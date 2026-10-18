/**
 * Reconnaissance for a third-party repository: safety-gated clone, content scan, purge.
 *
 * ## The mistake this exists to prevent
 *
 * Reading a project's README and reporting its mechanisms as fact is not analysis.
 * It happened here: three plugins were described in detail from their READMEs, with a
 * note that the code had not been read — and then the descriptions were used to decide
 * what to build. A README states intent. Only the code states behaviour, and the two
 * disagree often enough that treating one as the other is how a wrong mechanism gets
 * copied into a new project.
 *
 * ## Why the clone needs a gate in front of it
 *
 * `git clone` on its own does not execute repository content. The danger is everything
 * that happens NEXT: a `postinstall` script, a submodule that pulls a second repository,
 * a Git LFS filter that shells out, a symlink that points outside the tree. The point of
 * this tool is that the deciding happens while the code is still REMOTE, where refusing
 * costs nothing.
 *
 * Three phases, in this order, for that reason:
 *
 * 1. **Preflight, before any bytes land** — read metadata and the file tree over the
 *    API and look for the things that execute. Refuses by default; `--yes` overrides.
 * 2. **Clone, with every executing feature off** — shallow, single branch, no tags, no
 *    submodules, symlinks materialised as text, LFS smudge skipped, hooks path diverted
 *    to an empty directory.
 * 3. **Scan the real bytes, then purge** — the scan only READS. Nothing from the clone
 *    is ever executed: no install, no build, no test, no script.
 *
 * ## Usage
 *
 *   node tools/repo-recon.mjs owner/name                 # preflight, clone, scan, purge
 *   node tools/repo-recon.mjs owner/name --keep          # keep the clone for reading
 *   node tools/repo-recon.mjs owner/name --preflight     # decide without cloning
 *   node tools/repo-recon.mjs owner/name --yes           # clone despite a caution
 *   node tools/repo-recon.mjs --purge                    # remove every leftover clone
 *   node tools/repo-recon.mjs --list                     # what is on disk right now
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, readdirSync, rmSync, statSync, readFileSync, lstatSync, readlinkSync, mkdirSync } from 'node:fs'
import { join, relative, resolve, sep, extname } from 'node:path'
import { tmpdir } from 'node:os'

/** Every clone lives under one prefix so a purge is exact and complete. */
const RECON_PREFIX = 'dsh-recon-'
const RECON_ROOT = join(tmpdir(), `${RECON_PREFIX}root`)

/** Files that can cause code to run, and why each matters. */
const EXECUTION_SURFACE = [
  { path: '.gitmodules', why: 'submodules pull a second repository that may not have been reviewed', level: 'caution' },
  { path: '.gitattributes', why: 'a filter= entry can shell out; LFS smudge downloads and may invoke a helper', level: 'caution' },
  { path: 'binding.gyp', why: 'native builds run arbitrary build steps on install', level: 'caution' },
  { path: 'setup.py', why: 'Python install hooks execute', level: 'caution' },
  { path: 'install.sh', why: 'a typical curl|sh target', level: 'caution' },
  { path: 'postinstall.js', why: 'executed by npm', level: 'caution' },
  // Presence alone is NOT a caution: nearly every JavaScript project has one, and a
  // tool that flags them all teaches the reader to pass --yes without looking. The
  // hooks are checked separately, below, and those are the thing that executes.
  { path: 'package.json', why: 'a manifest; its install hooks are checked separately', level: 'info' },
  { path: 'Dockerfile', why: 'runs nothing on clone, but signals what the project expects to execute', level: 'info' },
]

