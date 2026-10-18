/**
 * Validate the guidance layer's shape and its two hard constraints.
 *
 * ## Constraint 1: the prompt section must not collide
 *
 * `systemPrompt.section` throws on "duplicates within one layer", and the repository
 * reserves a fixed set of section names. Picking one of them would fail activation
 * with an error that points at the registry rather than at this file. The reserved
 * list is read from the shipped implementation (SECTION_ORDERS in the asar) and
 * asserted against, so a future rename cannot quietly land on one.
 *
 * ## Constraint 2: a prompt section is paid for on EVERY step
 *
 * Its length is therefore a budget, not a preference. The cap here is a guard against
 * the natural drift of "just one more rule" until the section is a document.
 *
 * ## Constraint 3: skills must satisfy the registration contract
 *
 * `skills.get(name)` documents a kebab-case name, and `SkillRegistration` requires
 * `name`, `description`, `source` and `content`. Each skill's own front matter must
 * also agree with the name it registers under — a mismatch makes the catalog summary
 * disagree with the body the model eventually reads.
 *
 * Usage: node --import ./test/register-hook.mjs tools/probe-guidance.mjs
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  PROMPT_SECTION_TEXT,
  PROVIDER_SKILL_NAMES,
  installGuidance,
} from '../lib/guidance.js'
import { PackSkillProvider, parseSkillText, PACK_RANK, PROVIDER_NAME } from '../lib/skill-provider.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'skills')

/**
 * The real registry, read from the domain modules rather than restated here.
 *
 * Restating it would defeat the purpose: a list copied into a guard drifts from the list
 * the tools are built from, and the drift is invisible until a skill tells the model to
 * call something that no longer exists — the exact failure this section is for.
 */
const TOOLS = new Set()
/** @type {Map<string, Set<string>>} */
const ACTIONS = new Map()
{
  const domainDir = join(ROOT, 'lib', 'domains')
  for (const file of await readdir(domainDir)) {
    if (!file.endsWith('.js')) continue
    const module = await import(new URL(`../lib/domains/${file}`, import.meta.url).href)
    for (const value of Object.values(module)) {
      if (value === null || typeof value !== 'object') continue
      if (typeof value.tool !== 'string' || value.actions === undefined) continue
      TOOLS.add(value.tool)
      ACTIONS.set(value.tool, new Set(Object.keys(value.actions)))
    }
  }
}

/**
 * Every tool reference in a skill body, with the actions attributed to it.
 *
 * Two forms appear in these files and a reader resolves both the same way:
 *
 *     `github_pr` action `view`            ← explicit
 *     `github_pr` action `merge`, `close`  ← the following names belong to the same tool
 *     action `status`                      ← bare; the tool is the nearest one named above
 *
 * The bare form is why this cannot be a single regex. Attributing it to the nearest
 * preceding tool is what a reader does, and a bare action with no preceding tool in the
 * same paragraph is reported as unattributed rather than guessed — guessing would produce
 * a false finding, and a guard that cries wolf gets switched off.
 *
 * @param {string} body the skill body
 * @returns {{tool: string, actions: string[], form: string}[]} the references
 */
function referencesIn(body) {
  const out = []
  // Split into blocks so a bare `action` cannot borrow a tool from far away.
  for (const block of body.split(/\n\s*\n/)) {
    const tokens = [...block.matchAll(/`(github_[a-z_]+)`|action\s+((?:`[A-Za-z]+`(?:\s*,\s*)?)+)/g)]
    let current = undefined
    for (const token of tokens) {
      if (token[1] !== undefined) {
        current = token[1]
        out.push({ tool: current, actions: [], form: 'named' })
        continue
      }
      const names = [...token[2].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1])
      if (current === undefined) {
        // No tool in scope. Reported, not attributed — see above.
        out.push({ tool: '', actions: names, form: 'unattributed' })
        continue
      }
      out.push({ tool: current, actions: names, form: 'actions' })
    }
  }
  return out
}

