/**
 * github_actions — workflow runs and CI diagnostics.
 *
 * The domain that answers "why is CI red?". `runView` is cheap; `runLog` and
 * `runWatch` are marked `long` because a log download or a watch can outlast
 * the normal timeout. `runLog` is also where a spilled file matters most: an
 * Actions log easily exceeds the in-memory cap.
 */

import { str, bool, int, enumStr } from '../schema.js'

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_actions',
  title: 'GitHub Actions',
  // Every diagnostic action is a read, including the long ones: `runLog` and
  // `runWatch` only observe a run, so they are safe alongside other reads.
  readOnlyActions: ['list', 'runView', 'runLog', 'runWatch', 'workflowList', 'workflowView'],
  description:
    'Inspect and control workflow runs. The diagnostic path is list → runView → runLog: list to ' +
    'find the failed run, runView to see which job failed, runLog to read the output. Rerun, cancel, ' +
    'delete, and workflow dispatch all require confirm: true because they change or discard state. ' +
    'Long logs exceed the in-memory cap and their tail is written to a spill file whose path is returned.',
  params: {
    repo: str('requiresRepo: target repository as "owner/name". Omit it to use the workspace remote.'),
    runId: str('runView/runLog/runWatch/rerun/cancel/runDelete: the workflow run id (from `list` or the run URL).'),
    // The action ids are spelled out rather than written as `workflow
    // list/view/dispatch`. That shorthand reads fine to a human but names no real
    // action, so neither a reader nor a machine can map it — and it hid the fact
    // that `list` reads this parameter too.
    workflow: str('list/workflowView/dispatch: workflow file name or id (e.g. ci.yml).'),
    branch: str('list: filter runs by branch.'),
    status: enumStr(
      // gh's own check-run status values, including `startup_failure`. An enum that
      // omits a value the caller cannot ask about silently narrows the filter.
      ['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending'],
      'list: filter runs by status or conclusion.',
    ),
    limit: int('list: maximum runs to return (default 20).'),
    job: str('runLog: a specific job id to read instead of the whole run.'),
    failedOnly: bool('runLog: only the failed steps.'),
    ref: str('dispatch: the git ref to run the workflow on.'),
    field: str('dispatch: a key=value input for the workflow, e.g. "environment=staging".'),
    confirm: bool('DESTRUCTIVE: set to true to explicitly confirm this action.'),
    timeoutMs: int('Optional per-call timeout in milliseconds.'),
  },
  globalRepoFlag: true,
  actions: {
    list: {
      help: 'List recent workflow runs, optionally filtered by branch, status, or workflow.',
      needs: [],
      requiresRepo: true,
      json: 'databaseId,displayTitle,status,conclusion,headBranch,event,createdAt,url',
      argv: (a) => {
        const argv = ['run', 'list', '--limit', String(a.limit ?? 20)]
        if (a.branch) argv.push('--branch', a.branch)
        if (a.status) argv.push('--status', a.status)
        if (a.workflow) argv.push('--workflow', a.workflow)
        return argv
      },
    },
    runView: {
      help: 'Show one run: its jobs, their conclusions, and the failing step.',
      needs: ['runId'],
      requiresRepo: true,
      json: 'databaseId,displayTitle,status,conclusion,jobs,headBranch,url',
      argv: (a) => ['run', 'view', a.runId],
    },
    runLog: {
      help: 'Read a run\'s log (or one job\'s with `job`). failedOnly narrows it to failed steps. Long output spills to a file.',
      needs: ['runId'],
      requiresRepo: true,
      long: true,
      argv: (a) => {
        const argv = ['run', 'view', a.runId, '--log']
        if (a.job) argv.push('--job', a.job)
        if (a.failedOnly === true) argv.push('--log-failed')
        return argv
      },
    },
    runWatch: {
      help: 'Watch a run until it finishes, then report its conclusion. Long-running.',
      needs: ['runId'],
      requiresRepo: true,
      long: true,
      argv: (a) => ['run', 'watch', a.runId],
    },
    rerun: {
      help: 'Re-run a completed workflow run, or only its failed jobs (requires confirm: true).',
      needs: ['runId'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => {
        const argv = ['run', 'rerun', a.runId]
        if (a.failedOnly === true) argv.push('--failed')
        return argv
      },
    },
    cancel: {
      help: 'Cancel an in-progress run (requires confirm: true).',
      needs: ['runId'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => ['run', 'cancel', a.runId],
    },
    runDelete: {
      help: 'Delete a workflow run and its logs permanently (requires confirm: true).',
      needs: ['runId'],
      requiresRepo: true,
      destructive: true,
      // No `--yes`: `gh run delete` only accepts `--help` and `--repo`, and rejects
      // anything else with "unknown flag: --yes". Confirmation is this plugin's
      // confirm gate plus the approval seam, not a gh flag.
      argv: (a) => ['run', 'delete', a.runId],
    },
    workflowList: {
      help: 'List the repository\'s workflows with their state.',
      needs: [],
      requiresRepo: true,
      json: 'id,name,path,state',
      argv: () => ['workflow', 'list'],
    },
    workflowView: {
      help: 'Show one workflow definition.',
      needs: ['workflow'],
      requiresRepo: true,
      argv: (a) => ['workflow', 'view', a.workflow],
    },
    dispatch: {
      help: 'Trigger a workflow_dispatch run (requires `workflow` and confirm: true).',
      needs: ['workflow'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => {
        const argv = ['workflow', 'run', a.workflow]
        if (a.ref) argv.push('--ref', a.ref)
        if (a.field) {
          const [key, ...rest] = String(a.field).split('=')
          argv.push('--field', `${key}=${rest.join('=')}`)
        }
        return argv
      },
    },
  },
}

export default domain
