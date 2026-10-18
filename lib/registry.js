/**
 * Domain-table driven tool registration, using the official `defineTool` DSL.
 *
 * Every `github_*` tool is generated from a `lib/domains/*.js` definition: one
 * `action` enum parameter selects the operation, and the definition's `argv()`
 * maps typed parameters onto an argument ARRAY. Nothing here builds a command
 * string, which is what makes shell injection structurally impossible rather
 * than filtered against.
 *
 * Registration goes through `defineTool` from `@deepseek-ai/dsh-tools`, which
 * compiles the author-facing parameter DSL into the enforced JSON Schema subset
 * and wraps `execute` so model-generated arguments are validated BEFORE it
 * runs. A string passed where an array is declared is therefore rejected with
 * `invalid arguments: "labels" must be an array`, instead of being spread into
 * single characters and handed to `gh`.
 *
 * Four gates apply to every domain, in this order:
 *
 *   0. **argument shape** — enforced by `defineTool`; types, required keys, and
 *      the closed action enum.
 *   1. **schema** — the action parameter is a closed enum, so an unknown action
 *      never reaches `execute`.
 *   2. **needs / check** — per-action required parameters and custom validation.
 *      These stay in the action table because the DSL has no `pattern`,
 *      `minLength`, or cross-field rule to express them with.
 *   3. **destructive** — a `destructive` action requires `confirm: true` AND the
 *      config switch `allowDestructive`. The config switch is the hard stop;
 *      `confirm` is the per-call intent signal.
 *   4. **timeout** — `long` actions (watch/log style) use `watchTimeoutMs`.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { timeoutParam, RESULT_VALUE_SCHEMA } from './schema.js'
import { completed, rejection } from './result.js'
import { GhMissingError, displayArgv, executableFor } from './runner.js'
import { resolveRepo, detectCurrentBranch, safeBranchName, CURRENT_BRANCH, DEFAULT_BRANCH } from './workspace.js'

import auth from './domains/auth.js'
import repo from './domains/repo.js'
import pr from './domains/pr.js'
import issue from './domains/issue.js'
import release from './domains/release.js'
import actionsDomain from './domains/actions.js'
import search from './domains/search.js'
import api from './domains/api.js'
import update from './domains/update.js'

/** Registration order is the order the model sees the tools in. */
const DOMAINS = [auth, repo, pr, issue, release, actionsDomain, search, api, update]

/**
 * Build the model-facing description: the domain summary plus its action
 * catalog, so the model can pick an action without a second tool call.
 * @param {import('./types.js').DomainDef} domain the domain definition
 * @returns {string} the description text
 */
function describe(domain) {
  const lines = Object.entries(domain.actions).map(([key, def]) => `- ${key}: ${def.help}`)
  const tail = domain.gated
    ? '\nThis tool is only registered when the plugin config sets allowRawApi: true.'
    : ''
  return `${domain.description}\n\nActions:\n${lines.join('\n')}${tail}`
}

/**
 * Model-visible rendering of one run result.
 *
 * The reference asks for the canonical value to be a usable programmatic API
 * and for the human-facing explanation to live here. So this renderer owns the
 * prose (`$ command`, `✓/✗ exit …`) while `execute` owns the fields.
 *
 * @param {unknown} _args the call arguments (unused)
 * @param {any} value the result value
 * @returns {{ type: 'text', text: string }[]} the content blocks
 */
function renderResult(_args, value) {
  const parts = [`$ ${value.command}`]
  if (value.stdout) parts.push(value.stdout)
  if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
  const status = value.timedOut
    ? `✗ timed out after ${value.durationMs}ms`
    : value.ok
      ? `✓ exit ${value.exitCode} · ${(value.durationMs / 1000).toFixed(1)}s`
      : `✗ exit ${value.exitCode} · ${(value.durationMs / 1000).toFixed(1)}s`
  parts.push(status)
  if (value.truncated) parts.push(`[output truncated; tail continues in spill file: ${value.spillPath}]`)
  return [{ type: 'text', text: parts.join('\n') }]
}

/**
 * Project the bounded card facts a rendered card needs, from the same canonical
 * value the model sees.
 *
 * The reference is specific about what belongs here: replayable JSON that the
 * model-visible content cannot losslessly carry — NOT React props, NOT a
 * pre-selected card, and never the whole result value. A call that failed has no
 * card facts worth projecting beyond its outcome, so the projection stays small
 * on purpose.
 *
 * @param {any} _args the call arguments (unused)
 * @param {any} value the result value
 * @returns {Record<string, unknown>} a small, cloneable JSON object
 */
