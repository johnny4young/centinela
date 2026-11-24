import { matcher, sha256 } from './core.mjs';
import { parseRemoteRef } from './config.mjs';

export const EMPTY_LEARNINGS = { version: 1, learnings: [], suppressions: [], glossary: {} };

const VALID_SCOPES = new Set(['global', 'stack', 'repo']);
const VALID_STATUS = new Set(['active', 'candidate', 'retired']);

/** Parses and normalizes a learnings JSON document, returning an empty store when absent. */
export function parseLearningsDoc(text) {
  if (!text) return structuredClone(EMPTY_LEARNINGS);
  try {
    const raw = typeof text === 'string' ? JSON.parse(text) : text;
    if (!raw || typeof raw !== 'object') return structuredClone(EMPTY_LEARNINGS);
    const learnings = (Array.isArray(raw.learnings) ? raw.learnings : [])
      .filter(entry => entry && typeof entry.id === 'string' && typeof entry.rule === 'string')
      .map(entry => ({
        id: entry.id,
        scope: VALID_SCOPES.has(entry.scope) ? entry.scope : 'repo',
        stacks: Array.isArray(entry.stacks) ? entry.stacks.filter(s => typeof s === 'string') : [],
        paths: Array.isArray(entry.paths) ? entry.paths.filter(p => typeof p === 'string') : [],
        category: typeof entry.category === 'string' ? entry.category : 'convention',
        severity: entry.severity === 'maintainer' ? 'maintainer' : 'suggestion',
        rule: entry.rule.trim(),
        pattern: typeof entry.pattern === 'string' ? entry.pattern : null,
        origin: entry.origin ?? null,
        stats: normalizeStats(entry.stats),
        status: VALID_STATUS.has(entry.status) ? entry.status : 'active',
      }));
    const suppressions = (Array.isArray(raw.suppressions) ? raw.suppressions : []).filter(
      s => s && typeof s.id === 'string' && (typeof s.ruleId === 'string' || typeof s.learningId === 'string')
    );
    const glossary = raw.glossary && typeof raw.glossary === 'object' ? raw.glossary : {};
    return { version: raw.version ?? 1, learnings, suppressions, glossary };
  } catch {
    return structuredClone(EMPTY_LEARNINGS);
  }
}

function normalizeStats(stats) {
  const byRepo = {};
  if (stats?.byRepo && typeof stats.byRepo === 'object') {
    for (const [name, counts] of Object.entries(stats.byRepo)) {
      byRepo[name] = {
        shown: Number(counts?.shown) || 0,
        accepted: Number(counts?.accepted) || 0,
        dismissed: Number(counts?.dismissed) || 0,
      };
    }
  } else if (stats && (stats.shown || stats.accepted || stats.dismissed)) {
    byRepo._legacy = {
      shown: Number(stats.shown) || 0,
      accepted: Number(stats.accepted) || 0,
      dismissed: Number(stats.dismissed) || 0,
    };
  }
  return { byRepo };
}

/** Sums acceptance telemetry across every repository where a learning has fired. */
export function aggregateStats(learning) {
  const repos = Object.entries(learning.stats?.byRepo ?? {});
  let shown = 0;
  let accepted = 0;
  let dismissed = 0;
  let confirmedRepos = 0;
  for (const [, counts] of repos) {
    shown += counts.shown ?? 0;
    accepted += counts.accepted ?? 0;
    dismissed += counts.dismissed ?? 0;
    if ((counts.accepted ?? 0) > 0) confirmedRepos++;
  }
  return {
    shown,
    accepted,
    dismissed,
    confirmedRepos,
    dismissRate: shown > 0 ? dismissed / shown : 0,
  };
}

const JS_PACKS = new Set(['electron', 'react', 'node-server']);

/** Resolves all learning stack IDs for a repo, adding base javascript/typescript when present. */
export function learningStacksFor({ packs = [], paths = [] }) {
  const result = new Set(packs);
  const hasTs = paths.some(p => p === 'tsconfig.json' || /\.(?:[cm]?tsx?)$/.test(p));
  const hasJs =
    hasTs ||
    packs.some(p => JS_PACKS.has(p)) ||
    paths.some(p => p === 'package.json' || /\.(?:[cm]?jsx?)$/.test(p));
  if (hasJs) result.add('javascript');
  if (hasTs) result.add('typescript');
  return [...result];
}

