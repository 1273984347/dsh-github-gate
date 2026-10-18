/**
 * The second route: the git protocol.
 *
 * ## Why a fallback route at all
 *
 * Every tool in this plugin goes through `gh`. That makes `gh` a single point of
 * failure for the whole plugin, and the failure is not hypothetical: `gh` missing from
 * PATH, not logged in, or pointed at a host the network blocks are all ordinary
 * states, and any one of them turns nine tools into nine error messages.
 *
 * The git protocol is the cheapest second route available, because it needs neither
 * the `gh` binary nor a token. `git ls-remote` against a public repository answers
 * questions about refs with no authentication at all, and a workspace that has a clone
 * already has the remote configured.
 *
 * ## What it can and cannot do
 *
 * It reads REFS. That is narrower than it sounds and wider than it looks:
 *
 * - It can answer "which pull request has this commit as its head", which is the
 *   question the branch pill actually asks. GitHub exposes every pull request as
 *   `refs/pull/<number>/head`, and a branch pushed to a PR has exactly that head sha
 *   locally.
 * - It cannot answer anything about the PR's title, state, reviews or checks. Those
 *   live in the API, and a fallback that invented them would be worse than one that
 *   reports what it knows.
 *
 * So the fallback reports a NUMBER and marks where it came from. The pill renders that
 * number and no state colour, because a state it does not know is not a state.
 *
 * ## Measured, not assumed
 *
 * `refs/pull/<n>/head` is a real GitHub ref namespace and `git ls-remote` lists it
 * without credentials. The route exists because that was checked, not because it
 * sounded plausible.
 */

/**
 * Is the git protocol usable in this directory?
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @returns {Promise<{ ok: boolean, detail: string, remote: string }>} availability
 */
export async function gitRouteStatus(runner, cwd) {
  const version = await runner.runGit(['--version'], { cwd, timeoutMs: 10_000 })
  if (version.ok !== true) {
    return { ok: false, detail: 'git is not runnable', remote: '' }
  }
  const remote = await runner.runGit(['remote', 'get-url', 'origin'], { cwd, timeoutMs: 10_000 })
  if (remote.ok !== true) {
    return { ok: false, detail: 'the workspace has no origin remote', remote: '' }
  }
  const url = String(remote.stdout ?? '').trim()
  const isGitHub = /github\.com[/:]/.test(url)
  return {
    ok: isGitHub,
    detail: isGitHub ? url : `origin is not GitHub (${url === '' ? 'empty' : url})`,
    remote: url,
  }
}

/**
 * List the pull request head refs a repository exposes.
 *
 * `git ls-remote origin` with the pull-request head refspec needs no credentials on a public
 * repository. The pattern is passed as a single argv element, so no shell expands it.
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @param {number} timeoutMs the command budget
 * @returns {Promise<{ number: number, sha: string }[]>} the refs, or [] on any failure
 */
export async function listPullHeads(runner, cwd, timeoutMs = 20_000) {
  try {
    const result = await runner.runGit(['ls-remote', 'origin', 'refs/pull/*/head'], { cwd, timeoutMs })
    if (result.ok !== true) return []
    const refs = []
    for (const line of String(result.stdout ?? '').split('\n')) {
      const match = /^([0-9a-f]{7,40})\s+refs\/pull\/(\d+)\/head\s*$/.exec(line.trim())
      if (match === null) continue
      refs.push({ sha: match[1], number: Number(match[2]) })
    }
    return refs
  } catch {
    // A missing remote, an offline host and a private repository are the same answer
    // here: this route has nothing to say. The caller falls back to reporting the
    // branch alone, which it was doing before the fallback existed.
    return []
  }
}

/**
 * Which pull request, if any, has this commit as its head.
 *
 * The local branch's sha is the key: a branch that was pushed to open a pull request
 * shares its head commit with `refs/pull/<n>/head`. Matching is exact and full-length,
 * because a short sha could match a different commit.
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @param {string} sha the local head commit
 * @param {number} timeoutMs the command budget
 * @returns {Promise<number | null>} the pull request number, or null
 */
export async function findPullByHeadSha(runner, cwd, sha, timeoutMs = 20_000) {
  if (typeof sha !== 'string' || sha.length < 7) return null
  const heads = await listPullHeads(runner, cwd, timeoutMs)
  // Highest number wins when several share a head: a reopened or re-pushed pull
  // request leaves older refs behind, and the newest is the live one.
  const matches = heads.filter((head) => head.sha === sha).map((head) => head.number)
  if (matches.length === 0) return null
  return Math.max(...matches)
}

/**
 * The current head commit of the workspace.
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @returns {Promise<string>} the sha, or '' when it cannot be read
 */
export async function headSha(runner, cwd) {
  try {
    const result = await runner.runGit(['rev-parse', 'HEAD'], { cwd, timeoutMs: 10_000 })
    if (result.ok !== true) return ''
    const sha = String(result.stdout ?? '').trim()
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : ''
  } catch {
    return ''
  }
}

/**
 * ## Branch switching
 *
 * The pill started as a read-only indicator. Switching is the obvious next want, and it is
 * the first operation in this plugin that CHANGES the user's working tree from the browser,
 * so the safety model matters more than the feature.
 *
 * ### The injection question, answered by membership rather than by escaping
 *
 * The branch name arrives from the page. `git switch <name>` treats a leading `-` as an
 * option, so a name like `--force` or `-f` is not a branch name at all — it is an argument.
 * Sanitising the string (stripping dashes, quoting) is the usual answer and it is the wrong
 * one here: it invites a rule about which shapes are dangerous, and rules like that are
 * wrong exactly once.
 *
 * Instead every name is checked against the list this module just read from
 * `git for-each-ref`. A name that is not a ref in this repository is refused before git sees
 * it. There is no string that can survive that check and still be an option, because an
 * option is not a ref.
 *
 * ### What is deliberately NOT implemented
 *
 * `--force`, `--discard-changes`, `-C` and detached checkout are all absent. Each of them
 * turns "switch branches" into "lose uncommitted work", and none is needed to answer the
 * request that produced this feature. A dirty tree is REFUSED with the reason, not forced
 * through: `git switch` would refuse it anyway, and reporting why is more useful than a
 * generic failure.
 */

