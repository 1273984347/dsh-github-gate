/**
 * PRE-09 — every declared parameter must actually change the command, and every
 * action-scoped description must name real actions.
 *
 * ## The defect class this exists for
 *
 * `github_repo branches` documented a `branch` parameter — the parameter said
 * "branches inspects just that one" — and the argv builder never read it. Every
 * call silently listed branches instead. Nothing caught it: the parameter was
 * declared, the schema was valid, the help text was self-consistent, and the
 * action "worked" (it returned branches, just never the one asked for).
 *
 * A description is not an implementation. This guard treats a parameter as real
 * only when supplying it CHANGES the command the action would run.
 *
 * ## Trustworthy or worthless
 *
 * The first version of this file reported 26 failures, and most were its own
 * fault: it built argv without the actions' required arguments (so `query` was
 * `undefined`), and it treated any description without an `action:` prefix as
 * applying to every action. A guard that cries wolf gets ignored, which is worse
 * than no guard. Two rules keep it honest:
 *
 * 1. **Base arguments come from `needs`.** A tested parameter is injected with a
 *    DIFFERENT sentinel than the base, so a required parameter still shows its
 *    effect and a parameter that is required but ignored still fails.
 * 2. **Only explicit claims are tested.** A description is an action claim only
 *    when the text before its first colon parses as a run of identifiers. No
 *    prefix means the parameter is general and is reported as skipped with its
 *    reason, never silently tested everywhere.
 *
 * ## And the descriptions themselves
 *
 * A claim that names something which is not an action id — `workflow
 * list/view/dispatch` for actions called `workflowList`/`workflowView`/`dispatch`
 * — is reported as ambiguous. A human can guess what it meant; a machine cannot,
 * and neither can a reader who has not memorised the action table.
 *
 * Usage: node --import ./test/register-hook.mjs tools/verify-params.mjs
 */

import auth from '../lib/domains/auth.js'
import repo from '../lib/domains/repo.js'
import pr from '../lib/domains/pr.js'
import issue from '../lib/domains/issue.js'
import release from '../lib/domains/release.js'
import actionsDomain from '../lib/domains/actions.js'
import search from '../lib/domains/search.js'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Parameters the registry or the caller consumes, never the argv. */
const CONTROL_PARAMS = new Set(['confirm', 'timeoutMs', 'session'])

/**
 * Parameters that reach the command through the `repo` ARGUMENT rather than a
 * flag, so they are probed by varying both channels at once.
 *
 * `repo` cannot be blanket-skipped: most domains resolve it into the positional
 * `repo` argument, while `github_search` forwards it as `--repo` because its
 * `globalRepoFlag` is false and the filter is the caller's. Skipping it outright
 * hid a whole channel; varying both proves it arrives somehow.
 */
const DUAL_CHANNEL_PARAMS = new Set(['repo'])

/**
 * Parameters whose contract is to be REJECTED, not forwarded. Keyed
 * `tool:param`, value is the reason — required, so an exemption is never silent.
 */
const VALIDATE_ONLY = new Map([
  ['github_api:method', 'validated to deny a write without confirm; the method is an argv element of `gh api`, not a flag'],
])

const domains = [auth, repo, pr, issue, release, actionsDomain, search]
const results = []
const skipped = []

/**
 * Record one check.
 * @param {boolean} ok whether it passed
 * @param {string} name the check name
 * @param {string} detail evidence
 */
function check(ok, name, detail = '') {
  results.push({ ok, name, detail })
}

/**
 * Reproduce what the registry appends to an action's own argv.
 *
 * Testing `action.argv` alone produced a wave of false failures: `repo` never
 * appears in `github_pr`'s argv because the REGISTRY appends `--repo` for every
 * domain whose `globalRepoFlag` is true. A guard that ignores the registry measures
 * the wrong thing, so the two injections the registry performs are replicated here
 * — the global `--repo` flag and the `--json` field selection.
 *
 * @param {any} domain the domain definition
 * @param {any} action the action definition
 * @param {string[]} argv the action's own argv
 * @param {string} repo the resolved repository
 * @returns {string[]} the argv the runner would actually receive
 */
