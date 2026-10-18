/**
 * dsh-github-gate — a distilled GitHub toolkit for DeepSeek Harness.
 *
 * Two halves: the Host tools (this file and `lib/`) and one small Client module
 * (`client.js`, the session-header branch pill). Zero runtime dependencies, no
 * build step. It is a deliberate distillation of three community plugins rather
 * than a merge of them; DESIGN.md records what was kept from each and why.
 *
 * What it does:
 * - registers typed `github_*` tools driven by a domain/action table, so every
 *   operation is an argv ARRAY spawned without a shell;
 * - resolves credentials through a layered chain (dsh credentials seam →
 *   environment → gh CLI → git credential helper) and can establish a new one
 *   through GitHub Device Flow, talking only to github.com;
 * - binds the repository to the workspace's own git remote when no explicit
 *   `repo` argument is given;
 * - offers a guarded raw REST escape hatch with pagination, one error
 *   vocabulary, and an approval gate for state-changing calls.
 *
 * Deliberately absent: `peerDependencies` (the bundle resolves core packages
 * from the dsh installation, and a peer range that excludes the running
 * runtime would trigger the compatibility gate) and any `prepare`/build script.
 */

import { normalizeConfig } from './lib/config.js'
import { Config } from './lib/config-schema.js'
import { createRunner } from './lib/runner.js'
import {
  DEVICE_FLOW_PHASES,
  describeAuth,
  resolveToken,
  runDeviceFlow,
  storeToken,
} from './lib/auth.js'
import { createRequire } from 'node:module'
import { isOlderThan, versionToken } from './lib/version.js'
import {
  DEFAULT_UPDATE_REPO,
  isCacheFresh,
  parseRelease,
  readCheckCache,
  releaseRelation,
  updateCheckCachePath,
  writeCheckCache,
} from './lib/update.js'
import { resolveRepo } from './lib/workspace.js'
import { registerDomainTools, installDestructiveApproval } from './lib/registry.js'
import { installClientBridge } from './lib/client-bridge.js'
import { installSettingsRoutes } from './lib/settings-routes.js'
import { installGuidance } from './lib/guidance.js'

/**
 * This package's own version, read from its manifest.
 *
 * `createRequire` rather than a JSON import assertion: assertions are still
 * version-dependent across the Node builds this plugin supports, and a failure
 * here would take the whole plugin down for a diagnostic string.
 *
 * @returns {string} the version, or '' when the manifest cannot be read
 */
function pluginVersion() {
  try {
    return createRequire(import.meta.url)('./package.json').version ?? ''
  } catch {
    return ''
  }
}

/** Cordis plugin name. */
export const name = 'github-gate'

/**
 * Required services. `tools` is the only hard dependency; the credentials seam
 * is read through `ctx.get('credentials')` so the plugin still activates in a
 * composition that has no credentials service.
 */
export const inject = ['tools']

/**
 * The configuration schema.
 *
 * Declaring it is the Harness convention: the row's `config` is validated
 * against this schema at activation, absent fields are filled from the schema's
 * own defaults, and an invalid row fails the load with a clear message instead
 * of silently falling back later. See lib/config-schema.js for why every field
 * carries a default rather than one object-level default.
 */
export { Config }

/**
 * Log one line when a newer release exists, at most once per cache window.
 *
 * Advisory by construction: every failure path — no credential, no network, an
 * unreadable cache, an unparseable tag — ends in silence rather than in a warning
 * the user cannot act on. The alternative, a red log line on an offline machine,
 * teaches people to ignore the log.
 *
 * A cached result younger than the TTL is reused so a restart loop does not turn
 * into an API loop.
 *
 * @param {any} ctx the plugin context
 * @param {import('./lib/types.js').PluginConfig} cfg the resolved config
 * @param {import('./lib/types.js').Runner} runner the process runner
 * @returns {Promise<void>}
 */
