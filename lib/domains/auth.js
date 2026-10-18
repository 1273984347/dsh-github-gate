/**
 * github_auth — inspect and establish GitHub credentials.
 *
 * This is the domain that makes the layered credential chain visible and gives
 * a user with no credential a way to get one. `login` runs GitHub Device Flow
 * against github.com directly: it prints a code, opens nothing, and stores the
 * resulting token through the dsh credentials seam so every later call resolves
 * it without an environment variable.
 */

import { str, bool, enumStr } from '../schema.js'
import { resolveRepo } from '../workspace.js'
import { gitRouteStatus } from '../routes.js'
import { completed, rejection } from '../result.js'

/**
 * What to do about a broken layer.
 *
 * Each message names the layer that failed and the single action that fixes it.
 * "Check your network" is not a recommendation.
 *
 * @param {{ name: string, detail: string } | undefined} broken the first failed layer
 * @returns {string} the recommendation
 */
function recommendation(broken) {
  if (broken === undefined) return 'Nothing is broken.'
  switch (broken.name) {
    case 'gh executable':
      return 'gh is not runnable. Install the GitHub CLI, or set the plugin config `ghPath` to its '
        + 'absolute path if it is installed outside PATH.'
    case 'credential chain':
      return 'No credential resolved. Run `gh auth login`, export GH_TOKEN, or call this tool with '
        + 'action "login" to authorize through GitHub Device Flow.'
    case 'gh login':
      return 'gh has no login for this host. Run `gh auth login`, or call this tool with action '
        + '"login" (Device Flow) or provide a `token`.'
    case 'API round trip':
      return 'Credentials exist but the API refused the request. The token may be expired or lack '
        + `scope, or a proxy may be blocking it (${broken.detail}).`
    case 'workspace repository':
      return 'The path works, but this workspace names no repository. Pass `repo` explicitly, or set '
        + 'the plugin config `defaultRepo`.'
    default:
      return `Investigate the failing layer: ${broken.detail}`
  }
}

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_auth',
  title: 'GitHub authentication',
  // Actions safe to run concurrently with other reads: they change neither
  // remote state nor local files. `login` and `logout` write credentials.
  readOnlyActions: ['status', 'probe', 'token'],
  description:
    'Inspect and establish the GitHub credential this plugin uses. The credential chain is ' +
    'tried in order: the dsh credentials store, GH_TOKEN/GITHUB_TOKEN in the host environment, ' +
    'the GitHub CLI\'s own login, then git\'s credential helper. Use action "status" to see which ' +
    'layer is active, and action "login" to authorize through GitHub Device Flow when none is. ' +
    'Tokens are never echoed back except by action `token`, which exists to pipe one, and they ' +
    'never appear in the command line.',
  params: {
    token: str('login: optional personal access token. When omitted, Device Flow is used instead. The value is passed on stdin, never in argv.'),
    ref: str('login/status: credential reference name to read or write. Defaults to the plugin config credentialRef.'),
    hostname: str('login: GitHub host for gh auth login (default github.com; set it for a GHES instance).'),
    protocol: enumStr(['https', 'ssh'], 'login: git protocol gh should prefer for this host.'),
    gitCredential: bool('status: also report whether git\'s credential helper holds a GitHub credential.'),
  },
  actions: {
    status: {
      help: 'Report which credential layer is active, whether gh is installed, and the resolved login name.',
      needs: [],
      // Own execution: the layered chain is resolved in-process, and reporting
      // it is more useful than `gh auth status` alone (which only knows about
      // gh's own login).
      custom: async ({ deps, cfg }) => {
        const started = Date.now()
        const describe = deps.describeAuth
        if (typeof describe !== 'function') {
          return rejection('github_auth status: the credential chain is unavailable in this composition.')
        }
        const info = await describe()
        const lines = [
          `gh installed: ${info.ghInstalled ? 'yes' : 'no'}${info.ghVersion === '' ? '' : ` (${info.ghVersion})`}`,
          `credential source: ${info.source}`,
          `authenticated: ${info.authenticated ? 'yes' : 'no'}`,
        ]
        if (info.login !== undefined) lines.push(`login: ${info.login}`)
        lines.push(
          '',
          'The chain is tried in this order: the dsh credentials store, GH_TOKEN/GITHUB_TOKEN, the',
          'GitHub CLI login, then git\'s credential helper. Use action "login" to establish one.',
        )
        if (!info.authenticated) {
          lines.push(
            '',
            '[hint] No credential found. Either run `gh auth login`, export GH_TOKEN, or call this tool',
            'with action "login" to authorize through GitHub Device Flow.',
          )
        }
        return completed({
          ok: info.authenticated,
          durationMs: Date.now() - started,
          command: '(credential chain resolved in-process)',
          stdout: lines.join('\n'),
          data: info,
        })
      },
    },
    probe: {
      help: 'Probe the whole GitHub path end to end and report which layer is broken, with timings. '
        + 'Unlike "status", which reports what is CONFIGURED, this reports what actually WORKS right now: '
        + 'it runs gh --version, resolves the credential chain, asks gh auth status, makes a real API '
        + 'round trip, and resolves the workspace repository. Every layer is isolated, so one failure '
        + 'reports itself instead of hiding the rest.',
      needs: [],
      // Own execution: a probe is a ladder of SEVERAL commands plus an in-process
      // resolution, which no single argv can express. It also must not abort on the
      // first failure — the point is to show how far the path gets.
      custom: async ({ deps, cfg, cwd }) => {
        const started = Date.now()

        /**
         * Run one layer in isolation.
         * @param {string} name the layer name
         * @param {() => Promise<{ ok: boolean, detail: string }>} body the layer
         * @returns {Promise<{ name: string, ok: boolean, ms: number, detail: string }>} the outcome
         */
        const layer = async (name, body) => {
          const at = Date.now()
          try {
            const { ok, detail } = await body()
            return { name, ok, ms: Date.now() - at, detail }
          } catch (error) {
            // A layer that THROWS is a failed layer, not a failed probe. Swallowing
            // it here is what keeps the ladder complete.
            return { name, ok: false, ms: Date.now() - at, detail: String(error?.message ?? error) }
          }
        }

        /** Run one gh command with this call's timeout. */
        const gh = (argv) => deps.runner.run(argv, { exec: undefined, timeoutMs: cfg.timeoutMs })

        const layers = []

        layers.push(await layer('gh executable', async () => {
          const result = await gh(['--version'])
          if (result.ok !== true) {
            return { ok: false, detail: result.stderr.split('\n')[0] || 'gh could not be started' }
          }
          return { ok: true, detail: result.stdout.trim().split('\n')[0] ?? '' }
        }))

        layers.push(await layer('credential chain', async () => {
          if (typeof deps.describeAuth !== 'function') {
            return { ok: false, detail: 'the credential chain is unavailable in this composition' }
          }
          const info = await deps.describeAuth()
          return {
            ok: info.authenticated === true,
            detail: `source=${info.source}${info.login === undefined ? '' : ` login=${info.login}`}`,
          }
        }))

        layers.push(await layer('gh login', async () => {
          const result = await gh(['auth', 'status'])
          // `gh auth status` exits non-zero when no host is logged in, and prints
          // the reason on stderr. Both are the answer, not an error.
          const text = `${result.stdout}\n${result.stderr}`.trim()
          const loginLine = text.split('\n').find((line) => line.includes('Logged in to')) ?? ''
          return { ok: result.ok === true, detail: loginLine.trim() || text.split('\n')[0] || 'no login' }
        }))

        layers.push(await layer('API round trip', async () => {
          // The only layer that proves the whole path: credentials that are present
          // but rejected, a proxy that eats the request, or a blocked network all
          // pass the layers above and fail here.
          const result = await gh(['api', 'rate_limit'])
          if (result.ok !== true) {
            return { ok: false, detail: result.stderr.split('\n')[0] || `gh api exited ${result.exitCode}` }
          }
          try {
            const parsed = JSON.parse(result.stdout)
            const core = parsed?.resources?.core
            return {
              ok: true,
              detail: core === undefined
                ? 'responded'
                : `core ${core.remaining}/${core.limit} remaining`,
            }
          } catch {
            return { ok: true, detail: 'responded (unparseable body, but the request succeeded)' }
          }
        }))

        layers.push(await layer('workspace repository', async () => {
          if (typeof deps.resolveRepoForProbe !== 'function') {
            return { ok: false, detail: 'repository resolution is unavailable in this composition' }
          }
          const repo = await deps.resolveRepoForProbe()
          return repo === ''
            ? { ok: false, detail: 'no GitHub remote in the workspace and no defaultRepo configured' }
            : { ok: true, detail: repo }
        }))

        // The second route, and the only one that survives a missing or unauthenticated
        // `gh`: the git protocol needs neither the binary's login nor a token. This is
        // the layer that answers "if gh dies, is anything left?" — which is the whole
        // reason a fallback exists.
        layers.push(await layer('git protocol route', async () => {
          const status = await gitRouteStatus(deps.runner, typeof cwd === 'string' ? cwd : '.')
          return status.ok === true
            ? { ok: true, detail: `origin is GitHub: ${status.remote}` }
            : { ok: false, detail: status.detail }
        }))

        // The path works when the LAST mile works. A green credential chain with a
        // dead API round trip is the failure this probe exists to name.
        const api = layers.find((entry) => entry.name === 'API round trip')
        const ok = api?.ok === true
        const firstBroken = layers.find((entry) => !entry.ok)
        // Found BY NAME, never by position. Reading `layers.at(-1)` was correct until a
        // sixth layer was appended, at which point the repository field quietly began
        // reporting the git route instead. The probe's own test caught it; a name cannot
        // be reordered out from under a reader.
        const repoLayer = layers.find((entry) => entry.name === 'workspace repository')

        const lines = layers.map((entry) => `${entry.ok ? '[ok]  ' : '[FAIL]'} ${entry.name.padEnd(20)} ${String(entry.ms).padStart(6)} ms  ${entry.detail}`)
        lines.push('')
        if (ok) {
          lines.push('The GitHub path is working end to end.')
        } else {
          lines.push(`The GitHub path is BROKEN at: ${firstBroken?.name ?? 'unknown'}`)
          lines.push('', `[fix] ${recommendation(firstBroken)}`)
        }

        return completed({
          ok,
          durationMs: Date.now() - started,
          // Derived from the layers that actually ran, not hand-written. The previous
          // literal listed five and kept listing five after a sixth was added — the
          // exact "description drifts from implementation" defect this project keeps
          // finding, committed by the file that documents it. A derived label cannot
          // drift.
          command: `(connectivity probe: ${layers.map((entry) => entry.name).join(', ')})`,
          stdout: lines.join('\n'),
          stderr: ok ? '' : `probe failed at layer: ${firstBroken?.name ?? 'unknown'}`,
          data: {
            ok,
            brokenAt: ok ? null : (firstBroken?.name ?? 'unknown'),
            layers: layers.map(({ name, ok: layerOk, ms, detail }) => ({ name, ok: layerOk, ms, detail })),
            recommended: ok ? '' : recommendation(firstBroken),
            repo: repoLayer?.ok === true ? repoLayer.detail : '',
            cwd: typeof cwd === 'string' ? cwd : '',
          },
        })
      },
    },
    login: {
      help: 'Authorize GitHub. Without `token` this runs Device Flow (prints a code to enter at github.com/login/device) and stores the token; with `token` it pipes a PAT to gh on stdin. Both write the credential store, so confirm: true is required. Device Flow needs the plugin config deviceFlowClientId set to your own OAuth App client id.',
      needs: [],
      // Establishing a credential is a state change with two consequences — a
      // value is written to the credentials store, and later calls use it — so it
      // goes through the same gate as the other writes.
      destructive: true,
      check: (a) =>
        a.token !== undefined && typeof a.token === 'string' && a.token.trim() === ''
          ? 'github_auth login: `token` was provided but is empty; omit it entirely to use Device Flow.'
          : null,
      // Own execution: Device Flow is a multi-request handshake whose result
      // must be written through the credentials seam, which no single argv can
      // express. The PAT branch still shells out to gh, keeping the secret on
      // stdin rather than in argv.
      custom: async ({ args, deps, cfg, exec }) => {
        const started = Date.now()

        if (typeof args.token === 'string' && args.token !== '') {
          const result = await deps.runner.run(['auth', 'login', '--with-token'], {
            exec,
            timeoutMs: cfg.timeoutMs,
            stdin: `${args.token}\n`,
          })
          return result
        }

        if (typeof deps.deviceFlowLogin !== 'function') {
          return rejection('github_auth login: Device Flow is unavailable in this composition.')
        }
        const outcome = await deps.deviceFlowLogin()
        const lines = []
        if (outcome.userCode !== undefined) {
          lines.push(
            `Open ${outcome.verificationUri ?? 'https://github.com/login/device'} and enter the code:`,
            '',
            `    ${outcome.userCode}`,
            '',
          )
        }
        lines.push(outcome.message)
        return completed({
          ok: outcome.ok,
          durationMs: Date.now() - started,
          command: '(GitHub Device Flow)',
          stdout: lines.join('\n'),
          stderr: outcome.ok ? '' : outcome.message,
        })
      },
    },
    logout: {
      help: 'Log the current gh user out of the configured host.',
      needs: [],
      destructive: true,
      argv: (a) => {
        const argv = ['auth', 'logout']
        if (a.hostname) argv.push('--hostname', a.hostname)
        return argv
      },
    },
    token: {
      help: 'Print the resolved token (for piping into another tool). Treat the output as a secret.',
      needs: [],
      argv: () => ['auth', 'token'],
    },
  },
}

export default domain
