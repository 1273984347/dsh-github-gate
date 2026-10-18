/**
 * Ensure the vendored dsh packages exist before the offline suite runs.
 *
 * The plugin imports `@deepseek-ai/schemastery` (Config schema) and
 * `@deepseek-ai/dsh-tools` (defineTool). Inside the Harness those resolve
 * through the runtime resolution the launcher installs on Node's resolvers,
 * which a standalone `node` run cannot see, so the tests resolve them from a
 * vendored reconstruction instead.
 *
 * The vendor step is idempotent and cheap (about a second), and re-runs whenever
 * the vendored copy is missing. It needs the dsh installation's `app.asar`,
 * discovered from `DSH_INSTALL_ASAR` or the default desktop location; when
 * neither exists the tests cannot run faithfully, so this fails loudly instead
 * of letting the suite silently skip the real libraries.
 *
 * Usage: node tools/ensure-vendor.mjs
 */

import { existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorModules = join(root, 'test', '.vendor', 'node_modules')

/** Packages the offline suite resolves from the vendor tree. */
const ROOTS = [
  '/dsh/node_modules/@deepseek-ai/dsh-tools',
  '/dsh/node_modules/@deepseek-ai/schemastery',
]

/** Markers proving a previous vendoring covered both roots. */
const MARKERS = [
  join(vendorModules, '@deepseek-ai', 'dsh-tools', 'package.json'),
  join(vendorModules, '@deepseek-ai', 'schemastery', 'package.json'),
]

if (MARKERS.every((marker) => existsSync(marker))) {
  console.log('vendor: already present')
  process.exit(0)
}

/** Candidate installation archives, in preference order. */
const candidates = [
  process.env.DSH_INSTALL_ASAR,
  'D:\\DeepSeek Harness\\app\\resources\\app.asar',
].filter((value) => typeof value === 'string' && value !== '')

const archive = candidates.find((candidate) => existsSync(candidate))
if (archive === undefined) {
  console.error(
    'vendor: the dsh installation app.asar was not found.\n' +
      'Set DSH_INSTALL_ASAR to its path, or skip the offline suite. The tests\n' +
      'deliberately do not stub @deepseek-ai/* — a stub would test the stub.',
  )
  process.exit(1)
}
if (statSync(archive).isDirectory()) {
  console.error(`vendor: DSH_INSTALL_ASAR must point at app.asar, not a directory: ${archive}`)
  process.exit(1)
}

console.log(`vendor: extracting from ${archive}`)
execFileSync(process.execPath, [
  join(root, 'tools', 'asar-vendor.mjs'),
  archive,
  vendorModules,
  ...ROOTS,
], { stdio: 'inherit' })

const missing = MARKERS.filter((marker) => !existsSync(marker))
if (missing.length > 0) {
  console.error(`vendor: extraction did not produce ${missing.join(', ')}`)
  process.exit(1)
}
console.log('vendor: ready')
