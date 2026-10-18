/**
 * The installed copy against the source tree.
 *
 * ## The gap this closes
 *
 * On 2026-10-16 the source tree said `0.9.6` while the profile had `0.9.5` installed, and
 * **nothing in the project could tell.** `check-profile.mjs` compares the installed version
 * against the TARBALL FILENAME it is declared from — so `…-1.0.2.tgz` containing a package
 * that claims to be `1.0.1` passes, and a source tree two edits ahead of the profile passes
 * too. The mismatch was found by an independent auditor reading `package.json` in both
 * places by hand.
 *
 * ## Why it is not simply "diff every file"
 *
 * `lib/`, `skills/` and the entry points are the plugin. `tools/`, `test/` and the
 * development docs are not shipped, so a difference there is expected and meaningless. The
 * comparison therefore walks what `manifest.files` says ships, and reports:
 *
 * - **missing** — shipped by the source, absent from the profile (the file never installed)
 * - **different** — present in both, different bytes (the profile is behind, or ahead)
 * - **extra** — in the profile, not in the source (a leftover from an earlier version)
 *
 * ## What it does NOT catch, stated because a guard must
 *
 * It compares FILES. It cannot tell whether the running process loaded them —
 * that is the P-25 defect class, where every file was correct and the live composition
 * served an older generation. A hash comparison has nothing to say about a process that
 * started before the files changed. Use the diagnostics route or the skill tool for that.
 *
 * Usage:
 *   node tools/compare-installed.mjs
 *   node tools/compare-installed.mjs --json
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the profile keeps installed bundles, derived the way the Host derives it. */
function profileRoot() {
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
    return process.env.DSH_PROFILE_DIR
  }
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const installed = join(profileRoot(), 'node_modules', manifest.name)

if (!existsSync(installed)) {
  console.log(`not installed: ${installed}`)
  console.log('')
  console.log('This is not a failure of the source tree — the package simply is not in this')
  console.log('profile. Install it, or point DSH_PROFILE_DIR at the profile that has it.')
  process.exitCode = 0
  process.exit(0)
}

/**
 * Every file `manifest.files` says ships, relative to a root.
 *
 * @param {string} base the package root
 * @returns {string[]} relative paths, posix separators
 */
function shipped(base) {
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(relative(base, full).split('\\').join('/'))
    }
  }
  for (const entry of manifest.files ?? []) {
    if (entry.includes('*')) {
      // A glob entry: expand its directory, which is what npm does.
      const [dir] = entry.split('/')
      walk(join(base, dir))
      continue
    }
    const full = join(base, entry)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) walk(full)
    else out.push(entry.split('\\').join('/'))
  }
  return [...new Set(out)].sort()
}

/**
 * The sha256 of a file, or '' when it cannot be read.
 *
 * @param {string} path the file
 * @returns {string} the digest
 */
function hash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

const sourceFiles = shipped(ROOT)
const installedFiles = shipped(installed)

const missing = sourceFiles.filter((file) => !installedFiles.includes(file))
const extra = installedFiles.filter((file) => !sourceFiles.includes(file))
const different = []
for (const file of sourceFiles) {
  if (!installedFiles.includes(file)) continue
  const a = hash(join(ROOT, file))
  const b = hash(join(installed, file))
  if (a !== b) different.push({ file, source: a.slice(0, 12), installed: b.slice(0, 12) })
}

const sourceVersion = manifest.version
let installedVersion = '?'
try {
  installedVersion = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version
} catch {
  installedVersion = 'unreadable'
}

const report = {
  source: { path: ROOT, version: sourceVersion, files: sourceFiles.length },
  installed: { path: installed, version: installedVersion, files: installedFiles.length },
  versionsMatch: sourceVersion === installedVersion,
  missing,
  extra,
  different,
  identical: different.length === 0 && missing.length === 0 && extra.length === 0,
  limitation: 'compares FILES only; it cannot report whether the running process loaded them',
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const problems = missing.length + extra.length + different.length
  console.log(`source    ${sourceVersion}  ${sourceFiles.length} shipped file(s)`)
  console.log(`installed ${installedVersion}  ${installedFiles.length} shipped file(s)`)
  console.log(`          ${installed}`)
  console.log('')
  if (sourceVersion !== installedVersion) {
    console.log(`VERSION   source ${sourceVersion} vs installed ${installedVersion}`)
  }
  for (const file of missing) console.log(`MISSING   ${file}`)
  for (const file of extra) console.log(`EXTRA     ${file}`)
  for (const entry of different) {
    console.log(`DIFFERENT ${entry.file}`)
    console.log(`          source ${entry.source}  installed ${entry.installed}`)
  }
  if (problems === 0 && sourceVersion === installedVersion) {
    console.log('identical: the installed copy matches the source tree byte for byte')
  } else if (problems === 0) {
    console.log('')
    console.log('The file sets match, but the version strings do not. That is a real state —')
    console.log('a rebuilt tarball with no source change — and worth saying rather than hiding.')
  }
  console.log('')
  console.log(`note: ${report.limitation}`)
}
process.exitCode = report.identical && report.versionsMatch ? 0 : 1
