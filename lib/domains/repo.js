/**
 * github_repo — repository inspection and management.
 *
 * Read actions never require a repository argument: when `repo` is omitted the
 * workspace's own git remote is resolved, so the common case ("what is this
 * repository?") needs no arguments at all.
 */

import { str, bool, int, enumStr } from '../schema.js'
import { safeBranchName } from '../workspace.js'

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_repo',
  title: 'GitHub repository',
  // `clone` is excluded on purpose: it writes the local filesystem, so two
  // concurrent clones could race for the same target directory.
  readOnlyActions: ['view', 'list', 'branches'],
  description:
    'Inspect and manage GitHub repositories. Read actions (view, list, branches) need no ' +
    'repository argument when the workspace git remote points at GitHub. Write actions that ' +
    'change or remove a repository require confirm: true. Typical use: view to learn the default ' +
    'branch and visibility, list to survey your repositories, branches to see refs.',
  params: {
    repo: str('view/branches/edit/rename/archive/delete: target repository as "owner/name". Omit it to use the workspace remote or the configured defaultRepo. `create` reads it only when fork: true.'),
    limit: int('list: maximum repositories to return (default 30).'),
    visibility: enumStr(['all', 'public', 'private'], 'list: filter by repository visibility.'),
    // `gh repo list` has no `--affiliation`. It takes an `<owner>` POSITIONAL and
    // filters ownership with `--fork` / `--archived`, so an affiliation filter is
    // expressed by naming the owner instead. The parameter is kept because the
    // readme documents it, but its meaning is now the one gh implements.
    affiliation: str('list: owner to list repositories for, as a name or OWNER/REPO.'),
    archived: bool('list: show only archived repositories.'),
    branch: str('view/branches/clone: a branch name. view reads the repository as of it, branches inspects just that one, clone checks it out.'),
    // Not `create/rename`: `rename` reads `newName` (`gh repo rename [<new-name>]`
    // takes it positionally), so claiming `name` for rename documented a parameter
    // that action never looks at.
    name: str('create: repository name (without the owner). For rename use newName.'),
    description: str('create/edit: repository description.'),
    private: bool('create/edit: whether the repository is private.'),
    topic: str('edit: a single topic to add. create does not accept topics — gh repo create has no --add-topic, so set them with edit afterwards.'),
    homepage: str('edit: repository homepage URL. create does not accept a homepage either.'),
    newName: str('rename: the new repository name.'),
    // `fork: true` makes `create` run `gh repo fork <repo>` instead of
    // `gh repo create`, because the former has no --fork flag.
    fork: bool('create: fork the repository named in `repo` instead of creating an empty one. Requires `repo`.'),
    org: str('create: create under this organization, or fork into it with fork: true. Use a name or OWNER/REPO.'),
    // `fork` is not an ACTION — it is a mode of `create` that runs `gh repo fork`.
    // Describing it as an action id would fail `verify-params`, which checks every
    // claim in a description against the real action table.
    clone: bool('create: also clone the new repository locally.'),
    confirm: bool('DESTRUCTIVE: set to true to explicitly confirm this action.'),
    timeoutMs: int('Optional per-call timeout in milliseconds.'),
  },
  globalRepoFlag: false,
  actions: {
    view: {
      help: 'Show repository metadata: default branch, visibility, stars, description, and URL. Pass `branch` to read the repository as of that branch.',
      needs: [],
      requiresRepo: true,
      json: 'name,owner,description,defaultBranchRef,isPrivate,isFork,stargazerCount,url,pushedAt',
      argv: (a, _cfg, repo) => {
        const argv = ['repo', 'view', repo]
        // gh's own flag, verified to accept --json alongside it.
        if (a.branch) argv.push('--branch', a.branch)
        return argv
      },
    },
    list: {
      help: 'List repositories owned by a user or organization, filtered by visibility or topic.',
      needs: [],
      json: 'nameWithOwner,description,isPrivate,updatedAt,primaryLanguage',
      argv: (a) => {
        // `<owner>` is gh's only way to scope the list by ownership; `--affiliation`
        // does not exist and every call that passed it failed with "unknown flag".
        const argv = ['repo', 'list']
        if (a.affiliation) argv.push(a.affiliation)
        argv.push('--limit', String(a.limit ?? 30))
        if (a.visibility) argv.push('--visibility', a.visibility)
        if (a.archived === true) argv.push('--archived')
        if (a.fork === true) argv.push('--fork')
        return argv
      },
    },
    branches: {
      help: 'List the repository\'s branches, or inspect one when `branch` is given. Returns the API\'s own branch objects (name, commit sha, protected flag).',
      needs: [],
      requiresRepo: true,
      // NO `json` field on purpose. This action runs `gh api`, and `gh api` has
      // no `--json` flag — declaring one made the registry append it and every
      // call failed with "unknown flag: --json". `gh api` already emits JSON, so
      // the field selection was both broken and unnecessary. The audit test
      // "no action mixes gh api with a --json field selection" guards the class.
      check: (a) => {
        if (a.branch === undefined) return null
        try {
          safeBranchName(a.branch)
          return null
        } catch (error) {
          return `github_repo branches: ${String(error?.message ?? error)}`
        }
      },
      argv: (a, _cfg, repo) => {
        if (a.branch) {
          // The branch is interpolated RAW, not percent-encoded: GitHub's route
          // treats the remainder as the branch name, and encoding the slash in
          // "feat/x" as %2F makes the API answer 404. Measured, not assumed.
          return ['api', `repos/${repo}/branches/${a.branch}`]
        }
        // The list endpoint defaults to 30 per page, so `limit` has to become
        // per_page to mean anything.
        return ['api', `repos/${repo}/branches?per_page=${Math.max(1, Math.min(a.limit ?? 30, 100))}`]
      },
    },
    clone: {
      help: 'Clone a repository into the current working directory, optionally checking out a specific branch.',
      needs: ['repo'],
      argv: (a, _cfg, repo) => {
        const argv = ['repo', 'clone', repo]
        // `gh repo clone <repo> [<dir>] [-- <gitflags>...]` forwards everything
        // after `--` to git. `--branch` is a GIT flag, so it must go there:
        // before the separator gh rejects it as an unknown flag.
        if (a.branch) argv.push('--', '--branch', a.branch)
        return argv
      },
    },
    create: {
      help: 'Create a new repository, or fork an existing one with fork: true (requires confirm: true).',
      needs: ['name'],
      // NOT `requiresRepo`: `gh repo create <name>` needs no source repository, and
      // claiming one would force a caller to invent a target for an empty create.
      // A fork is the case that needs it, and `check` refuses that combination
      // before argv is built.
      destructive: true,
      check: (a) => {
        if (a.fork === true && a.name === undefined) {
          return 'github_repo create: fork requires `name` (the fork name).'
        }
        // `gh repo fork` is a separate subcommand: `gh repo create` has no `--fork`
        // and rejects it with "unknown flag". A fork also needs something to fork
        // FROM, which is `repo` — the one case where this action reads it.
        if (a.fork === true && a.repo === undefined) {
          return 'github_repo create: fork requires a source repository. Pass `repo` alongside fork: true.'
        }
        return null
      },
      argv: (a, _cfg, repo) => {
        // Two subcommands, selected by the flag. Building only one argv means a flag
        // gh does not know cannot reach it.
        if (a.fork === true) {
          // `gh repo fork <repo> --clone --org <org>`. The fork's own name is not
          // gh's to choose, so `name` is validated by `check` and not passed on.
          const argv = ['repo', 'fork', repo]
          if (a.clone === true) argv.push('--clone')
          if (a.org) argv.push('--org', a.org)
          return argv
        }
        const target = a.org ? `${a.org}/${a.name}` : a.name
        const argv = ['repo', 'create', target]
        if (a.description) argv.push('--description', a.description)
        if (a.private === true) argv.push('--private')
        else if (a.private === false) argv.push('--public')        // `--add-topic` and `--homepage` do not exist on `create` — they belong to
        // `gh repo edit`. `--source` DOES exist but takes a LOCAL PATH, so an
        // owner/name there was nonsense and an empty value left a dangling flag.
        if (a.clone === true) argv.push('--clone')
        return argv
      },
    },
    edit: {
      help: 'Edit a repository\'s description, visibility, homepage, or topics (requires confirm: true).',
      needs: [],
      requiresRepo: true,
      destructive: true,
      argv: (a, _cfg, repo) => {
        const argv = ['repo', 'edit', repo]
        if (a.description !== undefined) argv.push('--description', a.description)
        if (a.homepage !== undefined) argv.push('--homepage', a.homepage)
        if (a.private === true) argv.push('--visibility', 'private')
        if (a.private === false) argv.push('--visibility', 'public')
        if (a.topic) argv.push('--add-topic', a.topic)
        return argv
      },
    },
    rename: {
      help: 'Rename a repository (requires newName and confirm: true).',
      needs: ['newName'],
      requiresRepo: true,
      destructive: true,
      // `<new-name>` is gh's ONLY positional: `["repo","rename",newName,repo]` was
      // rejected with "accepts at most 1 arg(s), received 2". So the target cannot
      // be a positional here, and `gh repo rename` accepts `--repo` (verified) —
      // unlike `archive` and `delete`, which have no `--repo` and take the
      // repository positionally instead. Each of the three is spelled out because
      // they differ, and copying one shape onto another is the bug that shipped.
      argv: (a, _cfg, repo) => ['repo', 'rename', a.newName, '--yes', '--repo', repo],
    },
    archive: {
      help: 'Archive a repository, making it read-only (requires confirm: true).',
      needs: [],
      requiresRepo: true,
      destructive: true,
      // `gh repo archive [<repository>]` — an optional positional, and NO `--repo`
      // flag: passing one is rejected with "unknown flag: --repo". `--yes` is
      // mandatory because GH_PROMPT_DISABLED makes gh non-interactive.
      argv: (_a, _cfg, repo) => ['repo', 'archive', repo, '--yes'],
    },
    delete: {
      help: 'Delete a repository permanently. Requires confirm: true.',
      needs: [],
      requiresRepo: true,
      destructive: true,
      // Same shape as archive: `<repository>` positional, `--yes`, no `--repo`.
      // Omitting the positional would act on the working directory's repository,
      // so it is always supplied even when it resolves to the workspace's own.
      argv: (_a, _cfg, repo) => ['repo', 'delete', repo, '--yes'],
    },
  },
}

export default domain
