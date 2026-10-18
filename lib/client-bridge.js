/**
 * The Host half of the branch pill: one HTTP route the browser half reads.
 *
 * ## Why a route, and not `host.call`
 *
 * `host.call(method, args)` exists, but only on the *evaluated* Client path
 * (`evaluateClientHalf`), where it arrives as one of the `new Function`
 * parameters. An installed bundle's Client half takes the *script* path instead:
 * the Web shell enqueues it through `window.__ModuleLoader__` and its factory
 * receives only `require`. So the documented, framework-provided channel for an
 * installed bundle is the one the shipped third-party plugins also use — the Host
 * half registers a route on `ctx.webServer` and the Client half `fetch`es it.
 *
 * ## Diagnostics
 *
 * A second route reports this plugin's own runtime state. It exists because the
 * plugin's logs go NOWHERE: an exhaustive scan of `DSH_HOME`, `%APPDATA%`,
 * `%LOCALAPPDATA%`, `%TEMP%` and the installation directory found no file
 * containing a single line of plugin output — every match was a manifest, a pnpm
 * log, or Chromium's code cache. Three diagnosis rounds were spent blind because
 * of that. The route is the channel instead, and being a named route it is gated
 * by the same `connection.requestRejection` check as the branch route.
 *
 * ## Security
 *
 * This route is reachable from the browser, so it is deliberately NOT a general
 * "run git in this directory" endpoint. The caller may only name a workspace the
 * Host has already registered; that membership check is what stops the route
 * from becoming an arbitrary-directory probe. Everything else it might be asked
 * for is refused with a reason, never guessed at.
 *
 * The command is fixed (`git rev-parse`), argv is an array, and the directory
 * comes from the registry rather than from the request, so no request text ever
 * reaches a command line.
 */

import { installWhenAvailable } from './deferred.js'
// `sendJson` and `readJsonBody` live in one module: two copies of the response
// writer or the body cap is two places to get them wrong.
import { readJsonBody, sendJson } from './http-json.js'
// The git-protocol fallback route, used when the gh route has nothing to say.
import { headSha, findPullByHeadSha, listBranches, workingTreeState, switchBranch } from './routes.js'

/** Route path. Namespaced by package so a composition collision is obvious. */
export const BRANCH_ROUTE = '/dsh-github-gate/branch'

/**
 * Diagnostics route. Reports this plugin's own state — which services it found,
 * which routes it registered — because the plugin's logs are written nowhere a
 * human can read them (see the header). It answers the question three blind
 * diagnosis rounds had to answer by inference.
 */
export const DIAGNOSTICS_ROUTE = '/dsh-github-gate/diagnostics'
export const BRANCHES_ROUTE = '/dsh-github-gate/branches'
export const SWITCH_ROUTE = '/dsh-github-gate/switch'

/**
 * Read the branch checked out in one directory.
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the directory to inspect
 * @returns {Promise<{ branch: string, detached: boolean }>} the branch state
 */
async function readBranch(runner, cwd) {
  const result = await runner.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 })
  if (result.ok !== true) return { branch: '', detached: false }
  const name = String(result.stdout ?? '').trim()
  // A detached HEAD prints the literal "HEAD", which is a state, not a branch.
  if (name === 'HEAD') return { branch: '', detached: true }
  return { branch: name, detached: false }
}

/**
 * Read the open-or-recent pull request whose head is one branch.
 *
 * Strictly best-effort. `gh` may be absent, unauthenticated, offline, or the
 * repository may have no remote — none of which is a reason to lose the branch
 * the pill was already showing. Every failure returns null, and the caller reports
 * a null PR as "no PR", not as a broken route.
 *
 * `--state all` because a branch whose PR has just merged is exactly when the
 * status is most useful; the newest one is enough.
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @param {string} branch the head branch
 * @param {number} timeoutMs the command budget
 * @returns {Promise<{ number: number, title: string, state: string, isDraft: boolean, reviewDecision: string, url: string } | null>}
 */