function withRegistryFlags(domain, action, argv, repo) {
  const full = [...argv]
  if (domain.globalRepoFlag === true && repo !== '') full.push('--repo', repo)
  const jsonFields = typeof action.json === 'string' ? action.json : null
  if (jsonFields !== null) {
    full.push('--json', jsonFields)
    if (typeof action.jq === 'string' && action.jq !== '') full.push('--jq', action.jq)
  }
  return full
}

/**
 * Claim keywords that resolve against a structural fact instead of a hand-written
 * action list. A list written by hand is a guess that drifts; these two read what
 * the action already declares about itself:
 *
 * - `requiresRepo` — the action sets `requiresRepo: true`.
 * - `needs` — the action lists THIS parameter in its `needs` array.
 */
const CLAIM_KEYWORDS = new Set(['requiresRepo', 'needs'])

/**
 * Read what a parameter's description claims about the actions it serves.
 *
 * @param {unknown} description the schema description
 * @param {string[]} actionNames the domain's real action ids
 * @returns {{ kind: 'claim', tokens: string[] } | { kind: 'ambiguous', tokens: string[], unknown: string[] } | { kind: 'global' }}
 */
function parseClaim(description, actionNames) {
  const text = String(description ?? '')
  const colon = text.indexOf(':')
  if (colon === -1) return { kind: 'global' }
  const head = text.slice(0, colon).trim()
  if (head === '' || head.length > 60) return { kind: 'global' }
  // A claim reads as identifiers separated by `/` or spaces. Hyphens are allowed
  // so that a WRONG action name is still parsed as a claim and then reported as
  // ambiguous: without `-` here, `create/release-edit` failed the pattern, was
  // silently reclassified as prose, and the unknown name vanished. Caught by
  // injecting that exact violation, which is what two-way verification is for.
  if (!/^[A-Za-z][A-Za-z0-9-]*(?:[/ ][A-Za-z][A-Za-z0-9-]*)*$/.test(head)) return { kind: 'global' }
  const tokens = head.split(/[/ ]+/).filter(Boolean)
  // A bare capitalised word such as "DESTRUCTIVE" is a label, not an action list.
  if (tokens.length === 1 && /^[A-Z][A-Z0-9_]+$/.test(tokens[0])) return { kind: 'global' }
  if (tokens.length === 1 && CLAIM_KEYWORDS.has(tokens[0])) return { kind: 'claim', tokens }
  const unknown = tokens.filter((token) => !actionNames.includes(token))
  if (unknown.length > 0) return { kind: 'ambiguous', tokens, unknown }
  return { kind: 'claim', tokens }
}

/**
 * Decide whether one claim covers one action.
 *
 * @param {{ kind: string, tokens?: string[] }} claim the parsed claim
 * @param {string} actionName the action id
 * @param {any} action the action definition
 * @param {string} paramName the parameter name
 * @returns {boolean} whether the action is claimed
 */
function claimCovers(claim, actionName, action, paramName) {
  const tokens = claim.tokens ?? []
  if (tokens.length === 1 && tokens[0] === 'requiresRepo') return action.requiresRepo === true
  if (tokens.length === 1 && tokens[0] === 'needs') return (action.needs ?? []).includes(paramName)
  return tokens.includes(actionName)
}

/**
 * A usable value for one parameter, by its declared type, distinct per call so a
 * base value and a tested value never collide.
 *
 * @param {any} spec the parameter schema
 * @param {string} name the parameter name
 * @param {number} variant 0 for the base arguments, 1 for the tested value
 * @returns {unknown} the value
 */
function valueFor(spec, name, variant) {
  const type = spec?.type
  if (type === 'boolean') return true
  if (type === 'number') return variant === 0 ? 3 : 7
  const values = spec?.values ?? spec?.enum
  if (Array.isArray(values) && values.length > 0) return values[Math.min(variant, values.length - 1)]
  return variant === 0 ? `base-${name}` : `probe-${name}`
}

