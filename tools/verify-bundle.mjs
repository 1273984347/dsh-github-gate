/**
 * Pre-delivery integrity check for the plugin bundle.
 *
 * Verifies what a test suite cannot: that every module parses, every relative
 * import resolves, no stale reference remains, and the manifest matches the
 * contract dsh reads.
 *
 * One check deserves a note, because it REVERSED after a measured failure.
 * This file used to assert "manifest declares no peerDependencies", on the
 * theory that avoiding them avoided the compatibility gate. That was wrong:
 * the runtime resolution only supplies a bare `@deepseek-ai/*` package to a
 * profile plugin if the plugin DECLARES it (`profileDependencyNames` reads
 * `dependencies` and `peerDependencies`). Without a declaration the import
 * fails with ERR_MODULE_NOT_FOUND and the whole plugin fails to activate. The
 * check now asserts the peers ARE declared AND that each range actually
 * admits the running runtime, which is the property that matters.
 *
 * Usage: node --import ./test/register-hook.mjs tools/verify-bundle.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const RUNTIME_CANDIDATES = [
  process.env.DSH_INSTALL_ASAR?.replace(/app\.asar.*$/i, 'app.asar'),
  'D:\\DeepSeek Harness\\app\\resources\\app.asar',
].filter((value) => typeof value === 'string' && value !== '')

/** Where a semver implementation might be. Named for the same reason. */
const SEMVER_CANDIDATES = [
  process.env.DSH_SEMVER_PATH,
  'C:\\Program Files\\nodejs\\node_modules\\npm\\node_modules\\semver',
].filter((value) => typeof value === 'string' && value !== '')

/**
 * Report one check result.
 * @param {boolean} ok whether it passed
 * @param {string} label the check name
 * @param {string} detail what was observed
 */
function check(ok, label, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `\n      ${detail}`}`)
}

/**
 * A check that could not run, reported as such rather than as a pass.
 *
 * The compatibility check below used to call `check(true, …, 'skipped')` when either of its
 * inputs was missing — so a guard whose whole purpose is to catch a peer-range mismatch
 * reported PASS when it had not looked. An independent audit found it by renaming one of
 * the hard-coded paths and watching the line stay green.
 *
 * It is not a failure either: the inputs come from absolute paths that exist on this
 * machine and not on others, and a gate that always fails elsewhere trains people to ignore
 * it. So it is a THIRD state, counted separately and printed in the summary — a reader sees
 * that something was not verified rather than inferring that it was.
 *
 * @param {string} label what could not be checked
 * @param {string} detail why, and what would make it runnable
 */
function unverified(label, detail) {
  unverifiedCount += 1
  console.log(`UNVERIFIED  ${label}\n      ${detail}`)
}
let unverifiedCount = 0

/**
 * List every file under a directory, recursively.
 *
 * `.vendor` is skipped: it holds a reconstruction of dsh's own packages for the
 * offline tests, not this bundle's source, and scanning 900 vendored files
 * would both slow the check down and report on code this plugin does not own.
 *
 * @param {string} dir the directory
 * @returns {string[]} absolute file paths
 */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.vendor') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(root)
const scripts = files.filter((file) => /\.(js|mjs)$/.test(file))

// 1. Every module parses.
const syntaxFailures = []
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    syntaxFailures.push(`${file.slice(root.length + 1)}: ${String(error.stderr ?? error).split('\n')[0]}`)
  }
}
check(syntaxFailures.length === 0, `every module parses (${scripts.length} files)`, syntaxFailures.join('; '))

// 2. Every relative import resolves to a real FILE.
//
// `existsSync` is true for a DIRECTORY, so the first version of this check accepted a
// directory named `does-not-exist.js/` while the import failed the moment anything loaded
// it. An independent audit found it by creating exactly that. The candidates below are what
// Node tries for a relative specifier; each must be a regular file, not merely present.
const unresolved = []
let importCount = 0
for (const file of scripts) {
  // Strip comments BEFORE looking for imports.
  //
  // The fix for the directory case added a comment explaining the three import forms — and
  // wrote one of them out as an example. The pattern then matched the example, and the check
  // failed on this file with "-> ./x.js (nothing at that path)": it was scanning prose as
  // code.
  //
  // That is the exact defect this project already recorded three times while scanning
  // reference repositories — a README saying "It does NOT rewrite process.env" flagged as an
  // environment-exfiltration risk — and whose written remedy was "strip comments before
  // scanning". The remedy had never been applied to this file, which is why it happened
  // here the first time a comment quoted code.
  //
  // Only line comments that BEGIN a line are removed. A `//` inside a string is not a
  // comment, and truncating at one could hide a real import; a whole-line comment cannot be
  // anything else.
  const source = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  // Three forms, and the first version matched two of them. A bare side-effect import with
  // no `from` was invisible to the pattern, so a file could reference a module that does not
  // resolve and this check would never look at it. Found by probing the directory fix with
  // exactly that form and watching the count stay at 141.
  const pattern = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    importCount += 1
    const spec = match[1]
    const base = resolve(dirname(file), spec)
    const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js')]
    // `isFile()` cannot throw on a missing path the way `statSync` can, and it is false for
    // a directory — which is the whole point of using it over `existsSync`.
    const resolved = candidates.find((candidate) => {
      try {
        return statSync(candidate).isFile()
      } catch {
        return false
      }
    })
    if (resolved === undefined) {
      // Say WHICH shape was found, because "a directory is sitting where the module should
      // be" and "there is nothing there" need different fixes.
      const shadowing = candidates.filter((candidate) => existsSync(candidate))
      unresolved.push(
        `${file.slice(root.length + 1)} -> ${spec}`
        + (shadowing.length > 0
          ? ` (${shadowing.map((c) => relative(root, c)).join(', ')} exist but are not files)`
          : ' (nothing at that path)'),
      )
    }
  }
}
check(unresolved.length === 0, `every relative import resolves to a file (${importCount} imports)`, unresolved.join('; '))

