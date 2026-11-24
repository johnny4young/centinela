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
  validateStack(config.stack);
  const sections = config.pullRequest.sections;
  if (sections !== 'template' && !Array.isArray(sections))
    throw new Error('centinela: pullRequest.sections must be "template" or a list of sections');
  config.rules.custom = (config.rules.custom ?? []).map(validateRule);
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(config.ai.effort))
    throw new Error('centinela: ai.effort must be low, medium, high, xhigh or max');
  if (!(Number.isInteger(config.ai.maxInputTokens) && config.ai.maxInputTokens > 0))
    throw new Error('centinela: ai.maxInputTokens must be a positive number');
  for (const key of ['maxFileTokens', 'maxRelatedTokens']) {
    if (!(Number.isInteger(config.ai[key]) && config.ai[key] >= 0))
      throw new Error(`centinela: ai.${key} must be zero or a positive number`);
  }
  if (!Array.isArray(config.ai.rules) || !config.ai.rules.every(p => typeof p === 'string'))
    throw new Error('centinela: ai.rules must be a list of repository paths');
  for (const key of ['remindAfterDays', 'closeAfterDays']) {
    const days = config.lifecycle[key];
    if (days !== null && !(Number.isInteger(days) && days > 0))
      throw new Error(`centinela: lifecycle.${key} must be a positive number of days or null`);
  }
  const sizes = Object.keys(config.labels.size);
  if (!sizes.includes(config.size.justifyFrom)) {
    throw new Error(`centinela: size.justifyFrom must be one of ${sizes.join(', ')}`);
  }
  return config;
}

const SEVERITIES = ['blocking', 'maintainer', 'suggestion'];

function validateStack(stack) {
  if (stack === 'auto' || (Array.isArray(stack) && stack.every(id => typeof id === 'string')))
    return;
  throw new Error('centinela: stack must be "auto" or a list of pack ids');
}

/** A project rule needs an id, a severity, a message and a pattern or paths. */
function validateRule(rule, index) {
  const where = `rules.custom[${index}]`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(rule?.id ?? ''))
    throw new Error(`centinela: ${where}.id must be lowercase words joined by hyphens`);
  if (!SEVERITIES.includes(rule.severity))
    throw new Error(`centinela: ${where}.severity must be one of ${SEVERITIES.join(', ')}`);
  if (!rule.message) throw new Error(`centinela: ${where}.message is required`);
  if (!rule.pattern && !rule.paths?.length)
    throw new Error(`centinela: ${where} needs a pattern, paths or both`);
  for (const key of ['pattern', 'unless']) {
    if (!rule[key]) continue;
    try {
      new RegExp(rule[key], key === 'pattern' ? (rule.flags ?? '').replace(/[gy]/g, '') : '');
    } catch (error) {
      throw new Error(
        `centinela: ${where}.${key} is not a valid regular expression: ${error.message}`
      );
    }
  }
  return rule;
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