/**
 * Loads and merges 3 tiers of learnings:
 * 1) Shared global learnings (`<shared>/learnings/global.json`)
 * 2) Shared stack learnings matching the repo's detected stacks (`<shared>/learnings/stacks/<id>.json`)
 * 3) Local repo learnings (`.github/centinela/learnings.json`)
 * Local entries and suppressions always take precedence over shared layers.
 */
export async function loadMultiProjectLearnings({ client, ref, stacks = [], paths = [], config }) {
  if (config.learnings?.enabled === false) {
    return { ...structuredClone(EMPTY_LEARNINGS), sources: [] };
  }
  const activeStacks = learningStacksFor({ packs: stacks, paths });
  const sources = [];
  const layers = [];

  const shared = parseRemoteRef(config.learnings?.shared);
  if (shared && client.externalFileAt) {
    const prefix = shared.path ? `${shared.path.replace(/\/+$/, '')}/` : 'learnings/';
    const globalPath = `${prefix}global.json`;
    const globalText = await client
      .externalFileAt(shared.repo, globalPath, shared.ref)
      .catch(() => null);
    if (globalText) {
      layers.push({ tier: 'global', doc: parseLearningsDoc(globalText) });
      sources.push(`${shared.repo}:${globalPath}`);
    }
    const stackTexts = await Promise.all(
      activeStacks.map(async id => {
        const stackPath = `${prefix}stacks/${id}.json`;
        const text = await client
          .externalFileAt(shared.repo, stackPath, shared.ref)
          .catch(() => null);
        return text ? { id, stackPath, text } : null;
      })
    );
    for (const item of stackTexts.filter(Boolean)) {
      layers.push({ tier: `stack:${item.id}`, doc: parseLearningsDoc(item.text) });
      sources.push(`${shared.repo}:${item.stackPath}`);
    }
  }

  const localPath = config.learnings?.localPath || '.github/centinela/learnings.json';
  const localText = client.fileAt ? await client.fileAt(localPath, ref).catch(() => null) : null;
  if (localText) {
    layers.push({ tier: 'repo', doc: parseLearningsDoc(localText) });
    sources.push(localPath);
  }

  return { ...mergeLearningLayers(layers, activeStacks), sources };
}

/** Merges global -> stack -> local layers with local override and suppression precedence. */
export function mergeLearningLayers(layers, activeStacks = []) {
  const stackSet = new Set(activeStacks);
  const byId = new Map();
  const suppressions = [];
  const glossary = {};

  for (const { doc } of layers) {
    for (const entry of doc.learnings) {
      if (entry.status !== 'active') continue;
      if (
        entry.scope === 'stack' &&
        entry.stacks.length &&
        !entry.stacks.some(s => stackSet.has(s))
      ) {
        continue;
      }
      byId.set(entry.id, entry);
    }
    suppressions.push(...doc.suppressions);
    for (const [lang, entries] of Object.entries(doc.glossary ?? {})) {
      if (!Array.isArray(entries)) continue;
      glossary[lang] = [...(glossary[lang] ?? []), ...entries];
    }
  }

  const suppressedLearningIds = new Set(
    suppressions.filter(s => s.learningId && !s.paths?.length).map(s => s.learningId)
  );
  const learnings = [...byId.values()].filter(entry => !suppressedLearningIds.has(entry.id));
  return { version: 1, learnings, suppressions, glossary };
}

