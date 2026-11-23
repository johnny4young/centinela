export const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const COMMANDS = ['recheck', 'help'];

/** The command on the first line of a comment, `/centinela <name>`, or null. */
export function parseCommand(body = '') {
  const match = body
    .slice(0, 200)
    .trimStart()
    .match(/^\/centinela(?:[ \t]+([a-z-]+))?[ \t]*(?:\r?\n|$)/i);
  if (!match) return null;
  return (match[1] ?? 'help').toLowerCase();
}

export const knownCommand = name => COMMANDS.includes(name);

/** Only the author of the item and maintainers may run commands. */
export function canRun({ login, association, itemAuthor, config }) {
  return (
    login === itemAuthor ||
    MAINTAINER_ASSOCIATIONS.has(association) ||
    config.maintainers.includes(login)
  );
}

const HELP = {
  en: [
    'Commands Centinela understands, from the author or a maintainer:',
    '',
    '- `/centinela recheck` runs the checks again.',
    '- `/centinela help` shows this list.',
  ],
  es: [
    'Comandos que Centinela entiende, del autor o de un mantenedor:',
    '',
    '- `/centinela recheck` ejecuta los chequeos de nuevo.',
    '- `/centinela help` muestra esta lista.',
  ],
};

export const helpText = language => HELP[language].join('\n');
