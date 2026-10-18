/**
 * Project measurements, computed once and correctly.
 *
 * ## Why this exists
 *
 * Every line count reported from this project before this file existed was produced by an
 * ad-hoc PowerShell pipeline, and most of them were WRONG in the same direction:
 *
 *     Get-Content $f | Measure-Object -Line
 *
 * `Measure-Object -Line` counts newlines *inside* each piped string, so a blank line
 * contributes nothing. The same file measured 852 lines that way and 1073 lines by
 * `(Get-Content $f).Count`. Both numbers were reported to a reader at different times,
 * and both looked authoritative.
 *
 * That was not the only one. In the same session:
 *
 * - `$LASTEXITCODE` read AFTER a pipeline into `Select-Object` is the pipeline's status,
 *   not the command's, so a working `npm view` was reported as "package not found" for
 *   every package tried.
 * - `Select-String -SimpleMatch 'Fixed|fixed'` searched for the literal text
 *   `Fixed|fixed`, found nothing, and reported zero.
 * - `-AllMatches | .Matches.Count | Measure-Object -Sum` returned 0 on real matches.
 *
 * None of those threw. They produced confident wrong numbers, which is worse than an
 * error — an error stops you, a wrong number gets reported.
 *
 * ## The rule this file implements
 *
 * Shell is for launching one command. Anything that PRODUCES A NUMBER someone will read
 * belongs in a script that can be run twice and compared. This is that script for the
 * numbers this project quotes.
 *
 * Usage:
 *   node tools/measure.mjs            # human-readable table
 *   node tools/measure.mjs --json     # machine-readable
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Count the lines of a text file the way a reader counts them.
 *
 * `split('\n').length` is the honest answer: a file ending in a newline has one more
 * element than it has line breaks, and a blank line is still a line. Both numbers are
 * reported so a reader can see which convention a figure came from.
 *
 * @param {string} path the file
 * @returns {{ total: number, nonBlank: number }} the counts
 */
function countLines(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  // A trailing newline produces a final empty element that is not a line.
  const total = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  const nonBlank = lines.filter((line) => line.trim() !== '').length
  return { total, nonBlank }
}

/**
 * Every file under a directory, recursively, excluding vendor and VCS trees.
 *
 * @param {string} dir the directory
 * @param {{ extensions?: string[], skip?: string[] }} [options] filters
 * @returns {string[]} absolute paths
 */
function walk(dir, options = {}) {
  const { extensions, skip = ['node_modules', '.git', '.vendor', 'dist', 'build'] } = options
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    if (skip.includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(full, options))
    else if (extensions === undefined || extensions.includes(extname(entry.name))) found.push(full)
  }
  return found
}

/**
 * Total lines and files for a set of paths.
 *
 * @param {string[]} paths files or directories
 * @param {{ extensions?: string[] }} [options] filters
 * @returns {{ files: number, lines: number, nonBlank: number }} the totals
 */
function measure(paths, options = {}) {
  const files = []
  for (const target of paths) {
    const full = join(ROOT, target)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) files.push(...walk(full, options))
    else files.push(full)
  }
  let lines = 0
  let nonBlank = 0
  for (const file of files) {
    const counted = countLines(file)
    lines += counted.total
    nonBlank += counted.nonBlank
  }
  return { files: files.length, lines, nonBlank }
}

/** The package manifest. */
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The areas this project reports on. Each is measured with the same rule. */
const AREAS = {
  'product code': measure(['index.js', 'client.js', 'lib'], { extensions: ['.js', '.mjs'] }),
  'skills (instructions)': measure(['skills'], { extensions: ['.md'] }),
  'tests': measure(['test'], { extensions: ['.mjs'] }),
  'verification tools': measure(['tools'], { extensions: ['.mjs'] }),
  'docs': measure(['docs'], { extensions: ['.md', '.json'] }),
}

/** The prompt section's size, which has a budget and is therefore worth watching. */
const guidance = await import(new URL('../lib/guidance.js', import.meta.url).href)

/** How many plugin-manager operations this profile has recorded. */
function operationCount() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  const profile = process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', 'desktop')
  const logs = join(profile, '.plugin-manager', 'logs')
  if (!existsSync(logs)) return null
  return readdirSync(logs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
}

/** How many error families the recurrence board tracks. */
function familyCount() {
  const path = join(ROOT, 'docs', 'recurrence.json')
  if (!existsSync(path)) return null
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const families = Array.isArray(data.families) ? data.families : []
  return {
    families: families.length,
    events: families.reduce((sum, family) => sum + (family.events?.length ?? 0), 0),
    withPrevention: families.filter((family) => (family.prevention ?? []).length > 0).length,
  }
}

