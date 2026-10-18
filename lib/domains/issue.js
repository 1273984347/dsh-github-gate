/**
 * github_issue — issue lifecycle.
 *
 * The most-used read path in practice: find an issue, read it, then either
 * comment on it or close it with a reason.
 */

import { str, bool, int, strArr, enumStr } from '../schema.js'
import { pushTextSource } from '../argv.js'

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_issue',
  title: 'Issue',
  readOnlyActions: ['list', 'view'],
  description:
    'Create, inspect, and manage issues. Use list with a search query to find work, view to read ' +
    'one in full, and comment or close to act on it. Closing with a reason other than "completed" ' +
    'requires confirm: true because it records a negative outcome.',
  params: {
    repo: str('requiresRepo: target repository as "owner/name". Omit it to use the workspace remote.'),
    number: int('needs: the issue number for actions that target one (view, comment, close, reopen, edit).'),
    title: str('create: issue title.'),
    body: str('create/comment: markdown body text.'),
    bodyFile: str('create/comment: read the body from this file instead of `body`.'),
    state: enumStr(['open', 'closed', 'all'], 'list: filter by issue state (default open).'),
    limit: int('list: maximum issues to return (default 30).'),
    label: str('list/create/edit: a label name.'),
    labels: strArr('create/edit: label names to apply.'),
    assignee: str('list/create/edit: a user login to assign.'),
    author: str('list: filter by author login.'),
    search: str('list: filter by a search query.'),
    milestone: str('create/edit: milestone name or number.'),
    reason: enumStr(['completed', 'not planned'], 'close: why the issue is being closed.'),
    base: str('develop: the remote branch to create the new branch from.'),
    confirm: bool('DESTRUCTIVE: set to true to explicitly confirm this action.'),
    timeoutMs: int('Optional per-call timeout in milliseconds.'),
  },
  globalRepoFlag: true,
  actions: {
    list: {
      help: 'List issues, filtered by state, label, assignee, author, or a search query.',
      needs: [],
      requiresRepo: true,
      json: 'number,title,state,labels,assignees,author,updatedAt,url',
      argv: (a) => {
        const argv = ['issue', 'list', '--limit', String(a.limit ?? 30)]
        if (a.state) argv.push('--state', a.state)
        if (a.label) argv.push('--label', a.label)
        if (a.assignee) argv.push('--assignee', a.assignee)
        if (a.author) argv.push('--author', a.author)
        if (a.search) argv.push('--search', a.search)
        return argv
      },
    },
    view: {
      help: 'Show one issue in full: body, labels, assignees, and comment count.',
      needs: ['number'],
      requiresRepo: true,
      json: 'number,title,body,state,labels,assignees,author,createdAt,url',
      argv: (a) => ['issue', 'view', String(a.number)],
    },
    create: {
      help: 'Create an issue (requires `title` and confirm: true).',
      needs: ['title'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => {
        const argv = ['issue', 'create', '--title', a.title]
        pushTextSource(argv, a, 'body')
        for (const label of a.labels ?? (a.label ? [a.label] : [])) argv.push('--label', label)
        if (a.assignee) argv.push('--assignee', a.assignee)
        if (a.milestone) argv.push('--milestone', a.milestone)
        return argv
      },
    },
    comment: {
      help: 'Add a comment to an issue.',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      check: (a) =>
        typeof a.body === 'string' && a.body !== '' ? null : 'github_issue comment: `body` is required.',
      argv: (a) => {
        const argv = ['issue', 'comment', String(a.number)]
        pushTextSource(argv, a, 'body')
        return argv
      },
    },
    close: {
      help: 'Close an issue. Closing as "not planned" requires confirm: true.',
      needs: ['number'],
      requiresRepo: true,
      // Closing an issue is a state change that a person is asked about, because the
      // tool description and the injected prompt both promise that closing raises a
      // prompt. Neither may stay silent while the documents say otherwise.
      destructive: true,
      check: (a) =>
        a.reason === 'not planned' && a.confirm !== true
          ? 'github_issue close: closing as "not planned" records a negative outcome — set confirm: true.'
          : null,
      argv: (a) => {
        const argv = ['issue', 'close', String(a.number)]
        if (a.reason) argv.push('--reason', a.reason)
        if (a.body) argv.push('--comment', a.body)
        return argv
      },
    },
    reopen: {
      help: 'Reopen a closed issue (requires confirm: true).',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => {
        const argv = ['issue', 'reopen', String(a.number)]
        if (a.body) argv.push('--comment', a.body)
        return argv
      },
    },
    edit: {
      help: 'Edit an issue\'s title, body, labels, assignee, or milestone (requires confirm: true).',
      needs: ['number'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => {
        const argv = ['issue', 'edit', String(a.number)]
        if (a.title) argv.push('--title', a.title)
        pushTextSource(argv, a, 'body')
        // The same `labels ?? (label ? [label] : [])` fallback `create` uses. The
        // description promises `label` for edit as well, and without this the
        // parameter was silently ignored: `issue edit` with `label` added nothing.
        for (const label of a.labels ?? (a.label ? [a.label] : [])) argv.push('--add-label', label)
        if (a.assignee) argv.push('--add-assignee', a.assignee)
        if (a.milestone) argv.push('--milestone', a.milestone)
        return argv
      },
    },
    develop: {
      help: 'Create and link a branch for an issue, so work is associated with it (requires confirm: true). Pass `base` to branch from something other than the default.',
      needs: ['number'],
      requiresRepo: true,
      // `gh issue develop` creates a REMOTE branch and checks it out locally. It is
      // a write in two places, which is why it was missed: it reads as a
      // convenience rather than an action. It is a state change.
      destructive: true,
      argv: (a) => {
        const argv = ['issue', 'develop', String(a.number)]
        if (a.base) argv.push('--base', a.base)
        return argv
      },
    },
  },
}

export default domain
