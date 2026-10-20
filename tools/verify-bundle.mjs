/**
 * The DYNAMIC pre-delivery checks: the ones that must load the plugin.
 *
 * ## Why this file is small now
 *
 * It used to be 569 lines holding both the static tree checks and these. The static
 * half needs nothing but the tree, but it lived here — and this file imports
 * `index.js`, which imports `@deepseek-ai/*` packages a CI runner does not have. So
 * CI skipped the whole file, including the packaging checks that caught three real
 * omissions (`install.ps1`/`install.sh`, `PRIVACY.md`, `docs/roadmap.md` would each
 * have been left out of the tarball while CI stayed green).
 *
 * The split follows the dependency line, not the topic line:
 *
 * - `tools/verify-manifest.mjs` — imports only Node builtins; runs everywhere,
 *   including CI, and owns every static check.
 * - this file — imports the plugin entry and the tool registry; runs where a DSH
 *   installation exists, and reports `UNVERIFIED` rather than `PASS` where it cannot.
 *
 * There is exactly one implementation of each static check, and it lives in the half
 * that can always run.
 *
 * Usage: node --import ./test/register-hook.mjs tools/verify-bundle.mjs
 *
 * @module tools/verify-bundle
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { Reporter, printResults, finish } from './lib/report.mjs'
import { verifyManifest, walk } from './verify-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reporter = new Reporter()

const RUNTIME_CANDIDATES = [
  process.env.DSH_INSTALL_ASAR?.replace(/app\.asar.*$/i, 'app.asar'),
  'D:\\DeepSeek Harness\\app\\resources\\app.asar',
].filter((value) => typeof value === 'string' && value !== '')

/** Where a semver implementation might be. Named so a skip can say what it tried. */
const SEMVER_CANDIDATES = [
  process.env.DSH_SEMVER_PATH,
  'C:\\Program Files\\nodejs\\node_modules\\npm\\node_modules\\semver',
].filter((value) => typeof value === 'string' && value !== '')

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Static half: delegate, so there is one implementation.
// ---------------------------------------------------------------------------
const staticResults = verifyManifest(root)
reporter.results.push(...staticResults.results)

// ---------------------------------------------------------------------------
// Dynamic half.
// ---------------------------------------------------------------------------

