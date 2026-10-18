/**
 * Offline tests for the plugin entry point itself: activation, the credential
 * chain, the Device Flow guard, and the optional shell-git guard.
 *
 * These exercise `apply()` — the same function dsh calls — so a defect in the
 * wiring (a missing service, a bad export shape, a swallowed error) is caught
 * without a running Harness.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject, Config } from '../index.js'
import { makeContext } from './helpers.mjs'
import { normalizeConfig } from '../lib/config.js'
import { CREDENTIAL_SOURCES, resolveToken, runDeviceFlow, requestDeviceCode, pollForToken } from '../lib/auth.js'

/** Build a runner whose scripted answers describe a specific credential state. */
function authRunner({ ghAuthed = false, gitCredential = '' } = {}) {
  return {
    async run(argv) {
      const ok = (stdout) => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout, stderr: '', truncated: false, spillPath: '' })
      const fail = (stderr) => ({ ok: false, exitCode: 1, signal: '', timedOut: false, durationMs: 1, command: 'gh', stdout: '', stderr, truncated: false, spillPath: '' })
      if (argv[0] === 'auth' && argv[1] === 'token') return ghAuthed ? ok('gho_from_gh_cli\n') : fail('not logged in')
      if (argv[0] === 'api') return ok('tester\n')
      return ok('')
    },
    async runGit(argv) {
      const ok = (stdout) => ({ ok: true, exitCode: 0, signal: '', timedOut: false, durationMs: 1, command: 'git', stdout, stderr: '', truncated: false, spillPath: '' })
      if (argv[0] === 'credential') return gitCredential === '' ? ok('') : ok(`protocol=https\nhost=github.com\nusername=u\npassword=${gitCredential}\n`)
      return ok('')
    },
    async probe() {
      return { available: true, version: 'gh version 2.89.0' }
    },
  }
}

test('plugin: exports the documented shape and registers every tool', () => {
  assert.equal(name, 'github-toolkit')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  // The Config export is what makes Cordis validate the row at activation.
  assert.ok(Config !== undefined && typeof Config['~standard']?.validate === 'function',
    'the plugin must export a Standard Schema Config')

  const { ctx, tools } = makeContext()
  apply(ctx, {})
  assert.equal(tools.size, 9)
  for (const toolName of ['github_auth', 'github_repo', 'github_pr', 'github_issue', 'github_release', 'github_actions', 'github_search', 'github_api', 'github_update']) {
    assert.ok(tools.has(toolName), `${toolName} must be registered`)
  }
})

test('plugin: the dependency bag is fully wired, not just declared', async () => {
  // Every method on `deps` is a closure over `apply`'s locals, so a refactor that
  // moves one into a helper can leave it referring to a name that no longer exists
  // in scope. Nothing throws at activation, because the closures are only CALLED
  // later — `github_auth status` did exactly this during the R4 refactor and threw
  // `ReferenceError: credentialEnv is not defined`. This test calls each one.
  const { ctx, tools } = makeContext()
  apply(ctx, {})
  const auth = tools.get('github_auth')

  // `status` goes through deps.describeAuth, which reads the credential env.
  const status = await auth.execute({ action: 'status' }, { signal: undefined })
  assert.equal(typeof status.ok, 'boolean', `status must not throw: ${status.stderr}`)
  assert.ok(!/is not defined/.test(status.stderr), `status reported a scoping error: ${status.stderr}`)

  // `probe` goes through deps.resolveRepoForProbe and the layer ladder.
  const probe = await auth.execute({ action: 'probe' }, { signal: undefined })
  assert.equal(typeof probe.ok, 'boolean', `probe must not throw: ${probe.stderr}`)
  assert.ok(!/is not defined/.test(probe.stderr), `probe reported a scoping error: ${probe.stderr}`)

  // `login` goes through deps.deviceFlowLogin, which reads cfg.deviceFlowClientId.
  const login = await auth.execute({ action: 'login', confirm: true }, { signal: undefined })
  assert.equal(login.ok, false)
  assert.match(login.stderr, /client id/, `login must explain the missing client id, got: ${login.stderr}`)
})

test('plugin: activation survives an empty, absent, and hostile config', () => {
  for (const config of [undefined, null, {}, { timeoutMs: 'nonsense' }, { env: 'not-an-object' }, { maxOutputBytes: -1 }, []]) {
    const { ctx, tools } = makeContext()
    assert.doesNotThrow(() => apply(ctx, config), `config ${JSON.stringify(config)} must not throw`)
    assert.equal(tools.size, 9)
  }
})

