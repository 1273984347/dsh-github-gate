/**
 * Credential resolution and GitHub authorization.
 *
 * Two halves, deliberately separate:
 *
 * **Resolution** answers "which token should this call use?" by walking a
 * layered chain, cheapest and most explicit first. Every layer is re-read on
 * each call — the credentials seam's contract is that consumers re-resolve per
 * operation and never cache across operations, which is what lets a credential
 * stored mid-session reach the next invocation without a restart.
 *
 * **Device Flow** answers "how does a user who has no credential yet get one?"
 * by talking ONLY to github.com. This is the one piece taken from
 * kaziii/dsh-github-connector: its Device Flow implementation contacts the
 * OAuth host directly with a public client id and no secret, unlike
 * KryptonGao/dsh-github-integration, whose default configuration routes
 * authorization through a third-party broker and expects an OAuth App private
 * key on the machine. Nothing here depends on a server we do not control.
 *
 * The token never enters argv, never enters a log line, and — with the single
 * deliberate exception of `github_auth` action `token`, whose whole purpose is to
 * be piped elsewhere — is never returned in a tool result. The credential chain
 * reports which LAYER supplied a token, never its value.
 */

/** Raised when GitHub authorization fails in a way the user must act on. */
export class GitHubAuthError extends Error {
  /**
   * @param {string} message user-facing explanation
   * @param {string} code stable machine-readable code
   * @param {{ cause?: unknown, retryAfterMs?: number }} [details] extra context
   */
  constructor(message, code, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'GitHubAuthError'
    this.code = code
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
  }
}

/** Source labels reported by {@link describeAuth}. */
export const CREDENTIAL_SOURCES = {
  seam: 'credentials-seam',
  env: 'environment',
  gh: 'gh-cli',
  gitCredential: 'git-credential-helper',
  none: 'none',
}

/**
 * Read the token held by the dsh credentials seam.
 *
 * `resolve()` returns `undefined` while the reference is unconfigured and
 * treats an empty stored value as absent, so a blank can never masquerade as a
 * configured secret.
 *
 * @param {any} credentials the `credentials` service, or undefined
 * @param {string} ref the credential reference name, e.g. `GITHUB_TOKEN`
 * @returns {Promise<string>} the token, or an empty string
 */
async function readSeamToken(credentials, ref) {
  if (credentials === undefined || typeof credentials.resolve !== 'function') return ''
  try {
    const resolved = await credentials.resolve(ref)
    const value = resolved?.value
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    // An unreadable seam must not break the fallback chain below it.
    return ''
  }
}

/**
 * Read the GitHub credential stored by git's credential helper (Git
 * Credential Manager on Windows, osxkeychain, libsecret, ...).
 *
 * Prompts are disabled through the runner's quiet environment, so this can
 * never block on an interactive dialog. `password=` is the only field read;
 * the username line is ignored.
 *
 * @param {import('./types.js').Runner} runner the configured runner
 * @returns {Promise<string>} the token, or an empty string
 */
async function readGitCredential(runner) {
  try {
    const result = await runner.runGit(['credential', 'fill'], {
      timeoutMs: 15_000,
      stdin: 'protocol=https\nhost=github.com\n\n',
    })
    if (!result.ok) return ''
    const line = String(result.stdout ?? '')
      .split(/\r?\n/)
      .find((entry) => entry.startsWith('password='))
    return line === undefined ? '' : line.slice('password='.length).trim()
  } catch {
    return ''
  }
}

/**
 * Walk the credential chain and report which layer supplied the token.
 *
 * Order is deliberate: the most explicit, user-controlled source wins, and the
 * implicit discovery layers come last so they can never shadow a deliberate
 * choice.
 *
 * 1. `seam` — the value the user stored through the dsh credentials service
 * 2. `env` — `GH_TOKEN` / `GITHUB_TOKEN` in the host environment
 * 3. `gh` — the GitHub CLI's own login state (`gh auth token`)
 * 4. `gitCredential` — whatever the git credential helper already holds
 *
 * @param {{ credentials?: any, runner: import('./types.js').Runner, credentialRef: string, env?: Record<string, string | undefined> }} deps
 * @returns {Promise<{ token: string, source: string }>} the token and its source label
 */