/**
 * How many knowledge assets the library holds.
 *
 * Returns null when the file is absent, and the CALLER treats that as a failure — a
 * measurement tool whose inputs can vanish and still print a table is reporting a table
 * about a project it did not read. Independent audit: this file had no failure channel at
 * all (no exitCode, no throw, no console.error), so a missing input looked like a null in
 * a column.
 */
function knowledgeCount() {
  const path = join(ROOT, 'docs', 'KNOWLEDGE.md')
  if (!existsSync(path)) return null
  return (readFileSync(path, 'utf8').match(/^## K-\d{2} /gm) ?? []).length
}

/** How many versions the changelog records. */
function versionCount() {
  const path = join(ROOT, 'CHANGELOG.md')
  if (!existsSync(path)) return null
  return (readFileSync(path, 'utf8').match(/^## \d+\.\d+\.\d+/gm) ?? []).length
}

const report = {
  version: manifest.version,
  measuredWith: 'tools/measure.mjs (split on newline; blank lines COUNT)',
  areas: AREAS,
  totals: {
    files: Object.values(AREAS).reduce((sum, area) => sum + area.files, 0),
    lines: Object.values(AREAS).reduce((sum, area) => sum + area.lines, 0),
  },
  promptSection: {
    name: guidance.PROMPT_SECTION_NAME,
    order: guidance.PROMPT_SECTION_ORDER,
    chars: guidance.PROMPT_SECTION_TEXT.length,
  },
  knowledgeAssets: knowledgeCount(),
  versions: versionCount(),
  recurrence: familyCount(),
  pluginManagerOperations: operationCount(),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`dsh-github-gate ${report.version}`)
  console.log(`${report.measuredWith}\n`)
  console.log('area                     files     lines   non-blank')
  console.log('-'.repeat(58))
  for (const [name, area] of Object.entries(AREAS)) {
    console.log(`${name.padEnd(24)}${String(area.files).padStart(5)}${String(area.lines).padStart(10)}${String(area.nonBlank).padStart(12)}`)
  }
  console.log('-'.repeat(58))
  console.log(`${'total'.padEnd(24)}${String(report.totals.files).padStart(5)}${String(report.totals.lines).padStart(10)}`)
  console.log('')
  console.log(`prompt section           ${report.promptSection.name} @ ${report.promptSection.order}, ${report.promptSection.chars} chars`)
  console.log(`knowledge assets         ${report.knowledgeAssets}`)
  console.log(`changelog versions       ${report.versions}`)
  if (report.recurrence !== null) {
    console.log(`problem families         ${report.recurrence.families} (${report.recurrence.events} events, ${report.recurrence.withPrevention} with prevention)`)
  }
  console.log(`plugin-manager ops       ${report.pluginManagerOperations ?? 'unknown'}`)
  console.log('')
  // The two conventions never agree, so the difference is stated rather than hidden: a
  // reader who compares this with an older figure needs to know why it moved.
  console.log('note: `lines` counts every line including blanks; `non-blank` is what')
  console.log('      Measure-Object -Line reports. They differ by design, not by drift.')
}

// ---------------------------------------------------------------------------
// The failure channel.
//
// An independent audit found this file had none: no `process.exitCode`, no `throw`, no
// `console.error` — and it is the source of truth `check-report.mjs` trusts. A measurement
// tool whose inputs can disappear and still print a table is reporting a table about a
// project it did not read.
//
// What counts as a failure, and what does not:
//
//   - the areas are walked from this repository, so an area with ZERO files means the walk
//     found nothing — not that the area is empty. That is a failure.
//   - `knowledgeAssets` and `versions` return null when the document is missing. Null in a
//     column reads as a number that happens to be absent; it is a failure.
//   - `pluginManagerOperations` is machine state and may legitimately be unknown on a
//     machine with no profile. Reported, NOT a failure — the distinction is the point.
// ---------------------------------------------------------------------------
const missing = []
for (const [name, area] of Object.entries(AREAS)) {
  if (area.files === 0) missing.push(`${name}: no files found (the walk read nothing)`)
}
if (report.knowledgeAssets === null) missing.push('docs/KNOWLEDGE.md is missing, so the asset count is unknown')
if (report.versions === null) missing.push('CHANGELOG.md is missing, so the version count is unknown')

if (missing.length > 0) {
  console.error(`\nFAIL  ${missing.length} input(s) could not be measured:`)
  for (const item of missing) console.error(`  - ${item}`)
  console.error('\nA measurement with missing inputs is not a smaller measurement — it is a')
  console.error('different one, and the numbers it prints describe a project that was not read.')
  process.exitCode = 1
}