async function notifyWhenUpdateAvailable(ctx, cfg, runner) {
  if (cfg.updateCheck !== true) return

  const cachePath = updateCheckCachePath()
  const cached = readCheckCache(cachePath)
  const installed = pluginVersion()
  if (isCacheFresh(cached)) {
    // The cached tag is re-compared against the CURRENT installed version, because
    // the cached answer is "what is the newest release", not "am I behind" — the
    // latter changes after an upgrade that did not clear the cache.
    if (cached !== undefined && releaseRelation(installed, cached.latest) === 'newer') {
      ctx.logger?.info?.('update available: %s is installed, %s is published — run github_update check', installed, cached.latest)
    }
    return
  }

  const repo = typeof cfg.updateRepo === 'string' && cfg.updateRepo.trim() !== '' ? cfg.updateRepo.trim() : DEFAULT_UPDATE_REPO
  const endpoint = cfg.updateChannel === 'latest'
    ? `repos/${repo}/releases?per_page=1`
    : `repos/${repo}/releases/latest`
  const result = await runner.run(['api', endpoint], { timeoutMs: cfg.timeoutMs })
  if (result.ok !== true) return
  const payload = cfg.updateChannel === 'latest'
    ? (Array.isArray(result.data) ? result.data[0] : undefined)
    : result.data
  if (payload === undefined) return
  const release = parseRelease(payload)
  if (release.version === '') return
  writeCheckCache(cachePath, { checkedAt: Date.now(), latest: release.version })
  if (releaseRelation(installed, release.version) === 'newer') {
    ctx.logger?.info?.(
      'update available: %s is installed, %s is published — run github_update check for the release notes and staging path',
      installed === '' ? '(unknown)' : installed,
      release.version,
    )
  }
}

/**
 * Build the dependency bag the domain layer receives.
 *
 * Separated from `apply` because it is a self-contained description of what
 * the plugin can do on a domain's behalf. A 70-line object literal in the
 * middle of activation made the activation order hard to follow.
 *
 * @param {object} input the collaborators
 * @param {any} input.credentials the credentials seam, or undefined
 * @param {any} input.runner the process runner
 * @param {any} input.cfg the resolved config
 * @param {() => Promise<string>} input.tokenLookup credential lookup
 * @param {any} input.ctx the plugin context
 * @param {Record<string, string | undefined>} input.credentialEnv the environment
 *   the credential chain reports against (`process.env` merged with `cfg.env`)
 * @returns {Record<string, any>} the dependency bag
 */
function buildDeps({ credentials, runner, cfg, tokenLookup, ctx, credentialEnv }) {
  return {
    credentials,
    runner,
    resolveToken: tokenLookup,
    fetch: globalThis.fetch,
    // The running package version, for `github_update check`. Passed as a function
    // rather than a string so a diagnostic never reads the manifest at import time.
    pluginVersion,
    // Optional: present only when a job registry is composed. `run_in_background`
    // reports availability from this, so an absent registry is a clear message
    // rather than a silent foreground run.
    jobs: ctx.get?.('jobs'),
    /**
     * Run GitHub Device Flow and store the token.
     * @param {(update: any) => void} [onUpdate] progress sink
     * @returns {Promise<{ ok: boolean, message: string, userCode?: string, verificationUri?: string }>}
     */
    async deviceFlowLogin(onUpdate) {
      if (cfg.deviceFlowClientId === '') {
        return {
          ok: false,
          message:
            'Device Flow needs an OAuth App client id, and none is configured. Register an App with ' +
            'Device Flow enabled at https://github.com/settings/applications/new, then set ' +
            'deviceFlowClientId in this plugin\'s config. This is not shipped pre-filled on purpose: a ' +
            'client id identifies the app registration your authorization is granted to, so a built-in ' +
            'one would route your access through someone else\'s application. Alternatively call ' +
            'github_auth login with a `token`, or log in with `gh auth login` — both are picked up ' +
            'automatically by the credential chain.',
        }
      }
      try {
        const result = await runDeviceFlow({
          fetch: globalThis.fetch,
          authBaseURL: cfg.authBaseURL,
          clientId: cfg.deviceFlowClientId,
          scope: cfg.deviceFlowScope,
          onUpdate,
        })
        const stored = await storeToken(credentials, cfg.credentialRef, result.token)
        return {
          ok: true,
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          message: stored
            ? `Authorized and stored the token under "${cfg.credentialRef}".`
            : `Authorized. The token could not be written to the credentials store, so set ` +
              `${cfg.credentialRef} in the host environment to use it.`,
        }
      } catch (error) {
        return { ok: false, message: `Device Flow failed: ${String(error?.message ?? error)}` }
      }
    },
    describeAuth: () => describeAuth({ credentials, runner, credentialRef: cfg.credentialRef, env: credentialEnv }),
    // The probe resolves the workspace repository as its last layer. Wired here
    // rather than inside the domain so the domain stays free of the config shape.
    resolveRepoForProbe: () => resolveRepo({
      args: {},
      cfg,
      runner,
      cwd: globalThis.process?.cwd?.() ?? '.',
    }),
    phases: DEVICE_FLOW_PHASES,
  }
}

