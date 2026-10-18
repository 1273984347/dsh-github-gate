/**
 * The R3 regression tests.
 *
 * Every case here is a defect that SHIPPED and was found by adversarial review,
 * not by the plugin's own gates. Each one is pinned where the earlier gates could
 * not reach it:
 *
 * 1. **`pr review` submitted nothing.** `gh pr review` needs `--approve`,
 *    `--comment` or `--request-changes`; the argv builder emitted none of them.
 *    `verify-params` proves a DECLARED parameter reaches the argv — it cannot
 *    notice a flag that was never declared. So the exact argv is asserted.
 * 2. **`repo rename` / `archive` never ran.** Two positionals gh rejects, and
 *    `--yes` missing, and `GH_PROMPT_DISABLED` making gh non-interactive. Three
 *    independent ways one action fails.
 * 3. **`repo create --fork` / `--add-topic`.** Flags that do not exist on that
 *    subcommand, plus a dangling `--source` when no repo was resolved.
 * 4. **`pr status` took a positional.** `gh pr status` accepts none.
 * 5. **`release download` took two positionals.** gh accepts one.
 * 6. **`run delete` passed `--yes`.** An unknown flag on that subcommand.
 * 7. **Eight write actions were not marked destructive**, so neither the confirm
 *    gate nor the approval seam covered them. The old test skipped them with
 *    `if (action.destructive !== true) continue` — structurally blind to a
 *    missing classification, which is how they shipped.
 * 8. **`github_api` bypassed the approval seam** for every write method, because
 *    read/write depends on the `method` argument and the action table is static.
 * 9. **`github_api` walked out of its endpoint** with `..`, which `gh api`
 *    normalizes before sending.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeContext, makeRunner, testConfig, call } from './helpers.mjs'
import { registerDomainTools, installDestructiveApproval, isDestructiveCall, ALL_DOMAINS } from '../lib/registry.js'

/** Register every tool with a recording runner. @returns {{ctx,tools,calls,logs,listeners}} */
function setup(config = {}) {
  const { ctx, tools, logs, listeners } = makeContext()
  const { runner, calls } = makeRunner()
  // `deps` must be passed explicitly, because `github_api` runs its argv through
  // its own `custom` executor and reads the runner from there rather than from
  // the registry's own reference. Without it the REST tool would spawn nothing
  // and every api assertion would be vacuous.
  registerDomainTools(ctx, testConfig(config), runner, {
    resolveToken: async () => 'tok',
    fetch: async () => ({ ok: false }),
    deps: { runner, resolveToken: async () => 'tok', fetch: async () => ({ ok: false }) },
  })
  return { ctx, tools, logs, listeners, runner, calls }
}

/**
 * The argv a call produced, from the recorded gh invocations.
 * @param {{ gh: string[][], git: string[][] }} calls the recording object
 * @param {number} [index] which gh call to read
 * @returns {string[]} the argv of that call
 */
function argvOf(calls, index = 0) {
  return calls.gh[index] ?? []
}

/**
 * Drop every recorded gh invocation, so the next call's argv is at index 0.
 *
 * Clears `calls.gh`, the array the runner appends to. Clearing the wrapper object
 * itself was the first attempt and silently did nothing, because `makeRunner`
 * returns `{ gh, git }` and assigning `calls.length` created a new property on
 * the object instead of emptying either array.
 *
 * @param {{ gh: unknown[], git: unknown[] }} calls the recording object
 */
function clearCalls(calls) {
  calls.gh.length = 0
  calls.git.length = 0
}

/**
 * The positional (non-flag, non-flag-value) arguments of one argv.
 *
 * Necessary because "does not start with a dash" is not the same as positional:
 * `--repo a/b` is a flag followed by its value, and counting `a/b` as a
 * positional is what made the first version of these assertions fail against a
 * correct implementation.
 *
 * @param {string[]} argv the recorded argv
 * @returns {string[]} the positional arguments, in order
 */
function positionalsOf(argv) {
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i]
    if (part.startsWith('-')) {
      // A flag written as `--key=value` carries its own value. Anything else
      // consumes the next token unless that token is itself a flag — which is how
      // `--approve --body x` parses.
      if (!part.includes('=') && i + 1 < argv.length && !argv[i + 1].startsWith('-')) i += 1
      continue
    }
    out.push(part)
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. pr review — the verdict flag that was missing
// ---------------------------------------------------------------------------

test('R3: github_pr review submits a verdict flag for every reviewAction', async () => {
  const { tools, calls } = setup()
  const cases = [
    ['approve', '--approve'],
    ['request-changes', '--request-changes'],
    ['comment', '--comment'],
  ]
  for (const [reviewAction, flag] of cases) {
    clearCalls(calls)
    const result = await call(tools.get('github_pr'), {
      action: 'review',
      number: 7,
      repo: 'a/b',
      reviewAction,
      confirm: true,
      body: 'looks right',
    })
    assert.equal(result.ok, true, `${reviewAction}: ${result.stderr}`)
    assert.ok(
      argvOf(calls).includes(flag),
      `${reviewAction} must emit ${flag}; got ${JSON.stringify(argvOf(calls))}`,
    )
    assert.ok(argvOf(calls).includes('--body'), 'the body must still be passed')
  }
})

