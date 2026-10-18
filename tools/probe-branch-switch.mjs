/**
 * The branch switch route, against a real repository.
 *
 * ## Why this is a guard and not a one-off check
 *
 * `switchBranch` is the first operation in this plugin that changes the user's working
 * tree, and the way it can go wrong is not "throws an exception" — it is "accepts a string
 * that git reads as an OPTION". `git switch --force` and `git switch -f` both discard
 * uncommitted work, and both are reachable the moment a caller can put a dash at the front
 * of the name.
 *
 * So the interesting assertions here are all adversarial: they pass a name that is not a
 * ref and require a refusal. A guard that only checked a happy-path switch would pass on
 * the day the injection was introduced.
 *
 * ## What it needs
 *
 * A real git repository with at least two branches. It looks for one rather than creating
 * it, and skips with a clear message when there is none — a test that builds its own
 * fixture repository would be testing the fixture. Point it somewhere else with
 * `--repo <path>`.
 *
 * It never leaves the repository on a different branch than it found it.
 *
 * Usage: node --import ./test/register-hook.mjs tools/probe-branch-switch.mjs [--repo <path>]
 */

import { existsSync, statSync } from 'node:fs'
import { listBranches, workingTreeState, switchBranch } from '../lib/routes.js'
import { createRunner } from '../lib/runner.js'
import normalizeConfig from '../lib/config.js'

const args = process.argv.slice(2)
const repoArg = args.indexOf('--repo')
const CANDIDATES = [
  repoArg !== -1 ? args[repoArg + 1] : undefined,
  process.env.DSH_PROBE_REPO,
  'D:/xiyouji',
  'D:/dsh/github-gate',
].filter((value) => typeof value === 'string' && value !== '')

const results = []
/**
 * Record one check.
 *
 * @param {boolean} ok whether it passed
 * @param {string} name what was checked
 * @param {string} [detail] the evidence
 */
function check(ok, name, detail = '') {
  results.push({ ok, name, detail })
}

/** A repository with a real branch history, or undefined. */
async function findRepo(runner) {
  for (const candidate of CANDIDATES) {
    if (!existsSync(candidate) || statSync(candidate).isDirectory() === false) continue
    const listed = await listBranches(runner, candidate)
    if (listed.ok === true && listed.branches.length > 0) return { path: candidate, listed }
  }
  return undefined
}

// Built the same way `index.js` builds it. `createRunner({})` looks like it should work and
// does not: an empty config leaves `gitPath` unset, the runner falls back to `undefined`
// instead of the string 'git', and every call fails to spawn. Passing a config through the
// normaliser is what gives the defaults. The first version of this guard did it the wrong
// way and reported "no repository found" for a repository that has two branches.
const runner = createRunner(normalizeConfig({}))
const repo = await findRepo(runner)

if (repo === undefined) {
  console.log('no git repository with branches found in:')
  for (const candidate of CANDIDATES) console.log(`  ${candidate}`)
  console.log('')
  console.log('Pass one with --repo <path>. The guard needs a real repository on purpose:')
  console.log('a fixture it built itself would be testing the fixture, not git.')
  process.exitCode = 0
  process.exit(0)
}

const { path: cwd } = repo

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------
check(repo.listed.ok === true, 'listBranches reports success', repo.listed.detail)
check(repo.listed.branches.length > 0, 'listBranches finds at least one branch',
  repo.listed.branches.map((b) => b.name).slice(0, 5).join(', '))
check(
  repo.listed.branches.every((b) => typeof b.name === 'string' && b.name !== ''),
  'every listed branch has a name',
)
check(
  repo.listed.branches.every((b) => Number.isInteger(b.ahead) && Number.isInteger(b.behind)),
  'ahead/behind are integers on every branch',
  repo.listed.branches.filter((b) => b.ahead > 0 || b.behind > 0)
    .map((b) => `${b.name} ↑${b.ahead} ↓${b.behind}`).join(', ') || 'none have tracking',
)

const tree = await workingTreeState(runner, cwd)
check(typeof tree.clean === 'boolean', 'workingTreeState answers clean or not',
  `clean=${tree.clean} files=${tree.files}`)
