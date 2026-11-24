import { linkFor } from './config.mjs';
import { markerFor } from './core.mjs';
import { packName } from './packs.mjs';

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
    'title-lines': p => `Please put the title on one line: ${code(p.title)}.`,
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
    'electron-preload-node': () =>
      'The preload script imports a Node.js module. The renderer is sandboxed, so the preload can only use `contextBridge` and `ipcRenderer.invoke`; move the work to the main process behind an IPC handler.',
    'electron-remote': () =>
      'It uses the remote module, which gives the renderer direct access to the main process. Please use an IPC handler instead.',
    'electron-sync-ipc': () =>
      'It uses synchronous IPC (`sendSync`), which freezes the window until the main process answers. Please use `ipcRenderer.invoke` instead.',
    'electron-open-external': () =>
      'It opens an external URL. A maintainer needs to confirm the URL is validated, since `openExternal` can launch any protocol handler.',
    'electron-main-sync-io': () =>
      'It adds synchronous file or process work to the main process, which freezes every window while it runs. Please use the async version.',
    'react-dangerous-html': () =>
      'It renders raw HTML with `dangerouslySetInnerHTML`. A maintainer needs to confirm the content is sanitized.',
    'react-async-effect': () =>
      'An `async` function passed straight to `useEffect` cannot return a cleanup, so late results can update an unmounted component. Please call an async function inside the effect and ignore stale results.',
    'server-sync-io': () =>
      'It adds synchronous file or process work to server code, which blocks every request until it finishes. Please use the async version.',
    'sql-interpolation': () =>
      'It builds raw SQL with template interpolation, which can allow SQL injection. Please use bound parameters.',
    'swift-unchecked-sendable': () =>
      'It adds `@unchecked Sendable` without a comment. Please explain on the same line why the type is safe to share across threads.',
    'swift-nonisolated-unsafe': () =>
      'It adds `nonisolated(unsafe)`, which turns off data-race checking for that declaration. A maintainer needs to confirm it is safe.',
    'swift-main-sync': () =>
      'It calls `DispatchQueue.main.sync`, which deadlocks when it runs on the main thread and blocks the caller otherwise. Please use `await MainActor.run` or an async hop.',
    'swift-sleep': () =>
      'It sleeps the thread. On the main actor this freezes the UI; please use `try await Task.sleep` instead.',
    'swift-xcodeproj-edit': () =>
      'It edits the Xcode project, which is generated from `project.yml` by XcodeGen. Please make the change in `project.yml` and regenerate.',
    'rust-unsafe': () =>
      'It adds `unsafe` code. A maintainer needs to review it; please document the invariants that make it sound.',
    'workflow-injection': () =>
      'It expands text a contributor controls (a title, body, branch name or message) inside a `run:` script, which allows command injection. Please pass it through `env:` and quote the variable.',
    'workflow-pr-target-checkout': () =>
      'A privileged workflow (`pull_request_target` or `workflow_run`) checks out or references the pull request head. That job holds a write token, so contributed code must never run in it.',
    'workflow-unread': () =>
      'The workflow could not be read, so it was not checked. A maintainer needs to review it by hand.',
    'workflow-write-all': () =>
      'It grants `permissions: write-all`. Please grant only the permissions the job needs.',
    'workflow-unpinned-action': () =>
      'It uses a third-party action by tag or branch. Please pin it to a full commit SHA so a moved tag cannot change what runs.',
    'workflow-timeout': p =>
      `The job ${code(p.job)} has no \`timeout-minutes\`, so a hung run can hold a runner for hours. Please set one.`,
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
    'title-lines': p => `Por favor escriba el título en una sola línea: ${code(p.title)}.`,
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
    'electron-preload-node': () =>
      'El script de preload importa un módulo de Node.js. El renderer está aislado, así que el preload solo puede usar `contextBridge` e `ipcRenderer.invoke`; mueva el trabajo al proceso principal detrás de un handler de IPC.',
    'electron-remote': () =>
      'Usa el módulo remote, que da al renderer acceso directo al proceso principal. Por favor use un handler de IPC.',
    'electron-sync-ipc': () =>
      'Usa IPC síncrono (`sendSync`), que congela la ventana hasta que responde el proceso principal. Por favor use `ipcRenderer.invoke`.',
    'electron-open-external': () =>
      'Abre una URL externa. Un mantenedor debe confirmar que la URL se valida, porque `openExternal` puede abrir cualquier protocolo.',
    'electron-main-sync-io': () =>
      'Agrega trabajo síncrono de archivos o procesos en el proceso principal, que congela todas las ventanas mientras corre. Por favor use la versión asíncrona.',
    'react-dangerous-html': () =>
      'Renderiza HTML sin procesar con `dangerouslySetInnerHTML`. Un mantenedor debe confirmar que el contenido está sanitizado.',
    'react-async-effect': () =>
      'Una función `async` pasada directamente a `useEffect` no puede devolver una limpieza, así que un resultado tardío puede actualizar un componente desmontado. Por favor llame una función asíncrona dentro del efecto e ignore los resultados viejos.',
    'server-sync-io': () =>
      'Agrega trabajo síncrono de archivos o procesos en el servidor, que bloquea todas las peticiones hasta que termina. Por favor use la versión asíncrona.',
    'sql-interpolation': () =>
      'Arma SQL con interpolación de texto, lo que puede permitir inyección SQL. Por favor use parámetros.',
    'swift-unchecked-sendable': () =>
      'Agrega `@unchecked Sendable` sin comentario. Por favor explique en la misma línea por qué el tipo es seguro entre hilos.',
    'swift-nonisolated-unsafe': () =>
      'Agrega `nonisolated(unsafe)`, que desactiva la verificación de carreras de datos en esa declaración. Un mantenedor debe confirmar que es seguro.',
    'swift-main-sync': () =>
      'Llama `DispatchQueue.main.sync`, que bloquea la app si corre en el hilo principal y detiene a quien lo llama en los demás casos. Por favor use `await MainActor.run`.',
    'swift-sleep': () =>
      'Duerme el hilo. En el main actor esto congela la interfaz; por favor use `try await Task.sleep`.',
    'swift-xcodeproj-edit': () =>
      'Modifica el proyecto de Xcode, que se genera desde `project.yml` con XcodeGen. Por favor haga el cambio en `project.yml` y regenere el proyecto.',
    'rust-unsafe': () =>
      'Agrega código `unsafe`. Un mantenedor debe revisarlo; por favor documente las invariantes que lo hacen correcto.',
    'workflow-injection': () =>
      'Expande texto que controla un colaborador (un título, cuerpo, nombre de rama o mensaje) dentro de un script `run:`, lo que permite inyectar comandos. Por favor páselo por `env:` y use la variable entre comillas.',
    'workflow-pr-target-checkout': () =>
      'Un workflow privilegiado (`pull_request_target` o `workflow_run`) descarga o referencia el head de la pull request. Ese job tiene un token con permisos de escritura, así que nunca debe ejecutar código contribuido.',
    'workflow-unread': () =>
      'No se pudo leer el workflow, así que no se revisó. Un mantenedor debe revisarlo a mano.',
    'workflow-write-all': () =>
      'Otorga `permissions: write-all`. Por favor otorgue solo los permisos que el job necesita.',
    'workflow-unpinned-action': () =>
      'Usa una action de terceros por tag o rama. Por favor fíjela a un SHA completo para que un tag movido no cambie lo que se ejecuta.',
    'workflow-timeout': p =>
      `El job ${code(p.job)} no tiene \`timeout-minutes\`, así que una ejecución colgada puede ocupar un runner por horas. Por favor defina uno.`,
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
    welcome: link =>
      `Welcome, and thanks for your first contribution here!${link ? ` The [contributing guide](${link}) explains how we work.` : ''}`,
    resolved: count =>
      `${count === 1 ? 'One item' : `${count} items`} from the last review ${count === 1 ? 'is' : 'are'} resolved.`,
    isNew: 'new',
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
    welcome: link =>
      `¡Le damos la bienvenida y gracias por su primera contribución aquí!${link ? ` La [guía de contribución](${link}) explica cómo trabajamos.` : ''}`,
    resolved: count =>
      `${count === 1 ? 'Un punto' : `${count} puntos`} de la revisión anterior ${count === 1 ? 'quedó resuelto' : 'quedaron resueltos'}.`,
    isNew: 'nuevo',
    rules: 'reglas',
    footer: pr =>
      `${pr ? 'Al subir un commit nuevo o editar la descripción, los chequeos se ejecutan de nuevo.' : 'Al editar el issue, los chequeos se ejecutan de nuevo.'} Si algo aquí parece incorrecto, responda abajo y un mantenedor lo revisará.`,
  },
};