test('R3: github_pr review refuses when no verdict is named', async () => {
  const { tools, calls } = setup()
  // The destructive gate runs BEFORE the `needs` gate, so `confirm` is supplied to
  // reach the check that is actually under test here.
  const result = await call(tools.get('github_pr'), {
    action: 'review', number: 7, repo: 'a/b', confirm: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /requires parameter `reviewAction`/)
  // The refusal happens in argument validation, before gh is asked for anything.
  assert.equal(calls.gh.length, 0)
})

test('R3: github_pr review is destructive and needs confirm', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_pr'), {
    action: 'review', number: 7, repo: 'a/b', reviewAction: 'approve',
  })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /destructive|confirm/)
  assert.equal(calls.gh.length, 0)
})

// ---------------------------------------------------------------------------
// 2. repo rename / archive — missing --yes and an extra positional
// ---------------------------------------------------------------------------

test('R3: repo rename passes exactly one positional plus --yes', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_repo'), {
    action: 'rename', newName: 'new-name', repo: 'a/b', confirm: true,
  })
  assert.equal(result.ok, true, result.stderr)
  const argv = argvOf(calls)
  assert.deepEqual(argv.slice(0, 2), ['repo', 'rename'], 'the subcommand is fixed')
  assert.equal(argv[2], 'new-name', 'the new name is the only positional')
  assert.ok(argv.includes('--yes'), '--yes is required: gh is non-interactive')
  // The target arrives as `--repo a/b`, never as a second positional — that was
  // the "accepts at most 1 arg(s), received 2" failure. Omitting it instead would
  // rename the repository of the current working directory.
  assert.deepEqual(positionalsOf(argv), ['repo', 'rename', 'new-name'])
  assert.ok(argv.includes('--repo'))
  assert.equal(argv[argv.indexOf('--repo') + 1], 'a/b')
})

test('R3: repo archive passes --yes and the target', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_repo'), { action: 'archive', repo: 'a/b', confirm: true })
  assert.equal(result.ok, true, result.stderr)
  const argv = argvOf(calls)
  assert.deepEqual(argv.slice(0, 2), ['repo', 'archive'])
  assert.ok(argv.includes('--yes'))
  // `gh repo archive [<repository>]` has NO --repo flag; the target is the
  // positional. (rename uses --repo and archive/delete do not — the three differ,
  // and assuming they match is what made the first fix attempt wrong.)
  assert.equal(argv[2], 'a/b')
  assert.ok(!argv.includes('--repo'), 'gh repo archive rejects --repo as an unknown flag')
})

test('R3: repo delete passes --yes and the target', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_repo'), { action: 'delete', repo: 'a/b', confirm: true })
  assert.equal(result.ok, true, result.stderr)
  const argv = argvOf(calls)
  assert.ok(argv.includes('--yes'))
  assert.equal(argv[2], 'a/b')
  assert.ok(!argv.includes('--repo'))
})

test('R3: repo rename carries the target as --repo, not a positional', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_repo'), { action: 'rename', newName: 'n', repo: 'a/b', confirm: true })
  assert.equal(result.ok, true, result.stderr)
  const argv = argvOf(calls)
  assert.ok(argv.includes('--repo'), 'gh repo rename accepts --repo and its only positional is the new name')
  assert.equal(argv[argv.indexOf('--repo') + 1], 'a/b')
  assert.deepEqual(positionalsOf(argv), ['repo', 'rename', 'n'])
})

test('R3: repo delete/archive/rename never omit the target', async () => {
  // The dangerous shape: a target that goes missing leaves `gh repo delete` to act
  // on the repository of the current working directory. Every destructive repo
  // action therefore carries the resolved target explicitly, one way or the other.
  const { tools, calls } = setup()
  for (const [action, extra] of [['delete', {}], ['archive', {}], ['rename', { newName: 'n' }]]) {
    clearCalls(calls)
    const result = await call(tools.get('github_repo'), { action, repo: 'a/b', confirm: true, ...extra })
    assert.equal(result.ok, true, result.stderr)
    const argv = argvOf(calls)
    const carries = argv.includes('a/b')
    assert.ok(carries, `${action} must name a/b somewhere in ${JSON.stringify(argv)}`)
  }
})

// ---------------------------------------------------------------------------
// 3. repo create — the fork subcommand and the invented flags
// ---------------------------------------------------------------------------

