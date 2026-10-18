/**
 * gh version parsing.
 *
 * `gh --version` prints `gh version 2.89.0 (2026-03-26)`. That single line is the
 * whole reason this module exists: splitting it and taking the first token yields
 * `"gh"`, and `Number.parseInt("gh")` is `NaN`, so every comparison silently
 * answered "not older" — including for gh 0.5.0. The plugin therefore warned
 * about nothing for any input, which is the failure mode of a check nobody can
 * see fail.
 *
 * Extracted from `index.js` so the parsing has its own tests. Nothing about it
 * is worth inlining: it is pure, it is easy to get subtly wrong, and a wrong
 * version check costs a whole configuration switch.
 */

/**
 * The first token in a line that looks like a dotted version number.
 *
 * Scans rather than indexing, because the version token sits at a position that
 * depends on the executable name and on whether `version` is printed at all —
 * `gh version 2.89.0 (2026-03-26)` and a bare `2.89.0` both resolve to
 * `"2.89.0"`, and `gh 2.89.0` (no version word) also parses.
 *
 * @param {string} reported the full line, e.g. from `gh --version`
 * @returns {string} the version token, or '' when none is found
 */
export function versionToken(reported) {
  const parts = String(reported ?? '').trim().split(/\s+/)
  // Only accept a token whose FIRST segment is digits: `(2026-03-26)` and
  // `version` are both rejected, while `2` and `2.89.0` are not.
  const found = parts.find((part) => /^\d+(?:\.\d+)*/.test(part))
  return found === undefined ? '' : found
}

/**
 * Whether a reported gh version is older than a dotted minimum.
 *
 * Numeric segment comparison, no semver: `gh version 2.89.0` needs no prerelease
 * handling, and a shape that does not compare cleanly returns `false` rather than
 * raising a spurious warning.
 *
 * @param {string} reported the version line from the probe
 * @param {string} minimum the configured minimum, e.g. `2.0.0`
 * @returns {boolean} true when `reported` sorts below `minimum`
 */
export function isOlderThan(reported, minimum) {
  const actual = versionToken(reported).split(/[.-]/).map((part) => Number.parseInt(part, 10))
  const wanted = String(minimum ?? '').trim().split(/[.-]/).map((part) => Number.parseInt(part, 10))
  // An empty or unparsable reported version is NOT treated as old: `gh --version`
  // succeeding but printing something unexpected is a parsing problem, not a
  // reason to warn the user that their gh is stale.
  if (actual.length === 0 || actual.some((n) => !Number.isFinite(n))) return false
  if (wanted.length === 0 || wanted.some((n) => !Number.isFinite(n))) return false
  const length = Math.max(actual.length, wanted.length)
  for (let index = 0; index < length; index += 1) {
    const a = actual[index] ?? 0
    const b = wanted[index] ?? 0
    if (a !== b) return a < b
  }
  return false
}