export function projectResultMeta(_args, value) {
  /** @type {Record<string, unknown>} */
  const meta = { ok: value.ok === true, exitCode: value.exitCode }
  if (value.timedOut === true) meta.timedOut = true
  if (value.truncated === true) meta.truncated = true
  const data = value.data
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    // A few handle-like fields GitHub returns on most objects, so a replayed
    // card can still say WHICH object it referred to without the payload.
    for (const [source, target] of [['url', 'url'], ['html_url', 'url'], ['number', 'number'], ['nameWithOwner', 'repo'], ['full_name', 'repo'], ['tagName', 'tag'], ['name', 'name'], ['state', 'state']]) {
      const candidate = data[source]
      if ((typeof candidate === 'string' || typeof candidate === 'number') && meta[target] === undefined) {
        meta[target] = candidate
      }
    }
  }
  return meta
}

/**
 * Completed-call presentation: name the outcome instead of falling back to the
 * generic line the registry shows when no presenter is declared.
 *
 * @param {any} _args the call arguments (unused)
 * @param {any} result the tool result envelope (content, isError, meta)
 * @returns {{ card: 'generic', title: string } | undefined} the card, or undefined to fall back
 */
export function presentResult(_args, result) {
  const meta = result?.meta
  if (typeof meta !== 'object' || meta === null) return undefined
  if (meta.ok === true) return { card: 'generic', title: meta.url === undefined ? 'GitHub · done' : `GitHub · ${String(meta.url)}` }
  if (meta.timedOut === true) return { card: 'generic', title: 'GitHub · timed out' }
  return { card: 'generic', title: `GitHub · failed (exit ${String(meta.exitCode)})` }
}

/**
 * The card kind for one action. `kind` drives the icon the generic card shows,
 * so reporting `other` for everything — as this registry originally did — throws
 * away a signal the UI already supports.
 *
 * @param {import('./types.js').DomainDef} domain the domain definition
 * @param {unknown} actionName the action name from the call arguments
 * @returns {'read'|'search'|'other'} the card kind
 */
function callKind(domain, actionName) {
  if (domain.tool === 'github_search') return 'search'
  return (domain.readOnlyActions ?? []).includes(actionName) ? 'read' : 'other'
}

/**
 * Hide secret-looking parameter values from UI cards. Only the token argument
 * can carry a secret, and it never reaches argv, but it must not be echoed into
 * a rendered card either.
 * @param {any} args the call arguments
 * @returns {any} a sanitized shallow copy
 */
function sanitizeArgs(args) {
  const clone = { ...args }
  if (typeof clone.token === 'string' && clone.token !== '') clone.token = '***'
  return clone
}

/**
 * Build the non-throwing failure result for a gate violation.
 *
 * The shared `rejection()` builder owns the shape; this alias keeps the call sites
 * in `execute` short and makes it obvious that every early return here is a
 * pre-execution rejection.
 * @param {string} message the model-facing reason
 * @returns {any} a result value matching the output schema
 */
function fail(message) {
  return rejection(message)
}

/**
 * Build the author-facing parameter map for one domain.
 *
 * The implicit parameter root stays open (the DSL does not force
 * `additionalProperties: false`), matching what the previous raw schema did.
 *
 * `run_in_background` is declared only for actions long enough to outlive a
 * turn. It follows the shipped convention exactly: the flag admits a job and
 * returns its id at once, and no background execution timeout applies.
 *
 * @param {import('./types.js').DomainDef} domain the domain definition
 * @param {boolean} canBackground whether any action in this domain is long
 * @returns {Record<string, import('./types.js').ParamSpec>} the parameter DSL map
 */
function buildParameters(domain, canBackground) {
  return {
    action: {
      type: 'string',
      required: true,
      enum: Object.keys(domain.actions),
      description: `The ${domain.title.toLowerCase()} operation to perform.`,
    },
    ...domain.params,
    timeoutMs: timeoutParam(),
    ...canBackground
      ? {
        run_in_background: {
          type: 'boolean',
          description:
            'Admit this long-running action as a background job and return its id immediately. ' +
            'No background execution timeout applies; collect it with job_output and stop it with job_kill. ' +
            'Requires a composed job registry.',
        },
      }
      : {},
  }
}

/**
 * Which arguments name a GIT REF, and therefore accept the `@current` and
 * `@default` sentinels.
 *
 * A table rather than a name rule, on purpose: `ref` is a git ref on
 * `github_actions dispatch` and a CREDENTIAL reference on `github_auth`, so a
 * rule like "resolve every argument called ref" would rewrite a credential name
 * into a branch name. Listing the pairs keeps that impossible, and the test
 * "the ref table names no credential parameter" checks it.
 */
export const REF_PARAMS = {
  'github_repo:view': ['branch'],
  'github_repo:branches': ['branch'],
  'github_repo:clone': ['branch'],
  'github_pr:list': ['base', 'head'],
  'github_pr:create': ['base', 'head'],
  'github_pr:edit': ['base'],
  'github_pr:checkout': ['branch'],
  'github_issue:develop': ['base'],
  'github_actions:list': ['branch'],
  'github_actions:dispatch': ['ref'],
  'github_release:create': ['target'],
}