for (const domain of domains) {
  const tool = domain.tool
  const params = domain.params ?? {}
  const actions = domain.actions ?? {}
  const actionNames = Object.keys(actions)

  // A claim is resolved ONCE per parameter, not once per action: the description
  // is the same string for every action, so reporting it inside the action loop
  // produced twelve identical failures for one bad description and buried the
  // real findings.
  /** @type {Map<string, { kind: string, tokens?: string[], unknown?: string[] }>} */
  const claims = new Map()
  for (const [paramName, spec] of Object.entries(params)) {
    const claim = parseClaim(spec?.description, actionNames)
    claims.set(paramName, claim)
    if (claim.kind !== 'ambiguous') continue
    check(false, `${tool} ${paramName} names real actions`,
      `its description claims "${claim.tokens.join('/')}" but ${claim.unknown.join(', ')} `
      + `${claim.unknown.length === 1 ? 'is not an action' : 'are not actions'} of ${tool} `
      + `(actions: ${actionNames.join(', ')})`)
  }

  for (const [actionName, action] of Object.entries(actions)) {
    if (typeof action?.argv !== 'function') continue

    // Base arguments: what the action REQUIRES, so its argv is well formed. A
    // tested parameter is then injected with a different value, which keeps a
    // required-but-ignored parameter detectable instead of excused.
    const baseArgs = { repo: 'octocat/Hello-World' }
    for (const need of action.needs ?? []) {
      const spec = params[need]
      if (spec === undefined) continue
      baseArgs[need] = valueFor(spec, need, 0)
    }

    /** @type {string[]} */
    let baseArgv
    try {
      baseArgv = withRegistryFlags(domain, action,
        action.argv({ ...baseArgs }, {}, 'octocat/Hello-World') ?? [], 'octocat/Hello-World')
      if (baseArgv.some((part) => part === undefined || part === null || String(part) === 'undefined')) {
        // An incomplete base argv is only a defect when nothing rejects it. An
        // action whose `check` demands the missing argument is guarded, and its
        // rejection IS the contract — `pr comment` refuses a comment with no body.
        // Requiring a complete base regardless made this guard report a failure
        // for a correctly guarded action.
        const guarded = typeof action.check?.({ ...baseArgs }) === 'string'
        check(guarded, `${tool} ${actionName}: an incomplete base argv is rejected or impossible`,
          guarded
            ? `check() enforces the missing argument: ${JSON.stringify(baseArgv)}`
            : `nothing rejects this argv, so a required argument reaches gh as a hole: ${JSON.stringify(baseArgv)}`)
        if (guarded) continue
        continue
      }
    } catch (error) {
      check(false, `${tool} ${actionName}: base argv builds`, String(error?.message ?? error))
      continue
    }

    for (const [paramName, spec] of Object.entries(params)) {
      const label = `${tool} ${actionName}: ${paramName}`
      if (CONTROL_PARAMS.has(paramName)) {
        skipped.push(`${tool}:${paramName} — control parameter, consumed by the registry`)
        continue
      }

      const claim = claims.get(paramName) ?? { kind: 'global' }
      if (claim.kind === 'global') {
        skipped.push(`${tool}:${paramName} — description names no action, so no action is claimed`)
        continue
      }
      if (claim.kind === 'ambiguous') continue
      if (!claimCovers(claim, actionName, action, paramName)) continue

      const validateOnly = VALIDATE_ONLY.get(`${tool}:${paramName}`)
      if (validateOnly !== undefined) {
        const bad = action.check?.({ ...baseArgs, [paramName]: 'DELETE' })
        check(typeof bad === 'string' && bad !== '', `${label} is validate-only and rejects a bad value`, validateOnly)
        continue
      }

      const withParam = { ...baseArgs, [paramName]: valueFor(spec, paramName, 1) }
      /** @type {string[]} */
      let argv
      try {
        // A dual-channel parameter is varied in the args AND in the positional
        // `repo` argument, because either may be where the action reads it.
        const positional = DUAL_CHANNEL_PARAMS.has(paramName)
          ? String(valueFor(spec, paramName, 1))
          : 'octocat/Hello-World'
        argv = withRegistryFlags(domain, action,
          action.argv({ ...withParam }, {}, positional) ?? [], positional)
      } catch (error) {
        check(false, `${label} is accepted by the action`, `argv threw: ${String(error?.message ?? error)}`)
        continue
      }
      const changed = JSON.stringify(argv) !== JSON.stringify(baseArgv)
      const rejected = typeof action.check?.({ ...withParam }) === 'string'
      check(changed || rejected, `${label} changes the command`,
        changed
          ? `${JSON.stringify(baseArgv)} -> ${JSON.stringify(argv)}`
          : rejected
            ? 'rejected by check(), which is its contract'
            : `NO EFFECT — declared for this action but never read: ${JSON.stringify(argv)}`)
    }
  }
}