/** Refuse before the runner is even asked, for inputs the route can rule out alone. */
const BRANCH_NAME = /^[^\s~^:?*[\\]{1,200}$/

/**
 * Every local branch, with its upstream tracking state.
 *
 * Read through `for-each-ref` rather than `branch --list` because the output is a stable
 * record format with an explicit separator, so a branch name containing the separator
 * cannot be confused with a field boundary.
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @param {number} timeoutMs the command budget
 * @returns {Promise<{ ok: boolean, branches: {name: string, upstream: string, ahead: number, behind: number}[], detail: string }>} the branches
 */
export async function listBranches(runner, cwd, timeoutMs = 15_000) {
  try {
    const result = await runner.runGit([
      'for-each-ref',
      // The unit separator cannot appear in a ref name, so it is safe as a delimiter.
      '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)',
      'refs/heads',
    ], { cwd, timeoutMs })
    if (result.ok !== true) {
      return { ok: false, branches: [], detail: String(result.stderr ?? result.detail ?? 'git for-each-ref failed').trim().slice(0, 200) }
    }
    const branches = []
    for (const line of String(result.stdout ?? '').split('\n')) {
      const trimmed = line.replace(/\r$/, '')
      if (trimmed.trim() === '') continue
      const [name, upstream, track] = trimmed.split('\u001f')
      if (typeof name !== 'string' || name === '') continue
      // `[ahead 2, behind 1]` — parsed rather than shown, so the UI can sort and colour.
      const ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0)
      const behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0)
      branches.push({ name, upstream: upstream ?? '', ahead, behind })
    }
    return { ok: true, branches, detail: `${branches.length} local branch(es)` }
  } catch (error) {
    return { ok: false, branches: [], detail: String(error?.message ?? error).slice(0, 200) }
  }
}

/**
 * Whether the working tree has uncommitted changes, and how many paths are involved.
 *
 * The count is reported because it is the difference between a useful refusal ("3 files
 * would be overwritten") and one the user cannot act on ("cannot switch").
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @param {number} timeoutMs the command budget
 * @returns {Promise<{ clean: boolean, files: number, detail: string }>} the state
 */
export async function workingTreeState(runner, cwd, timeoutMs = 15_000) {
  try {
    // `--untracked-files=no` on purpose: an untracked file does not block a switch, and
    // counting it would refuse operations git would have allowed.
    const result = await runner.runGit(['status', '--porcelain', '--untracked-files=no'], { cwd, timeoutMs })
    if (result.ok !== true) {
      // An unreadable tree is NOT reported as clean. Refusing on unknown is the safe
      // direction for an operation that can overwrite files.
      return { clean: false, files: -1, detail: String(result.stderr ?? result.detail ?? 'git status failed').trim().slice(0, 200) }
    }
    const files = String(result.stdout ?? '').split('\n').filter((line) => line.trim() !== '').length
    return { clean: files === 0, files, detail: files === 0 ? 'working tree clean' : `${files} modified path(s)` }
  } catch (error) {
    return { clean: false, files: -1, detail: String(error?.message ?? error).slice(0, 200) }
  }
}

/**
 * Switch the working tree to a different local branch.
 *
 * @param {import('./types.js').Runner} runner the process runner
 * @param {string} cwd the workspace directory
 * @param {string} branch the branch to switch to
 * @param {number} timeoutMs the command budget
 * @returns {Promise<{ ok: boolean, branch: string, error?: string, detail?: string }>} the outcome
 */
export async function switchBranch(runner, cwd, branch, timeoutMs = 30_000) {
  if (typeof branch !== 'string' || !BRANCH_NAME.test(branch)) {
    return { ok: false, branch: '', error: 'invalid-branch-name', detail: 'that is not a usable branch name' }
  }
  // The membership check that makes injection impossible: the name must be a ref this
  // repository actually has, read a moment ago, before git is asked to do anything.
  const listed = await listBranches(runner, cwd, timeoutMs)
  if (listed.ok !== true) {
    return { ok: false, branch: '', error: 'list-failed', detail: listed.detail }
  }
  if (!listed.branches.some((entry) => entry.name === branch)) {
    return { ok: false, branch: '', error: 'unknown-branch', detail: `no local branch named ${JSON.stringify(branch)}` }
  }

  try {
    // No `--force`, no `--discard-changes`, no `-C`. Those flags are how this operation
    // would lose work; the point of the preflight below is to refuse rather than to force.
    const result = await runner.runGit(['switch', branch], { cwd, timeoutMs })
    if (result.ok !== true) {
      const raw = String(result.stderr ?? result.detail ?? '').trim()
      // A dirty tree is the ordinary refusal and deserves its own code so the UI can say
      // what to do about it instead of printing git's advice verbatim.
      const dirty = /would be overwritten|local changes|Please commit or stash/i.test(raw)
      return {
        ok: false,
        branch: '',
        error: dirty ? 'dirty-tree' : 'switch-failed',
        detail: raw.slice(0, 400) || 'git switch failed',
      }
    }
    return { ok: true, branch }
  } catch (error) {
    return { ok: false, branch: '', error: 'switch-failed', detail: String(error?.message ?? error).slice(0, 400) }
  }
}