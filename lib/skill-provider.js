/**
 * The skill provider: serves `skills/<name>/SKILL.md` from this package.
 *
 * ## Why a provider and not three `register()` calls
 *
 * `skills.register()` takes a finished skill — content and all — baked into this module
 * at activation. A provider hands the registry a `list`/`get` pair instead, and the body
 * is read from disk on each `get`. That matters for two reasons:
 *
 * 1. **The instructions are files, not JavaScript.** A reviewer can read and diff
 *    `skills/github-ci-triage/SKILL.md` without opening a module, and editing the wording
 *    does not mean editing code that builds a string at load time.
 * 2. **`resourceBase` makes relative paths resolvable.** A skill directory can ship
 *    `scripts/` next to its `SKILL.md` and the body may reference it, which is how the
 *    skill packs in this ecosystem carry executable help. These three skills need no
 *    scripts today — they drive this plugin's own tools — but the shape is what makes
 *    that possible later, and it is the shape the filesystem and bundled providers use.
 *
 * The contract is deliberately the same as `@deepseek-ai/dsh-skill-filesystem` and of the
 * community pack that was read before writing this: `list` returns candidates carrying a
 * `locator` and a `resourceBase`, `get` receives that candidate and returns the body.
 *
 * ## Rank
 *
 * `rank` is a provider concept — a runtime `register()` has none. Packaged skills rank
 * BELOW the project, user and custom roots (100–500), so a user who writes their own
 * `github-pr-review` wins over this one. That is the correct default: a local file is a
 * more specific statement of intent than a bundled one.
 *
 * ## Frontmatter
 *
 * Parsed by hand, and only the subset these files use. A YAML dependency would be one
 * more thing to keep resolving at runtime for four scalar fields, and the strict subset
 * makes a malformed file fail loudly rather than parse into something surprising.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the skill directories live, resolved relative to this module. */
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/** The provider name this pack registers under. */
export const PROVIDER_NAME = 'dsh-github-toolkit'

/**
 * Packaged skills rank below project/user/custom roots (100–500) so a user's own skill of
 * the same name wins. Matches the rank the bundled skill provider uses.
 */
export const PACK_RANK = 600

/** A skill name must be kebab-case; the registry documents the same rule. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** True/1/on/yes, the forms a frontmatter boolean may take. */
const TRUE_FORMS = new Set(['true', 'yes', 'on', '1'])
/** False/0/off/no. */
const FALSE_FORMS = new Set(['false', 'no', 'off', '0'])

/**
 * Split a SKILL.md into its frontmatter fields and its body.
 *
 * @param {string} text the file contents
 * @returns {{ fields: Record<string, string>, body: string } | undefined} the parts, or undefined when there is no frontmatter
 */
export function parseSkillText(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return undefined
  const firstNewline = text.indexOf('\n')
  if (firstNewline < 0) return undefined
  const closing = text.indexOf('\n---', firstNewline)
  if (closing < 0) return undefined
  const frontmatter = text.slice(firstNewline + 1, closing).trim()
  const body = text.slice(closing + 4).trim()
  if (body === '') return undefined
  /** @type {Record<string, string>} */
  const fields = {}
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    fields[match[1]] = match[2].trim()
  }
  return { fields, body }
}

/**
 * Strip one layer of matching quotes.
 *
 * @param {string | undefined} value the raw scalar
 * @returns {string | undefined} the value
 */
