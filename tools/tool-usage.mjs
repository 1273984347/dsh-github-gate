/**
 * Which tools and actions have ever actually been called — H-05, previously 【待验证】.
 *
 * ## The question
 *
 * Five actions of this plugin failed on every call from 0.1.0 until they were found. The
 * report could say they were broken; it could NOT say whether that mattered, because
 * "was anyone using them" needs the session records, and nobody had read them.
 *
 * ## Where the answer lives, and the one non-obvious part
 *
 * `DSH_HOME/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`. The file is NOT one
 * zstd stream: it is **hundreds of independently compressed frames appended over the life
 * of the session** — 413 of them in the audit session alone. `zstdDecompressSync` takes the
 * first frame and stops, which is how a 758 KB file yields 260 bytes and looks empty.
 *
 * Every frame starts with the magic `28 B5 2F FD`, so the file is split on that and each
 * piece is decompressed on its own; the decoder stops at the frame's own end, so a piece
 * that also contains the next frame is harmless. Measured on the audit session: 413 frames,
 * 0 failures, 660 records, 136 tool calls.
 *
 * ## What it does NOT claim
 *
 * It counts calls in the records it can read. A session whose log was pruned, or one from
 * another machine, is invisible — so "never called" means "never called in the records
 * available here", and the output says so rather than reporting a bare zero.
 *
 * Usage:
 *   node tools/tool-usage.mjs
 *   node tools/tool-usage.mjs --json
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The zstd frame magic, which is how frames are found in a concatenated file. */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Decode one `session.v4.jsonl.zstd`.
 *
 * @param {string} path the file
 * @returns {object[]} the records it holds
 */
function readSession(path) {
  const buffer = readFileSync(path)
  const positions = []
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1]
      && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) positions.push(index)
  }
  let text = ''
  for (const position of positions) {
    try {
      text += zstdDecompressSync(buffer.subarray(position)).toString('utf8')
    } catch {
      // A frame that will not decode is skipped, not fatal: the rest still counts.
    }
  }
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A partially written trailing line is expected in an append-only log.
    }
  }
  return records
}

/** Every session log under DSH_HOME, recursively. */
function findSessions() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  const root = join(home, 'sessions')
  if (!existsSync(root)) return { root, files: [] }
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd')) files.push(full)
    }
  }
  walk(root)
  return { root, files }
}

/**
 * The tool name and action of one `tool/call` record, or undefined.
 *
 * The record shape, measured rather than guessed:
 *
 *     { type: 'tool/call', seq, time, data: { turn, step, callId, name, arguments } }
 *
 * **`data.arguments` is a JSON STRING**, not an object — the first version of this file
 * tested `typeof args === 'object'` and therefore reported every action as `(no action)`,
 * which made the output useless in the one way that mattered: it said all 59 declared
 * actions were never called.
 *
 * @param {any} record a decoded record
 * @returns {{tool: string, action: string} | undefined} the call
 */
function callOf(record) {
  if (record?.type !== 'tool/call') return undefined
  const tool = record.data?.name
  if (typeof tool !== 'string') return undefined
  let args = record.data?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = undefined
    }
  }
  const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : ''
  return { tool, action }
}

const { root, files } = findSessions()

/** @type {Map<string, Map<string, number>>} */
const usage = new Map()
const sessions = []
let decoded = 0
let records_total = 0

for (const file of files) {
  let records
  try {
    records = readSession(file)
  } catch {
    continue
  }
  decoded += 1
  records_total += records.length
  const id = file.split(/[/\\]/).slice(-2, -1)[0] ?? file
  let calls = 0
  for (const record of records) {
    const call = callOf(record)
    if (call === undefined) continue
    calls += 1
    if (!call.tool.startsWith('github_')) continue
    if (!usage.has(call.tool)) usage.set(call.tool, new Map())
    const actions = usage.get(call.tool)
    const key = call.action === '' ? '(no action)' : call.action
    actions.set(key, (actions.get(key) ?? 0) + 1)
  }
  if (calls > 0) sessions.push({ id, calls })
}