/** Path-scoped retrieval: selects only learnings relevant to the files touched by a PR. */
export function selectLearningsForFiles({ learnings = [], suppressions = [], files = [], limit = 25 }) {
  const filenames = files.map(f => (typeof f === 'string' ? f : f.filename));
  const pathSuppressions = suppressions.filter(s => s.learningId && s.paths?.length);

  const relevant = learnings.filter(entry => {
    const matchesPath =
      !entry.paths?.length ||
      (() => {
        const match = matcher(entry.paths);
        return filenames.some(name => match(name));
      })();
    if (!matchesPath) return false;
    const suppressed = pathSuppressions.some(
      s => s.learningId === entry.id && filenames.every(name => matcher(s.paths)(name))
    );
    return !suppressed;
  });

  // Prefer higher-confidence, repo-specific and cross-project confirmed learnings first.
  const tierWeight = { repo: 3, stack: 2, global: 1 };
  return relevant
    .sort((a, b) => {
      const sa = aggregateStats(a);
      const sb = aggregateStats(b);
      const scoreA = (tierWeight[a.scope] ?? 1) * 10 + sa.confirmedRepos * 5 - sa.dismissRate * 10;
      const scoreB = (tierWeight[b.scope] ?? 1) * 10 + sb.confirmedRepos * 5 - sb.dismissRate * 10;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}

/** Filters deterministic findings suppressed by repo or shared suppression entries. */
export function applySuppressions(findings, suppressions = []) {
  const active = suppressions.filter(s => s.ruleId);
  if (!active.length) return findings;
  return findings.filter(f => {
    for (const s of active) {
      if (s.ruleId !== f.id) continue;
      if (!s.paths?.length) return false;
      const match = matcher(s.paths);
      const targets = f.file
        ? [f.file]
        : Array.isArray(f.params?.unread)
          ? f.params.unread
          : Array.isArray(f.params?.files)
            ? f.params.files
            : [];
      if (targets.length && targets.every(file => match(file))) return false;
    }
    return true;
  });
}

const STACK_HINTS = {
  electron: /\b(electron|preload|ipcRenderer|ipcMain|contextBridge|openExternal|BrowserWindow)\b/i,
  react: /\b(useEffect|useMemo|useCallback|useState|react|jsx|tsx|re-render|component|createImageBitmap|canvas|downscale|accessibility|aria-)\b/i,
  'node-server': /\b(sqlite|drizzle|sql|trpc|fastify|express|blob|transaction|mime|mimeType|magic bytes)\b/i,
  typescript: /\b(@ts-ignore|@ts-expect-error|tsconfig|as unknown as|discriminated union|type assertion|type guard|typescript)\b/i,
  javascript: /\b(AbortSignal\.timeout|unhandledRejection|EventEmitter|Promise\.all|engines\.node|node lts|setInterval|memory leak)\b/i,
  swift: /\b(swift|swiftui|mainactor|sendable|task\.sleep|xcode|appkit|uikit|@unchecked)\b/i,
  go: /\b(golang|goroutine|context\.context|http\.defaultclient|defer|mutex|channel)\b/i,
  rust: /\b(rust|unsafe|unwrap|cargo|borrow|tokio)\b/i,
};

const GLOBAL_HINTS =
  /\b(internal reference|decision d\d+|ticket|jira|comment|left accent|accent bar|filler copy|hollow test|assertion|always pass|co-authored-by|voseo|spanish register)\b/i;

const REPO_SPECIFIC_HINTS =
  /\b(tenantId|ensureTenantSite|puntovivo|roundMoney|resolvePayableTotal|insertCashMovement|purchase_documents|provider_payable)\b/i;

/**
 * Classifies a candidate learning into repo, stack or global scope while enforcing privacy
 * boundaries between private repositories and public shared hubs.
 */
export function classifyScope(candidate, { stacks = [], isPrivate = false, shareScope = 'public-only', sharedIsPublic = true } = {}) {
  const text = `${candidate.rule ?? ''} ${(candidate.paths ?? []).join(' ')}`;
  const canShare =
    shareScope === 'all' || (shareScope === 'public-only' && (!isPrivate || !sharedIsPublic));

  if (!canShare || REPO_SPECIFIC_HINTS.test(text)) {
    return { scope: 'repo', stacks: [] };
  }
  if (GLOBAL_HINTS.test(text)) {
    return { scope: 'global', stacks: [] };
  }
  const matchedStacks = Object.entries(STACK_HINTS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([id]) => id);
  if (matchedStacks.length) {
    return { scope: 'stack', stacks: matchedStacks };
  }
  if (candidate.scope && VALID_SCOPES.has(candidate.scope)) {
    return { scope: candidate.scope, stacks: candidate.scope === 'stack' ? stacks : [] };
  }
  return { scope: 'repo', stacks: [] };
}

/** Removes repository-specific paths and ticket pointers before promoting a rule to shared memory. */
export function sanitizeSharedCandidate(candidate, { isPrivate = false } = {}) {
  const genericPaths = (candidate.paths ?? [])
    .map(p => p.replace(/^(?:apps|packages)\/[^/]+\//, '**/'))
    .filter(p => !/\b(puntovivo|cognosos|melosensei)\b/i.test(p));
  return {
    ...candidate,
    paths: [...new Set(genericPaths)],
    origin: isPrivate ? { repo: 'private' } : candidate.origin,
  };
}

const RULE_SIGNAL = /\b(please|never|always|must|avoid|prefer|store|scope|drop|use|do not|don't)\b/i;

/** Extracts candidate rules from maintainer review comments and Centinela comment feedback. */
export async function harvestSignals({ client, config, repo, botLogin, limit = 15 }) {
  const maintainers = new Set((config.maintainers ?? []).map(m => m.toLowerCase()));
  const pulls = client.closedPulls ? await client.closedPulls(limit).catch(() => []) : [];
  const open = client.openPulls ? await client.openPulls(limit).catch(() => []) : [];
  const seenPrs = new Map();
  for (const pr of [...open, ...pulls]) seenPrs.set(pr.number, pr);

  const maintainerComments = [];
  const feedback = [];

  for (const pr of [...seenPrs.values()].slice(0, limit)) {
    const comments = client.reviewComments
      ? await client.reviewComments(pr.number).catch(() => [])
      : [];
    for (const c of comments) {
      const login = c.user?.login?.toLowerCase();
      const body = c.body ?? '';
      if (c.user?.type === 'Bot' && (!botLogin || c.user.login === botLogin)) {
        const fp = body.match(/<!-- centinela-ai-finding fp=([a-f0-9]+) -->/)?.[1];
        if (!fp) continue;
        const reactions = client.reactions
          ? await client.reactions(c.id, true).catch(() => [])
          : [];
        const plus = reactions.filter(r => r.content === '+1').length;
        const minus = reactions.filter(r => r.content === '-1').length;
        feedback.push({ pr: pr.number, fp, path: c.path, accepted: plus > 0, dismissed: minus > 0 });
      } else if (
        (maintainers.has(login) || ['OWNER', 'MEMBER'].includes(c.author_association)) &&
        body.length >= 35 &&
        RULE_SIGNAL.test(body)
      ) {
        maintainerComments.push({
          pr: pr.number,
          path: c.path,
          body: body.trim().slice(0, 600),
          repo,
        });
      }
    }
  }
  return { maintainerComments, feedback, scannedPrs: Math.min(seenPrs.size, limit) };
}

const LEARNING_ID = text =>
  `learned-${sha256(String(text).trim().toLowerCase()).slice(0, 10)}`;

/**
 * Turns harvested signals + existing stores into concrete local and shared learning updates,
 * auto-retirements for noisy rules, and deterministic promotion candidates.
 */
export function planLearningUpdates({
  currentLocal = EMPTY_LEARNINGS,
  currentShared = new Map(),
  signals = { maintainerComments: [], feedback: [] },
  candidates = [],
  stacks = [],
  repo = 'owner/repo',
  isPrivate = false,
  sharedIsPublic = true,
  config,
}) {
  const repoShort = repo.split('/').pop();
  const threshold = config.learnings?.retireThreshold ?? 0.4;
  const minSamples = config.learnings?.retireMinSamples ?? 5;
  const shareScope = config.learnings?.shareScope ?? 'public-only';

  const nextLocal = structuredClone(parseLearningsDoc(currentLocal));
  const localIds = new Set(nextLocal.learnings.map(l => l.id));
  const sharedUpdates = new Map();
  const retirements = [];
  const promotions = [];

  for (const entry of nextLocal.learnings) {
    const stats = aggregateStats(entry);
    if (entry.status === 'active' && stats.shown >= minSamples && stats.dismissRate >= threshold) {
      entry.status = 'retired';
      retirements.push({ id: entry.id, scope: 'repo', dismissRate: stats.dismissRate });
    }
    if (entry.status === 'active' && entry.pattern && stats.accepted >= 2 && stats.dismissed === 0) {
      promotions.push({
        id: entry.id,
        severity: entry.severity,
        paths: entry.paths,
        pattern: entry.pattern,
        message: entry.rule,
      });
    }
  }

  const allCandidates = [
    ...candidates,
    ...signals.maintainerComments.map(c => ({
      id: LEARNING_ID(`${c.path ?? ''}:${c.body}`),
      rule: c.body.replace(/\s+/g, ' ').slice(0, 220),
      paths: c.path ? [c.path.replace(/\/[^/]+$/, '/**')] : [],
      category: 'convention',
      severity: 'maintainer',
      origin: { repo: repoShort, pr: c.pr },
    })),
  ];

  const addedLocal = [];
  const addedShared = [];

  for (const raw of allCandidates) {
    const id = raw.id || LEARNING_ID(raw.rule);
    const routed = classifyScope(raw, { stacks, isPrivate, shareScope, sharedIsPublic });
    const entry = {
      id,
      scope: routed.scope,
      stacks: routed.stacks,
      paths: raw.paths ?? [],
      category: raw.category ?? 'convention',
      severity: raw.severity === 'maintainer' ? 'maintainer' : 'suggestion',
      rule: raw.rule,
      pattern: raw.pattern ?? null,
      origin: raw.origin ?? { repo: repoShort },
      stats: { byRepo: { [repoShort]: { shown: 0, accepted: 1, dismissed: 0 } } },
      status: 'active',
    };

    if (routed.scope === 'repo') {
      if (localIds.has(id)) continue;
      localIds.add(id);
      nextLocal.learnings.push(entry);
      addedLocal.push(entry);
    } else {
      const targetKey = routed.scope === 'global' ? 'global.json' : `stacks/${routed.stacks[0]}.json`;
      const doc =
        sharedUpdates.get(targetKey) ??
        structuredClone(parseLearningsDoc(currentShared.get(targetKey)));
      if (doc.learnings.some(l => l.id === id)) continue;
      const clean = sanitizeSharedCandidate(entry, { isPrivate });
      doc.learnings.push(clean);
      sharedUpdates.set(targetKey, doc);
      addedShared.push({ targetKey, entry: clean });
    }
  }

  return {
    nextLocal,
    sharedUpdates,
    addedLocal,
    addedShared,
    retirements,
    promotions,
  };
}

export function renderLearningPrBody(plan, { repo, language = 'en' } = {}) {
  const es = language === 'es';
  const lines = [
    es
      ? `Actualización automática de aprendizajes de Centinela para \`${repo}\`.`
      : `Automated Centinela learnings update for \`${repo}\`.`,
    '',
  ];
  if (plan.addedLocal.length) {
    lines.push(es ? '### Nuevas reglas locales' : '### New local learnings', '');
    for (const item of plan.addedLocal) {
      lines.push(`- \`${item.id}\` (${item.category}): ${item.rule}`);
    }
    lines.push('');
  }
  if (plan.addedShared.length) {
    lines.push(
      es ? '### Candidatas promovidas al hub multiproyecto' : '### Promoted to shared multi-project hub',
      ''
    );
    for (const { targetKey, entry } of plan.addedShared) {
      lines.push(`- \`${targetKey}\` · \`${entry.id}\`: ${entry.rule}`);
    }
    lines.push('');
  }
  if (plan.retirements.length) {
    lines.push(es ? '### Reglas retiradas por ruido' : '### Retired noisy rules', '');
    for (const r of plan.retirements) {
      lines.push(`- \`${r.id}\` (${Math.round(r.dismissRate * 100)}% dismissed)`);
    }
    lines.push('');
  }
  if (plan.promotions.length) {
    lines.push(
      es
        ? '### Listas para promover a `rules.custom` (regla determinística gratis)'
        : '### Ready to promote to deterministic `rules.custom`',
      ''
    );
    for (const p of plan.promotions) {
      lines.push(`- \`${p.id}\`: pattern \`${p.pattern}\``);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
