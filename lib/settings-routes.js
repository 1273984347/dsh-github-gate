/**
 * The Settings → Plugins → GitHub page's Host half.
 *
 * Three routes, all `requireGate: true`. That is stricter than the branch-pill
 * reads and for the same reason `/switch` is strict: these routes touch the
 * credential. A read-only status route could arguably fail open, but a page whose
 * whole purpose is to write a secret must not be reachable in a composition that
 * cannot judge the caller.
 *
 * Why a page at all: the alternative is editing `cordis.patch.yml` and restarting
 * to change a token. A credential that is hard to rotate is a credential people
 * stop rotating.
 *
 * The page never returns the token. `github_auth token` exists for the case where
 * a token must be read; a settings page has no business echoing one into a DOM.
 *
 * @module dsh-github-gate/settings-routes
 */

import { installWhenAvailable } from './deferred.js'
import { readJsonBody, sendJson } from './http-json.js'

/** Route paths, namespaced by package so a composition collision is obvious. */
export const STATUS_ROUTE = '/dsh-github-gate/settings/status'
export const TOKEN_ROUTE = '/dsh-github-gate/settings/token'
export const TEST_ROUTE = '/dsh-github-gate/settings/test'

/**
 * The Refuse-a-request helper, kept local because these three routes are the only
 * callers that need it outside `client-bridge.js`.
 *
 * @param {any} ctx the plugin context
 * @param {any} req the request
 * @param {any} res the response
 * @returns {boolean} true when the request was refused and the response is finished
 */
function refuseUntrusted(ctx, req, res) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') {
    // Fail CLOSED: this page writes a credential, so a composition that cannot
    // judge the caller gets a refusal rather than a service.
    res.statusCode = 403
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('dsh web authentication required')
    return true
  }
  let rejection
  try {
    rejection = connection.requestRejection({ headers: req?.headers ?? {} })
  } catch {
    rejection = 403
  }
  if (rejection === undefined) return false
  res.statusCode = rejection === 401 || rejection === 403 ? rejection : 403
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end('dsh web authentication required')
  return true
}

/**
 * Install the three settings routes on the composed web server.
 *
 * @param {any} ctx the plugin context
 * @param {object} deps the route dependencies
 * @param {any} deps.runner the process runner
 * @param {any} deps.logger the plugin logger
 * @param {any} deps.credentials the credentials seam, or undefined
 * @param {string} deps.credentialRef the credentials reference to write
 * @param {number} deps.timeoutMs the command budget
 * @param {string} deps.version this package's version
 * @param {() => Promise<{ source: string, authenticated: boolean, login?: string }>} deps.describeAuth credential-chain report
 * @returns {boolean} whether the routes were registered
 */
export function installSettingsRoutes(ctx, { runner, logger, credentials, credentialRef, timeoutMs = 15_000, version = '', describeAuth }) {
  return installWhenAvailable(ctx, 'webServer', (webServer) => {
    if (typeof webServer.register !== 'function') throw new Error('webServer has no register()')

    const routes = [
      {
        path: STATUS_ROUTE,
        label: 'the settings status route',
        handler: async (req, res) => {
          try {
            if (refuseUntrusted(ctx, req, res)) return
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            const info = typeof describeAuth === 'function'
              ? await describeAuth()
              : { source: 'unknown', authenticated: false }
            sendJson(res, 200, {
              ok: true,
              version,
              credentialRef,
              // Whether a credential EXISTS and where it came from. Never the value.
              configured: info.source !== 'none' && info.source !== 'unknown',
              source: info.source,
              authenticated: info.authenticated === true,
              login: typeof info.login === 'string' ? info.login : '',
              // A settings page can only WRITE through the credentials seam; when
              // there is no seam, saving is impossible and the page must say so
              // rather than offering a button that cannot work.
              canStore: credentials !== undefined && typeof credentials.set === 'function',
            })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: 'settings-error', detail: String(error?.message ?? error) })
          }
        },
      },
      {
        path: TOKEN_ROUTE,
        label: 'the settings token route',
        handler: async (req, res) => {
          try {
            if (refuseUntrusted(ctx, req, res)) return
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method-not-allowed', detail: 'saving a token requires POST' })
              return
            }
            const body = await readJsonBody(req)
            if (body === undefined) {
              sendJson(res, 400, { ok: false, error: 'bad-request', detail: 'the request body is not JSON' })
              return
            }
            const token = typeof body.token === 'string' ? body.token.trim() : ''
            if (token === '') {
              sendJson(res, 400, { ok: false, error: 'bad-request', detail: '`token` is required' })
              return
            }
            if (credentials === undefined || typeof credentials.set !== 'function') {
              sendJson(res, 200, {
                ok: false,
                error: 'no-credentials-service',
                detail: 'This composition has no credentials seam, so the token cannot be stored. Set '
                  + `${credentialRef} in the host environment instead.`,
              })
              return
            }
            await credentials.set(credentialRef, token)
            // The value is logged nowhere, and the response says only that it worked.
            // Rotation takes effect on the next call because the chain resolves per
            // operation; no restart is involved.
            logger?.info?.('settings: stored a token under "%s"', credentialRef)
            sendJson(res, 200, { ok: true, credentialRef })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: 'settings-error', detail: String(error?.message ?? error) })
          }
        },
      },
      {
        path: TEST_ROUTE,
        label: 'the settings test route',
        handler: async (req, res) => {
          try {
            if (refuseUntrusted(ctx, req, res)) return
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method-not-allowed', detail: 'testing requires POST' })
              return
            }
            // A real round trip through the same credential chain the tools use, so a
            // passing test means the tools will authenticate — not that a form parsed.
            const result = await runner.run(['api', 'user', '--jq', '.login'], { timeoutMs })
            if (result.ok !== true) {
              sendJson(res, 200, {
                ok: false,
                authenticated: false,
                detail: String(result.stderr || result.stdout || 'the API rejected the request').trim().split('\n')[0],
              })
              return
            }
            sendJson(res, 200, { ok: true, authenticated: true, login: String(result.stdout ?? '').trim() })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: 'settings-error', detail: String(error?.message ?? error) })
          }
        },
      },
    ]

    for (const route of routes) {
      ctx.effect(() => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }), {
        logger,
        label: route.label,
      })
    }
  }, { logger, label: 'the GitHub settings routes' })
}
