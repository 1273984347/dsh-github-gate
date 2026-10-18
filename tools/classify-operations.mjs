/**
 * Classify the plugin-manager operations — H-02 and H-03, both previously 【待验证】.
 *
 * ## The two questions this answers
 *
 * **H-02**: of the 100 recorded operations, how many were rework rather than iteration?
 * The report estimated "about 20 of 56" and could not close it, because closing it means
 * classifying every log and the classification rule was never written down.
 *
 * **H-03**: how long does an install-and-restart cycle take? The report guessed 4–8 minutes
 * and marked it 【待验证】 because only the user could time it. That is true of the RESTART,
 * which this cannot see. What it CAN see is everything the Host itself did — the pair of
 * operations a swap takes and the wall time between them — which bounds the part that is
 * not the restart.
 *
 * ## How an operation is classified, and why this way
 *
 * Each log directory holds the `pnpm` output for one operation. Two facts are read from it:
 *
 * - **Which side of the swap it is** — `+ <name>` in a dependency block means the package
 *   was added (an install or a re-enable); `- <name>` means removed.
 * - **Which package** — the manifest name, so an unrelated bundle's operation is not
 *   counted against this one.
 *
 * The classification of "rework" is the part that needs a stated rule, because a rule that
 * is not stated is a conclusion wearing a number's clothes. The rule below is deliberately
 * conservative: it counts as rework only operations that CANNOT be iteration, never ones
 * that merely look like it.
 *
 * | Class | Rule | Why it is rework |
 * |---|---|---|
 * | `installation` | the first install of a version | neither — this is the work |
 * | `upgrade` | the first install of each later version | neither — this is the work |
 * | `remove` | a remove with no matching re-install of the SAME version after it | neither — uninstalling |
 * | **`retry`** | a remove+install pair for a version that is ALREADY installed | rework: the version did not change |
 * | **`swap-pair`** | a remove followed by an install of a DIFFERENT version within 5 minutes | **this is the work**, but it is the cost being measured |

 * It does NOT classify "a release I did not need" as rework. Judging that needs intent,
 * and intent is not in the log.
 *
 * Usage:
 *   node tools/classify-operations.mjs
 *   node tools/classify-operations.mjs --json
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PACKAGE = manifest.name

/** `DSH_PROFILE_DIR` when the Host set it, else the conventional path. */
function profileRoot() {
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
    return process.env.DSH_PROFILE_DIR
  }
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

const logsDir = join(profileRoot(), '.plugin-manager', 'logs')
if (!existsSync(logsDir)) {
  console.log(`no plugin-manager logs at ${logsDir}`)
  console.log('This is a machine-state question, not a source-tree one — answer "unknown"')
  console.log('rather than guessing, which is what the report did before this existed.')
  process.exitCode = 0
  process.exit(0)
}

/**
 * What one operation did, read from its pnpm output.
 *
 * @param {string} dir the operation directory
 * @returns {{ id: string, at: number, action: 'install' | 'remove' | 'other', version: string }}
 */
function readOperation(dir) {
  const id = dir.split(/[/\\]/).pop() ?? dir
  let at = 0
  try {
    at = statSync(dir).birthtimeMs || statSync(dir).mtimeMs
  } catch {
    at = 0
  }

  let text = ''
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    try {
      text += readFileSync(join(dir, file), 'utf8')
    } catch {
      // A binary or unreadable log contributes nothing; the others still tell the story.
    }
  }

  // `+ name file:...tgz` / `- name file:...tgz` inside a dependency block.
  const added = new RegExp(`^\\+\\s+${PACKAGE}\\s+(.*)$`, 'm').exec(text)
  const removed = new RegExp(`^-\\s+${PACKAGE}\\s+(.*)$`, 'm').exec(text)
  const action = added ? 'install' : removed ? 'remove' : 'other'
  const spec = added?.[1] ?? removed?.[1] ?? ''
  const version = /(\d+\.\d+\.\d+)\.tgz/.exec(spec)?.[1] ?? ''

  return { id, at, action, version }
}

const operations = readdirSync(logsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readOperation(join(logsDir, entry.name)))
  .sort((a, b) => a.at - b.at)

