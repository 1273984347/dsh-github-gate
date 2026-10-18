---
name: github-issue-to-pr
description: Take a GitHub issue through to a pull request — read the issue, branch, implement, and open a PR that references it. Use when asked to implement an issue or fix a reported bug.
whenToUse: Use when asked to implement an issue, fix a reported bug, or deliver work that should close an issue.
---

# From issue to pull request

The issue is a request, not a specification. Read it, confirm what it asks for, and let the
pull request say how it was answered.

## Workflow

1. **Read the issue.** `github_issue` action `view` with `number`. Note the labels, the
   milestone, and whether someone is already assigned — an assigned issue may be in
   progress, and starting it anyway creates duplicated work.
2. **Read the discussion.** The issue body is often edited; the comments hold the actual
   agreement about what to do. `github_api` with `repos/{repo}/issues/{number}/comments`.
3. **Branch.** `github_issue` action `develop` creates and links a branch for the issue, so
   the association is recorded rather than implied by a commit message.
4. **Implement and verify in the workspace** using the repository's own tooling. Do not open
   a pull request whose change has not been run.
5. **Open the pull request.** `github_pr` action `create` with `title` and a `body` that
   references the issue (`Closes #123`) and states what was verified. `head` defaults to the
   checked-out branch. A body is required — `fill: true` uses the commits when that is
   honest.
6. **Report the link.** Give the pull request number and URL, and say what you verified
   locally versus what only CI can confirm.

## Write boundary

| Action | Boundary |
|---|---|
| `github_issue` action `view`, `list`, and the comments read | Allowed — read-only |
| `github_issue` action `develop` (create the branch) | Allowed under "implement this issue"; it writes a ref |
| Local edits, commits, and local verification | Allowed under the same instruction |
| `github_pr` action `create` | Allowed under "implement this issue" — that is the deliverable |
| `github_issue` action `close` | **Do not close it by hand.** `Closes #123` in the pull request body closes it on merge, which keeps the record honest about when the work landed |
| `github_issue` action `edit`, `github_pr` action `merge` | Only on an explicit instruction naming the issue or pull request |

Pushing to a protected branch, or to a repository the user does not own, is outside
"implement this issue" — ask before doing it.

## Stop when

- the pull request is open and its number is reported; or
- the issue cannot be implemented as described — then comment on the issue with the
  specific obstacle rather than opening a pull request that does something else.