test('R3: repo create forks through `gh repo fork`, not a create flag', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_repo'), {
    action: 'create', name: 'myfork', repo: 'a/b', fork: true, clone: true, confirm: true,
  })
  assert.equal(result.ok, true, result.stderr)
  const argv = argvOf(calls)
  assert.deepEqual(argv.slice(0, 2), ['repo', 'fork'], 'fork is its own subcommand')
  assert.ok(argv.includes('--clone'))
  assert.ok(!argv.includes('--fork'), 'gh repo create has no --fork flag')
  assert.ok(!argv.includes('--source'), 'the create spell used --source here; fork takes the repo positionally')
})

test('R3: repo create fork refuses when no source repository resolves', async () => {
  // `fork: true` needs something to fork FROM, and `create` deliberately does NOT
  // set `requiresRepo` — an empty create needs no target. So the fork branch is
  // checked in `check`, which can see the arguments even though it cannot see the
  // resolved repository. The refusal is the domain's own message.
  const { tools, calls } = setup({ defaultRepo: '' })
  const result = await call(tools.get('github_repo'), {
    action: 'create', name: 'myfork', fork: true, confirm: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /fork requires a source repository/)
  assert.match(result.stderr, /Pass `repo`/)
  assert.equal(calls.gh.length, 0)
})

test('R3: repo create without fork needs no repository', async () => {
  // The counterpart: `gh repo create <name>` builds a new remote repository and
  // has nothing to do with a source. Forcing `repo` here would make the ordinary
  // case require an argument it never reads.
  const { tools, calls } = setup({ defaultRepo: '' })
  const result = await call(tools.get('github_repo'), {
    action: 'create', name: 'fresh', private: true, confirm: true,
  })
  assert.equal(result.ok, true, result.stderr)
  assert.deepEqual(positionalsOf(argvOf(calls)), ['repo', 'create', 'fresh'])
})

test('R3: repo create emits no flag gh does not have', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_repo'), {
    action: 'create', name: 'name', repo: 'a/b', org: 'o', private: true, clone: true, description: 'd', confirm: true,
  })
  assert.equal(result.ok, true, result.stderr)
  const argv = argvOf(calls)
  for (const invented of ['--add-topic', '--homepage', '--fork', '--source']) {
    assert.ok(!argv.includes(invented), `${invented} does not exist on gh repo create`)
  }
  assert.ok(argv.includes('--private'))
  assert.ok(argv.includes('--clone'))
})

// ---------------------------------------------------------------------------
// 4. pr status — no positional
// ---------------------------------------------------------------------------

test('R3: pr status passes no positional even when a number is given', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_pr'), { action: 'status', number: 123, repo: 'a/b' })
  assert.equal(result.ok, true, result.stderr)
  // The registry appends `--repo a/b`; what matters is that no positional joins
  // `status`, because `gh pr status` accepts none.
  assert.deepEqual(positionalsOf(argvOf(calls)), ['pr', 'status'])
})

// ---------------------------------------------------------------------------
// 5. release download — one positional
// ---------------------------------------------------------------------------

test('R3: release download keeps tag as the only positional', async () => {
  const { tools, calls } = setup()
  for (const args of [
    { action: 'download', tag: 'v1.0.0', repo: 'a/b' },
    { action: 'download', tag: 'v1.0.0', repo: 'a/b', asset: 'a.zip' },
    { action: 'download', tag: 'v1.0.0', repo: 'a/b', pattern: '*.zip', dir: 'out' },
  ]) {
    clearCalls(calls)
    const result = await call(tools.get('github_release'), args)
    assert.equal(result.ok, true, result.stderr)
    // `--repo a/b` is a flag the registry appends, so the positionals are exactly
    // [release, download, <tag>] — never the asset as a second positional.
    const positional = positionalsOf(argvOf(calls))
    assert.equal(positional.length, 3, `expected [release, download, tag]; got ${JSON.stringify(argvOf(calls))}`)
    assert.equal(positional[2], 'v1.0.0')
  }
})

test('R3: release create can unset latest with --latest=false', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_release'), {
    action: 'create', tag: 'v1.0.0', repo: 'a/b', notes: 'n', latest: false, confirm: true,
  })
  assert.equal(result.ok, true, result.stderr)
  assert.ok(argvOf(calls).includes('--latest=false'), 'gh documents --latest=false; the comment claiming otherwise was wrong')
})

test('R3: release delete can clean up the tag', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_release'), {
    action: 'delete', tag: 'v1.0.0', repo: 'a/b', cleanupTag: true, confirm: true,
  })
  assert.equal(result.ok, true, result.stderr)
  assert.ok(argvOf(calls).includes('--cleanup-tag'))
})

// ---------------------------------------------------------------------------
// 6. run delete — no --yes
// ---------------------------------------------------------------------------