/**
 * Deny shell-level git mutations so the plugin's own gated actions are the
 * only path.
 *
 * Off by default, because dsh already owns permissions and a second, invisible
 * refusal layer surprises users who approved an action.
 *
 * @param {any} ctx the plugin context
 * @param {import('./lib/types.js').PluginConfig} cfg the resolved config
 * @returns {void}
 */
function installShellGitGuard(ctx, cfg) {
  if (cfg.blockShellGit !== true || typeof ctx.tools.guard !== 'function') return
    ctx.tools.guard((execution) => {
      if (execution.name !== 'bash' && execution.name !== 'pwsh') return undefined
      const args = execution.arguments
      if (typeof args !== 'object' || args === null || !('command' in args)) return undefined
      const command = /** @type {{ command?: unknown }} */ (args).command
      if (typeof command !== 'string') return undefined
      const normalized = command.replaceAll('\\', '/').replaceAll('\n', ' ')
      // Match `git <verb>` only where git is actually being INVOKED: at the
      // start of the command or right after a shell separator. A bare
      // /git\s+commit/ would also deny `echo "git commit"` and
      // `grep -r 'git commit' docs`, which is a confusing false positive.
      const invokesGit = (verbPattern) =>
        new RegExp(`(?:^|[;&|]\\s*)\\s*git\\s+(?:-[^\\s]+\\s+)*${verbPattern}`, 'i').test(normalized)
      if (invokesGit('(?:commit|push|merge)\\b')) {
        return 'Git commit, push, and merge go through the GitHub toolkit tools, which apply confirmation gates.'
      }
      if (invokesGit('reset\\b[^;|&]*\\s--hard(?:\\s|$)')) {
        return 'git reset --hard is blocked by the GitHub toolkit safety policy (blockShellGit).'
      }
      if (invokesGit('clean\\b')) {
        return 'git clean is blocked by the GitHub toolkit safety policy (blockShellGit).'
      }
      if (invokesGit('push\\b[^;|&]*(?:--force|-f\\b|--delete\\b|\\s:\\S+)')) {
        return 'Force-push and remote branch deletion are blocked by the GitHub toolkit safety policy (blockShellGit).'
      }
      return undefined
    })
}

