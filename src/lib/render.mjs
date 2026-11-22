import { linkFor } from './config.mjs';
import { markerFor } from './core.mjs';

const code = value => `\`${String(value).replace(/`/g, "'").replace(/\s+/g, ' ')}\``;
const list = values => values.map(code).join(', ');
const incomplete = (p, labels) =>
  [
    ...(p.files ? [`${p.files[0]}/${p.files[1]} ${labels.files}`] : []),
    ...(p.commits ? [`${p.commits[0]}/${p.commits[1]} ${labels.commits}`] : []),
    ...(p.unread.length ? [list(p.unread.slice(0, 5))] : []),
  ].join(', ');
const sectionNames = (p, language) =>
  p.labels.map(label => `**${label[language] ?? label.en}**`).join(', ');
const ISSUE_FIELD = {
  en: {
    steps: 'steps to reproduce',
    expected: 'expected behavior',
    actual: 'actual behavior',
    version: product => (product ? `${product} version` : 'app version'),
    platform: 'operating system',
  },
  es: {
    steps: 'pasos para reproducir',
    expected: 'comportamiento esperado',
    actual: 'comportamiento actual',
    version: product => (product ? `versión de ${product}` : 'versión de la app'),
    platform: 'sistema operativo',
  },
};

const field = (language, name, ctx) => {
  const value = ISSUE_FIELD[language][name];
  return typeof value === 'function' ? value(ctx.product) : value;
};

