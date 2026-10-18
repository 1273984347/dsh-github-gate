/**
 * Tool definition schema helpers, in the official author-facing DSL.
 *
 * The dev guide (`develop/basic/tool`) and the tool-authoring reference specify
 * that tools are defined with `defineTool` from `@deepseek-ai/dsh-tools` and a
 * per-property parameter map of the form
 * `{ type, required?, enum?, items?, description }`. That DSL is what makes the
 * registry validate model-generated arguments BEFORE `execute` runs:
 *
 *   labels: "oops"   -> invalid arguments: "labels" must be an array
 *   limit:  "abc"    -> invalid arguments: "limit" must be an integer
 *   (no action)      -> invalid arguments: missing required property "action"
 *   action: "nope"   -> invalid arguments: "action" must be one of [...]
 *
 * That last class matters here: with a raw JSON Schema, `ctx.tools.register`
 * accepts the definition but leaves validation to the tool, so a string passed
 * for an array parameter (`labels`) would have been spread into single
 * characters and sent to `gh`.
 *
 * Two constraints of the DSL were established by compiling against the real
 * `defineTool` rather than by reading about it (tools/probe-define-tool.mjs):
 *
 * 1. **`required` in a VALUE schema is a PER-PROPERTY flag, not an object-level
 *    array.** `{ required: ['ok'] }` is rejected with "schema.required is not
 *    supported by the value schema DSL", but
 *    `{ properties: { ok: { type: 'boolean', required: true } } }` is accepted
 *    and COMPILES INTO the object-level list. This module originally recorded
 *    only the first half — "the DSL cannot express required" — and moved the
 *    result contract into tests on the strength of it. That was an
 *    over-generalization of one rejected form, corrected after reading the
 *    shipped `@deepseek-ai/dsh-tool-fs`, whose output schema marks every field
 *    `required: true`. Both halves are now pinned by the probe.
 * 2. **An unconstrained property needs `type: 'json'`.** An annotation-only
 *    property (description with no type) is rejected by the compiler; the
 *    author-only `json` node is the sanctioned way to say "any JSON value".
 *
 * This module never emits a raw JSON Schema fragment for a parameter: the input
 * to `defineTool` must stay in the DSL, and the registry sees the compiled
 * schema that `defineTool` produces.
 *
 * @typedef {import('./types.js').ParamSpec} ParamSpec
 */

/** A string property. @returns {ParamSpec} */
export const str = (description) => ({ type: 'string', description })

/** A string property restricted to a closed set of values. @returns {ParamSpec} */
export const enumStr = (values, description) => ({
  type: 'string',
  enum: [...values],
  description,
})

/** A boolean property. @returns {ParamSpec} */
export const bool = (description) => ({ type: 'boolean', description })

/** An integer property. @returns {ParamSpec} */
export const int = (description) => ({ type: 'integer', description })

/** An array-of-strings property. @returns {ParamSpec} */
export const strArr = (description) => ({
  type: 'array',
  items: { type: 'string' },
  description,
})

/**
 * An object property with closed, fully described fields.
 * @param {Record<string, ParamSpec>} properties field specs
 * @param {string} description model-facing description
 * @returns {ParamSpec} the object spec
 */
export const obj = (properties, description) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  description,
})

/** Shared `repo` parameter ("owner/name" target selector). @returns {ParamSpec} */
export const repoParam = (description) => str(description)

/**
 * The explicit confirmation flag every destructive action requires. Optional in
 * the schema; the action's `destructive` gate enforces it at execution.
 * @returns {ParamSpec}
 */
export const confirmParam = () =>
  bool(
    'DESTRUCTIVE: set to true to explicitly confirm this action. ' +
      'The call is rejected when this flag is absent or false.',
  )

/**
 * Shared per-call timeout override (milliseconds).
 * @returns {ParamSpec}
 */
export const timeoutParam = () =>
  int(
    'Optional per-call timeout in milliseconds. Capped by the plugin ' +
      'configuration; when omitted, normal commands use timeoutMs and ' +
      'watch/log actions use watchTimeoutMs.',
  )

/**
 * A string property that must be present. @returns {ParamSpec}
 * @param {string} description the model-facing description
 */
const requiredStr = (description) => ({ type: 'string', required: true, description })

/** A boolean property that must be present. @returns {ParamSpec} */
const requiredBool = (description) => ({ type: 'boolean', required: true, description })

/** An integer property that must be present. @returns {ParamSpec} */
const requiredInt = (description) => ({ type: 'integer', required: true, description })

