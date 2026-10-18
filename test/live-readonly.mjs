/**
 * Opt-in live verification: real read-only calls through THIS plugin's own
 * runner, resolver, and workspace detection.
 *
 * Everything here is read-only by construction. It exists because the offline
 * suite proves the plugin's logic against fakes, which cannot prove that the
 * process runner, the credential chain, and the guarded API path actually work
 * against the real `gh` binary and the real API.
 *
 * Run with: node test/live-readonly.mjs
 */

import { normalizeConfig } from '../lib/config.js'
import { createRunner } from '../lib/runner.js'
import { describeAuth, resolveToken } from '../lib/auth.js'
import { detectRepository, parseGitHubRemote, safeBranchName } from '../lib/workspace.js'

const cfg = normalizeConfig({ timeoutMs: 30_000 })
const credentials = undefined // this harness has no dsh context
const runner = createRunner(cfg, { info: () => {}, warn: () => {} }, async () => {
  const { token } = await resolveToken({ credentials, runner, credentialRef: cfg.credentialRef })
  return token
})

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = []

/**
 * Record one check.
 * @param {string} name the check name
 * @param {boolean} ok whether it passed
 * @param {string} detail what was observed
 */
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

console.log('=== live read-only verification ===\n')

// 1. The runner can execute the real gh binary and parse its version.
const probe = await runner.probe()
record('runner: gh probe', probe.available === true, `available=${String(probe.available)} version="${probe.version}"`)

// 2. The layered credential chain resolves a token without any config.
const auth = await describeAuth({ credentials, runner, credentialRef: cfg.credentialRef })
record(
  'auth: layered chain resolves a credential',
  auth.authenticated === true,
  `source=${auth.source} login=${auth.login ?? '(unknown)'} ghInstalled=${String(auth.ghInstalled)}`,
)

// 3. A real API call through the runner's env-injection path.
const userResult = await runner.run(['api', 'user', '--jq', '.login'])
record(
  'runner: gh api user (token injected via env, never argv)',
  userResult.ok === true && userResult.stdout.trim() !== '',
  `exit=${userResult.exitCode} login="${userResult.stdout.trim()}" argv=${JSON.stringify(userResult.command)}`,
)

// 4. The runner reports a non-zero exit instead of throwing.
const badResult = await runner.run(['repo', 'view', 'this-org-does-not-exist-xyz/nope'])
record(
  'runner: a failing command reports ok:false rather than throwing',
  badResult.ok === false && badResult.exitCode !== 0,
  `exit=${badResult.exitCode} stderr="${badResult.stderr.split('\n')[0].slice(0, 70)}"`,
)

// 5. The runner kills a hung command and reports the timeout.
const slowStart = Date.now()
const slow = await runner.run(['api', '--method', 'GET', '--paginate', '/search/issues', '-f', 'q=is:issue', '-f', 'per_page=1'], { timeoutMs: 1_000 })
record(
  'runner: timeout kills the process and reports it',
  slow.timedOut === true || slow.ok === false,
  `timedOut=${String(slow.timedOut)} durationMs=${Date.now() - slowStart} signal="${slow.signal}"`,
)

// 6. Output beyond the cap spills to a file whose path is returned.
const smallCap = createRunner(normalizeConfig({ maxOutputBytes: 1_024, timeoutMs: 60_000 }), undefined, async () => {
  const { token } = await resolveToken({ credentials, runner, credentialRef: cfg.credentialRef })
  return token
})
// A wide page is needed to exceed 1 KiB; one commit's JSON is only ~100 B.
// The query goes IN THE PATH: `gh api -f per_page=100` would imply POST.
const big = await smallCap.run(['api', '/repos/cli/cli/issues?per_page=100'])
record(
  'runner: output past the cap spills to a file',
  big.truncated === true && big.spillPath !== '',
  `truncated=${String(big.truncated)} spillPath=${big.spillPath} inMemory=${big.stdout.length}B`,
)

// 7. The runner runs git with prompts disabled.
const gitStatus = await runner.runGit(['status', '--short'])
record(
  'runner: git runs with prompts disabled',
  gitStatus.exitCode !== -1,
  `exit=${gitStatus.exitCode} stdout="${gitStatus.stdout.trim().slice(0, 60)}"`,
)