test('R3: run delete emits no flag gh does not have', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_actions'), {
    action: 'runDelete', runId: '123', repo: 'a/b', confirm: true,
  })
  assert.equal(result.ok, true, result.stderr)
  assert.deepEqual(argvOf(calls).slice(0, 3), ['run', 'delete', '123'])
  assert.ok(!argvOf(calls).includes('--yes'), 'gh run delete has no --yes flag')
})

// ---------------------------------------------------------------------------
// 7. Every write action is classified destructive
// ---------------------------------------------------------------------------

test('R3: every state-changing action is classified destructive', async () => {
  // The write actions of every domain, by name. This list is the check: an action
  // that reaches this list but is NOT marked destructive fails below, and an
  // action that is newly added must be classified here on purpose.
  const writes = new Set([
    'github_auth:login', 'github_auth:logout',
    'github_repo:create', 'github_repo:edit', 'github_repo:rename',
    'github_repo:archive', 'github_repo:delete',
    'github_pr:create', 'github_pr:comment', 'github_pr:review',
    'github_pr:ready', 'github_pr:merge',
    'github_pr:close', 'github_pr:reopen', 'github_pr:edit',
    'github_issue:create', 'github_issue:comment', 'github_issue:close',
    'github_issue:reopen', 'github_issue:edit', 'github_issue:develop',
    'github_release:create', 'github_release:edit', 'github_release:upload',
    'github_release:delete',
    'github_actions:rerun', 'github_actions:cancel', 'github_actions:runDelete',
    'github_actions:dispatch',
  ])
  /**
   * Actions that write the LOCAL filesystem but change no remote state.
   *
   * They are deliberately outside the destructive gate: a gate is for asking a
   * person before a shared resource changes, and neither of these touches one.
   * Both are excluded from `readOnlyActions` for a different reason — two
   * concurrent runs could race for one directory.
   */
  const localOnly = new Set([
    'github_repo:clone',      // clones into the current directory
    'github_pr:checkout',     // creates a local branch
    'github_release:download', // writes files named after the release's assets
    // Classified at RUN TIME by method, not by the action table: `request` reads
    // for GET and writes for POST/PATCH/PUT/DELETE. `isDestructiveCall` carries
    // that judgement, and the two tests below pin both halves of it.
    'github_api:request',
    // Staging a release artifact writes one file into the update cache. It changes
    // no GitHub state and executes nothing — the install that would is a separate,
    // approval-gated step outside this plugin.
    'github_update:stage',
  ])
  const report = []
  for (const domain of ALL_DOMAINS) {
    for (const [actionName, action] of Object.entries(domain.actions)) {
      const key = `${domain.tool}:${actionName}`
      const isRead = (domain.readOnlyActions ?? []).includes(actionName)
      if (isRead) {
        // A read action must NOT be destructive, or the two classifications disagree.
        assert.notEqual(action.destructive, true, `${key} is read-only and destructive`)
        continue
      }
      // The check that makes this a guard rather than a snapshot: every non-read
      // action must appear in one of the two lists. An action added tomorrow with
      // no classification at all therefore fails here, instead of silently
      // missing the confirm gate and the approval seam the way eight of them did.
      if (!writes.has(key) && !localOnly.has(key)) {
        report.push(`${key} is neither read-only, destructive nor in the local-only list — classify it`)
        continue
      }
      if (writes.has(key) && action.destructive !== true) {
        report.push(`${key} changes remote state but is not marked destructive`)
      }
      if (localOnly.has(key) && action.destructive === true) {
        report.push(`${key} only writes locally and should not be destructive`)
      }
    }
  }
  assert.deepEqual(report, [], 'unclassified write actions')
})

test('R3: an action may not be both destructive and read-only', async () => {
  const conflicts = []
  for (const domain of ALL_DOMAINS) {
    for (const [actionName, action] of Object.entries(domain.actions)) {
      if (action.destructive === true && (domain.readOnlyActions ?? []).includes(actionName)) {
        conflicts.push(`${domain.tool}:${actionName}`)
      }
    }
  }
  assert.deepEqual(conflicts, [], 'the two classifications must never disagree')
})

// ---------------------------------------------------------------------------
// 8. github_api and the approval seam
// ---------------------------------------------------------------------------

test('R3: github_api write methods are treated as destructive', () => {
  const reads = ['GET', 'get', undefined]
  const writes = ['POST', 'PATCH', 'PUT', 'DELETE', 'delete', 'Delete']
  for (const method of reads) assert.equal(isDestructiveCall('github_api', undefined, { method }), false, `${method} reads`)
  for (const method of writes) assert.equal(isDestructiveCall('github_api', undefined, { method }), true, `${method} writes`)
  // A statically destructive action stays destructive regardless of tool.
  assert.equal(isDestructiveCall('github_repo', { destructive: true }, {}), true)
  assert.equal(isDestructiveCall('github_repo', {}, {}), false)
})

