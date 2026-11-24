import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { addedLines, matcher } from './core.mjs';

const run = promisify(execFile);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const DAY = 86_400_000;
const LOCKFILES = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/go.sum',
  '**/Cargo.lock',
];

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function flatKeys(value, prefix = '', out = new Set()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      flatKeys(child, prefix ? `${prefix}.${key}` : key, out);
  } else if (prefix) {
    out.add(prefix);
  }
  return out;
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keys a changed locale file has that the same file in another language lacks at the PR head.
 * `parity` is `{ dir, languages }`, for locale files laid out as `<dir>/<language>/<name>.json`.
 */
export async function localeGaps({ files, fileAt, headSha, parity, limit = 10 }) {
  if (!parity?.dir || !(parity.languages?.length > 1)) return [];
  const dir = parity.dir.replace(/\/+$/, '');
  const pattern = new RegExp(
    `^${escape(dir)}/(${parity.languages.map(escape).join('|')})(/.+\\.json)$`
  );
  const gaps = [];
  for (const file of files) {
    const match = file.filename.match(pattern);
    if (!match || file.status === 'removed') continue;
    const mineKeys = flatKeys(parseJson(await fileAt(file.filename, headSha)));
    for (const language of parity.languages.filter(l => l !== match[1])) {
      const other = `${dir}/${language}${match[2]}`;
      const theirKeys = flatKeys(parseJson(await fileAt(other, headSha)));
      for (const key of mineKeys) {
        if (!theirKeys.has(key)) gaps.push({ file: file.filename, missingIn: other, key });
        if (gaps.length >= limit) return gaps;
      }
    }
  }
  return gaps;
}

// Overrides and resolutions redirect what gets installed just like a direct dependency.
const OVERRIDE_FIELDS = [
  ['overrides', manifest => manifest?.overrides],
  ['pnpm.overrides', manifest => manifest?.pnpm?.overrides],
  ['resolutions', manifest => manifest?.resolutions],
];

export function changedDependencies(base, head) {
  const changes = [];
  const fields = [
    ...DEP_FIELDS.map(field => [field, manifest => manifest?.[field]]),
    ...OVERRIDE_FIELDS,
  ];
  for (const [field, read] of fields) {
    const before = read(base) ?? {};
    for (const [name, value] of Object.entries(read(head) ?? {})) {
      const spec = typeof value === 'string' ? value : JSON.stringify(value);
      const previous =
        typeof before[name] === 'string' ? before[name] : JSON.stringify(before[name]);
      if (previous !== spec) changes.push({ name, spec, field });
    }
  }
  return changes;
}

export function pinnedVersion(spec) {
  if (/^(workspace:|npm:|file:|link:|git|https?:|github:|catalog:)/.test(spec)) return null;
  return spec.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? null;
}

export async function registryInfo(name, version, { fetchImpl = fetch, now = Date.now() } = {}) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { license: null, ageDays: null };
    const doc = await response.json();
    const manifest = doc.versions?.[version];
    const license =
      typeof manifest?.license === 'string' ? manifest.license : (manifest?.license?.type ?? null);
    const published = doc.time?.[version];
    return { license, ageDays: published ? Math.floor((now - Date.parse(published)) / DAY) : null };
  } catch {
    return { license: null, ageDays: null };
  }
}

export async function dependencyChanges({
  files,
  fileAt,
  baseSha,
  headSha,
  lookup = registryInfo,
  limit = 10,
}) {
  const results = [];
  for (const file of files) {
    if (!(file.filename === 'package.json' || file.filename.endsWith('/package.json'))) continue;
    if (file.status === 'removed') continue;
    const [base, head] = await Promise.all([
      fileAt(file.filename, baseSha),
      fileAt(file.filename, headSha),
    ]);
    for (const change of changedDependencies(parseJson(base), parseJson(head))) {
      if (results.length >= limit) return results;
      const version = pinnedVersion(change.spec);
      const info = version ? await lookup(change.name, version) : { license: null, ageDays: null };
      results.push({ name: change.name, version: version ?? change.spec, ...info });
    }
  }
  return results;
}

const SPANISH_COMMON_TYPO_FP = new Set([
  'foto',
  'fotos',
  'precio',
  'precios',
  'numero',
  'fecha',
  'caja',
  'venta',
  'ventas',
  'compra',
  'compras',
  'producto',
  'productos',
  'cliente',
  'clientes',
  'factura',
  'remision',
  'orden',
  'pedido',
  'total',
  'cambio',
  'efectivo',
  'credito',
  'debito',
  'bodega',
  'sucursal',
  'usuario',
]);

/** Run typos over the added lines only, mapping results back to the PR's line numbers. */
export async function findTypos({
  files,
  exclude = [],
  ignoreWords = [],
  spanishEnabled = false,
  binary = process.env.TYPOS_BIN || 'typos',
  required = false,
}) {
  const skip = matcher([...LOCKFILES, '**/*.svg', ...exclude]);
  const ignored = new Set([
    ...ignoreWords.map(w => String(w).toLowerCase()),
    ...(spanishEnabled ? SPANISH_COMMON_TYPO_FP : []),
  ]);
  const dir = await mkdtemp(path.join(tmpdir(), 'centinela-typos-'));
  const map = new Map();
  try {
    for (const file of files) {
      if (skip(file.filename)) continue;
      const lines = addedLines(file.patch);
      if (!lines.length) continue;
      const target = path.resolve(dir, file.filename);
      if (!target.startsWith(`${dir}${path.sep}`)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, lines.map(l => l.text).join('\n'));
      map.set(path.relative(dir, target).split(path.sep).join('/'), lines);
    }
    if (!map.size) return [];
    let stdout;
    try {
      ({ stdout } = await run(binary, ['--format', 'json', '.'], {
        cwd: dir,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (required) throw new Error(`centinela: typos binary not found (${binary})`);
        return null;
      }
      stdout = error.stdout ?? '';
      if (!stdout) throw error;
    }
    return stdout
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(entry => entry.type === 'typo' && !ignored.has(String(entry.typo).toLowerCase()))
      .map(entry => {
        const file = entry.path.replace(/^\.\//, '');
        const original = map.get(file)?.[entry.line_num - 1];
        return {
          file,
          line: original?.line ?? null,
          typo: entry.typo,
          corrections: entry.corrections ?? [],
        };
      });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