async function readPullRequest(runner, cwd, branch, timeoutMs) {
  if (branch === '') return null
  try {
    const result = await runner.run([
      'pr', 'list',
      '--head', branch,
      '--state', 'all',
      '--limit', '1',
      '--json', 'number,title,state,isDraft,reviewDecision,url',
    ], { cwd, timeoutMs })
    if (result.ok !== true) return null
    const parsed = JSON.parse(String(result.stdout ?? '').trim() || '[]')
    const pr = Array.isArray(parsed) ? parsed[0] : undefined
    if (pr === undefined || typeof pr !== 'object' || pr === null) return null
    if (typeof pr.number !== 'number') return null
    return {
      number: pr.number,
      title: typeof pr.title === 'string' ? pr.title : '',
      state: typeof pr.state === 'string' ? pr.state : '',
      isDraft: pr.isDraft === true,
      reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : '',
      url: typeof pr.url === 'string' ? pr.url : '',
    }
  } catch {
    // A parse failure or a missing gh is the same answer here: no PR to show.
    return null
  }
}

/**
 * Resolve a requested path against the Host's registered workspaces.
 *
 * @param {any} registry the `workspaceRegistry` service, or undefined
 * @param {string} requested the path the browser asked about
 * @returns {Promise<string>} the registered workspace path, or ''
 */
async function resolveWorkspace(registry, requested) {
  if (registry === undefined || typeof requested !== 'string' || requested.trim() === '') return ''
  const wanted = requested.trim()
  try {
    // `resolveByPath` is the precise lookup; `list` is the fallback for a build
    // that does not expose it. Either way the answer comes from the registry, so
    // an unregistered directory can never be inspected.
    if (typeof registry.resolveByPath === 'function') {
      const found = await registry.resolveByPath(wanted)
      const path = found?.path
      return typeof path === 'string' ? path : ''
    }
    if (typeof registry.list === 'function') {
      const workspaces = registry.list()
      const match = (Array.isArray(workspaces) ? workspaces : [])
        .find((workspace) => workspace?.path === wanted)
      return typeof match?.path === 'string' ? match.path : ''
    }
  } catch {
    return ''
  }
  return ''
}

/**
 * Resolve the workspace owning one Session.
 *
 * This is the form the browser half uses, and it is the safer one: the request
 * names a SESSION, never a directory, so no request text can point the route at
 * an arbitrary path on the machine. The mapping lives in the Host registry, whose
 * `Workspace.sessionIds` is already filtered by the canonical-cwd header index.
 *
 * @param {any} registry the `workspaceRegistry` service, or undefined
 * @param {string} sessionId the session the pill belongs to
 * @returns {string} the owning workspace path, or ''
 */
function resolveSessionWorkspace(registry, sessionId) {
  if (registry === undefined || typeof sessionId !== 'string' || sessionId === '') return ''
  if (typeof registry.list !== 'function') return ''
  try {
    const workspaces = registry.list()
    const match = (Array.isArray(workspaces) ? workspaces : [])
      .find((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId))
    return typeof match?.path === 'string' ? match.path : ''
  } catch {
    return ''
  }
}

/**
 * Ask the composed Connection whether this request may be served at all.
 *
 * Returns the rejection status, or undefined when the request is admitted. A
 * composition with no `connection` (or an older one without the method) returns
 * undefined: the route then behaves as it did before, because refusing every
 * request in a composition that cannot judge them would break the pill outright.
 *
 * ## Two acknowledged weaknesses, made visible rather than left implicit
 *
 * An independent audit named both, and both are real:
 *
 * 1. **It is fail-OPEN when the check is unavailable.** No `connection`, or one without
 *    `requestRejection`, and every request is served. Refusing instead would break
 *    compositions that legitimately have no Connection service, so the behaviour stays —
 *    but it now says so once, loudly, instead of serving in silence. A gate that is absent
 *    and a gate that admitted you look identical from the outside; only the log separates
 *    them.
 * 2. **A return value other than 401 or 403 is treated as admission.** The real service
 *    returns only those two or `undefined`, so this cannot fire today. It is left as-is
 *    because guessing at an unknown status is worse than admitting, but the assumption is
 *    named here rather than implied by a bare `=== `.
 *
 * ## The gate is split by CONSEQUENCE, not by service availability
 *
 * An independent audit drove a real request through all four routes in a composition with
 * no `connection` service and measured that **every one of them served** — including
 * `/switch`, which runs `git switch` on the user's working tree.
 *
 * The fix is not "refuse everything when the check is missing" and it is not "that is fine,
 * they are loopback-only". It is to notice that the four routes do not carry the same
 * consequence:
 *
 * | Routes | What they do | Without a gate |
 * |---|---|---|
 * | `branch`, `branches`, `diagnostics` | read the workspace path and branch names | leaks to any local process |
 * | **`switch`** | **changes the user's working tree** | **any local process can move the user's branch** |
 *
 * Loopback is not a security boundary: any process on this machine can open
 * `127.0.0.1:19387`. So the rule is:
 *
 * > **A missing service is not consent.** An apparatus that cannot judge a request must not
 * > treat "cannot judge" as "judged safe" — least of all when the request changes something
 * > that belongs to someone else.
 *
 * The cost is asymmetric too, which is what makes the split the right one rather than a
 * compromise: refusing the read routes breaks the pill entirely, while refusing `/switch`
 * leaves it showing the branch and only disables the changing of it.
 *
 * There is deliberately **no opt-in flag**. A knob nobody would set correctly is another
 * place to be wrong, and a composition with no `connection` has no way to ask for the risk
 * knowingly.
 *
 * @param {any} ctx the plugin context
 * @param {any} req the Node request
 * @param {{ requireGate?: boolean }} [options] `requireGate` refuses when the check is absent
 * @returns {401 | 403 | undefined} the status to refuse with, or undefined
 */