const ours = operations.filter((op) => op.action !== 'other')
const others = operations.length - ours.length

// Walk ours in time order, keeping what has been installed so a re-install of the same
// version is visible as a repeat rather than mistaken for an upgrade.
const installedVersions = new Set()
let current = ''
let previous = undefined
const classified = []
for (const op of ours) {
  if (op.action === 'remove') {
    current = ''
    classified.push({ ...op, kind: 'remove' })
  } else {
    const known = installedVersions.has(op.version)
    installedVersions.add(op.version)
    // A re-install of a version already seen is the one thing iteration cannot produce.
    classified.push({ ...op, kind: known ? 'retry' : installedVersions.size === 1 ? 'installation' : 'upgrade' })
    current = op.version
  }
  previous = op
}

// Swap pairs: a remove and the NEXT install, when the version changed.
const swaps = []
for (let index = 0; index < classified.length - 1; index += 1) {
  const a = classified[index]
  const b = classified[index + 1]
  if (a.action !== 'remove' || b.action !== 'install') continue
  const seconds = (b.at - a.at) / 1000
  // Five minutes: a swap that took longer than that was almost certainly a restart in
  // between, which is the cost H-03 could not measure from here.
  if (seconds < 0 || seconds > 300) continue
  swaps.push({ from: a.version, to: b.version, seconds, at: a.at })
}

const byKind = {}
for (const op of classified) byKind[op.kind] = (byKind[op.kind] ?? 0) + 1

const rework = byKind.retry ?? 0
const versions = [...installedVersions].length
const swapTimes = swaps.map((s) => s.seconds).sort((a, b) => a - b)
const median = swapTimes.length === 0 ? null : swapTimes[Math.floor(swapTimes.length / 2)]

const report = {
  total: operations.length,
  ours: ours.length,
  otherBundles: others,
  versions,
  byKind,
  rework,
  operationsPerVersion: versions === 0 ? null : Number((ours.length / versions).toFixed(2)),
  swaps: {
    count: swaps.length,
    fastestSeconds: swapTimes[0] === undefined ? null : Number(swapTimes[0].toFixed(2)),
    medianSeconds: median === null ? null : Number(median.toFixed(2)),
    slowestSeconds: swapTimes.at(-1) === undefined ? null : Number(swapTimes.at(-1).toFixed(2)),
  },
  limitation: 'reads the Host\'s own operation logs; it cannot see the application restart, '
    + 'so H-03 is bounded here, not answered. Rework is counted only where iteration is '
    + 'impossible (re-installing a version already installed) — judging releases nobody '
    + 'needed requires intent, which is not in the log.',
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`plugin-manager operations for ${PACKAGE}`)
  console.log(`  log directories      ${operations.length}`)
  console.log(`  this package         ${ours.length}`)
  console.log(`  other bundles        ${others}  (not counted)`)
  console.log(`  distinct versions    ${versions}`)
  console.log('')
  console.log('classification')
  for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    const meaning = {
      installation: 'the first install — the work',
      upgrade: 'a later version install — the work',
      remove: 'an uninstall',
      retry: 'REWORK: a version that was already installed',
    }[kind] ?? ''
    console.log(`  ${kind.padEnd(14)}${String(count).padStart(4)}   ${meaning}`)
  }
  console.log('')
  console.log(`operations per version   ${report.operationsPerVersion}`)
  // `swaps` is the ARRAY; `report.swaps` is the summary object. The first version asked
  // the array for `.count`, which is undefined, so `undefined > 0` was false and this
  // section never printed — the pairs were found and then not shown.
  if (swaps.length > 0) {
    console.log('')
    console.log(`swaps measured           ${swaps.length}`)
    console.log(`  fastest / median / slowest   ${swapTimes[0].toFixed(1)}s / ${median.toFixed(1)}s / ${swapTimes.at(-1).toFixed(1)}s`)
    console.log('  ^ this is the Host\'s own work only. The application restart is NOT in')
    console.log('    these logs, so H-03 stays 【待验证】 — but it is now bounded on one side.')
  }
  console.log('')
  console.log(`note: ${report.limitation}`)
}