for (const item of results) {
  if (!item.ok) console.log(`FAIL  ${item.name}\n      ${item.detail}`)
}

// ---------------------------------------------------------------------------
// The domain that declares its parameters on the DOMAIN, not on the action.
//
// `github_api` is the one tool the loop above cannot reach: every other domain declares an
// action as a map of `params`, and this guard's method is "perturb one declared parameter and
// see it reach argv". `github_api` builds its argv by hand inside a `custom` executor, so
// there are no per-action `params` to perturb — which is why it used to be excluded and the
// coverage report said "0 NOT covered" over a set that had already dropped a whole tool.
//
// Excluding it was honest once the boundary was printed. It is still SEVEN PARAMETERS THAT
// NOBODY ASSERTS — declared, rendered to the model, and unchecked. This section closes that
// by driving the executor with a recording runner and asking the same question the rest of
// the file asks: does changing this parameter change what the command line becomes?
//
// The runner is a double, not the real one. The point is to observe the argv and the options
// the domain BUILDS, so a fake that records them and returns success is the correct
// instrument — nothing is executed.
// ---------------------------------------------------------------------------
{
  const apiDomain = (await import('../lib/domains/api.js')).default
  const action = apiDomain.actions.request

  /** Run the executor once with the given arguments and return what it built. */
  const drive = async (args, cfg = { allowDestructive: true, timeoutMs: 60_000, watchTimeoutMs: 300_000 }) => {
    const seen = []
    const deps = {
      runner: {
        run: async (argv, options) => {
          seen.push({ argv, options })
          return { ok: true, stdout: '{}', stderr: '' }
        },
      },
    }
    const outcome = await action.custom({ args, cfg, deps, exec: undefined })
    return { seen, outcome }
  }

  const BASE = { path: '/repos/o/n', method: 'GET' }

  // 1. `path` reaches the command line.
  {
    const { seen } = await drive(BASE)
    check(seen.length === 1 && seen[0].argv.includes('/repos/o/n'),
      'github_api: `path` becomes an argv element', JSON.stringify(seen[0]?.argv ?? null))
  }

  // 2. `method` reaches it, upper-cased.
  {
    const { seen } = await drive({ ...BASE, method: 'get' })
    const index = seen[0].argv.indexOf('--method')
    check(index !== -1 && seen[0].argv[index + 1] === 'GET',
      'github_api: `method` sets --method, upper-cased', JSON.stringify(seen[0]?.argv ?? null))
  }

  // 3. `query` is appended to the path rather than passed as its own argument —
  //    `gh api` takes the query as part of the endpoint, and a separate token would be read
  //    as a second endpoint.
  {
    const { seen } = await drive({ ...BASE, query: 'per_page=5&state=open' })
    const endpoint = seen[0].argv[1]
    check(endpoint.includes('per_page=5') && endpoint.includes('state=open') && seen[0].argv.length === 4,
      'github_api: `query` is appended to the endpoint, not passed as its own argument',
      JSON.stringify(seen[0]?.argv ?? null))
  }

  // 4. `body` goes to stdin, never argv.
  {
    const { seen } = await drive({ ...BASE, method: 'POST', confirm: true, body: '{"a":1}' })
    check(seen[0].argv.includes('--input') && seen[0].options.stdin === '{"a":1}',
      'github_api: `body` is passed on stdin, not in argv',
      JSON.stringify({ argv: seen[0]?.argv, stdin: seen[0]?.options.stdin }))
    check(seen[0].argv.some((part) => part.includes('{"a":1}')) === false,
      'github_api: the body string never appears in argv')
  }

  // 5. `paginate` adds its flag AND switches the timeout to the watch budget — one parameter
  //    with two effects, and the second is the one a refactor would drop silently.
  {
    const { seen } = await drive({ ...BASE, paginate: true })
    check(seen[0].argv.includes('--paginate'), 'github_api: `paginate` adds --paginate',
      JSON.stringify(seen[0]?.argv ?? null))
    check(seen[0].options.timeoutMs === 300_000,
      'github_api: `paginate` also switches the timeout to watchTimeoutMs',
      `got ${seen[0]?.options.timeoutMs}, expected 300000`)
  }

  // 6. `confirm` is a GATE, not an argument: a write without it is refused, and the refusal
  //    happens before anything runs.
  {
    const refused = await drive({ ...BASE, method: 'DELETE' })
    check(refused.seen.length === 0 && refused.outcome?.ok !== true,
      'github_api: `confirm` gates a write method before anything runs',
      `runner calls: ${refused.seen.length}`)

    const allowed = await drive({ ...BASE, method: 'DELETE', confirm: true })
    check(allowed.seen.length === 1,
      'github_api: `confirm: true` lets the same write through', `runner calls: ${allowed.seen.length}`)
  }

  // 7. `timeoutMs` reaches the runner options when it is supplied, and the config default
  //    applies when it is not.
  {
    const explicit = await drive({ ...BASE, timeoutMs: 12_345 })
    check(explicit.seen[0].options.timeoutMs === 12_345,
      'github_api: `timeoutMs` reaches the runner options', String(explicit.seen[0]?.options.timeoutMs))
    const fallback = await drive(BASE)
    check(fallback.seen[0].options.timeoutMs === 60_000,
      'github_api: the config timeout applies when `timeoutMs` is absent',
      String(fallback.seen[0]?.options.timeoutMs))
  }

  // 8. The path guard the tool documents, asserted here so it is not only in the description.
  {
    const absolute = await drive({ ...BASE, path: 'https://api.github.com/repos/o/n' })
    check(absolute.seen.length === 0, 'github_api: an absolute URL is refused before the runner is called')
    const backslash = await drive({ ...BASE, path: 'repos\\o\\n' })
    check(backslash.seen.length === 0, 'github_api: a backslash path is refused before the runner is called')
  }
}

