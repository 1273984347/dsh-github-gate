/**
 * Static manifest and packaging checks — everything that needs no DSH installation.
 *
 * ## Why this is a separate gate
 *
 * These checks lived inside `verify-bundle.mjs`, which also imports `index.js` to
 * inspect the registered tools. That import needs `@deepseek-ai/*` packages, which a
 * CI runner does not have, so the whole file was skipped in CI — including the
 * packaging checks that need nothing but the tree.
 *
 * The consequence was measured three times: `install.ps1`/`install.sh`, `PRIVACY.md`
 * and `docs/roadmap.md` were each present in the tree and absent from `manifest.files`,
 * so `npm pack` would have shipped a bundle without them. `verify-bundle.mjs` caught
 * all three — locally — while CI stayed green. **A guard that only runs when a person
 * remembers to run it is not a guard.**
 *
 * So the split is along the dependency line: this file imports only Node builtins and
 * is safe anywhere; `verify-bundle.mjs` keeps the dynamic checks and imports this one,
 * so there is exactly one implementation of each static check.
 *
 * Every check here returns data instead of printing. `test/gates.test.mjs` builds a
 * deliberately broken tree and asserts these functions report it — a gate that has
 * never been seen to fail is a gate nobody has proved works.
 *
 * @module tools/verify-manifest
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { Reporter } from './lib/report.mjs'

/**
 * List every file under a directory, recursively, skipping generated trees.
 *
 * `.vendor` holds a reconstruction of DSH's own packages for the offline tests, not
 * this bundle's source: scanning it would be slow and would report on code this
 * plugin does not own.
 *
 * @param {string} dir the directory
 * @returns {string[]} absolute file paths
 */
export function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.vendor') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/**
 * Run every static check against a tree.
 *
 * @param {string} root the package root
 * @returns {Reporter} the collected results
 */
export function verifyManifest(root) {
  const reporter = new Reporter()
  const files = walk(root)
  const scripts = files.filter((file) => /\.(js|mjs)$/.test(file))

  checkSyntax(reporter, root, scripts)
  checkImports(reporter, root, scripts)
  checkNoStaleModules(reporter, root, scripts)
  checkBareImportsDeclared(reporter, root, scripts)

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  checkManifestFields(reporter, root, manifest)
  checkClientHalf(reporter, root, manifest)
  checkFilesAgainstDisk(reporter, root, manifest)
  checkExports(reporter, root, manifest)
  checkPatchRows(reporter, root, manifest)
  checkLocale(reporter, root)
  checkPackagingParity(reporter, root)
  checkJunkArtifacts(reporter, root, files)
  checkTestSuitePresent(reporter, root, files)

  return reporter
}

/**
 * Every module must parse.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {string[]} scripts absolute paths
 */
function checkSyntax(reporter, root, scripts) {
  const failures = []
  for (const file of scripts) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
      failures.push(`${relative(root, file)}: ${String(error.stderr ?? error).split('\n')[0]}`)
    }
  }
  reporter.check(failures.length === 0, `every module parses (${scripts.length} files)`, failures.join('; '))
}

/**
 * Every relative import must resolve to a real FILE.
 *
 * `existsSync` is true for a DIRECTORY, so an earlier version accepted a directory
 * named `does-not-exist.js/` while the import failed the moment anything loaded it.
 * The candidates below are what Node tries for a relative specifier; each must be a
 * regular file, not merely present.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {string[]} scripts absolute paths
 */
function checkImports(reporter, root, scripts) {
  const unresolved = []
  let importCount = 0
  for (const file of scripts) {
    // Strip comments BEFORE looking for imports. A comment that quotes an import
    // form — which this file's own header used to do — would otherwise be scanned as
    // code. Only whole-line `//` comments are removed: a `//` inside a string is not
    // a comment, and truncating at one could hide a real import.
    const source = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    // Three forms: `from '...'`, dynamic `import('...')`, and bare side-effect
    // `import '...'`. The first version matched two, so a side-effect import could
    // reference a module that does not resolve without this check looking at it.
    const pattern = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g
    for (const match of source.matchAll(pattern)) {
      importCount += 1
      const spec = match[1]
      const base = resolve(dirname(file), spec)
      const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js')]
      const resolved = candidates.find((candidate) => {
        try {
          return statSync(candidate).isFile()
        } catch {
          return false
        }
      })
      if (resolved === undefined) {
        const shadowing = candidates.filter((candidate) => existsSync(candidate))
        unresolved.push(
          `${relative(root, file)} -> ${spec}`
          + (shadowing.length > 0
            ? ` (${shadowing.map((c) => relative(root, c)).join(', ')} exist but are not files)`
            : ' (nothing at that path)'),
        )
      }
    }
  }
  reporter.check(unresolved.length === 0, `every relative import resolves to a file (${importCount} imports)`, unresolved.join('; '))
}