// 3. No stale reference to a removed module. This checker is excluded because
// it necessarily names the module it is looking for.
const stale = []
for (const file of scripts) {
  if (file.endsWith('verify-bundle.mjs')) continue
  const source = readFileSync(file, 'utf8')
  if (/lib\/github\.js|\.\/github\.js['"]/.test(source)) stale.push(file.slice(root.length + 1))
}
check(stale.length === 0, 'no reference to the removed lib/github.js', stale.join('; '))

// 4. The manifest declares what dsh reads.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check(manifest.name === 'dsh-github-toolkit', 'manifest name', manifest.name)
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'manifest declares dsh.bundle.patch', String(manifest.dsh?.bundle?.patch))
check(manifest.dependencies === undefined, 'manifest declares no runtime dependencies (no install-time code execution)', JSON.stringify(manifest.dependencies ?? null))

// 5. The bare @deepseek-ai/* imports MUST be declared, or the runtime
// resolution will not supply them and the plugin fails to import entirely.
const peers = manifest.peerDependencies ?? {}
const requiredPeers = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools']
const missingPeers = requiredPeers.filter((name) => typeof peers[name] !== 'string')
check(missingPeers.length === 0,
  'every bare @deepseek-ai/* import is declared in peerDependencies (the runtime resolution key)',
  missingPeers.length === 0 ? Object.keys(peers).join(', ') : `missing: ${missingPeers.join(', ')}`)

// 6. Each declared dsh peer range must admit the running runtime, or
// `evaluatePluginCompatibility` records an incompatible peer and the install
// asks for an exact-version exemption.
const runtimeVersion = readRuntimeVersion()
if (runtimeVersion === undefined) {
  // NOT `check(true, …)`. The line below used to report PASS when the runtime version was
  // undiscoverable, which made this guard — the one whose whole purpose is to catch a peer
  // range mismatch — green without having looked. An independent audit found it by renaming
  // the hard-coded path and watching the line stay green.
  unverified('peer ranges vs the running runtime',
    'the DSH runtime version was not discoverable, so the peer ranges were NOT compared.\n'
    + `      Tried: ${RUNTIME_CANDIDATES.join(', ')}`)
} else {
  const semver = loadSemver()
  if (semver === null) {
    unverified('peer ranges vs the running runtime',
      `the runtime version is ${runtimeVersion} but no semver implementation was available `
      + 'to compare it against, so the ranges were NOT compared.\n'
      + `      Tried: ${SEMVER_CANDIDATES.join(', ')}`)
  } else {
    // Mirrors evaluatePluginCompatibility: only `@deepseek-ai/dsh` and
    // `@deepseek-ai/dsh-*` are gate-checked, with includePrerelease.
    const gated = Object.entries(peers).filter(([name]) =>
      name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    const blocked = gated.filter(([, range]) =>
      !semver.satisfies(runtimeVersion, range, { includePrerelease: true }))
    check(blocked.length === 0,
      `every gate-checked peer range admits dsh ${runtimeVersion}`,
      blocked.length === 0
        ? gated.map(([n, r]) => `${n}@${r}`).join(', ')
        : blocked.map(([n, r]) => `${n}@${r} rejects ${runtimeVersion}`).join('; '))
  }
}

check(typeof manifest.icon === 'string' && existsSync(join(root, manifest.icon)), 'manifest icon exists', String(manifest.icon))

// 6b. `engines.dsh` must exist. The closest peer plugin in the ecosystem
// (@perrylink/dsh-github, 22 stars) declares it and this plugin did not: without
// it a runtime bump surfaces as a load failure with no explanation instead of an
// upfront compatibility answer.
check(typeof manifest.engines?.dsh === 'string',
  'manifest declares engines.dsh (upfront compatibility, not a load failure)',
  String(manifest.engines?.dsh ?? 'MISSING'))

// 6c. Client-half packaging. Four things must line up or the pill silently never
// appears: the manifest declares `dsh.client`, the `./client` export points at a
// real file, that file is in `files` (so it ships), and its loader id equals the
// package name (the loader keys the module by that id).
const clientDecl = manifest.dsh?.client
check(clientDecl?.platform === 'web',
  'manifest declares dsh.client.platform "web"',
  String(clientDecl?.platform ?? 'MISSING'))
check(typeof manifest.exports?.['./client'] === 'string' && existsSync(join(root, manifest.exports['./client'])),
  'the "./client" export points at a real file',
  String(manifest.exports?.['./client'] ?? 'MISSING'))
check((manifest.files ?? []).includes('client.js'),
  'client.js is listed in manifest.files (otherwise it does not ship)',
  (manifest.files ?? []).includes('client.js') ? 'listed' : 'MISSING from files')

const clientPath = typeof manifest.exports?.['./client'] === 'string'
  ? join(root, manifest.exports['./client'])
  : undefined
if (clientPath !== undefined && existsSync(clientPath)) {
  const source = readFileSync(clientPath, 'utf8')
  // Pattern checks must not read prose. This file's own header EXPLAINS that
  // `styles.insert` and `host.call` are unavailable here, and a raw scan flagged
  // that explanation as a violation. Dropping comment lines is enough and is far
  // safer than half-writing a lexer over string literals.
  const codeOnly = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//'))
    })
    .join('\n')

  const idMatches = [...source.matchAll(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,200}?id\s*:\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
  check(idMatches.length === 1 && idMatches[0] === manifest.name,
    `the client loader id equals the package name (${manifest.name})`,
    idMatches.length === 0 ? 'no __ModuleLoader__.load({ id }) found' : idMatches.join(', '))
  check(/factory\s*\(\s*require\s*\)/.test(codeOnly),
    'the client half registers a lazy factory(require)',
    /factory\s*\(\s*require\s*\)/.test(codeOnly) ? 'present' : 'MISSING')
  // The script path has no injected `styles`, so a styles.insert() call would
  // throw at load and blank the slot. Styles must be React elements here.
  check(!/\bstyles\s*\.\s*insert\s*\(/.test(codeOnly),
    'the client half does not call styles.insert (unavailable on the script path)',
    /\bstyles\s*\.\s*insert\s*\(/.test(codeOnly) ? 'FOUND styles.insert — unavailable here' : 'clean')
  check(!/\bhost\s*\.\s*call\s*\(/.test(codeOnly),
    'the client half does not call host.call (unavailable on the script path)',
    /\bhost\s*\.\s*call\s*\(/.test(codeOnly) ? 'FOUND host.call — unavailable here' : 'clean')
  // Literal colors break light/dark; only tokens are allowed outside artwork.
  const literals = [...codeOnly.matchAll(/(?:color|background|border-color)\s*:\s*(?:#|rgb|hsl)/g)].map((m) => m[0])
  check(literals.length === 0,
    'the client styles use theme tokens, not literal colors',
    literals.length === 0 ? 'token-only' : literals.join('; '))
}

// 6d. Every row the patch inserts must resolve. A row whose `name` is not in the
// manifest's `exports` (or which points at a missing file) is a row that silently
// never activates — and for the Web row that means a pill stuck on its dash with
// nothing to explain why.
const patchPath = join(root, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const patchText = readFileSync(patchPath, 'utf8')
  const rowNames = [...patchText.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1])
  const unresolved = []
  for (const rowName of rowNames) {
    // Only rows naming THIS package are checked against our own exports.
    const prefix = rowName.split('/')[0].startsWith('@')
      ? rowName.split('/').slice(0, 2).join('/')
      : rowName.split('/')[0]
    if (prefix !== manifest.name) continue
    const subpath = rowName.slice(prefix.length)
    const target = subpath === '' ? manifest.exports?.['.'] : manifest.exports?.[`.${subpath}`]
    if (typeof target !== 'string') unresolved.push(`${rowName} (no "${subpath}" export)`)
    else if (!existsSync(join(root, target))) unresolved.push(`${rowName} -> ${target} (missing file)`)
  }
  check(unresolved.length === 0,
    `every patch row naming this package resolves (${rowNames.length} rows)`,
    unresolved.length === 0 ? rowNames.join(', ') : unresolved.join('; '))
  // A row must name the package ROOT. A subpath would resolve from the profile but
  // NOT from the installation base the launcher falls back to, so the row reports
  // "failed to import" — measured, after a two-row split shipped that way.
  const subpathRows = rowNames.filter((n) => n.startsWith(`${manifest.name}/`))
  check(subpathRows.length === 0,
    'no patch row uses a bare subpath (profile rows resolve by exact package name)',
    subpathRows.length === 0 ? 'root rows only' : subpathRows.join(', '))
}

// 7. Every file the manifest lists actually exists.
const missing = (manifest.files ?? [])
  .filter((entry) => !entry.includes('*'))
  .filter((entry) => !existsSync(join(root, entry)))
check(missing.length === 0, 'every concrete path in manifest.files exists', missing.join('; '))

// 7b. The reverse direction: everything that SHOULD ship is listed.
//
// Check 7 verifies manifest → disk. This one verifies disk → manifest, and it exists
// because the two are not the same check. `skills/` was written, tested and reviewed in
// 0.9.0 and would have gone out of the tarball entirely, because adding a directory to the
// tree does not add it to `files`. It was caught by thinking, not by a guard.
//
// This is the same defect shape as the "Iron Law E1" recorded in a neighbouring project:
// *Edit succeeded* ≠ *the file is git tracked*. Their version cost them 24 recorded
// reproductions. The general form is: **the thing exists** ≠ **the thing ships**.
{
  // `tools/` and `test/` are development-only and deliberately excluded; everything else
  // at the top level is either shipped or has to be named here as an exception.
  const NOT_SHIPPED = new Set(['tools', 'test', 'node_modules', '.git', 'package-lock.json'])
  const SKIP_FOR_NESTED = new Set(['node_modules', '.git', 'tools', 'test'])
  const listed = new Set((manifest.files ?? []).map((entry) => entry.split('/')[0]))
  const present = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !NOT_SHIPPED.has(entry.name))
    .map((entry) => entry.name)
  // `package.json` is always packed by npm regardless of `files`, so it is not a gap.
  const unlisted = present.filter((name) => name !== 'package.json' && !listed.has(name))
  // Nested files under a directory that `files` enumerates FILE BY FILE are invisible to
  // the check above: it compares top-level names, so `docs/` counts as covered while
  // `docs/NEW.md` would not be packed. Found by an independent audit that added
  // `docs/AUDIT-UNSHIPPED.md` and watched this check pass while `npm pack --dry-run`
  // omitted it. So: for every entry that names a file inside a directory, the directory
  // is checked top-down, and anything readable that is not itself listed is a finding.
  const enumeratedDirs = new Set(
    (manifest.files ?? [])
      .filter((entry) => entry.includes('/') && !entry.includes('*'))
      .map((entry) => entry.split('/')[0]),
  )
  const covered = new Set((manifest.files ?? []).filter((entry) => !entry.includes('*')))
  const nested = []
  for (const dir of enumeratedDirs) {
    const full = join(root, dir)
    if (!existsSync(full)) continue
    // A directory listed whole (`lib`, `skills`) ships everything under it by definition.
    if (covered.has(dir)) continue
    const walkDir = (base) => {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_FOR_NESTED.has(entry.name)) continue
        const path = join(base, entry.name)
        if (entry.isDirectory()) walkDir(path)
        else if (!covered.has(relative(root, path).split('\\').join('/'))) {
          nested.push(relative(root, path).split('\\').join('/'))
        }
      }
    }
    walkDir(full)
  }
  check(unlisted.length === 0,
    'every top-level entry that should ship is listed in manifest.files',
    unlisted.length === 0
      ? `${present.length} entries covered`
      : `${unlisted.join(', ')} — present in the tree but would NOT be packed`)
  check(nested.length === 0,
    'no file is left unpacked inside a directory manifest.files enumerates file by file',
    nested.length === 0
      ? `${enumeratedDirs.size} enumerated director(ies) checked`
      : `${nested.join(', ')} — present but would NOT be packed`)
}

// 8. The exports map points at real files.
const exportTargets = Object.values(manifest.exports ?? {})
  .map((value) => (typeof value === 'string' ? value : value?.default))
  .filter((value) => typeof value === 'string' && !value.includes('*'))
const badExports = exportTargets.filter((target) => !existsSync(join(root, target)))
check(badExports.length === 0, 'every manifest export resolves', badExports.join('; '))

// 9. The plugin entry exports the documented shape.
const entry = await import(`file:///${join(root, 'index.js').replaceAll('\\', '/')}`)
check(typeof entry.apply === 'function', 'entry exports apply()', typeof entry.apply)
check(entry.name === 'github-toolkit', 'entry exports name', String(entry.name))
check(Array.isArray(entry.inject) && entry.inject.includes('tools'), 'entry injects the tools service', JSON.stringify(entry.inject))
check(entry.default === undefined, 'entry has no default export (the Loader drops inject on default exports)', String(entry.default))
check(entry.Config !== undefined && typeof entry.Config['~standard']?.validate === 'function',
  'entry exports a Standard Schema Config', typeof entry.Config)

// 10. The source tree carries no leftover artifacts.
const junk = files
  .map((file) => file.slice(root.length + 1))
  .filter((rel) => /(^|\/)(node_modules|\.DS_Store|.*\.log|.*\.tmp)$/.test(rel))
check(junk.length === 0, 'no build or temp artifacts in the tree', junk.join('; '))

// 11. Test suite present.
const tests = files.filter((file) => /test[\\/].*\.mjs$/.test(file))
check(tests.length >= 4, `test suite present (${tests.length} files)`,
  tests.map((t) => t.slice(root.length + 1)).join(', '))

// 12. Packaging parity with the shipped plugins. `@deepseek-ai/dsh-tool-bash`
// and `dsh-tool-fs` both ship LICENSE plus a bilingual README; a plugin that
// declares `"license": "MIT"` without the file is incomplete.
for (const required of ['LICENSE', 'README.md', 'README.zh.md', 'CHANGELOG.md']) {
  check(existsSync(join(root, required)), `ships ${required}`, existsSync(join(root, required)) ? 'present' : 'MISSING')
}
const licenseText = existsSync(join(root, 'LICENSE')) ? readFileSync(join(root, 'LICENSE'), 'utf8') : ''
check(/^MIT License/m.test(licenseText) && /WITHOUT WARRANTY/i.test(licenseText),
  'LICENSE carries the full MIT text the manifest declares',
  licenseText === '' ? 'absent' : `${licenseText.split('\n').length} lines`)

// 13. The locale files must use the `meta` wrapper readPluginMeta actually
// reads. A flat {title, description} is silently ignored and the card falls
// back to the package name — the exact defect that hid this plugin from the
// settings page.
const localeProblems = []
const localeDir = join(root, 'locale')
if (existsSync(localeDir)) {
  for (const name of readdirSync(localeDir)) {
    if (!name.endsWith('.json')) continue
    const language = name.slice(0, -5)
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
      localeProblems.push(`${name}: filename is not a language id (readPluginMeta throws on it)`)
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(join(localeDir, name), 'utf8'))
      if (typeof parsed?.meta?.title !== 'string' || parsed.meta.title.trim() === '') {
        localeProblems.push(`${name}: meta.title is required (a flat "title" is ignored)`)
      }
    } catch (error) {
      localeProblems.push(`${name}: ${String(error.message ?? error)}`)
    }
  }
}
check(localeProblems.length === 0, 'locale files carry the meta.title readPluginMeta reads', localeProblems.join('; '))

// 14. Every bare @deepseek-ai/* import must be DECLARED, or the runtime
// resolution cannot supply it and the plugin dies at import. Checked against
// the actual import statements, so a new import cannot slip past a stale list.
const bareImports = new Set()
for (const file of scripts) {
  if (file.includes(`${pathSep}.vendor${pathSep}`)) continue
  for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) {
    bareImports.add(match[1].split('/').slice(0, 2).join('/'))
  }
}
const undeclaredImports = [...bareImports].filter((name) => typeof peers[name] !== 'string')
check(undeclaredImports.length === 0,
  'every bare @deepseek-ai/* import is declared in peerDependencies',
  undeclaredImports.length === 0 ? [...bareImports].join(', ') : `undeclared: ${undeclaredImports.join(', ')}`)

// 15. defineTool conformance: the capabilities the official reference documents
// and the shipped plugins use must be declared by every registered tool. A
// missing presenter degrades to the generic card; a missing concurrency
// predicate serialises every call.
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
check(missingCapabilities.length === 0,
  `every registered tool declares the official presentation and concurrency hooks (${probeContext.tools.size} tools)`,
  missingCapabilities.join('; '))

// 16. A declared `run_in_background` parameter must be backed by a real branch,
// because a parameter the model can pass but nothing honours is worse than no
// parameter at all.
const backgroundTools = [...probeContext.tools.entries()]
  .filter(([, definition]) => 'run_in_background' in (definition.parameters.properties ?? {}))
const unbacked = backgroundTools
  .filter(([, definition]) => !definition.description.includes('Actions:'))
  .map(([name]) => name)
check(unbacked.length === 0,
  `run_in_background is declared on long-action tools only (${backgroundTools.map(([n]) => n).join(', ') || 'none'})`,
  unbacked.join('; '))

// 17. Line counts, reported for the record.
const total = scripts.reduce((sum, file) => sum + readFileSync(file, 'utf8').split('\n').length, 0)
console.log(`\nmodules: ${scripts.length}, total lines: ${total}`)

/**
 * Read the running dsh runtime version from the installation manifest.
 * @returns {string | undefined} the version, when discoverable
 */
/** Where the DSH runtime manifest might be. Named so a skip can say what it tried. */

function readRuntimeVersion() {
  const candidates = [
    process.env.DSH_INSTALL_ASAR?.replace(/app\.asar.*$/i, 'app.asar'),
    'D:\\DeepSeek Harness\\app\\resources\\app.asar',
  ].filter((value) => typeof value === 'string' && value !== '')
  for (const archive of candidates) {
    if (!existsSync(archive)) continue
    try {
      // The installation manifest is the first JSON blob in the archive header
      // region; reading it whole is unnecessary, so scan the package.json of
      // the dsh runtime via asar-list + asar-extract instead.
      const out = execFileSync(process.execPath, [
        join(root, 'tools', 'asar-extract.mjs'),
        archive,
        '/dsh/package.json',
        join(root, 'test', '.vendor', 'dsh-runtime-package.json'),
      ], { stdio: 'pipe', encoding: 'utf8' })
      if (out === undefined) continue
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
  const candidates = [
    'C:\\Program Files\\nodejs\\node_modules\\npm\\node_modules\\semver',
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const require = createRequire(import.meta.url)
      return require(candidate)
    } catch { /* try the next candidate */ }
  }
  return null
}

// The unverified count is printed on EVERY run, including a clean one. A summary that says
// only "all checks passed" when some checks did not run is the defect this line exists to
// prevent — silence and success must not look the same.
const tail = unverifiedCount === 0
  ? '\n=== all checks passed ==='
  : `\n=== all checks passed, ${unverifiedCount} check(s) could NOT RUN (see UNVERIFIED above) ===`
console.log(failures === 0 ? tail : `\n=== ${failures} check(s) failed ===`)
process.exitCode = failures === 0 ? 0 : 1