export async function resolveToken(deps) {
  const env = deps.env ?? globalThis.process?.env ?? {}

  const seamToken = await readSeamToken(deps.credentials, deps.credentialRef)
  if (seamToken !== '') return { token: seamToken, source: CREDENTIAL_SOURCES.seam }

  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      return { token: value.trim(), source: CREDENTIAL_SOURCES.env }
    }
  }

  // `gh auth token` prints the stored token on success and fails when gh is
  // not logged in; it needs no network access.
  try {
    const result = await deps.runner.run(['auth', 'token'], { timeoutMs: 15_000, internal: true })
    if (result.ok) {
      const token = String(result.stdout ?? '').trim()
      if (token !== '') return { token, source: CREDENTIAL_SOURCES.gh }
    }
  } catch { /* fall through to the git credential helper */ }

  const gitToken = await readGitCredential(deps.runner)
  if (gitToken !== '') return { token: gitToken, source: CREDENTIAL_SOURCES.gitCredential }

  return { token: '', source: CREDENTIAL_SOURCES.none }
}

/**
 * Describe the authentication state without exposing the token.
 *
 * @param {{ credentials?: any, runner: import('./types.js').Runner, credentialRef: string, env?: Record<string, string | undefined> }} deps
 * @returns {Promise<{ authenticated: boolean, source: string, ghInstalled: boolean, ghVersion: string, login?: string }>}
 */
export async function describeAuth(deps) {
  const probe = await deps.runner.probe()
  const { token, source } = await resolveToken(deps)
  /** @type {{ authenticated: boolean, source: string, ghInstalled: boolean, ghVersion: string, login?: string }} */
  const info = {
    authenticated: token !== '',
    source,
    ghInstalled: probe.available === true,
    ghVersion: String(probe.version ?? ''),
  }
  if (token !== '') {
    try {
      const result = await deps.runner.run(['api', 'user', '--jq', '.login'], { timeoutMs: 20_000, internal: true })
      if (result.ok) {
        const login = String(result.stdout ?? '').trim()
        if (login !== '') info.login = login
      }
    } catch { /* a failed identity probe leaves login absent, not fatal */ }
  }
  return info
}

/** One progress update from a Device Flow run. */
export const DEVICE_FLOW_PHASES = {
  awaiting: 'awaiting-authorization',
  slowDown: 'slow-down',
  authorized: 'authorized',
  expired: 'expired',
  denied: 'denied',
  failed: 'failed',
}

/**
 * POST one OAuth form endpoint and return the parsed JSON body.
 *
 * GitHub's OAuth endpoints answer with JSON when asked, which is why the
 * `accept` header is set explicitly — the default form encoding would have to
 * be parsed by hand.
 *
 * @param {{ fetch: typeof globalThis.fetch, authBaseURL: string, signal?: AbortSignal }} deps
 * @param {string} path endpoint path, e.g. `/login/device/code`
 * @param {Record<string, string>} body form fields
 * @returns {Promise<Record<string, unknown>>} the parsed body
 */