function rejectUntrusted(ctx, req, options = {}) {
  const { requireGate = false } = options
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') {
    if (requireGate) {
      // The route changes the working tree and nothing can vouch for the caller.
      if (rejectUntrusted.warnedRequired !== true) {
        rejectUntrusted.warnedRequired = true
        ctx.logger?.warn?.(
          'github-gate: no connection.requestRejection in this composition, so the branch '
          + 'SWITCH route is refused. Reading the branch still works; changing it needs a '
          + 'composition that can judge the caller.',
        )
      }
      return 403
    }
    // Once per process, not once per request: this route is polled on every window focus.
    if (rejectUntrusted.warned !== true) {
      rejectUntrusted.warned = true
      ctx.logger?.warn?.(
        'github-gate: no connection.requestRejection in this composition, so the READ '
        + 'routes are served without the Host/Origin and authentication checks. They are '
        + 'loopback-only, but anything on this machine can read them.',
      )
    }
    return undefined
  }
  try {
    const rejection = connection.requestRejection({ headers: req?.headers ?? {} })
    if (rejection === 401 || rejection === 403) return rejection
    // Documented above: any other value admits. Logged the first time it happens, because
    // it would mean the contract changed under us.
    if (rejection !== undefined && rejectUntrusted.warnedOther !== true) {
      rejectUntrusted.warnedOther = true
      ctx.logger?.warn?.(
        'github-gate: connection.requestRejection returned %o, which is neither 401, 403 '
        + 'nor undefined — treated as admission. The contract may have changed.',
        rejection,
      )
    }
    return undefined
  } catch {
    // A thrown trust check is not an admission.
    return 403
  }
}

/**
 * Register the branch route on the composed web server.
 *
 * ## How this waits for `webServer`, and why not the obvious ways
 *
 * The route needs the `webServer` service, and Cordis loads a plugin only once
 * the services it DECLARES in `inject` are ready. The tools row declares only
 * `tools`, so three approaches were tried and two of them failed:
 *
 * 1. `ctx.get('webServer')` once in `apply` — undefined at that moment. Skipped
 *    silently; the route answered a bare 404 and the pill showed an idle dash.
 * 2. `ctx.inject(['webServer'], cb)` — the callback never registered the route in
 *    the running Desktop composition either.
 * 3. A second plugin ROW declaring `webServer` — correct in principle, but a
 *    profile bundle's row may not use a bare SUBPATH: the launcher's runtime
 *    resolution supplies a profile package by its exact name, so
 *    `dsh-github-gate/web` resolved nowhere and the row reported
 *    "failed to import". (Verified: that specifier resolves from the profile but
 *    not from the installation base, which is the base a fallback would use.)
 *
 * What works is listening. Cordis emits `internal/service` for every service
 * registration — `'internal/service'(this: Context, name: string, value: any)` —
 * and the shipped plugins use it. So this installs the route when the service is
 * already up AND on every later registration, which keeps `webServer` optional:
 * a headless profile simply never fires it and never gets a route, while every
 * `github_*` tool keeps working.
 *
 * ## The route belongs to `ctx.effect`
 *
 * The first version registered the route and simply held its disposer. That is a
 * leak: disposing the plugin's fiber did NOT release the route, so the next
 * activation — the HMR path an install takes — hit
 * `webserver: duplicate exact route "/dsh-github-gate/branch"` and the entry
 * failed to activate. Registering inside `ctx.effect` ties the route to the fiber,
 * which is the contract the reference states: "Register every resource inside
 * `apply` with `ctx.effect` or `ctx.on` and return its cleanup."
 *
 * @param {any} ctx the plugin context
 * @param {object} deps what the route needs
 * @param {import('./types.js').Runner} deps.runner the process runner
 * @param {any} deps.logger the plugin logger
 * @returns {boolean} whether a route was registered
 */

