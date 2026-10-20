/**
 * Every script under `tools/` must be reachable from something, or say why not.
 *
 * ## The defect class this catches
 *
 * This repository had 29 scripts in `tools/`: two were invoked by CI, twenty-five by
 * `npm run` aliases, and four by nothing at all. The important case was not the four.
 * `tools/verify-bundle.mjs` — the gate that caught three real packaging omissions —
 * was in CI's blind spot too, and the only thing that made it run was a person
 * remembering to type it. **A guard whose only trigger is human memory is not a guard.**
 *
 * A gate cannot demand "everything runs in CI": several scripts need a local DSH
 * installation and would only ever fail on a runner. So the rule is about
 * *reachability with a reason*:
 *
 * 1. A script referenced by `package.json` scripts, a CI workflow, a test, or another
 *    tool is reachable — fine.
 * 2. A `verify-*` / `check-*` script (a GATE) must additionally appear in a CI
 *    workflow, or be listed in `docs/script-baseline.json` with the reason it cannot.
 * 3. Anything else must be listed in the baseline with a reason.
 * 4. A baseline entry that is no longer needed — script deleted, or now referenced —
 *    is itself a finding. An exemption nobody re-examines is how a gate rots.
 *
 * @module tools/check-script-coverage
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Reporter } from './lib/report.mjs'

/**
 * Read the JSON baseline, tolerating absence.
 * @param {string} root the package root
 * @returns {{ scripts: Record<string, string> }} the baseline
 */
function readBaseline(root) {
  const path = join(root, 'docs', 'script-baseline.json')
  if (!existsSync(path)) return { scripts: {} }
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return { scripts: parsed.scripts ?? {} }
}

/**
 * Strip comments before scanning for a script name.
 *
 * This is the defect this repository has now recorded four times: a pattern check
 * reads PROSE and reports it as code. It happened here immediately — `ci.yml`
 * explains in a comment why `verify-bundle.mjs` cannot run in CI, and the raw scan
 * counted that explanation as "it runs in CI", which made a correct exemption look
 * stale. The same shape made `verify-bundle` flag its own explanatory comment and
 * made an earlier audit flag a README sentence as exfiltration.
 *
 * Only whole-line comments are removed, for every format. A `#` or `//` inside a
 * string is not a comment, and truncating at one could hide a real reference.
 *
 * @param {string} text the file content
 * @param {'json' | 'yaml' | 'code'} kind how to strip
 * @returns {string} content with comment lines removed
 */
function stripComments(text, kind) {
  if (kind === 'json') {
    // Comments are not valid JSON, so there is nothing to strip; references must come
    // from the parsed `scripts` values, which the caller passes separately.
    return text
  }
  const marker = kind === 'yaml' ? '#' : '//'
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(marker))
    .join('\n')
}

/**
 * Collect every text blob a script name could appear in.
 *
 * Deliberately broader than "the npm scripts block": a script can be reached from a
 * test that spawns it, or from another tool that calls it, and both count as reachable.
 * Comments are stripped from every source, because a comment that NAMES a script is
 * documentation about it, not a reference to it.
 *
 * @param {string} root the package root
 * @returns {{ label: string, text: string }[]} readable sources
 */
function collectSources(root) {
  const sources = []
  const push = (path, label, kind) => {
    try {
      sources.push({ label, text: stripComments(readFileSync(path, 'utf8'), kind) })
    } catch { /* unreadable: it cannot reference anything then */ }
  }

  // package.json: only the script COMMANDS count. A script name mentioned in a
  // description or a `files` entry is not a reference.
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    sources.push({ label: 'package.json', text: Object.values(manifest.scripts ?? {}).join('\n') })
  } catch { /* no manifest, nothing to reference */ }

  push(join(root, 'Makefile'), 'Makefile', 'code')

  const workflowDir = join(root, '.github', 'workflows')
  if (existsSync(workflowDir)) {
    for (const name of readdirSync(workflowDir)) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) {
        push(join(workflowDir, name), `.github/workflows/${name}`, 'yaml')
      }
    }
  }

  for (const dir of ['test', 'tools']) {
    const full = join(root, dir)
    if (!existsSync(full)) continue
    for (const name of readdirSync(full)) {
      if (!name.endsWith('.mjs')) continue
      push(join(full, name), `${dir}/${name}`, 'code')
    }
  }
  return sources
}

