#!/usr/bin/env node
/** Autonomous triage, agentic review, issue management and self-learning for GitHub repos. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkIssue, checkPullRequest, sizeOf } from './lib/checks.mjs';
import { merge, parseConfig, parseRemoteRef, resolveConfig } from './lib/config.mjs';
import {
  compareFindings,
  detectLanguage,
  parseMarker,
  readMarker,
  reviewKey,
  sha256,
} from './lib/core.mjs';
import { dependencyChanges, findTypos, localeGaps } from './lib/enrich.mjs';
import { createClient } from './lib/github.mjs';
import { collectHygiene } from './lib/hygiene.mjs';
import { applyStack, detectStack } from './lib/packs.mjs';
import { findContributing, loadTemplateSections } from './lib/template.mjs';
import { isWorkflow } from './lib/workflows.mjs';
import { renderComment } from './lib/render.mjs';
import {
  MAINTAINER_ASSOCIATIONS,
  canRun,
  helpText,
  knownCommand,
  parseCommand,
  wantsAgain,
} from './lib/commands.mjs';
import {
  AI_MARKER,
  aiConfigured,
  askClaude,
  buildPrompt,
  createModel,
  exploreContext,
  inlineComment,
  loadFileContents,
  loadRelatedFiles,
  loadProjectRules,
  planInline,
  postedFingerprints,
  readAiHead,
  renderAiComment,
  reviewBody,
  reviewComment,
  selectReviewTier,
  validFindings,
  verifyFindings,
} from './lib/ai.mjs';
import {
  ISSUE_AI_MARKER,
  issueAiKey,
  readIssueAiKey,
  renderIssueAiComment,
  triageIssueWithAi,
} from './lib/issues.mjs';
import {
  answerThread,
  isCentinelaMention,
  renderThreadReply,
} from './lib/conversation.mjs';
import {
  applySuppressions,
  harvestSignals,
  learningStacksFor,
  loadMultiProjectLearnings,
  parseLearningsDoc,
  planLearningUpdates,
  renderLearningPrBody,
  selectLearningsForFiles,
} from './lib/learnings.mjs';
import { lastActivity, lifecycleAction, lifecycleComment, reminderAt } from './lib/lifecycle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIRST_TIMERS = new Set(['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER']);

/** The welcome for a first-time contributor, linking the configured or detected guide. */
export async function welcomeFor({ association, config, paths }) {
  if (!FIRST_TIMERS.has(association)) return null;
  if (config.links.contributing) return { link: config.links.contributing };
  return { link: findContributing(await paths()) };
}
export const CONFIG_PATH = '.github/centinela.json';

/**
 * The project config, read from the base branch through the API so a pull request can never
 * change its own rules. Supports `"extends": "owner/repo/path.json[@ref]"` for fleet sharing.
 */
export async function loadConfig({ client, file, ref }) {
  let rawText;
  if (file) {
    rawText = readFileSync(file, 'utf8');
  } else {
    const base = ref ?? (await client.repository()).default_branch;
    rawText = await client.fileAt(CONFIG_PATH, base);
  }
  if (!rawText) return resolveConfig({});
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`centinela: invalid config: ${error.message}`);
  }
  if (parsed?.extends && client?.externalFileAt) {
    const remote = parseRemoteRef(parsed.extends);
    if (remote?.path) {
      const baseText = await client
        .externalFileAt(remote.repo, remote.path, remote.ref)
        .catch(() => null);
      if (baseText) {
        try {
          const baseObj = JSON.parse(baseText);
          parsed = merge(baseObj, parsed);
        } catch {
          // Ignore malformed remote base and fall back to local config.
        }
      }
    }
  }
  return parseConfig(JSON.stringify(parsed));
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
  const strFlag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const dryRun = argv.includes('--dry-run');
  const configFile = strFlag('--config');
  // --force replays closed, skipped or unchanged items; only allowed with --dry-run.
  const force = dryRun && argv.includes('--force');
  const manual = { dryRun, force, configFile, action: null, ref: null };
  if (argv.includes('--lifecycle')) return { kind: 'lifecycle', ...manual };
  if (argv.includes('--learn')) return { kind: 'learn', ...manual };
  // A manual AI review; with --dry-run it only reports the prompt size and calls nothing.
  if (flag('--pr') && argv.includes('--review')) {
    return {
      kind: 'pr',
      number: flag('--pr'),
      ...manual,
      command: {
        name: 'review',
        manual: true,
        again: argv.includes('--again'),
        tier: strFlag('--tier') || 'deep',
        language: 'en',
      },
    };
  }
  if (flag('--issue') && argv.includes('--triage')) {
    return {
      kind: 'issue',
      number: flag('--issue'),
      ...manual,
      command: { name: 'triage', manual: true, language: 'en' },
    };
  }
  if (flag('--pr')) return { kind: 'pr', number: flag('--pr'), ...manual };
  if (flag('--issue')) return { kind: 'issue', number: flag('--issue'), ...manual };
  if (!env.GITHUB_EVENT_PATH)
    throw new Error('centinela: pass --pr <n> or --issue <n>, or run inside GitHub Actions');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    return { kind: 'lifecycle', dryRun, force: false, configFile, action: null, ref: null };
  }
  if (env.GITHUB_EVENT_NAME === 'pull_request_review_comment') {
    return {
      kind: 'pr',
      number: event.pull_request?.number,
      dryRun,
      force: false,
      configFile,
      ref: env.GITHUB_SHA ?? null,
      action: event.action ?? null,
      conversation: {
        isReviewComment: true,
        comment: event.comment,
        inReplyToId: event.comment?.in_reply_to_id ?? null,
        language: detectLanguage(event.comment?.body ?? ''),
      },
    };
  }
  if (env.GITHUB_EVENT_NAME === 'issue_comment') {
    const cmdName = parseCommand(event.comment?.body);
    return {
      kind: event.issue.pull_request ? 'pr' : 'issue',
      number: event.issue.number,
      dryRun,
      force: false,
      configFile,
      ref: env.GITHUB_SHA ?? null,
      action: event.action ?? null,
      command: cmdName
        ? {
            name: cmdName,
            commentId: event.comment?.id,
            login: event.comment?.user?.login,
            association: event.comment?.author_association,
            bot: event.comment?.user?.type === 'Bot',
            itemAuthor: event.issue.user?.login,
            again: wantsAgain(event.comment?.body),
            language: detectLanguage(event.comment?.body ?? ''),
          }
        : null,
      conversation: !cmdName
        ? {
            isReviewComment: false,
            comment: event.comment,
            inReplyToId: null,
            language: detectLanguage(event.comment?.body ?? ''),
          }
        : null,
    };
  }
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
 * the event carried; later runs keep it only while the PR still points at that head. A new
 * head with the same tree is handled by carryApproval once its findings are known.
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

