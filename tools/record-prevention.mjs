/**
 * Record a prevention SUCCESS, not just a failure.
 *
 * ## Why the board was blind in one direction
 *
 * The recurrence board counted defects. That answers "is this root cause still happening",
 * and it cannot answer "does the measure that supposedly stops it actually stop anything".
 * A family with a prevention measure and no new events read exactly like a family whose
 * measure was never tested — the same green, the same confidence, two very different
 * claims.
 *
 * A neighbouring project's methodology index solves this by counting both: its headline
 * figure is `23/23 (including W085/W086 prevention succeeded, 0 files)`. The numerator
 * counts occurrences AND wins. That is the signal missing here, and this script exists to
 * record the wins as first-class evidence.
 *
 * ## What counts as a win
 *
 * A win is a moment where the defect would have occurred and a named measure stopped it —
 * the evidence has to be concrete, because "nothing went wrong" is the default state and
 * is not evidence of anything:
 *
 *   - a guard FAILED on a real violation and was fixed before shipping; the failure is the
 *     proof the guard works, and the fact that it was caught in CI rather than in the
 *     installed plugin is the win
 *   - a rule was followed at a point where skipping it was the natural thing to do, and the
 *     record says which moment
 *
 * "We added a guard" is not a win. "The guard rejected this specific input" is.
 *
 * Usage:
 *   node tools/record-prevention.mjs --list
 *   node tools/record-prevention.mjs <FAM-id> "<what the measure caught>" [--date YYYY-MM-DD]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'docs', 'recurrence.json')

const args = process.argv.slice(2)
const data = JSON.parse(readFileSync(DATA, 'utf8'))
const families = Array.isArray(data.families) ? data.families : []

if (args.includes('--list') || args.length === 0) {
  console.log('prevention record\n')
  console.log('family      events  wins  measures')
  console.log('-'.repeat(72))
  for (const family of families) {
    const wins = Array.isArray(family.preventionWins) ? family.preventionWins : []
    console.log(
      `${family.id.padEnd(12)}${String((family.events ?? []).length).padStart(6)}`
      + `${String(wins.length).padStart(6)}  ${(family.prevention ?? []).join(', ')}`,
    )
    for (const win of wins) console.log(`              ${win.date}  ${win.note}`)
  }
  const withWins = families.filter((f) => (f.preventionWins ?? []).length > 0).length
  console.log('')
  console.log(`${withWins}/${families.length} families have a recorded win.`)
  if (withWins < families.length) {
    console.log('')
    console.log('A family with a measure and no win is not proven to be protected — it is')
    console.log('simply unobserved since the measure landed. Say which, do not imply protection.')
  }
  process.exit(0)
}

/**
 * Today, as a LOCAL `YYYY-MM-DD`.
 *
 * NOT `new Date().toISOString().slice(0, 10)`, which is UTC. On a machine at UTC+8 the UTC
 * date is still yesterday between 00:00 and 08:00 local — so a win recorded at 02:10 local
 * was rejected as "in the future" by the first version of this check. The validator written
 * to catch bad input caught its own timezone bug instead, which is the better outcome but
 * still a bug: dates here are local, because the person typing them is local.
 *
 * @param {Date} [when] the instant
 * @returns {string} the local date
 */
function localDate(when = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}
const [familyId, note] = args.filter((arg) => !arg.startsWith('--'))
const at = args.indexOf('--date')

/**
 * Notes that describe the MEASURE rather than an OBSERVATION.
 *
 * This file's own header says "'We added a guard' is not a win", and the first version
 * accepted exactly that string — an executable documenting a standard it does not enforce.
 * These are the phrasings that name the guard instead of what it caught.
 */
const MEASURE_NOT_OBSERVATION = [
  /^(we |i )?(added|wrote|created|built|introduced) (a |the )?(guard|check|test|rule|measure)/i,
  /^(nothing|no incidents?|no problems?|all (good|green|clean))/i,
  /^(it )?(works|working) (fine|well|as expected)/i,
]

const dateGiven = at !== -1
const dateValue = dateGiven ? args[at + 1] : undefined
const dateMissing = dateGiven && (dateValue === undefined || dateValue.startsWith('--'))
const date = !dateGiven || dateMissing ? localDate() : dateValue

const today = localDate()
const dateWellFormed = /^\d{4}-\d{2}-\d{2}$/.test(date)
const dateInFuture = dateWellFormed && date > today

if (familyId === undefined || note === undefined || note.trim() === '') {
  console.log('usage: node tools/record-prevention.mjs <FAM-id> "<what the measure caught>" [--date YYYY-MM-DD]')
  process.exitCode = 1
} else if (dateMissing) {
  console.log('--date was given with no value. An undated record reads as "some time", which')
  console.log('cannot be placed on the timeline — pass a date or omit the flag for today.')
  process.exitCode = 1
} else if (!dateWellFormed) {
  console.log(`--date ${JSON.stringify(date)} is not YYYY-MM-DD.`)
  process.exitCode = 1
} else if (dateInFuture) {
  console.log(`--date ${date} is in the future (today is ${today}). A prevention win is`)
  console.log('something that already happened.')
  process.exitCode = 1
} else if (MEASURE_NOT_OBSERVATION.some((pattern) => pattern.test(note.trim()))) {
  console.log(`that note describes the MEASURE, not what it caught: ${JSON.stringify(note.trim())}`)
  console.log('')
  console.log('A win is a moment where the defect would have occurred and a named measure')
  console.log('stopped it. "We added a guard" is the default state — recording it makes this')
  console.log('column count intentions instead of outcomes.')
  console.log('')
  console.log('Say what it caught: "the guard rejected X on Y, before it shipped".')
  process.exitCode = 1
} else {
  const family = families.find((f) => f.id === familyId)
  if (family === undefined) {
    console.log(`${familyId} is not a family in docs/recurrence.json`)
    console.log(`known: ${families.map((f) => f.id).join(', ')}`)
    process.exitCode = 1
  } else if ((family.prevention ?? []).length === 0) {
    // A win without a named measure is a win that cannot be attributed, and therefore
    // cannot be counted as evidence for anything.
    console.log(`${familyId} has no prevention measure to credit. Add one first.`)
    process.exitCode = 1
  } else {
    family.preventionWins = Array.isArray(family.preventionWins) ? family.preventionWins : []
    family.preventionWins.push({ date, note: String(note), measures: [...family.prevention] })
    writeFileSync(DATA, `${JSON.stringify(data, null, 2)}\n`)
    console.log(`recorded a win for ${familyId}: ${note}`)
    console.log(`  measures credited: ${family.prevention.join(', ')}`)
    console.log(`  total wins: ${family.preventionWins.length}`)
  }
}
