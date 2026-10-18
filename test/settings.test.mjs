/**
 * Tests for the Settings → Plugins → GitHub routes.
 *
 * These routes write a credential, so the tests cover the same three things a
 * reviewer would check:
 *
 *   1. **They fail CLOSED.** No `connection` service, or a rejection, or a throwing
 *      rejection, must never reach the handler. A credential-writing route that
 *      admits an unjudged caller is the worst defect this file could have.
 *   2. **They never return the token.** Not in the status body, not in an error.
 *   3. **They do the real thing.** Saving calls the credentials seam's `set`;
 *      testing makes a real `gh api user` call through the runner.
 *
 * The requests are driven against the real handler with fake `req`/`res` objects,
 * so the code under test is the registered handler, not a reimplementation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installSettingsRoutes, STATUS_ROUTE, TOKEN_ROUTE, TEST_ROUTE } from '../lib/settings-routes.js'

/**
 * A minimal request/response pair.
 * @param {object} [init] the request shape
 * @returns {{ req: any, res: any, read: () => { status: number, headers: Record<string,string>, body: any, text: string } }}
 */
function makeExchange(init = {}) {
  const body = init.body === undefined ? '' : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  const chunks = body === '' ? [] : [Buffer.from(body)]
  const req = {
    method: init.method ?? 'GET',
    url: init.url ?? '/',
    headers: init.headers ?? { host: '127.0.0.1:9514' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const state = { status: 0, headers: {}, text: '' }
  const res = {
    get statusCode() { return state.status },
    set statusCode(value) { state.status = value },
    setHeader(name, value) { state.headers[name.toLowerCase()] = value },
    end(text) { state.text += text === undefined ? '' : String(text) },
  }
  return {
    req,
    res,
    read() {
      let parsed
      try {
        parsed = JSON.parse(state.text)
      } catch {
        parsed = undefined
      }
      return { status: state.status, headers: state.headers, body: parsed, text: state.text }
    },
  }
}

/** Install the routes into a fake context and return what was registered. */
function register({ connection, credentials, runner, describeAuth } = {}) {
  const routes = new Map()
  /** Whether each path was registered while an effect body was running. */
  const registeredInEffect = new Map()
  const effects = []
  let inEffect = false
  const services = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        registeredInEffect.set(route.path, inEffect)
        return () => {}
      },
    },
  }
  if (connection !== undefined) services.connection = connection
  const ctx = {
    get: (name) => services[name],
    effect: (body) => {
      inEffect = true
      let disposer
      try {
        disposer = body()
      } finally {
        inEffect = false
      }
      effects.push(disposer)
      return () => {}
    },
    // `installWhenAvailable` requires `on` to observe a service that arrives later.
    // Without it the installer warns and skips — which is why the first version of
    // this test saw zero routes and looked like a registration bug.
    on: () => () => {},
    logger: { info() {}, warn() {} },
  }
  const installed = installSettingsRoutes(ctx, {
    runner: runner ?? { async run() { return { ok: true, stdout: '', stderr: '' } } },
    logger: ctx.logger,
    credentials,
    credentialRef: 'GITHUB_TOKEN',
    timeoutMs: 5_000,
    version: '9.9.9',
    describeAuth: describeAuth ?? (async () => ({ source: 'none', authenticated: false })),
  })
  return { routes, installed, effects, registeredInEffect }
}

// ---------------------------------------------------------------------------
// Admission: fail closed
// ---------------------------------------------------------------------------

test('settings: every route refuses when no connection service can judge the caller', async () => {
  const { routes } = register()
  for (const path of [STATUS_ROUTE, TOKEN_ROUTE, TEST_ROUTE]) {
    const handler = routes.get(path)
    assert.ok(typeof handler === 'function', `${path} must be registered`)
    const exchange = makeExchange({ method: path === TOKEN_ROUTE || path === TEST_ROUTE ? 'POST' : 'GET', body: { token: 'x' } })
    await handler(exchange.req, exchange.res)
    assert.equal(exchange.read().status, 403, `${path} must fail closed`)
    assert.match(exchange.read().text, /authentication required/)
  }
})

test('settings: a rejection status is honoured, and a throwing check is refused', async () => {
  // `requestRejection` returns 401, 403, or undefined. The first two must be passed
  // through unchanged — rewriting 401 to 403 would tell an unauthenticated caller
  // they are forbidden, which is a different instruction. Anything else (a throw, or
  // a value the contract does not define) becomes a refusal rather than admission.
  const cases = [
    { connection: { requestRejection: () => 401 }, expected: 401 },
    { connection: { requestRejection: () => 403 }, expected: 403 },
    { connection: { requestRejection: () => { throw new Error('boom') } }, expected: 403 },
    { connection: { requestRejection: () => 'unexpected' }, expected: 403 },
  ]
  for (const { connection, expected } of cases) {
    const { routes } = register({ connection })
    const exchange = makeExchange({ method: 'GET' })
    await routes.get(STATUS_ROUTE)(exchange.req, exchange.res)
    assert.equal(exchange.read().status, expected, `${connection.requestRejection.toString()} should answer ${expected}`)
  }
})

test('settings: an admitted request reaches the handler', async () => {
  const { routes } = register({
    connection: { requestRejection: () => undefined },
    describeAuth: async () => ({ source: 'gh-cli', authenticated: true, login: 'octocat' }),
  })
  const exchange = makeExchange({ method: 'GET' })
  await routes.get(STATUS_ROUTE)(exchange.req, exchange.res)
  const { status, body } = exchange.read()
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.login, 'octocat')
  assert.equal(body.source, 'gh-cli')
})