/**
 * No source file may still reference a module that was removed.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {string[]} scripts absolute paths
 */
function checkNoStaleModules(reporter, root, scripts) {
  const stale = []
  for (const file of scripts) {
    // This gate necessarily names the module it looks for; naming it is the check.
    if (file.endsWith('verify-manifest.mjs')) continue
    if (/lib\/github\.js|\.\/github\.js['"]/.test(readFileSync(file, 'utf8'))) {
      stale.push(relative(root, file))
    }
  }
  reporter.check(stale.length === 0, 'no reference to the removed lib/github.js', stale.join('; '))
}

/**
 * Every bare `@deepseek-ai/*` import must be DECLARED, or the runtime resolution
 * cannot supply it and the plugin dies at import.
 *
 * Checked against the actual import statements rather than a hand-kept list, so a new
 * import cannot slip past a stale declaration.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {string[]} scripts absolute paths
 */
function checkBareImportsDeclared(reporter, root, scripts) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const peers = manifest.peerDependencies ?? {}
  const bare = new Set()
  for (const file of scripts) {
    if (file.includes('node_modules')) continue
    for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) {
      bare.add(match[1].split('/').slice(0, 2).join('/'))
    }
  }
  const undeclared = [...bare].filter((name) => typeof peers[name] !== 'string')
  reporter.check(undeclared.length === 0,
    'every bare @deepseek-ai/* import is declared in peerDependencies',
    undeclared.length === 0 ? [...bare].join(', ') : `undeclared: ${undeclared.join(', ')}`)
}

/**
 * The manifest must declare what dsh reads.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {any} manifest the parsed package.json
 */
function checkManifestFields(reporter, root, manifest) {
  reporter.check(typeof manifest.name === 'string' && manifest.name !== '', 'manifest name', String(manifest.name))
  reporter.check(manifest.dsh?.bundle?.patch === './cordis.patch.yml',
    'manifest declares dsh.bundle.patch', String(manifest.dsh?.bundle?.patch))
  reporter.check(manifest.dependencies === undefined,
    'manifest declares no runtime dependencies (no install-time code execution)',
    JSON.stringify(manifest.dependencies ?? null))
  reporter.check(typeof manifest.icon === 'string' && existsSync(join(root, manifest.icon)),
    'manifest icon exists', String(manifest.icon))
  // `engines.dsh` turns a runtime bump into an upfront compatibility answer instead of
  // a load failure with no explanation.
  reporter.check(typeof manifest.engines?.dsh === 'string',
    'manifest declares engines.dsh (upfront compatibility, not a load failure)',
    String(manifest.engines?.dsh ?? 'MISSING'))

  const clientDecl = manifest.dsh?.client
  reporter.check(clientDecl?.platform === 'web',
    'manifest declares dsh.client.platform "web"', String(clientDecl?.platform ?? 'MISSING'))
  reporter.check(typeof manifest.exports?.['./client'] === 'string' && existsSync(join(root, manifest.exports['./client'])),
    'the "./client" export points at a real file', String(manifest.exports?.['./client'] ?? 'MISSING'))
  reporter.check((manifest.files ?? []).includes('client.js'),
    'client.js is listed in manifest.files (otherwise it does not ship)',
    (manifest.files ?? []).includes('client.js') ? 'listed' : 'MISSING from files')
}

/**
 * The browser half must load on the shell's script path.
 *
 * Four things line up or the pill silently never appears: the loader id equals the
 * package name (the loader keys a module by that id), a lazy `factory(require)` is
 * registered, nothing calls the two capabilities that path does not inject
 * (`styles.insert`, `host.call`), and colours come from theme tokens — a literal
 * colour breaks exactly one of light/dark.
 *
 * These are static reads of `client.js`, so they belong in the gate CI can run: a
 * broken client half otherwise fails only when a browser loads it.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {any} manifest the parsed package.json
 */
