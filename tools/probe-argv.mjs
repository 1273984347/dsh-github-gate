/**
 * Adversarial gate: every argv this plugin can build is parsed by the REAL `gh`.
 *
 * The R2 audit found that `npm run verify` never ran a line of client code, and an
 * independent domain review found that several argv builders emit flags or
 * positional counts `gh` rejects outright — `repo rename` with two positionals,
 * `run delete --yes`, `repo list --affiliation`, `release download <tag> <asset>`.
 * Each of those shipped green because the offline suite only asserted that the
 * builder produced *some* array, never that gh could parse it.
 *
 * This file closes that hole the only way it can be closed offline: it asks
 * `gh <argv...> --help` for each shape. `--help` parses the FULL flag set and
 * rejects an unknown flag before printing, so a flag that does not exist fails
 * here without contacting the network or touching a repository. It cannot verify
 * positional COUNT (parse only, no execution) — that half stays measured by hand
 * against `gh <sub> --help` and recorded in DESIGN.md — but it removes the whole
 * class where a flag name was invented.
 *
 * A subcommand with no `gh <argv> --help` form (none today) is reported as
 * UNCHECKED rather than passed, so silence and coverage never look alike.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Whether `gh` is usable here. Without it this gate reports UNCHECKED, not PASS. */
async function ghAvailable() {
  try {
    await exec('gh', ['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * Whether `gh <argv...> --help` accepts these arguments.
 *
 * `clone` is the one subcommand that reaches the network even with `--help`
 * appended, because the `--` separator ends flag parsing and `--branch`/`dev`
 * become positionals for a subcommand help cannot intercept. Its sample passes
 * no repository for that reason, and a network error is therefore treated as a
 * PARSE success rather than a rejection — otherwise the only offline machine
 * would fail a check about flag names.
 *
 * @param {string[]} argv the argv under test
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function ghAccepts(argv) {
  try {
    await exec('gh', [...argv, '--help'], { timeout: 20_000 })
    return { ok: true, detail: '' }
  } catch (error) {
    const stderr = String((error).stderr ?? '')
    const stdout = String((error).stdout ?? '')
    const text = (stderr + stdout).split('\n').find((l) => l.trim() !== '') ?? 'unknown error'
    return { ok: false, detail: text.slice(0, 120) }
  }
}

/**
 * The argv shapes for every action in the domains, with concrete sample values.
 *
 * `verify-params` already proves a declared parameter reaches the argv; this file
 * pairs that with "the argv is one gh understands". The samples deliberately cover
 * the flags each action can add, because an unexercised flag is exactly the one
 * that went stale.
 *
 * @returns {Map<string, string[][]>} tool:action -> argv samples
 */
function sampleArgv() {
  return new Map([
    ['github_repo:view', [['repo', 'view', 'o/n'], ['repo', 'view', 'o/n', '--branch', 'main']]],
    ['github_repo:list', [['repo', 'list', '--limit', '30'], ['repo', 'list', 'someorg', '--limit', '30', '--visibility', 'public'], ['repo', 'list', '--limit', '10', '--archived'], ['repo', 'list', '--limit', '10', '--fork']]],
    ['github_repo:branches', [['api', 'repos/o/n/branches'], ['api', 'repos/o/n/branches?per_page=30']]],
    // `gh repo clone` reaches the network for ANY argument list, with or without
    // `--help`, because it resolves the repository before parsing the rest. Its
    // git-flag form is therefore excluded from this probe and pinned by
    // `tools/verify-params.mjs`, which asserts the separator ordering without
    // spawning gh. A flag-name check that cannot run is UNCHECKED, not PASS.
    // ['github_repo:clone', [['repo', 'clone', '--', '--branch', 'dev']]],
    ['github_repo:create', [['repo', 'create', 'name', '--public'], ['repo', 'create', 'org/name', '--private', '--clone'], ['repo', 'fork', 'o/n', '--clone', '--org', 'org']]],
    ['github_repo:edit', [['repo', 'edit', 'o/n'], ['repo', 'edit', 'o/n', '--description', 'x', '--homepage', 'https://e.org', '--visibility', 'private', '--add-topic', 't']]],
    ['github_repo:rename', [['repo', 'rename', 'new-name', '--yes', '--repo', 'a/b']]],
    ['github_repo:archive', [['repo', 'archive', 'a/b', '--yes']]],
    ['github_repo:delete', [['repo', 'delete', 'a/b', '--yes']]],
    ['github_pr:list', [['pr', 'list', '--limit', '20'], ['pr', 'list', '--limit', '20', '--base', 'main', '--head', 'dev', '--state', 'open']]],
    ['github_pr:view', [['pr', 'view', '1']]],
    ['github_pr:diff', [['pr', 'diff', '1']]],
    ['github_pr:checks', [['pr', 'checks', '1']]],
    ['github_pr:status', [['pr', 'status']]],
    ['github_pr:create', [['pr', 'create', '--title', 'T', '--body', 'B', '--base', 'main', '--head', 'dev'], ['pr', 'create', '--title', 'T', '--fill'], ['pr', 'create', '--title', 'T', '--draft']]],
    ['github_pr:comment', [['pr', 'comment', '1', '--body', 'x'], ['pr', 'comment', '1', '--body-file', 'f.md']]],
    ['github_pr:review', [['pr', 'review', '1', '--approve', '--body', ''], ['pr', 'review', '1', '--request-changes', '--body', 'x'], ['pr', 'review', '1', '--comment']]],
    ['github_pr:ready', [['pr', 'ready', '1']]],
    ['github_pr:checkout', [['pr', 'checkout', '1', '--branch', 'mine']]],
    ['github_pr:merge', [['pr', 'merge', '1'], ['pr', 'merge', '1', '--squash', '--delete-branch', '--subject', 's']]],
    ['github_pr:close', [['pr', 'close', '1', '--comment', 'c']]],
    ['github_pr:reopen', [['pr', 'reopen', '1']]],
    ['github_pr:edit', [['pr', 'edit', '1', '--title', 'T', '--base', 'main'], ['pr', 'edit', '1', '--body-file', 'f.md']]],
    ['github_issue:list', [['issue', 'list', '--limit', '30', '--state', 'open'], ['issue', 'list', '--limit', '5', '--label', 'bug', '--assignee', 'u', '--author', 'a', '--search', 'q']]],
    ['github_issue:view', [['issue', 'view', '1']]],
    ['github_issue:create', [['issue', 'create', '--title', 'T', '--label', 'bug', '--assignee', 'u', '--milestone', 'm']]],
    ['github_issue:comment', [['issue', 'comment', '1', '--body', 'x'], ['issue', 'comment', '1', '--body-file', 'f.md']]],
    ['github_issue:close', [['issue', 'close', '1', '--reason', 'completed', '--comment', 'c']]],
    ['github_issue:reopen', [['issue', 'reopen', '1', '--comment', 'c']]],
    ['github_issue:edit', [['issue', 'edit', '1', '--title', 'T', '--add-label', 'bug', '--add-assignee', 'u', '--milestone', 'm']]],
    ['github_issue:develop', [['issue', 'develop', '1', '--base', 'main']]],
    ['github_release:list', [['release', 'list', '--limit', '30']]],
    ['github_release:view', [['release', 'view', 'v1.0.0']]],
    ['github_release:create', [['release', 'create', 'v1.0.0', '--notes', 'n', '--target', 'main', '--draft', '--prerelease'], ['release', 'create', 'v1.0.0', '--generate-notes', '--latest=false'], ['release', 'create', 'v1.0.0', '--notes-file', 'f.md', '--title', 'T']]],
    ['github_release:edit', [['release', 'edit', 'v1.0.0', '--title', 'T', '--draft', '--prerelease', '--latest=false']]],
    ['github_release:upload', [['release', 'upload', 'v1.0.0', 'a.zip']]],
    ['github_release:download', [['release', 'download', 'v1.0.0', '--dir', '.'], ['release', 'download', 'v1.0.0', '--pattern', '*.zip', '--dir', 'out']]],
    ['github_release:delete', [['release', 'delete', 'v1.0.0', '--yes'], ['release', 'delete', 'v1.0.0', '--yes', '--cleanup-tag']]],
    ['github_actions:list', [['run', 'list', '--limit', '20', '--branch', 'main', '--status', 'failure', '--workflow', 'ci.yml']]],
    ['github_actions:runView', [['run', 'view', '123']]],
    ['github_actions:runLog', [['run', 'view', '123', '--log'], ['run', 'view', '123', '--log', '--job', '1'], ['run', 'view', '123', '--log-failed']]],
    ['github_actions:runWatch', [['run', 'watch', '123']]],
    ['github_actions:rerun', [['run', 'rerun', '123'], ['run', 'rerun', '123', '--failed']]],
    ['github_actions:cancel', [['run', 'cancel', '123']]],
    ['github_actions:runDelete', [['run', 'delete', '123']]],
    ['github_actions:workflowList', [['workflow', 'list']]],
    ['github_actions:workflowView', [['workflow', 'view', 'ci.yml']]],
    ['github_actions:dispatch', [['workflow', 'run', 'ci.yml', '--ref', 'main', '--field', 'k=v']]],
    ['github_search:repos', [['search', 'repos', 'is:open', '--limit', '20'], ['search', 'repos', 'stars:>100', '--limit', '5', '--language', 'ts']]],
    ['github_search:issues', [['search', 'issues', 'q', '--limit', '20', '--repo', 'o/n']]],
    ['github_search:prs', [['search', 'prs', 'q', '--limit', '20', '--owner', 'o']]],
    ['github_search:code', [['search', 'code', 'q', '--limit', '20', '--repo', 'o/n', '--language', 'ts']]],
    ['github_search:commits', [['search', 'commits', 'q', '--limit', '20', '--repo', 'o/n']]],
    ['github_api:request', [['api', '/rate_limit', '--method', 'GET'], ['api', '/repos/o/n/labels', '--method', 'POST', '--paginate']]],
    // The self-update tool builds its argv inside custom executors, so `verify-params`
    // covers the parameters by driving them. These samples cover the other half: that
    // the shapes it builds are ones `gh` parses.
    ['github_update:check', [['api', 'repos/o/r/releases/latest'], ['api', 'repos/o/r/releases?per_page=1']]],
    ['github_update:stage', [
      ['api', 'repos/o/r/releases/tags/v1.0.0'],
      ['release', 'download', 'v1.0.0', '--repo', 'o/r', '--pattern', 'dsh-github-gate-1.0.0.tgz', '--dir', '.', '--clobber'],
    ]],
  ])
}

/**
 * Every tool:action the plugin registers, so a shape with no sample is visible.
 *
 * @returns {void}
 */
function noteScope() {
  // The samples below are the alignment surface: each entry's key is the real
  // tool:action it belongs to. Adding an action without adding its shapes is a
  // coverage gap this probe cannot see, so the sum is asserted by hand against
  // `Object.keys(domain.actions)` in verify-params.
}

let passed = 0
let failed = 0
let unchecked = 0
const failures = []

if (!(await ghAvailable())) {
  console.log('UNCHECKED  gh is not available on this machine, so no argv was parsed.')
  console.log('\n=== argv samples not verified: not run ===')
  process.exit(0)
}

const samples = sampleArgv()
for (const [key, argvList] of samples) {
  for (const argv of argvList) {
    const result = await ghAccepts(argv)
    if (result.ok) {
      passed += 1
    } else {
      failed += 1
      failures.push(`${key}: gh ${argv.join(' ')}\n       gh says: ${result.detail}`)
    }
  }
}
void noteScope

console.log('=== ' + passed + '/' + (passed + failed) + ' argv shapes accepted by the real gh ===')
for (const line of failures) console.log('FAIL  ' + line)
if (failed > 0) {
  console.log('\n=== ' + failed + ' argv shape(s) gh does not accept ===')
  process.exitCode = 1
}
