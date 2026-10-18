# dsh-github-gate

<p>
  <a href="https://github.com/1273984347/dsh-github-gate/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/1273984347/dsh-github-gate/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/1273984347/dsh-github-gate/releases"><img alt="latest release" src="https://img.shields.io/github/v/release/1273984347/dsh-github-gate?color=6c5ce7"></a>
  <img alt="license" src="https://img.shields.io/github/license/1273984347/dsh-github-gate?color=4b6fff">
  <img alt="zero runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-eab308">
</p>

**GitHub tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) where a write cannot happen by accident.**

Nine typed `github_*` tools over the GitHub CLI. Every action that changes remote
state — 23 of them — needs `confirm: true` **and** passes a human approval seam.
The model's flag is intent; it is not consent.

```text
github_pr { action: "merge", number: 42, confirm: true }
  → an approval prompt naming the pull request; "no" stops it
  → after consent: gh pr merge 42 --repo owner/name
```

- **Argv arrays, never a shell.** `gh` is spawned with `shell: false`, so model text
  cannot become shell syntax — structurally, not by filtering.
- **One credential chain, resolved per call.** DSH credential store → `GH_TOKEN` /
  `GITHUB_TOKEN` → `gh auth login` → git credential helper. Rotating a token applies
  to the next call.
- **Configuration in the GUI.** Settings → Plugins → GitHub: paste a PAT, test it
  against the API, see which layer is live. The token is never displayed back.
- **A branch pill** in the session header: current branch, its pull request, and a
  switch menu that fails closed when the caller cannot be judged.
- **Digest-verified self-update.** `github_update` stages a release whose sha256 is
  checked against the digest GitHub publishes.

Host-side tools plus one small browser half. Zero runtime dependencies. No build step.