function checkClientHalf(reporter, root, manifest) {
  const target = manifest.exports?.['./client']
  if (typeof target !== 'string') return
  const clientPath = join(root, target)
  if (!existsSync(clientPath)) return
  const source = readFileSync(clientPath, 'utf8')
  // Pattern checks must not read prose: this file's own header explains that
  // `styles.insert` and `host.call` are unavailable here, and a raw scan flagged that
  // explanation as a violation. Dropping comment lines is enough and is far safer
  // than half-writing a lexer over string literals.
  const codeOnly = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//'))
    })
    .join('\n')

  const idMatches = [...source.matchAll(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,200}?id\s*:\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
  reporter.check(idMatches.length === 1 && idMatches[0] === manifest.name,
    `the client loader id equals the package name (${manifest.name})`,
    idMatches.length === 0 ? 'no __ModuleLoader__.load({ id }) found' : idMatches.join(', '))
  reporter.check(/factory\s*\(\s*require\s*\)/.test(codeOnly),
    'the client half registers a lazy factory(require)',
    /factory\s*\(\s*require\s*\)/.test(codeOnly) ? 'present' : 'MISSING')
  reporter.check(!/\bstyles\s*\.\s*insert\s*\(/.test(codeOnly),
    'the client half does not call styles.insert (unavailable on the script path)',
    /\bstyles\s*\.\s*insert\s*\(/.test(codeOnly) ? 'FOUND styles.insert — unavailable here' : 'clean')
  reporter.check(!/\bhost\s*\.\s*call\s*\(/.test(codeOnly),
    'the client half does not call host.call (unavailable on the script path)',
    /\bhost\s*\.\s*call\s*\(/.test(codeOnly) ? 'FOUND host.call — unavailable here' : 'clean')
  const literals = [...codeOnly.matchAll(/(?:color|background|border-color)\s*:\s*(?:#|rgb|hsl)/g)].map((m) => m[0])
  reporter.check(literals.length === 0,
    'the client styles use theme tokens, not literal colors',
    literals.length === 0 ? 'token-only' : literals.join('; '))
}

/**
 * The two directions between `manifest.files` and the tree.
 *
 * They are not the same check. `manifest → disk` catches a listed path that is gone;
 * `disk → manifest` catches a file that exists, is tested, and would be left out of
 * the tarball. The second direction is the one that caught three real omissions.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {any} manifest the parsed package.json
 */
function checkFilesAgainstDisk(reporter, root, manifest) {
  const missing = (manifest.files ?? [])
    .filter((entry) => !entry.includes('*'))
    .filter((entry) => !existsSync(join(root, entry)))
  reporter.check(missing.length === 0, 'every concrete path in manifest.files exists', missing.join('; '))

  // `tools/` and `test/` are development-only and deliberately excluded; everything
  // else at the top level is either shipped or has to be named here as an exception.
  const NOT_SHIPPED = new Set(['tools', 'test', 'node_modules', '.git', 'package-lock.json'])
  const SKIP_FOR_NESTED = new Set(['node_modules', '.git', 'tools', 'test'])
  const listed = new Set((manifest.files ?? []).map((entry) => entry.split('/')[0]))
  const present = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !NOT_SHIPPED.has(entry.name))
    .map((entry) => entry.name)
  // `package.json` is always packed by npm regardless of `files`, so it is not a gap.
  const unlisted = present.filter((name) => name !== 'package.json' && !listed.has(name))

  // Nested files under a directory that `files` enumerates FILE BY FILE are invisible
  // to the comparison above, which only looks at top-level names. `docs/` counts as
  // covered while `docs/NEW.md` would not be packed.
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
    // A directory listed whole ships everything under it by definition.
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

  reporter.check(unlisted.length === 0,
    'every top-level entry that should ship is listed in manifest.files',
    unlisted.length === 0
      ? `${present.length} entries covered`
      : `${unlisted.join(', ')} — present in the tree but would NOT be packed`)
  reporter.check(nested.length === 0,
    'no file is left unpacked inside a directory manifest.files enumerates file by file',
    nested.length === 0
      ? `${enumeratedDirs.size} enumerated director(ies) checked`
      : `${nested.join(', ')} — present but would NOT be packed`)
}

/**
 * Every export target must resolve.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {any} manifest the parsed package.json
 */
function checkExports(reporter, root, manifest) {
  const targets = Object.values(manifest.exports ?? {})
    .map((value) => (typeof value === 'string' ? value : value?.default))
    .filter((value) => typeof value === 'string' && !value.includes('*'))
  const bad = targets.filter((target) => !existsSync(join(root, target)))
  reporter.check(bad.length === 0, 'every manifest export resolves', bad.join('; '))
}

/**
 * Every patch row naming this package must resolve to an export, and must name the
 * package ROOT.
 *
 * A subpath resolves from the profile but not from the installation base the launcher
 * falls back to, so such a row reports "failed to import" — measured, after a two-row
 * split shipped that way.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {any} manifest the parsed package.json
 */
function checkPatchRows(reporter, root, manifest) {
  const patchPath = join(root, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
  if (!existsSync(patchPath)) return
  const patchText = readFileSync(patchPath, 'utf8')
  const rowNames = [...patchText.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1])
  const unresolved = []
  for (const rowName of rowNames) {
    const prefix = rowName.split('/')[0].startsWith('@')
      ? rowName.split('/').slice(0, 2).join('/')
      : rowName.split('/')[0]
    if (prefix !== manifest.name) continue
    const subpath = rowName.slice(prefix.length)
    const target = subpath === '' ? manifest.exports?.['.'] : manifest.exports?.[`.${subpath}`]
    if (typeof target !== 'string') unresolved.push(`${rowName} (no "${subpath}" export)`)
    else if (!existsSync(join(root, target))) unresolved.push(`${rowName} -> ${target} (missing file)`)
  }
  reporter.check(unresolved.length === 0,
    `every patch row naming this package resolves (${rowNames.length} rows)`,
    unresolved.length === 0 ? rowNames.join(', ') : unresolved.join('; '))
  const subpathRows = rowNames.filter((n) => n.startsWith(`${manifest.name}/`))
  reporter.check(subpathRows.length === 0,
    'no patch row uses a bare subpath (profile rows resolve by exact package name)',
    subpathRows.length === 0 ? 'root rows only' : subpathRows.join(', '))
}

/**
 * Locale files must use the `meta` wrapper `readPluginMeta` actually reads.
 *
 * A flat `{title, description}` is silently ignored and the card falls back to the
 * package name — the exact defect that once hid this plugin from the settings page.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 */
function checkLocale(reporter, root) {
  const problems = []
  const localeDir = join(root, 'locale')
  if (existsSync(localeDir)) {
    for (const name of readdirSync(localeDir)) {
      if (!name.endsWith('.json')) continue
      const language = name.slice(0, -5)
      if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
        problems.push(`${name}: filename is not a language id (readPluginMeta throws on it)`)
        continue
      }
      try {
        const parsed = JSON.parse(readFileSync(join(localeDir, name), 'utf8'))
        if (typeof parsed?.meta?.title !== 'string' || parsed.meta.title.trim() === '') {
          problems.push(`${name}: meta.title is required (a flat "title" is ignored)`)
        }
      } catch (error) {
        problems.push(`${name}: ${String(error.message ?? error)}`)
      }
    }
  }
  reporter.check(problems.length === 0, 'locale files carry the meta.title readPluginMeta reads', problems.join('; '))
}

/**
 * Packaging parity: a plugin that declares MIT without the licence text is
 * incomplete, and the shipped DSH plugins all carry a bilingual README.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 */
function checkPackagingParity(reporter, root) {
  for (const required of ['LICENSE', 'README.md', 'README.zh.md', 'CHANGELOG.md']) {
    reporter.check(existsSync(join(root, required)), `ships ${required}`,
      existsSync(join(root, required)) ? 'present' : 'MISSING')
  }
  const licenseText = existsSync(join(root, 'LICENSE')) ? readFileSync(join(root, 'LICENSE'), 'utf8') : ''
  reporter.check(/^MIT License/m.test(licenseText) && /WITHOUT WARRANTY/i.test(licenseText),
    'LICENSE carries the full MIT text the manifest declares',
    licenseText === '' ? 'absent' : `${licenseText.split('\n').length} lines`)
}

/**
 * No build or temp artifact may be committed.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {string[]} files absolute paths
 */
function checkJunkArtifacts(reporter, root, files) {
  const junk = files
    .map((file) => relative(root, file).split('\\').join('/'))
    .filter((rel) => /(^|\/)(node_modules|\.DS_Store|.*\.log|.*\.tmp)$/.test(rel))
  reporter.check(junk.length === 0, 'no build or temp artifacts in the tree', junk.join('; '))
}

/**
 * The test suite must exist and be discoverable.
 * @param {Reporter} reporter the collector
 * @param {string} root the package root
 * @param {string[]} files absolute paths
 */
function checkTestSuitePresent(reporter, root, files) {
  const tests = files.filter((file) => /test[\\/].*\.mjs$/.test(file))
  reporter.check(tests.length >= 4, `test suite present (${tests.length} files)`,
    tests.map((file) => relative(root, file)).join(', '))
}

// CLI entry: `node tools/verify-manifest.mjs`
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { printResults, finish } = await import('./lib/report.mjs')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const reporter = verifyManifest(root)
  printResults(reporter.results)
  finish(reporter.results)
}
