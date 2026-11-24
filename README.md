<p align="center"><img src="./assets/logo.png" alt="Centinela owl" width="128" height="128"></p>

# Centinela

**Language:** English · [Español](./README.es.md)

Centinela gives every pull request and issue from an outside contributor a polite first review, so it reaches the maintainer ready to review.
It posts one comment in the author's language (English or Spanish), keeps it updated, labels the item and sets a commit status that can block the merge.
A maintainer still reviews every contribution.

## What it checks

| Area         | Pull request                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Description  | Conventional Commit title and the sections of your pull request template                          |
| Evidence     | Screenshots for UI changes, reproduction steps for fixes, tests for new source code               |
| Size         | Lines changed without lockfiles or generated files; large pull requests are asked to split        |
| Language     | Typos in added lines; optionally the Spanish register and locale key parity                       |
| Safety       | Workflows, lockfiles, licenses, install scripts, binaries, hidden Unicode, secrets, encoded blobs |
| Identity     | Commits that carry a maintainer identity without a verified signature                             |
| Dependencies | New npm dependencies, their license and how long ago the version was published                    |

Bug reports need steps to reproduce, expected and actual behavior, the version and the operating system.
Reports that look like a vulnerability are pointed to your security policy.

Findings fall into three groups: **to move forward** (the author fixes it), **needs a maintainer review**, and **suggestions** that never block.
The status fails while either of the first two has items. The `triage: approved` label accepts them for the current content: it follows a new commit with an identical tree (a squash or a reworded message) as long as the review finds nothing new, and any other push needs a new approval.

On a later review, items it did not report before are marked **new**, and the comment says how many from the last review are resolved.
A first-time contributor gets a welcome that links your contributing guide: `CONTRIBUTING.md`, `.github/CONTRIBUTING.md` or `docs/CONTRIBUTING.md`, or the path in `links.contributing`.

## Commands and follow-up

The author or a maintainer can comment on a pull request or issue:

- `/centinela recheck` runs the checks again, for example after a dependency is old enough or the template changed.
- `/centinela review` asks Claude for a deep agentic review (maintainers only).
- `/centinela triage` runs AI issue triage: duplicates, already-fixed checks and contribution direction (maintainers only).
- `/centinela learn` harvests recent maintainer reviews and opens/updates a learnings PR (maintainers only).
- `/centinela help` lists the commands.

Replying to a Centinela review thread or mentioning `@centinela` answers questions grounded in your rules and records dismissals for self-learning. Centinela reacts with 👀 when it starts and 👍 when it finishes.

## AI review, Smart Issue Triage and Self-Learning

- **Cost-tiered agentic AI review (`ai.autoReview: "tiered"`):** runs a fast review automatically on ready external pull requests, and upgrades to deep Opus agentic review (with read-only GitHub API exploration tools `search_code`, `read_file`, `list_dir`, `list_open_prs` + a critic verifier pass) on large PRs, critical paths, or on demand via `centinela: ai-review` / `/centinela review`. Prompt caching cuts repeat token costs.
- **PR hygiene:** detects merge conflicts, stale branches, sequential SQL migration collisions (e.g. `0102` vs `main` at `0108`), overlapping commits across open PRs, and failing CI checks, flipping between `status: waiting-on-author` and `status: ready-for-maintainer`.
- **Smart Issue Manager (`issues.aiTriage: true`):** recognizes engineering code-level bug reports without blocking them on end-user forms, auto-labels issues, flags duplicates and bugs already fixed by a recent merged PR, and writes a contribution brief when someone offers a PR.
- **3-tier multi-project self-learning (`learnings`):** merges shared global rules (`<shared>/learnings/global.json`), active stack rules (`<shared>/learnings/stacks/<stack>.json`), and local repo rules (`.github/centinela/learnings.json`). Harvests maintainer review comments and reactions, routes candidates by scope (`global` / `stack` / `repo`) with strict privacy isolation (`shareScope: "public-only"`), retires noisy rules, and promotes repeated patterns to deterministic rules. See [examples/centinela-memory/learnings/global.json](./examples/centinela-memory/learnings/global.json).
- **Fleet onboarding & Tier 2 execution:** use the reusable workflow ([reusable-centinela.yml](./.github/workflows/reusable-centinela.yml)), config `"extends"`, `npm run init -- --maintainer <login> --shared <owner>/centinela-memory@main --write`, and the isolated opt-in Tier 2 template ([examples/centinela-execute.yml](./examples/centinela-execute.yml)). Run `npm run eval` to verify precision and recall against historical fixtures.

