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

## How it stays safe

- It runs on `pull_request_target` and `issues` and never checks out or executes contributed code. It reads the pull request only through the GitHub API.
- It reads its config from the base branch, so a pull request cannot change its own rules.
- When the API returns a truncated diff it fails closed and asks for a maintainer.
- It reviews an item again only when something it reads changes: a new commit, the title, the description, the opt-in or approval labels, or its rules.

## Setup

1. Copy [examples/centinela.yml](./examples/centinela.yml) to `.github/workflows/centinela.yml`.
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

| Key                                                      | Purpose                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `maintainers`                                            | Logins whose identity is protected and whose pull requests are skipped                     |
| `license`                                                | Your license, named when a dependency license is rejected                                  |
| `pullRequest.conventionalTitle`                          | Require a Conventional Commit title                                                        |
| `pullRequest.sections`                                   | `"template"` reads them from your pull request template; or a list with names per language |
| `paths.ui`, `source`, `tests`                            | Globs that decide when screenshots and tests are needed                                    |
| `paths.sensitive`                                        | Extra paths that always need a maintainer                                                  |
| `size`                                                   | Files left out of the size, and the bucket from which a split is suggested                 |
| `language.typos`, `typosExclude`                         | Typo check on added lines                                                                  |
| `language.spanishRegister`                               | `{ "register": "usted" or "tu", "paths": [...] }` flags voseo, and tú in usted copy        |
| `language.localeParity`                                  | `{ "dir": "src/locales", "languages": ["en", "es"] }` flags keys missing in a language     |
| `stack`                                                  | `"auto"` detects the stack packs below from the base branch; a list forces them            |
| `rules.workflows`                                        | Check changed workflows for injection, privileged checkouts, pins and timeouts             |
| `rules.custom`                                           | Your own rules; see [Project rules](#project-rules)                                        |
| `deps`                                                   | Minimum release age in days and blocked license prefixes                                   |
| `issues.productName`, `bugLabel`                         | Names used in bug report checks                                                            |
| `links.security`, `rules`, `contributing`                | Repository paths, one string or one per language, linked from the comment                  |
| `labels`, `optInLabel`, `overrideLabel`, `statusContext` | Names and colors Centinela uses                                                            |

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

`npm test` runs the suite. Centinela uses Node.js built-ins only.

## Versions

Pin `johnny4young/centinela@v1` for the latest compatible release, or a full commit SHA to review every update yourself.
A new rule or message changes the rules version, so each open contribution is reviewed once more after you update.

## License

[MIT](./LICENSE)