/**
 * Refuse a request the Connection cannot vouch for.
 *
 * Every route repeats this shape: ask `rejectUntrusted`, and on a refusal write
 * the status and the same plain-text body. Four copies of that meant four places
 * to get the body or the header wrong.
 *
 * @param {any} ctx the plugin context
 * @param {any} req the request
 * @param {any} res the response
 * @param {{ requireGate?: boolean }} [options] passed through to rejectUntrusted
 * @returns {boolean} true when the request was refused and the response is finished
 */
function refuseIfUntrusted(ctx, req, res, options) {
  const rejection = rejectUntrusted(ctx, req, options)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end('dsh web authentication required')
  return true
}

/**
 * Refuse a request whose method the route does not serve.
 *
 * @param {any} req the request
 * @param {any} res the response
 * @param {string[]} allowed the methods this route serves
 * @param {string} [detail] extra text for the refusal body
 * @returns {boolean} true when the method was refused and the response is finished
 */
function refuseIfMethod(req, res, allowed, detail) {
  if (allowed.includes(req.method)) return false
  sendJson(res, 405, { ok: false, error: 'method-not-allowed', ...(detail === undefined ? {} : { detail }) })
  return true
}

/**
 * The branch route handler.
 *
 * Reports the checked-out branch, its working-tree state, and the pull request
 * open on it. The pull request is looked up only when there IS a branch, and its
 * failure never costs the branch that was already read.
 *
 * @param {object} deps the route dependencies
 * @param {any} deps.ctx the plugin context
 * @param {import('./types.js').Runner} deps.runner the process runner
 * @param {number} deps.timeoutMs the command budget
 * @returns {(req: any, res: any) => Promise<void>} the handler
 */
function branchHandler({ ctx, runner, timeoutMs }) {
  return async (req, res) => {
    try {
      // A named route is PUBLIC by default: `/` answers 401 without the process
      // token, while this route was MEASURED answering 200 JSON to an
      // unauthenticated request. `connection.requestRejection` exists for exactly
      // this case — "apply Connection's Host/Origin checks and browser
      // authentication to another Web route" — so an unadmitted request is refused
      // with its status instead of being served. The Host/Origin half also matters:
      // it is what stops a page in the user's browser from reading this over the
      // loopback address.
      if (refuseIfUntrusted(ctx, req, res)) return
      if (refuseIfMethod(req, res, ['GET', 'HEAD'])) return
      const registry = ctx.get('workspaceRegistry')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const requestedSession = url.searchParams.get('sessionId') ?? ''
      // The session form first: a session id cannot name a directory, so the
      // browser never gets to point this route anywhere.
      const cwd = requestedSession !== ''
        ? resolveSessionWorkspace(registry, requestedSession)
        : await resolveWorkspace(registry, url.searchParams.get('path') ?? '')
      if (cwd === '') {
        sendJson(res, 200, {
          ok: false,
          error: 'unknown-workspace',
          // The reason is spelled out because the Client shows it in the tooltip:
          // "no branch" and "not a workspace" are different problems and a silent
          // blank would hide which one happened.
          detail: requestedSession !== ''
            ? 'this session is not attached to a registered workspace'
            : 'the requested path is not a registered workspace',
        })
        return
      }
      const state = await readBranch(runner, cwd)
      const pr = await lookupPullRequest({ runner, cwd, branch: state.branch, timeoutMs })
      sendJson(res, 200, { ok: true, path: cwd, ...state, pr })
    } catch (error) {
      // A route handler that throws leaves the socket without a response, so every
      // failure is turned into a body here.
      sendJson(res, 200, { ok: false, error: 'bridge-error', detail: String(error?.message ?? error) })
    }
  }
}

