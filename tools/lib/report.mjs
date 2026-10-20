/**
 * The reporting shape every gate in `tools/` uses.
 *
 * ## Why this exists
 *
 * `verify-bundle.mjs` accumulated its own counter, its own PASS/FAIL printer, and its
 * own "could not run" state. Every new gate copied that shape, so the same three
 * states were re-implemented per file — and a new gate could silently get one of them
 * wrong. Two rules from this project's own record went with it:
 *
 * 1. **Silence and success must not look alike.** A check that could not run reports
 *    `unverified`, never `pass`. It is counted separately and printed in the summary,
 *    because a reader has to be able to tell "I looked and it was fine" from "I could
 *    not look".
 * 2. **A gate must be able to go red.** The reporter is therefore a pure data
 *    structure: `results` can be asserted by a test, and the CLI exit code is derived
 *    from it. A gate whose findings no test can observe is a gate nobody has proved
 *    works.
 *
 * @module tools/lib/report
 */

/** The three states a check can be in. */
export const PASS = 'pass'
export const FAIL = 'fail'
export const UNVERIFIED = 'unverified'

/**
 * @typedef {object} Result
 * @property {string} label what was checked
 * @property {'pass' | 'fail' | 'unverified'} state the outcome
 * @property {string} detail what was observed, or why the check could not run
 */

/**
 * Collect gate results without printing anything.
 *
 * Callers decide how to present them: the CLI prints, a test asserts. Keeping the
 * collection pure is what lets `test/gates.test.mjs` feed a deliberately broken tree
 * and assert that the gate reports a failure instead of trusting the gate's own
 * console output.
 */
export class Reporter {
  constructor() {
    /** @type {Result[]} */
    this.results = []
  }

  /**
   * Record one check.
   * @param {boolean} ok whether it passed
   * @param {string} label the check name
   * @param {string} [detail] what was observed
   * @param {{ warnOnly?: boolean }} [options] `warnOnly` keeps a failure out of the exit code
   * @returns {Result} the recorded result
   */
  check(ok, label, detail = '', options = {}) {
    const state = ok ? PASS : options.warnOnly === true ? UNVERIFIED : FAIL
    const result = { label, state, detail }
    this.results.push(result)
    return result
  }

  /**
   * Record a check that could not run. Never a pass, never a failure.
   * @param {string} label what could not be checked
   * @param {string} detail why, and what would make it runnable
   * @returns {Result} the recorded result
   */
  unverified(label, detail) {
    const result = { label, state: UNVERIFIED, detail }
    this.results.push(result)
    return result
  }

  /** @returns {number} how many results are failures */
  get failureCount() {
    return this.results.filter((result) => result.state === FAIL).length
  }

  /** @returns {number} how many results could not run */
  get unverifiedCount() {
    return this.results.filter((result) => result.state === UNVERIFIED).length
  }

  /** @returns {number} how many results passed */
  get passCount() {
    return this.results.filter((result) => result.state === PASS).length
  }

  /** @returns {boolean} whether the gate as a whole succeeded */
  get ok() {
    return this.failureCount === 0
  }
}

/**
 * Print a result list.
 *
 * `unverified` is printed on every run, including a clean one, and named in the
 * summary — a summary that says only "all checks passed" while some checks did not
 * run is the exact defect this printer exists to prevent.
 *
 * @param {Result[]} results the results to print
 * @returns {void}
 */
export function printResults(results) {
  for (const result of results) {
    if (result.state === PASS) console.log(`PASS  ${result.label}${suffix(result.detail)}`)
    else if (result.state === FAIL) console.log(`FAIL  ${result.label}${suffix(result.detail)}`)
    else console.log(`UNVERIFIED  ${result.label}${suffix(result.detail)}`)
  }
}

/**
 * Print a summary line and set the process exit code.
 * @param {Result[]} results the results to summarise
 * @returns {void}
 */
export function finish(results) {
  const failures = results.filter((result) => result.state === FAIL).length
  const unverified = results.filter((result) => result.state === UNVERIFIED).length
  if (failures > 0) {
    console.log(`\n=== ${failures} check(s) failed ===`)
    process.exitCode = 1
    return
  }
  console.log(unverified === 0
    ? '\n=== all checks passed ==='
    : `\n=== all checks passed, ${unverified} check(s) could NOT RUN (see UNVERIFIED above) ===`)
  process.exitCode = 0
}

/**
 * Format a detail string as an indented second line.
 * @param {string} detail the detail
 * @returns {string} the formatted suffix
 */
function suffix(detail) {
  return detail === '' ? '' : `\n      ${detail}`
}
