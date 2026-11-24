import { matcher } from './core.mjs';

const MIGRATION_FILE = /^(.+\/migrations)\/(\d+)_[^/]+\.sql$/i;
const TRIVIAL_SUBJECT = /^(merge\b|wip\b|fixup!|squash!|revert\b)/i;

function finding(id, severity, params = {}, location = {}) {
  return { id, severity, params, ...location };
}

/**
 * Flags merge conflicts and optionally branches far behind the base branch.
 * GitHub returns `mergeable: null` while computing; only an explicit `false` or `dirty` counts.
 */
export function checkBranchState({ pr, behindBy = null, config }) {
  const results = [];
  if (
    config.hygiene?.checkConflicts !== false &&
    (pr.mergeable === false || pr.mergeable_state === 'dirty')
  ) {
    results.push(finding('merge-conflict', 'blocking', { base: pr.base?.ref ?? 'main' }));
  }
  const maxBehind = config.hygiene?.maxBehindCommits;
  if (
    Number.isInteger(maxBehind) &&
    maxBehind > 0 &&
    Number.isInteger(behindBy) &&
    behindBy > maxBehind
  ) {
    results.push(
      finding('branch-behind', 'suggestion', {
        behindBy,
        maxBehind,
        base: pr.base?.ref ?? 'main',
      })
    );
  }
  return results;
}

/**
 * Detects numbered SQL migration files added by a PR whose prefix collides with or predates the
 * latest migration already on the base branch.
 */
export function checkMigrationCollisions({ files, basePaths = [], config }) {
  if (config.hygiene?.migrations === false) return [];
  const customPattern =
    typeof config.hygiene?.migrations === 'string' && config.hygiene.migrations !== 'auto'
      ? matcher([config.hygiene.migrations])
      : null;

  const maxByDir = new Map();
  const widthByDir = new Map();
  for (const file of basePaths) {
    if (customPattern && !customPattern(file)) continue;
    const match = file.match(MIGRATION_FILE);
    if (!match) continue;
    const [, dir, digits] = match;
    const num = Number(digits);
    if (num > (maxByDir.get(dir) ?? -1)) {
      maxByDir.set(dir, num);
      widthByDir.set(dir, digits.length);
    }
  }
  if (!maxByDir.size) return [];

  const results = [];
  for (const file of files) {
    if (file.status !== 'added') continue;
    if (customPattern && !customPattern(file.filename)) continue;
    const match = file.filename.match(MIGRATION_FILE);
    if (!match) continue;
    const [, dir, digits] = match;
    const latest = maxByDir.get(dir);
    if (latest === undefined) continue;
    const num = Number(digits);
    if (num <= latest) {
      const width = widthByDir.get(dir) ?? digits.length;
      const pad = n => String(n).padStart(width, '0');
      results.push(
        finding(
          'migration-collision',
          'blocking',
          {
            prefix: digits,
            latest: pad(latest),
            next: pad(latest + 1),
          },
          { file: file.filename }
        )
      );
    }
  }
  return results;
}

const commitSubject = message =>
  String(message ?? '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Detects when a PR carries commits whose subject matches another open PR (common when branching
 * off an unmerged feature PR instead of main).
 */
export function checkPrOverlap({ number, commits = [], openPulls = [], config }) {
  if (config.hygiene?.checkOverlap === false || !openPulls.length || !commits.length) return [];
  const ownSubjects = new Map();
  for (const c of commits) {
    const subject = commitSubject(c.message);
    if (subject.length >= 16 && !TRIVIAL_SUBJECT.test(subject)) ownSubjects.set(subject, c);
  }
  if (!ownSubjects.size) return [];

  const overlaps = [];
  for (const other of openPulls) {
    if (other.number === number || other.draft) continue;
    const otherTitle = commitSubject(other.title);
    const otherSubjects = new Set(
      [otherTitle, ...(other.commits ?? []).map(c => commitSubject(c.message))].filter(
        s => s.length >= 16 && !TRIVIAL_SUBJECT.test(s)
      )
    );
    const shared = [...ownSubjects.keys()].filter(subject => otherSubjects.has(subject));
    if (shared.length) {
      overlaps.push({ number: other.number, subject: shared[0] });
    }
  }
  return overlaps.slice(0, 3).map(overlap => finding('pr-overlap', 'maintainer', overlap));
}

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

/** Summarizes failed CI check runs on the PR head, ignoring Centinela's own checks. */
export function checkCiFailures({ checkRuns = [], config }) {
  if (config.hygiene?.checkCi === false || !checkRuns.length) return [];
  const own = (config.statusContext ?? 'centinela').toLowerCase();
  const failed = checkRuns
    .filter(
      run =>
        run.status === 'completed' &&
        FAILING_CONCLUSIONS.has(run.conclusion) &&
        !String(run.name ?? '')
          .toLowerCase()
          .includes(own)
    )
    .map(run => ({
      name: run.name,
      conclusion: run.conclusion,
      url: run.html_url ?? null,
      summary: run.output?.title || run.output?.summary?.slice(0, 180) || null,
    }));
  if (!failed.length) return [];
  return [
    finding('ci-failure', 'suggestion', {
      checks: failed.slice(0, 6).map(f => f.name),
      total: failed.length,
      details: failed.slice(0, 6),
    }),
  ];
}

/** Runs all enabled PR hygiene lookups through the GitHub API, failing soft on unavailable endpoints. */
export async function collectHygiene({ client, pr, files, commits, basePaths, config }) {
  const hygiene = config.hygiene ?? {};
  const needsBehind = Number.isInteger(hygiene.maxBehindCommits) && hygiene.maxBehindCommits > 0;
  const hasAddedMigration =
    hygiene.migrations !== false &&
    files.some(f => f.status === 'added' && MIGRATION_FILE.test(f.filename));
  const [comparison, openPulls, checkRuns, tipPaths] = await Promise.all([
    needsBehind && client.compare && pr.base?.ref && pr.head?.sha
      ? client.compare(pr.base.ref, pr.head.sha).catch(() => null)
      : null,
    hygiene.checkOverlap !== false && client.openPulls
      ? client.openPulls(20).catch(() => [])
      : [],
    hygiene.checkCi !== false && client.checkRuns && pr.head?.sha
      ? client.checkRuns(pr.head.sha).catch(() => [])
      : [],
    // Compare added migrations against the current tip of the base branch, not the stale pr.base.sha.
    hasAddedMigration && client.tree && pr.base?.ref
      ? client.tree(pr.base.ref).catch(() => basePaths)
      : basePaths,
  ]);
  const findings = [
    ...checkBranchState({ pr, behindBy: comparison?.behind_by ?? null, config }),
    ...checkMigrationCollisions({ files, basePaths: tipPaths ?? basePaths, config }),
    ...checkPrOverlap({ number: pr.number, commits, openPulls, config }),
    ...checkCiFailures({ checkRuns, config }),
  ];
  return { findings, checkRuns, openPulls };
}
