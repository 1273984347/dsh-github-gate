# Roadmap

What this plugin intends to become, and what it deliberately will not. Ordered by
the question each item answers, not by size.

## Now (2.0)

- 9 tools / 58 actions over `gh`, argv arrays only, no shell.
- Every state-changing action carries `confirm: true` **and** passes an approval
  seam. `github_api` write methods are classified at run time by `method`.
- Digest-verified self-update (`github_update check` / `stage`).
- A branch pill in the session header, and a GitHub page in Settings → Plugins.
- Verification: 176 offline tests, 211 parameter assertions, 180 behaviour
  snapshots, real-`gh` argv probes (84 shapes, 50 positionals), live update probe.

## Next

### Coverage gaps that `github_api` currently fills

The typed actions stop where `gh`'s JSON field vocabulary stops being obvious.
Candidates, each gated on a real `gh --help` measurement:

- [ ] `github_issue` labels and milestones as first-class actions (`gh issue edit`
      covers them today, but there is no `list` for either).
- [ ] `github_pr` review comments (`gh api repos/{o}/{r}/pulls/{n}/comments`) —
      reading a review thread is common enough to deserve a typed read.
- [ ] `github_repo` topics as a list, not a single `--add-topic`.
- [ ] `github_actions` artifacts (`gh run download`) — needs the same `long` +
      background treatment `runLog` has.

### Web UI

- [ ] **Approval preview.** A destructive action currently asks through the Host's
      generic prompt. Rendering the exact `gh` argv that will run would let a person
      judge the target before consenting.
- [ ] **Update tab.** Move `github_update check` into the settings page so the
      version, staged artifact and digest state are visible without a tool call.
- [ ] **Localisation.** `locale/en.json` and `locale/zh.json` exist; the settings
      page and the pill are English-only today.

### Engineering

- [ ] **Publish to npm.** The install story is a tarball today; an npm spec would
      let `dsh plugin add` work. Blocked on deciding a package name scope.
- [ ] **Split `lib/registry.js`.** 948 lines and six responsibilities. The natural
      seams are presentation, ref resolution, background jobs and approval.
- [ ] **Coverage ratchet.** The suite is broad but unmeasured; a coverage floor
      would stop a new domain from landing with no tests.

## Not planned, with reasons

- **Direct REST calls instead of `gh`.** Measured: on a TLS-intercepting machine
  Node's CA store rejects `api.github.com` while `gh` succeeds. A second transport
  would also need its own pagination, error mapping and redirect handling.
- **Auto-install / auto-restart on update.** Installing rewrites the Harness profile
  and must stay behind the plugin manager's approval; restarting the Host from a
  plugin is not possible and not desirable. See `CHANGELOG.md` 1.7.1.
- **A settings page that can display the stored token.** A secret rendered in a DOM
  is a secret in every screenshot and screen share. `github_auth token` covers the
  legitimate "pipe it somewhere" case.
- **Bundling a fallback `gh`.** The plugin's value is that it uses the CLI you
  already trust and its platform trust store; shipping a binary would add a supply
  chain to a plugin whose point is a guarded one.