/**
 * The one action whose branch filter defaults to the workspace branch.
 *
 * `github_actions list` exists to answer "why is CI red?" about the work in
 * front of you, so scoping it to the checked-out branch is what the caller
 * almost always means. `github_pr list` deliberately does NOT default: `gh pr
 * list` shows every open pull request, and a hidden base filter would remove the
 * very thing the list is for.
 */
const DEFAULTED_BRANCH_FILTERS = { 'github_actions:list': 'branch' }

/** Passing this for a defaulted filter asks for every branch instead. */
const ALL_BRANCHES = '*'

/**
 * Resolve `@current` / `@default` in the ref arguments of one action.
 *
 * Precedence is explicit value, then the workspace, then the repository — the
 * same shape `resolveRepo` uses, so the two feel alike to a caller. A sentinel
 * that cannot be resolved is LEFT AS WRITTEN rather than dropped, so the call
 * fails loudly at gh instead of quietly acting on the wrong ref.
 *
 * A LITERAL name is checked with `safeBranchName`, the same rule
 * `github_repo branches` has always applied, and a failure is REPORTED as a note.
 * Not applying it here left eleven ref arguments accepting shapes no branch can
 * have, with nothing telling a caller which rule applied where. It is a warning,
 * not a refusal: no shell is involved and gh reads a two-token `--flag value` as
 * one value, so the value is still forwarded and gh's own refusal — which names
 * the ref — reaches the caller. An empty string is left alone: the `needs` gate
 * already rejected it before this runs.
 *
 * @param {object} deps the resolution inputs
 * @param {string} deps.tool the tool name
 * @param {string} deps.action the action name
 * @param {any} deps.args the call arguments (mutated in place)
 * @param {import('./types.js').PluginConfig} deps.cfg the resolved config
 * @param {import('./types.js').Runner} deps.runner the process runner
 * @param {string} deps.cwd the workspace directory
 * @param {string} deps.repo the resolved `owner/name`, or ''
 * @returns {Promise<string[]>} notes about the defaults actually applied
 */
export async function resolveRefArgs({ tool, action, args, cfg, runner, cwd, repo }) {
  /** @type {string[]} */
  const notes = []
  const names = REF_PARAMS[`${tool}:${action}`]
  if (names === undefined) return notes

  for (const name of names) {
    const raw = args[name]
    const isDefaulted = DEFAULTED_BRANCH_FILTERS[`${tool}:${action}`] === name && raw === undefined
    if (raw === undefined && !isDefaulted) continue

    if (raw === ALL_BRANCHES && !isDefaulted) {
      // The escape hatch: drop the argument so gh applies no branch filter.
      delete args[name]
      notes.push(`${name}: every branch (filter removed)`)
      continue
    }

    let value = isDefaulted ? CURRENT_BRANCH : (typeof raw === 'string' ? raw.trim() : '')

    if (value === CURRENT_BRANCH) {
      const detected = await detectCurrentBranch(runner, cwd)
      if (detected === '') {
        notes.push(`${name}: @current requested, but the workspace has no checked-out branch`)
        continue
      }
      args[name] = detected
      notes.push(`${name}: ${detected} (current branch)`)
      continue
    }

    if (value === DEFAULT_BRANCH) {
      const resolved = await repoDefaultBranch(runner, repo, cfg)
      if (resolved === '') {
        notes.push(`${name}: @default requested, but the repository default branch could not be read`)
        continue
      }
      args[name] = resolved
      notes.push(`${name}: ${resolved} (repository default)`)
      continue
    }

    // A literal name is checked with the same rule `github_repo branches` applies,
    // and a failure is REPORTED rather than silently forwarded. It is not a refusal:
    // this path has no shell and gh reads a two-token `--flag value` as one value,
    // so a bad ref is not an injection — it is a value gh will reject with its own
    // message, which is more specific than anything this layer could invent. The
    // note exists so the model sees WHY the call failed instead of guessing.
    //
    // Leaving it out entirely (the previous behaviour) meant one rule applied in
    // one place and not in ten others, with nothing telling a caller which.
    if (!isDefaulted) {
      try {
        safeBranchName(value)
      } catch {
        notes.push(`${name}: ${JSON.stringify(value)} is not a well-formed ref name — gh will likely reject it`)
      }
    }
  }
  return notes
}

/**
 * Read a repository's default branch through gh.
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} repo `owner/name`
 * @param {import('./types.js').PluginConfig} cfg the resolved config
 * @returns {Promise<string>} the branch name, or ''
 */