check(tree.clean === true ? tree.files === 0 : tree.files !== 0,
  'the file count agrees with the clean flag', `${tree.clean} / ${tree.files}`)

// ---------------------------------------------------------------------------
// The adversarial half. Every one of these is a string a caller could send.
// ---------------------------------------------------------------------------
const INJECTION_ATTEMPTS = [
  ['--force', 'the flag that would discard uncommitted work'],
  ['-f', 'the short form of the same flag'],
  ['--discard-changes', 'the explicit form'],
  ['-C', 'the flag that would run git in another directory'],
  ['--detach', 'detaching is not switching'],
  ['HEAD~1', 'a revision expression, not a branch'],
  ['refs/heads/main', 'a full ref, not a short name'],
  ['nonexistent-branch-xyzzy', 'a plausible name that is not a ref'],
  ['', 'the empty string'],
  ['  ', 'whitespace'],
  ['main\n--force', 'a newline hiding a second argument'],
  ['$(whoami)', 'command substitution syntax'],
  ['; rm -rf /', 'a shell separator'],
  ['`id`', 'backtick substitution'],
  ['../../etc/passwd', 'a path traversal shape'],
]

for (const [attempt, why] of INJECTION_ATTEMPTS) {
  const outcome = await switchBranch(runner, cwd, attempt, 15_000)
  check(outcome.ok !== true, `refuses ${JSON.stringify(attempt)} — ${why}`,
    outcome.ok === true ? 'ACCEPTED — this is the defect' : String(outcome.error))
}

// The refs must be unchanged by all of that. This is the assertion that would catch a
// refusal that reported failure while still running the command.
const afterAttempts = await listBranches(runner, cwd)
check(afterAttempts.branches.length === repo.listed.branches.length,
  'the injection attempts did not create or delete a branch',
  `${repo.listed.branches.length} before, ${afterAttempts.branches.length} after`)

// ---------------------------------------------------------------------------
// The real switch, and the guarantee that it is reversed.
// ---------------------------------------------------------------------------
const before = repo.listed.branches.find((b) => b.name !== '')?.name
const currentState = await runner.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 })
const original = String(currentState.stdout ?? '').trim()
const target = repo.listed.branches.map((b) => b.name).find((name) => name !== original)

if (target === undefined) {
  check(false, 'a second branch exists to switch to',
    `only ${JSON.stringify(original)} exists — cannot exercise a real switch`)
} else if (tree.clean !== true) {
  // Not a failure: a dirty tree is exactly when a switch SHOULD be refused, and asserting
  // a successful switch here would require touching the user's files.
  const refused = await switchBranch(runner, cwd, target, 20_000)
  check(refused.ok !== true, 'a switch on a dirty tree is refused rather than forced',
    `tree has ${tree.files} modified path(s); route said ${refused.error}`)
} else {
  const switched = await switchBranch(runner, cwd, target, 30_000)
  check(switched.ok === true, `switches to a real branch (${target})`,
    switched.ok === true ? `now on ${switched.branch}` : `${switched.error}: ${switched.detail}`)
  check(switched.branch === target, 'the outcome names the branch actually checked out',
    `${switched.branch} vs ${target}`)

  const back = await switchBranch(runner, cwd, original, 30_000)
  check(back.ok === true, `switches back to ${original}`, back.ok === true ? back.branch : String(back.error))

  const settled = await runner.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 })
  check(String(settled.stdout ?? '').trim() === original,
    'the repository is left on the branch it started on',
    `${String(settled.stdout ?? '').trim()} vs ${original}`)
}

// A branch that exists is not refused.
if (before !== undefined) {
  const listedAgain = await listBranches(runner, cwd)
  check(listedAgain.branches.some((b) => b.name === before),
    'a branch that exists remains listed after the injections', before)
}

const failed = results.filter((r) => !r.ok)
for (const item of results) {
  if (item.ok) continue
  console.log(`FAIL  ${item.name}`)
  if (item.detail !== '') console.log(`      ${item.detail}`)
}
console.log(`branch switch — repository: ${cwd}`)
console.log(`                 ${repo.listed.branches.length} branch(es), ${INJECTION_ATTEMPTS.length} injection attempts`)
console.log(`=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  console.log('failed:')
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