// The declared surface, so "never called" can be reported against what exists rather than
// against what happens to appear in a log.
const declared = []
{
  const domainDir = join(ROOT, 'lib', 'domains')
  if (existsSync(domainDir)) {
    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith('.js')) continue
      const module = await import(new URL(`../lib/domains/${file}`, import.meta.url).href)
      for (const value of Object.values(module)) {
        if (value === null || typeof value !== 'object') continue
        if (typeof value.tool !== 'string' || value.actions === undefined) continue
        declared.push({ tool: value.tool, actions: Object.keys(value.actions), readOnly: value.readOnlyActions ?? [] })
      }
    }
  }
}

const never = []
for (const entry of declared) {
  for (const action of entry.actions) {
    if (!usage.get(entry.tool)?.has(action)) never.push(`${entry.tool} ${action}`)
  }
}

const totalCalls = [...usage.values()].reduce((sum, actions) => sum + [...actions.values()].reduce((a, b) => a + b, 0), 0)

const report = {
  sessionsRoot: root,
  sessionFiles: files.length,
  decoded,
  records: records_total,
  githubCalls: totalCalls,
  byTool: Object.fromEntries([...usage].map(([tool, actions]) => [tool, Object.fromEntries(actions)])),
  declaredActions: declared.reduce((sum, entry) => sum + entry.actions.length, 0),
  neverCalled: never,
  limitation: 'counts what is in the records under DSH_HOME. A pruned or off-machine '
    + 'session is invisible, so "never called" means "not called in the sessions available here".',
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('tool usage, from the session records')
  console.log(`  session files decoded   ${decoded}/${files.length}`)
  console.log(`  records                 ${records_total}`)
  console.log(`  github_* tool calls     ${totalCalls}`)
  console.log('')
  if (totalCalls === 0) {
    console.log('  No github_* calls in any record. That is an answer, not an error: this')
    console.log('  plugin has been driven almost entirely by this agent, and the calls it')
    console.log('  makes are in ITS session — check that the sessions root is the right one.')
  }
  for (const [tool, actions] of usage) {
    const total = [...actions.values()].reduce((a, b) => a + b, 0)
    console.log(`  ${tool.padEnd(18)}${String(total).padStart(4)}   ${[...actions].map(([a, n]) => `${a}×${n}`).join(', ')}`)
  }
  console.log('')
  console.log(`declared actions          ${report.declaredActions}`)
  console.log(`never called              ${never.length}`)
  if (never.length > 0) {
    console.log('')
    for (const item of never) console.log(`  ${item}`)
    console.log('')
    console.log('  "Never called" is against the sessions available on THIS machine — see the')
    console.log('  limitation below. It is the H-05 answer for those sessions, not for all time.')
  }
  console.log('')
  console.log(`note: ${report.limitation}`)
}

// ---------------------------------------------------------------------------
// The failure channel.
//
// An independent audit found this file had none — no `process.exitCode`, no `throw`, no
// `console.error`. Two things went wrong silently as a result:
//
//   - a session whose frames would not decode is skipped by a bare `catch`, and the summary
//     printed `decoded N/M` as information rather than as a gap
//   - a missing sessions root printed an explanation and exited 0, so a run that read
//     nothing looked the same as a run that found nothing
//
// The distinction that matters: "no github_* calls in the records" is a FINDING about the
// plugin, while "no records could be read" is a failure of the measurement. They must not
// look alike, which is the same rule this project keeps rediscovering.
// ---------------------------------------------------------------------------
const readFailures = []
if (files.length === 0) {
  readFailures.push(`no session logs under ${root} — nothing was measured`)
} else if (decoded < files.length) {
  readFailures.push(`${files.length - decoded} of ${files.length} session log(s) could not be decoded`)
}

if (readFailures.length > 0) {
  console.error(`\nFAIL  ${readFailures.length} problem(s) reading the session records:`)
  for (const item of readFailures) console.error(`  - ${item}`)
  console.error('\n"No calls found" is a finding about the plugin. "Nothing readable" is a')
  console.error('failure of the measurement, and the two must not print the same way.')
  process.exitCode = 1
}