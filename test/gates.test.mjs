/**
 * Proof that each gate can go red.
 *
 * ## Why every gate needs a negative sample
 *
 * A check is a claim about what it forbids. Copying a tree, breaking exactly the thing
 * a check is for, and asserting the check reports it is the only way to distinguish a
 * working gate from a gate that always passes. This project already has one recorded
 * failure of that shape: the peer-range check reported PASS while it could not read the
 * runtime version, and an audit found it by renaming the hard-coded path and watching
 * the line stay green.
 *
 * Two rules the tests follow:
 *
 * 1. **Build the broken input, do not describe it.** Each test writes a real temporary
 *    tree (or a real string) that is wrong in exactly one way.
 * 2. **Assert the STATE, not the exit code.** `check()` is pure and returns results, so
 *    a test can name the check that must fail. Asserting only "the process exited 1"
 *    would pass when the wrong check failed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyManifest } from '../tools/verify-manifest.mjs'
import { checkScriptCoverage } from '../tools/check-script-coverage.mjs'
import { checkDocs, findMarkers } from '../tools/check-docs.mjs'
import { Reporter, PASS, FAIL, UNVERIFIED } from '../tools/lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * Create a temporary package tree cloned from this one, then hand it to the caller to
 * break. Only the files a gate needs are copied, so a run stays fast.
 * @returns {{ dir: string, dispose: () => void }} the tree
 */