/**
 * The pull request open on one branch, or null.
 *
 * Two routes: the API through `gh`, and — when that yields nothing — the git
 * protocol. `gh` missing, unauthenticated or blocked are ordinary states, and on a
 * public repository `git ls-remote` answers the one question the pill asks (which
 * pull request has this commit as its head) with no credential at all. It knows
 * the NUMBER and nothing else, so the fallback reports exactly that and marks
 * where it came from; inventing a state would be worse than reporting less.
 *
 * @param {object} input the lookup inputs
 * @param {import('./types.js').Runner} input.runner the process runner
 * @param {string} input.cwd the workspace directory
 * @param {string} input.branch the checked-out branch, or ''
 * @param {number} input.timeoutMs the command budget
 * @returns {Promise<any | null>} the pull request summary, or null
 */
async function lookupPullRequest({ runner, cwd, branch, timeoutMs }) {
  if (branch === '') return null
  const pr = await readPullRequest(runner, cwd, branch, timeoutMs)
  if (pr !== null) return pr
  const sha = await headSha(runner, cwd)
  const number = sha === '' ? null : await findPullByHeadSha(runner, cwd, sha, timeoutMs)
  return number === null
    ? null
    : { number, title: '', state: '', isDraft: false, reviewDecision: '', url: '', via: 'git' }
}

/**
 * The diagnostics route handler.
 *
 * Reports which services and halves are live, so a missing one is named rather
 * than inferred from a 404.
 *
 * @param {object} deps the route dependencies
 * @param {any} deps.ctx the plugin context
 * @param {string} deps.version this package's version
 * @param {any} deps.guidance the live guidance state
 * @returns {(req: any, res: any) => Promise<void>} the handler
 */
function diagnosticsHandler({ ctx, version, guidance, webServer }) {
  return async (req, res) => {
    try {
      if (refuseIfUntrusted(ctx, req, res)) return
      if (refuseIfMethod(req, res, ['GET', 'HEAD'])) return
      const registry = ctx.get('workspaceRegistry')
      let workspaces = -1
      try {
        const list = registry?.list?.()
        workspaces = Array.isArray(list) ? list.length : -1
      } catch {
        workspaces = -2
      }
      sendJson(res, 200, diagnosticsPayload({ ctx, version, guidance, registry, workspaces, webServer }))
    } catch (error) {
      sendJson(res, 200, { ok: false, error: 'bridge-error', detail: String(error?.message ?? error) })
    }
  }
}

/**
 * The branch-list route handler.
 *
 * Reports the local branches with their tracking state, plus the working-tree
 * state, because a branch list without the tree state is not enough to predict
 * whether a switch will be allowed — the popover shows both.
 *
 * @param {object} deps the route dependencies
 * @param {any} deps.ctx the plugin context
 * @param {import('./types.js').Runner} deps.runner the process runner
 * @param {number} deps.timeoutMs the command budget
 * @returns {(req: any, res: any) => Promise<void>} the handler
 */
function branchesHandler({ ctx, runner, timeoutMs }) {
  return async (req, res) => {
    try {
      // Admission FIRST, then the method. The other order answers an
      // unauthenticated GET with 405, which tells a caller the route exists — a
      // small disclosure, and one this file's own read route does not make.
      const admitted = admitRequest(ctx, req, res)
      if (admitted.refused) return
      if (refuseIfMethod(req, res, ['GET', 'HEAD'])) return
      const url = new URL(req.url ?? BRANCHES_ROUTE, 'http://localhost')
      // The SESSION id, not a path — the same rule the read route states and for
      // the same reason. A page that can name a directory can ask the Host to run
      // git in it; a page that can only name a session can only reach the workspace
      // that session is already attached to.
      const requestedSession = url.searchParams.get('sessionId') ?? ''
      const cwd = requestedSession !== ''
        ? await resolveSessionWorkspace(admitted.registry, requestedSession)
        : ''
      if (cwd === '') {
        sendJson(res, 200, {
          ok: false,
          error: 'unknown-workspace',
          detail: requestedSession === ''
            ? 'no session was named'
            : 'this session is not attached to a registered workspace',
        })
        return
      }
      const [listed, tree] = await Promise.all([
        listBranches(runner, cwd, timeoutMs),
        workingTreeState(runner, cwd, timeoutMs),
      ])
      const state = await readBranch(runner, cwd)
      sendJson(res, 200, {
        ok: listed.ok === true,
        path: cwd,
        current: state.branch,
        detached: state.detached === true,
        clean: tree.clean,
        modified: tree.files,
        branches: listed.branches,
        // The reason a branch list came back empty belongs in `detail`; when the
        // read succeeded it is just a count. This conditional used to return
        // `listed.detail` on BOTH sides, which made the expression meaningless.
        detail: listed.ok === true ? `${listed.branches.length} local branch(es)` : listed.detail,
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: 'bridge-error', detail: String(error?.message ?? error) })
    }
  }
}