/**
 * An approval moves to a new head only when the content is identical (same tree, so a squash
 * or reworded commit) and the review found nothing it had not found when it was approved.
 */
export function carryApproval({ previous, tree, findings }) {
  if (!previous?.approved || !previous.tree || !previous.seen || tree !== previous.tree)
    return false;
  return !findings.some(f => f.severity !== 'suggestion' && f.isNew);
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
  recheck = false,
  action = null,
  eventHeadSha = null,
  eventLabel = null,
  repo,
  version,
  botLogin = null,
  env = process.env,
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
  const previous = parseMarker(existing?.body);
  let approvedSha = approvalFor({
    labels,
    config,
    headSha: pr.head.sha,
    previous: previous?.approved ?? null,
    action,
    eventHeadSha,
    eventLabel,
  });
  const labeled = labels.includes(config.overrideLabel);
  // The approved tree is recorded, and compared when the head moved under an approval.
  const carry = labeled && !approvedSha && Boolean(previous?.approved && previous.tree);
  const tree = approvedSha || carry ? await client.commitTree(pr.head.sha) : null;
  const carrying = carry && tree === previous.tree;
  if (labeled && !approvedSha && !carrying && !dryRun) {
    await client.removeLabel(number, config.overrideLabel);
  }
  const key = reviewKey({
    rulesVersion: version,
    kind: 'pr',
    headSha: pr.head.sha,
    title: pr.title,
    body: pr.body,
    labels: [
      ...labels.filter(name => name === config.optInLabel),
      approvedSha ?? (carrying ? `tree:${tree}` : ''),
    ],
  });
  if (existing && readMarker(existing.body) === key && !force && !recheck)
    return log(`#${number} unchanged since the last review`);

  const [files, commits] = await Promise.all([
    client.pullFiles(number),
    client.pullCommits(number),
  ]);
  const mappedCommits = commits.map(c => ({
    sha: c.sha,
    authorLogin: c.author?.login ?? null,
    committerLogin: c.committer?.login ?? null,
    verified: c.commit.verification?.verified === true,
    message: c.commit.message,
  }));
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
  const [gaps, dependencies, typos, hygiene, learned] = await Promise.all([
    localeGaps({ files, fileAt, headSha: pr.head.sha, parity: config.language.localeParity }),
    dependencyChanges({ files, fileAt, baseSha: pr.base.sha, headSha: pr.head.sha }),
    config.language.typos
      ? findTypos({
          files,
          exclude: config.language.typosExclude,
          ignoreWords: config.language.typosIgnoreWords ?? [],
          spanishEnabled: Boolean(config.language.spanishRegister),
          required: process.env.CENTINELA_REQUIRE_TYPOS === '1',
        })
      : [],
    collectHygiene({
      client,
      pr,
      files,
      commits: mappedCommits,
      basePaths: stack.paths,
      config: effective,
    }),
    loadMultiProjectLearnings({
      client,
      ref: pr.base.ref ?? pr.base.sha,
      stacks: stack.packs,
      paths: stack.paths,
      config: effective,
    }),
  ]);
  if (typos === null) log('typos binary not found; spelling check skipped');

  const rawFindings = [
    ...checkPullRequest({
      totals: { files: pr.changed_files, commits: pr.commits },
      title: pr.title,
      body: pr.body ?? '',
      author: pr.user.login,
      files,
      commits: mappedCommits,
      config: effective,
      rules,
      workflows,
      repo,
      localeGaps: gaps,
      dependencies,
      typos: typos ?? [],
    }),
    ...hygiene.findings,
  ];
  const compared = compareFindings(
    applySuppressions(rawFindings, learned.suppressions),
    previous?.seen ?? null
  );
  const { findings } = compared;
  if (carrying) {
    if (carryApproval({ previous, tree, findings })) approvedSha = pr.head.sha;
    else if (!dryRun) await client.removeLabel(number, config.overrideLabel);
  }
  const welcome = await welcomeFor({
    association: pr.author_association,
    config,
    paths: async () => (stack.paths?.length ? stack.paths : client.tree(pr.base.sha)),
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
    tree: approved ? tree : null,
    seen: compared.seen,
    resolved: compared.resolved,
    welcome,
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
  const hasCiFailure = findings.some(f => f.id === 'ci-failure');
  const wanted = new Set([`size/${size.label}`]);
  if (result.blocking) wanted.add(names.waitingOnAuthor.name);
  if (result.maintainer) wanted.add(names.needsMaintainer.name);
  if (result.state === 'success' && !hasCiFailure && names.readyForMaintainer) {
    wanted.add(names.readyForMaintainer.name);
  }
  for (const label of wanted) {
    const definition = label.startsWith('size/')
      ? { name: label, color: names.size[label.slice(5)].color }
      : Object.values(names).find(entry => entry?.name === label);
    if (definition) await client.ensureLabel(definition);
  }
  // A push during the review gets its own run; never bind these results to a newer head.
  const current = await client.pull(number);
  if (current.head.sha !== pr.head.sha)
    return log(`#${number} moved to a new head; leaving it to the next run`);
  await client.upsertComment(number, existing, body);
  const managed = [
    ...sizeLabels,
    names.waitingOnAuthor.name,
    names.needsMaintainer.name,
    ...(names.readyForMaintainer ? [names.readyForMaintainer.name] : []),
  ];
  await syncLabels(client, number, labels, wanted, managed);
  await client.setStatus(pr.head.sha, result.state, description);
  log(`#${number} reviewed: ${result.state} (${findings.length} findings)`);

  // Cost-tiered automatic AI review for ready external PRs when credentials are configured.
  const tier = selectReviewTier({ files, sizeLabel: size.label, config });
  if (tier !== 'off' && !result.blocking && aiConfigured(env)) {
    await runAiReview({
      options: { client, config, number, dryRun, force, repo, version, botLogin, log },
      tier,
      env,
    }).catch(error => log(`auto AI review (${tier}) failed: ${error.message}`));
  }
  return { findings, result };
}

export async function triageIssue({
  client,
  config,
  number,
  dryRun,
  force,
  recheck = false,
  runAi = false,
  ref = null,
  repo,
  version,
  botLogin = null,
  env = process.env,
  model = null,
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
  if (skip && !force && !runAi) return log(`#${number} skipped: ${skip}`);

  const comments = await client.comments(number);
  const key = reviewKey({
    rulesVersion: version,
    kind: 'issue',
    title: issue.title,
    body: issue.body,
    labels: labels.filter(name => name === config.issues.bugLabel),
  });
  const existing = ownComment(comments, botLogin);
  const unchanged = existing && readMarker(existing.body) === key && !force && !recheck;

  let findings = [];
  if (!unchanged) {
    const compared = compareFindings(
      checkIssue({ title: issue.title, body: issue.body ?? '', labels, config }),
      parseMarker(existing?.body)?.seen ?? null
    );
    findings = compared.findings;
    const welcome = await welcomeFor({
      association: issue.author_association,
      config,
      paths: async () =>
        client.tree(ref ?? (await client.repository()).default_branch).catch(() => []),
    });
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
      seen: compared.seen,
      resolved: compared.resolved,
      welcome,
    });
    if (dryRun) {
      log(body);
    } else {
      const needsInfo = config.labels.needsInfo;
      const wanted = new Set(findings.some(f => f.severity === 'blocking') ? [needsInfo.name] : []);
      if (wanted.size) await client.ensureLabel(needsInfo);
      if (findings.length || existing) await client.upsertComment(number, existing, body);
      await syncLabels(client, number, labels, wanted, [needsInfo.name]);
      log(`#${number} reviewed (${findings.length} findings)`);
    }
  } else {
    log(`#${number} unchanged since the last review`);
  }

  // Semantic AI issue triage: auto-labeling, duplicate/already-fixed detection and direction.
  const shouldRunAi =
    (runAi || config.issues?.aiTriage !== false) && (model || aiConfigured(env));
  if (shouldRunAi) {
    const existingAi =
      comments.findLast(
        c =>
          c.user?.type === 'Bot' &&
          (!botLogin || c.user.login === botLogin) &&
          c.body?.startsWith(ISSUE_AI_MARKER)
      ) ?? null;
    if (existingAi && readIssueAiKey(existingAi.body) === issueAiKey(issue) && !runAi && !force) {
      return { findings };
    }
    const baseRef = ref ?? (await client.repository().catch(() => ({ default_branch: 'main' }))).default_branch;
    const [rules, stack] = await Promise.all([
      loadProjectRules({ client, ref: baseRef, paths: config.ai.rules }),
      detectStack({ client, ref: baseRef, setting: config.stack, legacy: config.rules }).catch(
        () => ({ packs: [], paths: [] })
      ),
    ]);
    const learned = await loadMultiProjectLearnings({
      client,
      ref: baseRef,
      stacks: stack.packs,
      paths: stack.paths,
      config,
    });
    const language = detectLanguage(issue.title, issue.body ?? '');
    const aiModel = model ?? (await createModel(env));
    const outcome = await triageIssueWithAi({
      model: aiModel,
      client,
      issue,
      rules,
      learnings: learned.learnings,
      tracked: stack.paths,
      language,
      config,
    });
    if (outcome.usage) {
      log(`#${number} AI triage usage: ${outcome.usage.input} input, ${outcome.usage.output} output tokens`);
    }
    if (outcome.error) {
      log(`#${number} AI triage failed: ${outcome.error}${outcome.stopReason ? ` (${outcome.stopReason})` : ''}${outcome.preview ? ` · ${outcome.preview}` : ''}`);
    }
    if (outcome.result) {
      const commentBody = renderIssueAiComment({ issue, result: outcome.result, language });
      if (dryRun) {
        log(commentBody);
      } else {
        await client.upsertComment(number, existingAi, commentBody);
        if (config.issues?.autoLabel !== false && outcome.result.labels?.length) {
          const toAdd = outcome.result.labels.filter(l => !labels.includes(l));
          for (const name of toAdd) {
            await client.ensureLabel({ name, color: name.startsWith('area:') ? '5319e7' : 'ededed' });
          }
          if (toAdd.length) await client.addLabels(number, toAdd);
        }
      }
      return { findings, ai: outcome.result };
    }
    if (runAi) return null;
  }
  return { findings };
}

/**
 * A `/centinela` command from a comment. Only the author and maintainers are answered; a
 * recheck reviews the item again even when nothing it reads has changed.
 */
export async function runCommand({ command, options, kind, env = process.env }) {
  const { client, config, dryRun, log } = options;
  if (command.manual && command.name === 'review') {
    return runAiReview({ options, again: command.again, tier: command.tier ?? 'deep', env });
  }
  if (command.manual && command.name === 'triage') {
    return triageIssue({ ...options, runAi: true, env });
  }
  if (!command.name || command.bot) return log('no Centinela command in this comment');
  if (!canRun({ ...command, config }))
    return log(`${command.login} may not run Centinela commands here`);
  const react = content =>
    dryRun ? log(`react ${content}`) : client.react(command.commentId, content);
  if (!knownCommand(command.name) || command.name === 'help') {
    await react(knownCommand(command.name) ? 'eyes' : 'confused');
    return dryRun
      ? log(helpText(command.language))
      : client.comment(options.number, helpText(command.language));
  }
  await react('eyes');
  if (command.name === 'review') {
    if (kind !== 'pr') return react('confused');
    const reviewed = await runAiReview({
      options,
      again: command.again,
      tier: 'deep',
      env,
    }).catch(error => {
      log(`AI review failed: ${error.message}`);
      return null;
    });
    return react(reviewed ? '+1' : 'confused');
  }
  if (command.name === 'triage') {
    if (kind !== 'issue') return react('confused');
    const triaged = await triageIssue({ ...options, runAi: true, env }).catch(error => {
      log(`AI issue triage failed: ${error.message}`);
      return null;
    });
    return react(triaged ? '+1' : 'confused');
  }
  if (command.name === 'learn') {
    const learned = await runLearn({ options, openPr: !dryRun }).catch(error => {
      log(`learning run failed: ${error.message}`);
      return null;
    });
    return react(learned ? '+1' : 'confused');
  }
  if (command.name === 'draft-pr' || command.name === 'fix-nits') {
    log(`command /centinela ${command.name} is handled by the Tier 2 execution workflow`);
    return react('+1');
  }
  const triage = kind === 'pr' ? triagePullRequest : triageIssue;
  const result = await triage({ ...options, recheck: true, env });
  await react('+1');
  return result;
}

/**
 * A Claude review of the pull request diff, posted as its own comment and kept apart from the
 * status: model output never approves or blocks. Once per head unless asked again.
 */
export async function runAiReview({
  options,
  again = false,
  tier = 'deep',
  env = process.env,
  model = null,
}) {
  const { client, config, number, dryRun, botLogin, log } = options;
  const pr = await client.pull(number);
  if (pr.state !== 'open' && !options.force) return log(`#${number} is ${pr.state}; no AI review`);
  const language = detectLanguage(pr.title, pr.body ?? '');
  const existing =
    (await client.comments(number)).findLast(
      c =>
        c.user?.type === 'Bot' &&
        (!botLogin || c.user.login === botLogin) &&
        c.body?.startsWith(AI_MARKER)
    ) ?? null;
  if (existing && readAiHead(existing.body) === pr.head.sha && !again) {
    log(`#${number} already has an AI review for ${pr.head.sha}`);
    return true;
  }
  const [files, rules, stack, rawReviewComments, rawCheckRuns] = await Promise.all([
    client.pullFiles(number),
    // The base branch tip: trusted, and newer than the commit the pull request started from.
    loadProjectRules({ client, ref: pr.base.ref, paths: config.ai.rules }),
    detectStack({ client, ref: pr.base.sha, setting: config.stack, legacy: config.rules }),
    client.reviewComments ? client.reviewComments(number).catch(() => []) : [],
    client.checkRuns ? client.checkRuns(pr.head.sha).catch(() => []) : [],
  ]);
  const learned = await loadMultiProjectLearnings({
    client,
    ref: pr.base.ref ?? pr.base.sha,
    stacks: stack.packs,
    paths: stack.paths,
    config,
  });
  const selectedLearnings = selectLearningsForFiles({
    learnings: learned.learnings,
    suppressions: learned.suppressions,
    files,
  });
  const existingReviews = rawReviewComments
    .filter(c => !(c.user?.type === 'Bot' && (!botLogin || c.user.login === botLogin)))
    .map(c => ({ user: c.user?.login, path: c.path, line: c.line, body: c.body }));
  const ciFailures = rawCheckRuns
    .filter(
      r =>
        r.status === 'completed' &&
        ['failure', 'timed_out'].includes(r.conclusion) &&
        !String(r.name ?? '')
          .toLowerCase()
          .includes((config.statusContext ?? 'centinela').toLowerCase())
    )
    .map(r => ({ name: r.name, conclusion: r.conclusion, summary: r.output?.title ?? null }));

  const contents = await loadFileContents({
    client,
    files,
    head: pr.head.sha,
    config,
    budget: config.ai.maxFileTokens * 2.3,
  });
  const tracked = stack.paths?.length ? stack.paths : await client.tree(pr.base.sha);
  const related = await loadRelatedFiles({
    client,
    contents,
    files,
    tracked,
    head: pr.head.sha,
    config,
  });
  let prompt = buildPrompt({
    pr,
    files,
    rules,
    learnings: selectedLearnings,
    glossary: learned.glossary?.[language] ?? [],
    existingReviews,
    ciFailures,
    contents,
    related,
    stack: stack.packs,
    language,
    config,
  });
  log(
    `#${number} AI review (${tier}) prompt: ~${prompt.tokens} tokens, ${prompt.files.length} files, ${prompt.fullFiles} in full, ${prompt.relatedFiles} related, ${selectedLearnings.length} learnings${rules.length ? `, rules from ${rules.map(r => r.file).join(', ')}` : ''}`
  );
  if (dryRun && !model) return { prompt };
  if (!prompt.tooLarge && !model && !aiConfigured(env)) {
    log('the Claude API is not configured; set the federation variables or ANTHROPIC_API_KEY');
    return false;
  }
  const activeModel = prompt.tooLarge ? null : (model ?? (await createModel(env)));

  // Phase 1: Agentic read-only exploration for cross-package callers, policies and contracts.
  if (!prompt.tooLarge && activeModel) {
    const explored = await exploreContext({
      model: activeModel,
      prompt,
      client,
      pr,
      tracked,
      config,
      tier,
    });
    if (explored.context) {
      log(`agentic exploration: ${explored.steps} tool call(s)`);
      prompt = buildPrompt({
        pr,
        files,
        rules,
        learnings: selectedLearnings,
        glossary: learned.glossary?.[language] ?? [],
        existingReviews,
        ciFailures,
        exploredContext: explored.context,
        contents,
        related,
        stack: stack.packs,
        language,
        config,
      });
    }
  }

  const outcome = prompt.tooLarge
    ? { tooLarge: true }
    : await askClaude({ model: activeModel, prompt, config, tier });
  if (outcome.usage)
    log(`usage: ${outcome.usage.input} input, ${outcome.usage.output} output tokens`);

  // Phase 2: Critic / verifier removes false positives and duplicates before posting.
  if (outcome.result?.findings?.length && activeModel) {
    const verified = await verifyFindings({
      model: activeModel,
      prompt,
      findings: validFindings(outcome.result, prompt.files),
      config,
    });
    if (verified.dropped > 0) log(`verifier filtered ${verified.dropped} low-signal finding(s)`);
    outcome.result = { ...outcome.result, findings: verified.findings };
  }

  // Findings that sit on a diff line go out as one review; a later review never repeats them.
  let inline = [];
  if (outcome.result) {
    const plan = planInline({
      findings: validFindings(outcome.result, prompt.files),
      files,
      posted: dryRun ? new Set() : postedFingerprints(rawReviewComments, botLogin),
      enabled: config.ai.inline,
    });
    inline = plan.inline;
    const lines = plan.lines;
    if (inline.length && !dryRun) {
      await client
        .createReview(number, {
          commit_id: pr.head.sha,
          event: 'COMMENT',
          body: reviewBody(inline.length, language),
          comments: inline.map(f => reviewComment(f, lines.get(f.file), language)),
        })
        .catch(error => {
          log(`inline review failed, keeping every finding in the summary: ${error.message}`);
          inline = [];
        });
    }
  }
  const body = renderAiComment({
    head: pr.head.sha,
    language,
    model: outcome.model ?? config.ai.model,
    outcome,
    files: prompt.files,
    tokens: prompt.tokens,
    inline,
  });
  if (dryRun) {
    log(body);
    for (const f of inline) log(`inline ${f.file}:${f.line}\n${inlineComment(f, language)}`);
    return { prompt, outcome, inline };
  }
  await client.upsertComment(number, existing, body);
  return { prompt, outcome, inline };
}

/**
 * Replies to questions or pushback on a Centinela review thread or `@centinela` mention,
 * logging structured feedback markers so the self-learning loop captures dismissals.
 */
export async function runConversation({
  options,
  conversation,
  env = process.env,
  model = null,
}) {
  const { client, config, number, dryRun, botLogin, log } = options;
  if (config.conversation?.enabled === false) return log('conversation replies are off');
  const comment = conversation?.comment;
  if (!comment || comment.user?.type === 'Bot') return log('ignoring bot comment');

  let parentComment = null;
  if (conversation.isReviewComment) {
    if (!conversation.inReplyToId) return log('top-level review comment is not a Centinela reply');
    const comments = await client.reviewComments(number).catch(() => []);
    parentComment = comments.find(c => c.id === conversation.inReplyToId) ?? null;
    const isOwnParent =
      parentComment?.user?.type === 'Bot' &&
      (!botLogin || parentComment.user.login === botLogin);
    if (!isOwnParent && !isCentinelaMention(comment.body, botLogin)) {
      return log('review reply is not addressed to Centinela');
    }
  } else if (!isCentinelaMention(comment.body, botLogin)) {
    return log('comment does not mention Centinela');
  }

  if (!model && !aiConfigured(env)) return log('Claude API is not configured for replies');
  const item = conversation.isReviewComment
    ? await client.pull(number)
    : await client.issue(number);
  const baseRef = item.base?.ref ?? (await client.repository().catch(() => ({ default_branch: 'main' }))).default_branch;
  const [rules, stack] = await Promise.all([
    loadProjectRules({ client, ref: baseRef, paths: config.ai.rules }),
    detectStack({ client, ref: baseRef, setting: config.stack, legacy: config.rules }).catch(
      () => ({ packs: [], paths: [] })
    ),
  ]);
  const learned = await loadMultiProjectLearnings({
    client,
    ref: baseRef,
    stacks: stack.packs,
    paths: stack.paths,
    config,
  });
  const activeModel = model ?? (await createModel(env));
  const response = await answerThread({
    model: activeModel,
    item,
    comment,
    parentComment,
    rules,
    learnings: learned.learnings,
    language: conversation.language,
    config,
  });
  if (!response.result) return log('could not generate thread reply');
  const reply = renderThreadReply(response);
  if (dryRun) {
    log(reply);
    return response;
  }
  if (conversation.isReviewComment && client.replyToReviewComment) {
    await client.replyToReviewComment(number, parentComment?.id ?? comment.id, reply);
    // Collapse confirmed false positives so they never clutter the PR or block merge rules.
    if (response.result.outcome === 'dismissed' && client.resolveReviewThreadForComment) {
      await client
        .resolveReviewThreadForComment(number, parentComment?.id ?? comment.id)
        .catch(() => false);
    }
  } else {
    await client.comment(number, reply);
  }
  return response;
}

/**
 * Self-learning pass: harvests maintainer reviews & feedback reactions, routes candidates to
 * local repo or shared multi-project memory, retires noisy rules, and opens/updates learning PRs.
 */
export async function runLearn({ options, openPr = false }) {
  const { client, config, dryRun, botLogin, repo, log } = options;
  const repoInfo = await client.repository().catch(() => ({ default_branch: 'main', private: false }));
  const baseBranch = repoInfo.default_branch ?? 'main';
  const isPrivate = repoInfo.private === true;
  const [signals, stack] = await Promise.all([
    harvestSignals({ client, config, repo, botLogin }),
    detectStack({ client, ref: baseBranch, setting: config.stack, legacy: config.rules }).catch(
      () => ({ packs: [], paths: [] })
    ),
  ]);
  const localPath = config.learnings?.localPath || '.github/centinela/learnings.json';
  const localText = await client.fileAt(localPath, baseBranch).catch(() => null);
  const currentLocal = parseLearningsDoc(localText);

  const sharedRef = parseRemoteRef(config.learnings?.shared);
  const activeStacks = learningStacksFor({ packs: stack.packs, paths: stack.paths });
  const currentShared = new Map();
  if (sharedRef && client.externalFileAt) {
    const prefix = sharedRef.path ? `${sharedRef.path.replace(/\/+$/, '')}/` : 'learnings/';
    for (const key of ['global.json', ...activeStacks.map(s => `stacks/${s}.json`)]) {
      const text = await client
        .externalFileAt(sharedRef.repo, `${prefix}${key}`, sharedRef.ref)
        .catch(() => null);
      if (text) currentShared.set(key, parseLearningsDoc(text));
    }
  }

  const plan = planLearningUpdates({
    currentLocal,
    currentShared,
    signals,
    stacks: activeStacks,
    repo,
    isPrivate,
    config,
  });
  const body = renderLearningPrBody(plan, { repo });
  log(
    `learn: scanned ${signals.scannedPrs} PRs · +${plan.addedLocal.length} local, +${plan.addedShared.length} shared, -${plan.retirements.length} retired, ${plan.promotions.length} promotable`
  );
  if (dryRun || !openPr) {
    if (plan.addedLocal.length || plan.addedShared.length || plan.retirements.length) log(body);
    return plan;
  }

  const branch = 'chore/centinela-learnings';
  if ((plan.addedLocal.length || plan.retirements.length) && client.ensureBranch) {
    await client.ensureBranch({ targetRepo: repo, branch, from: baseBranch });
    await client.upsertRepoFile({
      targetRepo: repo,
      filePath: localPath,
      content: `${JSON.stringify(plan.nextLocal, null, 2)}\n`,
      branch,
      message: 'chore(centinela): update local learned rules',
    });
    await client.openOrUpdatePull({
      targetRepo: repo,
      head: branch,
      base: baseBranch,
      title: 'chore(centinela): update learned rules',
      body,
    });
  }
  if (sharedRef && plan.sharedUpdates.size && client.ensureBranch) {
    const sharedBranch = `chore/centinela-learnings-${repo.split('/').pop()}`;
    const prefix = sharedRef.path ? `${sharedRef.path.replace(/\/+$/, '')}/` : 'learnings/';
    await client.ensureBranch({
      targetRepo: sharedRef.repo,
      branch: sharedBranch,
      from: sharedRef.ref,
    });
    for (const [key, doc] of plan.sharedUpdates) {
      await client.upsertRepoFile({
        targetRepo: sharedRef.repo,
        filePath: `${prefix}${key}`,
        content: `${JSON.stringify(doc, null, 2)}\n`,
        branch: sharedBranch,
        message: `chore(centinela): update ${key} from ${repo.split('/').pop()}`,
      });
    }
    await client.openOrUpdatePull({
      targetRepo: sharedRef.repo,
      head: sharedBranch,
      base: sharedRef.ref,
      title: `chore(centinela): fleet learnings from ${repo.split('/').pop()}`,
      body,
    });
  }
  return plan;
}

/**
 * Open items from outside contributors that Centinela never reviewed, such as those opened
 * before it was installed. A few per day keep the run short.
 */
export async function runBackfill(options, { limit = 10, scan = 50 } = {}) {
  const { client, config, botLogin, log } = options;
  let reviewed = 0;
  for (const item of (await client.openItems()).slice(0, scan)) {
    if (reviewed >= limit) break;
    const author = item.user?.login;
    if (
      item.draft ||
      config.skipAuthors.includes(author) ||
      MAINTAINER_ASSOCIATIONS.has(item.author_association) ||
      config.maintainers.includes(author)
    )
      continue;
    if (ownComment(await client.comments(item.number), botLogin)) continue;
    const triage = item.pull_request ? triagePullRequest : triageIssue;
    await triage({ ...options, number: item.number, action: null }).catch(error =>
      log(`#${item.number} backfill failed: ${error.message}`)
    );
    reviewed++;
  }
  log(`backfill: ${reviewed} item(s) reviewed for the first time`);
  return reviewed;
}

/**
 * Daily pass over items waiting on their author: one reminder after a quiet period, then an
 * optional close. Approved, maintainer and skipped items are left alone.
 */
export async function runLifecycle({ client, config, dryRun, botLogin, log, now = Date.now() }) {
  const settings = config.lifecycle;
  // Created here so maintainers find the AI review label before its first use.
  if (!dryRun) await client.ensureLabel(config.labels.aiReview);
  if (!settings.remindAfterDays) return log('lifecycle reminders are off');
  const waiting = new Map();
  for (const label of [config.labels.waitingOnAuthor.name, config.labels.needsInfo.name]) {
    for (const item of await client.waitingOn(label)) waiting.set(item.number, item);
  }
  const actions = [];
  for (const item of waiting.values()) {
    const labels = item.labels.map(label => (typeof label === 'string' ? label : label.name));
    const held = [config.overrideLabel, config.labels.needsMaintainer.name].some(name =>
      labels.includes(name)
    );
    const skip = shouldSkip({
      author: item.user.login,
      association: item.author_association,
      labels,
      draft: item.draft === true,
      config,
    });
    if (held || skip) continue;
    const timeline = await client.timeline(item.number);
    const activity = lastActivity({ created: item.created_at, author: item.user.login, timeline });
    const reminded = reminderAt(timeline, botLogin);
    const action = lifecycleAction({ now, activity, reminderAt: reminded, settings });
    if (!action) continue;
    const days = Math.floor((now - (action === 'close' ? reminded : activity)) / 86_400_000);
    const body = lifecycleComment(action, detectLanguage(item.title, item.body ?? ''), {
      author: item.user.login,
      days,
      closeAfterDays: settings.closeAfterDays,
    });
    actions.push({ number: item.number, action });
    if (dryRun) {
      log(`#${item.number} ${action}\n${body}`);
      continue;
    }
    await client.comment(item.number, body);
    if (action === 'close') await client.close(item.number, Boolean(item.pull_request));
    log(`#${item.number} ${action}`);
  }
  log(`lifecycle: ${waiting.size} waiting on the author, ${actions.length} action(s)`);
  return actions;
}

/** Label events matter only for the opt-in, approval and bug labels, never the bot's own. */
export function relevantEvent(target, config) {
  if (target.action !== 'labeled' && target.action !== 'unlabeled') return true;
  if (target.eventLabel === config.labels.aiReview.name) return target.action === 'labeled';
  return [config.optInLabel, config.overrideLabel, config.issues.bugLabel].includes(
    target.eventLabel
  );
}

/**
 * The AI review label is a request: only people who can triage may apply it. Centinela reviews,
 * then removes the label so applying it again after a new commit asks once more.
 */
export async function runLabeledAiReview(options) {
  const { client, config, number, dryRun, log } = options;
  try {
    return await runAiReview({ options, again: true, tier: 'deep' });
  } catch (error) {
    log(`AI review failed: ${error.message}`);
    return false;
  } finally {
    if (!dryRun) await client.removeLabel(number, config.labels.aiReview.name);
  }
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
  const client = createClient({ token, repo, statusContext: config.statusContext });
  const botLogin =
    env.CENTINELA_BOT_LOGIN || (env.GITHUB_ACTIONS === 'true' ? 'github-actions[bot]' : null);
  if (
    target.kind !== 'lifecycle' &&
    target.kind !== 'learn' &&
    !relevantEvent(target, config)
  )
    return log(`label ${target.eventLabel} does not affect the review`);
  const options = {
    client,
    config,
    version: rulesVersion(config),
    // Inside Actions the identity is always known; dry runs accept any bot.
    botLogin,
    number: target.number,
    dryRun: target.dryRun,
    action: target.action,
    eventHeadSha: target.eventHeadSha,
    eventLabel: target.eventLabel,
    force: target.force,
    ref: target.ref,
    repo,
    log,
  };
  if (target.kind === 'learn') {
    return runLearn({ options, openPr: !target.dryRun });
  }
  if (target.kind === 'lifecycle') {
    await runLifecycle({ client, config, dryRun: target.dryRun, botLogin, log });
    await runBackfill(options);
    if (config.learnings?.weeklyPr && new Date().getUTCDay() === 1) {
      await runLearn({ options, openPr: !target.dryRun }).catch(error =>
        log(`weekly learning pass failed: ${error.message}`)
      );
    }
    return;
  }
  if (target.command) return runCommand({ command: target.command, options, kind: target.kind, env });
  if (target.conversation) return runConversation({ options, conversation: target.conversation, env });
  if (
    target.kind === 'pr' &&
    target.action === 'labeled' &&
    target.eventLabel === config.labels.aiReview.name
  )
    return runLabeledAiReview(options);
  return target.kind === 'pr'
    ? triagePullRequest({ ...options, env })
    : triageIssue({ ...options, env });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
