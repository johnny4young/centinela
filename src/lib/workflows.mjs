import { addedLines, matcher } from './core.mjs';

export const isWorkflow = matcher(['.github/workflows/*.yml', '.github/workflows/*.yaml']);

// Untrusted text an author controls; numbers and repository fields are safe.
const UNTRUSTED =
  /\$\{\{[^}]*\b(github\.head_ref|github\.event\.(?!repository\b)[\w.]*\b(title|body|message|ref|label|name|email|default_branch|page_name))\b[^}]*\}\}/;
const PR_HEAD_REF =
  /\b(ref|repository)\s*:\s*\$\{\{[^}]*(pull_request\.head\.(sha|ref|repo)|github\.head_ref|merge_commit_sha)|refs\/pull\//;
const USES = /\buses:\s*['"]?([\w.-]+)\/[\w./-]+@([\w.-]+)/;
const indent = line => line.match(/^\s*/)[0].length;

/** Line numbers (1-based) inside `run:` scripts, where `${{ }}` lands in a shell. */
export function runLines(content) {
  const lines = content.split('\n');
  const inside = new Set();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)(-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    const column = match[1].length + (match[2]?.length ?? 0);
    if (!/^[|>][+-]?\s*$/.test(match[3])) {
      inside.add(i + 1);
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && indent(lines[j]) <= column) break;
      inside.add(j + 1);
    }
  }
  return inside;
}

/** Jobs as `{ name, line, runsOn, timeout }`, read by indentation under `jobs:`. */
export function jobs(content) {
  const lines = content.split('\n');
  const start = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (start < 0) return [];
  const result = [];
  let current = null;
  let jobIndent = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (indent(line) === 0) break;
    jobIndent ??= indent(line);
    if (indent(line) === jobIndent) {
      current = {
        name: line.trim().replace(/:.*$/, ''),
        line: i + 1,
        runsOn: null,
        timeout: false,
      };
      current.child = null;
      result.push(current);
    } else if (current) {
      // Only the job's own keys count; a step-level timeout does not bound the job.
      current.child ??= indent(line);
      if (indent(line) !== current.child) continue;
      if (/^\s*runs-on:/.test(line)) current.runsOn = i + 1;
      if (/^\s*timeout-minutes:/.test(line)) current.timeout = true;
    }
  }
  return result;
}

function finding(id, severity, file, line, params = {}) {
  return { id, severity, params, file, line };
}

/** Risky workflow changes; `workflows` holds each changed workflow's content at the head. */
export function checkWorkflows({ files, workflows = [], owner }) {
  const results = [];
  for (const { file, content } of workflows) {
    const changed = files.find(f => f.filename === file);
    if (!changed || !content) continue;
    const added = addedLines(changed.patch);
    const addedSet = new Set(added.map(l => l.line));
    const scripts = runLines(content);
    const privileged = /^\s*pull_request_target\b|\bpull_request_target\s*:/m.test(content);
    for (const { line, text } of added) {
      if (scripts.has(line) && UNTRUSTED.test(text)) {
        results.push(finding('workflow-injection', 'blocking', file, line));
      }
      if (privileged && PR_HEAD_REF.test(text)) {
        results.push(finding('workflow-pr-target-checkout', 'blocking', file, line));
      }
      if (/\bpermissions:\s*write-all\b/.test(text)) {
        results.push(finding('workflow-write-all', 'maintainer', file, line));
      }
      const uses = text.match(USES);
      if (
        uses &&
        !['actions', 'github', owner].includes(uses[1]) &&
        !/^[0-9a-f]{40}$/.test(uses[2])
      ) {
        results.push(finding('workflow-unpinned-action', 'suggestion', file, line));
      }
    }
    for (const job of jobs(content)) {
      const isNew = changed.status === 'added' || (job.runsOn && addedSet.has(job.runsOn));
      if (job.runsOn && !job.timeout && isNew) {
        results.push(finding('workflow-timeout', 'suggestion', file, job.line, { job: job.name }));
      }
    }
  }
  return results;
}