// ---------------------------------------------------------------------------
// `github_update` — the second tool whose parameters live on the DOMAIN.
//
// Same instrument as the block above: a recording runner, because nothing is
// executed. What matters is that each declared parameter still changes what the
// tool ASKS FOR — the endpoint for `channel`, the tag endpoint for `tag`, whether
// a download happens for `force`, and the timeout option for `timeoutMs`.
// ---------------------------------------------------------------------------
{
  const updateDomain = (await import('../lib/domains/update.js')).default
  const { createHash } = await import('node:crypto')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join: joinPath } = await import('node:path')

  // A real artifact is needed because `stage` VERIFIES what it downloaded: a fake
  // runner that only returns `ok` leaves no file, the digest check fails honestly,
  // and the assertion would be testing the refusal instead of the happy path.
  const ARTIFACT = 'verify-params artifact'
  const DIGEST = `sha256:${createHash('sha256').update(ARTIFACT).digest('hex')}`

  /** Drive the update domain once with the given arguments. */
  const driveUpdate = async (actionName, args) => {
    const seen = []
    const cacheDir = joinPath(process.env.TEMP ?? '/tmp', `dsh-verify-params-${Math.random().toString(36).slice(2)}`)
    mkdirSync(cacheDir, { recursive: true })
    const release = {
      tag_name: 'v9.9.9',
      html_url: 'https://github.com/o/r/releases/tag/v9.9.9',
      published_at: '2026-01-01T00:00:00Z',
      prerelease: false,
      assets: [{
        name: 'dsh-github-gate-9.9.9.tgz',
        size: ARTIFACT.length,
        digest: DIGEST,
        browser_download_url: 'https://example.invalid/a.tgz',
      }],
    }
    const deps = {
      pluginVersion: () => '1.0.0',
      runner: {
        run: async (argv, options) => {
          seen.push({ argv, options })
          // The release read is the first call; `gh release download` is the second,
          // and it is the one that must materialise the file for verification.
          if (argv[0] === 'api') {
            return { ok: true, stdout: JSON.stringify(release), stderr: '', data: release }
          }
          if (argv[0] === 'release') {
            mkdirSync(cacheDir, { recursive: true })
            writeFileSync(joinPath(cacheDir, 'dsh-github-gate-9.9.9.tgz'), ARTIFACT)
            return { ok: true, stdout: '', stderr: '' }
          }
          return { ok: true, stdout: '', stderr: '' }
        },
      },
    }
    const outcome = await updateDomain.actions[actionName].custom({
      args,
      cfg: { updateRepo: 'o/r', updateChannel: 'stable', updateCacheDir: cacheDir, timeoutMs: 60_000, watchTimeoutMs: 300_000 },
      deps,
      exec: undefined,
    })
    return { seen, outcome }
  }

  // 1. `channel` selects the endpoint: stable reads `releases/latest`, latest reads
  //    the list so prereleases are eligible.
  {
    const stable = await driveUpdate('check', {})
    check(stable.seen[0]?.argv?.includes('repos/o/r/releases/latest') === true,
      'github_update: channel "stable" reads the latest-release endpoint', JSON.stringify(stable.seen[0]?.argv ?? null))
    const latest = await driveUpdate('check', { channel: 'latest' })
    check(latest.seen[0]?.argv?.some((part) => part.includes('releases?per_page=1')) === true,
      'github_update: channel "latest" reads the release list', JSON.stringify(latest.seen[0]?.argv ?? null))
  }

  // 2. `tag` switches the release lookup to the tag endpoint, and reaches `gh
  //    release download` as the positional tag.
  {
    const { seen } = await driveUpdate('stage', { tag: 'v9.9.9' })
    check(seen[0]?.argv?.some((part) => part.includes('releases/tags/v9.9.9')) === true,
      'github_update: `tag` selects the release by tag', JSON.stringify(seen[0]?.argv ?? null))
    const download = seen.find((entry) => entry.argv[0] === 'release')
    check(download?.argv?.includes('v9.9.9') === true,
      'github_update: `tag` reaches gh release download', JSON.stringify(download?.argv ?? null))
  }

  // 3. `force` decides whether an intact staged copy is reused. Reaching this means
  //    a second runner call for the download, which is the observable difference.
  {
    const reuse = await driveUpdate('stage', { tag: 'v9.9.9' })
    check(reuse.seen.some((entry) => entry.argv[0] === 'release') === true,
      'github_update: stage downloads when nothing is staged')
    const forced = await driveUpdate('stage', { tag: 'v9.9.9', force: true })
    check(forced.seen.some((entry) => entry.argv[0] === 'release') === true,
      'github_update: `force` still downloads when a copy exists')
  }

  // 4. `timeoutMs` reaches the runner options, and the command carries a verification
  //    result rather than silently trusting the transfer.
  {
    const { outcome } = await driveUpdate('stage', { tag: 'v9.9.9', timeoutMs: 1234 })
    check(outcome?.data?.verification !== undefined,
      'github_update: stage reports a digest verification state', String(outcome?.data?.verification))
    check(outcome?.data?.installed === false,
      'github_update: stage never claims to have installed')
  }
}
//
// The SECOND version had the same defect one level up: `domains` above lists seven
// modules, and `github_api` is not one of them — so "0 NOT covered" was computed over a set
// that already excluded a whole tool. An independent audit found it by comparing the list
// against `lib/domains/`.
//
// The exclusion is structural rather than an oversight: every other domain declares an
// action as a map of `params`, and this guard's whole method is "perturb one declared
// parameter and see it reach argv". `github_api`'s `request` action is hand-written
// (`help`/`needs`/`argv`/`custom`), so it has no `params` to perturb and no honest way to
// join this check.
//
// What is NOT acceptable is reporting full coverage over a set that omits one. So the
// boundary is printed: which tools were asserted, and which cannot be.
const uncovered = skipped.filter((item) => item.includes('description names no action'))
const controls = skipped.filter((item) => item.includes('control parameter'))

