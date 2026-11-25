#!/usr/bin/env node
/**
 * Onboarding CLI for adopting Centinela across repositories:
 *   node src/cli-init.mjs [--dir .] [--shared owner/centinela-memory@main] [--maintainer login] [--write]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPacks } from './lib/packs.mjs';

function walkShallow(root, maxDepth = 3, prefix = '') {
  const out = [];
  if (maxDepth < 0 || !existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (['node_modules', 'dist', 'build', '.git', 'vendor', 'target'].includes(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkShallow(path.join(root, entry.name), maxDepth - 1, rel));
    else out.push(rel);
  }
  return out;
}

const MARKDOWN_RULE_DETECTORS = [
  {
    match: /\.default\(\s*null\s*\)/i,
    rule: {
      id: 'drizzle-null-default',
      severity: 'blocking',
      paths: ['**/db/**'],
      pattern: '\\.default\\(null\\)',
      message: 'Avoid `.default(null)` on JSON text columns; omit the default.',
    },
  },
  {
    match: /\btenantId\b/i,
    rule: {
      id: 'tenant-scope',
      severity: 'suggestion',
      paths: ['**/routers/**', '**/application/**'],
      message: 'Confirm every query scopes by `tenantId`.',
    },
  },
  {
    match: /\b(console\.log|no console\.log)\b/i,
    rule: {
      id: 'no-console-log',
      severity: 'suggestion',
      paths: ['src/**', 'apps/*/src/**', 'packages/*/src/**'],
      pattern: '\\bconsole\\.log\\s*\\(',
      message: 'Use the structured logger instead of `console.log`.',
    },
  },
];

/** Extracts deterministic `rules.custom` suggestions from AGENTS.md / CLAUDE.md prose. */
export function suggestCustomRulesFromMarkdown(markdownText = '') {
  if (!markdownText) return [];
  const rules = [];
  for (const detector of MARKDOWN_RULE_DETECTORS) {
    if (detector.match.test(markdownText)) rules.push(detector.rule);
  }
  return rules;
}

/** Generates a tailored `.github/centinela.json` and minimal reusable workflow stub for a repo. */
export function scaffoldForRepo({ dir, maintainer = null, shared = null, extendsRef = null }) {
  const paths = walkShallow(dir, 3);
  const manifests = paths
    .filter(p => p === 'package.json' || p.endsWith('/package.json'))
    .slice(0, 10)
    .map(file => {
      try {
        return JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const packs = detectPacks({ paths, manifests });
  const ruleFiles = ['AGENTS.md', 'CLAUDE.md', '.github/triage/REVIEW.md', 'CONTRIBUTING.md'].filter(
    f => paths.includes(f)
  );
  const prose = ruleFiles
    .map(file => {
      try {
        return readFileSync(path.join(dir, file), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  const suggestedCustom = suggestCustomRulesFromMarkdown(prose);
  const security = ['SECURITY.md', 'docs/SECURITY.md'].find(f => paths.includes(f)) ?? null;

  const config = {
    ...(extendsRef ? { extends: extendsRef } : {}),
    ...(maintainer ? { maintainers: [maintainer] } : {}),
    stack: 'auto',
    rules: {
      ui: true,
      comments: true,
      ...(suggestedCustom.length ? { custom: suggestedCustom } : {}),
    },
    ai: {
      autoReview: 'tiered',
      ...(ruleFiles.length ? { rules: ruleFiles } : {}),
    },
    ...(shared ? { learnings: { shared, shareScope: 'public-only', weeklyPr: true } } : {}),
    ...(security ? { links: { security } } : {}),
  };

  const workflow = `name: Centinela

on:
  pull_request_target:
    types: [opened, reopened, synchronize, edited, ready_for_review, labeled, unlabeled]
  issues:
    types: [opened, reopened, edited, labeled, unlabeled]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  schedule:
    - cron: '23 9 * * *'
  workflow_dispatch:

permissions: {}

jobs:
  centinela:
    uses: johnny4young/centinela/.github/workflows/reusable-centinela.yml@v1
    secrets: inherit
`;

  return { packs, config, workflow };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = flag => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : null;
  };
  const dir = path.resolve(get('--dir') || '.');
  const write = argv.includes('--write');
  const plan = scaffoldForRepo({
    dir,
    maintainer: get('--maintainer'),
    shared: get('--shared'),
    extendsRef: get('--extends'),
  });
  if (!write) {
    console.log(`Detected stack packs: ${plan.packs.join(', ') || 'none'}`);
    console.log('\n--- .github/centinela.json ---\n' + JSON.stringify(plan.config, null, 2));
    console.log('\n--- .github/workflows/centinela.yml ---\n' + plan.workflow);
    console.log('Pass --write to write these files.');
  } else {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(
      path.join(dir, '.github/centinela.json'),
      `${JSON.stringify(plan.config, null, 2)}\n`
    );
    writeFileSync(path.join(dir, '.github/workflows/centinela.yml'), plan.workflow);
    console.log(`Wrote .github/centinela.json and .github/workflows/centinela.yml (${plan.packs.join(', ') || 'generic'})`);
  }
}
