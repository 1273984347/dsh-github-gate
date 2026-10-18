/**
 * Positional-arity gate: `gh <sub> --help` prints a USAGE line, and that line
 * states the maximum number of positional arguments the subcommand accepts.
 *
 * `--help` parsing alone cannot catch a positional COUNT error: `gh repo rename
 * new-name o/n --help` still prints help, because the arity check happens during
 * execution, not parsing. That is exactly how `["repo","rename",newName,repo]`
 * shipped — a second positional gh rejects with "accepts at most 1 arg(s)".
 *
 * This file reads the USAGE line instead, so the count is checked from the same
 * source gh itself uses. It is a parse of documentation, not of behaviour, so it
 * cannot prove an arity is CORRECT — only that the usage text mentions the shape
 * the plugin builds. Where the text is ambiguous the entry is skipped and named.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * The positional count of the USAGE line for one subcommand.
 *
 * A subcommand that takes no positional prints `gh pr list [flags]`, which names
 * none — so a missing `<name>` means ZERO, not unreadable. Only a subcommand with
 * no usage line at all returns null.
 *
 * @param {string[]} prefix the subcommand path, e.g. ['repo', 'rename']
 * @returns {Promise<string | null>} the usage text, or null when unreadable
 */
async function usageOf(prefix) {
  try {
    const { stdout, stderr } = await exec('gh', [...prefix, '--help'], { timeout: 20_000 })
    const text = String(stdout) + String(stderr)
    // The USAGE line is the one that starts the subcommand path. Requiring
    // `[flags]` in it missed `gh repo clone <repository> [<directory>]`, whose
    // usage names no flags; that shape is caught by a line that CONTAINS the
    // subcommand path rather than by one that also lists flags.
    const at = text.split('\n').findIndex((l) => /^\s*(USAGE|Usage)/.test(l))
    if (at === -1) return null
    const line = text.split('\n').slice(at + 1).find((l) => new RegExp(`^\\s*gh\\s+${prefix.join('\\s+')}\\b`).test(l))
    return line === undefined ? null : line.trim()
  } catch {
    return null
  }
}

/**
 * Declared shapes: the subcommand and how many POSITIONAL arguments the plugin
 * can end up passing it, after the registry appends `--repo`.
 *
 * @type {{ sub: string[], maxPositional: number, note: string }[]}
 */
