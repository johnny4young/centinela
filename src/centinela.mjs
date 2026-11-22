#!/usr/bin/env node
/** First-pass review of pull requests and issues from outside contributors; see README.md. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkIssue, checkPullRequest, sizeOf } from './lib/checks.mjs';
import { parseConfig } from './lib/config.mjs';
import { detectLanguage, readApproval, readMarker, reviewKey, sha256 } from './lib/core.mjs';
import { dependencyChanges, findTypos, localeGaps } from './lib/enrich.mjs';
import { createClient } from './lib/github.mjs';
import { applyStack, detectStack } from './lib/packs.mjs';
import { loadTemplateSections } from './lib/template.mjs';
import { isWorkflow } from './lib/workflows.mjs';
import { renderComment } from './lib/render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const CONFIG_PATH = '.github/centinela.json';

/**
 * The project config, read from the base branch through the API so a pull request can never
 * change its own rules. `--config <file>` reads a local file instead, for dry runs.
 */
export async function loadConfig({ client, file, ref }) {
  if (file) return parseConfig(readFileSync(file, 'utf8'));
  const base = ref ?? (await client.repository()).default_branch;
  return parseConfig(await client.fileAt(CONFIG_PATH, base));
}

/** Changes whenever Centinela or the project config changes, so open items are reviewed once more. */
export function rulesVersion(config, dir = here) {
  const lib = path.join(dir, 'lib');
  const sources = [
    path.join(dir, 'centinela.mjs'),
    path.join(dir, 'defaults.json'),
    ...readdirSync(lib)
      .filter(file => file.endsWith('.mjs'))
      .sort()
      .map(file => path.join(lib, file)),
  ];
  return sha256(
    [...sources.map(file => readFileSync(file, 'utf8')), JSON.stringify(config)].join('\0')
  );
}

export function parseTarget(argv, env) {
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? Number(argv[index + 1]) : null;
  };
  const dryRun = argv.includes('--dry-run');
  const configIndex = argv.indexOf('--config');
  const configFile = configIndex >= 0 ? argv[configIndex + 1] : null;
  // --force replays closed, skipped or unchanged items; only allowed with --dry-run.
  const force = dryRun && argv.includes('--force');
  const manual = { dryRun, force, configFile, action: null, ref: null };
  if (flag('--pr')) return { kind: 'pr', number: flag('--pr'), ...manual };
  if (flag('--issue')) return { kind: 'issue', number: flag('--issue'), ...manual };
  if (!env.GITHUB_EVENT_PATH)
    throw new Error('centinela: pass --pr <n> or --issue <n>, or run inside GitHub Actions');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.pull_request?.number ?? event.issue?.number;
  if (!number)
    throw new Error(`centinela: event ${env.GITHUB_EVENT_NAME} has no pull request or issue`);
  return {
    kind: event.pull_request ? 'pr' : 'issue',
    number,
    dryRun,
    force: false,
    configFile,
    // pull_request_target and issues both run on the base branch tip.
    ref: env.GITHUB_SHA ?? null,
    action: event.action ?? null,
    // The head the maintainer saw when they applied a label, immune to a later push.
    eventHeadSha: event.pull_request?.head?.sha ?? null,
    eventLabel: event.label?.name ?? null,
  };
}

export function shouldSkip({ author, association, labels, draft, config }) {
  if (draft) return 'draft';
  if (config.skipAuthors.includes(author)) return 'automation author';
  const maintainer =
    MAINTAINER_ASSOCIATIONS.has(association) || config.maintainers.includes(author);
  if (maintainer && !labels.includes(config.optInLabel)) return 'maintainer without opt-in label';
  return null;
}

/**
 * The newest comment Centinela wrote. Its marker carries the approval, so only the identity
 * Centinela posts as counts; another bot quoting a marker must never forge one.
 */
export function ownComment(comments, botLogin = null) {
  return (
    comments.findLast(
      comment =>
        comment.user?.type === 'Bot' &&
        (!botLogin || comment.user.login === botLogin) &&
        readMarker(comment.body)
    ) ?? null
  );
}

/**
 * The head SHA a maintainer approval covers, or null. Applying the label approves the head
 * the event carried; later runs keep it only while the PR still points at that head.
 */
export function approvalFor({
  labels,
  config,
  headSha,
  previous,
  action,
  eventHeadSha,
  eventLabel,
}) {
  if (!labels.includes(config.overrideLabel)) return null;
  if (action === 'labeled' && eventLabel === config.overrideLabel && eventHeadSha === headSha) {
    return headSha;
  }
  return previous === headSha ? headSha : null;
}

