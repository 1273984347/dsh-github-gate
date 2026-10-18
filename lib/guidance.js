/**
 * The guidance layer: what the agent must know that the tool schemas cannot say.
 *
 * ## Why this file exists
 *
 * The plugin's nine tools answer "what can be called". They do not answer the
 * questions that decide whether the calls are any good: which capability applies to
 * this task, in what order, what evidence is required before a conclusion, when to
 * STOP, and what to do when the path is broken. Those questions have answers, and
 * every one of them in this file was paid for during development — several of them
 * with a wasted round of diagnosis.
 *
 * A neighbouring project in this ecosystem (`dsh-github-skills`) puts the split
 * well: a provider plugin makes the agent ABLE, while a guidance layer makes it
 * organise those abilities correctly. This is that layer for this plugin.
 *
 * ## Two mechanisms, chosen deliberately
 *
 * - **A system-prompt section** for the rules that must never be missed. It costs
 *   tokens on EVERY step, so it is kept to the non-obvious and the non-negotiable.
 *   Its order follows the repository's own convention: tool guidance occupies the
 *   1000–3100 band (`TOOL_BASH` 1000 … `COMPUTER_USE` 3000, `MCP_SERVERS` 3100),
 *   so a third-party tool section sits at 3200 — after the built-in tools and after
 *   MCP, before `TOOLS_SDK` at 5000. Note that `getSectionOrder()` only resolves the
 *   repository's reserved names and returns `undefined` for anything else, and a
 *   non-finite order THROWS, so the number must be a literal.
 *
 * - **Skills** for the workflows. They are loaded on demand, so they can be long
 *   and specific without taxing every step.
 *
 * Both are registered only when the composition provides the service — a headless
 * profile has neither, and the tools must keep working there.
 */

import { installWhenAvailable } from './deferred.js'
import { registerSkillProvider, PROVIDER_NAME } from './skill-provider.js'

/**
 * The section name. A plugin-owned name in the same shape as the repository's own
 * (`TOOL_BASH`, `TOOL_WEB_SEARCH`, …).
 */
export const PROMPT_SECTION_NAME = 'TOOL_GITHUB'

/**
 * Where the section sorts. See the header: the tool band ends at MCP_SERVERS 3100.
 */
export const PROMPT_SECTION_ORDER = 3200

/**
 * The always-present rules.
 *
 * Every line here is something the tool schemas cannot express and a plausible
 * agent would otherwise get wrong. Anything a schema already says is deliberately
 * absent — this section is paid for on every step.
 */
export const PROMPT_SECTION_TEXT = [
  '## GitHub tools (github_*)',
  '',
  'These tools wrap the `gh` CLI against the workspace\'s own git remote. Six rules are not',
  'visible in the schemas:',
  '',
  '1. **Before reporting that GitHub is broken, run `github_auth` with action `probe`.** Action',
  '   `status` reports what is CONFIGURED (is gh installed, is there a credential); `probe`',
  '   reports what WORKS now, layer by layer, with timings, and names the layer that failed.',
  '   The two can disagree, and the disagreement is the answer.',
  '2. **Do not retry a failing `gh` call in a loop.** Run the probe once and report the broken',
  '   layer and its recommendation. Retrying a broken path burns turns without changing it.',
  '3. **Prefer a typed action over `github_api`.** The escape hatch exists for endpoints the',
  '   typed actions do not cover. `gh` gives each subcommand its own `--json` field vocabulary',
  '   (`gh repo list` uses `nameWithOwner`, `gh search repos` uses `fullName`), and the typed',
  '   actions already normalise that.',
  '4. **A destructive action asks the user, and the answer may be no.** `github_repo` action',
  '   `delete`, `github_pr` action `merge`, `github_issue` action `close` and `github_actions`',
  '   action `rerun` all raise a prompt. `confirm: true` states your own intent; it is not their',
  '   consent. Do not look for a way around it, and do not treat approval for one action as approval',
  '   for the next.',
  '5. **Read before you write.** `github_pr` action `view` before `merge`, `github_issue` action',
  '   `view` before `close`, `github_release` action `view` before `delete`. The read is also how you',
  '   find the id the write needs.',
  '6. **A branch is not a pull request.** The checked-out branch heads a PR only when someone made it',
  '   so. `github_pr` action `status` reports CI for the branch you are on; action `list` with `head`',
  '   finds the pull request whose head it is.',
].join('\n')