/**
 * Check script reachability.
 * @param {string} root the package root
 * @returns {Reporter} the collected results
 */
export function checkScriptCoverage(root) {
  const reporter = new Reporter()
  const toolsDir = join(root, 'tools')
  if (!existsSync(toolsDir)) {
    reporter.check(true, 'no tools/ directory to police')
    return reporter
  }

  const scripts = readdirSync(toolsDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort()
  const allSources = collectSources(root)
  const baseline = readBaseline(root)

  /** Whether any place other than the script itself names it. */
  const referencedBy = (name) => allSources
    .filter((source) => source.text.includes(name))
    // `tools/<name>` is the script's own file; skip self-references from tools/ where
    // the string is just a path constant naming this very file.
    .filter((source) => !(source.label === `tools/${name}`))
    .map((source) => source.label)

  const unreachable = []
  const gatesNotInCi = []
  const staleExemptions = []
  const seen = new Set()

  for (const name of scripts) {
    const sources = referencedBy(name)
    const isGate = /^(verify|check)-/.test(name)
    const inCi = sources.some((label) => label.startsWith('.github/workflows/'))
    const exemption = baseline.scripts[name]

    // An exemption is "needed" for exactly the condition it excepts:
    //   - a non-gate: nothing references it at all;
    //   - a gate: it runs everywhere except CI.
    // Being reachable from `package.json` was never the problem being excepted, so it
    // must not count as staleness — the first version of this loop did that and
    // reported every working exemption as stale.
    const exemptionNeeded = sources.length === 0 || (isGate && !inCi)

    if (exemption !== undefined) {
      seen.add(name)
      if (!exemptionNeeded) {
        staleExemptions.push(`${name} no longer needs an exemption (`
          + (sources.length === 0 ? 'it no longer exists' : sources.length > 0 && inCi ? 'it now runs in CI' : `now reachable via ${sources.join(', ')}`) + ')')
      }
      continue
    }
    if (sources.length === 0) {
      unreachable.push(`${name} (referenced by nothing)`)
      continue
    }
    if (isGate && !inCi) {
      // A gate that nothing runs on every push is indistinguishable from no gate.
      gatesNotInCi.push(`${name} -> ${sources.join(', ')}`)
    }
  }

  for (const name of Object.keys(baseline.scripts)) {
    if (!seen.has(name) && !scripts.includes(name)) {
      staleExemptions.push(`${name} is exempted but does not exist`)
    }
  }

  reporter.check(unreachable.length === 0,
    `every tools/ script is reachable from a script, workflow, test or another tool (${scripts.length} scripts)`,
    unreachable.length === 0 ? 'all reachable' : `${unreachable.join('; ')} — wire it or put it in docs/script-baseline.json with a reason`)

  reporter.check(gatesNotInCi.length === 0,
    'every verify-*/check-* gate runs in CI, or is exempted with a reason',
    gatesNotInCi.length === 0 ? 'all gates wired' : gatesNotInCi.join('; '))

  reporter.check(staleExemptions.length === 0,
    'no stale entry in docs/script-baseline.json',
    staleExemptions.join('; '))

  // The baseline must carry a REASON, not just a name. An exemption without one is how
  // a gate quietly becomes optional.
  const reasonless = Object.entries(baseline.scripts)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 20)
    .map(([name]) => name)
  reporter.check(reasonless.length === 0,
    'every baseline exemption states a reason (>=20 characters)',
    reasonless.length === 0 ? `${Object.keys(baseline.scripts).length} exemption(s) documented` : reasonless.join('; '))

  return reporter
}

// CLI entry: `node tools/check-script-coverage.mjs`
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { printResults, finish } = await import('./lib/report.mjs')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const reporter = checkScriptCoverage(root)
  printResults(reporter.results)
  finish(reporter.results)
}
