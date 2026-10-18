/**
 * Behaviour snapshot: record what every tool action DOES, so a refactor can be
 * proven to change nothing.
 *
 * This is not a test — it is a fixture generator. It drives every registered
 * action through a recording runner and dumps the exact argv, the exact result
 * value, and the exact rejection message. Run it before and after a refactor and
 * diff the two files: any difference is a behaviour change, including one the
 * existing suite does not assert.
 *
 * Why a separate tool rather than more assertions: the existing suite checks the
 * properties someone thought to check. A snapshot catches the ones nobody wrote
 * down — an argument that moved position, a note that changed wording, a gate
 * that now fires one line earlier. During the R4 refactor this file is what made
 * "no behaviour change" a measurement instead of a claim.
 *
 * Usage:
 *   node tools/snapshot-behaviour.mjs > /tmp/before.json
 *   ... refactor ...
 *   node tools/snapshot-behaviour.mjs > /tmp/after.json
 *   node tools/snapshot-behaviour.mjs --compare /tmp/before.json
 */

import { writeFileSync, readFileSync } from 'node:fs'
import { makeContext, makeRunner, testConfig, call } from '../test/helpers.mjs'
import { registerDomainTools, ALL_DOMAINS } from '../lib/registry.js'

/**
 * A value every parameter can take, by its declared type.
 * @param {any} spec the parameter spec
 * @param {number} variant distinguishes values within one action
 * @returns {unknown} the sample
 */
function sampleValue(spec, variant) {
  const type = spec?.type
  if (type === 'boolean') return true
  if (type === 'number' || type === 'integer') return variant === 0 ? 1 : 2
  const values = spec?.enum ?? spec?.values
  if (Array.isArray(values) && values.length > 0) return values[Math.min(variant, values.length - 1)]
  if (type === 'array') return ['x']
  return variant === 0 ? 'base' : 'probe'
}

/**
 * Argument sets for one action: a minimal set, a maximal set, and one with
 * `confirm` omitted (to exercise the destructive gate).
 * @param {any} domain the domain
 * @param {string} actionName the action id
 * @param {any} action the action definition
 * @returns {{ label: string, args: Record<string, unknown> }[]}
 */
function argSets(domain, actionName, action) {
  const params = domain.params ?? {}
  const base = { action: actionName }
  for (const [name, spec] of Object.entries(params)) {
    if (name === 'confirm' || name === 'run_in_background') continue
    base[name] = sampleValue(spec, 0)
  }
  for (const key of action.needs ?? []) if (base[key] === undefined) base[key] = sampleValue(params[key], 0)
  const sets = [{ label: 'minimal', args: { ...base } }]
  const maximal = { ...base }
  for (const [name, spec] of Object.entries(params)) {
    if (name === 'confirm' || name === 'run_in_background') continue
    maximal[name] = sampleValue(spec, 1)
  }
  sets.push({ label: 'maximal', args: maximal })
  if (action.destructive === true) {
    sets.push({ label: 'no-confirm', args: { ...base } })
    sets.push({ label: 'confirmed', args: { ...base, confirm: true } })
  }
  return sets
}

/** Run one call and reduce its outcome to a comparable record. */
async function record(domain, actionName, label, args) {
  const { runner, calls } = makeRunner()
  // A fresh context per record: the recorder must start empty, and a tool
  // definition is bound to the context that registered it.
  const { ctx, tools } = makeContext()
  registerDomainTools(ctx, testConfig({ defaultRepo: 'o/r' }), runner, {
    resolveToken: async () => 'tok',
    fetch: async () => ({ ok: false }),
    deps: { runner, resolveToken: async () => 'tok', fetch: async () => ({ ok: false }) },
  })
  const definition = tools.get(domain.tool)
  if (definition === undefined) return { skipped: 'not registered' }
  try {
    const result = await definition.execute(args, { signal: undefined })
    return {
      argv: calls.gh.length > 0 ? calls.gh[0] : calls.git.length > 0 ? calls.git[0] : null,
      result: {
        ok: result.ok,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        command: result.command,
      },
    }
  } catch (error) {
    return { threw: `${error.constructor.name}: ${error.message}` }
  }
}

const snapshots = []
for (const domain of ALL_DOMAINS) {
  for (const [actionName, action] of Object.entries(domain.actions)) {
    for (const set of argSets(domain, actionName, action)) {
      snapshots.push({
        key: `${domain.tool}:${actionName}:${set.label}`,
        ...(await record(domain, actionName, set.label, set.args)),
      })
    }
  }
}

const json = JSON.stringify(snapshots, null, 2)

/**
 * Strip the parts of a result that legitimately vary between runs.
 *
 * The probe reports per-layer timings (`0 ms`, `1 ms`), which differ run to run on
 * any machine and say nothing about behaviour. Comparing them produced a
 * "difference" on the first refactor that was pure clock noise, which is exactly
 * the kind of false positive that teaches a reader to ignore the tool.
 *
 * @param {string} text a captured output
 * @returns {string} the text with timings and durations normalised
 */
function withoutTiming(text) {
  return String(text)
    .replace(/\b\d+ ms\b/g, '<ms>')
    .replace(/\b\d+(\.\d+)?s\b/g, '<s>')
    .replace(/in \d+ms/g, 'in <ms>')
}

/**
 * The comparable projection of one record.
 * @param {any} record the snapshot record
 * @returns {string} a stable JSON string
 */
function stable(record) {
  if (record === undefined) return 'undefined'
  return JSON.stringify({
    ...record,
    result: record.result === undefined ? undefined : {
      ...record.result,
      stdout: withoutTiming(record.result.stdout),
      stderr: withoutTiming(record.result.stderr),
    },
  })
}

const compareAt = process.argv.indexOf('--compare')
if (compareAt !== -1) {
  const beforePath = process.argv[compareAt + 1]
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  const after = snapshots
  let differences = 0
  for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
    const a = stable(before[i])
    const b = stable(after[i])
    if (a !== b) {
      differences += 1
      console.log(`DIFF  ${before[i]?.key ?? after[i]?.key}`)
      console.log(`  before: ${a}`)
      console.log(`  after : ${b}`)
    }
  }
  console.log(differences === 0
    ? `\n=== identical: ${after.length} snapshots match (timings normalised) ===`
    : `\n=== ${differences} difference(s) of ${after.length} ===`)
  process.exitCode = differences === 0 ? 0 : 1
} else {
  process.stdout.write(json)
}
void writeFileSync
