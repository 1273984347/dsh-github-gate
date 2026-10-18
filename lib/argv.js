/**
 * Shared argv-construction helpers.
 *
 * Every domain builds a plain `string[]` and the runner spawns it with
 * `shell: false`. Two conventions are worth stating once here rather than
 * re-deriving in eight files:
 *
 * 1. **A value that comes from a text source has two spellings.** `gh` accepts
 *    either `--body-file <path>` or `--body <text>` (and `--notes-file` /
 *    `--notes`, and the same for any other text field). "Prefer the file, fall
 *    back to the inline value" appeared ten times across `github_issue`,
 *    `github_pr` and `github_release` — ten copies of one decision, each of which
 *    could independently get the precedence backwards.
 * 2. **Every element must be a string.** `spawn` coerces, so a number would work by
 *    accident, but the offline suite asserts the array is a list of strings and a
 *    non-string element would fail there for a reason far from its cause. The
 *    helpers below coerce explicitly.
 *
 * Deliberately NOT provided: a generic "push this flag if the argument is set"
 * helper. `if (a.limit) argv.push('--limit', String(a.limit))` is idiomatic and
 * reads in place; wrapping it would trade five clear characters for an indirection
 * a reader has to look up. Only the patterns with real semantics live here.
 *
 * @module dsh-github-toolkit/argv
 */

/**
 * Append `--<name>-file <path>`, or `--<name> <text>`, whichever the caller gave.
 *
 * The file wins when both are present, matching gh's own behaviour: a
 * `--body-file` is an explicit request for that file's contents, so silently
 * preferring the inline string would ignore it.
 *
 * @param {string[]} argv the argv being built (mutated)
 * @param {Record<string, any>} args the call arguments
 * @param {string} name the gh flag's base name, e.g. `body` -> `--body` / `--body-file`
 * @param {{ fallback?: string }} [options] `fallback` is pushed as `--<name>` when
 *   neither form was supplied; omit it to push nothing
 * @returns {string[]} the same array, for chaining
 */
export function pushTextSource(argv, args, name, options = {}) {
  const file = args[`${name}File`]
  if (file !== undefined && file !== null && file !== '') {
    argv.push(`--${name}-file`, String(file))
    return argv
  }
  const text = args[name]
  if (text !== undefined && text !== null) {
    argv.push(`--${name}`, String(text))
    return argv
  }
  if (options.fallback !== undefined) argv.push(`--${name}`, options.fallback)
  return argv
}

/**
 * Append a boolean switch when the argument is `true`.
 *
 * `=== true` rather than truthiness: the DSL guarantees a boolean here, and a
 * stray `"false"` string must not switch a flag on.
 *
 * @param {string[]} argv the argv being built (mutated)
 * @param {unknown} enabled the argument value
 * @param {string} flag the flag to append
 * @returns {string[]} the same array, for chaining
 */
export function pushSwitch(argv, enabled, flag) {
  if (enabled === true) argv.push(flag)
  return argv
}

/**
 * Append a flag and its value when the value is present and non-empty.
 *
 * `0` and `false` are pushed as values: they are meaningful for a limit or a
 * boolean-valued option, and dropping them would silently change the request.
 *
 * @param {string[]} argv the argv being built (mutated)
 * @param {unknown} value the argument value
 * @param {string} flag the flag to append
 * @returns {string[]} the same array, for chaining
 */
export function pushValue(argv, value, flag) {
  if (value === undefined || value === null || value === '') return argv
  argv.push(flag, String(value))
  return argv
}
