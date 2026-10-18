/**
 * End-to-end run of `github_auth probe` against the real gh.
 *
 * The probe is the one action whose whole value is "does this actually work right
 * now", so it cannot be verified by asserting its argv — it has no argv. This runs
 * it for real and prints the ladder, then drives each failure branch with a
 * deliberately broken composition to prove the probe NAMES the broken layer
 * instead of collapsing.
 *
 * Usage: node --import ./test/register-hook.mjs tools/probe-connectivity.mjs
 */

import { normalizeConfig } from '../lib/config.js'
import { createRunner } from '../lib/runner.js'
import { registerDomainTools } from '../lib/registry.js'

const cfg = normalizeConfig({ timeoutMs: 30_000 })
const runner = createRunner(cfg, { info: () => {}, warn: () => {}, error: () => {} }, async () => '')

/**
 * Register the domains and return the tool map.
 * @param {Record<string, unknown>} deps what the probe layers resolve against
 * @param {import('../lib/types.js').Runner} [useRunner] the runner to use
 * @returns {Map<string, any>} the registered tools
 */
function register(deps, useRunner = runner) {
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
  registerDomainTools(ctx, cfg, useRunner, { cwd: process.cwd(), deps })
  return tools
}

/** Call one action and return the raw outcome the tool produced. */
async function call(tools, name, args) {
  const tool = tools.get(name)
  return tool.execute({ ...args }, { signal: undefined })
}

const results = []
/**
 * Record one check.
 * @param {boolean} ok whether it passed
 * @param {string} name the check name
 * @param {string} detail evidence
 */
function check(ok, name, detail = '') {
  results.push({ ok, name, detail })
}

// ---------------------------------------------------------------------------
// 1. The real composition.
// ---------------------------------------------------------------------------
const live = register({
  describeAuth: async () => ({ authenticated: true, source: 'gh-cli', login: 'probe', ghInstalled: true, ghVersion: 'probe' }),
  resolveRepoForProbe: async () => 'cli/cli',
})
const real = await call(live, 'github_auth', { action: 'probe' })
console.log('=== github_auth probe (real gh) ===')
console.log(real?.stdout ?? real.stdout ?? JSON.stringify(real).slice(0, 400))
console.log('')

const realLayers = real?.data?.layers ?? []
check(realLayers.length === 6, `the probe reports all six layers (${realLayers.length})`,
  realLayers.map((l) => `${l.name}${l.ok ? '=ok' : '=FAIL'}`).join(', '))
check(realLayers.every((l) => typeof l.ms === 'number' && l.ms >= 0), 'every layer carries a timing')
check(realLayers.some((l) => l.name === 'API round trip' && l.ok === true),
  'the real API round trip succeeds in this environment',
  realLayers.find((l) => l.name === 'API round trip')?.detail ?? 'absent')
check(real?.data?.brokenAt === null, 'a working path reports no broken layer',
  String(real?.data?.brokenAt))
check(real?.data?.repo === 'cli/cli', 'the resolved repository is reported',
  String(real?.data?.repo))

// The `command` label is the first thing a reader sees, and it went on listing five
// layers for a while after a sixth was added — the "description drifts from
// implementation" defect this project keeps catching, committed by the probe itself.
// It is derived from the layers now, and this asserts it stays that way.
{
  const label = String(real?.command ?? '')
  const missing = realLayers.map((l) => l.name).filter((name) => !label.includes(name))
  check(realLayers.length > 0 && missing.length === 0,
    'the probe command label names every layer that ran',
    missing.length === 0 ? label : `label omits: ${missing.join(', ')} — it is stale, not derived`)
}

// ---------------------------------------------------------------------------
// 2. gh missing entirely: the ladder must still be complete.
// ---------------------------------------------------------------------------
const brokenRunner = createRunner(
  normalizeConfig({ ghPath: 'definitely-not-a-real-gh-binary-xyz', timeoutMs: 10_000 }),
  { info: () => {}, warn: () => {}, error: () => {} },
  async () => '',
)
const noGh = register({
  describeAuth: async () => ({ authenticated: false, source: 'none', ghInstalled: false, ghVersion: '' }),
  resolveRepoForProbe: async () => '',
}, brokenRunner)
const missing = await call(noGh, 'github_auth', { action: 'probe' })
const missingLayers = missing?.data?.layers ?? []
check(missingLayers.length === 6, 'a missing gh still reports all six layers, not an exception',
  missingLayers.map((l) => `${l.name}${l.ok ? '=ok' : '=FAIL'}`).join(', '))
