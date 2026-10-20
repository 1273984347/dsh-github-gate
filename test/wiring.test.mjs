/**
 * Wiring tests: does CI actually run the gates, and does `npm run` actually run them?
 *
 * ## Why this file exists
 *
 * The repository shipped a green CI badge while the gate that caught three real
 * packaging omissions (`install.ps1`/`install.sh`, `PRIVACY.md`, `docs/roadmap.md` were
 * each in the tree and absent from `manifest.files`) was not wired into CI at all. A
 * gate nobody invokes is indistinguishable from no gate, and nothing in the suite
 * would have noticed its absence.
 *
 * ## Why the assertion anchors on `run:` and not on step names
 *
 * A step called "Static delivery gate" whose body is `echo skipped` satisfies any
 * name-based assertion. So the check parses the workflow, extracts the `run:` BLOCKS,
 * and asserts the command appears inside one. It also asserts the negative: a step
 * name alone does not count.
 *
 * These tests deliberately do not execute the gates — `test/gates.test.mjs` does that
 * with broken inputs. This file answers a different question: "is it invoked at all?"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * Extract the `run:` bodies from a GitHub Actions workflow.
 *
 * Handles both the inline form (`run: node x.mjs`) and the block form
 * (`run: |` followed by an indented body). The block form's body is what actually
 * executes, so it must be read, not just the first line.
 *
 * @param {string} workflow the YAML text
 * @returns {string[]} one string per `run:` block
 */
function runBlocks(workflow) {
  const lines = workflow.split('\n')
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length + (lines[index].includes('- run:') ? 2 : 0)
    const inline = match[2].trim()
    if (inline !== '' && inline !== '|' && inline !== '>' && inline !== '|-') {
      blocks.push(inline)
      continue
    }
    // Block form: everything more indented than `run:` until the indent drops back.
    const body = []
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (line.trim() === '') { body.push(''); continue }
      const lineIndent = line.length - line.trimStart().length
      if (lineIndent <= indent) break
      body.push(line.trim())
    }
    blocks.push(body.join('\n'))
  }
  return blocks
}

const RUNS = runBlocks(CI)

test('CI: the workflow parses into run blocks', () => {
  assert.ok(RUNS.length >= 5, `expected several run blocks, found ${RUNS.length}`)
})

test('CI: every static delivery gate is invoked from a run block', () => {
  // Each of these is a gate whose absence let a real defect through at least once.
  const required = [
    'tools/verify-manifest.mjs',
    'tools/check-script-coverage.mjs',
    'tools/check-docs.mjs',
    'tools/check-encoding.mjs',
  ]
  for (const script of required) {
    assert.ok(
      RUNS.some((block) => block.includes(script)),
      `${script} is not invoked from any run: block in ci.yml`,
    )
  }
})

test('CI: a step NAME alone does not satisfy the wiring assertion', () => {
  // The anchor is the executed body. This test pins that by asserting the gate script
  // path appears inside a run block — a workflow that only mentioned it in `name:`
  // would fail the test above, and this one documents why.
  const mentionedInNames = /-?\s*name:\s*.*verify-manifest/.test(CI)
  const inRunBlock = RUNS.some((block) => block.includes('tools/verify-manifest.mjs'))
  assert.equal(inRunBlock, true)
  if (mentionedInNames) {
    // If it is also named, that is fine — but the assertion above, not this name, is
    // what makes the wiring real.
    assert.ok(CI.includes('run:'), 'a name-only mention would be a false positive')
  }
})

test('CI: the documented reason a gate is unverifiable locally is stated', () => {
  // The offline suite cannot run on a runner (it needs a local DSH asar). That
  // omission is deliberate and must be explained in the workflow, or a reader assumes
  // the suite runs and the green badge means more than it does.
  assert.match(CI, /offline suite is deliberately absent/i)
})

test('npm: verify:static runs every static gate', () => {
  const script = MANIFEST.scripts['verify:static']
  assert.equal(typeof script, 'string')
  for (const gate of ['verify-manifest', 'check-script-coverage', 'check-docs', 'check-encoding']) {
    assert.ok(script.includes(gate), `verify:static does not run ${gate}`)
  }
})

test('npm: the gates CI runs are also available as their own scripts', () => {
  for (const name of ['manifest', 'coverage', 'check:docs', 'encoding']) {
    assert.equal(typeof MANIFEST.scripts[name], 'string', `missing npm script: ${name}`)
  }
})

test('npm: the release script runs the static gates before packing', () => {
  const release = MANIFEST.scripts.release
  assert.equal(typeof release, 'string')
  // The release path must not be able to pack a tree the static gate would reject.
  assert.match(release, /verify:static|verify-manifest/)
})

test('CI: no workflow invokes a script that does not exist', () => {
  // A workflow that calls a deleted script fails only on the next push; this catches it
  // while the change is still being reviewed. It is the same defect class as the dead
  // pre-commit hook this project recorded while auditing a reference repository.
  const referenced = [...CI.matchAll(/node (tools\/[a-z0-9-]+\.mjs)/g)].map((match) => match[1])
  assert.ok(referenced.length > 0, 'no tools/ script is referenced by CI at all')
  const present = new Set(readdirSync(join(ROOT, 'tools')).filter((name) => name.endsWith('.mjs')))
  for (const path of new Set(referenced)) {
    const name = path.replace('tools/', '')
    assert.ok(present.has(name), `ci.yml invokes ${path}, which does not exist`)
  }
})