/**
 * Register the toolkit.
 *
 * Every resource is registered inside `apply` and owned by this plugin's fiber,
 * so unloading the plugin removes all of it.
 *
 * @param {any} ctx the plugin context
 * @param {unknown} rawConfig the row's `config`, already validated against
 *   {@link Config} and populated with schema defaults by the framework
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const credentials = ctx.get?.('credentials')

  /**
   * The environment the credential chain reports against.
   *
   * `cfg.env` is merged in because the runner spawns `gh` with it: a token set
   * there authenticates every child process. Reading only `process.env` made the
   * chain report `none` while gh was in fact authenticated — a diagnostic that
   * contradicted the tool's own behaviour, which is worse than no diagnostic.
   * @type {Record<string, string | undefined>}
   */
  const credentialEnv = { ...globalThis.process?.env, ...cfg.env }

  /**
   * The credential lookup handed to the runner and to REST domains. It is an
   * async callback rather than a value on purpose: the credentials seam
   * contract requires re-resolution per operation, so a token stored
   * mid-session reaches the very next call with no restart.
   * @returns {Promise<string>} the token, or an empty string
   */
  const tokenLookup = async () => {
    const { token } = await resolveToken({ credentials, runner, credentialRef: cfg.credentialRef, env: credentialEnv })
    return token
  }

  const runner = createRunner(cfg, ctx.logger, tokenLookup)

  // An availability probe runs once so the first real call already benefits
  // from the cached result, and so a missing gh is reported at activation
  // rather than on the first tool call.
  runner.probe().then((probe) => {
    if (probe.available === true) {
      ctx.logger?.info?.('gh detected: %s', probe.version)
      if (cfg.verifyGhVersion === true && isOlderThan(probe.version, cfg.minGhVersion)) {
        ctx.logger?.warn?.(
          'gh %s is older than the configured minimum %s — some actions may be unavailable',
          versionToken(probe.version),
          cfg.minGhVersion,
        )
      }
    } else {
      ctx.logger?.warn?.(
        'gh not usable (%s) — github_* tools will return guidance until it is installed',
        probe.version !== '' ? probe.version : 'probe failed',
      )
    }
  }).catch(() => { /* the probe is advisory; a failure must not break activation */ })

  // Report the resolved credential source once, without ever logging the value.
  describeAuth({ credentials, runner, credentialRef: cfg.credentialRef, env: credentialEnv }).then((info) => {
    if (info.authenticated) ctx.logger?.info?.('auth: using %s%s', info.source, info.login === undefined ? '' : ` as ${info.login}`)
    else ctx.logger?.warn?.('auth: no GitHub credential found — call github_auth with action "status" for the chain')
  }).catch(() => { /* advisory only */ })

  const deps = buildDeps({ credentials, runner, cfg, tokenLookup, ctx, credentialEnv })

  // Advisory update notice, opt-in and cached.
  //
  // Off by default (`updateCheck: false`): a plugin that reaches the network during
  // activation surprises someone who did not ask for it, and this one already makes
  // two advisory calls above. When enabled it runs at most once per 24 hours, reads
  // the cached result otherwise, and logs one line — never a state change, because a
  // replaced bundle needs a restart this process cannot perform.
  notifyWhenUpdateAvailable(ctx, cfg, runner).catch(() => { /* advisory only */ })

  registerDomainTools(ctx, cfg, runner, {
    cwd: globalThis.process?.cwd?.() ?? '.',
    resolveToken: tokenLookup,
    fetch: globalThis.fetch,
    deps,
  })

  // Guidance: the rules the tool schemas cannot state, plus the workflows. Each half
  // registers only where its service exists, so a headless composition keeps every
  // tool and simply has no prompt to contribute to.
  const guidance = installGuidance(ctx, { logger: ctx.logger })

  // Ask a person before a destructive action actually runs. `confirm: true` is
  // the model stating its own intent; on its own it is not consent.
  installDestructiveApproval(ctx, cfg)

  // The branch and pull-request status routes (plus diagnostics). They wait for
  // the `webServer` service by LISTENING rather than declaring it: this row's
  // `inject` stays `['tools']` so a headless profile keeps every github_* tool,
  // and the routes simply never appear there.
  installClientBridge(ctx, {
    runner,
    logger: ctx.logger,
    timeoutMs: cfg.timeoutMs,
    // Reported on the diagnostics route, so a RUNNING process can be asked which
    // generation it loaded. That question previously cost two restart cycles,
    // answered by comparing a file timestamp against a process start time.
    version: pluginVersion(),
    // The diagnostics route reports whether the guidance reached the model. Passed in
    // rather than imported, so there is no module-level state shared between contexts.
    guidance,
  })

  // Settings → Plugins → GitHub. Writes a credential, so every route fails CLOSED
  // when no `connection` service can judge the caller — a page whose purpose is to
  // store a secret must not be reachable in a composition that cannot authenticate.
  installSettingsRoutes(ctx, {
    runner,
    logger: ctx.logger,
    credentials,
    credentialRef: cfg.credentialRef,
    timeoutMs: cfg.timeoutMs,
    version: pluginVersion(),
    describeAuth: () => describeAuth({ credentials, runner, credentialRef: cfg.credentialRef, env: credentialEnv }),
  })

  // Optional: deny shell-level git mutations so the plugin's own gated actions
  // are the only path. Off by default, because dsh already owns permissions and
  // a second, invisible refusal layer surprises users who approved an action.
  installShellGitGuard(ctx, cfg)

  ctx.effect(() => () => {
    ctx.logger?.info?.('dsh-github-gate disposed')
  })
}