const shapes = [
  { sub: ['repo', 'view'], maxPositional: 1, note: '<repository>' },
  { sub: ['repo', 'list'], maxPositional: 1, note: '[<owner>]' },
  { sub: ['repo', 'clone'], maxPositional: 2, note: '[<repository>] [<dir>]' },
  { sub: ['repo', 'create'], maxPositional: 1, note: '[<name>]' },
  { sub: ['repo', 'fork'], maxPositional: 1, note: '[<repository>]' },
  { sub: ['repo', 'edit'], maxPositional: 0, note: 'no positional; --repo selects it' },
  { sub: ['repo', 'rename'], maxPositional: 1, note: '[<new-name>] ONLY — the target goes in --repo' },
  { sub: ['repo', 'archive'], maxPositional: 1, note: '[<repository>] positional, and NO --repo flag' },
  { sub: ['repo', 'delete'], maxPositional: 1, note: '[<repository>] positional, and NO --repo flag' },
  { sub: ['pr', 'view'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'list'], maxPositional: 0, note: 'no positional' },
  { sub: ['pr', 'diff'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'checks'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'status'], maxPositional: 0, note: 'NO positional — this is the one that regressed' },
  { sub: ['pr', 'create'], maxPositional: 0, note: 'no positional' },
  { sub: ['pr', 'comment'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'review'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'ready'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'checkout'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'merge'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'close'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'reopen'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['pr', 'edit'], maxPositional: 1, note: '[<number> | <url> | <branch>]' },
  { sub: ['issue', 'list'], maxPositional: 0, note: 'no positional' },
  { sub: ['issue', 'view'], maxPositional: 1, note: '[<number> | <url>]' },
  { sub: ['issue', 'create'], maxPositional: 0, note: 'no positional' },
  { sub: ['issue', 'comment'], maxPositional: 1, note: '[<number> | <url>]' },
  { sub: ['issue', 'close'], maxPositional: 1, note: '[<number> | <url>]' },
  { sub: ['issue', 'reopen'], maxPositional: 1, note: '[<number> | <url>]' },
  { sub: ['issue', 'edit'], maxPositional: 1, note: '[<number> | <url>]' },
  { sub: ['issue', 'develop'], maxPositional: 1, note: '[<number> | <url>]' },
  { sub: ['release', 'list'], maxPositional: 0, note: 'no positional' },
  { sub: ['release', 'view'], maxPositional: 1, note: '[<tag>]' },
  { sub: ['release', 'create'], maxPositional: 1, note: '[<tag>]' },
  { sub: ['release', 'edit'], maxPositional: 1, note: '[<tag>]' },
  { sub: ['release', 'upload'], maxPositional: 2, note: '<tag> <file>...' },
  { sub: ['release', 'download'], maxPositional: 1, note: '[<tag>] ONLY — asset goes through --pattern' },
  { sub: ['release', 'delete'], maxPositional: 1, note: '[<tag>]' },
  { sub: ['run', 'list'], maxPositional: 0, note: 'no positional' },
  { sub: ['run', 'view'], maxPositional: 1, note: '[<run-id>]' },
  { sub: ['run', 'watch'], maxPositional: 1, note: '[<run-id>]' },
  { sub: ['run', 'rerun'], maxPositional: 1, note: '[<run-id>]' },
  { sub: ['run', 'cancel'], maxPositional: 1, note: '[<run-id>]' },
  { sub: ['run', 'delete'], maxPositional: 1, note: '[<run-id>]' },
  { sub: ['workflow', 'list'], maxPositional: 0, note: 'no positional' },
  { sub: ['workflow', 'view'], maxPositional: 1, note: '[<workflow-id> | <workflow-name> | <filename>]' },
  { sub: ['workflow', 'run'], maxPositional: 1, note: '[<workflow-id> | <workflow-name> | <filename>]' },
  { sub: ['search', 'repos'], maxPositional: 0, note: 'the query is a slice, not one positional' },
  { sub: ['search', 'issues'], maxPositional: 0, note: 'the query is a slice, not one positional' },
  { sub: ['api'], maxPositional: 1, note: '<endpoint>' },
]

/**
 * Count the optional and required positionals in a usage fragment.
 * @param {string} usage the USAGE line
 * @returns {number} the highest positional index it names
 */
function maxPositionalIn(usage) {
  // Positionals look like `<name>` or `[<name>]`; flags look like `[flags]`,
  // `--flag` or `-f file`, none of which are angle-bracketed at that position.
  const matches = usage.match(/\[?<[^\]<>]+>\]?/g) ?? []
  return matches.length
}

let passed = 0
let failed = 0
const failures = []

for (const shape of shapes) {
  const usage = await usageOf(shape.sub)
  if (usage === null) {
    failed += 1
    failures.push(`gh ${shape.sub.join(' ')}: no usage line could be read, so its arity is UNCHECKED`)
    continue
  }
  const allowed = maxPositionalIn(usage)
  if (allowed >= shape.maxPositional) {
    passed += 1
  } else {
    failed += 1
    failures.push(`gh ${shape.sub.join(' ')}: plugin passes ${shape.maxPositional} positional(s), usage allows ${allowed}\n       usage: ${usage}\n       note: ${shape.note}`)
  }
}

console.log(`=== ${passed}/${shapes.length} positional arities within what gh's usage allows ===`)
for (const line of failures) console.log('FAIL  ' + line)
if (failed > 0) {
  console.log(`\n=== ${failed} arity problem(s) ===`)
  process.exitCode = 1
}
