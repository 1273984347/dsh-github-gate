/**
 * Post-swap consistency check for the installed profile.
 *
 * ## Why this exists
 *
 * Installing this plugin is not atomic. Measured, on 2026-10-15: `remove_bundle`
 * succeeded and `install_bundle` then failed with
 *
 *     [EPERM] EPERM: operation not permitted, rename
 *     '…\profiles\desktop\package.json.2067520508' -> '…\profiles\desktop\package.json'
 *
 * pnpm could not rename over the manifest because the running app held it open. The
 * result was a profile that had the plugin REMOVED and not re-added — a state
 * nothing reported, and which would have silently dropped every `github_*` tool on
 * the next restart. A retry fixed it, but nothing told anyone a retry was needed.
 *
 * This script is that missing check. Run it after any install or removal, and after
 * a failed one especially: it compares the three places the truth lives — the
 * profile manifest, the bundle list, and the bytes actually on disk.
 *
 * Usage:
 *   node tools/check-profile.mjs                  # uses DSH_PROFILE_DIR
 *   node tools/check-profile.mjs --profile <dir>  # an explicit profile
 *   node tools/check-profile.mjs --expect <ver>   # also require a version
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PACKAGE = 'dsh-github-gate'

/** Read one CLI flag's value. */
function flag(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : undefined
}

const profileDir = resolve(
  flag('--profile')
  ?? process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'profiles', 'desktop'),
)
const expected = flag('--expect')

const results = []
/**
 * Record one check.
 * @param {boolean} ok whether it passed
 * @param {string} name the check name
 * @param {string} detail evidence
 */
function check(ok, name, detail = '') {
  results.push({ ok, name, detail })
}

if (!existsSync(profileDir)) {
  console.log(`FAIL  the profile exists: ${profileDir}`)
  process.exitCode = 1
  console.log('\n=== 0/1 passed ===')
  process.exit(1)
}
console.log(`profile: ${profileDir}\n`)

/** The profile manifest, or null when it cannot be read. */
let manifest = null
try {
  manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
} catch (error) {
  check(false, 'the profile manifest parses', String(error?.message ?? error))
}

if (manifest !== null) {
  const dependency = manifest.dependencies?.[PACKAGE]
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const installedAt = join(profileDir, 'node_modules', PACKAGE, 'package.json')

  // 1. The three places must agree. A tarball dependency is how the plugin_manager
  //    records what it installed; the bundle list is what actually loads it.
  check(typeof dependency === 'string' && dependency !== '',
    'the manifest declares the dependency',
    dependency ?? 'MISSING — a failed swap leaves the plugin removed')
  check(bundles.includes(PACKAGE),
    'the bundle list includes it',
    bundles.includes(PACKAGE) ? PACKAGE : `MISSING (bundles: ${bundles.join(', ') || 'none'})`)
  check(existsSync(installedAt),
    'the package is on disk',
    existsSync(installedAt) ? installedAt : `MISSING at ${installedAt}`)

  // 2. The dependency must point at the artifact that was just built, not at a
  //    stale tarball left behind by an earlier version.
  if (typeof dependency === 'string') {
    const file = dependency.replace(/^file:/, '')
    check(existsSync(file), 'the declared tarball exists', file)
    const onDisk = existsSync(installedAt)
      ? JSON.parse(readFileSync(installedAt, 'utf8')).version
      : null
    const fromTarball = /dsh-github-gate-(.+)\.tgz$/.exec(file)?.[1]
    check(onDisk !== null && fromTarball !== undefined && onDisk === fromTarball,
      'the installed version matches the declared tarball',
      onDisk === null ? 'no package on disk' : `disk ${onDisk} vs tarball ${fromTarball}`)
    if (expected !== undefined) {
      check(onDisk === expected, `the installed version is ${expected}`, String(onDisk))
    }
  }

  // 3. Leftovers from a failed rename are harmless but signal that a swap was
  //    interrupted, which is worth reporting rather than deleting silently.
  const leftovers = existsSync(profileDir)
    ? readdirSync(profileDir).filter((name) => /^package\.json\.\d+$/.test(name))
    : []
  check(leftovers.length === 0, 'no interrupted-rename leftovers',
    leftovers.length === 0 ? 'none' : `${leftovers.join(', ')} — an install was interrupted`)

  // 4. A freshly installed generation needs a restart to load. The app's start
  //    time versus the package's mtime answers "am I looking at the new code?",
  //    which previously took two restart cycles to establish.
  if (existsSync(installedAt)) {
    console.log(`note: the installed package was written ${new Date(statSync(installedAt).mtimeMs).toISOString()}`)
  }
  console.log('note: a REPLACED package needs an app restart to load; a new bundle may activate via HMR')
}

const failed = results.filter((r) => !r.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  if (item.detail !== '') console.log(`      ${item.detail}`)
}
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  console.log('\nan interrupted swap leaves the plugin REMOVED. Re-run install_bundle, and')
  console.log('retry once if pnpm reports EPERM on package.json.')
  process.exitCode = 1
}