async function repoDefaultBranch(runner, repo, cfg) {
  if (repo === '') return ''
  try {
    const result = await runner.run(
      ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      { timeoutMs: cfg.timeoutMs },
    )
    if (!result.ok) return ''
    return String(result.stdout ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * Whether any action in a domain is marked long enough to background.
 * @param {import('./types.js').DomainDef} domain the domain definition
 * @returns {boolean} true when the flag is worth declaring
 */
function domainCanBackground(domain) {
  return Object.values(domain.actions).some((action) => action.long === true)
}

/**
 * The canonical value for a call that was admitted as a background job.
 *
 * The handle lives in `data`, which is the schema's unconstrained slot, exactly
 * as the reference requires: a typed handle a program reads (`data.jobId`), plus
 * human text in `render`. PTC must never have to parse the text to recover the
 * id, and this shape is why it does not have to.
 *
 * @param {string} jobId the registry-issued id
 * @param {string} command the displayed command
 * @param {string} kind the job kind
 * @returns {any} a result value matching the output schema
 */
function backgroundHandle(jobId, command, kind) {
  return completed({
    ok: true,
    durationMs: 0,
    command,
    stdout: `started background job ${jobId}`,
    data: { kind: 'background', jobId, jobKind: kind },
  })
}

/**
 * The session id a job should be owned by, from the execution identity.
 *
 * `JobSpec.owner` is a SessionId, not an Agent: the registry resolves it with
 * `agents.get(session)` to find the live agent whose disposal cancels the job.
 * The execution identity's `agent` field is the Agent itself, so its `id` is the
 * value that resolves. The reference writes `owner: exec.agent`, which is why
 * this accepts a bare string too — shipping the object there produced
 * `session "[object Object]" has no live agent` on a real call.
 *
 * Returning `undefined` is a supported outcome: unowned work is listed for every
 * caller, and `resolveOwner` returns early rather than requiring an agent
 * registry. A composition with no agent registry would otherwise throw here.
 *
 * @param {any} exec the execution identity
 * @returns {string | undefined} the owning session id, when one is known
 */
export function ownerSessionOf(exec) {
  const agent = exec?.agent
  if (typeof agent === 'string') return agent === '' ? undefined : agent
  const id = agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Admit a long action as a background job.
 *
 * Follows the shipped convention rather than inventing one: `run_in_background`
 * returns the id at once, no background timeout applies, and the job is
 * collected with `job_output` and stopped with `job_kill`. The work is handed to
 * the registry's own cancel signal, NOT `exec.signal` — once an id is published
 * the call no longer owns that lifecycle, so aborting the tool call stops the
 * wait without killing a job the user can still see.
 *
 * @param {any} jobs the composed `ctx.jobs` service
 * @param {object} spec what to run
 * @param {string} spec.kind the job kind
 * @param {string} spec.label the human label
 * @param {any} spec.owner the owning agent (fences collected jobs per session)
 * @param {(signal: AbortSignal) => Promise<any>} spec.execute the work
 * @returns {string} the job id
 */
function startBackgroundJob(jobs, { kind, label, owner, execute }) {
  return jobs.start({
    kind,
    label,
    owner,
    run(job) {
      // Work starts HERE, not before. The registry validates the owner and the
      // task controller and only then calls `run()`, and its contract is that a
      // rejected preflight leaves no execution resource. Spawning before this
      // point would leak a live process into a job that was never admitted —
      // invisible to `job_list`, impossible for `job_kill` to reach.
      const controller = new AbortController()
      // Stream chunks into the job's output ring as they arrive. Without this a
      // background job would return an id whose `job_output` reads nothing,
      // which defeats the point of backgrounding a log download or a watch.
      const onOutput = (_channel, text) => job.append(text)
      job.updateProgress(label)
      const settled = execute(controller.signal, onOutput).catch((error) => ({
        ok: false,
        exitCode: -1,
        durationMs: 0,
        stderr: String(error?.message ?? error),
      }))
      return {
        // The registry stores the cancellation reason on the job record itself;
        // the process only needs the signal, and the runner escalates SIGTERM to
        // SIGKILL on its own.
        cancel: () => controller.abort(),
        done: settled.then((result) => ({
          status: result?.ok === true ? 'completed' : 'failed',
          detail: result?.ok === true
            ? `exit ${result.exitCode} in ${result.durationMs}ms`
            : (result?.stderr ?? '').split('\n')[0].slice(0, 200),
        })),
      }
    },
  })
}

/**
 * Methods that change state. Mirrors `lib/domains/api.js` so a write REST call
 * is asked about even though the action itself is not declared destructive.
 * @type {Set<string>}
 */
const API_WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Whether one call is destructive, given the action's own table entry.
 *
 * `github_api` cannot be classified statically: its single `request` action reads
 * when `method` is GET and writes otherwise, and `lib/domains/api.js` therefore
 * declares no `readOnlyActions` at all. Leaving it out of the approval map meant
 * the plugin's own argument — "`confirm` is intent, not consent" — was applied to
 * eleven actions and skipped for the least constrained one. This predicate is the
 * correction: read methods defer, write methods ask.
 *
 * @param {string | undefined} tool the tool name
 * @param {{ destructive?: boolean }} [action] the action table entry
 * @param {Record<string, any>} args the call arguments
 * @returns {boolean} whether a person must be asked before this runs
 */
export function isDestructiveCall(tool, action, args) {
  if (action?.destructive === true) return true
  if (tool === 'github_api') {
    return API_WRITE_METHODS.has(String(args?.method ?? 'GET').toUpperCase())
  }
  return false
}

/**
 * Ask the user before a destructive action, through the platform's approval
 * seam rather than a flag the model supplies by itself.
 *
 * This closes a real gap. `confirm: true` is the model stating its own intent —
 * it is not consent, and a model that decided to delete a repository could set
 * it without anyone being asked. The reference is explicit that deployment
 * policy should not be built into the tool: `tools/pre-execute` is the
 * extensible allow/deny/ask seam, and `ctx.tools.guard()` is for the final
 * monotonic denial this plugin uses for shell git.
 *
 * Layers, strongest first:
 *   1. `allowDestructive: false` — the hard stop, checked inside `execute`.
 *   2. this ask — a person sees the target and answers.
 *   3. `confirm: true` — the model's per-call intent, checked inside `execute`.
 *
 * Codex-style compositions with no approval service reject at (2), so the
 * remaining gates still hold; the ask never becomes a silent allow. Nested code
 * dispatch also skips the waterfall, so (1) and (3) are what protect a `run_code`
 * call, which is exactly why they stay inside `execute` instead of moving here.
 *
 * @param {any} ctx the plugin context
 * @param {import('./types.js').PluginConfig} cfg the resolved config
 * @returns {(() => void) | undefined} a disposer, when a gate was installed
 */
export function installDestructiveApproval(ctx, cfg) {
  if (cfg.approvalForDestructive !== true) return undefined
  // No `ctx.on` (a bare test context) or no approval seam: stay silent rather
  // than install a gate that cannot ask.
  if (typeof ctx?.on !== 'function') return undefined

  const destructive = new Map()
  for (const domain of DOMAINS) {
    for (const [actionName, action] of Object.entries(domain.actions)) {
      if (action.destructive === true) {
        // A destructive action that is somehow also declared read-only would
        // mean the concurrency classification and the safety classification
        // disagree; registration-time noise beats a silent wrong answer.
        if ((domain.readOnlyActions ?? []).includes(actionName)) {
          ctx.logger?.warn?.('github-toolkit: %s.%s is both destructive and read-only', domain.tool, actionName)
        }
        destructive.set(`${domain.tool}:${actionName}`, action)
      }
    }
  }

  const disposer = ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = exec?.name
    const action = destructive.get(`${tool}:${exec?.arguments?.action}`)
    const args = exec.arguments ?? {}
    // `github_api` has no entry in the map — its read/write nature depends on the
    // method argument — so it is decided here instead of by the map lookup.
    if (action === undefined && !isDestructiveCall(tool, undefined, args)) return next()
    const target = args.repo ?? args.path ?? args.runId ?? args.number ?? '(current repository)'
    const outcome = await next()
    // Only ask when the call is actually going to run: a call that the seam
    // already denied, or that `execute` will reject for a missing parameter,
    // must not produce a prompt about work that cannot happen.
    if (outcome?.kind !== 'allow') return outcome
    const verb = tool === 'github_api' ? `REST ${String(args.method ?? 'GET').toUpperCase()}` : `${tool}:${exec?.arguments?.action}`
    return {
      kind: 'ask',
      reason: `Destructive GitHub action ${verb} on ${String(target)}.`,
    }
  })
  return typeof disposer === 'function' ? disposer : undefined
}

/**
 * Gate 1 (destructive) and gate 2 (required parameters).
 *
 * Kept together because they are both pure argument checks with no I/O, and they
 * must run in this order: a destructive action reports the missing confirmation
 * first, which is the more actionable message.
 *
 * @param {any} action the action definition
 * @param {Record<string, any>} args the call arguments
 * @param {import('./types.js').PluginConfig} cfg the resolved config
 * @returns {any | undefined} a rejection result, or undefined when both pass
 */
function checkGates(action, args, cfg) {
  // Gate 1: destructive actions.
  if (action.destructive === true) {
    if (cfg.allowDestructive !== true) {
      return fail(
        `Action "${args.action}" is destructive and the plugin config has allowDestructive: false. ` +
          'Enable it in the plugin config to permit this operation.',
      )
    }
    if (args.confirm !== true) {
      return fail(
        `Action "${args.action}" is destructive — call it again with confirm: true to proceed. ` +
          'Review the target (repo/ref/run) before confirming.',
      )
    }
  }

  // Gate 2: required parameters. Presence only, so it can run before the ref
  // sentinels are resolved — a sentinel is a non-empty string and satisfies
  // `needs` exactly as a literal branch name does.
  for (const key of action.needs ?? []) {
    const value = args[key]
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      return fail(`Action "${args.action}" requires parameter \`${key}\` (missing or empty).`)
    }
  }
  return undefined
}

/**
 * Resolve the repository a call targets.
 *
 * Precedence is explicit argument, then config default, then the workspace
 * remote — never invented. An action that declares `requiresRepo` is refused when
 * none of the three produces a value.
 *
 * @param {object} input the resolution inputs
 * @param {any} input.action the action definition
 * @param {Record<string, any>} input.args the call arguments
 * @param {import('./types.js').PluginConfig} input.cfg the resolved config
 * @param {import('./types.js').Runner} input.runner the process runner
 * @param {string} input.cwd the workspace directory
 * @returns {Promise<{ repo: string } | { rejection: any }>} the repository, or a refusal
 */
async function resolveActionRepo({ action, args, cfg, runner, cwd }) {
  const repo = action.requiresRepo === true
    ? await resolveRepo({ args, cfg, runner, cwd })
    : (typeof args.repo === 'string' && args.repo.trim() !== '' ? args.repo.trim() : cfg.defaultRepo)
  if (action.requiresRepo === true && repo === '') {
    return {
      rejection: fail(
        `Action "${args.action}" requires a repository: pass \`repo\` as "owner/name", set the plugin ` +
          'config defaultRepo, or run inside a workspace whose git remote points at GitHub.',
      ),
    }
  }
  return { repo }
}

/**
 * Append the flags the registry owns, after the domain's own arguments.
 *
 * `--repo` first, then `--json`/`--jq`, because gh accepts its persistent flag in
 * any position (verified against gh 2.89.0 for view/list/run/release forms) and
 * appending keeps a domain's builder readable without an inserted flag splitting
 * its positionals.
 *
 * @param {string[]} argv the domain-built argv (mutated)
 * @param {any} domain the domain definition
 * @param {any} action the action definition
 * @param {string} repo the resolved repository, or ''
 * @returns {string[]} the same array, for chaining
 */
function appendRegistryFlags(argv, domain, action, repo) {
  if (domain.globalRepoFlag === true && repo !== '') argv.push('--repo', repo)
  if (typeof action.json === 'string') {
    argv.push('--json', action.json)
    if (typeof action.jq === 'string' && action.jq !== '') argv.push('--jq', action.jq)
  }
  return argv
}

/**
 * The timeout budget for one call.
 *
 * A per-call `timeoutMs` wins; otherwise a `long` action gets `watchTimeoutMs`.
 * @param {any} action the action definition
 * @param {Record<string, any>} args the call arguments
 * @param {import('./types.js').PluginConfig} cfg the resolved config
 * @returns {number} milliseconds
 */
function timeoutFor(action, args, cfg) {
  if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) return args.timeoutMs
  return action.long === true ? cfg.watchTimeoutMs : cfg.timeoutMs
}