export function outcome(findings, approved) {
  const blocking = findings.some(f => f.severity === 'blocking');
  const maintainer = findings.some(f => f.severity === 'maintainer');
  if (approved) return { state: 'success', blocking: false, maintainer: false };
  return { state: blocking || maintainer ? 'failure' : 'success', blocking, maintainer };
}

async function syncLabels(client, number, current, wanted, managed) {
  for (const name of managed) {
    if (current.includes(name) && !wanted.has(name)) await client.removeLabel(number, name);
  }
  const missing = [...wanted].filter(name => !current.includes(name));
  if (missing.length) await client.addLabels(number, missing);
}

export async function triagePullRequest({
  client,
  config,
  number,
  dryRun,
  force,
  action = null,
  eventHeadSha = null,
  eventLabel = null,
  repo,
  version,
  botLogin = null,
  log,
}) {
  const pr = await client.pull(number);
  const labels = pr.labels.map(label => label.name);
  if (pr.state !== 'open' && !force) return log(`#${number} is ${pr.state}; nothing to do`);
  const skip = shouldSkip({
    author: pr.user.login,
    association: pr.author_association,
    labels,
    draft: pr.draft,
    config,
  });
  if (skip && !force) {
    // A required triage status must not leave skipped pull requests pending forever.
    if (skip !== 'draft' && !dryRun) {
      await client
        .setStatus(pr.head.sha, 'success', `Skipped: ${skip}`)
        .catch(error => log(`could not set the skipped status: ${error.message}`));
    }
    return log(`#${number} skipped: ${skip}`);
  }

  const existing = ownComment(await client.comments(number), botLogin);
  const approvedSha = approvalFor({
    labels,
    config,
    headSha: pr.head.sha,
    previous: readApproval(existing?.body),
    action,
    eventHeadSha,
    eventLabel,
  });
  if (labels.includes(config.overrideLabel) && !approvedSha && !dryRun) {
    await client.removeLabel(number, config.overrideLabel);
  }
  const key = reviewKey({
    rulesVersion: version,
    kind: 'pr',
    headSha: pr.head.sha,
    title: pr.title,
    body: pr.body,
    labels: [...labels.filter(name => name === config.optInLabel), approvedSha ?? ''],
  });
  if (existing && readMarker(existing.body) === key && !force)
    return log(`#${number} unchanged since the last review`);

  const [files, commits] = await Promise.all([
    client.pullFiles(number),
    client.pullCommits(number),
  ]);
  const fileAt = (file, ref) => client.fileAt(file, ref);
  const stack = await detectStack({
    client,
    ref: pr.base.sha,
    setting: config.stack,
    legacy: config.rules,
  });
  const { config: effective, rules } = applyStack(config, stack);
  if (config.pullRequest.sections === 'template') {
    effective.pullRequest = {
      ...config.pullRequest,
      sections: await loadTemplateSections({ client, ref: pr.base.sha, paths: stack.paths }),
    };
  }
  // Fetch a bounded number; the rest are reported unread so a maintainer reviews them.
  const workflows = [];
  for (const file of files.filter(f => isWorkflow(f.filename) && f.status !== 'removed')) {
    const content = workflows.length < 30 ? await fileAt(file.filename, pr.head.sha) : null;
    workflows.push({ file: file.filename, content });
  }
  const [gaps, dependencies, typos] = await Promise.all([
    localeGaps({ files, fileAt, headSha: pr.head.sha, parity: config.language.localeParity }),
    dependencyChanges({ files, fileAt, baseSha: pr.base.sha, headSha: pr.head.sha }),
    config.language.typos
      ? findTypos({
          files,
          exclude: config.language.typosExclude,
          required: process.env.CENTINELA_REQUIRE_TYPOS === '1',
        })
      : [],
  ]);
  if (typos === null) log('typos binary not found; spelling check skipped');

  const findings = checkPullRequest({
    totals: { files: pr.changed_files, commits: pr.commits },
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user.login,
    files,
    commits: commits.map(c => ({
      sha: c.sha,
      authorLogin: c.author?.login ?? null,
      committerLogin: c.committer?.login ?? null,
      verified: c.commit.verification?.verified === true,
      message: c.commit.message,
    })),
    config: effective,
    rules,
    workflows,
    repo,
    localeGaps: gaps,
    dependencies,
    typos: typos ?? [],
  });
  const approved = approvedSha !== null;
  const result = outcome(findings, approved);
  const body = renderComment({
    kind: 'pr',
    repo,
    config,
    stack: stack.packs,
    author: pr.user.login,
    findings,
    language: detectLanguage(pr.title, pr.body ?? ''),
    key,
    rulesVersion: version,
    approved,
    approvedSha,
  });
  const size = sizeOf(files, config);
  const description =
    result.state === 'success'
      ? approved
        ? 'Approved by a maintainer'
        : 'Automated checks passed'
      : `${findings.filter(f => f.severity !== 'suggestion').length} item(s) to resolve before review`;

  if (dryRun) {
    log(
      `size/${size.label} (${size.lines} lines) · status ${result.state}: ${description}\n\n${body}`
    );
    return { findings, result };
  }

  const { labels: names } = config;
  const sizeLabels = Object.keys(names.size).map(label => `size/${label}`);
  const wanted = new Set([`size/${size.label}`]);
  if (result.blocking) wanted.add(names.waitingOnAuthor.name);
  if (result.maintainer) wanted.add(names.needsMaintainer.name);
  for (const label of wanted) {
    const definition = label.startsWith('size/')
      ? { name: label, color: names.size[label.slice(5)].color }
      : Object.values(names).find(entry => entry.name === label);
    await client.ensureLabel(definition);
  }
  // A push during the review gets its own run; never bind these results to a newer head.
  const current = await client.pull(number);
  if (current.head.sha !== pr.head.sha)
    return log(`#${number} moved to a new head; leaving it to the next run`);
  await client.upsertComment(number, existing, body);
  await syncLabels(client, number, labels, wanted, [
    ...sizeLabels,
    names.waitingOnAuthor.name,
    names.needsMaintainer.name,
  ]);
  await client.setStatus(pr.head.sha, result.state, description);
  log(`#${number} reviewed: ${result.state} (${findings.length} findings)`);
  return { findings, result };
}

