/**
 * Validate the knowledge library.
 *
 * A library nobody checks becomes prose. This asserts the properties that make an
 * entry REUSABLE rather than merely written: it has a stable id, it names what it
 * replaces (a source E/SC/P/S/... reference), it states who owns it and how often
 * it is revisited, and it is reachable from the index.
 *
 * Without this, `docs/KNOWLEDGE.md` drifts: an id gets reused, a source reference
 * points at a section number that no longer exists, and the index silently stops
 * matching the body. That is the same "documented but not enforced" failure the
 * library itself is about.
 *
 * Usage: node tools/knowledge-index.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const library = join(root, 'docs', 'KNOWLEDGE.md')

const results = []
/**
 * Record one check.
 * @param {boolean} ok whether it passed
 * @param {string} name the check name
 * @param {string} detail evidence
 */
function check(ok, name, detail = '') {
  results.push({ ok, name, detail })
}

if (!existsSync(library)) {
  console.log(`FAIL  docs/KNOWLEDGE.md exists`)
  process.exitCode = 1
  process.exit(1)
}

const text = readFileSync(library, 'utf8')

// 1. Every record is a `## K-nn Title` section.
const records = [...text.matchAll(/^## (K-\d{2}) (.+)$/gm)].map((m) => ({ id: m[1], title: m[2].trim() }))
check(records.length >= 10, `the library holds at least 10 records (${records.length})`,
  records.map((r) => r.id).join(', '))

// 2. Ids are unique and contiguous — a reused id breaks every reference to it.
const ids = records.map((r) => r.id)
check(new Set(ids).size === ids.length, 'record ids are unique',
  ids.filter((id, at) => ids.indexOf(id) !== at).join(', ') || 'all unique')
const numbered = ids.map((id) => Number(id.slice(2))).sort((a, b) => a - b)
const contiguous = numbered.every((n, at) => n === at + 1)
check(contiguous, 'record ids are contiguous from K-01',
  contiguous ? `K-01 … K-${String(numbered.length).padStart(2, '0')}` : numbered.join(', '))

// 3. Every record carries the fields that make it reusable.
for (const record of records) {
  const at = text.indexOf(`## ${record.id} `)
  const next = text.indexOf('\n## ', at + 1)
  const body = text.slice(at, next === -1 ? text.length : next)
  const missing = []
  // The metadata table is how the fields are expressed; each must be a row.
  for (const field of ['类型 / 分类', '来源', 'Owner', '版本 / 更新频率', '适用场景', '边界条件']) {
    if (!body.includes(`| ${field} |`)) missing.push(field)
  }
  check(missing.length === 0, `${record.id} declares every required field`,
    missing.length === 0 ? 'all present' : `missing: ${missing.join(', ')}`)

  // 4. A source reference must resolve to a numbered item, so the entry can be
  //    traced back to the observation that produced it.
  const sourceRow = /\| 来源 \| (.+?) \|/.exec(body)?.[1] ?? ''
  const refs = sourceRow.match(/\b(?:E|S|U|SC|P|WF|A|PRE|K)-\d{2}\b/g) ?? []
  check(refs.length > 0, `${record.id} cites a source item`,
    refs.length === 0 ? `no E/SC/P/S/U/WF/A/PRE/K reference in "${sourceRow}"` : refs.join(', '))
}

// 5. The index must list exactly the records the body defines — an index that
//    drifts is worse than none, because it looks authoritative.
const indexRows = [...text.matchAll(/^\| \[(K-\d{2})\]\(#k-\d{2}\)/gm)].map((m) => m[1])
check(indexRows.length === records.length,
  'the index lists every record', `index ${indexRows.length}, body ${records.length}`)
check(indexRows.every((id) => ids.includes(id)), 'the index lists no id the body lacks',
  indexRows.filter((id) => !ids.includes(id)).join(', ') || 'consistent')

// 6. Each record needs an anchor matching its index link.
for (const record of records) {
  const anchor = `<a id="${record.id.toLowerCase()}"></a>`
  check(text.includes(anchor), `${record.id} has the anchor its index link targets`,
    text.includes(anchor) ? anchor : `missing ${anchor}`)
}

const failed = results.filter((r) => !r.ok)
for (const item of results) {
  if (!item.ok) console.log(`FAIL  ${item.name}\n      ${item.detail}`)
}
console.log(`knowledge library: ${records.length} records, ${results.length} assertions`)
console.log(`=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  console.log('failed:')
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
