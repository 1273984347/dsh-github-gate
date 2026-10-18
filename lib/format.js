/**
 * Turn a failed `gh` invocation into a hint that names the fix.
 *
 * ## Why a module
 *
 * The plugin already produced hints in three places — the registry's
 * authentication note, `github_api`'s 401 note, and the credential chain's
 * `recommendation()` — and each covered a different subset. A user who hit a rate
 * limit got nothing, and a user whose token lacked a scope got the same text as a
 * user who was never logged in. Worse, the three could disagree about the same
 * failure.
 *
 * The rule this module follows: **a hint says what to DO**, and it says nothing
 * when it does not know. "Something went wrong" costs tokens on every failure and
 * teaches the reader to skip hints. So every mapping below is anchored to a
 * message `gh` or the GitHub API actually emits, and an unrecognised failure
 * returns `undefined` — silence, not noise.
 *
 * The signatures are matched against `stderr + stdout` because `gh` splits them:
 * an HTTP status line goes to stderr while the API's error body goes to stdout.
 *
 * @module dsh-github-gate/format
 */

/**
 * One recognised failure: what matched, what to do, and how sure that is.
 * @typedef {object} FailureHint
 * @property {string} kind a stable id, so callers can branch without parsing prose
 * @property {string} hint the actionable sentence shown to the model
 */

/**
 * Ordered patterns. Order matters: the first match wins, so the narrowest and
 * most actionable rule must come before a broader one that would also match.
 *
 * Each entry documents the message it keys on, because a pattern that no longer
 * appears in gh's output is dead weight that looks like coverage.
 * @type {{ kind: string, test: RegExp, hint: string }[]}
 */
const RULES = [
  {
    kind: 'rate-limit',
    // `gh` prints `HTTP 403: API rate limit exceeded ...` and the API body says
    // "API rate limit exceeded for <ip>".
    test: /API rate limit exceeded|rate limit exceeded|secondary rate limit/i,
    hint: 'GitHub says the rate limit is exhausted. Authenticated calls get 5000/hour instead of 60; '
      + 'check which credential is in use with github_auth action "status". Wait for the reset rather than retrying.',
  },
  {
    kind: 'auth',
    // Both gh's own wording and the API's.
    test: /not logged into|authentication required|requires authentication|bad credentials|gh auth login|GH_TOKEN/i,
    hint: 'No usable GitHub credential was found. Call github_auth with action "status" to inspect the chain, '
      + 'or action "login" to authorize. If a token is configured, it may be expired or revoked.',
  },
  {
    kind: 'saml',
    // A 403 that is NOT a quota problem: an organisation enforces SAML SSO.
    test: /SAML|sso|single sign-on/i,
    hint: 'The token is valid but the organisation enforces SAML SSO. Authorize the token for that '
      + 'organisation from GitHub settings; nothing in this plugin can grant that.',
  },
  {
    kind: 'scopes',
    // The API returns this in `message` when a token lacks a scope.
    test: /insufficient (?:scopes|permissions)|Resource not accessible by (?:integration|personal access token)/i,
    hint: 'The credential is valid but lacks the scope this call needs. GitHub names the missing permission '
      + 'in the response above; add it to the token. Fine-grained tokens need per-repository grants.',
  },
  {
    kind: 'not-found',
    test: /HTTP 404|Not Found|Could not resolve to a (?:Repository|Issue|PullRequest|User)/i,
    hint: 'The target does not exist, or the credential cannot see it. A private repository returns 404 '
      + 'rather than 403, so "not found" and "no access" look identical here. Check the name and the token\'s access.',
  },
  {
    kind: 'validation',
    // `HTTP 422: Validation Failed` plus a field-level body.
    test: /HTTP 422|Validation Failed|must be one of/i,
    hint: 'GitHub rejected the request fields. The response names the offending field; correct that value '
      + 'and retry rather than repeating the call unchanged.',
  },
  {
    kind: 'conflict',
    test: /HTTP 409|Merge conflict|not mergeable|merge conflict/i,
    hint: 'The operation conflicts with the current state (usually a merge conflict, or the resource moved). '
      + 'Re-read the target with the matching `view` action before retrying.',
  },
  {
    kind: 'network',
    test: /dial tcp|i\/o timeout|TLS handshake|no such host|connection refused|proxyconnect|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
    hint: 'The request never reached GitHub. Run github_auth action "probe": it isolates DNS, TLS, the '
      + 'credential chain and the API round trip, and names the layer that failed.',
  },
  {
    kind: 'gh-missing',
    test: /failed to (?:run|spawn)|executable file not found|ENOENT/i,
    hint: 'The gh executable could not be started. Install it from https://cli.github.com/ or set the '
      + 'plugin config "ghPath".',
  },
]

/**
 * The first actionable hint for a failed result, or undefined.
 *
 * Returns undefined for a SUCCESSFUL result: a hint on a success is noise by
 * definition, and a caller should not have to check `ok` before asking.
 *
 * @param {{ ok?: boolean, stderr?: string, stdout?: string }} result a runner result
 * @returns {FailureHint | undefined} the hint, when one applies
 */
export function failureHint(result) {
  if (result === undefined || result === null || result.ok === true) return undefined
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  if (text.trim() === '') return undefined
  for (const rule of RULES) {
    if (rule.test.test(text)) return { kind: rule.kind, hint: rule.hint }
  }
  return undefined
}

/**
 * Append a hint to a failed result's stderr, in place.
 *
 * The hint goes AFTER the captured output so the model reads the evidence first
 * and the advice second — and it is prefixed so a reader can tell which lines are
 * GitHub's and which are this plugin's.
 *
 * @param {any} result the runner result (mutated)
 * @returns {any} the same result
 */
export function attachFailureHint(result) {
  const found = failureHint(result)
  if (found === undefined) return result
  const prefix = result.stderr === '' ? '' : result.stderr.endsWith('\n') ? '' : '\n'
  result.stderr = `${result.stderr ?? ''}${prefix}[hint] ${found.hint}`
  return result
}

/** Exported for tests: the patterns and their order. */
export const FAILURE_RULES = RULES