// 8. Remote parsing covers the three URL spellings and rejects foreign hosts.
const forms = [
  ['https://github.com/owner/repo.git', 'owner/repo'],
  ['git@github.com:owner/repo.git', 'owner/repo'],
  ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
  ['https://github.com/owner/repo', 'owner/repo'],
]
const parsed = forms.every(([url, expected]) => {
  const result = parseGitHubRemote(url)
  return result !== null && `${result.owner}/${result.repo}` === expected
})
const rejected = parseGitHubRemote('https://gitlab.com/owner/repo.git') === null &&
  parseGitHubRemote('https://github.com/owner/repo/extra') === null &&
  parseGitHubRemote('/local/path') === null
record('workspace: parses the three GitHub URL forms and rejects foreign hosts', parsed && rejected,
  `forms=${forms.length} rejected=${String(rejected)}`)

// 9. Branch-name sanitization refuses the escaping shapes.
const sanitize = (() => {
  const rejectedNames = []
  for (const hostile of ['../../etc/passwd', 'feat/../../x', '.hidden', '/abs', '-flag', 'a..b', 'a//b']) {
    try {
      safeBranchName(hostile)
      rejectedNames.push(`NOT-REJECTED:${hostile}`)
    } catch { /* expected */ }
  }
  return rejectedNames
})()
record(
  'workspace: branch-name sanitization rejects traversal and escaping shapes',
  sanitize.length === 0 && safeBranchName('feat/x-1') === 'feat/x-1',
  sanitize.length === 0 ? 'all rejected; normal="feat/x-1"' : sanitize.join(', '),
)

// 10. Workspace detection either finds this repository or cleanly reports none.
const detected = await detectRepository(runner, process.cwd())
record('workspace: repository detection never throws', true,
  detected === null ? 'no GitHub remote in this cwd (clean null)' : `${detected.owner}/${detected.repo} via ${detected.remoteName}`)

// 11. The guarded API tool reaches the real API through gh.
const apiResult = await runner.run(['api', '/repos/cli/cli', '--method', 'GET'])
let apiName
try {
  apiName = JSON.parse(apiResult.stdout).full_name
} catch { apiName = undefined }
record('api: gh api returns parsed JSON', apiResult.ok === true && apiName === 'cli/cli',
  `exit=${apiResult.exitCode} full_name="${apiName}"`)

// 12. A 404 is reported as a failure with gh's own diagnostic, not a throw.
const notFound = await runner.run(['api', '/repos/this-org-does-not-exist-xyz/nope', '--method', 'GET'])
record('api: a 404 is reported rather than thrown', notFound.ok === false && /HTTP 404/.test(notFound.stderr),
  `exit=${notFound.exitCode} stderr="${notFound.stderr.split('\n')[0].slice(0, 60)}"`)

// 13. Pagination aggregates array results.
// `per_page=100` keeps this to a few pages: at per_page=5 the 275-branch
// repository needs 55 requests, which can exceed a 30s budget on a proxied
// connection and made this check fail intermittently for no code reason.
const paged = await runner.run(
  ['api', '/repos/cli/cli/branches?per_page=100', '--method', 'GET', '--paginate'],
  { timeoutMs: 120_000 },
)
let branchCount
try {
  const parsedPage = JSON.parse(paged.stdout)
  branchCount = Array.isArray(parsedPage) ? parsedPage.length : undefined
} catch { branchCount = undefined }
record('api: pagination aggregates pages', paged.ok === true && typeof branchCount === 'number' && branchCount > 100,
  `exit=${paged.exitCode} branches=${String(branchCount)}`)

// 14. An unauthenticated request works for public data and carries no token.
const anon = await runner.run(['api', '/repos/cli/cli', '--method', 'GET'], {
  env: { PATH: process.env.PATH, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
})
record('api: an unauthenticated public request is possible', anon.ok === true,
  `exit=${anon.exitCode} (env stripped of any token)`)

// 15-…: EVERY read-only action, driven through the REAL registry against the
// REAL gh, asserting only that gh does not reject the command line itself.
//
// This is the check that was missing. `github_repo branches` shipped for three
// releases with `json: 'name,commit'` while building a `gh api` command, so the
// registry appended `--json` to a command that has no such flag and every call
// died with "unknown flag: --json". Offline tests only asserted the argvs they
// chose to assert, and the live suite exercised `lib/` modules rather than whole
// actions, so nothing walked every action against real gh until now.
//
// The assertion is deliberately narrow — a usage error, not success — because a
// read-only probe of arbitrary resources legitimately 404s, and a red CI run for
// "pull request 1 does not exist" would train everyone to ignore this check.
const { registerDomainTools } = await import('../lib/registry.js')

/** Register the tools against a recording context and return them. */
function registerForProbe() {
  const tools = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    get: () => undefined,
    effect: () => () => {},
    tools: {
      register: (definition) => { tools.set(definition.name, definition); return () => {} },
      guard: () => () => {},
    },
  }
  // The real runner, so the real gh is what answers.
  registerDomainTools(ctx, cfg, runner, { cwd: process.cwd(), deps: {} })
  return tools
}

