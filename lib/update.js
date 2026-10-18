/**
 * Self-update: detect a newer release, and stage its artifact for installation.
 *
 * ## Why this module stops short of installing
 *
 * Three constraints decide the shape, and all three were measured rather than
 * assumed:
 *
 * 1. **Node's `fetch` cannot reach github.com here.** On a machine whose TLS is
 *    intercepted by a proxy the OS trusts but Node's bundled CA store does not, a
 *    `fetch` to `api.github.com` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
 *    while `gh` succeeds because it uses the platform trust store. Every network
 *    call in this module therefore goes through `gh` — the same choice `github_api`
 *    documents for the REST escape hatch.
 *
 * 2. **A replaced bundle needs a process restart.** Node has already imported the
 *    old module; writing new files changes nothing about the running generation.
 *    This was observed directly: after installing a new version, the projected
 *    `Config` schema kept the old shape until the Host restarted.
 *
 * 3. **Installation is owned by the Harness plugin manager.** `install_bundle`
 *    rewrites the profile's `package.json`, prunes `node_modules`, and applies the
 *    patch row. A plugin that edited the profile itself would leave the profile's
 *    dependency spec, lockfile, and patch row disagreeing — and it would be
 *    executing downloaded code without the approval step the platform already
 *    gates that on.
 *
 * So this module does the two things a plugin CAN do safely and leaves the two it
 * must not do to the platform:
 *
 *   check  → is there a newer release?                (read-only)
 *   stage  → download it and verify its digest        (writes one local file)
 *   install → `plugin_manager` `install_bundle`       (platform, approval-gated)
 *   restart → user                                     (platform)
 *
 * The digest check is what makes staging worth doing: GitHub publishes a
 * `sha256:` digest for every release asset, so the downloaded bytes are verified
 * against GitHub's own value rather than trusted because they arrived over TLS.
 *
 * @module dsh-github-toolkit/update
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareVersions } from './version.js'

/** Where this plugin's releases live, unless configured otherwise. */
export const DEFAULT_UPDATE_REPO = '1273984347/dsh-github-toolkit'

/** The asset name a release is expected to carry. */
export const UPDATE_ASSET = /^dsh-github-toolkit-.*\.tgz$/

/** How long a cached check result stays fresh, in milliseconds. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The directory staged artifacts go into.
 * @param {string} configured the configured cache dir, or ''
 * @returns {string} an absolute directory path
 */
export function updateCacheDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(tmpdir(), 'dsh-github-toolkit-updates')
}

/**
 * The path of the check cache used by the activation-time notice.
 * @returns {string} an absolute file path
 */
export function updateCheckCachePath() {
  return join(updateCacheDir(''), 'check.json')
}

/**
 * Read the cached check result, or undefined when absent or unreadable.
 *
 * A cache is advisory: a corrupt or stale file must never break activation, so
 * every failure is an absent cache rather than an error.
 *
 * @param {string} path the cache file
 * @returns {{ checkedAt: number, latest: string } | undefined} the cached result
 */
export function readCheckCache(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed?.checkedAt !== 'number' || typeof parsed?.latest !== 'string') return undefined
    return { checkedAt: parsed.checkedAt, latest: parsed.latest }
  } catch {
    return undefined
  }
}

/**
 * Write the check cache. Best effort: a read-only temp dir is not a reason to
 * fail a check that already succeeded.
 * @param {string} path the cache file
 * @param {{ checkedAt: number, latest: string }} value the result
 * @returns {boolean} whether it was written
 */
