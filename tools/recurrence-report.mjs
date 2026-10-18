import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Today as a LOCAL date — `toISOString()` is UTC and is yesterday between 00:00 and 08:00 at UTC+8. */
function localDate(when = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/**
 * Recurrence board for problem families.
 *
 * Reads `docs/recurrence.json` and applies the rules from the retrospective: a
 * family whose members recur inside one quarter is a process failure that survived
 * its own fix, not bad luck. Counting is split by severity because the thresholds
 * differ — P0/P1 recurrence is never tolerated, P2/P3 allows one per quarter.
 *
 * The board is the point. A family that nobody counts is a family that quietly
 * comes back, which is how the same root cause produced six defects in one session
 * while every individual fix looked correct.
 *
 * Usage:
 *   node tools/recurrence-report.mjs                  # current quarter
 *   node tools/recurrence-report.mjs --quarter 2026-Q4
 *   node tools/recurrence-report.mjs --json           # machine-readable
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataPath = join(root, 'docs', 'recurrence.json')

/** The quarter a date falls in, as `YYYY-Qn`. */
function quarterOf(date) {
  const [year, month] = String(date).split('-').map(Number)
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`
}

/** Read one CLI flag's value. */
function flag(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : undefined
}

if (!existsSync(dataPath)) {
  console.log(`FAIL  ${dataPath} exists`)
  process.exitCode = 1
  process.exit(1)
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'))
const families = Array.isArray(data.families) ? data.families : []

// The default period is the quarter of the most recent event, not "today": this
// board describes a project's history, and a family whose last defect predates the
// current calendar quarter should read as clean rather than as missing.
const allDates = families.flatMap((f) => (f.events ?? []).map((e) => e.date)).sort()
const latest = allDates.at(-1) ?? new Date().toISOString().slice(0, 10)
const quarter = flag('--quarter') ?? quarterOf(latest)

/** Decide the alert level for one family. */
function alertFor(recurrencesInQuarter, severityInQuarter) {
  // Only recurrences alert. The FIRST occurrence of a problem is the defect; the
  // rule is about it happening AGAIN, so a family with one member and one event is
  // green however severe that event was. Counting first occurrences made every
  // family red, which is a board nobody reads.
  if (recurrencesInQuarter === 0) return { level: 'green', why: '' }
  if (severityInQuarter.some((s) => s === 'P0' || s === 'P1')) {
    return { level: 'red', why: 'a P0/P1 recurred' }
  }
  if (recurrencesInQuarter >= 3) return { level: 'red', why: `${recurrencesInQuarter} recurrences in one quarter (>= 3)` }
  if (recurrencesInQuarter === 2) return { level: 'amber', why: '2 recurrences in one quarter' }
  return { level: 'yellow', why: '1 recurrence in one quarter' }
}

const rows = []
for (const family of families) {
  const events = Array.isArray(family.events) ? family.events : []
  // Total = every occurrence ever recorded. Recurrence = everything after the
  // first, because the first is the original defect, not a repeat.
  const total = events.length
  const inQuarter = events.filter((e) => quarterOf(e.date) === quarter)
  const recurrences = Math.max(0, total - 1)
  // The same correction inside the period: the earliest event in the quarter is
  // that quarter's first occurrence, and only what follows it repeats.
  const recurrencesInQuarter = Math.max(0, inQuarter.length - 1)
  const rate = total === 0 ? 0 : (recurrences / total) * 100
  const severities = inQuarter.slice(1).map((e) => e.severity)
  const alert = alertFor(recurrencesInQuarter, severities)
  rows.push({
    id: family.id,
    title: family.title,
    total,
    inQuarter: inQuarter.length,
    recurrences,
    recurrencesInQuarter,
    rate,
    severities,
    alert: alert.level,
    why: alert.why,
    prevention: family.prevention ?? [],
    // Wins are counted alongside occurrences, not instead of them. A family whose measure
    // has never demonstrably caught anything is UNOBSERVED, and that is a weaker claim
    // than PROTECTED — until both numbers are shown, a green row implies the stronger one.
    wins: (Array.isArray(family.preventionWins) ? family.preventionWins : []).length,
  })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ quarter, rows }, null, 2))
} else {
  console.log(`recurrence board — quarter ${quarter}\n`)
  const head = ['问题族', '母因', '历史', '本季', '复发', '复发率', '预防成功', '预警']
  console.log(`${head[0].padEnd(11)}${head[1].padEnd(30)}${head[2].padStart(5)}${head[3].padStart(6)}${head[4].padStart(6)}${head[5].padStart(9)}${head[6].padStart(10)}  ${head[7]}`)
  console.log('-'.repeat(108))
  const mark = { green: '绿', yellow: '黄', amber: '橙', red: '红' }
  for (const row of rows) {
    const title = row.title.length > 28 ? `${row.title.slice(0, 27)}…` : row.title
    console.log(
      `${row.id.padEnd(11)}${title.padEnd(30)}${String(row.total).padStart(5)}`
      + `${String(row.inQuarter).padStart(6)}${String(row.recurrences).padStart(6)}`
      + `${`${row.rate.toFixed(0)}%`.padStart(9)}${String(row.wins).padStart(10)}  ${mark[row.alert]}`
      + (row.why === '' ? '' : `  (${row.why})`),
    )
  }
  // A green row with no wins says "nothing has happened", not "the measure works". Stated
  // as a line rather than left to the reader, because the difference is the whole reason
  // the column exists.
  const unobserved = rows.filter((r) => r.wins === 0)
  if (unobserved.length > 0) {
    console.log('')
    console.log(`${unobserved.length}/${rows.length} families have no recorded prevention success.`)
    console.log('Green there means UNOBSERVED since the measure landed, not PROVEN protected.')
    console.log('Record a win with: node tools/record-prevention.mjs <FAM-id> "<what it caught>"')
  }
  const red = rows.filter((r) => r.alert === 'red')
  const amber = rows.filter((r) => r.alert === 'amber')
  console.log(`\nP0/P1 target 0, P2/P3 target 0 with an accepted ceiling of 1 per quarter.`)
  if (red.length > 0) {
    console.log(`\nACTION REQUIRED (${red.length}): a root cause is repeating. Start a re-analysis and`)
    console.log(`submit a corrective report within one week.`)
    for (const row of red) console.log(`  - ${row.id} ${row.title}: ${row.why}`)
  } else if (amber.length > 0) {
    console.log(`\nWATCH (${amber.length}): reinforce the listed prevention measures.`)
    for (const row of amber) console.log(`  - ${row.id}: ${row.why}`)
  } else {
    console.log('\nNo family exceeds its threshold in this quarter.')
  }
  console.log('\nA family closes only after 3 consecutive quarters at zero, confirmed by')
  console.log('the owner, the verifier, and quality. Closed families stay in quarterly sampling.')

  // A red board is a FINDING, not a build failure. Making it fatal would fail
  // `npm run verify` on every run for as long as the project's history stays red,
  // and a gate that always fails is a gate nobody reads — the same "guard that
  // cries wolf" problem this file exists to catch. `--strict` exists for the
  // review meeting, where a red family must actually block the sign-off.
  if (process.argv.includes('--strict') && red.length > 0) {
    console.log(`\nFAIL (--strict): ${red.length} famil${red.length === 1 ? 'y is' : 'ies are'} red.`)
    process.exitCode = 1
  }
}

// This one IS fatal, in every mode: a family with several members and no prevention
// measure is the failure the whole mechanism exists to prevent — the same root
// cause, fixed per instance, with nothing stopping the next one. That is a defect
// in the process, not a status to report.
const unguarded = families.filter((f) => (f.events ?? []).length > 1 && (f.prevention ?? []).length === 0)
if (unguarded.length > 0) {
  console.log(`\nFAIL  ${unguarded.length} multi-member family/families carry no prevention measure: `
    + unguarded.map((f) => f.id).join(', '))
  process.exitCode = 1
}

// ---------------------------------------------------------------------------
// The baseline: what actually fails the gate.
//
// A red board is a standing state, not a regression — the families are historical and they
// close by changing how the work is done, not by one commit. Failing the gate on "the board
// is red" makes it red from the first day and forever, and a gate nobody can turn green is a
// gate nobody reads. That reasoning is why this file was informational in the first place.
//
// But "informational" was not right either. Today's evidence: the board was red across five
// families, and nobody looked at it until an independent audit had already finished. A
// measurement that is red and that nobody is forced to face does not exist.
//
// So the line is drawn at REGRESSION, not at history:
//
//   - the baseline records how many events each family had when a release was accepted
//   - **the gate fails when a count goes UP, or when a family appears that was not there**
//   - `--accept` writes a new baseline, and running it is the acknowledgement
//
// The friction is the point: recording a new defect event turns the gate red, and the only
// way to green is to run a command that says "I have seen this and I accept the new state".
// ---------------------------------------------------------------------------
const baselinePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'recurrence-baseline.json')

/** The current per-family event counts, which is what a baseline records. */
const counts = Object.fromEntries(families.map((f) => [f.id, (f.events ?? []).length]))

if (process.argv.includes('--accept')) {
  const next = {
    acceptedAt: localDate(),
    version: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version,
    note: 'Event counts at the moment this state was accepted. `npm run recurrence:check` fails when any count grows.',
    events: counts,
  }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`\naccepted: baseline written for ${families.length} famil(ies) at ${next.version}`)
  console.log('This command IS the acknowledgement — the gate goes green because someone ran it.')
} else if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const base = baseline.events ?? {}
  const grown = []
  for (const [id, count] of Object.entries(counts)) {
    const was = base[id]
    if (was === undefined) grown.push({ id, was: 'new family', now: count })
    else if (count > was) grown.push({ id, was, now: count })
  }
  const disappeared = Object.keys(base).filter((id) => counts[id] === undefined)
  if (grown.length > 0) {
    console.log(`\nFAIL  ${grown.length} famil(ies) gained events since the accepted baseline `
      + `(${baseline.version}, ${baseline.acceptedAt}):`)
    for (const item of grown) console.log(`  - ${item.id}: ${item.was} → ${item.now}`)
    console.log('')
    console.log('A new event is a regression, and this is the only check here that is one: the')
    console.log('rest describe a standing state. Record what changed, then accept the new')
    console.log('baseline with `npm run recurrence:accept` — running that IS the acknowledgement.')
    process.exitCode = 1
  } else if (disappeared.length > 0) {
    // Not a failure: a family can be renamed or removed. But it is worth saying, because a
    // baseline that no longer describes the data silently stops checking anything.
    console.log(`\nnote: ${disappeared.length} baseline famil(ies) no longer exist: ${disappeared.join(', ')}`)
  } else {
    console.log(`\nbaseline: no family has gained an event since ${baseline.version} (${baseline.acceptedAt}).`)
  }
} else {
  console.log(`\nno baseline yet at docs/recurrence-baseline.json.`)
  console.log('Without one this file cannot tell a standing state from a regression, so it')
  console.log('reports only. Create it with `npm run recurrence:accept` once the current')
  console.log('counts are the ones being accepted.')
}