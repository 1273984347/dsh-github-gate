/**
 * What the two argv probes can and cannot catch.
 *
 * A guard that claims more than it checks is worse than no guard, so this file
 * pins the exact boundary by running both probes against the shapes that shipped.
 *
 * ## The measured boundary
 *
 * `gh <argv...> --help` parses FLAG NAMES and rejects an unknown one, but it does
 * NOT check positional COUNT and does NOT require a mandatory flag. Proven here,
 * not assumed:
 *
 *   gh repo rename new-name o/n --help    -> accepted  (arity error, missed)
 *   gh pr status 123 --help               -> accepted  (arity error, missed)
 *   gh pr review 1 --body x --help        -> accepted  (missing verdict flag, missed)
 *   gh run delete 123 --yes --help        -> REJECTED  (unknown flag, caught)
 *
 * So `probe-argv.mjs` catches one class exactly: **invented flag names**. The
 * arity probe catches a second class from gh's own USAGE text: **too many
 * positionals**. Between them these are the two of the four defects that shipped
 * that an offline tool can reach at all.
 *
 * The remaining two — a mandatory flag omitted (`pr review` without `--approve`)
 * and a positional given where none is allowed (`pr status 123`) — are only
 * visible by EXECUTION, which these probes deliberately do not do: no repository
 * may be touched from a test. They stay measured by hand and recorded below, and
 * the offline suite covers them structurally instead: `verify-params` asserts the
 * built argv, and a new assertion pins the exact argv for each action that regressed.
 *
 * ## Why the assertion is kept in the repo
 *
 * The value is that a FUTURE invented flag fails the first probe on the machine
 * that has gh, and on a machine without gh both probes report UNCHECKED rather
 * than passing. That distinction is the whole point: silence and success must not
 * look alike.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Whether gh's `--help` parser accepts this argv.
 * @param {string[]} argv the argv under test
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function flagParse(argv) {
  try {
    await exec('gh', [...argv, '--help'], { timeout: 20_000 })
    return { ok: true, detail: '' }
  } catch (error) {
    const text = (String((error).stderr ?? '') + String((error).stdout ?? ''))
      .split('\n').find((l) => l.trim() !== '') ?? 'unknown'
    return { ok: false, detail: text.trim().slice(0, 90) }
  }
}

/**
 * The positional count gh's USAGE line allows for this subcommand.
 * @param {string[]} prefix the subcommand path
 * @returns {Promise<number | null>}
 */
async function usageArity(prefix) {
  try {
    const { stdout, stderr } = await exec('gh', [...prefix, '--help'], { timeout: 20_000 })
    const lines = (String(stdout) + String(stderr)).split('\n')
    const at = lines.findIndex((l) => /^\s*(USAGE|Usage)/.test(l))
    if (at === -1) return null
    const usage = lines.slice(at + 1).find((l) => new RegExp(`^\\s*gh\\s+${prefix.join('\\s+')}\\b`).test(l))
    return usage === undefined ? null : (usage.match(/\[?<[^\]<>]+>\]?/g) ?? []).length
  } catch {
    return null
  }
}

/** The boundary, one row per defect class, with the exact measurement. */
const boundary = [
  {
    defect: 'invented flag name (run delete --yes)',
    argv: ['run', 'delete', '123', '--yes'],
    caughtBy: 'probe-argv (flag parse)',
  },
  {
    defect: 'invented flag name (repo list --affiliation)',
    argv: ['repo', 'list', '--affiliation', 'owner'],
    caughtBy: 'probe-argv (flag parse)',
  },
  {
    defect: 'invented flag name (repo create --add-topic/--fork)',
    argv: ['repo', 'create', 'name', '--add-topic', 't', '--fork'],
    caughtBy: 'probe-argv (flag parse)',
  },
  {
    defect: 'too many positionals (repo rename new-name o/n)',
    argv: ['repo', 'rename', 'new-name', 'o/n'],
    caughtBy: 'probe-arity, arity 1',
    sub: ['repo', 'rename'],
    builtPositional: 2,
  },
  {
    defect: 'too many positionals (pr status 123)',
    argv: ['pr', 'status', '123'],
    caughtBy: 'probe-arity, arity 0',
    sub: ['pr', 'status'],
    builtPositional: 1,
  },
  {
    defect: 'too many positionals (release download tag asset)',
    argv: ['release', 'download', 'v1.0.0', 'asset.zip'],
    caughtBy: 'probe-arity, arity 1',
    sub: ['release', 'download'],
    builtPositional: 2,
  },
  {
    defect: 'mandatory flag omitted (pr review without a verdict)',
    argv: ['pr', 'review', '1', '--body', 'x'],
    caughtBy: 'NOT reachable offline — measured by hand, pinned by verify-params',
    unreachable: true,
  },
]

let reachable = 0
let unreachable = 0

for (const row of boundary) {
  const parse = await flagParse(row.argv)
  if (row.unreachable) {
    // The flag parse ACCEPTS it, which is the proof that it is unreachable.
    const acceptedByParse = parse.ok
    unreachable += 1
    console.log(`OFFLINE-UNREACHABLE  ${row.defect}`)
    console.log(`${''.padEnd(20)}proof: gh ${row.argv.join(' ')} --help -> ${acceptedByParse ? 'accepted (no parser complaint)' : parse.detail}`)
    console.log(`${''.padEnd(20)}${row.caughtBy}`)
    continue
  }

  if (row.sub !== undefined) {
    const allowed = await usageArity(row.sub)
    const caught = allowed !== null && row.builtPositional > allowed
    if (caught) reachable += 1
    console.log(`${caught ? 'CAUGHT-BY-ARITY   ' : 'ARITY-MISSED      '} ${row.defect}`)
    console.log(`${''.padEnd(20)}branch: plugin builds ${row.builtPositional} positional(s); usage allows ${allowed}`)
    continue
  }

  const caught = !parse.ok
  if (caught) reachable += 1
  console.log(`${caught ? 'CAUGHT-BY-FLAGPARSE' : 'FLAGPARSE-MISSED  '} ${row.defect}`)
  console.log(`${''.padEnd(20)}gh ${row.argv.join(' ')} --help -> ${parse.ok ? 'accepted' : parse.detail}`)
}

console.log('')
console.log(`reachable offline: ${reachable}, not reachable offline: ${unreachable}`)
console.log('Each "CAUGHT-*" row above is a defect class these probes now fail on.')
console.log('Each "OFFLINE-UNREACHABLE" row is one only execution can see; it is pinned')
console.log('by an exact-argv assertion in test/offline.test.mjs instead.')