check(missing?.data?.brokenAt === 'gh executable', 'a missing gh is named as the broken layer',
  String(missing?.data?.brokenAt))
check(String(missing?.data?.recommended ?? '').includes('ghPath'),
  'the recommendation names the config key that fixes it',
  String(missing?.data?.recommended))
check(missing?.ok === false, 'the call reports failure rather than a green ladder')

// ---------------------------------------------------------------------------
// 3. A ladder that genuinely breaks at the credential layer.
//
// This needs a runner whose ONLY working command is `--version`. The real gh in
// this environment IS logged in, so a fake `describeAuth` returning "not
// authenticated" does not break the path: the API round trip still succeeds and
// the probe correctly calls that working. The first version of this test asserted
// a failure the probe had no reason to report — the test was wrong, not the probe.
// Driving the layers precisely is the only way to exercise the recommendation.
// ---------------------------------------------------------------------------
/** A runner that answers exactly one argv and fails everything else. */
const onlyVersion = {
  run: async (argv) => (argv[0] === '--version'
    ? { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh --version', stdout: 'gh version 9.9.9\n', stderr: '', truncated: false, spillPath: '' }
    : { ok: false, exitCode: 1, signal: '', timedOut: false, durationMs: 1, command: `gh ${argv.join(' ')}`, stdout: '', stderr: 'gh: not available in this probe', truncated: false, spillPath: '' }),
}
const noCred = register({
  describeAuth: async () => ({ authenticated: false, source: 'none', ghInstalled: true, ghVersion: '9.9.9' }),
  resolveRepoForProbe: async () => 'cli/cli',
}, onlyVersion)
const unauthenticated = await call(noCred, 'github_auth', { action: 'probe' })
check(unauthenticated?.ok === false, 'a broken API layer makes the whole probe report failure')
check(unauthenticated?.data?.brokenAt === 'credential chain',
  'the FIRST broken layer is named as the break point',
  String(unauthenticated?.data?.brokenAt))
check(String(unauthenticated?.data?.recommended ?? '').includes('login'),
  'the recommendation names the way to get a credential',
  String(unauthenticated?.data?.recommended))
check((unauthenticated?.data?.layers ?? []).some((l) => l.name === 'gh executable' && l.ok === true),
  'the layers that DID work are still reported as working',
  (unauthenticated?.data?.layers ?? []).map((l) => `${l.name}${l.ok ? '=ok' : '=FAIL'}`).join(', '))

// ---------------------------------------------------------------------------
// 4. A throwing layer must not take the probe down with it.
// ---------------------------------------------------------------------------
const thrower = register({
  describeAuth: async () => { throw new Error('credentials seam exploded') },
  resolveRepoForProbe: async () => 'cli/cli',
})
const survived = await call(thrower, 'github_auth', { action: 'probe' })
const survivedLayers = survived?.data?.layers ?? []
check(survivedLayers.length === 6, 'a THROWING layer still yields six reported layers',
  survivedLayers.map((l) => `${l.name}${l.ok ? '=ok' : '=FAIL'}`).join(', '))
check(survivedLayers.some((l) => l.detail.includes('credentials seam exploded')),
  'the thrown message is surfaced as that layer detail',
  survivedLayers.find((l) => l.name === 'credential chain')?.detail ?? 'absent')
check(survivedLayers.some((l) => l.name === 'API round trip' && l.ok === true),
  'the layers after the throwing one still ran')

// ---------------------------------------------------------------------------
// 5. Missing composition helpers are named, not crashed on.
// ---------------------------------------------------------------------------
const bare = register({})
const noDeps = await call(bare, 'github_auth', { action: 'probe' })
const bareLayers = noDeps?.data?.layers ?? []
check(bareLayers.length === 6, 'absent composition helpers still yield six layers',
  bareLayers.map((l) => `${l.name}${l.ok ? '=ok' : '=FAIL'}`).join(', '))
check(bareLayers.filter((l) => !l.ok).every((l) => /unavailable in this composition|no origin remote/.test(l.detail)),
  'each failing layer is NAMED with its own reason rather than throwing',
  bareLayers.filter((l) => !l.ok).map((l) => l.detail).join(' | ') || 'none failed')
// The overall verdict still follows the API layer, and that is deliberate: the two
// helper layers are ADVISORY — they enrich the answer, while the round trip is what
// decides whether the agent can reach GitHub at all. Asserted so a future change to
// that rule has to be a decision rather than a drift.
check(noDeps?.ok === true,
  'a working API round trip still reports the path as working when helpers are absent',
  `layers: ${bareLayers.map((l) => `${l.name}${l.ok ? '=ok' : '=FAIL'}`).join(', ')}`)

// ---------------------------------------------------------------------------
// 6. The second route: the git protocol.
//
// The fallback matters exactly when `gh` is unusable, which is the state a test can
// drive with a runner that answers only the git commands. The mechanism — matching a
// local head sha against `refs/pull/<n>/head` — is what lets the pill name a pull
// request with no token at all, so it is worth testing where it can actually fail: the
// sha matching, the highest-number tie-break, and the offline case.
// ---------------------------------------------------------------------------
{
  const { findPullByHeadSha, headSha, gitRouteStatus } = await import('../lib/routes.js')

  /** A runner whose only skill is ls-remote with a scripted answer. */
  const lsRemoteRunner = (stdout, ok = true) => ({
    runGit: async (argv) => ({
      ok, exitCode: ok ? 0 : 1, signal: '', timedOut: false, durationMs: 1,
      command: `git ${argv.join(' ')}`,
      stdout: argv[0] === 'ls-remote' ? stdout : (argv[0] === 'rev-parse' ? 'abc1234def\n' : 'git version 2.0.0\n'),
      stderr: ok ? '' : 'fatal: could not read from remote', truncated: false, spillPath: '',
    }),
  })

  const refs = [
    'abc1234def5678901234567890123456789012ab\trefs/pull/7/head',
    'abc1234def5678901234567890123456789012ab\trefs/pull/9/head',
    'ffffffffffffffffffffffffffffffffffffffff\trefs/pull/12/head',
    'not-a-sha\trefs/pull/13/head',
    '',
  ].join('\n')

  const found = await findPullByHeadSha(lsRemoteRunner(refs), process.cwd(), 'abc1234def5678901234567890123456789012ab')
  check(found === 9, 'the fallback finds the pull request whose head matches the local sha', String(found))
  // The "highest number wins" rule needs its OWN assertion. Both lines previously tested
  // `found === 9`, so the report's 28/28 was 27 distinct checks and the ordering rule named
  // in the comment was never tested. Found by an independent audit.
  //
  // The replacement uses an input where only the ORDER can give the right answer. `refs` is
  // raw `ls-remote` output (`<sha>\t<refname>` lines), and the list below is ASCENDING, so a
  // first-match implementation returns 3 while `Math.max` returns 9.
  const ascending = [
    'abc1234def5678901234567890123456789012ab\trefs/pull/3/head',
    'abc1234def5678901234567890123456789012ab\trefs/pull/7/head',
    'abc1234def5678901234567890123456789012ab\trefs/pull/9/head',
  ].join('\n')
  const ordered = await findPullByHeadSha(lsRemoteRunner(ascending), process.cwd(), 'abc1234def5678901234567890123456789012ab')
  check(ordered === 9, 'the highest number wins regardless of the order the refs arrive in',
    `ascending refs 3,7,9 gave ${ordered}, expected 9 — a first-match implementation would give 3`)

  const none = await findPullByHeadSha(lsRemoteRunner(refs), process.cwd(), '0000000000000000000000000000000000000000')
  check(none === null, 'an unmatched sha yields null rather than a guessed number', String(none))

  const offline = await findPullByHeadSha(lsRemoteRunner('', false), process.cwd(), 'abc1234def5678901234567890123456789012ab')
  check(offline === null, 'an unreachable remote yields null, not an exception', String(offline))

  const short = await findPullByHeadSha(lsRemoteRunner(refs), process.cwd(), 'abc')
  check(short === null, 'a too-short sha is refused: a prefix could match a different commit', String(short))

  const malformed = await findPullByHeadSha(lsRemoteRunner('garbage\nno refs here\n'), process.cwd(), 'abc1234def5678901234567890123456789012ab')
  check(malformed === null, 'unparseable ls-remote output is ignored, not crashed on', String(malformed))

  const head = await headSha(lsRemoteRunner(refs), process.cwd())
  check(head === 'abc1234def', 'the local head sha is read and validated as hex', head)

  // The route reports itself as unusable in a directory with no origin, which is the
  // state every non-git workspace is in — including the one this suite runs in.
  const status = await gitRouteStatus(lsRemoteRunner(''), process.cwd())
  check(typeof status.ok === 'boolean' && typeof status.detail === 'string',
    'gitRouteStatus always answers with a verdict and a reason', JSON.stringify(status))
}

const failed = results.filter((r) => !r.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  if (item.detail !== '') console.log(`      ${item.detail}`)
}
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  console.log('failed:')
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
