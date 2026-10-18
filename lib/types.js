/**
 * Shared type vocabulary. Types only — this module emits no runtime code, so
 * importing it never pulls a dependency into the bundle.
 *
 * @module dsh-github-gate/types
 */

/**
 * Resolved plugin configuration. Every field is populated and normalized by
 * `normalizeConfig`, so consumers never re-check for undefined.
 * @typedef {object} PluginConfig
 * @property {string} ghPath explicit gh executable, or '' to probe PATH
 * @property {string} gitPath explicit git executable, or '' to probe PATH
 * @property {string} defaultRepo fallback `owner/name` when a call omits `repo`
 * @property {boolean} verifyGhVersion warn at activation when gh is older than minGhVersion
 * @property {string} minGhVersion the minimum gh version this plugin expects
 * @property {string} credentialRef credentials-seam reference for the token
 * @property {number} timeoutMs default per-command timeout
 * @property {number} watchTimeoutMs timeout for watch/log style actions
 * @property {number} maxOutputBytes in-memory output cap before spilling
 * @property {number} killGraceMs SIGTERM→SIGKILL escalation window
 * @property {string} apiBaseURL REST root, GHES-aware
 * @property {string} authBaseURL OAuth host (NOT the API host)
 * @property {string} deviceFlowClientId public OAuth App client id
 * @property {string} deviceFlowScope requested OAuth scope
 * @property {boolean} allowDestructive master switch for destructive actions
 * @property {boolean} allowRawApi register the guarded raw REST tool
 * @property {boolean} blockShellGit deny shell git mutations through a guard
 * @property {Record<string, string>} env extra environment for child processes
 */

/**
 * Options accepted by a single run.
 * @typedef {object} RunOptions
 * @property {{ signal?: AbortSignal } | undefined} [exec] tool execution context
 * @property {number} [timeoutMs] per-call timeout override
 * @property {string} [cwd] working directory for the child
 * @property {string} [stdin] text written to the child's stdin
 * @property {boolean} [internal] skip the credential fallback (probe calls)
 */

/**
 * One process outcome. Shape mirrors the tool result value exactly.
 * @typedef {object} RunResult
 * @property {boolean} ok true only when the exit code was 0 and no timeout fired
 * @property {number} exitCode process exit code, -1 when killed or unspawnable
 * @property {string} signal termination signal, or `killed(<reason>)`
 * @property {boolean} timedOut whether the plugin killed the process
 * @property {number} durationMs wall-clock duration
 * @property {string} command the displayed command line
 * @property {string} stdout captured standard output
 * @property {string} stderr captured standard error
 * @property {boolean} truncated whether output exceeded the cap
 * @property {string} spillPath file holding the overflow, or ''
 * @property {unknown} [data] parsed JSON payload when the output was JSON
 */

/**
 * The process runner surface.
 * @typedef {object} Runner
 * @property {(argv: string[], options?: RunOptions) => Promise<RunResult>} run
 * @property {(argv: string[], options?: RunOptions) => Promise<RunResult>} runGit
 * @property {() => Promise<{ available: boolean, version: string, error?: string }>} probe
 */

/**
 * One property in the author-facing parameter DSL consumed by `defineTool`.
 *
 * `required` is a DSL-level flag (not a JSON Schema keyword); the compiler lifts
 * it into the parent object's `required` array. `enum` carries the closed value
 * set, and `items` describes an array element.
 *
 * @typedef {object} ParamSpec
 * @property {string} [type] one of the DSL types; `json` means any JSON value
 * @property {boolean} [required] whether the parent must carry this property
 * @property {string} [description] model-facing description
 * @property {(string|number|boolean|null)[]} [enum] closed value set
 * @property {ParamSpec} [items] element spec for an array
 * @property {Record<string, ParamSpec>} [properties] field specs for an object
 * @property {boolean} [additionalProperties] object openness
 * @property {ParamSpec[]} [oneOf] exactly-one union branches
 * @property {string|number|boolean|null} [const] a single accepted value
 */

/**
 * One action inside a domain.
 * @typedef {object} ActionDef
 * @property {string} help one-line catalog entry shown to the model
 * @property {string[]} [needs] parameters that must be present and non-empty
 * @property {(args: any) => string | null} [check] extra validation; a string is the error
 * @property {(args: any, cfg: PluginConfig, repo: string) => string[] | { error: string }} [argv]
 * @property {boolean} [destructive] requires confirm AND allowDestructive
 * @property {boolean} [long] uses watchTimeoutMs instead of timeoutMs
 * @property {string} [json] comma-separated gh --json fields
 * @property {string} [jq] default --jq filter
 * @property {boolean} [requiresRepo] rejects when no repo can be resolved
 * @property {(input: { args: any, cfg: PluginConfig, repo: string, deps: any, exec: any, cwd: string }) => Promise<any>} [custom] own execution instead of one argv
 */

/**
 * One tool: a set of actions sharing a parameter map.
 * @typedef {object} DomainDef
 * @property {string} tool the registered tool name
 * @property {string} title short human label
 * @property {'gh'|'git'} [bin] which executable runs the argv (default 'gh')
 * @property {string} description model-facing description
 * @property {Record<string, ParamSpec>} params parameter specs in the DSL
 * @property {Record<string, ActionDef>} actions action table
 * @property {boolean} [gated] only registered when allowRawApi is true
 * @property {boolean} [globalRepoFlag] repository selection uses gh's --repo
 * @property {(input: { args: any, action: ActionDef, cfg: PluginConfig, deps: any, exec: any, cwd: string }) => Promise<any>} [execute] own execution for every action
 */

export {}