/** Section names the repository owns, read from SECTION_ORDERS in the shipped build. */
const RESERVED_SECTION_NAMES = new Set([
  'HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_PREFIX', 'PLAN_POLICY', 'TEAM_POLICY', 'PTC_ONLY',
  'FILE_REFERENCE', 'TOOL_BASH', 'TOOL_PWSH', 'TOOL_READ', 'TOOL_WRITE', 'TOOL_EDIT', 'TOOL_GLOB',
  'TOOL_GREP', 'TOOL_JOBS', 'TOOL_PTY', 'TOOL_WEB_SEARCH', 'TOOL_WEB_FETCH', 'TOOL_LSP',
  'TOOL_SESSION_QUERY', 'TOOL_GOAL', 'TOOL_WORKFLOW', 'TOOL_RALPH', 'TOOL_SUBAGENT', 'TOOL_REPORT',
  'TOOL_COMPUTER_USE', 'MCP_SERVERS', 'TOOLS_SDK', 'DELIVERABLE_FILE_REFERENCES',
  'STRUCTURED_OUTPUT', 'HARNESS_SOURCE', 'WEB_SURFACE', 'DEPLOYMENT_PERSONA_SUFFIX',
])

/** The tool band the repository uses for its own tool guidance, and its bounds. */
const TOOL_BAND = { first: 1000, last: 3100, sdk: 5000 }

/** A prompt section is paid for on every step; this is its budget. */
const PROMPT_SECTION_MAX_CHARS = 2_400

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

// ---------------------------------------------------------------------------
// The prompt section.
// ---------------------------------------------------------------------------
check(!RESERVED_SECTION_NAMES.has(PROMPT_SECTION_NAME),
  `the section name ${PROMPT_SECTION_NAME} is not one the repository reserves`,
  RESERVED_SECTION_NAMES.has(PROMPT_SECTION_NAME)
    ? 'COLLISION — registering it would throw on activation'
    : 'no collision')
check(Number.isFinite(PROMPT_SECTION_ORDER), 'the order is a finite number (a non-finite order throws)',
  String(PROMPT_SECTION_ORDER))
check(PROMPT_SECTION_ORDER > TOOL_BAND.last && PROMPT_SECTION_ORDER < TOOL_BAND.sdk,
  `the order ${PROMPT_SECTION_ORDER} sits after the built-in tool band and before TOOLS_SDK`,
  `band ${TOOL_BAND.first}–${TOOL_BAND.last}, TOOLS_SDK ${TOOL_BAND.sdk}`)
check(PROMPT_SECTION_TEXT.length > 0 && PROMPT_SECTION_TEXT.length <= PROMPT_SECTION_MAX_CHARS,
  `the section fits its ${PROMPT_SECTION_MAX_CHARS}-character budget`,
  `${PROMPT_SECTION_TEXT.length} characters`)
check(PROMPT_SECTION_TEXT.startsWith('## '),
  'the section starts with a markdown heading, as the repository sections do')
// Every rule must be actionable. A rule that names no tool or action is a platitude,
// and platitudes are what makes a prompt section not worth its tokens. The check reads
// the WHOLE rule — rules wrap across lines, and a first line that says "Read before you
// write" is not less actionable for having its tool names on the next line.
const rules = []
for (const line of PROMPT_SECTION_TEXT.split('\n')) {
  if (/^\d+\.\s\*\*/.test(line)) rules.push(line)
  else if (rules.length > 0 && /^\s{3}\S/.test(line)) rules[rules.length - 1] += ` ${line.trim()}`
}
check(rules.length >= 4, `the section carries numbered rules (${rules.length})`)
for (const rule of rules) {
  check(/github_[a-z_]+|`gh`/.test(rule), 'every rule names a tool or the gh binary',
    rule.slice(0, 100))
}

// ---------------------------------------------------------------------------
// The skills: the real FILES, read from disk.
//
// The guard reads what the provider reads. An earlier version validated an in-memory
// array inside guidance.js, which meant it validated a copy of the instructions rather
// than the instructions — and the two could disagree without anything noticing.
// ---------------------------------------------------------------------------
const provider = new PackSkillProvider({ logger: { warn: () => {}, info: () => {} } })
const candidates = await provider.list()

check(candidates.length >= 2, `at least two workflows are shipped (${candidates.length})`,
  candidates.map((c) => c.name).join(', '))