async function postOAuth(deps, path, body) {
  let response
  try {
    response = await deps.fetch(`${deps.authBaseURL.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
  } catch (cause) {
    if (deps.signal?.aborted) {
      throw new GitHubAuthError('the GitHub device flow was aborted', 'GITHUB_ABORTED', { cause })
    }
    throw new GitHubAuthError(
      `the GitHub device flow request to ${path} failed before a response arrived`,
      'GITHUB_CONNECT_NETWORK',
      { cause },
    )
  }
  if (!response.ok) {
    throw new GitHubAuthError(
      `the GitHub device flow request to ${path} failed with HTTP ${response.status}`,
      'GITHUB_CONNECT_HTTP',
    )
  }
  return /** @type {Record<string, unknown>} */ (await response.json())
}

/**
 * Request a device code / user code pair (`POST /login/device/code`).
 *
 * @param {{ fetch: typeof globalThis.fetch, authBaseURL: string, clientId: string, scope: string, signal?: AbortSignal }} deps
 * @returns {Promise<{ userCode: string, verificationUri: string, interval: number, expiresIn: number, deviceCode: string }>}
 */
export async function requestDeviceCode(deps) {
  const json = await postOAuth(deps, '/login/device/code', {
    client_id: deps.clientId,
    scope: deps.scope,
  })
  const deviceCode = json.device_code
  const userCode = json.user_code
  const verificationUri = json.verification_uri
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new GitHubAuthError('GitHub returned an unusable device code response', 'GITHUB_CONNECT_HTTP')
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    interval: typeof json.interval === 'number' ? json.interval : 5,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 900,
  }
}

/**
 * Poll `POST /login/oauth/access_token` until the user authorizes, following
 * the server's pacing: wait `interval` seconds between polls, add 5 seconds on
 * `slow_down`, and settle terminally on `expired_token` / `access_denied`.
 *
 * A wall-clock deadline derived from `expiresIn` bounds the loop so a device
 * code that GitHub never expires still cannot poll forever.
 *
 * @param {{ fetch: typeof globalThis.fetch, authBaseURL: string, clientId: string, scope: string, signal?: AbortSignal }} deps
 * @param {string} deviceCode the private code from {@link requestDeviceCode}
 * @param {number} intervalSeconds the initial poll interval
 * @param {number} expiresIn seconds until the device code expires
 * @param {(update: { phase: string, intervalSeconds?: number }) => void} [onUpdate] progress sink
 * @returns {Promise<string>} the access token
 */
export async function pollForToken(deps, deviceCode, intervalSeconds, expiresIn, onUpdate) {
  let interval = intervalSeconds
  const deadline = Date.now() + Math.max(60, expiresIn) * 1000
  for (;;) {
    await sleep(interval * 1000, deps.signal)
    if (deps.signal?.aborted) {
      throw new GitHubAuthError('the GitHub device flow was aborted', 'GITHUB_ABORTED')
    }
    if (Date.now() > deadline) {
      throw new GitHubAuthError('the GitHub device code expired before authorization', 'GITHUB_CONNECT_EXPIRED')
    }
    const json = await postOAuth(deps, '/login/oauth/access_token', {
      client_id: deps.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const error = json.error
    if (error === undefined) {
      const token = json.access_token
      if (typeof token !== 'string' || token === '') {
        throw new GitHubAuthError('GitHub returned an unusable access token response', 'GITHUB_CONNECT_HTTP')
      }
      return token
    }
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      interval += 5
      onUpdate?.({ phase: DEVICE_FLOW_PHASES.slowDown, intervalSeconds: interval })
      continue
    }
    if (error === 'expired_token') {
      throw new GitHubAuthError('the GitHub device code expired before authorization', 'GITHUB_CONNECT_EXPIRED')
    }
    if (error === 'access_denied') {
      throw new GitHubAuthError('the user denied the GitHub authorization request', 'GITHUB_CONNECT_DENIED')
    }
    throw new GitHubAuthError(`GitHub device flow failed: ${String(error)}`, 'GITHUB_CONNECT_HTTP')
  }
}

/**
 * Sleep for `ms`, resolving early when the signal aborts.
 * @param {number} ms milliseconds to wait
 * @param {AbortSignal} [signal] optional cancellation
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Run one complete Device Flow and return the token WITHOUT storing it; the
 * caller owns the credentials-seam write, so this stays testable with the
 * endpoints fully mocked.
 *
 * @param {{ fetch?: typeof globalThis.fetch, authBaseURL: string, clientId: string, scope: string, signal?: AbortSignal, onUpdate?: (update: any) => void }} deps
 * @returns {Promise<{ token: string, userCode: string, verificationUri: string }>}
 */
export async function runDeviceFlow(deps) {
  const resolved = { fetch: deps.fetch ?? globalThis.fetch, ...deps }
  const code = await requestDeviceCode(resolved)
  deps.onUpdate?.({
    phase: DEVICE_FLOW_PHASES.awaiting,
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    interval: code.interval,
    expiresIn: code.expiresIn,
  })
  const token = await pollForToken(resolved, code.deviceCode, code.interval, code.expiresIn, deps.onUpdate)
  deps.onUpdate?.({ phase: DEVICE_FLOW_PHASES.authorized })
  return { token, userCode: code.userCode, verificationUri: code.verificationUri }
}

/**
 * Store a token through the dsh credentials seam so later calls resolve it
 * without any environment variable.
 *
 * @param {any} credentials the `credentials` service
 * @param {string} ref the credential reference name
 * @param {string} token the token to store
 * @returns {Promise<boolean>} whether the write succeeded
 */
export async function storeToken(credentials, ref, token) {
  if (credentials === undefined || typeof credentials.set !== 'function') return false
  if (token === '') return false
  try {
    await credentials.set(ref, token)
    return true
  } catch {
    return false
  }
}