export async function triageIssue({
  client,
  config,
  number,
  dryRun,
  force,
  repo,
  version,
  botLogin = null,
  log,
}) {
  const issue = await client.issue(number);
  if (issue.pull_request) return log(`#${number} is a pull request; skipped`);
  if (issue.state !== 'open' && !force) return log(`#${number} is ${issue.state}; nothing to do`);
  const labels = issue.labels.map(label => (typeof label === 'string' ? label : label.name));
  const skip = shouldSkip({
    author: issue.user.login,
    association: issue.author_association,
    labels,
    draft: false,
    config,
  });
  if (skip && !force) return log(`#${number} skipped: ${skip}`);

  const key = reviewKey({
    rulesVersion: version,
    kind: 'issue',
    title: issue.title,
    body: issue.body,
    labels: labels.filter(name => name === config.issues.bugLabel),
  });
  const existing = ownComment(await client.comments(number), botLogin);
  if (existing && readMarker(existing.body) === key && !force)
    return log(`#${number} unchanged since the last review`);

  const findings = checkIssue({ title: issue.title, body: issue.body ?? '', labels, config });
  const body = renderComment({
    kind: 'issue',
    repo,
    config,
    author: issue.user.login,
    findings,
    language: detectLanguage(issue.title, issue.body ?? ''),
    key,
    rulesVersion: version,
    approved: false,
  });
  if (dryRun) {
    log(body);
    return { findings };
  }
  const needsInfo = config.labels.needsInfo;
  const wanted = new Set(findings.some(f => f.severity === 'blocking') ? [needsInfo.name] : []);
  if (wanted.size) await client.ensureLabel(needsInfo);
  if (findings.length || existing) await client.upsertComment(number, existing, body);
  await syncLabels(client, number, labels, wanted, [needsInfo.name]);
  log(`#${number} reviewed (${findings.length} findings)`);
  return { findings };
}

/** Label events matter only for the opt-in, approval and bug labels, never the bot's own. */
export function relevantEvent(target, config) {
  if (target.action !== 'labeled' && target.action !== 'unlabeled') return true;
  return [config.optInLabel, config.overrideLabel, config.issues.bugLabel].includes(
    target.eventLabel
  );
}

export async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const target = parseTarget(argv, env);
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const config = await loadConfig({
    client: createClient({ token, repo }),
    file: target.configFile,
    ref: target.ref,
  });
  if (!relevantEvent(target, config))
    return log(`label ${target.eventLabel} does not affect the review`);
  const options = {
    client: createClient({ token, repo, statusContext: config.statusContext }),
    config,
    version: rulesVersion(config),
    // Inside Actions the identity is always known; dry runs accept any bot.
    botLogin:
      env.CENTINELA_BOT_LOGIN || (env.GITHUB_ACTIONS === 'true' ? 'github-actions[bot]' : null),
    number: target.number,
    dryRun: target.dryRun,
    action: target.action,
    eventHeadSha: target.eventHeadSha,
    eventLabel: target.eventLabel,
    force: target.force,
    repo,
    log,
  };
  return target.kind === 'pr' ? triagePullRequest(options) : triageIssue(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
