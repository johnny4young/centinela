#!/usr/bin/env node
/**
 * Replay harness for Centinela's deterministic checks, hygiene detectors and issue triage against
 * real historical cases (precision, recall, false-positive rate).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
