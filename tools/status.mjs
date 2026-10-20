/**
 * One-screen project status, and the only writer of `docs/stats.json`.
 *
 * ## Why this exists
 *
 * The README states numbers — nine tools, 176 tests, 211 parameter assertions — and
 * every one of them was typed by hand. Hand-typed numbers drift silently: the claim
 * stays, the code moves, and a reader cannot tell which happened. `docs/stats.json`
 * is the single source for those values, the README carries `<!--stats:key-->`
 * markers, and `tools/check-docs.mjs` fails when a marker disagrees.
 *
 * Two rules it follows:
 *
 * 1. **Measure, do not remember.** Every value comes from running the thing that owns
 *    it, or from a static count of the file that declares it — never from prose.
 * 2. **Never write a value that was not measured.** When a measurement cannot run, the
 *    key keeps its previous value and the run reports it. A fresh timestamp over a
 *    stale number is worse than an honest gap.
 *
 * Usage (the vendor hook is needed because the surface is read from the real registry):
 *   node --import ./test/register-hook.mjs tools/status.mjs
 *   node --import ./test/register-hook.mjs tools/status.mjs --write
 *
 * @module tools/status
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATS_PATH = join(root, 'docs', 'stats.json')
const VENDOR = ['--import', './test/register-hook.mjs']

/**
 * Run a node command in this package and return its output.
 * @param {string[]} argv argv tail (never a shell string)
 * @param {string[]} [nodeArgs] extra node flags
 * @returns {string} stdout, or the combined output when it failed
 */
function runNode(argv, nodeArgs = []) {
  try {
    return execFileSync(process.execPath, [...nodeArgs, ...argv], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

/**
 * Read the registered tool surface from the real registry.
 *
 * Counts come from `ALL_DOMAINS` — the same table registration iterates — so they
 * cannot drift from what is actually registered. `destructive_count` counts only the
 * actions that declare `destructive: true`; the four write methods `github_api` accepts
 * are destructive at RUN time depending on an argument, so they are described in prose
 * rather than folded into a count of actions.
 * @returns {Promise<{ tools: string[], actions: number, destructive: number }>} the surface
 */
async function readSurface() {
  const { makeContext, makeRunner, testConfig } = await import('../test/helpers.mjs')
  const { registerDomainTools, ALL_DOMAINS } = await import('../lib/registry.js')
  const context = makeContext()
  registerDomainTools(context.ctx, testConfig(), makeRunner().runner)
  const tools = [...context.tools.keys()]

  let actions = 0
  let destructive = 0
  for (const domain of ALL_DOMAINS) {
    for (const action of Object.values(domain.actions)) {
      actions += 1
      if (action?.destructive === true) destructive += 1
    }
  }
  return { tools, actions, destructive }
}

/**
 * Count declared tests by reading the suite.
 *
 * A file scan beats `npm test` here: both produce the same tally, the scan is instant,
 * and the run remains the authority on whether they PASS.
 * @returns {number} how many `test(` declarations exist
 */
function countTests() {
  const dir = join(root, 'test')
  if (!existsSync(dir)) return 0
  let total = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.mjs')) continue
    const source = readFileSync(join(dir, name), 'utf8')
    total += [...source.matchAll(/^test\(/gm)].length
  }
  return total
}

/**
 * Every stat, with the command that produces it.
 *
 * A key earns a place here only if something MEASURES it. A value maintained by hand
 * would be the same problem this file exists to solve, one level up.
 * @param {{ tools: string[], actions: number, destructive: number }} surface the registered surface
 * @returns {{ key: string, domain: string, value: number, source: string }[]} the stats
 */
function measureAll(surface) {
  const results = []
  const record = (key, domain, value, source) => results.push({ key, domain, value, source })

  record('tool_count', 'surface', surface.tools.length, 'tools registered by registerDomainTools')
  record('action_count', 'surface', surface.actions, 'sum of every domain\'s action table')
  record('destructive_count', 'surface', surface.destructive, 'actions declaring destructive: true')
  record('runtime_dependencies', 'packaging',
    Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {}).length,
    'manifest.dependencies — must stay 0')
  record('test_count', 'verification', countTests(), 'test() declarations across test/*.test.mjs')

  const params = /(\d+)\/(\d+) passed/.exec(runNode(['tools/verify-params.mjs'], VENDOR))
  record('param_count', 'verification', params === null ? 0 : Number(params[2]),
    'assertions in tools/verify-params.mjs')

  const guidance = /prompt section (\d+) chars/.exec(runNode(['tools/probe-guidance.mjs'], VENDOR))
  record('guidance_chars', 'prompt', guidance === null ? 0 : Number(guidance[1]),
    'injected prompt section size, measured by probe-guidance')

  // The argv probe needs the real `gh`; without it the count stays unmeasured rather
  // than being guessed from the source.
  const argv = /(\d+)\/(\d+) argv shapes accepted/.exec(runNode(['tools/probe-argv.mjs']))
  record('argv_shapes', 'verification', argv === null ? 0 : Number(argv[2]),
    'argv shapes parsed by the real gh (tools/probe-argv.mjs)')

  // The snapshot tool prints its cases as a JSON array on stdout.
  let snapshotCount = 0
  try {
    const raw = runNode(['tools/snapshot-behaviour.mjs'], VENDOR)
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) snapshotCount = parsed.length
  } catch { /* unparseable output means unmeasured, not zero */ }
  record('snapshot_count', 'verification', snapshotCount,
    'cases in tools/snapshot-behaviour.mjs output')

  return results
}

/** Print the status screen. */
async function printStatus() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const stats = existsSync(STATS_PATH) ? JSON.parse(readFileSync(STATS_PATH, 'utf8')).keys : {}

  console.log(`package    ${manifest.name}@${manifest.version}`)
  console.log(`git HEAD   ${gitValue(['rev-parse', '--short', 'HEAD'])}`)
  console.log(`changelog  ${/^## (.+)$/m.exec(changelog)?.[1] ?? '(no entry)'}`)
  console.log('')
  console.log('measured facts (docs/stats.json)')
  const entries = Object.entries(stats)
  if (entries.length === 0) {
    console.log('  none recorded — run: node --import ./test/register-hook.mjs tools/status.mjs --write')
  } else {
    for (const [key, entry] of entries) {
      console.log(`  ${key.padEnd(22)} ${String(entry.value).padEnd(7)} ${entry.source}`)
    }
  }
  console.log('')
  console.log('gates: npm run verify:static   tests: npm test')
}

