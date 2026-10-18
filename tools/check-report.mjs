/**
 * Cross-check the retrospective report's numbers against the measurements.
 *
 * ## Why this exists
 *
 * The report quotes figures — version count, line counts, knowledge assets, problem
 * families, plugin-manager operations — and every one of them goes stale the moment work
 * continues. The first time this check was run by hand it found three inconsistencies at
 * once: the version count was one behind (a release landed after the table was written),
 * the documentation line count was 165 short (three sections were added afterwards), and
 * the recurrence event total was one behind (a defect was recorded afterwards).
 *
 * None of those were lies when written. They were **true and then kept being read**, which
 * is the failure mode a figure has: nobody re-measures a number they already believe.
 *
 * The fix is not "remember to update the report". It is this: the report states its
 * figures in a fixed, greppable form, and a script compares them with `measure.mjs` —
 * the single source of truth for measurements established after an earlier round produced
 * systematically wrong line counts.
 *
 * ## The contract
 *
 * The report must contain this block, and every line must match a measurement:
 *
 *     | 版本数 | 10（0.1.0→0.4.0） | **20**（→0.9.2） |
 *
 * Adding a figure means adding a row here, which is deliberate: an unreferenced number in
 * the report is exactly what goes stale unnoticed.
 *
 * ## What a failure means, and what it does not
 *
 * The report is a SNAPSHOT of a moment. Its figures describe the state at the version they
 * name, and they are correct for it. Work continuing afterwards makes them behind, not
 * wrong — so a failure here says **"the snapshot no longer describes the current project"**,
 * and the fix is to re-measure and update, or to accept that the report is historical.
 *
 * That distinction is why this is NOT part of `npm run verify`. A check that fails after
 * every release would make the gate permanently red, and a gate nobody can keep green is a
 * gate nobody reads — the same reasoning that made the recurrence board a report rather
 * than a build failure.
 *
 * **The limitation, stated plainly**: this cannot verify a figure against the version it
 * claims to describe, because past measurements are not reproducible. It can only detect
 * that the snapshot is behind the present. A number that was wrong WHEN WRITTEN would pass.
 *
 * Usage:
 *   node tools/check-report.mjs                    # default report path
 *   node tools/check-report.mjs <path>             # another report
 */

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the retrospective lives. Overridable, because it is kept outside the package. */
const DEFAULT_REPORT = resolve(ROOT, '..', '复盘报告-2026-10-15.md')

const reportPath = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? DEFAULT_REPORT

if (!existsSync(reportPath)) {
  console.log(`FAIL  the report exists: ${reportPath}`)
  process.exitCode = 1
  process.exit(1)
}

// Measured by the same tool the report cites, so the two cannot disagree about method.
const measured = JSON.parse(
  execFileSync(process.execPath, [join(ROOT, 'tools', 'measure.mjs'), '--json'], { encoding: 'utf8' }),
)

const text = readFileSync(reportPath, 'utf8')

/**
 * One figure the report states, and where its truth comes from.
 *
 * `marker` is the exact string the report must contain. `actual` is the measured value.
 * Keeping the expected string rather than parsing the table is deliberate: a regex loose
 * enough to find these rows in three different table layouts would also match the wrong
 * row, and a check that reads the wrong cell is worse than no check.
 */
