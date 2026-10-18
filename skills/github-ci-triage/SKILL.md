---
name: github-ci-triage
description: Diagnose a failing GitHub Actions run from its log, and separate a real failure from an infrastructure flake. Use when a CI run failed, when asked why a workflow is red, or when asked to fix a failing check.
whenToUse: Use when a CI run failed, when asked why a workflow is red, or when asked to fix a failing check.
---

# Triaging a failing CI run

The log is large; the answer is usually one step. Read the run metadata first so you know
which step to read at all.

## Workflow

1. **Find the run.** `github_actions` action `list` — filter with `branch` and
   `status: failure`. Note the run id.
2. **Find the failing job and step.** `github_actions` action `runView` with the run id.
   The projection names the failing step; do not read the whole log to discover it.
3. **Read only the failure.** `github_actions` action `runLog` with `failedOnly: true`. For
   a long log the tail is written to a spill file — read that file rather than re-running
   with a bigger cap.
4. **Classify before proposing a fix:**

   | Symptom | Class | Action |
   |---|---|---|
   | dependency download timed out, runner disappeared | infrastructure | re-run; do not change code |
   | assertion or test failure with a stack | real | fix the cause the stack names |
   | lint or type error | real | fix at the reported location |
   | "no space left", OOM killed | infrastructure or config | check the workflow, then re-run |

5. **Establish the root cause only from real evidence** — the check state, the log, and the
   diff. Never infer a failure reason from a single error string that happens to appear in
   the log.
6. **Missing, pending or inconclusive logs are uncertainty.** Report them as uncertainty
   instead of guessing what the log would have said.

## Evidence required

A diagnosis names: the run id, the failing job, the failing step, and the line of the log
that shows it. "The tests failed" is not a diagnosis.

## Write boundary

| Action | Boundary |
|---|---|
| `list`, `runView`, `runLog`, `workflowList`, `workflowView` | Allowed — read-only |
| Editing code locally to fix a real failure | Allowed when the user asked to fix it; run the most relevant local verification afterwards |
| `github_actions` action `rerun` | **Destructive: it discards the previous result.** Only on an explicit instruction, and the prompt may refuse |
| `github_actions` action `cancel`, `runDelete`, `dispatch` | Only on an explicit instruction naming the run or workflow |
| `git push` of a fix | Not covered by "fix the CI" — pushing is a separate instruction |

If the failure is clearly unrelated to the local diff, say so **before** proposing code
changes: a fix that touches unrelated code is a worse outcome than an honest report.

## Stop when

- the failing step and its cause are identified; or
- the log shows the failure is in a repository or workflow this workspace does not own —
  report that instead of guessing at a fix.