const MESSAGES = {
  en: {
    title: p =>
      `The title ${code(p.title)} does not follow Conventional Commits, e.g. ${code('fix(parser): keep empty lines')}.`,
    description: p =>
      `Please fill in these sections of the pull request template: ${sectionNames(p, 'en')}.`,
    size: p =>
      `This pull request changes ${p.lines} lines (${p.label}). If it can be split into smaller, independent pull requests, review will be faster; otherwise, please explain in **Why** why it needs to land together.`,
    screenshots: p =>
      `It changes user-facing UI (${list(p.files.slice(0, 5))}). Please attach before/after screenshots or a short recording.`,
    reproduction: () =>
      'For a fix, please link the issue or add numbered steps to reproduce the bug in **How to test**.',
    tests: p =>
      `It adds ${p.lines} lines of source code without touching tests. Please add or update tests that cover the change.`,
    dialect: p =>
      `Spanish copy must use neutral Latin American Spanish in the ${p.register === 'tu' ? 'tú' : 'usted'} register; found ${list(p.words)}.`,
    'locale-parity': p =>
      `The key ${code(p.key)} exists in ${code(p.file)} but not in ${code(p.missingIn)}. Every key needs to exist in each language.`,
    typo: p =>
      `Possible typo ${code(p.typo)}${p.corrections?.length ? `; did you mean ${list(p.corrections)}?` : '.'}`,
    'sensitive-paths': p =>
      `It touches files that need a maintainer's review: ${list(p.files.slice(0, 8))}${p.files.length > 8 ? ` and ${p.files.length - 8} more` : ''}.`,
    'incomplete-diff': p =>
      `The diff is too large for the automated review to read in full (${incomplete(p, { files: 'files', commits: 'commits' })}); a maintainer needs to review it by hand.`,
    binary: () =>
      'It adds a binary file. Binaries cannot be reviewed; a maintainer needs to confirm where it comes from.',
    'lifecycle-script': () =>
      'It adds a package install or prepare script, which runs on every contributor machine.',
    authorship: () => 'It changes authorship, copyright or package author metadata.',
    'hidden-unicode': () =>
      'It contains invisible or bidirectional Unicode characters, which can hide what the code really does. Please remove them.',
    secret: () =>
      'It looks like a credential or private key. Please remove it and rotate it if it was real.',
    'electron-hardening': () =>
      'It disables an Electron security setting (sandbox, context isolation, web security or node integration). The renderer must stay sandboxed.',
    'dynamic-code': () => 'It evaluates code dynamically (`eval` or `new Function`).',
    'process-spawn': () => 'It spawns processes from new code.',
    'pipe-to-shell': () => 'It pipes a download straight into a shell.',
    obfuscation: () =>
      'It contains a long encoded or escaped blob. Please explain what it is or replace it with readable code.',
    impersonation: p =>
      `Commit ${code(p.sha)} carries a maintainer identity without a verified signature; a maintainer needs to confirm they wrote it.`,
    'dep-license': (p, ctx) =>
      `The dependency ${code(p.name)} is licensed ${code(p.license)}, which is not compatible with ${ctx.license ? `this ${code(ctx.license)} project` : 'the licenses this project accepts'}.`,
    'dep-age': p =>
      `The dependency ${code(`${p.name}@${p.version}`)} was published ${p.ageDays} days ago; the project waits at least ${p.minAgeDays} days before adopting a release.`,
    dependency: p =>
      `New or changed dependency ${code(`${p.name}@${p.version}`)}${p.license ? ` (${code(p.license)})` : ''}.`,
    'security-report': (p, ctx) =>
      `If this describes a security vulnerability, please report it privately as explained in the [security policy](${ctx.security('en')}) and remove the details from this issue.`,
    'issue-empty': () =>
      'Please describe the problem or idea in a few sentences so we can understand it.',
    'issue-incomplete': (p, ctx) =>
      `To reproduce it, please add: ${p.missing.map(m => field('en', m, ctx)).join(', ')}.`,
    'issue-media': () => 'A screenshot or short recording would help us a lot.',
  },
  es: {
    title: p =>
      `El título ${code(p.title)} no sigue Conventional Commits; por ejemplo: ${code('fix(parser): conserva las líneas vacías')}.`,
    description: p =>
      `Por favor complete estas secciones de la plantilla: ${sectionNames(p, 'es')}.`,
    size: p =>
      `Esta pull request cambia ${p.lines} líneas (${p.label}). Si puede dividirse en pull requests más pequeñas e independientes, la revisión será más rápida; si no, explique en **Por qué** la razón para integrarla junta.`,
    screenshots: p =>
      `Cambia la interfaz visible (${list(p.files.slice(0, 5))}). Por favor adjunte capturas de antes y después, o una grabación corta.`,
    reproduction: () =>
      'Para una corrección, enlace el issue o agregue pasos numerados para reproducir el error en **Cómo probar**.',
    tests: p =>
      `Agrega ${p.lines} líneas de código sin tocar pruebas. Por favor agregue o actualice pruebas que cubran el cambio.`,
    dialect: p =>
      `Los textos en español deben usar español latinoamericano neutro con registro ${p.register === 'tu' ? 'tú' : 'usted'}; se encontró ${list(p.words)}.`,
    'locale-parity': p =>
      `La clave ${code(p.key)} existe en ${code(p.file)} pero no en ${code(p.missingIn)}. Cada clave debe existir en todos los idiomas.`,
    typo: p =>
      `Posible error de escritura ${code(p.typo)}${p.corrections?.length ? `; ¿quiso decir ${list(p.corrections)}?` : '.'}`,
    'sensitive-paths': p =>
      `Modifica archivos que requieren revisión de un mantenedor: ${list(p.files.slice(0, 8))}${p.files.length > 8 ? ` y ${p.files.length - 8} más` : ''}.`,
    'incomplete-diff': p =>
      `El diff es demasiado grande para que la revisión automática lo lea completo (${incomplete(p, { files: 'archivos', commits: 'commits' })}); un mantenedor debe revisarlo a mano.`,
    binary: () =>
      'Agrega un archivo binario. Los binarios no se pueden revisar; un mantenedor debe confirmar su origen.',
    'lifecycle-script': () =>
      'Agrega un script de instalación o prepare, que se ejecuta en la máquina de cada colaborador.',
    authorship: () => 'Cambia autoría, copyright o los metadatos de autor del paquete.',
    'hidden-unicode': () =>
      'Contiene caracteres Unicode invisibles o bidireccionales, que pueden ocultar lo que realmente hace el código. Por favor elimínelos.',
    secret: () =>
      'Parece una credencial o clave privada. Por favor elimínela y revóquela si era real.',
    'electron-hardening': () =>
      'Desactiva una protección de Electron (sandbox, aislamiento de contexto, seguridad web o integración con Node). El renderer debe seguir aislado.',
    'dynamic-code': () => 'Evalúa código dinámicamente (`eval` o `new Function`).',
    'process-spawn': () => 'Lanza procesos desde código nuevo.',
    'pipe-to-shell': () => 'Envía una descarga directamente a una shell.',
    obfuscation: () =>
      'Contiene un bloque largo codificado o escapado. Por favor explique qué es o reemplácelo por código legible.',
    impersonation: p =>
      `El commit ${code(p.sha)} lleva la identidad de un mantenedor sin firma verificada; un mantenedor debe confirmar que lo escribió.`,
    'dep-license': (p, ctx) =>
      `La dependencia ${code(p.name)} tiene licencia ${code(p.license)}, que no es compatible con ${ctx.license ? `este proyecto ${code(ctx.license)}` : 'las licencias que acepta este proyecto'}.`,
    'dep-age': p =>
      `La dependencia ${code(`${p.name}@${p.version}`)} se publicó hace ${p.ageDays} días; el proyecto espera al menos ${p.minAgeDays} días antes de adoptar una versión.`,
    dependency: p =>
      `Dependencia nueva o modificada ${code(`${p.name}@${p.version}`)}${p.license ? ` (${code(p.license)})` : ''}.`,
    'security-report': (p, ctx) =>
      `Si esto describe una vulnerabilidad de seguridad, por favor repórtela de forma privada como se explica en la [política de seguridad](${ctx.security('es')}) y retire los detalles de este issue.`,
    'issue-empty': () =>
      'Por favor describa el problema o la idea en unas frases para poder entenderlo.',
    'issue-incomplete': (p, ctx) =>
      `Para reproducirlo, por favor agregue: ${p.missing.map(m => field('es', m, ctx)).join(', ')}.`,
    'issue-media': () => 'Una captura o una grabación corta nos ayudaría mucho.',
  },
};

