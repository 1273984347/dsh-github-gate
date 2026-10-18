/**
 * Config normalization on top of the Schemastery schema.
 *
 * The schema (lib/config-schema.js) owns the substance: which keys exist, what
 * their types and bounds are, and what an absent key defaults to. Cordis runs it
 * when the plugin activates, so an invalid row fails at load time with a clear
 * message instead of degrading silently at run time.
 *
 * This module does the part a schema should not: whitespace trimming and
 * trailing-slash removal, which are shape normalizations rather than
 * constraints. It is deliberately defensive — if the schema somehow did not
 * populate a field, a sane value is used, because a plugin that crashes on
 * activation takes the whole profile down with it.
 */

/** The output-cap floor. Mirrors the schema. */
const MIN_OUTPUT_BYTES = 1_024

/** Smallest accepted timeout; below this a spawn cannot plausibly complete. */
export const MIN_TIMEOUT_MS = 1_000

/** Upper bound shared by every command timeout, matching the host's own cap. */
export const MAX_TIMEOUT_MS = 600_000

/** Fallbacks, used only if a schema default was somehow absent. */
const FALLBACKS = {
  timeoutMs: 60_000,
  watchTimeoutMs: 300_000,
  maxOutputBytes: 65_536,
  killGraceMs: 2_000,
  credentialRef: 'GITHUB_TOKEN',
  apiBaseURL: 'https://api.github.com',
  authBaseURL: 'https://github.com',
}

/**
 * Clamp one timeout into the accepted window.
 *
 * `setTimeout(fn, NaN)` fires after ~1 ms in Node, so an unclamped non-finite
 * value would turn every command into an instant timeout. The schema rejects
 * those already; this is the second line.
 *
 * @param {unknown} value the configured value
 * @param {number} fallback used when the value is unusable
 * @returns {number} a finite timeout inside `[MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]`
 */
export function clampTimeout(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_TIMEOUT_MS) return fallback
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS)
}

/**
 * Drop trailing slashes so `https://ghe.example.com/api/v3/` and its bare form
 * join paths identically.
 * @param {string} value the configured base URL
 * @returns {string} the base without trailing slashes
 */
function trimTrailingSlashes(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : value
}

/**
 * Read a trimmed string, falling back when the result is blank.
 * @param {unknown} value the configured value
 * @param {string} fallback used when the value is absent or blank
 * @returns {string} the resolved string
 */
function str(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * Read a trimmed string, allowing an empty result (used for keys whose empty
 * value is meaningful, such as "probe PATH" or "detect from the remote").
 * @param {unknown} value the configured value
 * @returns {string} the trimmed string, or '' when absent
 */
function optionalStr(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read a boolean, or the fallback.
 * @param {unknown} value the configured value
 * @param {unknown} fallback used when the value is not a boolean
 * @returns {boolean} the resolved flag
 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize a schema-validated config for runtime use.
 * @param {unknown} raw the config Cordis produced from the row and the schema
 * @returns {any} the config with normalized strings and clamped numbers
 */
export function normalizeConfig(raw) {
  const input = typeof raw === 'object' && raw !== null ? raw : {}
  const envInput = input.env
  /** @type {Record<string, string>} */
  const env = {}
  if (typeof envInput === 'object' && envInput !== null) {
    for (const [key, value] of Object.entries(envInput)) {
      if (typeof value === 'string') env[key] = value
    }
  }

  return {
    ghPath: optionalStr(input.ghPath),
    gitPath: optionalStr(input.gitPath),
    defaultRepo: optionalStr(input.defaultRepo),
    verifyGhVersion: bool(input.verifyGhVersion, true),
    minGhVersion: str(input.minGhVersion, '2.0.0'),
    credentialRef: str(input.credentialRef, FALLBACKS.credentialRef),
    timeoutMs: clampTimeout(input.timeoutMs, FALLBACKS.timeoutMs),
    watchTimeoutMs: clampTimeout(input.watchTimeoutMs, FALLBACKS.watchTimeoutMs),
    maxOutputBytes: Number.isFinite(input.maxOutputBytes) && input.maxOutputBytes >= MIN_OUTPUT_BYTES
      ? Math.min(Math.floor(input.maxOutputBytes), 64 * 1024 * 1024)
      : FALLBACKS.maxOutputBytes,
    killGraceMs: Number.isFinite(input.killGraceMs) && input.killGraceMs >= 0
      ? Math.min(Math.floor(input.killGraceMs), 60_000)
      : FALLBACKS.killGraceMs,
    apiBaseURL: trimTrailingSlashes(str(input.apiBaseURL, FALLBACKS.apiBaseURL)),
    authBaseURL: trimTrailingSlashes(str(input.authBaseURL, FALLBACKS.authBaseURL)),
    deviceFlowClientId: optionalStr(input.deviceFlowClientId),
    deviceFlowScope: str(input.deviceFlowScope, 'repo'),
    allowDestructive: bool(input.allowDestructive, true),
    approvalForDestructive: bool(input.approvalForDestructive, true),
    allowRawApi: bool(input.allowRawApi, true),
    blockShellGit: bool(input.blockShellGit, false),
    updateCheck: bool(input.updateCheck, false),
    updateRepo: optionalStr(input.updateRepo),
    updateChannel: input.updateChannel === 'latest' ? 'latest' : 'stable',
    updateCacheDir: optionalStr(input.updateCacheDir),
    env,
  }
}

export default normalizeConfig