/**
 * The executable path for a domain, matching what the runner would spawn.
 *
 * Delegates to the runner's own `executableFor` so a background job's label cannot
 * name a binary the run did not use.
 *
 * @param {any} domain the domain definition
 * @param {import('./types.js').PluginConfig} cfg the resolved config
 * @returns {string} the executable
 */
function domainExecutable(domain, cfg) {
  return executableFor(cfg, domain.bin === 'git' ? 'git' : 'gh')
}

/**
 * Run one argv through the runner the domain selects.
 * @param {object} input the run inputs
 * @param {any} input.domain the domain definition
 * @param {import('./types.js').Runner} input.runner the process runner
 * @param {string[]} input.argv the argv to run
 * @param {any} input.exec the execution identity
 * @param {number} input.timeoutMs the timeout budget
 * @param {string} input.cwd the workspace directory
 * @returns {Promise<any>} the run result
 */
function runArgv({ domain, runner, argv, exec, timeoutMs, cwd }) {
  return domain.bin === 'git'
    ? runner.runGit(argv, { exec, timeoutMs, cwd })
    : runner.run(argv, { exec, timeoutMs, cwd })
}

/**
 * Admit a `run_in_background` call, or explain why it cannot be admitted.
 *
 * The flag is only honoured for a `long` action, so a caller cannot turn a cheap
 * read into an unkillable job by passing it.
 *
 * @param {object} input the admission inputs
 * @param {any} input.action the action definition
 * @param {any} input.domain the domain definition
 * @param {Record<string, any>} input.args the call arguments
 * @param {string[]} input.argv the argv to run in the background
 * @param {any} input.deps the dependency bag (carries the job registry)
 * @param {any} input.exec the execution identity
 * @param {any} input.runner the process runner
 * @param {import('./types.js').PluginConfig} input.cfg the resolved config
 * @param {string} input.cwd the workspace directory
 * @returns {any} a background handle, or a rejection explaining the refusal
 */
