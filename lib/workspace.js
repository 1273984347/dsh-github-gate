/**
 * Workspace-bound repository detection.
 *
 * Distilled from two sources, keeping the better half of each:
 *
 * - KryptonGao/dsh-github-integration had the right *idea* (bind the GitHub
 *   target to the workspace's own git remote so the model never invents a
 *   repository) but a narrow implementation: it accepted only the `origin`
 *   remote and only two URL spellings, and returned `null` for everything
 *   else, including a perfectly ordinary `ssh://git@github.com/owner/repo`.
 * - kaziii/dsh-github-connector had the better parser (one regex covering
 *   `git@host:`, `https://host/`, and `ssh://git@host/` for an arbitrary host)
 *   but embedded it inside its seam package.
 *
 * What is here: accept any remote name, cover all three URL forms, normalize
 * the result, and refuse to guess when the shape is ambiguous.
 */

/** GitHub owner/repository segments: no slash, no whitespace, optional `.git`. */
const OWNER_REPO = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/

/**
 * Parse a git remote URL into a GitHub repository binding.
 *
 * Accepted forms (with `host` defaulting to `github.com`):
 * - `https://github.com/owner/repo.git`
 * - `git@github.com:owner/repo.git`
 * - `ssh://git@github.com/owner/repo.git`
 * - the same three with a trailing slash and without `.git`
 *
 * Rejected on purpose: a different host (GitLab, a local path), a URL with a
 * query or fragment, an owner/repo with extra path segments (which would make
 * the repository ambiguous), and anything whose shape is not recognized.
 *
 * @param {string} url the raw remote URL
 * @param {string} [host] the accepted GitHub host
 * @returns {{ owner: string, repo: string, host: string, url: string } | null}
 */
export function parseGitHubRemote(url, host = 'github.com') {
  if (typeof url !== 'string') return null
  const normalized = url.trim()
  if (normalized === '') return null

  // A query or fragment means this is not a plain clone URL.
  if (normalized.includes('?') || normalized.includes('#')) return null

  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    // ssh://git@host/owner/repo(.git)
    new RegExp(`^ssh://(?:[^@/]+@)?${escaped}/(.+)$`),
    // git@host:owner/repo(.git)
    new RegExp(`^(?:[^@/]+@)?${escaped}:(.+)$`),
    // https://host/owner/repo(.git) and http:// for a local GHES mirror
    new RegExp(`^https?://(?:[^@/]+@)?${escaped}/(.+)$`),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(normalized)
    if (match === null) continue
    const path = match[1].replace(/\/+$/, '')
    const ownerRepo = OWNER_REPO.exec(path)
    if (ownerRepo === null) return null
    const owner = ownerRepo[1]
    const repo = ownerRepo[2]
    if (owner === '' || repo === '') return null
    return { owner, repo, host, url: normalized }
  }
  return null
}

/**
 * Read the workspace's git remotes and resolve the GitHub binding.
 *
 * A remote named `origin` wins when present, because that is the convention
 * every tool and every user expects; otherwise the first remote that parses as
 * a GitHub repository is used, so a workspace cloned from `upstream` still
 * binds correctly.
 *
 * Never throws: an absent repository, a missing git binary, and a non-GitHub
 * remote all resolve to `null`, because "this workspace is not a GitHub repo"
 * is a normal state rather than an error.
 *
 * @param {import('./types.js').Runner} runner the configured runner
 * @param {string} cwd the workspace directory
 * @param {string} [host] the accepted GitHub host
 * @returns {Promise<{ owner: string, repo: string, host: string, url: string, remoteName: string } | null>}
 */
export async function detectRepository(runner, cwd, host = 'github.com') {
  let names = []
  try {
    const result = await runner.runGit(['remote'], { cwd, timeoutMs: 10_000 })
    if (!result.ok) return null
    names = String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return null
  }
  if (names.length === 0) return null

  const ordered = names.includes('origin')
    ? ['origin', ...names.filter((name) => name !== 'origin')]
    : names

  for (const remoteName of ordered) {
    try {
      const result = await runner.runGit(['remote', 'get-url', remoteName], { cwd, timeoutMs: 10_000 })
      if (!result.ok) continue
      const parsed = parseGitHubRemote(String(result.stdout ?? '').trim(), host)
      if (parsed !== null) return { ...parsed, remoteName }
    } catch {
      // Try the next remote.
    }
  }
  return null
}