/**
 * The branch-switch route handler.
 *
 * The only route that changes the working tree, so it is the only one that
 * refuses to serve when no `connection` can judge the caller, and the only one
 * that requires POST. Both are consequence-driven, not style.
 *
 * @param {object} deps the route dependencies
 * @param {any} deps.ctx the plugin context
 * @param {import('./types.js').Runner} deps.runner the process runner
 * @param {any} deps.logger the plugin logger
 * @param {number} deps.timeoutMs the command budget
 * @returns {(req: any, res: any) => Promise<void>} the handler
 */
function switchHandler({ ctx, runner, logger, timeoutMs }) {
  return async (req, res) => {
    try {
      // `requireGate: true` — this is the one route that changes the working tree,
      // so a composition that cannot judge the caller gets a refusal rather than a
      // service. See `rejectUntrusted` for why the four routes are not treated alike.
      const admitted = admitRequest(ctx, req, res, { requireGate: true })
      if (admitted.refused) return
      // Not GET: a link, an image tag or a prefetch must not be able to move the
      // working tree. Requiring POST means the page has to mean it.
      if (refuseIfMethod(req, res, ['POST'], 'switching a branch requires POST')) return
      const body = await readJsonBody(req)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'bad-request', detail: 'the request body is not JSON' })
        return
      }
      // Session id only — see the branches route. The branch name is validated
      // against the repository's real refs inside switchBranch, not sanitised here.
      const cwd = typeof body.sessionId === 'string' && body.sessionId !== ''
        ? await resolveSessionWorkspace(admitted.registry, body.sessionId)
        : ''
      if (cwd === '') {
        sendJson(res, 200, {
          ok: false,
          error: 'unknown-workspace',
          detail: 'the named session is not attached to a registered workspace',
        })
        return
      }
      const previous = (await readBranch(runner, cwd)).branch
      const outcome = await switchBranch(runner, cwd, body.branch, timeoutMs)
      if (outcome.ok !== true) {
        sendJson(res, 200, { ok: false, error: outcome.error, detail: outcome.detail, previous })
        return
      }
      // Re-read rather than echoing the request: the point of the answer is what
      // the repository now says, not what was asked for.
      const state = await readBranch(runner, cwd)
      logger?.info?.('github-gate: switched %s -> %s', previous === '' ? '(none)' : previous, state.branch)
      sendJson(res, 200, { ok: true, previous, branch: state.branch, path: cwd })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: 'bridge-error', detail: String(error?.message ?? error) })
    }
  }
}

/**
 * Admit a request that needs the workspace registry, or refuse it.
 *
 * Returns a TAGGED result rather than the registry alone. The first version
 * returned `undefined` both when the request was refused and when no workspace
 * registry exists, which forced the caller to guess from `res.writableEnded` — a
 * check that is correct only as long as nothing else ever ends the response early.
 *
 * @param {any} ctx the plugin context
 * @param {any} req the request
 * @param {any} res the response
 * @param {{ requireGate?: boolean }} [options] passed through to rejectUntrusted
 * @returns {{ refused: true } | { refused: false, registry: any }} the admission
 */
function admitRequest(ctx, req, res, options) {
  if (refuseIfUntrusted(ctx, req, res, options)) return { refused: true }
  return { refused: false, registry: ctx.get('workspaceRegistry') }
}

/**
 * The diagnostics body.
 *
 * Every service the routes depend on, so a missing one is named rather than
 * inferred from a 404.
 *
 * @param {object} input the reported state
 * @param {any} input.ctx the plugin context
 * @param {string} input.version this package's version
 * @param {any} input.guidance the live guidance state
 * @param {any} input.registry the workspace registry, if composed
 * @param {number} input.workspaces the workspace count, or a negative error code
 * @returns {Record<string, unknown>} the response payload
 */
