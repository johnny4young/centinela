import { readFileSync } from 'node:fs';

export const DEFAULTS = JSON.parse(
  readFileSync(new URL('../defaults.json', import.meta.url), 'utf8')
);

// Always reviewed by a maintainer; a project config can add paths but never remove these.
export const SENSITIVE_FLOOR = [
  '.github/**',
  'CODEOWNERS',
  '**/CODEOWNERS',
  'LICENSE*',
  'SECURITY.md',
  '**/SECURITY.md',
  '.npmrc',
  '**/.npmrc',
  '.yarnrc*',
  'pnpm-workspace.yaml',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Objects merge key by key; arrays and scalars from the project replace the defaults. */
export function merge(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = merge(base[key], value);
  return out;
}

export function resolveConfig(project = {}) {
  if (!isObject(project)) throw new Error('centinela: the config must be a JSON object');
  const config = merge(DEFAULTS, project);
  config.paths.sensitive = [...new Set([...SENSITIVE_FLOOR, ...(config.paths.sensitive ?? [])])];
  const sizes = Object.keys(config.labels.size);
  if (!sizes.includes(config.size.justifyFrom)) {
    throw new Error(`centinela: size.justifyFrom must be one of ${sizes.join(', ')}`);
  }
  return config;
}

export function parseConfig(text) {
  if (!text) return resolveConfig({});
  try {
    return resolveConfig(JSON.parse(text));
  } catch (error) {
    throw new Error(`centinela: invalid config: ${error.message}`);
  }
}

/** A link from the config, which may be one path or one per language. */
export function linkFor(value, language) {
  if (!value) return null;
  return typeof value === 'string' ? value : (value[language] ?? value.en ?? null);
}