export function writeCheckCache(path, value) {
  try {
    mkdirSync(updateCacheDir(''), { recursive: true })
    writeFileSync(path, JSON.stringify(value), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Whether a cached result is still fresh.
 * @param {{ checkedAt: number } | undefined} cached the cached entry
 * @param {number} now the current epoch milliseconds
 * @returns {boolean} true when the cache may be reused
 */
export function isCacheFresh(cached, now = Date.now()) {
  if (cached === undefined) return false
  return now - cached.checkedAt < UPDATE_CHECK_TTL_MS
}

/**
 * Reduce a GitHub release payload to the facts a check needs.
 *
 * Tolerant on purpose: the API is not this plugin's, so a missing field becomes an
 * empty value instead of a thrown error far from the cause. `prerelease` is kept
 * because the channel decision needs it.
 *
 * @param {unknown} payload the parsed `releases/latest` (or a release list entry)
 * @returns {{ tag: string, version: string, url: string, publishedAt: string, prerelease: boolean, assets: { name: string, size: number, digest: string, url: string }[] }}
 */
export function parseRelease(payload) {
  const record = typeof payload === 'object' && payload !== null ? payload : {}
  const tag = typeof record.tag_name === 'string' ? record.tag_name.trim() : ''
  const assets = Array.isArray(record.assets)
    ? record.assets.map((asset) => ({
      name: typeof asset?.name === 'string' ? asset.name : '',
      size: typeof asset?.size === 'number' ? asset.size : 0,
      digest: typeof asset?.digest === 'string' ? asset.digest : '',
      url: typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : '',
    })).filter((asset) => asset.name !== '')
    : []
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    url: typeof record.html_url === 'string' ? record.html_url : '',
    publishedAt: typeof record.published_at === 'string' ? record.published_at : '',
    prerelease: record.prerelease === true,
    assets,
  }
}

/**
 * The installable artifact of a release.
 *
 * A release may carry more than one file; the `.tgz` is the one `install_bundle`
 * consumes. A release with none is a release this plugin cannot install, and that
 * is reported rather than guessed at.
 *
 * @param {{ assets: { name: string, size: number, digest: string, url: string }[] }} release the parsed release
 * @returns {{ name: string, size: number, digest: string, url: string } | undefined} the artifact
 */
export function pickTarball(release) {
  return release.assets.find((asset) => UPDATE_ASSET.test(asset.name))
}

/**
 * Decide what an upgrade from `installed` to `latest` means.
 *
 * @param {string} installed the version this process is running
 * @param {string} latest the version the release names
 * @returns {'newer' | 'same' | 'older' | 'unknown'} the relationship
 */
export function releaseRelation(installed, latest) {
  const compared = compareVersions(latest, installed)
  if (compared === null) return 'unknown'
  if (compared > 0) return 'newer'
  return compared === 0 ? 'same' : 'older'
}

/**
 * The `sha256:<hex>` digest GitHub publishes for an asset, as bare lowercase hex.
 * @param {string} digest the digest field
 * @returns {string} the hex part, or '' when it is not a sha256 digest
 */
export function digestHex(digest) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? '').trim())
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * Compute a file's sha256 as bare lowercase hex.
 * @param {string} path the file
 * @returns {string} the digest, or '' when unreadable
 */
export function sha256OfFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

/**
 * Verify a downloaded artifact against the digest GitHub published for it.
 *
 * Three outcomes rather than two, because "no digest to compare against" is not
 * the same as "matches": an older API response may omit the field, and silently
 * treating that as success would make the check decorative.
 *
 * @param {string} path the downloaded file
 * @param {string} published the `digest` field from the release payload
 * @returns {{ state: 'match' | 'mismatch' | 'unverified', actual: string, expected: string }}
 */
export function verifyArtifact(path, published) {
  const expected = digestHex(published)
  const actual = sha256OfFile(path)
  if (expected === '') return { state: 'unverified', actual, expected: '' }
  if (actual === '') return { state: 'mismatch', actual, expected }
  return { state: actual === expected ? 'match' : 'mismatch', actual, expected }
}

/**
 * A previously staged artifact for one version, if it is still on disk and intact.
 *
 * Re-staging an identical release is wasteful, and a partially written file from
 * an interrupted download must not be offered for installation — hence the digest
 * re-check rather than trusting the filename.
 *
 * @param {string} dir the cache directory
 * @param {{ name: string, digest: string }} asset the release asset
 * @returns {{ path: string, verified: string } | undefined} the staged artifact
 */
export function findStaged(dir, asset) {
  const path = join(dir, asset.name)
  try {
    if (!statSync(path).isFile()) return undefined
  } catch {
    return undefined
  }
  const check = verifyArtifact(path, asset.digest)
  return { path, verified: check.state }
}

/**
 * Every artifact currently staged, newest first.
 *
 * Used by `check` so a caller can tell "already downloaded" from "needs a
 * download" without touching the network twice.
 *
 * @param {string} dir the cache directory
 * @returns {{ name: string, size: number }[]} the staged files
 */
export function listStaged(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => UPDATE_ASSET.test(name))
      .map((name) => ({ name, size: statSync(join(dir, name)).size }))
      .sort((left, right) => right.name.localeCompare(left.name))
  } catch {
    return []
  }
}