A maintainer applies the `centinela: ai-review` label to a pull request, or comments `/centinela review`, to have Claude do a deep review: freezes, memory leaks and performance first, then bugs and edge cases, security, workarounds that hide a problem, departures from your written rules, missing or hollow tests, and duplication. It reads the diff, the full new version of the changed files, the unchanged files they import (relative and `@/` imports) and your project rules. Findings that sit on a changed line are posted as review comments on that line, in a review that only comments and never requests changes, with a one-click suggestion when the fix is a small edit of those lines; the rest, with a summary, go in a separate comment in the author's language. Centinela removes the label when it finishes, so applying it again after a new commit asks for another review; with the comment, `--again` reviews the same commit once more.

- Only maintainers can ask for it, and it runs once per commit, so its cost stays in your hands.
- The diff and description are passed as untrusted data, the model has no tools, and its findings never change the Centinela status.
- It reads the files in `ai.rules` (`AGENTS.md` and `CLAUDE.md` by default) from the base branch as project rules.
- Full files are added up to `ai.maxFileTokens` (60,000 by default); a diff above `ai.maxInputTokens` (150,000) is not sent. A review of a mid-sized pull request costs a few tens of cents.
- A later review never repeats an inline comment it already posted.

It authenticates with [workload identity federation](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions), so no API key is stored. In the Claude Console, connect a GitHub Actions workload whose rule matches `ref` `refs/heads/main`, the `Centinela` workflow and the `pull_request_target` and `issue_comment` events, then set the four IDs as repository variables and add `id-token: write` to the job, as in [examples/centinela.yml](./examples/centinela.yml):

```bash
gh variable set ANTHROPIC_FEDERATION_RULE_ID --body fdrl_...
gh variable set ANTHROPIC_ORGANIZATION_ID --body <organization-id>
gh variable set ANTHROPIC_SERVICE_ACCOUNT_ID --body svac_...
gh variable set ANTHROPIC_WORKSPACE_ID --body wrkspc_...
```

A dedicated workspace with a monthly spend limit caps what reviews can cost.

Once a day it also gives a first review to open contributions it never saw, such as those opened before Centinela was installed, up to ten per run. It looks at items waiting on their author (`status: waiting-on-author` or `needs-info`). After `lifecycle.remindAfterDays` without activity from the author (14 by default) it posts one reminder in the author's language. Closing is off by default; set `lifecycle.closeAfterDays` to close the item that many days after the reminder, with a message that invites the author to come back. Approved items, items waiting on a maintainer, drafts and maintainer items are never touched.

## How it stays safe

- It runs on `pull_request_target`, `issues`, `issue_comment` and a daily `schedule`, and never checks out or executes contributed code. It reads the pull request only through the GitHub API.
- It reads its config from the base branch, so a pull request cannot change its own rules.
- When the API returns a truncated diff it fails closed and asks for a maintainer.
- It reviews an item again only when something it reads changes: a new commit, the title, the description, the opt-in or approval labels, or its rules.

## Setup

To onboard another repository in one step from a Centinela checkout:

```bash
npm run init -- --dir ../<repo> --extends <owner>/centinela-memory/base.json@main --write
```

Or set it up manually:

