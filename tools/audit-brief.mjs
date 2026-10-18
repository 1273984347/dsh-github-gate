/**
 * The R2 brief.
 *
 * ## What this is, and what it deliberately is not
 *
 * This does NOT run an audit. It prints the brief that a human or an agent hands to an
 * auditor whose context does not include the author's. That separation is the entire
 * mechanism, and it cannot be automated away: an auditor spawned from the same
 * conversation inherits the same assumptions, and the assumptions are what has to be
 * tested.
 *
 * ## Why the project needs it written down
 *
 * `npm run verify` exiting 0 is R1 — a single pass. It was treated as convergence for most
 * of this project's life, and the cost is measurable: six recorded defects where every
 * guard was green and reality disagreed (P-01, P-17, P-24, the encoding blind spot, the
 * diagnostics field, and P-25, where 113 checks passed while the running composition
 * served the previous generation of every skill).
 *
 * The one time an independent auditor ran, it found P-25. It was not spawned by a script
 * and did not recur. This file makes the brief repeatable; it cannot make the auditor
 * independent by itself.
 *
 * ## The rules that make it work
 *
 * Three rules are load-bearing, and each was learned from a failure:
 *
 * 1. **Default to refuted.** The auditor is told every claim is FALSE until the code shows
 *    otherwise. An auditor asked to "check" agrees; one asked to "refute" looks.
 * 2. **A zero-finding report is not evidence.** A neighbouring project's iron law: a
 *    subagent's "0 findings" must be spot-checked by the caller, because silence and
 *    correctness look identical in a report. The brief therefore requires the auditor to
 *    show its search scope and commands even when it finds nothing.
 * 3. **Findings are inputs, not verdicts.** Everything the auditor reports is re-verified
 *    by the caller with an independent tool call before anyone acts on it. The audit that
 *    found P-25 also reported four other findings; the caller confirmed all five, but the
 *    confirmation was the caller's, not the auditor's.
 *
 * Usage:
 *   node tools/audit-brief.mjs            # print the brief
 *   node tools/audit-brief.mjs --claims   # print only the claims under audit
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The script names, which are the gates a claim can be made about. */
const scripts = Object.keys(manifest.scripts ?? {})
/** How many verification tools exist, quoted so the brief is concrete. */
const toolCount = existsSync(join(ROOT, 'tools'))
  ? readdirSync(join(ROOT, 'tools')).filter((f) => f.endsWith('.mjs')).length
  : 0

/**
 * The claims an auditor should be pointed at.
 *
 * Regenerated each run rather than stored, because a stale claim list is an audit of last
 * week's code. The categories are stable; the specifics are read from the tree.
 */
const CLAIMS = [
  `\`npm run verify\` exiting 0 means the bundle is correct. (It runs ${scripts.includes('verify:offline') ? 'offline and live checks' : 'some checks'} but does NOT include: ${['encoding', 'report:check', 'profile:check'].filter((s) => scripts.includes(s)).join(', ') || 'none'}. Check what it actually covers and what it therefore cannot report.)`,
  `Every guard in \`tools/\` (${toolCount} files) can FAIL. A guard that passes everything is not a guard — for each one, construct an input that should fail it and confirm it does.`,
  'The skills in `skills/*/SKILL.md` are what the running composition serves. (Files being correct is not the claim — P-25 was exactly this gap.)',
  'The four webServer routes are gated. (`/dsh-github-gate/branch`, `/branches`, `/diagnostics`, `/switch`.)',
  'Resources are disposed when the plugin unloads, so a reload does not leak or duplicate.',
  'The retrospective report states figures that match the current measurements.',
  'The installed copy in the profile matches the source tree.',
  'Every parameter a tool declares actually reaches the command line it builds.',
  'The plugin survives a composition that has none of the services it can use (`systemPrompt`, `skills`, `webServer`, `workspaceRegistry`, `connection`).',
]

if (process.argv.includes('--claims')) {
  for (const claim of CLAIMS) console.log(`- ${claim}`)
  process.exit(0)
}

