/**
 * github_pr — pull request lifecycle.
 *
 * The largest domain, and the one with the most consequential actions, so the
 * destructive gate matters most here: merge and close require `confirm: true`,
 * and merge additionally refuses when the pull request is not mergeable.
 */

import { str, bool, int, strArr, enumStr } from '../schema.js'
import { pushTextSource } from '../argv.js'

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_pr',
  title: 'Pull request',
  readOnlyActions: ['list', 'view', 'diff', 'checks', 'status'],
  description:
    'Create, inspect, and manage pull requests. Read actions (list, view, diff, checks, status) ' +
    'are safe and cheap; use them before merging. Creating a pull request requires a title and ' +
    'either a head branch or a branch checked out locally. Merge, close, and reopen are ' +
    'destructive and require confirm: true. Typical loop: status → create → checks → merge.',
  params: {
    repo: str('requiresRepo: target repository as "owner/name". Omit it to use the workspace remote.'),
    number: int('needs: the pull request number for actions that target one (view, diff, checks, merge, close, reopen, comment, ready, checkout, review, edit). `status` reports the current branch and ignores it.'),
    title: str('create: pull request title.'),
    body: str('create/comment: markdown body text.'),
    base: str('create/edit: target branch. list: filter by base branch.'),
    head: str('create: source branch. list: filter by head branch (plain branch name, no "owner:" prefix). Omit it on create to use the branch checked out in the workspace.'),
    branch: str('checkout: local branch name to create (defaults to the head branch name).'),
    draft: bool('create: open the pull request as a draft.'),
    fill: bool('create: fill title and body from the commits instead of the provided values.'),
    // `gh pr review` requires one of --approve / --comment / --request-changes, or it
    // has nothing to submit. This action exists because a previous `review` passed only
    // `--body` and could therefore never record a verdict — with GH_PROMPT_DISABLED=1
    // gh cannot fall back to prompting, so every call failed.
    reviewAction: enumStr(['approve', 'request-changes', 'comment'], 'review: which verdict to record. Required: gh pr review submits nothing without it.'),
    state: enumStr(['open', 'closed', 'merged', 'all'], 'list: filter by pull request state (default open).'),
    limit: int('list: maximum pull requests to return (default 30).'),
    author: str('list: filter by author login.'),
    label: str('list: filter by label name.'),
    search: str('list: filter by a search query.'),
    mergeMethod: enumStr(['merge', 'squash', 'rebase'], 'merge: which merge strategy to use (default merge).'),
    deleteBranch: bool('merge: delete the source branch after merging.'),
    subject: str('merge: custom merge commit subject.'),
    bodyFile: str('create/comment: read the body from this file instead of `body`.'),
    confirm: bool('DESTRUCTIVE: set to true to explicitly confirm this action.'),
    timeoutMs: int('Optional per-call timeout in milliseconds.'),
  },
  globalRepoFlag: true,
  actions: {
    list: {
      help: 'List pull requests, filtered by state, author, label, base branch, head branch, or a search query.',
      needs: [],
      requiresRepo: true,
      json: 'number,title,state,headRefName,baseRefName,author,isDraft,updatedAt,url',
      argv: (a) => {
        const argv = ['pr', 'list', '--limit', String(a.limit ?? 30)]
        if (a.state) argv.push('--state', a.state)
        if (a.author) argv.push('--author', a.author)
        if (a.label) argv.push('--label', a.label)
        if (a.search) argv.push('--search', a.search)
        // Branch filters. gh rejects an "<owner>:<branch>" head form, so the
        // parameter description says plain branch only.
        if (a.base) argv.push('--base', a.base)
        if (a.head) argv.push('--head', a.head)
        return argv
      },
    },
    view: {
      help: 'Show one pull request: title, body, branches, review state, and CI summary.',
      needs: ['number'],
      requiresRepo: true,
      json: 'number,title,body,state,headRefName,baseRefName,author,isDraft,mergeable,reviewDecision,url',
      argv: (a) => ['pr', 'view', String(a.number)],
    },
    diff: {
      help: 'Show the unified diff of one pull request. Large diffs are truncated by the plugin.',
      needs: ['number'],
      requiresRepo: true,
      argv: (a) => ['pr', 'diff', String(a.number)],
    },
    checks: {
      help: 'List the CI check runs on a pull request and their conclusions.',
      needs: ['number'],
      requiresRepo: true,
      argv: (a) => ['pr', 'checks', String(a.number)],
    },
    status: {
      help: 'Show CI status for the current branch. gh pr status takes no pull request number — see `checks`.',
      needs: [],
      requiresRepo: true,
      // `gh pr status [flags]` takes NO positional: passing one is rejected with
      // `unknown argument "123"`. A per-PR verdict is `checks`, which does take
      // the number. `number` is therefore ignored here rather than forwarded.
      argv: () => ['pr', 'status'],
    },
    create: {
      help: 'Create a pull request (requires `title` and confirm: true). `head` defaults to the checked-out branch.',
      needs: ['title'],
      requiresRepo: true,
      destructive: true,
      check: (a) => {
        if (a.fill === true || typeof a.body === 'string' && a.body !== '' || typeof a.bodyFile === 'string') {
          // `--fill` asks gh to derive the title and body from the commits, so
          // combining it with an explicit body is two sources for one field. gh's
          // precedence between them is not documented and was not measured, so the
          // combination is refused rather than resolved by guessing: an explicit
          // body that gh silently discards is the failure this prevents.
          if (a.fill === true && (typeof a.body === 'string' || typeof a.bodyFile === 'string')) {
            return 'github_pr create: pass either fill: true OR a body/bodyFile, not both — gh derives the body from the commits when filling, and which one wins is not defined.'
          }
          return null
        }
        return 'github_pr create: provide `body`, `bodyFile`, or fill: true so the pull request is not empty.'
      },
      argv: (a) => {
        const argv = ['pr', 'create', '--title', a.title]
        pushTextSource(argv, a, 'body')
        if (a.base) argv.push('--base', a.base)
        if (a.head) argv.push('--head', a.head)
        if (a.draft === true) argv.push('--draft')
        if (a.fill === true) argv.push('--fill')
        return argv
      },
    },
    comment: {
      help: 'Add a comment to a pull request (requires confirm: true).',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      check: (a) =>
        typeof a.body === 'string' && a.body !== '' ? null : 'github_pr comment: `body` is required.',
      argv: (a) => {
        const argv = ['pr', 'comment', String(a.number)]
        pushTextSource(argv, a, 'body')
        return argv
      },
    },
    review: {
      help: 'Submit a review: approve it, request changes, or leave a review comment (requires confirm: true, because it is recorded under your account).',
      needs: ['number', 'reviewAction'],
      requiresRepo: true,
      // A review is written under the user's account, so it is a state change in
      // the same sense a comment is. gh submits nothing without a verdict flag,
      // so `reviewAction` is required rather than optional.
      destructive: true,
      check: (a) => {
        if (a.reviewAction === undefined) {
          return 'github_pr review: `reviewAction` is required — pass "approve", "request-changes", or "comment", because gh pr review submits nothing without one.'
        }
        // Parenthesised on purpose: `&&` binds tighter than `||`, so without the
        // outer parens this reads as "(is a number and not an integer) or (<= 0)",
        // which happens to be right but looks like the classic precedence bug.
        if ((typeof a.number === 'number' && !Number.isInteger(a.number)) || a.number <= 0) {
          return 'github_pr review: `number` must be a positive integer.'
        }
        return null
      },
      argv: (a) => {
        const argv = ['pr', 'review', String(a.number)]
        if (a.reviewAction === 'approve') argv.push('--approve')
        else if (a.reviewAction === 'request-changes') argv.push('--request-changes')
        else argv.push('--comment')
        pushTextSource(argv, a, 'body', { fallback: '' })
        return argv
      },
    },
    ready: {
      help: 'Mark a draft pull request as ready for review (requires confirm: true).',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => ['pr', 'ready', String(a.number)],
    },
    checkout: {
      help: 'Check out a pull request\'s branch locally, optionally under a different local branch name.',
      needs: ['number'],
      requiresRepo: true,
      argv: (a) => {
        const argv = ['pr', 'checkout', String(a.number)]
        if (a.branch) argv.push('--branch', a.branch)
        return argv
      },
    },
    merge: {
      help: 'Merge a pull request (requires confirm: true). gh reports an unmergeable request when it tries; it does not pre-check mergeability, and an auto-merge may be scheduled instead.',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      check: (a) =>
        typeof a.number === 'number' && Number.isInteger(a.number) && a.number > 0
          ? null
          : 'github_pr merge: `number` must be a positive integer.',
      argv: (a) => {
        const argv = ['pr', 'merge', String(a.number)]
        if (a.mergeMethod) argv.push(`--${a.mergeMethod}`)
        if (a.deleteBranch === true) argv.push('--delete-branch')
        if (a.subject) argv.push('--subject', a.subject)
        return argv
      },
    },
    close: {
      help: 'Close a pull request without merging (requires confirm: true).',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => {
        const argv = ['pr', 'close', String(a.number)]
        if (a.body) argv.push('--comment', a.body)
        return argv
      },
    },
    reopen: {
      help: 'Reopen a closed pull request (requires confirm: true).',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => ['pr', 'reopen', String(a.number)],
    },
    edit: {
      help: 'Edit a pull request\'s title, body, or base branch (requires confirm: true).',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => {
        const argv = ['pr', 'edit', String(a.number)]
        if (a.title) argv.push('--title', a.title)
        pushTextSource(argv, a, 'body')
        if (a.base) argv.push('--base', a.base)
        return argv
      },
    },
  },
}

export default domain
