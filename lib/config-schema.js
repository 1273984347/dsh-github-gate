/**
 * Plugin configuration, expressed as a Schemastery schema.
 *
 * The dev guide (`develop/basic/config`) states the Harness convention plainly:
 * 凡是不同部署可能需要采用不同值的参数，都必须定义为配置字段 — every value a
 * different deployment might need to change must be a config field — and the
 * schema should carry the constraint so an invalid configuration fails AT LOAD
 * TIME with a clear message rather than degrading silently at run time.
 *
 * Declaring `Config` is what activates that: Cordis validates the row's `config`
 * against this schema when the plugin activates and fills in defaults for absent
 * fields. Without it, a value like `{ timeoutMs: 'abc' }` would surface only when
 * the first command ran, and a malformed `defaultRepo` would silently resolve to
 * nothing instead of telling the operator what is wrong.
 *
 * Two implementation notes, both established by running the library rather than
 * by assuming (see tools/probe-schemastery.mjs):
 *
 * 1. `@deepseek-ai/schemastery@3.18.4` exposes its entry as the **Standard
 *    Schema** symbol `schema['~standard'].validate(input)`, which returns
 *    `{ value }` or `{ issues }`. There is no `schema.parse()`.
 * 2. `.default(x)` takes a LITERAL value, not a factory. `.default(() => ({}))`
 *    would hand the plugin a function; `.default({})` is correct.
 * 3. A `.pattern()` must accept the field's OWN default, or an empty
 *    `config: {}` row fails validation. `defaultRepo` therefore allows empty.
 *
 * Each field carries its own default, and an object-level `.default(...)` is
 * avoided entirely for the same reason as (2).
 *
 * The schema imports `@deepseek-ai/schemastery`, which the dsh installation
 * itself ships; a profile-installed bundle resolves it through the runtime
 * resolution the launcher installs on Node's resolvers, so this manifest
 * declares no dependency for it.
 */

import Schema from '@deepseek-ai/schemastery'

/**
 * The plugin's configuration surface.
 *
 * @typedef {object} Config
 * @property {string} ghPath explicit gh executable; empty probes PATH
 * @property {string} gitPath explicit git executable; empty probes PATH
 * @property {string} defaultRepo fallback `owner/name` when a call omits `repo`
 * @property {boolean} verifyGhVersion warn at activation when gh is older than minGhVersion
 * @property {string} minGhVersion the minimum gh version this plugin expects
 * @property {string} credentialRef credentials-store reference for the token
 * @property {number} timeoutMs default per-command timeout
 * @property {number} watchTimeoutMs timeout for watch/log actions
 * @property {number} maxOutputBytes in-memory cap before output spills to a file
 * @property {number} killGraceMs SIGTERM-to-SIGKILL escalation window
 * @property {string} apiBaseURL REST root (GHES: `https://ghe.example.com/api/v3`)
 * @property {string} authBaseURL OAuth host, NOT the API host
 * @property {string} deviceFlowClientId your own OAuth App client id
 * @property {string} deviceFlowScope scope requested by Device Flow
 * @property {boolean} allowDestructive master switch for destructive actions
 * @property {boolean} allowRawApi register the github_api tool
 * @property {boolean} blockShellGit deny shell-level git mutations through a guard
 * @property {Record<string, string>} env extra environment for child processes
 */

/** The output-cap floor, mirrored from lib/schema.js. */
const MIN_OUTPUT_BYTES = 1_024

/**
 * The configuration schema.
 *
 * Every field carries its own default, so an empty `config: {}` row is valid and
 * fully populated. The constraints are exactly the ones that would otherwise
 * produce a confusing failure later: a timeout of NaN, a zero output cap, a
 * `defaultRepo` that is not `owner/name`, a credential ref that cannot name an
 * environment variable, or a `killGraceMs` large enough to outlive a turn.
 */
export const Config = Schema.object({
  ghPath: Schema.string()
    .description('Explicit gh executable path. Leave empty to probe PATH.')
    .default(''),
  gitPath: Schema.string()
    .description('Explicit git executable path. Leave empty to probe PATH.')
    .default(''),
  defaultRepo: Schema.string()
    // Empty is the DEFAULT and is valid ("detect from the workspace remote"),
    // so the pattern must accept it — a pattern that rejected its own default
    // would make an empty `config: {}` row fail validation at activation.
    .pattern(/^$|^[^\s/]+\/[^\s/]+$/)
    .description('Fallback repository as "owner/name" when a call omits `repo`. Leave empty to detect from the workspace remote.')
    .default(''),
  verifyGhVersion: Schema.boolean()
    .description('Warn at activation when the installed gh is older than minGhVersion.')
    .default(true),
  minGhVersion: Schema.string()
    .description('Minimum gh version this plugin expects when verifyGhVersion is on.')
    .default('2.0.0'),
  credentialRef: Schema.string()
    .pattern(/^[A-Z][A-Z0-9_]*$/)
    .description('Credentials-store reference the token is stored under and resolved from. Must look like an environment variable name.')
    .default('GITHUB_TOKEN'),
  timeoutMs: Schema.natural()
    .min(1_000).max(600_000)
    .description('Default per-command timeout in milliseconds.')
    .default(60_000),
  watchTimeoutMs: Schema.natural()
    .min(1_000).max(600_000)
    .description('Timeout for watch/log style actions in milliseconds.')
    .default(300_000),
  maxOutputBytes: Schema.natural()
    .min(MIN_OUTPUT_BYTES).max(64 * 1024 * 1024)
    .description('In-memory output cap in bytes before spilling to a file.')
    .default(65_536),
  killGraceMs: Schema.natural()
    .min(0).max(60_000)
    .description('SIGTERM-to-SIGKILL escalation window in milliseconds. Zero kills immediately.')
    .default(2_000),
  apiBaseURL: Schema.string()
    .description('REST API root. For GHES use e.g. https://ghe.example.com/api/v3.')
    .default('https://api.github.com'),
  authBaseURL: Schema.string()
    .description('OAuth host for Device Flow. This is NOT the API host.')
    .default('https://github.com'),
  deviceFlowClientId: Schema.string()
    .description('Your own OAuth App client id (Device Flow enabled). Left empty on purpose: a client id identifies the app registration your authorization is granted to, so a built-in one would route users through someone else\'s application.')
    .default(''),
  deviceFlowScope: Schema.string()
    .description('OAuth scope requested by Device Flow.')
    .default('repo'),
  allowDestructive: Schema.boolean()
    .description('Master switch for destructive actions such as merge, delete, and force-push.')
    .default(true),
  approvalForDestructive: Schema.boolean()
    .description('Ask the user through the approval seam before a destructive action runs. Turn off only for unattended automation that already gates elsewhere.')
    .default(true),
  allowRawApi: Schema.boolean()
    .description('Register the github_api tool, which can issue a raw REST request.')
    .default(true),
  blockShellGit: Schema.boolean()
    .description('Deny shell-level git commit/push/merge through a tools guard. Off by default because dsh already owns permissions.')
    .default(false),
  env: Schema.dict(String)
    // A plain value, NOT a factory: this schemastery version treats
    // `.default(fn)` as the literal default, so a factory would be handed to
    // the plugin as a function. normalizeConfig copies the map, so the shared
    // default object is never mutated.
    .description('Extra environment variables for child processes.')
    .default({}),
})

export default Config
