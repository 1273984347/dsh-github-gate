/**
 * The one result shape every `github_*` tool returns.
 *
 * ## Why this module exists
 *
 * The shape is a contract: `RESULT_VALUE_SCHEMA` declares it, `renderResult`
 * renders it, and the offline suite asserts every real return value carries the
 * exact keys. It was previously constructed by hand in five places — the registry's
 * rejection path, `github_api`'s, `github_auth`'s, the credential-chain reporter,
 * and the Device Flow login — which is five chances to forget `truncated` or to
 * spell `spillPath` differently.
 *
 * A builder also makes the DIFFERENCE between those paths explicit. A rejection
 * before execution and a command that ran both need every field; they differ only
 * in what `command` says and what `durationMs` means. `rejection()` and
 * `completed()` say that in one place instead of leaving it to five readers to
 * notice.
 *
 * @module dsh-github-gate/result
 */

/**
 * The exact keys every result value carries, in schema order.
 *
 * Kept here rather than in `schema.js` so the builder and the list cannot drift:
 * a field added to one is a field added to both.
 * @type {readonly string[]}
 */
export const RESULT_KEYS = Object.freeze([
  'ok',
  'exitCode',
  'signal',
  'timedOut',
  'durationMs',
  'command',
  'stdout',
  'stderr',
  'truncated',
  'spillPath',
])

/** The `command` text used by every pre-execution rejection. */
export const REJECTED_COMMAND = '(rejected before execution)'

/**
 * A rejection that happened before any process was spawned.
 *
 * `ok` is false and `exitCode` is -1 because nothing ran — the same values a
 * killed or unspawnable process reports, which is why callers can treat "did not
 * run" and "ran badly" with one branch.
 *
 * @param {string} message the model-facing reason
 * @param {object} [options] presentation overrides
 * @param {string} [options.command] what the `command` field should say, when the
 *   rejection is not a plain argument refusal (a Device Flow handshake, say)
 * @param {number} [options.durationMs] wall-clock time spent before rejecting
 * @param {Record<string, unknown>} [options.data] a structured payload, if any
 * @returns {any} a RESULT_SCHEMA-shaped value
 */
export function rejection(message, options = {}) {
  const value = {
    ok: false,
    exitCode: -1,
    signal: '',
    timedOut: false,
    durationMs: options.durationMs ?? 0,
    command: options.command ?? REJECTED_COMMAND,
    stdout: '',
    stderr: String(message),
    truncated: false,
    spillPath: '',
  }
  if (options.data !== undefined) value.data = options.data
  return value
}

/**
 * A completed call that did not go through the process runner.
 *
 * Three actions build their own outcome: `github_auth status` (resolved in
 * process), `github_auth login` (a multi-request handshake), and the background
 * admission (which returns a job id). Each used to spell the whole shape out.
 *
 * @param {object} input the outcome
 * @param {boolean} input.ok whether the operation succeeded
 * @param {number} input.durationMs wall-clock duration
 * @param {string} input.command the display command
 * @param {string} [input.stdout] captured or synthesized standard output
 * @param {string} [input.stderr] captured or synthesized standard error
 * @param {number} [input.exitCode] exit code; 0 or 1 when derived from `ok`
 * @param {Record<string, unknown>} [input.data] a structured payload
 * @returns {any} a RESULT_SCHEMA-shaped value
 */
export function completed({ ok, durationMs, command, stdout = '', stderr = '', exitCode, data }) {
  const value = {
    ok: ok === true,
    exitCode: exitCode ?? (ok === true ? 0 : 1),
    signal: '',
    timedOut: false,
    durationMs,
    command,
    stdout,
    stderr,
    truncated: false,
    spillPath: '',
  }
  if (data !== undefined) value.data = data
  return value
}

/**
 * Whether a value carries every key the result contract requires.
 *
 * Used by the offline suite; exported here so the list and the check live
 * together. `data` is deliberately absent from the required set — a gate
 * rejection and a command without `--json` have no payload, and forcing one would
 * mean inventing it.
 *
 * @param {unknown} value the candidate result value
 * @returns {string[]} the missing keys, empty when the value conforms
 */
export function missingResultKeys(value) {
  if (typeof value !== 'object' || value === null) return [...RESULT_KEYS]
  return RESULT_KEYS.filter((key) => !(key in value))
}