const TEXT = {
  en: {
    thanksPr: author =>
      `Thanks for your contribution, @${author}! I ran the automated checks on this pull request.`,
    thanksIssue: author => `Thanks for opening this issue, @${author}!`,
    blocking: 'To move forward',
    maintainer: 'Needs a maintainer review',
    suggestion: 'Suggestions',
    clean: 'Everything looks good to the automated checks. A maintainer will review it soon.',
    cleanIssue: 'It has everything we need. A maintainer will look at it soon.',
    approved: 'A maintainer approved the open items.',
    rules: 'rules',
    footer: pr =>
      `${pr ? 'Pushing a new commit or editing the description runs the checks again.' : 'Editing the issue runs the checks again.'} If something here looks wrong, reply below and a maintainer will take a look.`,
  },
  es: {
    thanksPr: author =>
      `¡Gracias por su contribución, @${author}! Ejecuté los chequeos automáticos sobre esta pull request.`,
    thanksIssue: author => `¡Gracias por abrir este issue, @${author}!`,
    blocking: 'Para avanzar',
    maintainer: 'Requiere revisión de un mantenedor',
    suggestion: 'Sugerencias',
    clean: 'Todo está en orden según los chequeos automáticos. Un mantenedor la revisará pronto.',
    cleanIssue: 'Tiene todo lo necesario. Un mantenedor lo revisará pronto.',
    approved: 'Un mantenedor aprobó los puntos pendientes.',
    rules: 'reglas',
    footer: pr =>
      `${pr ? 'Al subir un commit nuevo o editar la descripción, los chequeos se ejecutan de nuevo.' : 'Al editar el issue, los chequeos se ejecutan de nuevo.'} Si algo aquí parece incorrecto, responda abajo y un mantenedor lo revisará.`,
  },
};

/** Group repeated location-only findings so one rule never floods the comment. */
function lines(items, language, ctx) {
  const seen = new Map();
  for (const item of items) {
    const text = MESSAGES[language][item.id](item.params, ctx);
    const group = seen.get(text) ?? { item, locations: [] };
    if (item.file) group.locations.push(item.line ? `${item.file}:${item.line}` : item.file);
    seen.set(text, group);
  }
  return [...seen.entries()].map(([text, { locations }]) => {
    if (!locations.length) return `- ${text}`;
    const shown = locations.slice(0, 5).map(code).join(', ');
    const more = locations.length > 5 ? ` (+${locations.length - 5})` : '';
    return `- ${shown}${more}: ${text}`;
  });
}

const HOME = 'https://github.com/johnny4young/centinela';

export function renderComment({
  kind,
  repo,
  config,
  author,
  findings,
  language,
  key,
  rulesVersion,
  approved,
  approvedSha,
}) {
  const text = TEXT[language];
  const repoUrl = `https://github.com/${repo}`;
  const url = file => `${repoUrl}/blob/HEAD/${file.split('/').map(encodeURIComponent).join('/')}`;
  const ctx = {
    product: config.issues.productName,
    license: config.license,
    security: lang => {
      const file = linkFor(config.links.security, lang);
      return file ? url(file) : `${repoUrl}/security/policy`;
    },
  };
  const pr = kind === 'pr';
  const out = [
    markerFor(key, approvedSha),
    pr ? text.thanksPr(author) : text.thanksIssue(author),
    '',
  ];
  if (!findings.length) out.push(pr ? text.clean : text.cleanIssue, '');
  if (approved) out.push(`> ${text.approved}`, '');
  for (const severity of ['blocking', 'maintainer', 'suggestion']) {
    const items = findings.filter(f => f.severity === severity);
    if (!items.length) continue;
    out.push(`**${text[severity]}**`, '', ...lines(items, language, ctx), '');
  }
  const rulesFile = linkFor(config.links.rules, language);
  const rules = rulesFile
    ? `[${text.rules} ${rulesVersion.slice(0, 8)}](${url(rulesFile)})`
    : `${text.rules} ${rulesVersion.slice(0, 8)}`;
  out.push(`<sub>[Centinela](${HOME}) · ${rules} · ${text.footer(pr)}</sub>`);
  return out.join('\n');
}
