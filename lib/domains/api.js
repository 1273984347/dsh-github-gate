/**
 * github_api — the guarded raw REST escape hatch.
 *
 * It runs `gh api` rather than calling the REST API directly. That choice was
 * made after measuring, not assumed:
 *
 * - **It works where a direct fetch does not.** On a machine whose TLS
 *   interception (a corporate proxy, a hosts-based accelerator such as
 *   Steam++) is trusted by the OS but not by Node's bundled CA store, a
 *   `fetch` to api.github.com fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE while
 *   `gh` — which uses the platform trust store — succeeds. Routing through gh
 *   inherits the credential chain and the platform trust configuration that the
 *   other seven tools already depend on, instead of introducing a second,
 *   differently-configured network path.
 * - **It is one implementation, not two.** The plugin already requires gh; a
 *   second transport would need its own pagination, error mapping, and
 *   redirect handling, and would drift.
 * - **Pagination is native.** `gh api --paginate` follows the Link header and
 *   aggregates array results, which is exactly the behaviour wanted here.
 *
 * The guardrails are unchanged: the path must be RELATIVE (so the request can
 * never be aimed at another host with the user's credential attached), the
 * method set is closed, and state-changing methods require `confirm: true`.
 *
 * Two `gh api` behaviours are handled explicitly because they are easy traps:
 * - `-f` implies POST. Query parameters are therefore appended to the path
 *   rather than passed as fields, so a GET stays a GET.
 * - A request body must go through `--input -` on stdin, never argv.
 */

import { str, bool, int, enumStr } from '../schema.js'
import { rejection } from '../result.js'

/** Methods this tool will issue. */
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']

/** Methods that change state and therefore need explicit confirmation. */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Validate a caller-supplied REST path.
 *
 * A path must be relative and must not be able to redirect the request to a
 * different host. `//evil.com/x` and an absolute URL are both rejected for that
 * reason: either would send the user's token somewhere else.
 *
 * It must also stay inside the API tree it names. `gh api` normalizes `.` and
 * `..` before sending, so `"/repos/../../user"` reaches `/user` — measured, and it
 * works. The relative-path rule stops a request crossing to another HOST; this
 * check stops it crossing to another ENDPOINT, which is the same escape with a
 * narrower consequence: an unauthenticated read of `/user`, `/rate_limit`, or
 * anything else reachable by walking up.
 *
 * @param {string} path the candidate path
 * @returns {string | null} an error message, or null when the path is usable
 */
export function validateApiPath(path) {
  if (typeof path !== 'string' || path.trim() === '') return 'github_api: `path` is required.'
  const value = path.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return 'github_api: `path` must be relative, not an absolute URL.'
  if (value.startsWith('//')) return 'github_api: `path` must not start with "//" (it would target another host).'
  if (!value.startsWith('/')) return 'github_api: `path` must start with "/" (e.g. "/repos/owner/name").'
  if (value.includes('\\')) return 'github_api: `path` must not contain a backslash.'
  // Refuse `..` anywhere in the path. gh api normalizes it before sending, so
  // `/repos/../user` reaches `/user`: the same escape the relative-path rule
  // stops, with a narrower consequence — an unauthenticated read of any endpoint
  // reachable by walking up.
  if (containsDotDot(value)) {
    return 'github_api: `path` must not contain ".." — it would resolve to a different endpoint than the one written.'
  }
  return null
}

/**
 * Whether a path contains a traversal segment, plain or percent-encoded.
 *
 * Every occurrence is refused, not only the ones that walk past the API root.
 * `/repos/../rate_limit` resolves to a different endpoint than the one written
 * while still looking like a nested repos path, so a caller — and any reviewer of
 * the request — cannot tell it from `/rate_limit`. Refusing the segment outright
 * is what keeps the argv and the request identical, which is the property the
 * caller already relies on for every other path.
 *
 * The ENCODED forms matter and were missed on the first attempt: `gh api
 * "/repos/%2e%2e/user"` is decoded by the HTTP layer and normalized to `/user`,
 * so it reaches the same endpoint the plain form does. `%2f` splits a segment the
 * same way a literal `/` does. The check therefore decodes before splitting —
 * exactly once, because that is what the transport does; a double-encoded
 * `%252e` stays literal and is harmless.
 *
 * @param {string} path a validated relative path
 * @returns {boolean} true when the path walks up the tree anywhere
 */
function containsDotDot(path) {
  const withoutQuery = path.split('?')[0].split('#')[0]
  let decoded = withoutQuery
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    // A malformed escape cannot be decoded, and gh would send it literally; treat
    // the raw form as the thing to inspect.
    decoded = withoutQuery
  }
  return decoded.split('/').includes('..')
}

/**
 * Parse `key=value&key2=value2` into ordered pairs, or accept an object.
 * @param {unknown} input the raw `query` argument
 * @returns {{ key: string, value: string }[] | null} parsed pairs, or null when unusable
 */