function admitBackground({ action, domain, args, argv, deps, exec, runner, cfg, cwd }) {
  if (action.long !== true) {
    return fail(
      `Action "${args.action}" is not long-running, so run_in_background does not apply. ` +
        'Drop the flag and call it normally.',
    )
  }
  const jobs = deps.jobs
  if (jobs === undefined || typeof jobs.start !== 'function') {
    return fail(
      'background jobs unavailable: load a job registry (for example @deepseek-ai/dsh-jobs ' +
        'with a runtime such as @deepseek-ai/dsh-jobs-local) and retry, or drop ' +
        'run_in_background to run it in the foreground.',
    )
  }
  const display = displayArgv(domainExecutable(domain, cfg), argv)
  const jobId = startBackgroundJob(jobs, {
    kind: 'github',
    label: display,
    owner: ownerSessionOf(exec),
    execute: (signal, onOutput) => domain.bin === 'git'
      ? runner.runGit(argv, { exec: { signal }, noTimeout: true, cwd, onOutput })
      : runner.run(argv, { exec: { signal }, noTimeout: true, cwd, onOutput }),
  })
  return backgroundHandle(jobId, display, 'github')
}

/**
 * Turn a completed run into the model-facing result.
 *
 * Two pieces of guidance are added here rather than in the runner, because both
 * are about what the MODEL should do next:
 *
 * 1. A missing `gh` is an infrastructure failure, not a tool outcome, so it is
 *    thrown with install instructions instead of returned as a failed command.
 * 2. An authentication failure gains a hint naming the tool that diagnoses it.
 *
 * The ref notes are prepended to stdout because a filter the plugin chose for the
 * caller must be STATED — a list that quietly narrows is how a caller concludes
 * "there is nothing there" when there is.
 *
 * @param {any} result the run result (mutated)
 * @param {string[]} refNotes notes about refs the plugin resolved
 * @param {any} runner the process runner, for the availability probe
 * @returns {Promise<any>} the result to return
 */
