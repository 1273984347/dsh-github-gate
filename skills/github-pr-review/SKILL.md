---
name: github-pr-review
description: Review a pull request with evidence. Use when asked to review a PR, judge whether one is ready to merge, or explain what a PR changes.
whenToUse: Use when asked to review a pull request, judge whether one is ready to merge, or explain what a pull request changes.
---

# Reviewing a pull request

A review is a claim about code, so it needs evidence. The failure mode is reading the
title and the description and then writing a confident paragraph about a diff nobody
opened.

## Workflow

1. **Identify the pull request.** `github_pr` action `view` with `number` (or action
   `list` with `head: "@current"` for the branch you are on). Record the base branch, the
   head branch, and whether it is a draft.
2. **Read the change, not the summary.** `github_pr` action `diff`. For a large diff, read
   it in pieces rather than skimming — the description is the author's account of the
   change, not the change.
3. **Check the machine verdict.** `github_pr` action `checks` for the check runs, and
   action `status` for the CI state of the branch. A failing check is evidence; say which
   one and why, not that "CI is red".
4. **Read prior discussion before adding to it.** `github_pr` action `view` returns the
   metadata; use `github_api` with `repos/{repo}/pulls/{number}/comments` when you need
   the inline review comments. Do not repeat a point someone already made.
5. **Report what you verified.** For each finding: the file, the line, what is wrong, and
   the evidence. Distinguish "this is incorrect" from "this is a preference".

## Evidence required before a verdict

| Claim | Evidence needed |
|---|---|
| "This changes X" | the diff hunk that changes X |
| "This breaks Y" | the call site of Y and the changed signature |
| "CI passes" | the check runs and their conclusions |
| "This is ready to merge" | the above, plus no unresolved review request |

## Write boundary

**Reading is free; everything that speaks for the user is not.**

| Action | Boundary |
|---|---|
| `view`, `diff`, `checks`, `status`, `list`, `github_api` GET | Allowed — read-only |
| `github_pr` action `comment` | Only when the user asked for a comment, or accepted the prompt. Do not leave a review comment to "be helpful" |
| `github_pr` action `review` | Records a judgement **under the user's account**. Approving is a judgement that person may not share; request it explicitly |
| `github_pr` action `merge`, `close`, `ready`, `edit` | Only on an explicit instruction naming the pull request |

`confirm: true` states your own intent; it is not the user's consent. The action raises a
prompt, and the answer may be no — do not look for a way around it, and do not treat
approval for one action as approval for the next.

## Stop when

- the diff and the checks have both been read, and you have stated the findings with their
  evidence; or
- a tool reports that the pull request does not exist — say so and stop, rather than
  trying the next number.
