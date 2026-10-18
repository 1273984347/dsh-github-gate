/**
 * Verify the tool-definition DSL against the REAL `defineTool` from the dsh
 * installation.
 *
 * Every check here corresponds to something that would otherwise fail at plugin
 * LOAD time, where the only signal is "failed to import" with no detail:
 *
 * 1. Does the vendored `@deepseek-ai/dsh-tools` import and expose `defineTool`?
 * 2. Does the shipped `RESULT_VALUE_SCHEMA` compile under the value DSL?
 * 3. Does the value DSL REJECT a `required` array? (It does — the compiler runs
 *    with `allowRequired: false`. That is why the result contract is pinned by
 *    tests instead of a schema keyword, and this check keeps it pinned.)
 * 4. Does it REJECT an annotation-only property? (It does — hence
 *    `type: 'json'` for the unconstrained `data`.)
 * 5. Does the parameter DSL actually reject bad arguments before `execute`?
 *
 * Run with the resolver hook:
 *   node --import ./test/register-hook.mjs tools/probe-define-tool.mjs
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { RESULT_VALUE_SCHEMA } from '../lib/schema.js'

/** @type {string[]} */
const results = []
/**
 * @param {boolean} ok whether the check passed
 * @param {string} label the check name
 * @param {string} detail what was observed
 */
const report = (ok, label, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `\n      ${detail}`}`)
}

report(typeof defineTool === 'function', 'defineTool imports from the vendored dsh-tools', typeof defineTool)

// The exact parameter DSL the registry produces.
const parameterSpec = {
  action: { type: 'string', required: true, enum: ['list', 'view'], description: 'What to do.' },
  repo: { type: 'string', description: 'owner/name' },
  limit: { type: 'integer', description: 'How many.' },
  labels: { type: 'array', items: { type: 'string' }, description: 'Labels.' },
  confirm: { type: 'boolean', description: 'Confirm.' },
}

// Probe 1: the shipped result schema compiles.
let currentAccepted = true
let currentError = ''
let compiled
try {
  compiled = defineTool({
    name: 'probe_tool',
    description: 'probe',
    parameters: parameterSpec,
    output: { schema: RESULT_VALUE_SCHEMA, render: () => [] },
    async execute() { return null },
  })
} catch (error) {
  currentAccepted = false
  currentError = String(error?.message ?? error)
}
report(currentAccepted, 'the shipped RESULT_VALUE_SCHEMA compiles under the value DSL', currentError)

// Probe 2: WHICH form of `required` the value DSL accepts.
//
// This probe used to assert only that the object-level ARRAY is rejected, and
// the plugin then concluded "the DSL has no required" and moved the whole result
// contract into tests. That was an over-generalization. Reading the shipped
// production tool `@deepseek-ai/dsh-tool-fs` showed the real form:
//
//     properties: { path: { type: 'string', required: true } }
//
// `required` is a per-PROPERTY flag in the value DSL. Both facts are pinned
// below, because knowing only the first is what produced the wrong conclusion.
let requiredArrayRejected = false
let requiredArrayError = ''
try {
  defineTool({
    name: 'probe_required_array',
    description: 'probe',
    parameters: parameterSpec,
    output: { schema: { ...RESULT_VALUE_SCHEMA, required: ['ok'] }, render: () => [] },
    async execute() { return null },
  })
} catch (error) {
  requiredArrayRejected = true
  requiredArrayError = String(error?.message ?? error)
}
report(requiredArrayRejected, 'the value DSL REJECTS an object-level `required` ARRAY', requiredArrayError)

let perPropertyAccepted = false
let perPropertyError = ''
let perPropertyTool
try {
  perPropertyTool = defineTool({
    name: 'probe_required_property',
    description: 'probe',
    parameters: parameterSpec,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          exitCode: { type: 'integer', required: true },
        },
      },
      render: () => [],
    },
    async execute() { return null },
  })
  perPropertyAccepted = true
} catch (error) {
  perPropertyError = String(error?.message ?? error)
}
report(perPropertyAccepted, 'the value DSL ACCEPTS a per-property `required: true` (the production form)',
  perPropertyError)

if (perPropertyTool !== undefined) {
  const compiled = perPropertyTool.output.schema
  report(Array.isArray(compiled.required) && compiled.required.includes('ok'),
    'per-property `required: true` compiles into an object-level required list',
    JSON.stringify(compiled.required ?? null))
  report(compiled.additionalProperties === false,
    '`additionalProperties: false` survives compilation',
    String(compiled.additionalProperties))
}

// Probe 3: an annotation-only property is rejected — hence `type: 'json'`.
let bareAnnotationRejected = false
let bareAnnotationError = ''
try {
  defineTool({
    name: 'probe_annotation',
    description: 'probe',
    parameters: parameterSpec,
    output: { schema: { type: 'object', properties: { data: { description: 'no type' } } }, render: () => [] },
    async execute() { return null },
  })
} catch (error) {
  bareAnnotationRejected = true
  bareAnnotationError = String(error?.message ?? error)
}
report(bareAnnotationRejected, 'the value DSL REJECTS an annotation-only property (hence `type: \'json\'`)',
  bareAnnotationError)

if (compiled !== undefined) {
  const requiredList = compiled.parameters.required ?? []
  report(requiredList.includes('action'), 'the DSL marks `required: true` fields as required', JSON.stringify(requiredList))
  report(!requiredList.includes('repo') && !requiredList.includes('limit'),
    'fields without `required` stay optional', JSON.stringify(requiredList))
  report(compiled.parameters.additionalProperties === undefined,
    'the implicit parameter root stays open', String(compiled.parameters.additionalProperties))

  // Argument validation is the whole point of the migration: a string where an
  // array is declared must be rejected BEFORE execute runs.
  const exec = { signal: undefined }
  const cases = [
    [{ action: 'list', labels: 'not-an-array' }, 'a string passed for an array parameter'],
    [{ action: 'list', limit: 'abc' }, 'a string passed for an integer parameter'],
    [{ repo: 'a/b' }, 'a missing required `action`'],
    [{ action: 'nonsense' }, 'an action outside the enum'],
  ]
  for (const [args, label] of cases) {
    let rejected = false
    let detail = ''
    try {
      await compiled.execute(args, exec)
    } catch (error) {
      rejected = true
      detail = String(error?.name ?? '') + ': ' + String(error?.message ?? error).slice(0, 120)
    }
    report(rejected, `defineTool rejects ${label}`, detail)
  }

  let accepted = false
  let acceptDetail = ''
  try {
    await compiled.execute({ action: 'list', labels: ['a'], limit: 3 }, exec)
    accepted = true
  } catch (error) {
    acceptDetail = String(error?.message ?? error)
  }
  report(accepted, 'a well-formed argument object reaches execute', acceptDetail)
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