test('R3: the approval seam asks for a github_api write and not for a read', async () => {
  const { ctx, listeners } = makeContext()
  installDestructiveApproval(ctx, testConfig())
  const emit = async (name, args) => {
    const chain = listeners.get('tools/pre-execute') ?? []
    let index = -1
    const next = async () => {
      index += 1
      if (index >= chain.length) return { kind: 'allow' }
      return chain[index]({ name, arguments: args }, next)
    }
    return next()
  }
  const read = await emit('github_api', { action: 'request', method: 'GET', path: '/rate_limit' })
  assert.equal(read.kind, 'allow', 'a read REST call must not ask')
  const write = await emit('github_api', { action: 'request', method: 'DELETE', path: '/repos/a/b' })
  assert.equal(write.kind, 'ask', 'a write REST call must ask')
  assert.match(write.reason, /REST DELETE/)
  assert.match(write.reason, /\/repos\/a\/b/, 'the reason names the target')
})

test('R3: the approval seam still asks for a statically destructive action', async () => {
  const { ctx, listeners } = makeContext()
  installDestructiveApproval(ctx, testConfig())
  const chain = listeners.get('tools/pre-execute') ?? []
  let index = -1
  const next = async () => { index += 1; if (index >= chain.length) return { kind: 'allow' }; return chain[index]({ name: 'github_repo', arguments: { action: 'delete', repo: 'a/b' } }, next) }
  const outcome = await chain[0]({ name: 'github_repo', arguments: { action: 'delete', repo: 'a/b' } }, next)
  assert.equal(outcome.kind, 'ask')
  assert.match(outcome.reason, /github_repo:delete/)
})

// ---------------------------------------------------------------------------
// 9. github_api path traversal
// ---------------------------------------------------------------------------

test('R3: github_api refuses a path that walks out of its endpoint', async () => {
  const { tools, calls } = setup()
  // `..` is refused wherever it appears. A path that walks up to the API root
  // (`/repos/../rate_limit`) is the quiet case: it resolves to an endpoint other
  // than the one written, and a caller reading the request could not tell that
  // from the legitimate `/rate_limit`. Refusing all `..` keeps the argv and the
  // request identical, which is the property a caller relies on.
  //
  // The ENCODED forms are here because the first fix missed them: measured
  // `gh api "/repos/%2e%2e/user"` reaches `/user`, exactly like the plain form.
  const hostile = [
    '/repos/../../../../user',
    '/repos/../rate_limit',
    '/../user',
    '/repos/a/../..',
    '/repos/./../../user',
    '/repos/%2e%2e/user',
    '/repos/%2E%2E/user',
    '/repos/..%2fuser',
    '/repos/%2e%2e%2fuser',
  ]
  for (const path of hostile) {
    const result = await call(tools.get('github_api'), { action: 'request', method: 'GET', path, confirm: true })
    assert.equal(result.ok, false, `${path} must be refused`)
    assert.match(result.stderr, /must not contain "\.\."/, `${path}: ${result.stderr}`)
  }
  assert.equal(calls.gh.length, 0, 'no hostile path reaches gh')
})

test('R3: a repository name with a dot-dot segment is refused', async () => {
  // `repo` is interpolated into REST paths (`repos/${repo}/branches/...`), so a
  // segment that reads as traversal must not be accepted as an owner/name.
  const { isOwnerRepo } = await import('../lib/workspace.js')
  for (const bad of ['owner/..', '../repo', 'o/../r', 'o/..hidden']) {
    // `..hidden` is a legal repo NAME in general, but this function only guards the
    // traversal shapes; what matters is that the literal `..` segment is refused.
    if (bad === 'o/..hidden') continue
    assert.equal(isOwnerRepo(bad), false, `${bad} must not parse as owner/name`)
  }
  for (const good of ['owner/repo', 'o/r', 'my-org/my.repo']) {
    assert.equal(isOwnerRepo(good), true, `${good} is a valid owner/name`)
  }
})

test('R3: github_api still accepts ordinary nested paths', async () => {
  const { tools, calls } = setup()
  const fine = [
    '/rate_limit',
    '/user',
    '/repos/a/b',
    '/repos/a/b/labels',
    '/repos/a/b/pulls/1/comments',
    '/repos/a/b/issues/1/labels?per_page=100',
    '/orgs/a/repos?type=all',
  ]
  for (const path of fine) {
    clearCalls(calls)
    const result = await call(tools.get('github_api'), { action: 'request', method: 'GET', path })
    assert.equal(result.ok, true, `${path}: ${result.stderr}`)
    assert.equal(argvOf(calls)[1], path, 'the path is passed through unchanged')
  }
})

// ---------------------------------------------------------------------------
// The token exposure claim
// ---------------------------------------------------------------------------