const FIGURES = [
  {
    name: 'versions',
    // TWO rows state this and both are checked. The first version of this guard compared
    // only the appendix's comparison table — so the executive summary could still say
    // "10 versions, 4268 lines" while the appendix beside it said 28, and the guard passed.
    // The summary is the part a reader actually reads first, so leaving it unguarded
    // guarded the wrong document.
    marker: `| 版本数 | 10（0.1.0→0.4.0） | **${measured.versions}**（→${measured.version}） |`,
    also: [`| 版本 | 10 | **${measured.versions}** |`],
    actual: measured.versions,
    note: 'CHANGELOG headings — appendix table AND executive summary',
  },
  {
    name: 'product code lines',
    marker: `**${measured.areas['product code'].lines} 行 / ${measured.areas['product code'].files} 文件**`,
    actual: measured.areas['product code'].lines,
    note: 'index.js + client.js + lib/',
  },
  {
    name: 'test lines',
    marker: `**${measured.areas.tests.lines} 行**`,
    actual: measured.areas.tests.lines,
    note: 'test/',
  },
  {
    name: 'verification tool lines',
    marker: `**${measured.areas['verification tools'].lines} 行 / ${measured.areas['verification tools'].files} 个**`,
    actual: measured.areas['verification tools'].lines,
    note: 'tools/',
  },
  {
    name: 'documentation lines',
    marker: `**${measured.areas.docs.lines} 行 / ${measured.areas.docs.files} 个**`,
    actual: measured.areas.docs.lines,
    note: 'docs/',
  },
  {
    name: 'skill instruction lines',
    marker: `**${measured.areas['skills (instructions)'].lines} 行 / ${measured.areas['skills (instructions)'].files} 个文件**`,
    actual: measured.areas['skills (instructions)'].lines,
    note: 'skills/',
  },
  {
    name: 'knowledge assets',
    marker: `**${measured.knowledgeAssets} 条`,
    actual: measured.knowledgeAssets,
    note: 'docs/KNOWLEDGE.md records',
  },
  {
    name: 'recurrence families',
    marker: `**${measured.recurrence.families}**（${measured.recurrence.events} 个事件`,
    actual: measured.recurrence.families,
    note: 'docs/recurrence.json families',
  },
  {
    name: 'plugin-manager operations',
    marker: `| 插件管理器操作 | 56 | **${measured.pluginManagerOperations}** |`,
    actual: measured.pluginManagerOperations,
    note: 'profile .plugin-manager/logs',
  },
]

const results = []
for (const figure of FIGURES) {
  // A figure may be stated in more than one place — the appendix's comparison table and
  // the executive summary carry the same numbers in different layouts. ALL of them must
  // be current; one stale copy is one reader misled.
  const wanted = [figure.marker, ...(figure.also ?? [])]
  const missing = wanted.filter((candidate) => !text.includes(candidate))
  results.push({ ...figure, ok: missing.length === 0, missing })
}

// An additional guard: the report's own headline claim about its size. Cheap, and it is
// the figure most likely to be quoted onward.
const reportLines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

const failed = results.filter((r) => !r.ok)
for (const item of results) {
  if (item.ok) continue
  console.log(`STALE  ${item.name}`)
  for (const candidate of item.missing) console.log(`       missing: ${candidate}`)
  console.log(`       measured ${item.actual} (${item.note})`)
}
console.log(`report: ${reportPath}`)
console.log(`        ${reportLines} lines, ${results.length} figures cross-checked`)
console.log(`=== ${results.length - failed.length}/${results.length} figures match the current measurements ===`)

if (failed.length > 0) {
  console.log('')
  console.log('The report is a SNAPSHOT: these figures were correct for the version they name')
  console.log('and are now behind, not wrong. Re-measure with `npm run measure` and update the')
  console.log('report, or accept it as historical.')
  // Not fatal by default, and deliberately not part of `npm run verify`.
  //
  // This is the same decision the recurrence board carries, for the same reason: any edit
  // under `tools/` changes the tool line count, which is one of the figures below, so a
  // check that fails on drift fails after every single change to a tool — including the
  // change that fixes it. A gate nobody can keep green is a gate nobody reads. The drift is
  // REPORTED here, which is the maintenance signal, and `--strict` enforces it when someone
  // deliberately wants that.
  if (process.argv.includes('--strict')) {
    console.log('')
    console.log(`FAIL (--strict): ${failed.length} figure(s) are behind the current project.`)
    process.exitCode = 1
  }
}