function diagnosticsPayload({ ctx, version, guidance, registry, workspaces, webServer }) {
  return {
    ok: true,
    plugin: 'dsh-github-gate',
    version,
    services: {
      // Reported from the service this install actually received, not re-read from
      // the context: the two agree today, but the route's own capability is the
      // fact worth reporting, and a re-read would also be true for a composition
      // whose webServer lacks register().
      webServer: typeof webServer?.register === 'function',
      workspaceRegistry: registry !== undefined,
      connection: typeof ctx.get('connection')?.requestRejection === 'function',
      jobs: ctx.get('jobs') !== undefined,
    },
    routes: [BRANCH_ROUTE, BRANCHES_ROUTE, DIAGNOSTICS_ROUTE, SWITCH_ROUTE],
    workspaces,
    workspaceRegistryResolveByPath: typeof registry?.resolveByPath === 'function',
    // What THIS PLUGIN OFFERED — not what the catalog accepted.
    //
    // This field previously read "Whether the guidance reached the model",
    // "reported as a fact". It is not that fact. `skills` comes from this
    // provider's own `list()`, so it says how many files this plugin found and
    // named; it says nothing about which skill OBJECT won a name in the catalog.
    //
    // That distinction stopped being academic: a neighbouring release registered
    // the same three names through the old runtime path, which outranks a packaged
    // provider, so the live catalog served the OLD bodies while this field would
    // still have reported three healthy names. A diagnostic that reports its own
    // input as its output is the same defect class as a guard that validates a
    // copy of the thing it guards.
    //
    // Fixing it properly means resolving the catalog, which this route cannot do —
    // so the field now says what it measures and the caveat travels with the data.
    guidance: {
      promptSection: guidance?.promptSection === true ? guidance.sectionName : null,
      offeredByThisProvider: Array.isArray(guidance?.skills) ? [...guidance.skills] : [],
      offeredIsNotCatalogState: true,
      note: 'offeredByThisProvider lists what this plugin found and named. It is NOT '
        + 'proof those skills won the catalog: a runtime registration outranks a '
        + 'packaged provider, so a stale generation can serve older bodies while '
        + 'this list still looks complete. Confirm with the skill tool, not here.',
    },
  }
}

/**
 * Register the four routes on the composed web server.
 *
 * Each route is its own `ctx.effect`, so disposing the plugin's fiber releases
 * every one of them. The wait-for-`webServer` mechanism lives in
 * `lib/deferred.js`, shared with the guidance layer: a subtle lifecycle rule with
 * two copies is a rule with two behaviours, and this one already cost three
 * diagnosis rounds. `installWhenAvailable` wraps the registration in
 * `ctx.effect`, which is what releases the routes on disposal — registering
 * outside an effect leaked and made the next activation fail with
 * `webserver: duplicate exact route "/dsh-github-gate/branch"`.
 *
 * The workspace registry is read at REQUEST time, not at install time, so a
 * registry that arrives after the web server still serves branches.
 *
 * @param {any} ctx the plugin context
 * @param {object} options the bridge dependencies
 * @param {import('./types.js').Runner} options.runner the process runner
 * @param {any} options.logger the plugin logger
 * @param {number} options.timeoutMs the command budget
 * @param {string} options.version this package's version
 * @param {any} options.guidance the live guidance state
 * @returns {boolean} whether the routes were registered
 */
export function installClientBridge(ctx, { runner, logger, timeoutMs = 15_000, version = '', guidance }) {
  return installWhenAvailable(ctx, 'webServer', (webServer) => {
    if (typeof webServer.register !== 'function') {
      throw new Error('webServer has no register()')
    }
    const routes = [
      { path: BRANCH_ROUTE, handler: branchHandler({ ctx, runner, timeoutMs }), label: 'the branch route' },
      { path: DIAGNOSTICS_ROUTE, handler: diagnosticsHandler({ ctx, version, guidance, webServer }), label: 'the diagnostics route' },
      { path: BRANCHES_ROUTE, handler: branchesHandler({ ctx, runner, timeoutMs }), label: 'the branch list route' },
      { path: SWITCH_ROUTE, handler: switchHandler({ ctx, runner, logger, timeoutMs }), label: 'the branch switch route' },
    ]
    for (const route of routes) {
      ctx.effect(() => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }), { logger, label: route.label })
    }
  }, { logger, label: 'the branch pill route' })
}
