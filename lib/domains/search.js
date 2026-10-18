/**
 * github_search — search across GitHub.
 *
 * A read-only domain with no destructive actions, so it stays usable in the
 * most restricted configurations. Code search is the action that most often
 * needs a repository qualifier to be useful, so the description says so.
 */

import { str, int, enumStr, bool } from '../schema.js'

/**
 * Split a search query into the separate argv terms `gh search` requires.
 *
 * gh quotes EVERY positional argument before joining them. Passing a whole
 * query as one argument therefore produces a single quoted term, and
 * `repo:cli/cli is:open` is rejected with `Invalid search query
 * "( repo:\"cli/cli is:open\" )"`. Measured against gh 2.89.0: one argument
 * fails, whitespace-separated arguments succeed.
 *
 * A double-quoted run stays ONE term including its quotes, because that is how
 * gh is told to search for a phrase — splitting it would leave the quotes
 * unbalanced.
 *
 * An UNEVEN number of quotes is refused rather than silently tolerated. The old
 * tokenizer happily returned one term carrying a dangling `"`, which gh answers
 * with a syntax error that names no reason — the caller cannot tell a typo in
 * their query from a broken one.
 *
 * @param {string} query the model-supplied query
 * @returns {{ terms: string[] } | { error: string }} the argv terms, or a reason
 */
export function tokenizeQuery(query) {
  /** @type {string[]} */
  const tokens = []
  let current = ''
  let quoted = false
  for (const char of String(query)) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current !== '') tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  if (quoted) {
    return {
      error: `github_search: the query has an unterminated quote (${JSON.stringify(query)}). Close it, or drop it — gh reads an unpaired " as a phrase it cannot complete.`,
    }
  }
  if (tokens.length === 0) return { error: 'github_search: `query` is empty.' }
  return { terms: tokens }
}

/**
 * The argv terms for one query, as an array or an `{ error }` marker.
 *
 * The registry treats a non-array `argv()` return as a rejection and reports
 * `argv.error`, which is how the other domains abort a call. So the refusal has
 * to travel as the WHOLE return value of `argv()`, not as one element inside a
 * spread — `...{ error }` throws `object is not iterable`, which is an
 * uncaught TypeError rather than a refusal.
 *
 * `searchArgv` below is the shape every action uses: it either builds the full
 * argv or hands back the `{ error }` untouched.
 *
 * @param {unknown} query the raw `query` argument
 * @returns {string[] | { error: string }} the terms, or the reason to refuse
 */
function terms(query) {
  const parsed = tokenizeQuery(/** @type {string} */ (query))
  if ('error' in parsed) return { error: parsed.error }
  return parsed.terms
}

/**
 * Build a search argv, or return the tokenizer's refusal as the argv result.
 *
 * @param {string} sub the `gh search` subcommand
 * @param {unknown} query the raw query
 * @param {number} limit the result limit
 * @param {(argv: string[]) => void} [extend] add this action's own flags
 * @returns {string[] | { error: string }} the argv, or the refusal
 */