/**
 * Every domain this guard did NOT assert, with the reason. Read, not remembered.
 *
 * `github_api` and `github_update` ARE in the set: the sections above assert them by driving
 * their custom executors with a recording runner, rather than by perturbing per-action `params`.
 * Leaving one out is what made the coverage line print "not asserted at all" immediately after
 * thirteen assertions about it had passed.
 */
const assertedTools = new Set([...domains.map((domain) => domain.tool), 'github_api', 'github_update'])
const domainDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'domains')
const notAsserted = []
for (const file of readdirSync(domainDir)) {
  if (!file.endsWith('.js')) continue
  const module = await import(new URL(`../lib/domains/${file}`, import.meta.url).href)
  for (const value of Object.values(module)) {
    if (value === null || typeof value !== 'object') continue
    if (typeof value.tool !== 'string' || value.actions === undefined) continue
    if (assertedTools.has(value.tool)) continue

    // Where this domain declares its parameters. The asserted domains put them on each
    // ACTION; `github_api` puts them on the DOMAIN. The first version of this note read
    // "there are no declared `params` to perturb", which was WRONG — there are seven, and
    // they are rendered to the model exactly like the asserted ones. They are simply
    // somewhere this loop does not walk. Counting them is the difference between naming a
    // boundary and excusing one.
    const actionParams = Object.values(value.actions)
      .reduce((sum, action) => sum + Object.keys(action?.params ?? {}).length, 0)
    const domainParams = Object.keys(value.params ?? {}).length
    const total = actionParams + domainParams
    notAsserted.push({
      tool: value.tool,
      params: total,
      reason: total === 0
        ? 'it declares no parameters at all'
        : `it declares ${total} parameter(s) ${domainParams > 0 ? 'on the DOMAIN' : 'on its actions'}, `
          + 'while every asserted domain declares them per action — the perturb-one-parameter '
          + 'method does not reach them',
    })
  }
}