// D1. Each gate-checked dsh peer range must admit the RUNNING runtime, or
// `evaluatePluginCompatibility` records an incompatible peer and the install asks for
// an exact-version exemption.
const runtimeVersion = readRuntimeVersion()
if (runtimeVersion === undefined) {
  // NOT a pass. This line once reported PASS when the runtime version was
  // undiscoverable, which made the guard green without having looked; an audit found
  // it by renaming the hard-coded path and watching the line stay green.
  reporter.unverified('peer ranges vs the running runtime',
    'the DSH runtime version was not discoverable, so the peer ranges were NOT compared.\n'
    + `      Tried: ${RUNTIME_CANDIDATES.join(', ')}`)
} else {
  const semver = loadSemver()
  if (semver === null) {
    reporter.unverified('peer ranges vs the running runtime',
      `the runtime version is ${runtimeVersion} but no semver implementation was available `
      + 'to compare it against, so the ranges were NOT compared.\n'
      + `      Tried: ${SEMVER_CANDIDATES.join(', ')}`)
  } else {
    // Mirrors evaluatePluginCompatibility: only `@deepseek-ai/dsh` and
    // `@deepseek-ai/dsh-*` are gate-checked, with includePrerelease.
    const peers = manifest.peerDependencies ?? {}
    const gated = Object.entries(peers).filter(([name]) =>
      name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    const blocked = gated.filter(([, range]) =>
      !semver.satisfies(runtimeVersion, range, { includePrerelease: true }))
    reporter.check(blocked.length === 0,
      `every gate-checked peer range admits dsh ${runtimeVersion}`,
      blocked.length === 0
        ? gated.map(([name, range]) => `${name}@${range}`).join(', ')
        : blocked.map(([name, range]) => `${name}@${range} rejects ${runtimeVersion}`).join('; '))
  }
}

// D2. The plugin entry exports the documented shape.
const entry = await import(`file:///${join(root, 'index.js').replaceAll('\\', '/')}`)
reporter.check(typeof entry.apply === 'function', 'entry exports apply()', typeof entry.apply)
reporter.check(entry.name === 'github-gate', 'entry exports name', String(entry.name))
reporter.check(Array.isArray(entry.inject) && entry.inject.includes('tools'),
  'entry injects the tools service', JSON.stringify(entry.inject))
reporter.check(entry.default === undefined,
  'entry has no default export (the Loader drops inject on default exports)', String(entry.default))
reporter.check(entry.Config !== undefined && typeof entry.Config['~standard']?.validate === 'function',
  'entry exports a Standard Schema Config', typeof entry.Config)

// D3. defineTool conformance: the capabilities the official reference documents and
// the shipped plugins use must be declared by every registered tool. A missing
// presenter degrades to the generic card; a missing concurrency predicate serialises
// every call.
const { makeContext, makeRunner, testConfig } = await import('../test/helpers.mjs')
const { registerDomainTools } = await import('../lib/registry.js')
const probeContext = makeContext()
const probeRunner = makeRunner()
registerDomainTools(probeContext.ctx, testConfig(), probeRunner.runner)
const missingCapabilities = []
for (const [toolName, definition] of probeContext.tools) {
  if (typeof definition.presentCall !== 'function') missingCapabilities.push(`${toolName}.presentCall`)
  if (typeof definition.presentResult !== 'function') missingCapabilities.push(`${toolName}.presentResult`)
  if (typeof definition.isConcurrencySafe !== 'function') missingCapabilities.push(`${toolName}.isConcurrencySafe`)
  if (typeof definition.output?.presentationMeta !== 'function') missingCapabilities.push(`${toolName}.presentationMeta`)
}
reporter.check(missingCapabilities.length === 0,
  `every registered tool declares the official presentation and concurrency hooks (${probeContext.tools.size} tools)`,
  missingCapabilities.join('; '))

// D4. A declared `run_in_background` parameter must be backed by a real branch: a
// parameter the model can pass but nothing honours is worse than no parameter.
const backgroundTools = [...probeContext.tools.entries()]
  .filter(([, definition]) => 'run_in_background' in (definition.parameters.properties ?? {}))
const unbacked = backgroundTools
  .filter(([, definition]) => !definition.description.includes('Actions:'))
  .map(([name]) => name)
reporter.check(unbacked.length === 0,
  `run_in_background is declared on long-action tools only (${backgroundTools.map(([name]) => name).join(', ') || 'none'})`,
  unbacked.join('; '))

// Reported for the record, not asserted.
const scripts = walk(root).filter((file) => /\.(js|mjs)$/.test(file))
const total = scripts.reduce((sum, file) => sum + readFileSync(file, 'utf8').split('\n').length, 0)
console.log(`\nmodules: ${scripts.length}, total lines: ${total}`)

printResults(reporter.results)
finish(reporter.results)

/**
 * Read the running dsh runtime version from the installation manifest.
 * @returns {string | undefined} the version, when discoverable
 */
function readRuntimeVersion() {
  for (const archive of RUNTIME_CANDIDATES) {
    if (!existsSync(archive)) continue
    try {
      execFileSync(process.execPath, [
        join(root, 'tools', 'asar-extract.mjs'),
        archive,
        '/dsh/package.json',
        join(root, 'test', '.vendor', 'dsh-runtime-package.json'),
      ], { stdio: 'pipe', encoding: 'utf8' })
      const parsed = JSON.parse(readFileSync(join(root, 'test', '.vendor', 'dsh-runtime-package.json'), 'utf8'))
      if (typeof parsed.version === 'string') return parsed.version
    } catch { /* fall through to the next candidate */ }
  }
  return undefined
}

/**
 * Locate a semver implementation to evaluate peer ranges with.
 * @returns {any | null} the module, or null when unavailable
 */
function loadSemver() {
  for (const candidate of SEMVER_CANDIDATES) {
    if (!existsSync(candidate)) continue
    try {
      const require = createRequire(import.meta.url)
      return require(candidate)
    } catch { /* try the next candidate */ }
  }
  return null
}