/**
 * The canonical value every tool returns.
 *
 * `required` is declared per property, the form the value DSL accepts and
 * compiles into an object-level required list — the same shape the shipped
 * `@deepseek-ai/dsh-tool-fs` uses. That makes the contract DECLARATIVE: it feeds
 * the schema projection the model sees.
 *
 * It is deliberately not described as run-time enforcement. Measured:
 * `defineTool`'s own wrapper returns a value that omits a required field without
 * complaining. The reference says the REGISTRY completes validation after
 * `execute`, and a direct `execute` call bypasses the registry, so whether a
 * violating value is rejected at run time is unmeasured here. The contract is
 * therefore ALSO pinned on real return values by test/offline.test.mjs, which
 * names the offending action when one breaks it.
 *
 * `data` is deliberately NOT required: a gate rejection or a command without
 * `--json` has no parsed payload, and forcing it would mean inventing one.
 *
 * @type {object}
 */
export const RESULT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: requiredBool('True when the process exited with code 0.'),
    exitCode: requiredInt('Process exit code (-1 when the process was killed or failed to spawn).'),
    signal: requiredStr('Termination signal when the process was killed, otherwise an empty string.'),
    timedOut: requiredBool('True when the plugin killed the process after its timeout.'),
    durationMs: requiredInt('Wall-clock duration of the process run.'),
    command: requiredStr('The command line that ran (secrets are never part of argv).'),
    stdout: requiredStr('Captured standard output, possibly truncated (see truncated/spillPath).'),
    stderr: requiredStr('Captured standard error, possibly truncated.'),
    truncated: requiredBool('True when output exceeded maxOutputBytes and was cut in memory.'),
    spillPath: requiredStr('Path holding the complete untruncated output when truncated, otherwise an empty string.'),
    data: {
      type: 'json',
      description:
        'Parsed JSON payload when the command ran with --json and produced valid JSON; absent otherwise.',
    },
  },
}

/**
 * The exact keys every result value carries.
 *
 * Re-exported from `lib/result.js`, which owns the list, the builder that produces
 * it, and the check that verifies it. The list lived in both files for one release;
 * two copies of a contract is two contracts waiting to disagree. The schema above
 * still declares the same keys through per-property `required`, because that is
 * what the model's schema projection sees — but the LIST has one home.
 *
 * @type {readonly string[]}
 */
export { RESULT_KEYS } from './result.js'

/**
 * Keywords the dsh registry enforces on a COMPILED schema.
 *
 * Exported so the offline test can prove every compiled parameter and output
 * schema stays inside the subset, instead of trusting review. Note this checks
 * what `defineTool` produced, not the DSL input.
 * @type {ReadonlySet<string>}
 */
export const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

/** Annotation keywords the registry accepts and ignores for validation. @type {ReadonlySet<string>} */
export const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

/**
 * Walk a COMPILED schema and report every keyword outside the accepted subset.
 *
 * The host rejects an out-of-subset schema with UNSUPPORTED_SCHEMA at
 * registration, so catching it offline turns a load-time failure into a test
 * failure.
 *
 * @param {unknown} schema the compiled schema to inspect
 * @param {string} [path] JSON pointer-ish location for the diagnostic
 * @returns {string[]} violation descriptions, empty when the schema is clean
 */
export function findSchemaViolations(schema, path = '#') {
  /** @type {string[]} */
  const violations = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    violations.push(`${path}: schema must be an object`)
    return violations
  }
  const record = /** @type {Record<string, unknown>} */ (schema)

  for (const key of Object.keys(record)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      violations.push(`${path}: unsupported keyword "${key}"`)
    }
  }

  const type = record.type
  if (type !== undefined) {
    const accepted = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
    if (typeof type !== 'string' || !accepted.includes(type)) {
      violations.push(`${path}: "type" must be one of ${accepted.join('/')}`)
    }
  }

  if (record.properties !== undefined) {
    if (typeof record.properties !== 'object' || record.properties === null || Array.isArray(record.properties)) {
      violations.push(`${path}.properties: must be an object`)
    } else {
      for (const [name, child] of Object.entries(record.properties)) {
        violations.push(...findSchemaViolations(child, `${path}.properties.${name}`))
      }
    }
  }

  if (record.items !== undefined) {
    violations.push(...findSchemaViolations(record.items, `${path}.items`))
  }

  if (record.oneOf !== undefined) {
    if (!Array.isArray(record.oneOf) || record.oneOf.length === 0) {
      violations.push(`${path}.oneOf: must be a non-empty array`)
    } else {
      record.oneOf.forEach((child, index) => {
        violations.push(...findSchemaViolations(child, `${path}.oneOf[${index}]`))
      })
    }
  }

  if (record.required !== undefined) {
    if (!Array.isArray(record.required) || record.required.some((item) => typeof item !== 'string')) {
      violations.push(`${path}.required: must be a string array`)
    }
  }

  if (record.additionalProperties !== undefined && typeof record.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties: must be a boolean`)
  }

  if (record.enum !== undefined && (!Array.isArray(record.enum) || record.enum.length === 0)) {
    violations.push(`${path}.enum: must be a non-empty array`)
  }

  return violations
}