/**
 * Where everything is, on THIS machine.
 *
 * The first version of this brief omitted all of it — the repository path, the profile, the
 * installed copy, the DSH installation. Five of the six facts an auditor needs were missing
 * and the only one present was the phrase "npm run", so the brief was a task without the
 * means to do it. Found by checking the brief against a list of what an auditor must know,
 * not by running an audit — a brief is user-facing text and needs the same treatment as
 * anything else.
 *
 * The paths are read from the environment, so a brief generated on another machine is
 * correct on that machine.
 *
 * @returns {string[]} one line per fact
 */
function whereThingsAre() {
  const home = process.env.DSH_HOME ?? '<DSH_HOME>'
  const profile = process.env.DSH_PROFILE_DIR ?? `${home}/profiles/${process.env.DSH_PROFILE ?? 'desktop'}`
  return [
    `- **This repository**: \`${ROOT}\` — the source tree, and where \`npm run\` is executed.`,
    `- **The profile**: \`${profile}\`. The installed copy is at `
      + `\`${profile}/node_modules/${manifest.name}\` and is supposed to be identical to the `
      + 'source; comparing them is one of the claims.',
    '- **The DSH installation**: `D:\\DeepSeek Harness\\app\\resources\\app.asar\\dsh\\`. The '
      + 'asar reads as text and is the AUTHORITY for framework contracts — when a claim is '
      + 'about what the Host does rather than what this plugin does, the answer is in there, '
      + 'not in anyone\'s memory, including the author\'s.',
    `- **The commands**: \`package.json\` lists all ${scripts.length} scripts. \`npm run verify\` `
      + 'is the repository gate; `npm run release` is a superset that also reads this '
      + 'machine\'s installed state; `npm run audit` is this brief.',
    '- **Nothing here is confidential and nothing is fragile.** Read anything, run anything, '
      + 'create files. If you change something, say so in the report.',
  ]
}

console.log(`# The R2 brief — ${manifest.name} ${manifest.version}

Hand this to an auditor **whose context does not include the author's**. Do not summarise
the code for them; the summary is the thing under test. Do not let them read this
conversation.

## Where everything is

${whereThingsAre().join('\n')}

## Standing

You are an INDEPENDENT AUDITOR. You did not write this code and you have no access to the
author's reasoning. Your job is to REFUTE the claims below, not to confirm them.

**Default to refuted.** Assume every claim is FALSE until the code shows otherwise. An
auditor asked to check agrees; one asked to refute looks.

## The claims under audit

${CLAIMS.map((claim, index) => `${index + 1}. ${claim}`).join('\n')}

## Hard requirements — these are not optional

- **Every finding carries the evidence that produced it**: a file and line number, or the
  exact command and its output. A finding without evidence is not a finding.
- **If you report ZERO findings, you must still show evidence.** State exactly which files
  you read and which commands you ran, and quote the key output. Silence and correctness
  look identical in a report, so silence is not accepted as an answer.
- **Prefer class-level findings over instances.** If a guard has a flaw, say so once and
  name the class, rather than listing five symptoms of it.
- **Test each guard adversarially.** Construct an input that SHOULD fail it. If a guard
  cannot be made to fail, say so and explain what it actually verifies.
- **Say what you could not check and why.** A stated blind spot is worth more than a
  confident silence.

## What the caller will do with your report

Per the caller's own rule, **your findings are inputs, not verdicts**: each one will be
re-verified by the caller with an independent tool call before anything is acted on. Your
"0 findings" in particular will NOT be treated as proof that the claims hold.

So: be specific, be harsh, and do not soften a finding to be agreeable. A finding the
caller did not expect is worth more than agreement.

## Output format

For each claim: \`CONFIRMED\` / \`REFUTED\` / \`PARTIAL\`, with evidence.

Then \`## Findings\` with severity P0/P1/P2/P3:
- **P0** — broken or unsafe right now
- **P1** — a claim is materially false, or a guard does not do what it says
- **P2** — a real but contained defect
- **P3** — cosmetic

Then \`## Residual risk\` with at least three things you could not verify and why.
`)