/**
 * Read a short git value.
 * @param {string[]} argv git arguments
 * @returns {string} the value or '(unknown)'
 */
function gitValue(argv) {
  try {
    return execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return '(unknown)'
  }
}

/**
 * Re-measure and write `docs/stats.json`.
 *
 * A measurement that produced no number keeps the previous value and is reported: a
 * value of 0 from a failed probe would be a lie with a fresh timestamp.
 * @returns {Promise<void>} resolves after writing
 */
async function writeStats() {
  const previous = existsSync(STATS_PATH) ? JSON.parse(readFileSync(STATS_PATH, 'utf8')).keys : {}
  const surface = await readSurface()
  const measured = measureAll(surface)
  const today = new Date().toISOString().slice(0, 10)

  const keys = {}
  const notMeasured = []
  for (const entry of measured) {
    // 0 is a legitimate value for runtime_dependencies; for the probes it means the
    // measurement failed, and the table makes that distinguishable by convention.
    const failed = entry.value === 0 && entry.key !== 'runtime_dependencies'
    if (failed) {
      notMeasured.push(`${entry.key}: ${entry.source} produced no number`)
      if (previous[entry.key] !== undefined) keys[entry.key] = previous[entry.key]
      continue
    }
    keys[entry.key] = {
      value: entry.value,
      domain: entry.domain,
      source: entry.source,
      measured_on: today,
      measured_by: 'tools/status.mjs --write',
    }
  }

  writeFileSync(STATS_PATH, `${JSON.stringify({
    $comment: [
      'Single source for the numbers the README states. Written only by',
      'tools/status.mjs --write; verified by tools/check-docs.mjs, which fails when a',
      '`N<!--stats:key-->` marker disagrees with a value here. Do not edit by hand: a',
      'hand-edited value is indistinguishable from a measured one.',
    ],
    keys,
  }, null, 2)}\n`)

  console.log(`wrote ${Object.keys(keys).length} stat(s) to docs/stats.json`)
  for (const [key, entry] of Object.entries(keys)) {
    console.log(`  ${key.padEnd(22)} ${String(entry.value).padEnd(7)} ${entry.source}`)
  }
  if (notMeasured.length > 0) {
    console.log('\nCOULD NOT MEASURE (previous value kept):')
    for (const line of notMeasured) console.log(`  ${line}`)
    process.exitCode = 1
  }
}

if (process.argv.includes('--write')) await writeStats()
else await printStatus()