> **Requires** DeepSeek Harness `>=0.2.0-0 <0.3.0` and the
> [GitHub CLI](https://cli.github.com/) (`gh`) on `PATH`. Linux, macOS, and Windows.

**Topics:** `dsh-plugin` · `deepseek-harness` · `dsh` · `cordis-plugin` · `github` · `gh-cli`

## Why this over another GitHub plugin

Tool count is a bad proxy for usefulness — a broader surface with looser gates is
easier to write and harder to trust. The trade this project makes is explicit:

| | Other GitHub plugins for DSH | This one |
|---|---|---|
| Write safety | `confirm: true`, set by the model | `confirm: true` **+** an approval seam the model cannot set |
| Raw REST | unrestricted escape hatch | path must be relative, no `..`, write methods gated at run time |
| Correctness evidence | tests of its own API | 176 tests, 180 behaviour snapshots, and **84 argv shapes parsed by a real `gh`** |
| Failure messages | HTTP code passed through | 401 / 403 quota / 403 SSO / 404 / 422 each name the fix |
| Scope | as many tools as possible | 9 tools / 58 actions, one to a `gh` subcommand family |
| Self-update | — | staged with a verified sha256, install left to the platform |

If you want the largest possible tool surface with no gates, this is not the right
plugin. If you want the model to be able to *look* at GitHub freely but need a
person in the loop before it *changes* anything, it is.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Guidance](#guidance)
- [The branch pill](#the-branch-pill)
- [Settings page](#settings-page)
- [What it provides](#what-it-provides)
- [Updating this plugin](#updating-this-plugin)
- [Configuration](#configuration)
- [Credential chain](#credential-chain)
- [Device Flow needs your own OAuth App](#device-flow-needs-your-own-oauth-app)
- [Safety model](#safety-model)
- [Background jobs](#background-jobs)
- [Known limitations](#known-limitations)
- [Development](#development)

## Install

Two ways, both through the Harness plugin manager (`plugin_manager` action
`install_bundle`):

1. **From a GitHub release** — download `dsh-github-gate-<version>.tgz` from
   [Releases](../../releases) and point `install_bundle` at the unpacked package
   directory, or at a local path holding it.
2. **From a packed tarball of your own checkout**:

   ```bash
   npm pack --pack-destination ../packages     # pack OUTSIDE the source directory
   ```

   then install `../packages/dsh-github-gate-<version>.tgz`.

**Install from a packed tarball, not from the source directory.** This is not a
style preference. Installing a `link:` to a workspace directory produces a
junction, and the launcher's runtime resolution does not reach bare
`@deepseek-ai/*` packages through it — the plugin then fails with
`ERR_MODULE_NOT_FOUND` and refuses to activate entirely.

Pack the tarball **outside** the source tree: one run that packed into the source
directory itself left that directory emptied once the install completed (see
[docs/DESIGN.md](./docs/DESIGN.md) §5.8).

The tarball is a snapshot, so editing the source requires repacking and
reinstalling; a restart loads the new module generation.

### One-command download

The install scripts fetch the latest release, verify its sha256 against the digest
GitHub publishes, and print the install path. They deliberately do not install —
that step belongs to the plugin manager, which asks for approval:

```powershell
# Windows
irm https://raw.githubusercontent.com/1273984347/dsh-github-gate/main/install.ps1 | iex
```

```sh
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/1273984347/dsh-github-gate/main/install.sh | sh
```

Then install the printed path with `plugin_manager` action `install_bundle`.

## Quick start

```text
1. Is there a credential?
   github_auth { action: "status" }
     credential source: credentials-seam | environment | gh-cli | git-credential-helper | none

2. No credential? Establish one.
   github_auth { action: "login" }                  # Device Flow, needs your own OAuth App
   — or paste a PAT in Settings → Plugins → GitHub
   — or just run `gh auth login` in a terminal; the chain picks it up

3. Something is broken?
   github_auth { action: "probe" }                  # isolates each layer, names the failed one

4. Work on a pull request.
   github_pr { action: "status" }                   # CI for the branch you are on
   github_pr { action: "view", number: 42 }
   github_pr { action: "checks", number: 42 }
   github_pr { action: "merge", number: 42, confirm: true }   # asks a person
```

The repository is taken from the workspace's git remote when `repo` is omitted, so
the common case needs no argument.

## Guidance

Beyond the tools, this plugin contributes a **prompt section** and three **skills** that say what the
tool schemas cannot: when to use which capability, what evidence a conclusion needs, and when to stop.
The rules are deliberately few — a prompt section is paid for on every step — and each one names the
tool it applies to.

Three workflows load on demand: `github-pr-review`, `github-ci-triage`, `github-issue-to-pr`.

## The branch pill

`client.js` is the browser half: a branch pill in the session header slot
(`conversation.session.header.utilities`) showing the checked-out branch, the pull
request open on it, and a menu for switching branches. It is ~26 KB and it is the
only part of this bundle that renders in the browser. It reads through four
loopback HTTP routes this plugin registers on the `webServer` service:

| Route | Does | Without a `connection` service |
|---|---|---|
| `/branch`, `/branches`, `/diagnostics` | read the workspace and branch names | served, with one logged warning |
| `/switch` | runs `git switch` on the working tree | **refused with 403** |

A missing service is not consent: an apparatus that cannot judge a request must not
treat "cannot judge" as "judged safe". The read routes fail open because refusing
them would disable the pill outright in a composition that legitimately has no
Connection service; `/switch` fails closed because its consequence is a change to
the user's working tree. `client.js` requires no Harness Client package and uses
only `--dsw-alias-*` theme tokens, so a change in a client half this plugin does not
own cannot break it.

Neither half breaks a composition that lacks the `systemPrompt`, `skills` or
`webServer` service: the tools keep working and the guidance simply is not
registered. The diagnostics route reports which halves are live.

## Settings page

`Settings → Plugins → GitHub` (a tab inside the Plugins section — no nav entry of
its own, because the section owner renders each contribution as a tab).

| Shows | Does |
|---|---|
| whether a credential is configured, and which layer supplied it | — |
| the account, when the chain can identify it | — |
| the credential reference and the running plugin version | — |
| a password field | writes the token to the Harness credential store |
| **Test connection** | one real `gh api user` round trip through the same chain the tools use |

Two deliberate properties:

- **The page cannot read the token back.** The Host never returns it and the field
  is cleared on save. A settings page that can display a secret is a settings page
  that leaks it to every screenshot.
- **Every route fails closed.** These routes write a credential, so a composition
  whose `connection` service cannot judge the caller gets a `403` rather than a
  service — the same rule `/switch` follows.

Rotating a token needs no restart: the chain resolves per operation.

### Why `peerDependencies` are declared

The plugin imports `@deepseek-ai/schemastery` (its Config schema) and
`@deepseek-ai/dsh-tools` (`defineTool`). The runtime resolution decides what to
supply from the plugin's own manifest — `profileDependencyNames` reads
`dependencies` and `peerDependencies` — so a bare import that is **not**
declared cannot resolve, and the plugin dies at import. The declared ranges
admit the running dsh version, which is what keeps
`evaluatePluginCompatibility` from demanding a version exemption.

## What it provides

| Tool | Covers |
|---|---|
| `github_auth` | Credential chain status, **end-to-end connectivity probe**, Device Flow login, PAT login, logout |
| `github_repo` | View, list, branches, clone, create, edit, rename, archive, delete |
| `github_pr` | List, view, diff, checks, status, create, comment, review, ready, checkout, merge, close, reopen, edit |
| `github_issue` | List, view, create, comment, close, reopen, edit, develop |
| `github_release` | List, view, create, edit, upload, download, delete |
| `github_actions` | Run list/view/log/watch/rerun/cancel/delete, workflow list/view/dispatch |
| `github_search` | Repositories, issues, pull requests, code, commits |
| `github_api` | Guarded raw REST for everything else (registered when `allowRawApi: true`) |
| `github_update` | Check for a newer release of this plugin, and stage its verified tarball |

## Updating this plugin

`github_update` does the two things a plugin can do safely; the other two belong
outside it.

```
check   → is there a newer release?              read-only
stage   → download it and verify its digest      writes one file
install → plugin_manager install_bundle          platform, approval-gated
verify  → confirm the new generation is live     you
```

```text
github_update { "action": "check" }
  installed: 1.7.0   latest: 1.8.0   status: an upgrade is available

github_update { "action": "stage" }
  staged: <tmp>/dsh-github-gate-updates/dsh-github-gate-1.8.0.tgz
  digest: sha256 verified against the digest GitHub publishes
```

Then install the returned path with `plugin_manager` action `install_bundle` — it
needs approval, because that is the point at which downloaded code is allowed to
run. That is why `stage` reports `installed: false`: installing is not its job.

**Whether a restart is needed depends on the install, so verify instead of
assuming.** The plugin manager re-activates the entry, and a measured install
(1.7.0 over 1.6.1, 2026-10-19) served the new tool set and the new Config keys
immediately, with no process restart; an earlier install in the same environment
did not update the projected Config schema until a restart. The check that means
something is a tool or Config key that only exists in the new version — *not* the
installed `package.json`, because pnpm replaces it before the module is
necessarily reloaded. `stage` therefore reports `next.restartRequired: "unverified"`
rather than `true`.

Three details worth knowing:

- **Every network call goes through `gh`, not `fetch`.** On a machine whose TLS is
  intercepted by a proxy the OS trusts but Node's CA store does not, `fetch` to
  `api.github.com` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while `gh`
  succeeds. This is the same reason `github_api` routes through `gh api`.
- **The digest is checked, and "no digest" is not "verified".** GitHub publishes a
  `sha256:` digest per asset; the downloaded bytes are compared against it. A
  release that publishes no digest is reported as `unverified`, not as a pass.
- **`updateCheck: true` adds a startup notice.** Off by default: an activation-time
  network call is a surprise. When on, it runs at most once per 24 hours and logs a
  single line.

## Credential chain

Tried in order, cheapest and most explicit first, re-read on **every** call so a
credential stored mid-session takes effect with no restart:

1. the dsh credentials store (`credentialRef`, default `GITHUB_TOKEN`)
2. `GH_TOKEN` / `GITHUB_TOKEN` in the host environment
3. the GitHub CLI's own login (`gh auth token`)
4. git's credential helper (`git credential fill`, prompts disabled)

Machines that can already `git push` therefore work with no setup. To establish a
credential where none exists, use `github_auth` with action `login`.

## Device Flow needs your own OAuth App

`github_auth` action `login` authorizes through GitHub Device Flow, talking only
to `github.com` — no broker, no secret on the machine. It requires a client id,
which is **not** shipped pre-filled: a client id identifies the app registration
your authorization is granted to, so a built-in one would route your access
through someone else's application that you cannot audit or revoke.

Register an App with Device Flow enabled at
<https://github.com/settings/applications/new>, then set its client id:

```yaml
- id: github-gate
  name: dsh-github-gate
  config:
    deviceFlowClientId: "Ov23li..."
```

You do not need Device Flow at all if you already have `gh auth login` or a
`GH_TOKEN` — the chain above picks either up automatically.

## Configuration

```yaml
- id: github-gate
  name: dsh-github-gate
  config:
    defaultRepo: owner/name        # fallback when a call omits `repo`; empty detects it from the workspace remote
    timeoutMs: 60000               # general command timeout
    watchTimeoutMs: 300000         # watch/log actions, and any action admitted as a background job
    allowDestructive: true         # master switch for merge/delete/force-push
    approvalForDestructive: true   # ask the user before a destructive action runs
    allowRawApi: true              # register github_api
    blockShellGit: false           # deny shell-level git commit/push/merge through a tools guard
    credentialRef: GITHUB_TOKEN    # credentials-store reference
    deviceFlowClientId: ''         # your own OAuth App client id
```

Every field is validated at **plugin load time**, so a bad value fails loudly
there instead of degrading silently on first use. The full catalog:

| Key | Default | Meaning |
|---|---|---|
| `ghPath` | `""` | Explicit gh executable; empty probes `PATH` |
| `gitPath` | `""` | Explicit git executable; empty probes `PATH` |
| `defaultRepo` | `""` | Fallback `owner/name` (or empty) when a call omits `repo` |
| `verifyGhVersion` | `true` | Warn at activation when gh is older than `minGhVersion` |
| `minGhVersion` | `2.0.0` | The minimum gh version this plugin expects |
| `credentialRef` | `GITHUB_TOKEN` | Credentials-store reference; must be ENV-shaped |
| `timeoutMs` | `60000` | Default per-command timeout (1000–600000) |
| `watchTimeoutMs` | `300000` | Timeout for watch/log actions (1000–600000) |
| `maxOutputBytes` | `65536` | In-memory cap before output spills to a file |
| `killGraceMs` | `2000` | SIGTERM→SIGKILL escalation window (0–60000) |
| `apiBaseURL` | `https://api.github.com` | REST root (GHES: `https://ghe.example.com/api/v3`) |
| `authBaseURL` | `https://github.com` | OAuth host, not the API host |
| `deviceFlowClientId` | `""` | Your OAuth App client id |
| `deviceFlowScope` | `repo` | Scope requested by Device Flow |
| `allowDestructive` | `true` | Master switch for destructive actions |
| `approvalForDestructive` | `true` | Ask the user through the approval seam before a destructive action runs |
| `allowRawApi` | `true` | Register the `github_api` tool |
| `blockShellGit` | `false` | Deny shell-level git mutations through a guard |
| `updateCheck` | `false` | Log a one-line notice at startup when a newer release exists (cached 24h) |
| `updateRepo` | `""` | Repository releases are read from; empty means this project |
| `updateChannel` | `stable` | `stable` ignores prereleases; `latest` takes the newest, prerelease included |
| `updateCacheDir` | `""` | Where staged artifacts land; empty uses the system temp directory |
| `env` | `{}` | Extra environment for child processes |

## Safety model

- **No shell, ever.** Every command is an argv array spawned with `shell: false`,
  so model-supplied text cannot be re-interpreted as shell syntax.
- **Arguments are validated before execution.** Tools use the official `defineTool`
  DSL, so a wrong type, a missing required key, or an action outside the closed enum
  is rejected before any command is built — `labels: "bug"` cannot be spread into
  three separate arguments.
- **Secrets never enter argv.** PAT login pipes the token through stdin; the
  credential fallback keeps it in the child environment.
- **Prompts are hard-disabled** (`GH_PROMPT_DISABLED`, `GIT_TERMINAL_PROMPT=0`,
  `GCM_INTERACTIVE=never`), so nothing can hang the host process.
- **Every state-changing action is gated in three layers**, strongest first:
  1. `allowDestructive: false` — the hard stop, checked inside `execute`;
  2. **an approval ask** through the official `tools/pre-execute` seam, whose reason
     names the target so a person can judge it;
  3. `confirm: true` — the model's per-call intent.

  Layer 2 is what closes the real gap: layer 3 alone is a flag the model sets by
  itself, which is *intent, not consent*. A composition with no approval service
  rejects at layer 2, so the ask never becomes a silent allow.

  **Which actions count.** Every action that changes remote state is classified
  `destructive` — 23 of them across the eight tools, including `github_api` write
  methods, which are classified at run time by their `method` because one `request`
  action reads as GET and writes as POST. An offline test asserts that no action is
  left unclassified: a new action that is neither read-only, destructive, nor in the
  local-only list fails the build. Three actions write the local filesystem but no
  remote state (`repo clone`, `pr checkout`, `release download`) and are deliberately
  outside the gate.
- **Independent reads may run in parallel** (`isConcurrencySafe`); writes stay
  serialised. `github_api` is never classified safe, because whether it reads or
  writes depends on its `method` argument.
- **Bounded processes.** A wall-clock timeout and the caller's abort signal both
  terminate the child, escalating SIGTERM → SIGKILL after `killGraceMs`.
- **Bounded output.** `maxOutputBytes` is ONE budget across stdout and stderr
  combined — a run that fills both with 60 KB each spills at 64 KB, not at 128 KB.
  Everything past the cap goes to a spill file whose path is returned; the in-memory
  prefix plus the spill tail is complete output.
- **`github_api` cannot leave the endpoint it names.** The path must be relative
  (absolute URLs and `//host/...` are rejected) and must contain no `..`: `gh api`
  normalizes those away before sending, so `/repos/../../user` would reach `/user`
  with the caller's credential attached. Both halves are enforced.
- **REST goes through `gh api`, never a direct fetch.** A direct fetch would add a
  second, differently-configured network path (Node's CA store instead of the
  platform's) and fails on a machine with TLS interception the OS trusts.

## Background jobs

Long actions (`github_actions` `runLog`/`runWatch`, `github_release`
`upload`/`download`) accept `run_in_background: true`:

```
github_actions { action: "runWatch", repo: "a/b", runId: "123", run_in_background: true }
  -> data: { kind: "background", jobId: "github-1" }
```

This follows the shipped convention exactly: the flag returns the id at once, **no
background execution timeout applies**, and the job is collected with `job_output`
and stopped with `job_kill`. The handle is a programmatic field (`data.jobId`), so
PTC mode never has to parse the rendered text.

With no composed job registry the call reports `background jobs unavailable` and
names what to load — it does not silently fall back to running in the foreground.

The work starts inside the registry's `run()` callback, not before it: the registry
validates the owner and task controller first, and a rejected admission must leave
no execution resource. Spawning earlier would leak a live process into a job that
was never admitted — invisible to `job_list` and unreachable by `job_kill`.

## Known limitations

- **Device Flow has not completed a real authorization round trip.** The polling
  state machine is fully covered against an injected fetch; the real github.com
  exchange needs your own OAuth App and a browser.
- **No write action has been executed.** All verification is read-only; no real
  resource was created, merged, or deleted.
- **Only `github_auth` action `token` prints a token.** It exists to pipe a token
  into another tool, so its `stdout` is the secret; the plugin never puts one in
  argv, in a log line, or in a card. Treat that output as a secret. Everything else
  reports *which layer* supplied the credential and never the value. Tool cards go
  through the generic `presentCall`/`presentResult` path with a real `kind`
  (read / search).
- **Source edits do not take effect automatically**: the installed artifact is a
  tarball snapshot.
- **PTC mode is untested.** `defineTool` makes `await tools.<name>(args)` work, but
  this plugin has not been driven under the PTC preset.

Designs that were evaluated and deliberately not implemented — structured review
evidence routing, idempotent PR creation, diff budgets, flow state — are recorded
in [docs/DESIGN.md](./docs/DESIGN.md) §8 so the ideas are not lost with the source
repositories.

## Development

```bash
npm run vendor    # rebuild the @deepseek-ai packages from the dsh installation
npm test          # offline: no network, no gh (140 checks)
npm run verify    # bundle integrity: parse, imports, manifest, entry shape
npm run probe     # compile the tool DSL against the real defineTool
npm run test:live # opt-in: real read-only gh calls (14 checks)
```

The offline suite resolves `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`
from `test/.vendor/`, a byte-for-byte reconstruction of those packages extracted
from the dsh installation by `tools/asar-vendor.mjs`. Inside the Harness they
resolve through the launcher's runtime resolution instead. The tests deliberately
**do not stub** them — a stub would only test the stub.

It covers Config schema validation (every field defaulted; nine classes of invalid
value rejected), `defineTool` argument validation, compiled-schema subset
compliance, argv construction for all 58 actions, destructive-gate enforcement,
the approval ask, background-job admission, credential-chain precedence, the
Device Flow polling state machine, and the result contract asserted against real
return values.

### Proving a refactor changed nothing

Tests check the properties someone thought to check. A behaviour snapshot checks
everything that ran:

```bash
npm run snapshot -- > /tmp/before.json     # before touching anything
# ... refactor ...
npm run snapshot:compare -- /tmp/before.json
```

It drives every action of every tool through four argument sets (minimal, maximal,
without `confirm`, with `confirm`) and records the exact argv, result value, and
rejection text — 176 snapshots. Timings are normalised before comparison, because
a `0 ms` vs `1 ms` difference is clock noise and a tool that cries wolf gets
ignored. The R4 refactor was done under this net and required 176/176 identical
between every step.

### Checking the argv against the real `gh`

Two probes run the argv shapes against the `gh` binary on the machine, because
several defects shipped while every offline assertion passed:

```bash
npm run probe:argv    # every argv shape this plugin builds, parsed by `gh <argv> --help`
npm run probe:arity   # positional counts vs gh's own USAGE line
npm run probe:prove   # what those two can and cannot catch, measured
```

`--help` parsing catches an invented FLAG NAME (`run delete --yes`), and the
USAGE line catches a POSITIONAL COUNT error (`repo rename new-name o/n`). It
cannot catch a mandatory flag that is omitted (`pr review` without `--approve`),
because gh only complains about that at execution time — so those are pinned by
exact-argv assertions in the offline suite instead. Both probes report
**UNCHECKED** on a machine with no `gh`, rather than passing: silence and success
must not look alike. `npm run release` runs them.

## Design

[docs/DESIGN.md](./docs/DESIGN.md) records what was taken from which upstream
project and why — including what was deliberately dropped, the two judgments that
measurement overturned, and the constraints of the official DSL that only appeared
when compiling against the real libraries.

MIT licensed — see [LICENSE](./LICENSE). Changes are listed in
[CHANGELOG.md](./CHANGELOG.md).

## License

MIT.