function searchArgv(sub, query, limit, extend) {
  const parsed = terms(query)
  if (!Array.isArray(parsed)) return parsed
  const argv = ['search', sub, ...parsed, '--limit', String(limit ?? 20)]
  if (typeof extend === 'function') extend(argv)
  return argv
}

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_search',
  title: 'GitHub search',
  // A read-only domain: every action only queries.
  readOnlyActions: ['repos', 'issues', 'prs', 'code', 'commits'],
  description:
    'Search GitHub for repositories, issues, pull requests, code, or commits. The `query` uses ' +
    'GitHub search syntax; for code search, qualifying with a repository (repo:owner/name) or an ' +
    'organization (org:name) makes the result far more useful. Use this to locate work before ' +
    'reading it with github_issue, github_pr, or github_repo.',
  params: {
    // Every description names the actions that read it, using the real action ids.
    // That is not decoration: `tools/verify-params.mjs` reads these lists and fails
    // the build when a parameter a description claims is never read, so a prose
    // description would leave the parameter unguarded.
    query: str('repos/issues/prs/code/commits: the search query. GitHub search qualifiers are supported, e.g. "is:open label:bug repo:owner/name".'),
    // There was a `kind` enum here — "What to search (default repos)". No action
    // ever read it: the action id already decides what is searched, so passing
    // `kind: "issues"` silently searched repositories instead. A parameter that
    // looks like the tool's primary selector and does nothing is worse than a
    // missing one, so it is gone; the enum now lives where it is enforced, in the
    // action names themselves.
    limit: int('repos/issues/prs/code/commits: maximum results to return (default 20, max 100).'),
    repo: str('issues/prs/code/commits: limit the search to this repository ("owner/name").'),
    owner: str('issues/prs/code/commits: limit the search to repositories owned by this user or organization.'),
    language: str('repos/code: filter by programming language.'),
    // A free string, because the legal set differs per action — repos accepts
    // {stars|forks|help-wanted-issues|updated}, commits accepts
    // {author-date|committer-date}, and issues/prs accept their own list. Fixing
    // one list here made a copied example fail, so the description states the
    // three real sets instead of one example that only fits repos.
    sort: str('repos/issues/prs/commits: the sort field for THIS action. repos: stars|forks|help-wanted-issues|updated. issues/prs: comments|created|interactions|reactions|updated. commits: author-date|committer-date. Omit to let gh pick.'),
    order: enumStr(['asc', 'desc'], 'repos/issues/prs/commits: sort direction (default desc).'),
    // Passed by the uniform registry builder, which adds it to every domain. This
    // domain has no destructive action, so it is never read — the same shape this
    // file's own header comment rejects, tolerated here because removing it would
    // need the registry to stop declaring it universally. `verify-params` skips it
    // as a control parameter.
    confirm: bool('DESTRUCTIVE: ignored by every github_search action — this tool is read-only.'),
    timeoutMs: int('Optional per-call timeout in milliseconds.'),
  },
  globalRepoFlag: false,
  actions: {
    repos: {
      help: 'Search repositories by name, description, topics, or qualifiers like stars:>100.',
      needs: ['query'],
      // Field list verified against `gh search repos`. Its vocabulary differs
      // from `gh repo list` in three places — fullName vs nameWithOwner,
      // stargazersCount (with the s) vs stargazerCount, and language vs
      // primaryLanguage — so the two lists are NOT interchangeable.
      json: 'fullName,description,language,stargazersCount,isPrivate,updatedAt,url',
      argv: (a) => searchArgv('repos', a.query, a.limit, (argv) => {
        if (a.language) argv.push('--language', a.language)
        if (a.sort) argv.push('--sort', a.sort)
        if (a.order) argv.push('--order', a.order)
      }),
    },
    issues: {
      help: 'Search issues and pull requests.',
      needs: ['query'],
      json: 'number,title,state,repository,author,updatedAt,url',
      argv: (a) => searchArgv('issues', a.query, a.limit, (argv) => {
        if (a.repo) argv.push('--repo', a.repo)
        if (a.owner) argv.push('--owner', a.owner)
        if (a.sort) argv.push('--sort', a.sort)
        if (a.order) argv.push('--order', a.order)
      }),
    },
    prs: {
      help: 'Search pull requests.',
      needs: ['query'],
      json: 'number,title,state,repository,author,updatedAt,url',
      argv: (a) => searchArgv('prs', a.query, a.limit, (argv) => {
        if (a.repo) argv.push('--repo', a.repo)
        if (a.owner) argv.push('--owner', a.owner)
        if (a.sort) argv.push('--sort', a.sort)
        if (a.order) argv.push('--order', a.order)
      }),
    },
    code: {
      help: 'Search code. Qualify with repo: or org: — an unqualified code search is rarely useful.',
      needs: ['query'],
      json: 'path,repository,textMatches,url',
      argv: (a) => searchArgv('code', a.query, a.limit, (argv) => {
        if (a.repo) argv.push('--repo', a.repo)
        if (a.owner) argv.push('--owner', a.owner)
        if (a.language) argv.push('--language', a.language)
      }),
    },
    commits: {
      help: 'Search commit messages.',
      needs: ['query'],
      // `gh search commits` has no flat `message`/`committedDate`: the subject
      // lives under `commit` and the date under `committer`.
      json: 'sha,commit,author,committer,repository,url',
      argv: (a) => searchArgv('commits', a.query, a.limit, (argv) => {
        if (a.repo) argv.push('--repo', a.repo)
        if (a.owner) argv.push('--owner', a.owner)
        if (a.sort) argv.push('--sort', a.sort)
        if (a.order) argv.push('--order', a.order)
      }),
    },
  },
}

export default domain
