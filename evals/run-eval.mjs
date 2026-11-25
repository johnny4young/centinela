#!/usr/bin/env node
/**
 * Replay harness for Centinela's deterministic checks, hygiene detectors and issue triage against
 * real historical cases (precision, recall, false-positive rate).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askClaude, buildPrompt, createModel, validFindings } from '../src/lib/ai.mjs';
import { checkIssue, checkPullRequest } from '../src/lib/checks.mjs';
import { parseConfig, resolveConfig } from '../src/lib/config.mjs';
import { checkBranchState, checkCiFailures, checkMigrationCollisions, checkPrOverlap } from '../src/lib/hygiene.mjs';
import { applySuppressions } from '../src/lib/learnings.mjs';
import { applyStack } from '../src/lib/packs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function evaluateCase(entry) {
  const baseConfig = entry.config ? resolveConfig(entry.config) : parseConfig('');
  const { config, rules } = applyStack(baseConfig, {
    packs: entry.packs ?? [],
    paths: entry.basePaths ?? [],
  });

  let actual = [];
  if (entry.kind === 'issue') {
    actual = checkIssue({
      title: entry.title,
      body: entry.body,
      labels: entry.labels ?? [],
      config,
    });
  } else {
    const raw = [
      ...checkPullRequest({
        totals: entry.totals ?? { files: (entry.files ?? []).length, commits: (entry.commits ?? []).length },
        title: entry.title,
        body: entry.body ?? '',
        author: entry.author ?? 'contributor',
        files: entry.files ?? [],
        commits: entry.commits ?? [],
        config,
        rules,
        workflows: entry.workflows ?? [],
        repo: entry.repo ?? 'owner/repo',
        localeGaps: entry.localeGaps ?? [],
        dependencies: entry.dependencies ?? [],
        typos: entry.typos ?? [],
      }),
      ...checkBranchState({ pr: entry.pr ?? {}, behindBy: entry.behindBy ?? null, config }),
      ...checkMigrationCollisions({ files: entry.files ?? [], basePaths: entry.basePaths ?? [], config }),
      ...checkPrOverlap({
        number: entry.number ?? 1,
        commits: entry.commits ?? [],
        openPulls: entry.openPulls ?? [],
        config,
      }),
      ...checkCiFailures({ checkRuns: entry.checkRuns ?? [], config }),
    ];
    actual = applySuppressions(raw, entry.suppressions ?? []);
  }

  const foundIds = new Set(actual.map(f => f.id));
  const mustFind = entry.expect?.mustFind ?? [];
  const mustNotFind = entry.expect?.mustNotFind ?? [];

  const truePositives = mustFind.filter(id => foundIds.has(id));
  const falseNegatives = mustFind.filter(id => !foundIds.has(id));
  const falsePositives = mustNotFind.filter(id => foundIds.has(id));

  return {
    id: entry.id,
    passed: falseNegatives.length === 0 && falsePositives.length === 0,
    truePositives,
    falseNegatives,
    falsePositives,
    found: [...foundIds],
  };
}

export function runSuite(fixturePath = path.join(here, 'fixtures/puntovivo-cases.json')) {
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const results = cases.map(evaluateCase);
  const tp = results.reduce((n, r) => n + r.truePositives.length, 0);
  const fn = results.reduce((n, r) => n + r.falseNegatives.length, 0);
  const fp = results.reduce((n, r) => n + r.falsePositives.length, 0);
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  return { results, tp, fn, fp, precision, recall, passed: results.every(r => r.passed) };
}

function matchesExpectation(finding, spec) {
  if (spec.file && finding.file !== spec.file) return false;
  const hay = `${finding.title ?? ''} ${finding.detail ?? ''} ${finding.category ?? ''}`.toLowerCase();
  return !spec.keywords?.length || spec.keywords.some(k => hay.includes(k.toLowerCase()));
}

/** Evaluates Centinela's AI review layer on a single fixture case using a live or mocked model. */
export async function evaluateAiCase(entry, { model, config = parseConfig('') }) {
  const contents = new Map(Object.entries(entry.contents ?? {}));
  const prompt = buildPrompt({
    pr: entry.pr,
    files: entry.files ?? [],
    contents,
    related: new Map(),
    rules: entry.rules ?? [],
    learnings: entry.learnings ?? [],
    stack: entry.packs ?? [],
    language: 'en',
    config,
  });
  const outcome = await askClaude({ model, prompt, config, tier: 'fast' });
  const findings = outcome.result
    ? validFindings(outcome.result, (entry.files ?? []).map(f => f.filename))
    : [];
  const mustMatch = entry.expect?.mustMatch ?? [];
  const mustNotMatch = entry.expect?.mustNotMatch ?? [];
  const tp = mustMatch.filter(spec => findings.some(f => matchesExpectation(f, spec))).length;
  const fn = mustMatch.length - tp;
  const fp = mustNotMatch.filter(spec => findings.some(f => matchesExpectation(f, spec))).length;
  return {
    id: entry.id,
    passed: fn === 0 && fp === 0 && !outcome.error,
    tp,
    fn,
    fp,
    usage: outcome.usage ?? { input: 0, output: 0 },
    findingsCount: findings.length,
    error: outcome.error ?? null,
  };
}

export async function runAiSuite({
  model,
  fixturePath = path.join(here, 'fixtures/ai-cases.json'),
} = {}) {
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const results = [];
  for (const entry of cases) results.push(await evaluateAiCase(entry, { model }));
  const tp = results.reduce((n, r) => n + r.tp, 0);
  const fn = results.reduce((n, r) => n + r.fn, 0);
  const fp = results.reduce((n, r) => n + r.fp, 0);
  const inputTokens = results.reduce((n, r) => n + (r.usage?.input ?? 0), 0);
  const outputTokens = results.reduce((n, r) => n + (r.usage?.output ?? 0), 0);
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    results,
    tp,
    fn,
    fp,
    precision,
    recall,
    f1,
    inputTokens,
    outputTokens,
    passed: results.every(r => r.passed),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--ai')) {
    const model = await createModel(process.env);
    const ai = await runAiSuite({ model });
    for (const r of ai.results) {
      console.log(
        `${r.passed ? 'PASS' : 'FAIL'} ${r.id} (findings=${r.findingsCount}, tokens=${r.usage.input}in/${r.usage.output}out${r.error ? `, error=${r.error}` : ''})`
      );
    }
    console.log(
      `\nAI Summary: ${ai.results.filter(r => r.passed).length}/${ai.results.length} passed · precision=${(ai.precision * 100).toFixed(1)}% · recall=${(ai.recall * 100).toFixed(1)}% · F1=${(ai.f1 * 100).toFixed(1)}% · tokens=${ai.inputTokens}in/${ai.outputTokens}out`
    );
    if (!ai.passed) process.exit(1);
  } else {
    const summary = runSuite();
    for (const r of summary.results) {
      const icon = r.passed ? 'PASS' : 'FAIL';
      console.log(
        `${icon} ${r.id} (found: ${r.found.join(', ') || 'none'}${r.falseNegatives.length ? ` | missed: ${r.falseNegatives.join(', ')}` : ''}${r.falsePositives.length ? ` | fp: ${r.falsePositives.join(', ')}` : ''})`
      );
    }
    console.log(
      `\nSummary: ${summary.results.filter(r => r.passed).length}/${summary.results.length} passed · precision=${(summary.precision * 100).toFixed(1)}% · recall=${(summary.recall * 100).toFixed(1)}%`
    );
    if (!summary.passed) process.exit(1);
  }
}