/**
 * Skills: the workflows, loaded only when they apply.
 *
 * They live as files under `skills/<name>/SKILL.md` and are served by
 * `lib/skill-provider.js` — see that file for why a provider rather than inline
 * content. Each body carries the evidence a conclusion needs, the write boundary for
 * that particular workflow, and an explicit stop condition, because an agent that does
 * not know when to stop keeps calling tools.
 */

/**
 * What this installation registered, returned so the caller can publish it.
 *
 * Deliberately NOT module-level state. Both halves register LAZILY — the service may
 * arrive long after `apply` — so the answer changes over time and must be read through
 * the returned object. A module-level singleton would also be shared by every context
 * in the process, which makes test order decide test results, and that is a class of
 * flakiness this project has already paid for.
 *
 * The guidance layer has no UI of its own: a prompt section either is or is not in the
 * prompt, and a skill either is or is not in the catalog. Both fail invisibly, so the
 * caller publishes this where the rest of the plugin's state already is.
 *
 * @typedef {{ promptSection: boolean, skills: string[], sectionName: string }} GuidanceState
 */

/**
 * The skill directory names this package ships, in catalog order.
 *
 * Only used to report WHICH skills a count refers to. The names that actually reach the
 * registry come from each SKILL.md frontmatter, and the provider refuses a file whose
 * name disagrees with its directory. Keeping a list here would let the two drift, so the
 * guard checks it against the real directories rather than trusting it.
 */
export const PROVIDER_SKILL_NAMES = ['github-pr-review', 'github-ci-triage', 'github-issue-to-pr']

/**
 * The provider name, re-exported so a reader can see the catalog entry's provider field
 * without opening another module.
 */
export { PROVIDER_NAME }

/**
 * Register the guidance, each half only where its service exists.
 *
 * The skills half is ASYNCHRONOUS — the provider reads the catalog from disk once so it
 * can report a count — but it is fired and not awaited: activation must not block on the
 * filesystem, and a slow or missing directory simply reports zero.
 *
 * @param {any} ctx the plugin context
 * @param {{ logger?: any }} [options] logging
 * @returns {GuidanceState} the live state, updated as the lazy halves register
 */
export function installGuidance(ctx, options = {}) {
  const { logger } = options
  /** @type {GuidanceState} */
  const state = { promptSection: false, skills: [], sectionName: `${PROMPT_SECTION_NAME} @ ${PROMPT_SECTION_ORDER}` }

  const promptSection = installWhenAvailable(ctx, 'systemPrompt', (systemPrompt) => {
    systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text: PROMPT_SECTION_TEXT,
    })
    state.promptSection = true
    logger?.info?.('github-toolkit: prompt section %s registered', PROMPT_SECTION_NAME)
  }, { logger, label: 'the GitHub prompt section' })

  installWhenAvailable(ctx, 'skills', (skills) => {
    // The names come from the provider's OWN `list()`, not from the declared constant
    // sliced by a count.
    //
    // The first version did `PROVIDER_SKILL_NAMES.slice(0, count)`: it reported the names
    // this file EXPECTS, cut to the number the provider found. Those agree today and can
    // disagree the moment a directory is renamed, added or skipped — and the disagreement
    // would be invisible, because the count and the list would still look consistent with
    // each other. An independent audit named it as the diagnostic reporting its own input
    // as its output.
    void registerSkillProvider(ctx, skills).then((names) => {
      state.skills.push(...names)
      logger?.info?.('github-toolkit: skill provider registered (%d skill(s): %s)', names.length, names.join(', '))
    }).catch((error) => {
      // A throwing provider must not take the plugin down: the tools are the point, and
      // the skills are guidance on top of them.
      logger?.warn?.('github-toolkit: the skill provider could not be registered: %s', String(error?.message ?? error))
    })
  }, { logger, label: 'the GitHub skills' })

  return state
}