async function finalizeRun(result, refNotes, runner) {
  if (result.exitCode === -1 && /failed to (run|spawn)/.test(result.stderr)) {
    await runner.probe()
    throw new GhMissingError(result.stderr.replace(/^failed to (run|spawn) [^:]*: /, ''))
  }
  if (!result.ok && /not logged into|authentication required|requires authentication|GH_TOKEN|bad credentials|gh auth login/i.test(result.stderr + result.stdout)) {
    result.stderr = (result.stderr ? result.stderr + '\n' : '') +
      '[hint] No usable GitHub credential was found. Call github_auth with action "status" to inspect the ' +
      'credential chain, or action "login" to authorize through GitHub Device Flow.'
  }
  if (refNotes.length > 0) {
    const note = refNotes.map((line) => `[ref] ${line}`).join('\n')
    result.stdout = result.stdout === '' ? note : `${note}\n${result.stdout}`
  }
  return result
}

/**
 * Build the `defineTool` definition for one domain.
 *
 * Every github_* tool is the same shape: a closed action enum, the unified result
 * schema, the shared renderers, and an `execute` that runs the gates and then
 * dispatches. Spelling that out once here is what lets the registration loop stay
 * a loop.
 *
 * @param {object} input the definition inputs
 * @param {any} input.domain the domain definition
 * @param {import('./types.js').PluginConfig} input.cfg the resolved config
 * @param {import('./types.js').Runner} input.runner the process runner
 * @param {Record<string, any>} input.deps the dependency bag
 * @param {string} input.cwd the workspace directory
 * @returns {any} the definition passed to `defineTool`
 */