/** Group repeated location-only findings so one rule never floods the comment. */
function lines(items, language, ctx) {
  const seen = new Map();
  for (const item of items) {
    const custom = item.params?.message;
    const text = custom
      ? typeof custom === 'string'
        ? custom
        : (custom[language] ?? custom.en)
      : MESSAGES[language][item.id](item.params, ctx);
    const group = seen.get(text) ?? { item, locations: [], isNew: false };
    group.isNew ||= item.isNew === true;
    if (item.file) group.locations.push(item.line ? `${item.file}:${item.line}` : item.file);
    seen.set(text, group);
  }
  const tag = TEXT[language].isNew;
  return [...seen.entries()].map(([text, { locations, isNew }]) => {
    const flag = isNew ? `**${tag}** · ` : '';
    if (!locations.length) return `- ${flag}${text}`;
    const shown = locations.slice(0, 5).map(code).join(', ');
    const more = locations.length > 5 ? ` (+${locations.length - 5})` : '';
    return `- ${flag}${shown}${more}: ${text}`;
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
  tree = null,
  seen = [],
  resolved = 0,
  welcome = null,
  stack = [],
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
    markerFor(key, { approved: approvedSha, tree, seen }),
    pr ? text.thanksPr(author) : text.thanksIssue(author),
    '',
  ];
  if (welcome) {
    const link = linkFor(welcome.link, language);
    out.push(text.welcome(link && (/^https?:\/\//.test(link) ? link : url(link))), '');
  }
  if (resolved) out.push(text.resolved(resolved), '');
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
  const detected = stack.length ? ` · stack: ${stack.map(packName).join(', ')}` : '';
  out.push(`<sub>[Centinela](${HOME}) · ${rules}${detected} · ${text.footer(pr)}</sub>`);
  return out.join('\n');
}