function cloneTree() {
  const dir = mkdtempSync(join(tmpdir(), 'ghg-gate-'))
  const copy = (relative) => {
    const target = join(dir, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(ROOT, relative)))
  }
  for (const relative of ['package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'LICENSE', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'icon.svg']) {
    copy(relative)
  }
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Whether a named check failed.
 * @param {Reporter} reporter the collected results
 * @param {string} fragment text the check label must contain
 * @returns {boolean} true when that check reported a failure
 */
function failedNamed(reporter, fragment) {
  return reporter.results.some((result) => result.state === FAIL && result.label.includes(fragment))
}

// ---------------------------------------------------------------------------
// The reporter itself
// ---------------------------------------------------------------------------

test('report: a check that could not run is neither a pass nor a failure', () => {
  const reporter = new Reporter()
  reporter.unverified('something', 'could not look')
  assert.equal(reporter.results[0].state, UNVERIFIED)
  assert.equal(reporter.failureCount, 0, 'unverified must not fail the gate')
  assert.equal(reporter.passCount, 0, 'unverified must never be counted as a pass')
  assert.equal(reporter.ok, true)
})

test('report: a failure makes the reporter not ok', () => {
  const reporter = new Reporter()
  reporter.check(false, 'thing', 'broken')
  assert.equal(reporter.failureCount, 1)
  assert.equal(reporter.ok, false)
})

// ---------------------------------------------------------------------------
// verify-manifest
// ---------------------------------------------------------------------------

test('verify-manifest: a file present in the tree but absent from manifest.files fails', () => {
  const tree = cloneTree()
  try {
    // The defect that happened three times: written and tested, but never packed.
    writeFileSync(join(tree.dir, 'UNSHIPPED.md'), '# present but would not be packed\n')
    const reporter = verifyManifest(tree.dir)
    assert.equal(failedNamed(reporter, 'every top-level entry that should ship'), true,
      'a top-level file missing from manifest.files must be a failure')
  } finally {
    tree.dispose()
  }
})

test('verify-manifest: an unlisted file inside an enumerated directory fails', () => {
  const tree = cloneTree()
  try {
    // `docs/` is enumerated file by file in `files`, so a new file under it is invisible
    // to a top-level comparison — which is exactly how docs/roadmap.md nearly shipped
    // outside the tarball.
    mkdirSync(join(tree.dir, 'docs'), { recursive: true })
    writeFileSync(join(tree.dir, 'docs', 'NEW.md'), '# not in files\n')
    const reporter = verifyManifest(tree.dir)
    assert.equal(failedNamed(reporter, 'no file is left unpacked'), true,
      'a file inside an enumerated directory must be a failure when unlisted')
  } finally {
    tree.dispose()
  }
})

test('verify-manifest: a listed path that does not exist fails', () => {
  const tree = cloneTree()
  try {
    const manifest = JSON.parse(readFileSync(join(tree.dir, 'package.json'), 'utf8'))
    manifest.files.push('docs/does-not-exist.md')
    writeFileSync(join(tree.dir, 'package.json'), JSON.stringify(manifest, null, 2))
    const reporter = verifyManifest(tree.dir)
    assert.equal(failedNamed(reporter, 'every concrete path in manifest.files exists'), true)
  } finally {
    tree.dispose()
  }
})

test('verify-manifest: a relative import that resolves to nothing fails', () => {
  const tree = cloneTree()
  try {
    mkdirSync(join(tree.dir, 'lib'), { recursive: true })
    // The bad specifier is ASSEMBLED, not spelled out. This file is scanned by the very
    // gate under test, so a literal broken import here would be reported as a broken
    // import in the test suite — the gate is right, the fixture has to be built.
    const broken = ['import { x } from ', JSON.stringify(`./${'missing'}.js`), '\nexport const y = x\n'].join('')
    writeFileSync(join(tree.dir, 'lib', 'broken.js'), broken)
    const reporter = verifyManifest(tree.dir)
    assert.equal(failedNamed(reporter, 'every relative import resolves'), true)
  } finally {
    tree.dispose()
  }
})

test('verify-manifest: a directory where a module should be is reported differently from nothing', () => {
  const tree = cloneTree()
  try {
    mkdirSync(join(tree.dir, 'lib'), { recursive: true })
    // A DIRECTORY named like a module: existsSync is true, so an earlier version of this
    // check accepted it while the import failed the moment anything loaded it.
    mkdirSync(join(tree.dir, 'lib', 'shadow.js'), { recursive: true })
    writeFileSync(join(tree.dir, 'lib', 'shadow.js', 'keep.txt'), 'x')
    const broken = ['import { v } from ', JSON.stringify(`./${'shadow'}.js`), '\nexport const w = v\n'].join('')
    writeFileSync(join(tree.dir, 'lib', 'uses-shadow.js'), broken)
    const reporter = verifyManifest(tree.dir)
    const result = reporter.results.find((entry) => entry.label.includes('every relative import resolves'))
    assert.equal(result?.state, FAIL)
    assert.match(result?.detail ?? '', /exist but are not files/,
      'the report must say a directory is sitting there, because that needs a different fix')
  } finally {
    tree.dispose()
  }
})

test('verify-manifest: a client loader id that does not match the package name fails', () => {
  const tree = cloneTree()
  try {
    const client = readFileSync(join(tree.dir, 'client.js'), 'utf8')
    writeFileSync(join(tree.dir, 'client.js'), client.replace(/id:\s*'[^']+'/, "id: 'some-other-package'"))
    const reporter = verifyManifest(tree.dir)
    assert.equal(failedNamed(reporter, 'the client loader id equals the package name'), true)
  } finally {
    tree.dispose()
  }
})

test('verify-manifest: a comment that mentions styles.insert does not count as a call', () => {
  const tree = cloneTree()
  try {
    const client = readFileSync(join(tree.dir, 'client.js'), 'utf8')
    // The check must strip comments: this project has flagged its own prose five times.
    writeFileSync(join(tree.dir, 'client.js'), `${client}\n// This half must never call styles.insert(...)\n`)
    const reporter = verifyManifest(tree.dir)
    assert.equal(failedNamed(reporter, 'does not call styles.insert'), false,
      'a comment mentioning the call must not be read as the call')
  } finally {
    tree.dispose()
  }
})

// ---------------------------------------------------------------------------
// check-script-coverage
// ---------------------------------------------------------------------------

/**
 * Build a minimal tree for the coverage gate.
 * @param {{ script: string, baseline?: Record<string, string>, wireInCi?: boolean }} options what to plant
 * @returns {{ dir: string, dispose: () => void }} the tree
 */
function coverageTree({ script, baseline = {}, wireInCi = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'ghg-cov-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, 'tools', script), '// a script\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }, null, 2))
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'),
    wireInCi ? `jobs:\n  x:\n    steps:\n      - run: node tools/${script}\n` : 'jobs:\n  x:\n    steps:\n      - run: echo hi\n')
  writeFileSync(join(dir, 'docs', 'script-baseline.json'), JSON.stringify({ scripts: baseline }, null, 2))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('check-script-coverage: a script referenced by nothing fails', () => {
  const tree = coverageTree({ script: 'orphan.mjs' })
  try {
    const reporter = checkScriptCoverage(tree.dir)
    assert.equal(failedNamed(reporter, 'every tools/ script is reachable'), true)
  } finally {
    tree.dispose()
  }
})

test('check-script-coverage: a gate that never runs in CI fails', () => {
  const tree = coverageTree({ script: 'check-thing.mjs' })
  try {
    // Referenced from package.json, but never executed on push. That was the real state
    // of verify-bundle.mjs while CI stayed green.
    const manifest = JSON.parse(readFileSync(join(tree.dir, 'package.json'), 'utf8'))
    manifest.scripts.check = 'node tools/check-thing.mjs'
    writeFileSync(join(tree.dir, 'package.json'), JSON.stringify(manifest, null, 2))
    const reporter = checkScriptCoverage(tree.dir)
    assert.equal(failedNamed(reporter, 'every verify-*/check-* gate runs in CI'), true)
  } finally {
    tree.dispose()
  }
})

test('check-script-coverage: a written exemption makes the same gate pass', () => {
  const tree = coverageTree({
    script: 'check-thing.mjs',
    baseline: { 'check-thing.mjs': 'Needs a local DSH installation, so it cannot run on a CI runner at all.' },
  })
  try {
    const reporter = checkScriptCoverage(tree.dir)
    assert.equal(failedNamed(reporter, 'every verify-*/check-* gate runs in CI'), false)
  } finally {
    tree.dispose()
  }
})

test('check-script-coverage: a stale exemption fails when the gate now runs in CI', () => {
  const tree = coverageTree({
    script: 'check-thing.mjs',
    baseline: { 'check-thing.mjs': 'Needs a local DSH installation, so it cannot run on a CI runner at all.' },
    wireInCi: true,
  })
  try {
    const reporter = checkScriptCoverage(tree.dir)
    assert.equal(failedNamed(reporter, 'no stale entry'), true,
      'an exemption that is no longer needed must be removed, not left to rot')
  } finally {
    tree.dispose()
  }
})

test('check-script-coverage: an exemption without a real reason fails', () => {
  const tree = coverageTree({ script: 'orphan.mjs', baseline: { 'orphan.mjs': 'because' } })
  try {
    const reporter = checkScriptCoverage(tree.dir)
    assert.equal(failedNamed(reporter, 'every baseline exemption states a reason'), true)
  } finally {
    tree.dispose()
  }
})

test('check-script-coverage: a comment naming a script does not count as invoking it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghg-cov2-'))
  try {
    mkdirSync(join(dir, 'tools'), { recursive: true })
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'tools', 'check-thing.mjs'), '// a gate\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }, null, 2))
    writeFileSync(join(dir, 'docs', 'script-baseline.json'), JSON.stringify({ scripts: {} }, null, 2))
    // The workflow EXPLAINS that this gate cannot run here. Prose is not a reference —
    // the first version of the gate counted it as one and declared a correct exemption stale.
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  x:\n    steps:\n      # tools/check-thing.mjs is deliberately absent: needs a local DSH\n      - run: echo hi\n')
    const reporter = checkScriptCoverage(dir)
    // The honest outcome is "unreachable", not "wired": the comment must rescue nothing.
    assert.equal(failedNamed(reporter, 'every tools/ script is reachable'), true,
      'a comment mentioning the gate must not count as running it')
    assert.match(reporter.results.find((r) => r.state === FAIL)?.detail ?? '', /referenced by nothing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// check-docs
// ---------------------------------------------------------------------------

test('findMarkers: a claim is recognised and its number read', () => {
  const markers = findMarkers('We have 9<!--stats:tool_count--> tools.')
  assert.equal(markers.length, 1)
  assert.equal(markers[0].key, 'tool_count')
  assert.equal(markers[0].value, 9)
})

test('findMarkers: a marker inside a code span is not a claim', () => {
  // This gate reported its own documentation as a bad claim the first time it ran.
  const markers = findMarkers('Write it as `N<!--stats:tool_count-->` in prose.')
  assert.equal(markers.length, 1)
  assert.equal(markers[0].inCode, true)
})

test('check-docs: a claim that disagrees with stats.json fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghg-docs-'))
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'stats.json'), JSON.stringify({
      keys: { tool_count: { value: 9 } },
    }, null, 2))
    writeFileSync(join(dir, 'README.md'), 'We have 10<!--stats:tool_count--> tools.\n')
    writeFileSync(join(dir, 'README.zh.md'), '我们有 9<!--stats:tool_count--> 个工具。\n')
    const reporter = checkDocs(dir)
    assert.equal(failedNamed(reporter, 'every stats claim'), true)
    assert.match(reporter.results.find((r) => r.state === FAIL)?.detail ?? '', /claims 10 .* says 9/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-docs: a claim about a key that does not exist fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghg-docs2-'))
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'stats.json'), JSON.stringify({ keys: { tool_count: { value: 9 } } }, null, 2))
    writeFileSync(join(dir, 'README.md'), 'We have 9<!--stats:tool_cuont--> tools.\n')
    writeFileSync(join(dir, 'README.zh.md'), 'x\n')
    const reporter = checkDocs(dir)
    assert.equal(failedNamed(reporter, 'every stats claim'), true)
    assert.match(reporter.results.find((r) => r.state === FAIL)?.detail ?? '', /unknown key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-docs: a stat no document claims fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghg-docs3-'))
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'stats.json'), JSON.stringify({
      keys: { tool_count: { value: 9 }, unused_key: { value: 3 } },
    }, null, 2))
    writeFileSync(join(dir, 'README.md'), 'We have 9<!--stats:tool_count--> tools.\n')
    writeFileSync(join(dir, 'README.zh.md'), 'x\n')
    const reporter = checkDocs(dir)
    assert.equal(failedNamed(reporter, 'every key in docs/stats.json is claimed'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-docs: a claim with no number fails, because nothing can be verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghg-docs4-'))
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'stats.json'), JSON.stringify({ keys: { tool_count: { value: 9 } } }, null, 2))
    writeFileSync(join(dir, 'README.md'), 'We have <!--stats:tool_count--> tools.\n')
    writeFileSync(join(dir, 'README.zh.md'), 'x\n')
    const reporter = checkDocs(dir)
    assert.equal(failedNamed(reporter, 'every stats claim'), true)
    assert.match(reporter.results.find((r) => r.state === FAIL)?.detail ?? '', /no number/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-docs: a missing stats file is UNVERIFIED, not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghg-docs5-'))
  try {
    writeFileSync(join(dir, 'README.md'), '# nothing\n')
    writeFileSync(join(dir, 'README.zh.md'), '# nothing\n')
    const reporter = checkDocs(dir)
    assert.equal(reporter.results[0].state, UNVERIFIED)
    assert.equal(reporter.ok, true, 'unverified must not fail the build')
    assert.equal(reporter.passCount, 0, 'and must not pretend to be a pass either')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

test('gates: the shipped tree passes every gate', () => {
  const manifest = verifyManifest(ROOT)
  assert.equal(manifest.ok, true, `verify-manifest failed: ${manifest.results.filter((r) => r.state === FAIL).map((r) => r.label).join('; ')}`)

  const coverage = checkScriptCoverage(ROOT)
  assert.equal(coverage.ok, true, `check-script-coverage failed: ${coverage.results.filter((r) => r.state === FAIL).map((r) => `${r.label}: ${r.detail}`).join('; ')}`)

  const docs = checkDocs(ROOT)
  assert.equal(docs.ok, true, `check-docs failed: ${docs.results.filter((r) => r.state === FAIL).map((r) => `${r.label}: ${r.detail}`).join('; ')}`)
  assert.ok(docs.passCount >= 2, 'the real tree must actually carry verified claims, not merely avoid failures')
})