1. Copy [examples/centinela.yml](./examples/centinela.yml) to `.github/workflows/centinela.yml` (or call [reusable-centinela.yml](./.github/workflows/reusable-centinela.yml)).
2. Add `.github/centinela.json` with what is specific to your project. Every key is optional; see [Configuration](#configuration).
3. Optional, to post with the Centinela name and avatar: install the Centinela GitHub App on the repository and set its credentials.

   ```bash
   gh variable set CENTINELA_APP_CLIENT_ID --body <client-id>
   gh secret set CENTINELA_APP_PRIVATE_KEY < centinela.private-key.pem
   ```

   Without them it posts as `github-actions`.

4. After the first run, make the `centinela` status a required check in the branch rules.

Maintainer contributions are skipped unless they carry the `triage` label. Drafts and bots are skipped.

## Configuration

`.github/centinela.json` is merged over [src/defaults.json](./src/defaults.json): objects merge key by key, and lists replace the default list.
The exception is `paths.sensitive`, which always keeps the built-in floor (workflows, lockfiles, `CODEOWNERS`, licenses, security policy, `.npmrc`).

| Key                                                      | Purpose                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `maintainers`                                            | Logins whose identity is protected and whose pull requests are skipped                      |
| `license`                                                | Your license, named when a dependency license is rejected                                   |
| `pullRequest.conventionalTitle`                          | Require a Conventional Commit title                                                         |
| `pullRequest.sections`                                   | `"template"` reads them from your pull request template; or a list with names per language  |
| `paths.ui`, `source`, `tests`                            | Globs that decide when screenshots and tests are needed                                     |
| `paths.sensitive`                                        | Extra paths that always need a maintainer                                                   |
| `size`                                                   | Files left out of the size, and the bucket from which a split is suggested                  |
| `language.typos`, `typosExclude`                         | Typo check on added lines                                                                   |
| `language.spanishRegister`                               | `{ "register": "usted" or "tu", "paths": [...] }` flags voseo, and tú in usted copy         |
| `language.localeParity`                                  | `{ "dir": "src/locales", "languages": ["en", "es"] }` flags keys missing in a language      |
| `stack`                                                  | `"auto"` detects the stack packs below from the base branch; a list forces them             |
| `rules.workflows`                                        | Check changed workflows for injection, privileged checkouts, pins and timeouts              |
| `rules.custom`                                           | Your own rules; see [Project rules](#project-rules)                                         |
| `deps`                                                   | Minimum release age in days and blocked license prefixes                                    |
| `issues.productName`, `bugLabel`                         | Names used in bug report checks                                                             |
| `ai.model`, `effort`, `rules`, `inline`                  | Model, effort (`xhigh`), rule files and inline comments for the AI review                   |
| `ai.maxInputTokens`, `maxFileTokens`, `maxRelatedTokens` | Input limit, and how much of it changed and imported files may use                          |
| `lifecycle.remindAfterDays`, `closeAfterDays`            | Days before the reminder (`null` turns it off) and before closing after it (off by default) |
| `links.security`, `rules`, `contributing`                | Repository paths, one string or one per language, linked from the comment                   |
| `labels`, `optInLabel`, `overrideLabel`, `statusContext` | Names and colors Centinela uses                                                             |

## Required sections

By default Centinela reads `.github/pull_request_template.md` from the base branch. A heading whose body prompts the author with an HTML comment is required; checklists and headings such as Screenshots, Notes or Linked issues are optional.
Common synonyms count: a body with **Verification**, **Checks** or **Evidence** fills a **Testing** section, **Summary** or **Description** fills **What**, and Spanish headings such as **Qué** or **Cómo probar** work too.
A repository without a template only gets the title check.

## Stack packs

Centinela reads the base branch tree and its package manifests, turns on the packs that match, and names them in the comment footer.
Each pack adds rules for added lines and paths that need screenshots, tests or a maintainer.

| Pack        | Detected by                                         | Looks for                                                                                                                             |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Electron    | an `electron` dependency                            | Disabled sandbox or isolation, Node modules in preload, remote module, `sendSync`, `openExternal`, sync I/O in main                   |
| React       | a `react` dependency                                | `dangerouslySetInnerHTML`, async functions passed to `useEffect`                                                                      |
| Node server | `fastify`, `express`, `@trpc/server`, `koa`, `hono` | Sync I/O in server code, SQL built with template interpolation                                                                        |
| Swift       | `Package.swift`, an Xcode project or `project.yml`  | Uncommented `@unchecked Sendable`, `nonisolated(unsafe)`, `DispatchQueue.main.sync`, thread sleeps, hand edits to an XcodeGen project |
| Rust        | `Cargo.toml`                                        | `unsafe` code, changes to `build.rs`                                                                                                  |

Changed workflows are always checked: untrusted text in `run:` scripts, `pull_request_target` jobs that reference the PR head, `permissions: write-all`, third-party actions without a SHA pin, and jobs without `timeout-minutes`.

## Project rules

`rules.custom` turns the invariants in your `AGENTS.md` into checks. A rule with a `pattern` fires on each added line that matches; a rule with only `paths` fires once for each changed file.

```json
{
  "rules": {
    "custom": [
      {
        "id": "tenant-scope",
        "severity": "maintainer",
        "paths": ["packages/server/src/trpc/routers/**"],
        "pattern": "\\.from\\(",
        "unless": "tenantId",
        "message": {
          "en": "Every query must scope by ctx.tenantId.",
          "es": "Toda consulta debe filtrar por ctx.tenantId."
        }
      }
    ]
  }
}
```

Keys: `id`, `severity` (`blocking`, `maintainer` or `suggestion`), `message` (a string or one per language), `pattern` and `flags`, `unless` (skip lines that also match it), `paths`, `exclude`, and `tests: true` to include test files.

## Trying a change

Run it against a real pull request without posting anything:

```bash
GITHUB_REPOSITORY=owner/repo GH_TOKEN=$(gh auth token) \
  node src/centinela.mjs --dry-run --force --pr 123 --config path/to/centinela.json
```

`npm test` runs the suite. Add `--review` to see the size of the AI review prompt; with `--dry-run` it calls nothing.
Centinela uses Node.js built-ins plus the official Claude SDK, which is installed only when the AI review is configured.

## Versions

Pin `johnny4young/centinela@v1` for the latest compatible release, or a full commit SHA to review every update yourself.
A new rule or message changes the rules version, so each open contribution is reviewed once more after you update.

## License

[MIT](./LICENSE)