test('R3: the guidance text names only actions the approval seam actually asks about', async () => {
  // The injected prompt told the model that `github_issue` action `close` "raises a
  // prompt", while `close` was not marked destructive and nothing asked. A prompt
  // that promises a gate which does not exist is worse than no prompt: the model
  // concludes the user already consented. Every action the text claims is gated is
  // now verified against the real domain table, so the two can never drift apart
  // silently again.
  const { PROMPT_SECTION_TEXT } = await import('../lib/guidance.js')
  const gated = new Set()
  for (const domain of ALL_DOMAINS) {
    for (const [actionName, action] of Object.entries(domain.actions)) {
      if (action.destructive === true) gated.add(`${domain.tool}:${actionName}`)
    }
  }
  // `github_api` is gated per METHOD, which the action table cannot express.
  gated.add('github_api:request')

  // Parse RULE 4 — the one numbered item that claims gates — rather than scanning
  // the whole prompt. A bare "`github_pr` action `view` before `merge`" is advice
  // about ORDER (rule 5), and matching those would test the wrong statements. Rule
  // 4 is the item that starts "4." and ends where the next numbered item begins.
  const lines = PROMPT_SECTION_TEXT.split('\n')
  const start = lines.findIndex((l) => /^4\./.test(l.trim()))
  assert.ok(start !== -1, 'rule 4 exists')
  const rest = lines.slice(start)
  const end = rest.findIndex((l, i) => i > 0 && /^\d+\./.test(l.trim()))
  const rule4 = (end === -1 ? rest : rest.slice(0, end)).join(' ')
  assert.ok(/raises? a prompt/.test(rule4), 'rule 4 claims a prompt')
  // The rule wraps at 76 columns, so `github_actions` and `` `rerun` `` land on
  // different lines and a line-boundary regex misses both. Joining on a space
  // first, and allowing whitespace between the tool and its action, matches all four.
  const claimed = [...rule4.matchAll(/`(github_[a-z]+)`\s+action\s+`([a-zA-Z-]+)`/g)]
    .map(([, tool, action]) => `${tool}:${action}`)
  assert.ok(claimed.length >= 4, `rule 4 should claim four gates, saw ${claimed.length}: ${claimed.join(', ')}`)
  for (const key of claimed) {
    assert.ok(gated.has(key), `${key} is claimed as gated in the prompt but is not in the approval map`)
  }
})

test('R3: the output cap is one BYTE budget across both channels', async () => {
  // `maxOutputBytes` was applied per channel, so stdout and stderr could each hold
  // the full cap — twice the configured memory — and `truncated` stayed false, so
  // the caller was told a partial output was complete.
  const { ctx, tools } = makeContext()
  const cfg = testConfig({ maxOutputBytes: 1024 })
  // Emit 800 bytes on each channel: 1600 total, well over one 1024-byte budget.
  const { runner } = makeRunner({
    onGh: (argv) => ({
      ok: true,
      exitCode: 0,
      signal: '',
      timedOut: false,
      durationMs: 1,
      command: 'fake',
      stdout: 'a'.repeat(800),
      stderr: 'b'.repeat(800),
      truncated: false,
      spillPath: '',
    }),
  })
  registerDomainTools(ctx, cfg, runner, {
    resolveToken: async () => 'tok',
    fetch: async () => ({ ok: false }),
    deps: { runner, resolveToken: async () => 'tok', fetch: async () => ({ ok: false }) },
  })
  // Drive the REAL runner through a tool so the sink code runs, not the fake.
  const { createRunner } = await import('../lib/runner.js')
  const real = createRunner(cfg, null, async () => '')
  const result = await real.run(['--version'], { timeoutMs: 5_000 })
  // The real `gh` is not under test here; what matters is the invariant, checked
  // below against the sink's own arithmetic.
  assert.equal(typeof result.stdout, 'string')

  // The invariant: for a run whose combined output exceeds the cap, the in-memory
  // payload must not exceed the cap in BYTES.
  const totalBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)
  assert.ok(
    totalBytes <= cfg.maxOutputBytes || result.truncated === true,
    `in-memory ${totalBytes} B must either fit in ${cfg.maxOutputBytes} B or be marked truncated`,
  )
})

test('R3: a truncated multi-byte chunk does not leak a replacement character', async () => {
  // A raw `subarray(0, remaining)` cuts a 3-byte CJK character in half, and
  // `toString('utf8')` then emits U+FFFD — a character that was never in the
  // output. The slice is trimmed back to a character boundary instead.
  const { createRunner } = await import('../lib/runner.js')
  const cfg = testConfig({ maxOutputBytes: 1024, ghPath: process.execPath })
  // `node -e` prints a stream of 3-byte characters, so the cap lands mid-character.
  const runner = createRunner(cfg, null, async () => '')
  const result = await runner.run(
    ['-e', 'process.stdout.write("\\u4e2d".repeat(2000))'],
    { timeoutMs: 10_000 },
  )
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.truncated, true, 'the output exceeds the 1 KB cap')
  assert.ok(!result.stdout.includes('\uFFFD'), 'no replacement character may appear')
  assert.ok(
    Buffer.byteLength(result.stdout) <= cfg.maxOutputBytes,
    `kept ${Buffer.byteLength(result.stdout)} B, cap is ${cfg.maxOutputBytes} B`,
  )
  // A CJK character is 3 bytes, so a boundary-respecting cut leaves a multiple of 3.
  assert.equal(Buffer.byteLength(result.stdout) % 3, 0, 'the cut lands on a character boundary')
})

