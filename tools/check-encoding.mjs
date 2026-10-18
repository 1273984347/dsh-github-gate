/**
 * Text hygiene for every file this package ships.
 *
 * ## Why this exists
 *
 * Two claims arrived from another project's notes, and both are checkable:
 *
 * - `Set-Content` writes UTF-8 **with a BOM** on Windows PowerShell.
 * - `>` redirection writes **UTF-16LE**.
 *
 * This project used `Set-Content` and `Add-Content` extensively — including to append
 * six sections to the retrospective report — so the claim is not academic. A BOM is
 * invisible in most editors and harmless in most parsers, which is exactly what makes it
 * a bad defect: it survives review, then breaks something that reads the first bytes
 * literally (a shebang, a JSON parser, a diff).
 *
 * A third claim is about line endings: mixing shells can leave `\r\n` in files written by
 * a tool that expected `\n`.
 *
 * ## What this checks
 *
 * Every shipped text file must be:
 *
 * 1. **UTF-8 without a BOM.** No `EF BB BF` prefix.
 * 2. **Valid UTF-8.** Decoding it must not produce replacement characters.
 * 3. **One line-ending convention throughout.** A file that mixes `\r\n` and bare `\n` is
 *    reported with the counts, because "which one is correct" depends on the file.
 * 4. **Free of NUL bytes**, which mean it was written as UTF-16 without anyone noticing.
 *
 * ## A note on why the shipped files pass
 *
 * They pass because this machine's ANSI code page is 65001 (UTF-8), which is what
 * PowerShell 5.1's `Set-Content` and `Add-Content` fall back to for their default
 * encoding. Measured: `Add-Content` writing four Chinese characters produced 12 bytes
 * (UTF-8), not the 8 that GBK would give. The `>` redirection operator is NOT covered by
 * that — measured, it writes UTF-16LE with a `FF FE` prefix.
 *
 * So the files are clean by SYSTEM CONFIGURATION, not by tool guarantee. Turn that
 * Windows setting off and every `Set-Content` in this project starts writing GBK, with no
 * error and no visible symptom until someone opens the file in a UTF-8 reader. That is
 * the reason the rule is "write files with the editor", not "write files with whichever
 * shell happens to be configured correctly".
 *
 * ## Scope, and its blind spot
 *
 * By default this checks the files the package SHIPS, which is what a reader of the
 * artifact sees. It does **not** cover documents kept outside the package by default —
 * the retrospective report lives at `D:\dsh\复盘报告-2026-10-15.md` and went unmeasured
 * until this was noticed. Pass extra paths to include them:
 *
 *     node tools/check-encoding.mjs ../../复盘报告-2026-10-15.md
 *
 * Usage: node tools/check-encoding.mjs [extra paths…] [--fix-lf]
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Extensions excluded from the check as non-text, and how many files each accounts for.
 *
 * Module-level rather than local to `collect` because the SUMMARY needs it: a coverage
 * count says nothing about what was left out, and the failure this closes was exactly a
 * silent omission. `LICENSE` and `icon.svg` were outside the boundary and the report did
 * not say so.
 */
const skipped = new Map()

/**
 * Extensions treated as text.
 *
 * `.svg` belongs here because it IS text and it SHIPS. It was missing, so `icon.svg` never
 * entered the check — and the summary line still read "checked 60 text file(s)", which a
 * reader takes as "everything was checked".
 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.ts', '.svg',
])

/**
 * Extension-less files that are nonetheless text and SHIP.
 *
 * `LICENSE` has no extension, so the filter dropped it for the same reason `.svg` was
 * dropped, and for the same reason it went unnoticed: the boundary was never stated.
 *
 * This is the project's own rule PRE-17 — *a guard must say what it does NOT cover* —
 * broken by the guard that rule was written about. The fix is two-part: widen the set, and
 * PRINT what was skipped so the next omission is visible instead of implied.
 */
const TEXT_NAMES = new Set(['LICENSE', 'NOTICE', 'COPYING', 'AUTHORS'])

/**
 * Whether a path is text this check should read.
 *
 * @param {string} path the file path
 * @returns {boolean} true when it should be checked
 */
function isText(path) {
  const name = path.split(/[/\\]/).pop() ?? ''
  return TEXT_EXT.has(extname(name).toLowerCase()) || TEXT_NAMES.has(name)
}

/** Trees that are not ours to police. */
const SKIP = new Set(['node_modules', '.git', '.vendor', 'dist', 'build'])