export function scalar(value) {
  if (value === undefined) return undefined
  return value.replace(/^(["'])(.*)\1$/, '$2')
}

/**
 * Read a frontmatter boolean.
 *
 * @param {string | undefined} value the raw scalar
 * @returns {boolean | undefined} the value, or undefined when it is neither form
 */
export function parseBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (TRUE_FORMS.has(normalized)) return true
  if (FALSE_FORMS.has(normalized)) return false
  return undefined
}

/**
 * Turn the invocation frontmatter into the policy the contract expects.
 *
 * @param {Record<string, string>} fields the frontmatter
 * @returns {{ modelInvocable: boolean, userInvocable: boolean }} the policy
 */
export function parseInvocation(fields) {
  const disabled = parseBoolean(fields['disable-model-invocation'])
  const userInvocable = parseBoolean(fields['user-invocable'])
  return {
    modelInvocable: disabled === undefined ? true : !disabled,
    userInvocable: userInvocable === undefined ? true : userInvocable,
  }
}

/**
 * Everything in the frontmatter that is not a field this provider consumes.
 *
 * @param {Record<string, string>} fields the frontmatter
 * @returns {Record<string, string> | undefined} the leftovers
 */
function parseMetadata(fields) {
  /** @type {Record<string, string>} */
  const metadata = {}
  for (const [key, value] of Object.entries(fields)) {
    if (['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable'].includes(key)) continue
    metadata[key] = value
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata
}

/** Serves this package's bundled skill directories. */
export class PackSkillProvider {
  /**
   * @param {any} ctx the plugin context, for logging
   */
  constructor(ctx) {
    this.ctx = ctx
    this.name = PROVIDER_NAME
  }

  /**
   * List the skills this pack ships.
   *
   * A missing `skills/` directory is an empty catalog, not an error: the package may be
   * installed from a tarball that excluded it, and the tools must keep working.
   *
   * @returns {Promise<any[]>} the candidates
   */
  async list() {
    let entries
    try {
      entries = await readdir(SKILLS_DIR, { withFileTypes: true })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    const candidates = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(SKILLS_DIR, entry.name)
      const skill = await this.readSkill(join(dir, 'SKILL.md'))
      if (skill === undefined) {
        this.ctx.logger?.warn?.('%s: skills/%s/SKILL.md is missing or has no usable frontmatter, so it is not offered', PROVIDER_NAME, entry.name)
        continue
      }
      if (!SKILL_NAME.test(skill.name)) {
        this.ctx.logger?.warn?.('%s: skill %s ignored — a skill name must be kebab-case', PROVIDER_NAME, JSON.stringify(skill.name))
        continue
      }
      // The DIRECTORY name and the frontmatter name must agree. They are two identifiers
      // for one thing, and a mismatch means one of them is wrong in a way nothing else
      // would report — the catalog would offer a name whose file lives elsewhere.
      if (skill.name !== entry.name) {
        this.ctx.logger?.warn?.('%s: skill %s ignored — its directory is named %s', PROVIDER_NAME, skill.name, entry.name)
        continue
      }
      candidates.push({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
        invocation: skill.invocation,
        source: 'bundled',
        provider: PROVIDER_NAME,
        rank: PACK_RANK,
        locator: { dir },
        // Relative `scripts/...` references in the body resolve against the skill's own
        // directory because of this. Omitting it would make any such reference dangling.
        resourceBase: { kind: 'directory', path: dir },
        path: join(dir, 'SKILL.md'),
        ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
      })
    }
    return candidates
  }

  /**
   * Load one skill body.
   *
   * The file is read again here rather than cached at list time, so an edited SKILL.md is
   * served on the next request without re-activating the plugin.
   *
   * @param {any} candidate a candidate from list()
   * @returns {Promise<any | undefined>} the definition, or undefined
   */
  async get(candidate) {
    const locator = candidate?.locator
    if (locator === undefined || typeof locator.dir !== 'string') return undefined
    const skill = await this.readSkill(join(locator.dir, 'SKILL.md'))
    if (skill === undefined || skill.name !== candidate.name) return undefined
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: skill.invocation,
      source: candidate.source,
      provider: candidate.provider,
      resourceBase: candidate.resourceBase,
      path: candidate.path,
      ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
      content: skill.body,
    }
  }

  /**
   * Read and validate one SKILL.md.
   *
   * @param {string} file the file path
   * @returns {Promise<any | undefined>} the parsed skill, or undefined when unusable
   */
  async readSkill(file) {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
      throw error
    }
    const parsed = parseSkillText(raw)
    if (parsed === undefined) return undefined
    const { fields, body } = parsed
    const name = scalar(fields.name)
    const description = scalar(fields.description)
    // A skill with no description cannot be discovered intelligently — the catalog shows
    // the description, not the body — so an incomplete skill is left out entirely rather
    // than offered as a name with nothing behind it.
    if (name === undefined || description === undefined || name === '' || description === '') return undefined
    const whenToUse = scalar(fields.whenToUse)
    return {
      name,
      description,
      ...(whenToUse !== undefined ? { whenToUse } : {}),
      invocation: parseInvocation(fields),
      ...(parseMetadata(fields) !== undefined ? { metadata: parseMetadata(fields) } : {}),
      body,
    }
  }
}

/**
 * Register the provider on a composed skills service.
 *
 * @param {any} ctx the plugin context
 * @param {any} skills the `skills` service
 * @returns {Promise<string[]>} the names the provider currently finds
 */
export async function registerSkillProvider(ctx, skills) {
  skills.registerProvider(() => new PackSkillProvider(ctx))
  // Listed now so the caller can report something concrete — and, since the caller
  // publishes these names as a diagnostic, so that the names are the ones this provider
  // ACTUALLY found rather than the ones a constant expects. The provider itself is lazy
  // and may serve a different list later if files change on disk.
  const provider = new PackSkillProvider(ctx)
  const candidates = await provider.list()
  return candidates.map((candidate) => candidate.name)
}