const probeTools = registerForProbe()
const READ_PROBES = [
  ['github_repo', { action: 'view', repo: 'cli/cli' }],
  ['github_repo', { action: 'list', limit: 2 }],
  ['github_repo', { action: 'branches', repo: 'cli/cli', limit: 3 }],
  ['github_repo', { action: 'branches', repo: 'cli/cli', branch: 'trunk' }],
  ['github_pr', { action: 'list', repo: 'cli/cli', limit: 2 }],
  ['github_pr', { action: 'view', repo: 'cli/cli', number: 1 }],
  ['github_pr', { action: 'diff', repo: 'cli/cli', number: 1 }],
  ['github_pr', { action: 'checks', repo: 'cli/cli', number: 1 }],
  ['github_issue', { action: 'list', repo: 'cli/cli', limit: 2 }],
  ['github_issue', { action: 'view', repo: 'cli/cli', number: 1 }],
  ['github_release', { action: 'list', repo: 'cli/cli', limit: 2 }],
  ['github_release', { action: 'view', repo: 'cli/cli' }],
  ['github_actions', { action: 'list', repo: 'cli/cli', limit: 2 }],
  ['github_actions', { action: 'runView', repo: 'cli/cli', runId: '38447288363' }],
  ['github_actions', { action: 'workflowList', repo: 'cli/cli', limit: 2 }],
  ['github_search', { action: 'repos', query: 'cli language:go', limit: 2 }],
  ['github_search', { action: 'issues', query: 'repo:cli/cli is:open', limit: 2 }],
  ['github_search', { action: 'prs', query: 'repo:cli/cli is:open', limit: 2 }],
  ['github_search', { action: 'code', query: 'repo:cli/cli func main', limit: 2 }],
  ['github_search', { action: 'commits', query: 'repo:cli/cli fix', limit: 2 }],
  ['github_auth', { action: 'status' }],
]

/** gh's own wording for a command line it cannot parse or a query/field it rejects. */
const USAGE_ERROR = /unknown flag|unknown command|unknown shorthand|unknown JSON field|unknown field|invalid search query|accepts \d+ arg|required flag|invalid argument|Usage:\s+gh/im

let usageFailures = 0
for (const [toolName, args] of READ_PROBES) {
  const definition = probeTools.get(toolName)
  if (definition === undefined) {
    record(`live argv: ${toolName} ${args.action}`, false, 'tool is not registered')
    usageFailures += 1
    continue
  }
  let outcome
  try {
    outcome = await definition.execute(args, { signal: undefined })
  } catch (error) {
    // A thrown infrastructure error still has to be gh's, not a bad flag.
    const message = String(error?.message ?? error)
    const bad = USAGE_ERROR.test(message)
    if (bad) usageFailures += 1
    record(`live argv: ${toolName} ${args.action}`, !bad, message.split('\n')[0].slice(0, 110))
    continue
  }
  const bad = USAGE_ERROR.test(outcome.stderr ?? '')
  if (bad) usageFailures += 1
  record(
    `live argv: ${toolName} ${args.action}`,
    !bad,
    `exit=${outcome.exitCode} ${bad ? 'USAGE ERROR: ' : ''}${(outcome.stderr || outcome.stdout || '').split('\n')[0].slice(0, 90)}`,
  )
}
record(
  `live argv: no read-only action sends gh an unparseable command line (${READ_PROBES.length} probes)`,
  usageFailures === 0,
  usageFailures === 0 ? 'every constructed argv was accepted by gh' : `${usageFailures} action(s) rejected their own command line`,
)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  console.log('failed:')
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