/**
 * Patterns in the real bytes that deserve a human look before anything is run.
 *
 * ## These run on CODE ONLY, never on documentation
 *
 * The first version scanned every text file and produced nothing but false alarms on
 * the first repository it met:
 *
 * - `install-hook` matched a custom `"install": { … }` config block, because the regex
 *   looked for that key anywhere in the file instead of inside `scripts`.
 * - `exfil-env` matched a README line reading *"It does **not** … rewrite
 *   `process.env`, or replace the global fetch dispatcher"* — a security CLAIM, flagged
 *   as a security RISK.
 * - `credential-read` matched a deny-list of glob paths the plugin refuses to read
 *   (npm and pypi config files), flagged as credential theft.
 *
 * Three hits, three false positives, one root cause: the patterns matched MENTIONS of
 * dangerous things rather than USES of them, and prose about security is exactly where
 * those mentions live. Reporting that would have smeared a legitimate project using a
 * broken tool, which is worse than not scanning at all.
 *
 * So: code extensions only; `install-hook` is checked structurally against `scripts`;
 * and documentation is listed separately as "mentions" for a human to read, never as a
 * finding.
 */
const RISK_PATTERNS = [
  { id: 'shell-pipe', re: /\b(?:curl|wget)\b[^\n|]{0,120}\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, why: 'pipes a remote script straight into a shell' },
  { id: 'eval-remote', re: /\beval\s*\(\s*(?:await\s+)?(?:fetch|require\s*\(\s*['"]https?)/, why: 'evaluates remotely fetched code' },
  { id: 'exfil-env', re: /\b(?:process\.env|os\.environ)\b[^\n]{0,80}\b(?:fetch|axios|request|https?\.request|urllib)\b/, why: 'reads environment variables and sends them somewhere' },
  { id: 'credential-read', re: /(?:\.ssh[/\\]id_|\.aws[/\\]credentials|gh[/\\]hosts\.yml)/, why: 'reads a private key or a credential store directly' },
  { id: 'dynamic-exec', re: /\bnew\s+Function\s*\(|\bvm\.runIn\w+\s*\(/, why: 'dynamic code execution' },
  { id: 'child-exec', re: /\bchild_process\b[^\n]{0,40}\b(?:exec|execSync)\s*\(/, why: 'spawns a shell command' },
  { id: 'encoded-blob', re: /(?:[A-Za-z0-9+/]{400,}={0,2})/, why: 'a very long base64 run is usually packed code' },
]

/** Extensions where a match means code. Everything else is treated as prose. */
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.ps1', '.rb', '.go', '.rs'])

/** Directories never worth scanning. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor'])

/** Read one CLI flag's value. */
function flag(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : undefined
}

/** Run gh and return parsed JSON, or undefined. */
function ghJson(path) {
  try {
    const out = execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(out)
  } catch {
    return undefined
  }
}

/** Run gh and return text, or ''. */
function ghText(path) {
  try {
    return execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}

/**
 * Phase 1 — decide while the code is still remote.
 *
 * @param {string} repo owner/name
 * @returns {{ verdict: 'safe'|'caution'|'refuse', sizeKb: number, findings: {level: string, text: string}[], meta: any }}
 */
function preflight(repo) {
  const findings = []
  const meta = ghJson(`repos/${repo}`)
  if (meta === undefined) {
    return { verdict: 'refuse', sizeKb: 0, findings: [{ level: 'refuse', text: 'the repository could not be read (404, or no access)' }], meta: undefined }
  }

  const sizeKb = Number(meta.size ?? 0)
  // 1. Metadata.
  if (meta.archived === true) findings.push({ level: 'caution', text: 'the repository is archived' })
  if (meta.disabled === true) findings.push({ level: 'refuse', text: 'the repository is disabled' })
  if (meta.fork === true) findings.push({ level: 'caution', text: `it is a fork of ${meta.parent?.full_name ?? 'unknown'}` })
  if (sizeKb > 200_000) findings.push({ level: 'refuse', text: `it is ${Math.round(sizeKb / 1024)} MB — too large to clone casually` })
  else if (sizeKb > 50_000) findings.push({ level: 'caution', text: `it is ${Math.round(sizeKb / 1024)} MB — a shallow clone is still large` })

  // 2. The execution surface, read WITHOUT cloning.
  const tree = ghJson(`repos/${repo}/git/trees/${encodeURIComponent(meta.default_branch ?? 'main')}?recursive=1`)
  const paths = Array.isArray(tree?.tree) ? tree.tree.map((entry) => String(entry.path)) : []
  if (tree?.truncated === true) findings.push({ level: 'caution', text: 'the file tree was truncated, so this scan is partial' })

  for (const { path, why, level } of EXECUTION_SURFACE) {
    const hit = paths.find((p) => p === path || p.endsWith(`/${path}`))
    if (hit === undefined) continue
    findings.push({ level, text: `${hit} is present — ${why}` })
  }

  // 3. Two files whose CONTENT decides, not their presence: a manifest's install hooks
  //    and a attributes file's filters. Both are fetched and READ here — never run.
  const pkgPath = paths.find((p) => p === 'package.json')
  if (pkgPath !== undefined) {
    const raw = ghText(`repos/${repo}/contents/${pkgPath}`)
    try {
      const decoded = Buffer.from(JSON.parse(raw).content ?? '', 'base64').toString('utf8')
      const pkg = JSON.parse(decoded)
      const hooks = Object.keys(pkg.scripts ?? {}).filter((k) => /^(pre|post)?install$/.test(k))
      if (hooks.length > 0) {
        findings.push({
          level: 'caution',
          text: `package.json declares install hooks (${hooks.join(', ')}) — NEVER run npm/pnpm install in this tree`,
        })
      }
    } catch {
      findings.push({ level: 'info', text: 'package.json could not be parsed; treat its hooks as unknown' })
    }
  }
  const attrPath = paths.find((p) => p === '.gitattributes')
  if (attrPath !== undefined) {
    const raw = ghText(`repos/${repo}/contents/${attrPath}`)
    try {
      const decoded = Buffer.from(JSON.parse(raw).content ?? '', 'base64').toString('utf8')
      const filters = decoded.split('\n').filter((line) => /\bfilter\s*=/.test(line))
      if (filters.length > 0) {
        findings.push({
          level: 'caution',
          text: `.gitattributes declares a filter (${filters[0].trim()}) — smudge can execute a helper`,
        })
      }
    } catch {
      findings.push({ level: 'info', text: '.gitattributes could not be parsed; its filters are unknown' })
    }
  }

  const verdict = findings.some((f) => f.level === 'refuse')
    ? 'refuse'
    : findings.some((f) => f.level === 'caution') ? 'caution' : 'safe'
  return { verdict, sizeKb, findings, meta: { full_name: meta.full_name, stars: meta.stargazers_count, license: meta.license?.spdx_id ?? 'none', pushed_at: meta.pushed_at, default_branch: meta.default_branch } }
}

/**
 * Phase 2 — clone with every executing feature turned off.
 *
 * `core.symlinks=false` makes git write a symlink as a small text file holding its
 * target instead of creating it, so a link pointing at `~/.ssh` cannot become a real
 * path inside the tree. `core.hooksPath` is diverted to an empty directory so that no
 * hook can run even if a later git command inside the clone would invoke one.
 *
 * @param {string} repo owner/name
 * @param {string} dir destination
 * @returns {{ ok: boolean, detail: string }}
 */
function safeClone(repo, dir) {
  const emptyHooks = join(RECON_ROOT, 'empty-hooks')
  mkdirSync(emptyHooks, { recursive: true })
  const args = [
    '-c', 'core.symlinks=false',
    '-c', `core.hooksPath=${emptyHooks}`,
    '-c', 'core.fsmonitor=false',
    'clone',
    '--depth', '1',
    '--single-branch',
    '--no-tags',
    // Deliberately ABSENT: --recurse-submodules. A submodule is a second repository
    // nobody reviewed, and it would be fetched under this tool's authority.
    `https://github.com/${repo}.git`,
    dir,
  ]
  try {
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A Git LFS smudge filter would download and could invoke a helper.
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true, detail: dir }
  } catch (error) {
    return { ok: false, detail: String(error?.stderr ?? error?.message ?? error).split('\n')[0] }
  }
}

/** Every file under a root, skipping the directories never worth scanning. */
function walk(root, limit = 4000) {
  const out = []
  const stack = [root]
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(full)
      } else if (entry.isSymbolicLink()) {
        out.push(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  return out
}

/**
 * Phase 3 — read the real bytes. Nothing here executes anything.
 *
 * @param {string} dir the clone root
 * @returns {{ files: number, symlinks: string[], risks: {file: string, id: string, why: string}[], hooks: string[], mentions: {file: string, id: string}[], largest: {file: string, bytes: number}[] }}
 */
function scan(dir) {
  const files = walk(dir)
  const symlinks = []
  const risks = []
  const hooks = []
  const mentions = []
  const sizes = []

  for (const file of files) {
    // A symlink whose target escapes the clone root is the one that turns "read a
    // file" into "read the user's private key" further down the line.
    try {
      const info = lstatSync(file)
      if (info.isSymbolicLink()) {
        const target = readlinkSync(file)
        const resolved = resolve(join(file, '..'), target)
        if (!resolved.startsWith(resolve(dir) + sep)) symlinks.push(`${relative(dir, file)} -> ${target} (ESCAPES THE CLONE)`)
        else symlinks.push(`${relative(dir, file)} -> ${target}`)
        continue
      }
      sizes.push({ file: relative(dir, file), bytes: info.size })
    } catch {
      continue
    }

    if (statSync(file).size > 1_500_000) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue
    const name = relative(dir, file)
    const isCode = CODE_EXT.has(extname(file).toLowerCase())

    // Install hooks are read STRUCTURALLY, from `scripts`, and only for a manifest.
    // Matching the bare key anywhere in the file found `"install": { … }` config
    // blocks and called them lifecycle scripts.
    if (/(^|[/\\])package\.json$/.test(name)) {
      try {
        const pkg = JSON.parse(text)
        for (const key of Object.keys(pkg.scripts ?? {})) {
          if (/^(pre|post)?install$/.test(key)) hooks.push(`${name}: scripts.${key} = ${String(pkg.scripts[key]).slice(0, 80)}`)
        }
      } catch {
        hooks.push(`${name}: unparseable, so its hooks are unknown — do not run npm install here`)
      }
    }

    // A hit is a FINDING only in code. In prose, the same words are usually a claim
    // about safety, so they are listed as mentions for a human — not as risk.
    for (const { id, re, why } of RISK_PATTERNS) {
      if (!re.test(text)) continue
      if (isCode) risks.push({ file: name, id, why })
      else mentions.push({ file: name, id })
    }
  }
  sizes.sort((a, b) => b.bytes - a.bytes)
  return { files: files.length, symlinks, risks, hooks, mentions, largest: sizes.slice(0, 5) }
}

/** Remove one clone completely and confirm it is gone. */
function purge(dir) {
  if (!existsSync(dir)) return { ok: true, detail: 'already absent' }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) }
  }
  return { ok: existsSync(dir) === false, detail: existsSync(dir) ? 'STILL PRESENT' : 'removed' }
}

/** Every clone this tool has left on disk. */
function listClones() {
  if (!existsSync(RECON_ROOT)) return []
  return readdirSync(RECON_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'empty-hooks')
    .map((entry) => join(RECON_ROOT, entry.name))
}

// ---------------------------------------------------------------------------

if (process.argv.includes('--purge')) {
  const clones = listClones()
  console.log(`purging ${clones.length} clone(s) under ${RECON_ROOT}`)
  let bad = 0
  for (const dir of clones) {
    const outcome = purge(dir)
    if (!outcome.ok) bad += 1
    console.log(`  ${outcome.ok ? 'removed' : 'FAILED '} ${dir} — ${outcome.detail}`)
  }
  // The hooks diversion directory is not a clone, but "completely delete" means the
  // whole root goes: leaving an empty directory behind still tells a later reader that
  // something was here.
  if (existsSync(RECON_ROOT)) {
    try {
      rmSync(RECON_ROOT, { recursive: true, force: true })
    } catch { /* reported below by the existence check */ }
  }
  const rest = listClones()
  const rootGone = existsSync(RECON_ROOT) === false
  console.log(rest.length === 0 && bad === 0 && rootGone
    ? `\nnothing left on disk — ${RECON_ROOT} is gone`
    : `\nSTILL PRESENT: ${RECON_ROOT}${rest.length > 0 ? ` (${rest.join(', ')})` : ''}`)
  process.exitCode = rest.length === 0 && bad === 0 && rootGone ? 0 : 1
} else if (process.argv.includes('--list')) {
  const clones = listClones()
  console.log(clones.length === 0 ? 'no reconnaissance clones on disk' : clones.join('\n'))
} else {
  const repo = process.argv.slice(2).find((arg) => !arg.startsWith('--') && arg !== flag('--out'))
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.log('usage: node tools/repo-recon.mjs owner/name [--preflight] [--keep] [--yes]')
    process.exitCode = 1
  } else {
    console.log(`=== preflight ${repo} (nothing has been downloaded yet) ===`)
    const pre = preflight(repo)
    if (pre.meta !== undefined) {
      const m = pre.meta
      console.log(`  ${m.full_name}  stars ${m.stars}  license ${m.license}  pushed ${String(m.pushed_at).slice(0, 10)}  ${Math.round(pre.sizeKb)} KB`)
    }
    for (const finding of pre.findings) console.log(`  [${finding.level.toUpperCase()}] ${finding.text}`)
    console.log(`  verdict: ${pre.verdict.toUpperCase()}`)

    if (process.argv.includes('--preflight')) {
      console.log('\npreflight only; nothing was cloned')
    } else if (pre.verdict === 'refuse' && !process.argv.includes('--yes')) {
      console.log('\nREFUSED — not cloning. Re-run with --yes only after reading the findings above.')
      process.exitCode = 1
    } else {
      mkdirSync(RECON_ROOT, { recursive: true })
      const dir = mkdtempSync(join(RECON_ROOT, `${repo.replace('/', '-')}-`))
      console.log(`\n=== clone (shallow, no submodules, symlinks as text, hooks diverted) ===\n  ${dir}`)
      const clone = safeClone(repo, dir)
      if (!clone.ok) {
        console.log(`  FAILED: ${clone.detail}`)
        purge(dir)
        process.exitCode = 1
      } else {
        console.log('\n=== scan of the real bytes (read-only; nothing is executed) ===')
        const report = scan(dir)
        console.log(`  files scanned      : ${report.files}`)
        console.log(`  install hooks      : ${report.hooks.length === 0 ? 'none' : report.hooks.join(', ')}`)
        console.log(`  risk pattern hits  : ${report.risks.length} (in code — these are findings)`)
        for (const risk of report.risks.slice(0, 12)) console.log(`      ${risk.file}  [${risk.id}] ${risk.why}`)
        // Prose is listed separately and never as a finding: the same words appear in
        // security claims and deny-lists, which is where the first version's three
        // false positives came from.
        console.log(`  mentions in prose  : ${report.mentions.length} (documentation only — NOT findings)`)
        for (const mention of report.mentions.slice(0, 6)) console.log(`      ${mention.file}  [${mention.id}]`)
        console.log(`  symlinks           : ${report.symlinks.length}`)
        for (const link of report.symlinks.slice(0, 8)) console.log(`      ${link}`)
        console.log(`  largest files      :`)
        for (const big of report.largest) console.log(`      ${String(big.bytes).padStart(9)}  ${big.file}`)

        if (process.argv.includes('--keep')) {
          console.log(`\nkept for reading: ${dir}`)
          console.log(`purge later with: node tools/repo-recon.mjs --purge`)
        } else {
          const outcome = purge(dir)
          console.log(`\n=== purge ===\n  ${outcome.detail}: ${dir}`)
          if (!outcome.ok) process.exitCode = 1
        }
      }
    }
  }
}