export function parseQuery(input) {
  if (input === undefined || input === null || input === '') return []
  if (typeof input === 'object' && !Array.isArray(input)) {
    return Object.entries(input)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(([key, value]) => ({ key, value: String(value) }))
  }
  if (typeof input !== 'string') return null
  /** @type {{ key: string, value: string }[]} */
  const pairs = []
  for (const pair of input.split('&')) {
    if (pair === '') continue
    const index = pair.indexOf('=')
    if (index === -1) return null
    pairs.push({ key: pair.slice(0, index), value: pair.slice(index + 1) })
  }
  return pairs
}

/**
 * Append query pairs to a path, preserving any query the caller already wrote
 * into the path itself.
 * @param {string} path the validated relative path
 * @param {{ key: string, value: string }[]} pairs the parameters
 * @returns {string} the path with its query string
 */
export function withQuery(path, pairs) {
  if (pairs.length === 0) return path
  const encoded = pairs
    .map(({ key, value }) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  return path.includes('?') ? `${path}&${encoded}` : `${path}?${encoded}`
}

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_api',
  title: 'GitHub REST API',
  description:
    'Call the GitHub REST API through `gh api` for endpoints the typed tools do not cover (labels, ' +
    'milestones, projects, gists, orgs, teams, and so on). `path` must be relative, e.g. ' +
    '"/repos/owner/name/labels"; `query` is appended to it. paginate: true follows the Link header ' +
    'and aggregates array results. POST, PATCH, PUT, and DELETE change state and require ' +
    'confirm: true. Prefer a typed tool when one covers the endpoint: those are validated and ' +
    'render better.',
  params: {
    path: str('Relative REST path starting with "/", e.g. "/repos/owner/name/labels". Absolute URLs are rejected.'),
    method: enumStr(METHODS, 'HTTP method (default GET). Non-GET methods require confirm: true.'),
    query: str('Query string as "key=value&key2=value2". Appended to the path, so GET stays GET.'),
    body: str('JSON request body as a string (POST/PATCH/PUT). Passed on stdin, never in argv.'),
    paginate: bool('Follow the Link header and aggregate array results, up to a hard page cap.'),
    confirm: bool('DESTRUCTIVE: set to true to explicitly confirm this action.'),
    timeoutMs: int('Optional per-call timeout in milliseconds.'),
  },
  gated: true,
  // Deliberately empty: whether one `request` reads or writes depends on its
  // `method` argument, which concurrency classification is not allowed to
  // inspect. An unclassifiable action is never treated as safe.
  readOnlyActions: [],
  actions: {
    request: {
      help: 'Issue one REST request. Set `path` (relative), `method`, and optionally `query`, `body`, or `paginate`.',
      needs: ['path'],
      // The argv is built by the custom executor below, which needs to inspect
      // the method before deciding on flags. This stub satisfies the uniform
      // action-table shape and is never used.
      argv: () => ['api'],
      custom: async ({ args, cfg, deps, exec }) => {
        const started = Date.now()

        const pathError = validateApiPath(args.path)
        if (pathError !== null) return rejection(pathError)

        const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
        if (!METHODS.includes(method)) {
          return rejection(`github_api: unsupported method ${JSON.stringify(method)}. Use one of ${METHODS.join(', ')}.`)
        }
        if (WRITE_METHODS.has(method)) {
          if (cfg.allowDestructive !== true) {
            return rejection(`github_api: ${method} changes state and the plugin config has allowDestructive: false.`)
          }
          if (args.confirm !== true) {
            return rejection(`github_api: ${method} changes state — call it again with confirm: true to proceed.`)
          }
        }

        const pairs = parseQuery(args.query)
        if (pairs === null) return rejection('github_api: `query` must be "key=value&key2=value2".')

        let body
        if (typeof args.body === 'string' && args.body.trim() !== '') {
          try {
            body = JSON.parse(args.body)
          } catch (error) {
            return rejection(`github_api: \`body\` is not valid JSON — ${String(error?.message ?? error)}`)
          }
        }

        const argv = ['api', withQuery(args.path.trim(), pairs), '--method', method]
        if (args.paginate === true) argv.push('--paginate')
        if (body !== undefined) argv.push('--input', '-')

        const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
          ? args.timeoutMs
          : args.paginate === true
            ? cfg.watchTimeoutMs
            : cfg.timeoutMs

        const result = await deps.runner.run(argv, {
          exec,
          timeoutMs,
          ...(body === undefined ? {} : { stdin: JSON.stringify(body) }),
        })

        // gh prints the HTTP status line to stderr and the response body to stdout,
        // so a credential error is matched across BOTH. Matching stderr alone made
        // the "Bad credentials" clause unreachable.
        if (!result.ok && /HTTP 401|Bad credentials|Requires authentication/i.test(result.stderr + result.stdout)) {
          result.stderr += (result.stderr.endsWith('\n') ? '' : '\n') +
            '[hint] The credential was rejected. Call github_auth with action "status" to inspect the chain.'
        }
        return result
      },
    },
  },
}

export default domain
