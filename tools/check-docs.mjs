/**
 * Verify every number the README states against `docs/stats.json`.
 *
 * ## The mechanism
 *
 * A claim is written as `61<!--stats:action_count-->`. GitHub renders it as `61`; the
 * comment is invisible in the rendered page and carries the key the claim is about.
 * This gate reads both and fails when:
 *
 * 1. the number and `docs/stats.json` disagree;
 * 2. the marker names a key that does not exist (a typo would otherwise silently drop
 *    the claim from verification forever);
 * 3. a marker carries no number, so there is nothing to compare;
 * 4. a key in `docs/stats.json` appears in NO document — a claim that was deleted is
 *    as much a defect as one that went stale, because the stat then has no reader and
 *    nobody notices when it stops being true.
 *
 * This is the cheap version of a document-drift gate: the value's single source is a
 * JSON file, and the only thing the prose owns is where the number appears. Writing a
 * regex per sentence — the alternative — grows without bound and still misses the
 * sentence someone writes tomorrow.
 *
 * @module tools/check-docs
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Reporter } from './lib/report.mjs'

/** Documents that may carry a stats claim. */
const DOCUMENTS = ['README.md', 'README.zh.md']

/**
 * Read stats.json, or an empty map when absent.
 * @param {string} root the package root
 * @returns {Record<string, number>} key -> value
 */
function readStats(root) {
  const path = join(root, 'docs', 'stats.json')
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const keys = parsed.keys ?? {}
  return Object.fromEntries(Object.entries(keys).map(([key, entry]) => [key, entry.value]))
}

/**
 * Find every claim marker in a document.
 *
 * Markers inside an inline code span are skipped: a document has to be able to TALK
 * about the marker syntax without making a claim. This gate found that out the hard
 * way — its own README paragraph documented the form `N<!--stats:key-->`, and the
 * scanner reported `marker names unknown key "key"`. It is the fifth time in this
 * repository that a pattern check read prose as code; the remedy each time was the
 * same, and it is cheaper to encode it here than to remember it.
 *
 * @param {string} text the document
 * @returns {{ key: string, value: number | undefined, index: number, inCode: boolean }[]} the markers
 */
export function findMarkers(text) {
  const markers = []
  for (const match of text.matchAll(/(\d*)\s*<!--stats:([a-z0-9_]+)-->/g)) {
    const index = match.index ?? 0
    const lineStart = text.lastIndexOf('\n', index) + 1
    const before = text.slice(lineStart, index)
    // An odd number of backticks before the marker on the same line means the marker
    // sits inside a code span.
    const inCode = (before.match(/`/g) ?? []).length % 2 === 1
    markers.push({
      key: match[2],
      value: match[1] === '' ? undefined : Number(match[1]),
      index,
      inCode,
    })
  }
  return markers
}

/**
 * Check every document's claims against the stats file.
 * @param {string} root the package root
 * @returns {Reporter} the collected results
 */
export function checkDocs(root) {
  const reporter = new Reporter()
  const stats = readStats(root)
  const statKeys = Object.keys(stats)

  if (statKeys.length === 0) {
    reporter.unverified('docs/stats.json exists and carries keys',
      'no docs/stats.json (or no keys in it), so no claim could be verified. '
      + 'Run: node --import ./test/register-hook.mjs tools/status.mjs --write')
    return reporter
  }

  const problems = []
  const usedKeys = new Set()
  let claimCount = 0

  for (const name of DOCUMENTS) {
    const path = join(root, name)
    if (!existsSync(path)) {
      problems.push(`${name}: missing (documented numbers live here)`)
      continue
    }
    const text = readFileSync(path, 'utf8')
    for (const marker of findMarkers(text)) {
      // A marker inside a code span documents the syntax; it makes no claim.
      if (marker.inCode) continue
      claimCount += 1
      const where = `${name}@${text.slice(0, marker.index).split('\n').length}`
      if (!(marker.key in stats)) {
        problems.push(`${where}: marker names unknown key "${marker.key}" (not in docs/stats.json)`)
        continue
      }
      if (marker.value === undefined) {
        problems.push(`${where}: "${marker.key}" has no number before the marker, so nothing can be checked`)
        continue
      }
      usedKeys.add(marker.key)
      if (marker.value !== stats[marker.key]) {
        problems.push(`${where}: claims ${marker.value} but docs/stats.json says ${stats[marker.key]} (${marker.key})`)
      }
    }
  }

  reporter.check(problems.length === 0,
    `every stats claim in ${DOCUMENTS.join(' and ')} matches docs/stats.json (${claimCount} claims)`,
    problems.join('; '))

  // Both documents carry claims, but a key need only appear once overall: README and
  // README.zh do not have to repeat every number.
  const unused = statKeys.filter((key) => !usedKeys.has(key))
  reporter.check(unused.length === 0,
    'every key in docs/stats.json is claimed by at least one document',
    unused.length === 0
      ? `${statKeys.length} key(s) referenced`
      : `unclaimed: ${unused.join(', ')} — add a \`N<!--stats:key-->\` claim or drop the stat`)

  reporter.check(claimCount > 0, 'the documents carry stats claims', `${claimCount} marker(s) found in ${relative(root, join(root, 'README.md'))}`)
  return reporter
}

// CLI entry: `node tools/check-docs.mjs`
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { printResults, finish } = await import('./lib/report.mjs')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const reporter = checkDocs(root)
  printResults(reporter.results)
  finish(reporter.results)
}