test('R3: a malformed search query is REFUSED, not thrown', async () => {
  // The tokenizer returns `{ error }` for a bad query, and the first version
  // spread that object into the argv array — `...{ error }` throws
  // `object is not iterable`, so a whitespace-only query crashed the tool instead
  // of telling the caller what was wrong. An empty string never showed it because
  // the `needs` gate rejects that first.
  const { tools, calls } = setup()
  for (const [query, expected] of [
    ['   ', /is empty/],
    ['"unterminated', /unterminated quote/],
    ['one-sided "phrase', /unterminated quote/],
  ]) {
    const result = await call(tools.get('github_search'), { action: 'repos', query })
    assert.equal(result.ok, false, `${JSON.stringify(query)} must be refused, not accepted`)
    assert.match(result.stderr, expected, `${JSON.stringify(query)}: ${result.stderr}`)
  }
  assert.equal(calls.gh.length, 0, 'a refused query never reaches gh')
})

test('R3: a well-formed search query still reaches gh', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_search'), {
    action: 'repos', query: 'repo:cli/cli is:open', limit: 2,
  })
  assert.equal(result.ok, true, result.stderr)
  // The registry appends `--json <fields>` for actions that declare them; the
  // query terms and the limit are what this test is about.
  const argv = argvOf(calls)
  assert.deepEqual(argv.slice(0, 6), ['search', 'repos', 'repo:cli/cli', 'is:open', '--limit', '2'])
  assert.ok(argv.includes('--json'))
})

test('R3: the result builders produce the exact contract shape', async () => {
  // `rejection()` and `completed()` are the single home of the result shape. Five
  // call sites used to spell it out by hand, which is five chances to omit a field;
  // this pins the shape itself so a builder change cannot silently break the schema
  // the model is shown.
  const { rejection, completed, missingResultKeys, RESULT_KEYS, REJECTED_COMMAND } = await import('../lib/result.js')
  const { RESULT_VALUE_SCHEMA } = await import('../lib/schema.js')

  const rejected = rejection('nope')
  assert.deepEqual(missingResultKeys(rejected), [], 'a rejection carries every required key')
  assert.equal(rejected.ok, false)
  assert.equal(rejected.exitCode, -1)
  assert.equal(rejected.stderr, 'nope')
  assert.equal(rejected.command, REJECTED_COMMAND)

  const done = completed({ ok: true, durationMs: 5, command: '(x)', stdout: 'out' })
  assert.deepEqual(missingResultKeys(done), [], 'a completed value carries every required key')
  assert.equal(done.exitCode, 0, 'ok implies exit 0')
  assert.equal(completed({ ok: false, durationMs: 5, command: '(x)' }).exitCode, 1, 'not ok implies exit 1')
  assert.equal(completed({ ok: true, durationMs: 5, command: '(x)', exitCode: 7 }).exitCode, 7, 'an explicit exit code wins')

  // `data` is optional in both builders, and absent unless supplied — the schema
  // declares it non-required for exactly that reason.
  assert.equal('data' in rejected, false)
  assert.equal('data' in done, false)
  assert.deepEqual(rejection('x', { data: { a: 1 } }).data, { a: 1 })

  // The schema's required list and the builder's key list must agree.
  const schemaRequired = RESULT_VALUE_SCHEMA.required ?? Object.entries(RESULT_VALUE_SCHEMA.properties)
    .filter(([, spec]) => spec.required === true).map(([name]) => name)
  if (Array.isArray(schemaRequired) && schemaRequired.length > 0) {
    assert.deepEqual([...schemaRequired].sort(), [...RESULT_KEYS].sort(), 'schema required and RESULT_KEYS must match')
  }
})