// The declared list must match the directories. If they diverge the diagnostics route
// reports names that do not exist, or omits ones that do.
const declared = [...PROVIDER_SKILL_NAMES].sort()
const actual = candidates.map((c) => c.name).sort()
check(JSON.stringify(declared) === JSON.stringify(actual),
  'PROVIDER_SKILL_NAMES matches the real skill directories',
  JSON.stringify(declared) === JSON.stringify(actual) ? actual.join(', ') : `declared ${declared.join(', ')} vs on disk ${actual.join(', ')}`)

const directories = (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
check(directories.length === candidates.length,
  'no skill directory is silently skipped (a skipped one means unusable frontmatter)',
  `${directories.length} directories, ${candidates.length} offered`)

for (const candidate of candidates) {
  const label = `skill ${candidate.name}`
  check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name),
    `${label}: the name is kebab-case, as skills.get(name) documents`)
  check(typeof candidate.description === 'string' && candidate.description.length > 20,
    `${label}: has a description long enough to be discoverable`, candidate.description.slice(0, 60))
  check(typeof candidate.whenToUse === 'string' && candidate.whenToUse.length > 0,
    `${label}: declares whenToUse, which is what makes it load at the right moment`)
  check(candidate.rank === PACK_RANK,
    `${label}: ranks ${PACK_RANK}, below project/user/custom roots (100-500), so a user's own skill wins`,
    String(candidate.rank))
  check(candidate.source === 'bundled', `${label}: declares a source`, String(candidate.source))
  check(candidate.resourceBase?.kind === 'directory' && typeof candidate.resourceBase.path === 'string',
    `${label}: carries a directory resourceBase, so relative references in the body resolve`,
    JSON.stringify(candidate.resourceBase))

  // The body is loaded through the same call the registry makes, so this checks the real
  // path rather than the candidate.
  const full = await provider.get(candidate)
  check(full !== undefined && typeof full.content === 'string' && full.content.length > 200,
    `${label}: loads a body`, full === undefined ? 'get() returned undefined' : `${full.content.length} chars`)
  const body = String(full?.content ?? '')

  check(body.includes('## Workflow'), `${label}: states a workflow`)
  check(/## Stop when/.test(body), `${label}: states a stop condition`,
    'an agent that does not know when to stop keeps calling tools')
  // Every workflow ends somewhere different, so the boundary is per skill rather than
  // only in the shared prompt section.
  check(/## Write boundary/.test(body), `${label}: states its own write boundary`,
    'approving a PR and re-running a workflow are not the same permission')
  check(/github_[a-z_]+/.test(body), `${label}: names the tools it drives`)
  check(candidate.invocation?.modelInvocable === true, `${label}: is model-invocable`)

  // Directory, frontmatter and catalog name must be one name, not three.
  const raw = await readFile(join(SKILLS_DIR, candidate.name, 'SKILL.md'), 'utf8')
  const parsed = parseSkillText(raw)
  check(parsed?.fields?.name === candidate.name,
    `${label}: the frontmatter name equals the directory name`,
    `frontmatter says "${parsed?.fields?.name}", directory is "${candidate.name}"`)

  // ---------------------------------------------------------------------------
  // Every tool and action a skill names must actually exist.
  //
  // This section exists because the check above — `/github_[a-z_]+/` — only proves that
  // SOME name with the right shape appears. It would pass for `github_nonexistent`, and it
  // would pass after renaming an action here without touching the instructions, which is
  // the failure that matters: the skill would confidently tell the model to call something
  // that is not there.
  //
  // That is the "impact surface" problem from a neighbouring project's methodology index
  // (`改动后影响面扫描`): changing an attribute obliges you to find everything that
  // REFERENCES the attribute. Here the attribute is an action name and the references are
  // these files, so the scan is mechanical rather than a matter of remembering.
  // ---------------------------------------------------------------------------
  for (const { tool, actions, form } of referencesIn(body)) {
    if (!TOOLS.has(tool)) {
      check(false, `${label}: names a real tool`,
        `\`${tool}\` is not one of: ${[...TOOLS].join(', ')}`)
      continue
    }
    if (actions.length === 0) {
      check(true, `${label}: \`${tool}\` is real`, form)
      continue
    }
    const bad = actions.filter((action) => !ACTIONS.get(tool).has(action))
    check(bad.length === 0,
      `${label}: \`${tool}\` names real actions`,
      bad.length === 0
        ? `${actions.join(', ')}`
        : `${bad.join(', ')} — ${tool} has: ${[...ACTIONS.get(tool)].join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Registration, against a fake service pair.
// ---------------------------------------------------------------------------
/** A context exposing the two services and recording what they were given. */
function makeCtx(services) {
  const listeners = []
  return {
    logger: { info: () => {}, warn: () => {} },
    get: (name) => services[name],
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (event, listener) => { if (event === 'internal/service') listeners.push(listener); return () => {} },
    listeners,
  }
}

{
  const sections = []
  const providers = []
  const ctx = makeCtx({
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    skills: { registerProvider: (create) => { providers.push(create); return () => {} } },
  })
  const outcome = installGuidance(ctx, { logger: ctx.logger })
  check(sections.length === 1, 'exactly one prompt section is registered', String(sections.length))
  check(sections[0]?.name === PROMPT_SECTION_NAME && sections[0]?.order === PROMPT_SECTION_ORDER,
    'the registered section carries the declared name and order',
    `${sections[0]?.name} @ ${sections[0]?.order}`)
  check(typeof sections[0]?.text === 'string' && sections[0].text.length > 0,
    'the registered section carries text, not a provider that could fail later')

  // The skills half registers a PROVIDER, not finished skills. Asserted because the
  // difference is the whole point: a provider re-reads its bodies from disk, so editing
  // a SKILL.md does not need the plugin re-activated.
  check(providers.length === 1, 'exactly one skill provider is registered', String(providers.length))
  check(typeof providers[0] === 'function', 'the provider is registered as a lazy factory')
  const built = providers[0]()
  check(built?.name === PROVIDER_NAME && typeof built.list === 'function' && typeof built.get === 'function',
    'the factory builds a provider with the list/get contract', JSON.stringify({ name: built?.name }))
  const listed = await built.list()
  check(listed.length === candidates.length,
    `the registered provider serves the same catalog the guard read (${listed.length})`)
  check(listed.every((c) => typeof c.locator?.dir === 'string'),
    'every candidate carries a locator, which is how get() finds its file again')

  check(outcome.sectionName === `${PROMPT_SECTION_NAME} @ ${PROMPT_SECTION_ORDER}`,
    'the reported section name carries its placement, so the diagnostics route can print it',
    outcome.sectionName)
}

// ---------------------------------------------------------------------------
// A composition with neither service: the tools must still work.
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({})
  let threw = false
  try {
    const outcome = installGuidance(ctx, { logger: ctx.logger })
    check(outcome.promptSection === false && outcome.skills.length === 0,
      'a composition with no guidance services installs nothing and reports it',
      JSON.stringify(outcome))
  } catch (error) {
    threw = true
    check(false, 'a composition with no guidance services must not throw', String(error?.message ?? error))
  }
  if (!threw) check(true, 'a composition with no guidance services must not throw', 'returned cleanly')

  // And they arrive later, which is the common case.
  const late = makeCtx({})
  let lateSections = 0
  let lateProviders = 0
  installGuidance(late, { logger: late.logger })
  late.get = (name) => (name === 'systemPrompt'
    ? { section: () => { lateSections += 1; return () => {} } }
    : name === 'skills'
      ? { registerProvider: () => { lateProviders += 1; return () => {} } }
      : undefined)
  for (const listener of late.listeners) {
    listener('systemPrompt')
    listener('skills')
  }
  check(lateSections === 1 && lateProviders === 1,
    'services that arrive later are picked up by the same announcement mechanism',
    `sections=${lateSections} providers=${lateProviders}`)
}

const failed = results.filter((r) => !r.ok)
for (const item of results) {
  if (!item.ok) console.log(`FAIL  ${item.name}\n      ${item.detail}`)
}
console.log(`guidance: ${candidates.length} skill files, prompt section ${PROMPT_SECTION_TEXT.length} chars`)
console.log(`=== ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length > 0) {
  console.log('failed:')
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