test('plugin: allowRawApi false removes exactly the github_api tool', () => {
  const { ctx, tools } = makeContext()
  apply(ctx, { allowRawApi: false })
  assert.equal(tools.has('github_api'), false)
  assert.equal(tools.size, 8)
})

test('plugin: blockShellGit installs a guard, and the default does not', () => {
  const withGuard = makeContext()
  apply(withGuard.ctx, { blockShellGit: true })
  assert.equal(withGuard.guards.length, 1)

  const withoutGuard = makeContext()
  apply(withoutGuard.ctx, {})
  assert.equal(withoutGuard.guards.length, 0, 'the guard must be opt-in')
})

test('plugin: the shell-git guard denies mutations and allows reads', () => {
  const { ctx, guards } = makeContext()
  apply(ctx, { blockShellGit: true })
  const guard = guards[0]
  const exec = (command) => ({ name: 'pwsh', arguments: { command } })

  for (const denied of ['git commit -m x', 'git push origin main', 'git merge other', 'git reset --hard HEAD~1', 'git clean -fd', 'git push --force', 'git push -f', 'git push --delete origin x', 'cd repo && git commit -m x', 'echo hi; git push', '  git commit -m x']) {
    assert.equal(typeof guard(exec(denied)), 'string', `${denied} must be denied`)
  }
  for (const allowed of ['git status', 'git log --oneline', 'git diff', 'git add .', 'ls -la', 'echo git commit', "grep -r 'git commit' docs", 'gitk --all', 'npm run git-push-docs']) {
    assert.equal(guard(exec(allowed)), undefined, `${allowed} must be allowed`)
  }
  // A non-shell tool is never touched.
  assert.equal(guard({ name: 'github_repo', arguments: { action: 'view' } }), undefined)
  // A malformed argument object is ignored rather than throwing.
  assert.equal(guard({ name: 'pwsh', arguments: null }), undefined)
  assert.equal(guard({ name: 'pwsh', arguments: { command: 42 } }), undefined)
})

test('auth: the seam wins over every other layer', async () => {
  const credentials = { resolve: async () => ({ value: 'seam-token', source: 'store' }) }
  const { token, source } = await resolveToken({
    credentials,
    runner: authRunner({ ghAuthed: true, gitCredential: 'git-token' }),
    credentialRef: 'GITHUB_TOKEN',
    env: { GH_TOKEN: 'env-token' },
  })
  assert.equal(token, 'seam-token')
  assert.equal(source, CREDENTIAL_SOURCES.seam)
})

test('auth: the environment wins when the seam is unconfigured', async () => {
  const { token, source } = await resolveToken({
    credentials: { resolve: async () => undefined },
    runner: authRunner({ ghAuthed: true, gitCredential: 'git-token' }),
    credentialRef: 'GITHUB_TOKEN',
    env: { GH_TOKEN: 'env-token' },
  })
  assert.equal(token, 'env-token')
  assert.equal(source, CREDENTIAL_SOURCES.env)
})

test('auth: the gh CLI login is used when no seam or env value exists', async () => {
  const { token, source } = await resolveToken({
    runner: authRunner({ ghAuthed: true, gitCredential: 'git-token' }),
    credentialRef: 'GITHUB_TOKEN',
    env: {},
  })
  assert.equal(token, 'gho_from_gh_cli')
  assert.equal(source, CREDENTIAL_SOURCES.gh)
})

test('auth: the git credential helper is the last resort', async () => {
  const { token, source } = await resolveToken({
    runner: authRunner({ ghAuthed: false, gitCredential: 'git-helper-token' }),
    credentialRef: 'GITHUB_TOKEN',
    env: {},
  })
  assert.equal(token, 'git-helper-token')
  assert.equal(source, CREDENTIAL_SOURCES.gitCredential)
})

test('auth: nothing configured resolves to an empty token rather than throwing', async () => {
  const { token, source } = await resolveToken({
    runner: authRunner({ ghAuthed: false, gitCredential: '' }),
    credentialRef: 'GITHUB_TOKEN',
    env: {},
  })
  assert.equal(token, '')
  assert.equal(source, CREDENTIAL_SOURCES.none)
})

test('auth: a throwing credentials seam degrades to the next layer instead of failing', async () => {
  const { token, source } = await resolveToken({
    credentials: { resolve: async () => { throw new Error('seam exploded') } },
    runner: authRunner({ ghAuthed: true }),
    credentialRef: 'GITHUB_TOKEN',
    env: {},
  })
  assert.equal(token, 'gho_from_gh_cli')
  assert.equal(source, CREDENTIAL_SOURCES.gh)
})

