/**
 * github_release — release and tag management.
 *
 * Asset upload and download are the two actions that can move large amounts of
 * data, so they are marked `long` and get the watch timeout budget.
 */

import { str, bool, int, enumStr } from '../schema.js'
import { pushTextSource } from '../argv.js'

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_release',
  title: 'Release',
  // `download` is excluded on purpose: it writes asset files to the local
  // filesystem, so two concurrent downloads could race for the same path.
  readOnlyActions: ['list', 'view'],
  description:
    'Create, inspect, and manage releases and their assets. Use list to see existing tags and ' +
    'view to read one release. Create with generateNotes: true lets GitHub compose the notes from ' +
    'the commits since the previous tag, which is usually better than hand-writing them. Deleting ' +
    'a release or asset requires confirm: true.',
  params: {
    repo: str('requiresRepo: target repository as "owner/name". Omit it to use the workspace remote.'),
    tag: str('needs: the release tag (e.g. v1.2.0). Required for view, create, edit, delete, and upload.'),
    title: str('create/edit: the release title.'),
    notes: str('create/edit: release notes markdown.'),
    notesFile: str('create/edit: read the notes from this file instead of `notes`.'),
    target: str('create: the commit-ish to tag (defaults to the default branch head).'),
    generateNotes: bool('create: let GitHub generate the notes from commits since the last release.'),
    draft: bool('create/edit: keep the release as a draft.'),
    prerelease: bool('create/edit: mark the release as a prerelease.'),
    latest: bool('create/edit: mark the release as the latest.'),
    // Two different meanings by action, stated because they used to be conflated:
    // upload sends a LOCAL file path; download names a REMOTE asset, and gh has no
    // positional for it (`gh release download <tag>` takes one argument only), so
    // it travels as `--pattern`. A local path passed to download is therefore not
    // what this parameter means there.
    asset: str('upload: path to the local file to upload. download: the remote asset name to fetch, passed as --pattern (download accepts no second positional).'),
    pattern: str('download: a glob over remote asset names, e.g. "*.zip". Use instead of `asset` to select several.'),
    dir: str('download: directory to download assets into (default the current directory).'),
    limit: int('list: maximum releases to return (default 30).'),
    confirm: bool('DESTRUCTIVE: set to true to explicitly confirm this action.'),
    cleanupTag: bool('delete: also delete the git tag the release points at.'),
    timeoutMs: int('Optional per-call timeout in milliseconds.'),
  },
  globalRepoFlag: true,
  actions: {
    list: {
      help: 'List releases with their tags, names, and publication state.',
      needs: [],
      requiresRepo: true,
      // Field list verified against `gh release list`. This command does NOT
      // expose `url` (unlike `gh release view`), so asking for it made every
      // call fail with `Unknown JSON field: "url"`.
      json: 'tagName,name,isDraft,isPrerelease,isLatest,publishedAt',
      argv: (a) => ['release', 'list', '--limit', String(a.limit ?? 30)],
    },
    view: {
      help: 'Show one release: notes, assets, and publication state.',
      needs: ['tag'],
      requiresRepo: true,
      json: 'tagName,name,body,isDraft,isPrerelease,assets,publishedAt,url',
      argv: (a) => ['release', 'view', a.tag],
    },
    create: {
      help: 'Create a release for a tag (requires `tag`, notes or generateNotes, and confirm: true).',
      needs: ['tag'],
      requiresRepo: true,
      destructive: true,
      check: (a) =>
        a.generateNotes === true || typeof a.notes === 'string' || typeof a.notesFile === 'string'
          ? null
          : 'github_release create: provide `notes`, `notesFile`, or generateNotes: true.',
      argv: (a) => {
        const argv = ['release', 'create', a.tag]
        if (a.title) argv.push('--title', a.title)
        pushTextSource(argv, a, 'notes')
        if (a.generateNotes === true) argv.push('--generate-notes')
        if (a.target) argv.push('--target', a.target)
        if (a.draft === true) argv.push('--draft')
        if (a.prerelease === true) argv.push('--prerelease')
        // `latest: false` is a real request gh honours. An earlier comment claimed
        // the flag "cannot unmark" and implemented the option as a no-op, which
        // invented a limitation and lost the only way to move `latest` off a
        // release. `gh release create --help` documents `--latest=false` with its
        // own example.
        if (a.latest === false) argv.push('--latest=false')
        else if (a.latest === true) argv.push('--latest')
        return argv
      },
    },
    edit: {
      help: 'Edit a release\'s title, notes, or publication flags (requires confirm: true).',
      needs: ['tag'],
      requiresRepo: true,
      destructive: true,
      argv: (a) => {
        const argv = ['release', 'edit', a.tag]
        if (a.title) argv.push('--title', a.title)
        pushTextSource(argv, a, 'notes')
        if (a.draft === true) argv.push('--draft')
        if (a.prerelease === true) argv.push('--prerelease')
        // `latest: false` is a real request and gh supports it: `gh release create
        // --help` documents "--latest=false to explicitly NOT set as latest", with
        // its own example. An earlier comment claimed the flag "cannot unmark", so
        // the option was implemented as a no-op — inventing a limitation the tool
        // does not have, and losing the only way to move `latest` off a release.
        if (a.latest === false) argv.push('--latest=false')
        else if (a.latest === true) argv.push('--latest')
        return argv
      },
    },
    upload: {
      help: 'Upload an asset file to a release (requires `tag` and `asset`). Writing to a release is a state change, so it is confirmed like the rest.',
      needs: ['tag', 'asset'],
      requiresRepo: true,
      long: true,
      destructive: true,
      argv: (a) => ['release', 'upload', a.tag, a.asset],
    },
    download: {
      help: 'Download release assets into `dir` (requires `tag`; use `pattern` or `asset` to narrow it).',
      needs: ['tag'],
      requiresRepo: true,
      long: true,
      // NOT destructive: it reads from the API and writes files named after the
      // release's own assets. It writes the local disk, which is why it is also
      // excluded from `readOnlyActions` — two runners could race for one path.
      argv: (a) => {
        // `gh release download [<tag>]` takes AT MOST ONE positional. Passing the
        // asset name as a second one was rejected with "accepts at most 1 arg(s),
        // received 2". `--pattern` selects by name, and a single known asset is
        // expressed either through that glob or through `--output`.
        const argv = ['release', 'download', a.tag]
        if (a.pattern) argv.push('--pattern', a.pattern)
        else if (a.asset) argv.push('--pattern', a.asset)
        if (a.dir) argv.push('--dir', a.dir)
        return argv
      },
    },
    delete: {
      help: 'Delete a release and optionally its tag (requires confirm: true).',
      needs: ['tag'],
      requiresRepo: true,
      destructive: true,
      // `--cleanup-tag` is the flag that removes the tag too. The help always said
      // "optionally its tag" while no parameter could ask for it; now one can.
      argv: (a) => {
        const argv = ['release', 'delete', a.tag, '--yes']
        if (a.cleanupTag === true) argv.push('--cleanup-tag')
        return argv
      },
    },
  },
}

export default domain