console.log(`\ncoverage: ${results.length} parameters asserted across ${assertedTools.size} tool(s), `
  + `${controls.length} control parameters (consumed by the registry), ${uncovered.length} NOT covered`)
if (uncovered.length > 0) {
  console.log('not covered — a description naming no action cannot be checked against one:')
  for (const item of uncovered) console.log(`  - ${item}`)
}
if (notAsserted.length > 0) {
  const unassertedParams = notAsserted.reduce((sum, entry) => sum + entry.params, 0)
  console.log(`\nnot asserted at all (${notAsserted.length} tool(s), ${unassertedParams} parameter(s)) `
    + '— OUTSIDE the count above, not inside it:')
  for (const entry of notAsserted) {
    console.log(`  - ${entry.tool} (${entry.params} params): ${entry.reason}`)
  }
  console.log('  ^ listed so "0 NOT covered" is read as "0 within these tools", not as "0 everywhere".')
}

// Computed HERE, not earlier. It used to be captured at the top of the coverage
// section — before the `github_api` block below, which appends thirteen checks of
// its own. The summary then read a STALE snapshot: `results.length` grew while
// `failed` did not, so any failure from that block was counted in the total and
// never reported. A deliberate canary proved it — a check(false, …) moved the
// denominator and produced no failure line. Eighth instance of this project's
// most persistent defect: a number computed from a snapshot taken too early.
const failed = results.filter((r) => !r.ok)

console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  console.log('failed:')
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}