// ---------------------------------------------------------------------------
// The status route
// ---------------------------------------------------------------------------

test('settings status: reports capability, and never the token', async () => {
  const { routes } = register({
    connection: { requestRejection: () => undefined },
    credentials: { set: async () => {} },
    describeAuth: async () => ({ source: 'credentials-seam', authenticated: true, login: 'me' }),
  })
  const exchange = makeExchange({ method: 'GET' })
  await routes.get(STATUS_ROUTE)(exchange.req, exchange.res)
  const { body, text } = exchange.read()
  assert.equal(body.configured, true)
  assert.equal(body.canStore, true, 'a seam with set() means the page can save')
  assert.equal(body.version, '9.9.9')
  assert.equal(body.credentialRef, 'GITHUB_TOKEN')
  assert.doesNotMatch(text, /ghp_|gho_|token" *:/, 'the status body must not carry a token')
})

test('settings status: says saving is impossible when there is no seam', async () => {
  const { routes } = register({ connection: { requestRejection: () => undefined } })
  const exchange = makeExchange({ method: 'GET' })
  await routes.get(STATUS_ROUTE)(exchange.req, exchange.res)
  assert.equal(exchange.read().body.canStore, false, 'the page must not offer a button that cannot work')
})

test('settings status: a non-GET is refused', async () => {
  const { routes } = register({ connection: { requestRejection: () => undefined } })
  const exchange = makeExchange({ method: 'POST', body: {} })
  await routes.get(STATUS_ROUTE)(exchange.req, exchange.res)
  assert.equal(exchange.read().status, 405)
})

// ---------------------------------------------------------------------------
// The token route
// ---------------------------------------------------------------------------

test('settings token: stores through the credentials seam and never echoes the value', async () => {
  const stored = []
  const { routes } = register({
    connection: { requestRejection: () => undefined },
    credentials: { set: async (ref, value) => { stored.push([ref, value]) } },
  })
  const exchange = makeExchange({ method: 'POST', body: { token: 'ghp_example_value_1234567890' } })
  await routes.get(TOKEN_ROUTE)(exchange.req, exchange.res)
  const { body, text } = exchange.read()
  assert.equal(body.ok, true)
  assert.deepEqual(stored, [['GITHUB_TOKEN', 'ghp_example_value_1234567890']])
  assert.doesNotMatch(text, /ghp_example_value/, 'the response must not echo the token')
})

test('settings token: rejects an empty token and a non-POST', async () => {
  const { routes } = register({ connection: { requestRejection: () => undefined }, credentials: { set: async () => {} } })
  const empty = makeExchange({ method: 'POST', body: { token: '   ' } })
  await routes.get(TOKEN_ROUTE)(empty.req, empty.res)
  assert.equal(empty.read().status, 400)

  const get = makeExchange({ method: 'GET' })
  await routes.get(TOKEN_ROUTE)(get.req, get.res)
  assert.equal(get.read().status, 405)
})

test('settings token: explains the missing seam instead of failing silently', async () => {
  const { routes } = register({ connection: { requestRejection: () => undefined } })
  const exchange = makeExchange({ method: 'POST', body: { token: 'x' } })
  await routes.get(TOKEN_ROUTE)(exchange.req, exchange.res)
  const { body } = exchange.read()
  assert.equal(body.ok, false)
  assert.equal(body.error, 'no-credentials-service')
  assert.match(body.detail, /GITHUB_TOKEN/)
})

test('settings token: a throwing seam is reported, not propagated', async () => {
  const { routes } = register({
    connection: { requestRejection: () => undefined },
    credentials: { set: async () => { throw new Error('store offline') } },
  })
  const exchange = makeExchange({ method: 'POST', body: { token: 'x' } })
  await routes.get(TOKEN_ROUTE)(exchange.req, exchange.res)
  assert.equal(exchange.read().body.ok, false)
  // The message must not include the token either.
  assert.doesNotMatch(exchange.read().text, /"x"/)
})

// ---------------------------------------------------------------------------
// The test route
// ---------------------------------------------------------------------------

test('settings test: makes a real round trip and reports the login', async () => {
  const calls = []
  const { routes } = register({
    connection: { requestRejection: () => undefined },
    runner: {
      async run(argv) {
        calls.push(argv)
        return { ok: true, stdout: 'octocat\n', stderr: '' }
      },
    },
  })
  const exchange = makeExchange({ method: 'POST', body: {} })
  await routes.get(TEST_ROUTE)(exchange.req, exchange.res)
  assert.deepEqual(exchange.read().body, { ok: true, authenticated: true, login: 'octocat' })
  assert.deepEqual(calls[0].slice(0, 2), ['api', 'user'], 'the test must be a real API call, not a form check')
})

test('settings test: a rejected request reports why', async () => {
  const { routes } = register({
    connection: { requestRejection: () => undefined },
    runner: { async run() { return { ok: false, stdout: '', stderr: 'HTTP 401: Bad credentials' } } },
  })
  const exchange = makeExchange({ method: 'POST', body: {} })
  await routes.get(TEST_ROUTE)(exchange.req, exchange.res)
  const { body } = exchange.read()
  assert.equal(body.ok, false)
  assert.equal(body.authenticated, false)
  assert.match(body.detail, /401/)
})

test('settings: every route is registered inside ctx.effect, so disposal releases it', () => {
  const { routes, registeredInEffect } = register({ connection: { requestRejection: () => undefined } })
  assert.equal(routes.size, 3)
  for (const path of [STATUS_ROUTE, TOKEN_ROUTE, TEST_ROUTE]) {
    assert.equal(registeredInEffect.get(path), true, `${path} must be registered inside ctx.effect`)
  }
})