function defineDomainTool({ domain, cfg, runner, deps, cwd }) {
  return {
        name: domain.tool,
        description: describe(domain),
        parameters: buildParameters(domain, domainCanBackground(domain)),
        output: {
          schema: RESULT_VALUE_SCHEMA,
          render: renderResult,
          presentationMeta: projectResultMeta,
        },
        presentCall: (args) => ({
          card: 'generic',
          title: `GitHub · ${domain.tool.replace('github_', '')} ${String(args?.action ?? '')}`.trim(),
          kind: callKind(domain, args?.action),
          rawInput: sanitizeArgs(args ?? {}),
        }),
        presentResult,
        // Independent reads may run in parallel; anything that changes remote
        // state or the local filesystem stays serialised. The predicate receives
        // the raw arguments, so an unrecognised action is never treated as safe —
        // which is why `github_api` (read-only only when its METHOD says so)
        // declares no read-only actions at all.
        isConcurrencySafe: (args) => (domain.readOnlyActions ?? []).includes(args?.action),
        async execute(args, exec) {
          const action = domain.actions[args.action]
          // Unreachable through the registry, which enforces the enum. Kept as a
          // guard for a direct `execute` call (tests, PTC) so a bad action can
          // never fall through to `action.argv` and throw a TypeError.
          if (action === undefined) return fail(`Unknown action ${JSON.stringify(args.action)}.`)

          const rejected = checkGates(action, args, cfg)
          if (rejected !== undefined) return rejected

          const resolved = await resolveActionRepo({ action, args, cfg, runner, cwd })
          if (resolved.rejection !== undefined) return resolved.rejection
          const { repo } = resolved

          // The registry freezes `arguments` before dispatch ("the registry
          // materializes arguments as detached lossless JSON and freezes that
          // value before policy begins"), so this is a working copy. Writing the
          // resolved refs back into the frozen object throws
          // `Cannot assign to read only property` — measured, on a live call.
          const callArgs = { ...args }

          // Ref resolution: `@current` and `@default` become real branch names, and
          // github_actions list defaults its branch filter to the workspace branch.
          // Before argv construction, so a domain builder only ever sees a concrete name.
          const refNotes = await resolveRefArgs({
            tool: domain.tool,
            action: args.action,
            args: callArgs,
            cfg,
            runner,
            cwd,
            repo,
          })

          // Validation runs on the RESOLVED values, so a name that a sentinel
          // produced is checked by the same rule as one the caller typed.
          const checkError = action.check?.(callArgs)
          if (checkError !== undefined && checkError !== null) return fail(checkError)

          // An action may own its execution when it cannot be expressed as one argv
          // (github_auth login runs a multi-request Device Flow handshake). The gates
          // above have already run, so a custom handler cannot bypass them.
          if (typeof action.custom === 'function') {
            return action.custom({ args: callArgs, cfg, repo, deps, exec, cwd })
          }

          // A domain may own execution for every action at once, which is how
          // github_api talks to the REST transport instead of spawning a process.
          if (typeof domain.execute === 'function') {
            return domain.execute({ args: callArgs, action, cfg, deps, exec, cwd })
          }

          // argv construction. A definition may abort by returning `{ error }`.
          const argv = action.argv(callArgs, cfg, repo)
          if (!Array.isArray(argv)) return fail(argv.error ?? 'command construction failed')
          if (argv.length === 0) return fail('constructed an empty command')
          appendRegistryFlags(argv, domain, action, repo)

          const timeoutMs = timeoutFor(action, callArgs, cfg)

          if (callArgs.run_in_background === true) {
            return admitBackground({ action, domain, args, argv, deps, exec, runner, cfg, cwd })
          }

          const result = await runArgv({ domain, runner, argv, exec, timeoutMs, cwd })
          return finalizeRun(result, refNotes, runner)
        },
  }
}

/**
 * Register every domain tool on `ctx.tools`.
 *
 * @param {any} ctx the plugin context (carries `ctx.tools`)
 * @param {import('./types.js').PluginConfig} cfg the resolved config
 * @param {import('./types.js').Runner} runner the process runner
 * @param {object} [options] workspace and dependency hints
 * @param {string} [options.cwd] the workspace directory for git resolution
 * @param {() => Promise<string>} [options.resolveToken] credential lookup for REST domains
 * @param {typeof globalThis.fetch} [options.fetch] injectable fetch for tests
 * @param {Record<string, unknown>} [options.deps] extra capabilities a domain may own
 * @returns {string[]} the names actually registered
 */
export function registerDomainTools(ctx, cfg, runner, options = {}) {
  /** @type {string[]} */
  const registered = []
  const cwd = options.cwd ?? globalThis.process?.cwd?.() ?? '.'
  const deps = {
    resolveToken: options.resolveToken ?? (async () => ''),
    fetch: options.fetch ?? globalThis.fetch,
    runner,
    cfg,
    // Optional: without a composed job registry, `run_in_background` reports
    // that it is unavailable rather than silently running in the foreground.
    jobs: options.deps?.jobs ?? ctx.get?.('jobs'),
    ...(options.deps ?? {}),
  }

  for (const domain of DOMAINS) {
    if (domain.gated === true && cfg.allowRawApi !== true) continue

    ctx.tools.register(defineTool(defineDomainTool({ domain, cfg, runner, deps, cwd })))

    registered.push(domain.tool)
    ctx.logger?.info?.('registered tool %s (%d actions)', domain.tool, Object.keys(domain.actions).length)
  }

  if (!cfg.allowRawApi) {
    ctx.logger?.info?.('github_api (guarded raw REST) not registered — set allowRawApi: true in config to enable')
  }
  return registered
}

/** Exported for tests: the domains this plugin registers, in order. */
export { DOMAINS, DOMAINS as ALL_DOMAINS }
