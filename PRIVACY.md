# Privacy

`dsh-github-gate` is a local plugin. It has no server, no analytics, no telemetry,
and no account of its own. This page lists every place data can go, so the answer
to "what does it send" is checkable rather than promised.

## What leaves this machine

Only requests you or your agent cause, and only to hosts you configure:

| Destination | When | What is sent |
|---|---|---|
| `api.github.com` (or your `apiBaseURL`) | Any `github_*` call | The command's arguments via `gh`; your credential in an HTTP header, added by `gh` |
| `github.com` (or your `authBaseURL`) | `github_auth` action `login` | The OAuth Device Flow request: your `deviceFlowClientId` and requested scope. No secret |
| `github.com` release API | `github_update` action `check`/`stage` | Nothing but the request for this project's public release metadata |
| Your git remote | `git ls-remote`, `git fetch`-style reads | The refspec, through the git binary you already use |

There is no other endpoint. No request is sent at startup unless you set
`updateCheck: true`, and even then it is one read of public release metadata per
24 hours.

## What is stored, and where

| Data | Where | Retention |
|---|---|---|
| Your GitHub token | The Harness credential store, under `credentialRef` (default `GITHUB_TOKEN`) | Until you replace it, or the store is cleared |
| Update-check result | `<updateCacheDir>/check.json` (default: a folder in the system temp directory) | 24 hours; nothing personal in it — a version string and a timestamp |
| A staged release tarball | `<updateCacheDir>` | Until you delete it; it is a public artifact |

**This plugin never writes your token to a file it controls, a log line, or a tool
result.** The one deliberate exception is `github_auth` action `token`, which exists
to print a token for piping into another tool. Its output is the secret.

## What the Web UI can see

The browser half talks only to routes this plugin registers on `127.0.0.1`, and
every route that reads your credential or writes it requires the Harness
`connection` service to admit the caller. In a composition without that service the
request is refused with `403` — fail-closed, because a page that stores a secret
must not be reachable by an unauthenticated caller.

The settings page can read *whether* a credential exists and which layer supplied
it. It cannot read the token back: the Host never returns it, and the input field
is cleared on save.

## Removing your data

- Replace or clear the credential through the settings page, or the Harness
  credential store directly.
- Delete the update cache directory.
- Uninstall the plugin: `plugin_manager` action `remove_bundle`. Nothing survives
  in the plugin's own directory, because it stores nothing there.

## Reporting

A vulnerability is an issue you should not file publicly. Use the repository's
private advisory form (Security → Advisories → New).