/**
 * Resolve the repository a call targets, in precedence order: the explicit
 * `repo` argument, then the configured default, then the workspace remote.
 *
 * @param {{ args: any, cfg: import('./types.js').PluginConfig, runner: import('./types.js').Runner, cwd: string }} deps
 * @returns {Promise<string>} `owner/name`, or '' when nothing resolves
 */
export async function resolveRepo(deps) {
  const explicit = typeof deps.args?.repo === 'string' ? deps.args.repo.trim() : ''
  if (isOwnerRepo(explicit)) return explicit
  if (isOwnerRepo(deps.cfg.defaultRepo)) return deps.cfg.defaultRepo
  const detected = await detectRepository(deps.runner, deps.cwd)
  return detected === null ? '' : `${detected.owner}/${detected.repo}`
}

/** The sentinel that means "the branch checked out in this workspace". */
export const CURRENT_BRANCH = '@current'

/** The sentinel that means "the repository's own default branch". */
export const DEFAULT_BRANCH = '@default'

/**
 * Read the branch checked out in the workspace.
 *
 * `git rev-parse --abbrev-ref HEAD` prints the literal `HEAD` on a detached
 * HEAD, which is not a branch name and must not be sent to GitHub as one, so it
 * resolves to '' — the same "nothing known" answer as a missing repository.
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @returns {Promise<string>} the branch name, or '' when there is none
 */
export async function detectCurrentBranch(runner, cwd) {
  try {
    const result = await runner.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 })
    if (!result.ok) return ''
    const name = String(result.stdout ?? '').trim()
    if (name === '' || name === 'HEAD') return ''
    return name
  } catch {
    return ''
  }
}

/**
 * Whether a string is a well-formed `owner/name`.
 *
 * `..` and a leading or trailing dot are refused in either segment. The value is
 * interpolated into REST paths (`repos/${repo}/branches/...`), so a segment that
 * looks like traversal is not a repository name — and a shape git and GitHub both
 * reject anyway.
 *
 * @param {string} value the candidate
 * @returns {boolean} true when it has exactly two usable segments
 */
export function isOwnerRepo(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!OWNER_REPO.test(trimmed) || trimmed.includes(' ')) return false
  const [owner, repo] = trimmed.split('/')
  return !owner.includes('..') && !repo.includes('..')
}

/**
 * Sanitize a string into a safe git branch name.
 *
 * Kept from KryptonGao/dsh-github-integration: it rejects `..`, a leading dot,
 * and a leading separator — the shapes that let a "branch name" escape its
 * intended ref namespace.
 *
 * The traversal check runs on the RAW input, not only on the sanitized result.
 * Sanitizing first is not enough: `..` collapses to nothing and a path like
 * `feat/../../x` becomes an innocent-looking `feat/x`, silently turning a
 * hostile input into a different ref than the caller asked for. Rejecting it
 * outright is the honest behaviour.
 *
 * @param {string} value the candidate branch name
 * @returns {string} a safe branch name
 * @throws {Error} when the input is unsafe or nothing usable survives
 */
export function safeBranchName(value) {
  if (typeof value !== 'string') throw new Error('branch name is invalid')
  const raw = value.trim()
  if (raw === '') throw new Error('branch name is invalid')
  // Refuse the escaping shapes before normalization can hide them.
  if (raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('-')) {
    throw new Error('branch name is invalid')
  }
  if (raw.includes('..') || raw.includes('//') || raw.includes('@{') || raw.includes('\\')) {
    throw new Error('branch name is invalid')
  }
  if (/[\x00-\x1f\x7f ~^:?*[\]']/.test(raw)) {
    throw new Error('branch name is invalid')
  }
  const normalized = raw
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '')
  if (normalized === '' || normalized.startsWith('.') || normalized.includes('..')) {
    throw new Error('branch name is invalid')
  }
  return normalized.slice(0, 120)
}