/**
 * Every text file that would be shipped or reviewed.
 *
 * Driven by `manifest.files` so the check covers exactly what leaves this package, plus
 * the tools and tests that a reader opens. Extra paths on the command line are added, which
 * is how a document kept outside the package gets covered.
 *
 * @returns {string[]} absolute paths
 */
function collect(extra) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const roots = new Set(['tools', 'test'])
  for (const entry of manifest.files ?? []) {
    // A glob entry is covered by its directory; `locale/*.json` has no literal path.
    roots.add(entry.split('/')[0])
  }
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (isText(entry.name)) files.push(full)
      else {
        const kind = extname(entry.name).toLowerCase() || '(no extension)'
        skipped.set(kind, (skipped.get(kind) ?? 0) + 1)
      }
    }
  }
  for (const root of roots) {
    const full = join(ROOT, root)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) walk(full)
    else if (isText(full)) files.push(full)
  }
  for (const target of extra) {
    const full = resolve(target)
    if (!existsSync(full)) {
      console.log(`warning: extra path does not exist and was skipped: ${full}`)
      continue
    }
    if (statSync(full).isDirectory()) walk(full)
    else files.push(full)
  }
  return [...new Set(files)].sort()
}

const args = process.argv.slice(2)
const extraPaths = args.filter((arg) => !arg.startsWith('--'))
const files = collect(extraPaths)
const findings = []

if (process.argv.includes('--fix-lf')) {
  let fixed = 0
  for (const file of files) {
    const bytes = readFileSync(file)
    if (bytes.includes(0x0d)) {
      writeFileSync(file, Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'))
      fixed += 1
    }
  }
  console.log(`normalised ${fixed} file(s) to LF`)
}

for (const file of files) {
  const name = relative(ROOT, file)
  const bytes = readFileSync(file)

  // 1. BOM. The whole point of the check: these three bytes are how the shell-layer
  //    pitfalls announced in the notes would show up in this repository.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    findings.push({ file: name, id: 'bom', detail: 'starts with a UTF-8 BOM (EF BB BF)' })
  }

  // 2. UTF-16 written by a redirect. A NUL byte in a text file is never intentional here.
  if (bytes.includes(0x00)) {
    findings.push({ file: name, id: 'nul', detail: 'contains a NUL byte — written as UTF-16?' })
    continue
  }

  const text = bytes.toString('utf8')
  // 3. Invalid UTF-8 decodes to the replacement character.
  if (text.includes('\ufffd')) {
    findings.push({ file: name, id: 'not-utf8', detail: 'is not valid UTF-8 (decoded a replacement character)' })
  }

  // 4. Mixed line endings. Counted, not assumed: the correct convention depends on the
  //    file, so the finding is the MIX rather than either ending.
  const crlf = (text.match(/\r\n/g) ?? []).length
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length
  if (crlf > 0 && bareLf > 0) {
    findings.push({ file: name, id: 'mixed-eol', detail: `mixes CRLF (${crlf}) and LF (${bareLf})` })
  }
}

const byId = new Map()
for (const finding of findings) {
  byId.set(finding.id, (byId.get(finding.id) ?? 0) + 1)
}

// What was NOT checked, stated rather than implied.
//
// The defect this closes: the summary read "checked 60 text file(s) / clean", and a reader
// takes that as "everything is clean". Two shipped files were never opened. A count of
// what was covered says nothing about what was skipped, so both are printed — and the
// skipped ones are named by extension, so the next text format to arrive is visible here
// instead of silently outside the boundary.
console.log(`checked ${files.length} text file(s)`)
if (skipped.size > 0) {
  const summary = [...skipped.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([kind, count]) => `${kind} (${count})`)
    .join(', ')
  console.log(`skipped ${[...skipped.values()].reduce((sum, n) => sum + n, 0)} non-text file(s): ${summary}`)
  console.log('  ^ these are binary by assumption. If one of them is text and SHIPS, add its')
  console.log('    extension to TEXT_EXT — an unchecked file that ships is the bug this line exists for.')
}
if (findings.length === 0) {
  console.log('clean: no BOM, no NUL bytes, valid UTF-8, no mixed line endings')
} else {
  console.log(`${findings.length} finding(s):`)
  for (const [id, count] of byId) console.log(`  ${id}: ${count}`)
  console.log('')
  for (const finding of findings) console.log(`  ${finding.file}  [${finding.id}] ${finding.detail}`)
}
process.exitCode = findings.length === 0 ? 0 : 1