test('device flow: a missing client id is explained, not silently attempted', async () => {
  const { ctx, tools } = makeContext()
  let fetched = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { fetched += 1; throw new Error('network must not be touched') }
  try {
    apply(ctx, { deviceFlowClientId: '' })
    // `login` is destructive since R3 — it writes the credentials store — so the
    // gate is answered first, exactly as a real caller would.
    const result = await tools.get('github_auth').execute({ action: 'login', confirm: true }, { signal: undefined })
    assert.equal(result.ok, false)
    assert.match(result.stderr, /client id/)
    assert.match(result.stderr, /settings\/applications\/new/)
    assert.match(result.stderr, /someone else's application/)
    assert.equal(fetched, 0, 'no request may be made without a client id')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('device flow: the polling state machine follows the server pacing', async () => {
  /** @type {string[]} */
  const paths = []
  const responses = [
    { device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 },
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { access_token: 'gho_device' },
  ]
  let index = 0
  const fetchImpl = async (url) => {
    paths.push(new URL(url).pathname)
    return new Response(JSON.stringify(responses[index++]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const updates = []
  const result = await runDeviceFlow({
    fetch: fetchImpl,
    authBaseURL: 'https://github.com',
    clientId: 'cid',
    scope: 'repo',
    onUpdate: (update) => updates.push(update),
  })
  assert.equal(result.token, 'gho_device')
  assert.equal(result.userCode, 'ABCD-1234')
  assert.deepEqual(paths, ['/login/device/code', '/login/oauth/access_token', '/login/oauth/access_token', '/login/oauth/access_token'])
  assert.deepEqual(updates.map((u) => u.phase), ['awaiting-authorization', 'slow-down', 'authorized'])
})

test('device flow: a denial and an expiry are terminal with distinct messages', async () => {
  // pollForToken does NOT request a device code; its first fetch is already the
  // token poll. The interval is 1s, so each case costs one second.
  const tokenResponse = (body) => async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  await assert.rejects(
    () => pollForToken(
      { fetch: tokenResponse({ error: 'access_denied' }), authBaseURL: 'https://github.com', clientId: 'c', scope: 'repo' },
      'd', 1, 900,
    ),
    /denied/,
  )
  await assert.rejects(
    () => pollForToken(
      { fetch: tokenResponse({ error: 'expired_token' }), authBaseURL: 'https://github.com', clientId: 'c', scope: 'repo' },
      'd', 1, 900,
    ),
    /expired/,
  )
})

test('device flow: a non-2xx device code response is a clean error', async () => {
  await assert.rejects(
    () => requestDeviceCode({
      fetch: async () => new Response('nope', { status: 500 }),
      authBaseURL: 'https://github.com',
      clientId: 'c',
      scope: 'repo',
    }),
    /HTTP 500/,
  )
})

test('plugin: the credential source is reported without the token value', () => {
  const { ctx, logs } = makeContext()
  apply(ctx, {})
  // The probe and describeAuth calls are async; the assertion here is that no
  // log line can contain a token-shaped string, checked after a tick.
  return new Promise((resolve) => {
    setTimeout(() => {
      for (const line of logs) {
        assert.doesNotMatch(line, /gho_[A-Za-z0-9]{20,}/, `a token leaked into a log line: ${line}`)
      }
      resolve()
    }, 400)
  })
})

test('plugin: the config defaults are the ones the patch layer documents', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.timeoutMs, 60_000)
  assert.equal(cfg.watchTimeoutMs, 300_000)
  assert.equal(cfg.maxOutputBytes, 65_536)
  assert.equal(cfg.killGraceMs, 2_000)
  assert.equal(cfg.apiBaseURL, 'https://api.github.com')
  assert.equal(cfg.authBaseURL, 'https://github.com')
  assert.equal(cfg.deviceFlowScope, 'repo')
})

test('plugin: apply() accepts the shape Cordis produces from the Config schema', () => {
  // Cordis validates the row against the exported Config and passes the
  // RESULT (defaults filled) to apply. This runs that exact pipeline so a
  // mismatch between the schema's output and normalizeConfig's input is caught.
  const validated = Config['~standard'].validate({})
  assert.equal(validated.issues, undefined, JSON.stringify(validated.issues))
  const { ctx, tools } = makeContext()
  assert.doesNotThrow(() => apply(ctx, validated.value))
  assert.equal(tools.size, 9)
  assert.equal(normalizeConfig(validated.value).timeoutMs, 60_000)
})