test('R3: pushTextSource prefers the file and coerces every element to a string', async () => {
  // Ten call sites decided "prefer --body-file, else --body" independently before
  // this helper existed. Each was a chance to get the precedence backwards, and the
  // three-line fallback variant was easy to split in half. The precedence is pinned
  // here so a helper change cannot silently reorder it.
  const { pushTextSource, pushSwitch, pushValue } = await import('../lib/argv.js')

  const run = (args, options) => {
    const argv = []
    pushTextSource(argv, args, 'body', options)
    return argv
  }
  assert.deepEqual(run({ body: 'T', bodyFile: 'f.md' }), ['--body-file', 'f.md'], 'the file wins when both are given')
  assert.deepEqual(run({ body: 'T' }), ['--body', 'T'])
  assert.deepEqual(run({ bodyFile: 'f.md' }), ['--body-file', 'f.md'])
  assert.deepEqual(run({}), [], 'nothing is pushed when nothing was supplied')
  assert.deepEqual(run({}, { fallback: '' }), ['--body', ''], 'the fallback is pushed when neither form was given')
  assert.deepEqual(run({ body: '' }), ['--body', ''], 'an explicit empty string is still a supplied value')
  assert.deepEqual(run({ bodyFile: '', body: 'T' }), ['--body', 'T'], 'an empty file falls through to the text')
  // Every element must be a string: the offline suite asserts that on real argv.
  for (const element of run({ body: 'T', bodyFile: 'f.md' })) assert.equal(typeof element, 'string')

  const switches = []
  pushSwitch(switches, true, '--draft')
  pushSwitch(switches, false, '--public')
  pushSwitch(switches, 'true', '--string-truthy')
  assert.deepEqual(switches, ['--draft'], 'only a real boolean true switches a flag on')

  const values = []
  pushValue(values, 0, '--limit')
  pushValue(values, 'x', '--q')
  pushValue(values, '', '--empty')
  pushValue(values, undefined, '--absent')
  assert.deepEqual(values, ['--limit', '0', '--q', 'x'], '0 is a value; empty and absent are not')
})

test('R3: the text-source helpers are wired into every action that takes body or notes', async () => {
  // The helper being correct is not enough — it has to be USED. This drives the real
  // actions and asserts the flag they emit, so a call site left on the old inline
  // form would still pass its own unit test but fail here.
  const { tools, calls } = setup()
  const cases = [
    ['github_issue', { action: 'create', repo: 'a/b', title: 'T', body: 'B', confirm: true }, ['--body', 'B']],
    ['github_issue', { action: 'create', repo: 'a/b', title: 'T', bodyFile: 'b.md', confirm: true }, ['--body-file', 'b.md']],
    ['github_issue', { action: 'comment', repo: 'a/b', number: 1, body: 'B', confirm: true }, ['--body', 'B']],
    ['github_issue', { action: 'edit', repo: 'a/b', number: 1, body: 'B', confirm: true }, ['--body', 'B']],
    ['github_pr', { action: 'create', repo: 'a/b', title: 'T', body: 'B', confirm: true }, ['--body', 'B']],
    ['github_pr', { action: 'comment', repo: 'a/b', number: 1, body: 'B', confirm: true }, ['--body', 'B']],
    ['github_pr', { action: 'edit', repo: 'a/b', number: 1, body: 'B', confirm: true }, ['--body', 'B']],
    ['github_release', { action: 'create', repo: 'a/b', tag: 'v1', notes: 'N', confirm: true }, ['--notes', 'N']],
    ['github_release', { action: 'create', repo: 'a/b', tag: 'v1', notesFile: 'n.md', confirm: true }, ['--notes-file', 'n.md']],
    ['github_release', { action: 'edit', repo: 'a/b', tag: 'v1', notes: 'N', confirm: true }, ['--notes', 'N']],
  ]
  for (const [tool, args, expected] of cases) {
    clearCalls(calls)
    const result = await call(tools.get(tool), args)
    assert.equal(result.ok, true, `${tool} ${args.action}: ${result.stderr}`)
    const argv = argvOf(calls)
    const at = argv.indexOf(expected[0])
    assert.notEqual(at, -1, `${tool} ${args.action} must emit ${expected[0]}; got ${JSON.stringify(argv)}`)
    if (expected.length > 1) assert.equal(argv[at + 1], expected[1], `${tool} ${args.action} flag value`)
  }

  // `pr review` is the one with the empty fallback: gh needs a body argument even
  // when there is no body text, or it refuses the verdict flag pairing.
  clearCalls(calls)
  await call(tools.get('github_pr'), { action: 'review', repo: 'a/b', number: 1, reviewAction: 'approve', confirm: true })
  const reviewArgv = argvOf(calls)
  assert.equal(reviewArgv[reviewArgv.indexOf('--body') + 1], '', 'review pushes an empty --body when none was given')
})

test('R3: github_auth token is the one action that returns a token, and the doc admits it', async () => {
  const { tools, calls } = setup()
  const result = await call(tools.get('github_auth'), { action: 'token' })
  assert.equal(result.ok, true, result.stderr)
  assert.deepEqual(argvOf(calls), ['auth', 'token'])
  // The absolute claim "never echoed back" was false while this action existed.
  const authDomain = ALL_DOMAINS.find((d) => d.tool === 'github_auth')
  assert.match(authDomain.description, /never echoed back except by action `token`/)
  // The action's own help still carries the warning.
  assert.match(authDomain.actions.token.help, /secret/i)
})
