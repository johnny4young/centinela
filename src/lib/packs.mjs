/**
 * Stack packs: rules and paths that apply when a repository uses a stack. Patterns run on added
 * lines only. Security rules set `tests: true` so a test file cannot hide them; performance rules
 * skip tests. A rule without a pattern fires once for each matching file.
 */
const MANIFEST_SKIP = /(^|\/)(node_modules|fixtures|examples|test|tests|e2e|vendor)\//;
const NODE_SERVERS = ['fastify', 'express', '@trpc/server', 'koa', 'hono', '@nestjs/core'];

export const PACKS = {
  electron: {
    name: 'Electron',
    detect: ({ deps }) => deps.has('electron'),
    paths: {
      sensitive: ['**/preload/**', '**/preload.*', '**/electron-builder.yml', '**/forge.config.*'],
    },
    rules: [
      {
        id: 'electron-hardening',
        tests: true,
        severity: 'blocking',
        pattern:
          /\b(sandbox|contextIsolation|webSecurity)\s*:\s*false\b|\bnodeIntegration\s*:\s*true\b/,
      },
      {
        id: 'electron-preload-node',
        tests: true,
        severity: 'blocking',
        paths: ['**/preload/**', '**/preload.*'],
        pattern:
          /\brequire\(\s*['"](node:)?(fs|child_process|net|os|path|http|https)['"]|\bfrom\s+['"](node:)?(fs|child_process|net|os|http|https)(\/promises)?['"]/,
      },
      {
        id: 'electron-remote',
        tests: true,
        severity: 'blocking',
        pattern: /@electron\/remote|\benableRemoteModule\b/,
      },
      { id: 'electron-sync-ipc', severity: 'maintainer', pattern: /\bsendSync\s*\(/ },
      {
        id: 'electron-open-external',
        tests: true,
        severity: 'maintainer',
        pattern: /\bopenExternal\s*\(/,
      },
      {
        id: 'electron-main-sync-io',
        severity: 'suggestion',
        paths: ['**/main/**', '**/electron/**'],
        pattern: /\b(readFileSync|writeFileSync|execSync|spawnSync|readdirSync)\s*\(/,
      },
    ],
  },
  react: {
    name: 'React',
    detect: ({ deps }) => deps.has('react'),
    rules: [
      {
        id: 'react-dangerous-html',
        tests: true,
        severity: 'maintainer',
        pattern: /dangerouslySetInnerHTML/,
      },
      { id: 'react-async-effect', severity: 'suggestion', pattern: /\buseEffect\(\s*async\b/ },
    ],
  },
  'node-server': {
    name: 'Node server',
    detect: ({ deps }) => NODE_SERVERS.some(name => deps.has(name)),
    rules: [
      {
        id: 'server-sync-io',
        severity: 'suggestion',
        paths: [
          '**/server/**',
          '**/api/**',
          '**/routes/**',
          '**/routers/**',
          '**/handlers/**',
          '**/services/**',
        ],
        pattern: /\b(readFileSync|writeFileSync|execSync|spawnSync|readdirSync)\s*\(/,
      },
      {
        id: 'sql-interpolation',
        tests: true,
        severity: 'maintainer',
        pattern: /\b(sql\.raw|\.raw|\.exec|\.prepare|\.query)\(\s*`[^`]*\$\{/,
      },
    ],
  },
  swift: {
    name: 'Swift',
    detect: ({ paths }) =>
      paths.some(p => p === 'Package.swift' || p.endsWith('.xcodeproj/project.pbxproj')) ||
      paths.includes('project.yml'),
    paths: {
      ui: ['**/*View.swift', '**/Views/**/*.swift'],
      source: ['**/*.swift'],
      tests: ['**/*Tests.swift', '**/*Tests/**', '**/UITests/**'],
      sensitive: ['**/*.entitlements'],
    },
    rules: [
      {
        id: 'swift-unchecked-sendable',
        severity: 'maintainer',
        pattern: /@unchecked\s+Sendable/,
        unless: /\/\//,
      },
      { id: 'swift-nonisolated-unsafe', severity: 'maintainer', pattern: /nonisolated\(unsafe\)/ },
      { id: 'swift-main-sync', severity: 'maintainer', pattern: /DispatchQueue\.main\.sync\b/ },
      { id: 'swift-force-try', severity: 'maintainer', pattern: /\btry!\s/ },
      {
        id: 'swift-untracked-task',
        severity: 'suggestion',
        pattern: /(?:^|[;{]\s*)Task(?:\.detached)?\s*(?:\([^)]*\))?\s*\{/,
        unless: /=\s*Task|return\s+Task|\.task\b/,
      },
      {
        id: 'swift-silent-try-optional',
        severity: 'suggestion',
        pattern: /\btry\?\s+(?:await\s+)?[^\n]*\b(?:save|write|delete|persist|migrate|commit|execute|encode)\b/i,
      },
      {
        id: 'swift-sleep',
        severity: 'suggestion',
        pattern: /\bThread\.sleep\b|\busleep\s*\(|(?<![\w.])sleep\s*\(/,
      },
      {
        id: 'swift-xcodeproj-edit',
        severity: 'maintainer',
        when: ({ paths }) => paths.includes('project.yml'),
        paths: ['**/*.xcodeproj/**'],
        tests: true,
      },
    ],
  },
  go: {
    name: 'Go',
    detect: ({ paths }) => paths.includes('go.mod'),
    paths: {
      source: ['**/*.go'],
      tests: ['**/*_test.go'],
      sensitive: ['go.mod', 'go.sum'],
    },
    rules: [
      {
        id: 'go-http-default-client',
        severity: 'suggestion',
        paths: ['**/*.go'],
        pattern: /\bhttp\.(Get|Post|PostForm|Head|DefaultClient)\b/,
      },
      {
        id: 'go-sql-concat',
        tests: true,
        severity: 'maintainer',
        paths: ['**/*.go'],
        pattern: /\.(Query|QueryRow|Exec)(Context)?\s*\([^)]*fmt\.Sprintf\b/,
      },
      {
        id: 'go-ignored-error',
        severity: 'suggestion',
        paths: ['**/*.go'],
        pattern: /\b_\s*=\s*[A-Za-z_][\w.]*\.(?:Close|Write|Flush|Commit|Rollback|Exec|Save|Remove)\s*\(/,
      },
      {
        id: 'go-goroutine-no-ctx',
        severity: 'suggestion',
        paths: ['**/*.go'],
        pattern: /\bgo\s+func\s*\(\s*\)\s*\{/,
        unless: /\b(?:ctx|context|Done\()/,
      },
    ],
  },
  rust: {
    name: 'Rust',
    detect: ({ paths }) => paths.includes('Cargo.toml'),
    paths: { source: ['**/*.rs'], sensitive: ['build.rs', '**/build.rs'] },
    rules: [
      {
        id: 'rust-unsafe',
        tests: true,
        severity: 'maintainer',
        pattern: /\bunsafe\s*(\{|fn\b|impl\b|extern\b)/,
      },
    ],
  },
  shell: {
    name: 'Shell',
    detect: ({ paths }) =>
      paths.some(p => /^[^/]+\.sh$/.test(p)) &&
      !paths.includes('package.json') &&
      !paths.includes('go.mod') &&
      !paths.includes('Cargo.toml'),
    paths: {
      source: ['**/*.sh', 'bin/**'],
    },
    rules: [
      {
        id: 'shell-eval',
        tests: true,
        severity: 'maintainer',
        paths: ['**/*.sh', 'bin/**'],
        pattern: /(?:^|[;&|]\s*)eval\s+/,
      },
    ],
  },
};

export const EXTRA_RULES = {
  ui: [
    {
      id: 'ui-left-accent-bar',
      severity: 'suggestion',
      paths: ['**/*.tsx', '**/*.jsx', '**/*.css', '**/*.scss', '**/*.swift'],
      pattern:
        /\bborder-(?:l|s)-(?:2|4|8)\b|\bborder-(?:left|inline-start)\s*:\s*[2-6]px\b|\.overlay\s*\(\s*alignment:\s*\.leading\s*\)/,
    },
  ],
  comments: [
    {
      id: 'internal-comment-ref',
      severity: 'suggestion',
      pattern:
        /\/\/.*\b(?:owner\s+decision\s+D\d+|sprint\s+\d+|[A-Z]{2,6}-\d{2,5})\b/i,
    },
  ],
};

/** The package.json files worth reading: the root and workspace packages, not fixtures. */
export function manifestPaths(paths, limit = 12) {
  return paths
    .filter(p => (p === 'package.json' || p.endsWith('/package.json')) && !MANIFEST_SKIP.test(p))
    .filter(p => p.split('/').length <= 3)
    .slice(0, limit);
}

export function dependencyNames(manifests) {
  const deps = new Set();
  for (const manifest of manifests) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(manifest?.[field] ?? {})) deps.add(name);
    }
  }
  return deps;
}

/** Pack ids for a repository, from its tracked paths and package manifests. */
export function detectPacks({ paths, manifests }) {
  const signals = { paths, deps: dependencyNames(manifests) };
  return Object.entries(PACKS)
    .filter(([, pack]) => pack.detect(signals))
    .map(([id]) => id);
}

/** Read the base tree and manifests through the API and return the stack it implies. */
export async function detectStack({ client, ref, setting = 'auto', legacy = {} }) {
  const forced = Array.isArray(setting) ? setting : [];
  if (legacy.electron) forced.push('electron');
  if (setting !== 'auto') return { packs: [...new Set(forced)], paths: [] };
  const paths = await client.tree(ref);
  const manifests = [];
  for (const file of manifestPaths(paths)) {
    try {
      const text = await client.fileAt(file, ref);
      if (text) manifests.push(JSON.parse(text));
    } catch {
      // An unreadable manifest only means one less signal.
    }
  }
  return { packs: [...new Set([...detectPacks({ paths, manifests }), ...forced])], paths };
}

/** The config with each pack's paths added, plus the rules that apply to this repository. */
export function applyStack(config, stack) {
  const paths = structuredClone(config.paths);
  const rules = [];
  for (const id of stack.packs) {
    const pack = PACKS[id];
    if (!pack) continue;
    for (const [key, globs] of Object.entries(pack.paths ?? {})) {
      paths[key] = [...new Set([...(paths[key] ?? []), ...globs])];
    }
    for (const rule of pack.rules) {
      if (!rule.when || rule.when({ paths: stack.paths ?? [] })) rules.push(rule);
    }
  }
  if (config.rules?.ui) rules.push(...EXTRA_RULES.ui);
  if (config.rules?.comments) rules.push(...EXTRA_RULES.comments);
  return { config: { ...config, paths }, rules };
}

export const packName = id => PACKS[id]?.name ?? id;
