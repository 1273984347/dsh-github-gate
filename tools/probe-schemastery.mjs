/**
 * Exercise the schemastery 3.18.4 API that this plugin's Config schema uses.
 *
 * Every fact here was learned by running the library, and each one would
 * otherwise surface as a load-time failure with a confusing message:
 *
 * 1. **`schema.parse()` does not exist in 3.18.4.** Several call sites inside
 *    the dsh install look like `schema.parse(...)`, but they belong to
 *    schemastery's own source/test files. The real entry is the Standard Schema
 *    symbol: `schema['~standard'].validate(input)`, returning `{ value }` or
 *    `{ issues }`.
 * 2. **Defaults are applied per field by `validate`.** That is what makes an
 *    empty `config: {}` row valid.
 * 3. **`.default(fn)` stores the FUNCTION, not its result.** A factory is then
 *    rejected by the field's own type check, so the Config uses literal
 *    defaults everywhere.
 * 4. **A `.pattern()` must accept the field's own default.** The plugin's
 *    `defaultRepo` defaults to `''` meaning "detect from the workspace remote",
 *    so its pattern must admit the empty string — a pattern written only for
 *    `owner/repo` makes an empty row fail validation at activation.
 * 5. **`dict(String)` requires string values.**
 *
 * Verification note: this proves the library's API shape against the copy dsh
 * actually ships. It does NOT prove the import resolves inside the Harness —
 * that is decided by the plugin's `peerDependencies` and is verified by
 * activating the real plugin.
 */

import { pathToFileURL } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve against the vendored copy that `npm run vendor` produces, so this
// probe needs no separate extraction step and always tests the same bytes the
// offline suite uses.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'test', '.vendor', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
const module = await import(pathToFileURL(target).href)
const Schema = module.default

/** @type {string[]} */
const checks = []
/**
 * @param {string} label what is being checked
 * @param {() => void} fn the assertion body
 */
const check = (label, fn) => {
  try {
    fn()
    checks.push(`PASS  ${label}`)
  } catch (error) {
    checks.push(`FAIL  ${label}: ${String(error?.message ?? error)}`)
  }
}

/** Validate through the Standard Schema symbol. @returns {any} */
const validate = (schema, input) => schema['~standard'].validate(input)

check('the Standard Schema symbol is the entry point (there is no schema.parse)', () => {
  const schema = Schema.object({ a: Schema.string() })
  const std = schema['~standard']
  if (typeof std !== 'object' || std === null) throw new Error('missing ~standard')
  if (typeof std.validate !== 'function') throw new Error('~standard.validate is not a function')
  if (typeof schema.parse === 'function') throw new Error('unexpected: schema.parse now exists — re-check the docs')
})

check('validate() applies defaults for absent keys', () => {
  const schema = Schema.object({
    timeoutMs: Schema.natural().min(1_000).max(600_000).default(60_000),
    allowRawApi: Schema.boolean().default(true),
  })
  const result = validate(schema, {})
  if (result.value?.timeoutMs !== 60_000) throw new Error(`timeoutMs=${JSON.stringify(result.value?.timeoutMs)}`)
  if (result.value?.allowRawApi !== true) throw new Error(`allowRawApi=${JSON.stringify(result.value?.allowRawApi)}`)
})

check('min/max bounds reject out-of-range numbers', () => {
  const schema = Schema.object({
    maxOutputBytes: Schema.natural().min(1_024).max(1_000_000).default(65_536),
  })
  for (const bad of [0, -1, 1_000_001]) {
    const result = validate(schema, { maxOutputBytes: bad })
    if (result.issues === undefined || result.issues.length === 0) throw new Error(`${bad} was accepted`)
  }
})

check('dict(String) accepts a string map and rejects a non-string value', () => {
  const schema = Schema.object({ env: Schema.dict(String).default({}) })
  const ok = validate(schema, { env: { GH_HOST: 'github.com' } })
  if (ok.value?.env?.GH_HOST !== 'github.com') throw new Error('a string map was rejected')
  const bad = validate(schema, { env: { A: 1 } })
  if (bad.issues === undefined || bad.issues.length === 0) throw new Error('a non-string value was accepted')
})

check('`.default(fn)` stores the FUNCTION, not its result — the factory trap', () => {
  // This is why the Config gives every field its own literal default: a factory
  // is stored as the value, then fails its own type check, so the whole row is
  // rejected.
  const schema = Schema.object({ env: Schema.dict(String).default(() => ({ a: 'x' })) })
  const result = validate(schema, {})
  if (result.issues === undefined || result.issues.length === 0) {
    throw new Error(`expected rejection, got ${JSON.stringify(result.value)}`)
  }
  // A literal default is what actually works.
  const literal = Schema.object({ env: Schema.dict(String).default({ a: 'x' }) })
  const ok = validate(literal, {})
  if (ok.issues !== undefined) throw new Error(`a literal default failed: ${JSON.stringify(ok.issues)}`)
  if (ok.value?.env?.a !== 'x') throw new Error(`a literal default did not apply: ${JSON.stringify(ok.value?.env)}`)
})

check('a `.pattern()` must accept the field\'s own default', () => {
  // The plugin's defaultRepo defaults to '' meaning "detect from the workspace
  // remote". A pattern written only for owner/repo would make an empty
  // `config: {}` row fail validation at activation.
  const broken = Schema.object({ defaultRepo: Schema.string().pattern(/^[^\s/]+\/[^\s/]+$/).default('') })
  const brokenResult = validate(broken, {})
  if (brokenResult.issues === undefined || brokenResult.issues.length === 0) {
    throw new Error('a pattern that rejects its own default was accepted')
  }
  const fixed = Schema.object({ defaultRepo: Schema.string().pattern(/^$|^[^\s/]+\/[^\s/]+$/).default('') })
  const fixedResult = validate(fixed, {})
  if (fixedResult.issues !== undefined) throw new Error(`the fixed pattern still failed: ${JSON.stringify(fixedResult.issues)}`)
  if (fixedResult.value?.defaultRepo !== '') throw new Error('the empty default did not survive')
  const bad = validate(fixed, { defaultRepo: 'not-a-repo' })
  if (bad.issues === undefined || bad.issues.length === 0) throw new Error('a malformed repo was accepted')
})

console.log(checks.join('\n'))
const failed = checks.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
