/**
 * github_update — detect a newer release of this plugin, and stage its artifact.
 *
 * This is the one tool that acts on the plugin itself rather than on GitHub
 * content. It exists because the alternative — asking a person to remember a
 * repository URL, a release page, a tarball name, and a digest — is how a plugin
 * silently rots at an old version.
 *
 * The action set is deliberately small and the boundary is explicit: `check` reads
 * the latest release, `stage` downloads and verifies it. Neither installs. See
 * `lib/update.js` for the three measured constraints that put installation and the
 * restart outside this tool.
 */

import { join } from 'node:path'
import { str, bool, int, enumStr } from '../schema.js'
import { completed, rejection } from '../result.js'
import {
  DEFAULT_UPDATE_REPO,
  UPDATE_ASSET,
  findStaged,
  listStaged,
  parseRelease,
  pickTarball,
  readCheckCache,
  releaseRelation,
  updateCacheDir,
  verifyArtifact,
  writeCheckCache,
  updateCheckCachePath,
  isCacheFresh,
} from '../update.js'

/**
 * The repository releases are read from.
 * @param {{ updateRepo?: string }} cfg the resolved config
 * @returns {string} `owner/name`
 */
function repoFor(cfg) {
  const configured = typeof cfg.updateRepo === 'string' ? cfg.updateRepo.trim() : ''
  return configured === '' ? DEFAULT_UPDATE_REPO : configured
}

/**
 * Read the latest release through `gh`.
 *
 * `gh api` rather than `fetch`: on a machine with TLS interception Node's CA store
 * rejects github.com while gh trusts the platform store. The channel decides the
 * endpoint — `/releases/latest` excludes prereleases, which is what "stable" means
 * here, and the list endpoint is needed to opt into them.
 *
 * @param {object} input the lookup inputs
 * @param {any} input.runner the process runner
 * @param {any} input.cfg the resolved config
 * @param {'stable'|'latest'} input.channel which releases count
 * @param {any} input.exec the execution identity
 * @returns {Promise<{ release: any } | { error: string, detail?: string }>} the release, or why not
 */
async function fetchLatestRelease({ runner, cfg, channel, exec }) {
  const repo = repoFor(cfg)
  const argv = channel === 'latest'
    ? ['api', `repos/${repo}/releases?per_page=1`]
    : ['api', `repos/${repo}/releases/latest`]
  const result = await runner.run(argv, { exec, timeoutMs: cfg.timeoutMs })
  if (result.ok !== true) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n')[0] ?? ''
    return {
      error: `could not read releases for ${repo}: ${detail === '' ? 'gh api failed' : detail}`,
      detail,
    }
  }
  // The list form yields an array; take the first entry, which GitHub returns
  // newest-first. An empty list is a real answer (no releases), not a parse error.
  if (channel === 'latest') {
    const list = Array.isArray(result.data) ? result.data : []
    if (list.length === 0) return { error: `no releases found for ${repo}` }
    return { release: parseRelease(list[0]) }
  }
  return { release: parseRelease(result.data) }
}

/** @type {import('../types.js').DomainDef} */
const domain = {
  tool: 'github_update',
  title: 'Plugin update',
  // `check` reads only. `stage` writes one local file and is therefore outside
  // `readOnlyActions`, for the same reason `release download` is: two concurrent
  // stages would race for the same path.
  readOnlyActions: ['check'],
  description:
    'Detect and stage a newer release of this plugin. `check` reports the installed version, the latest '
    + 'release, and whether an upgrade exists. `stage` downloads that release\'s tarball, verifies its '
    + 'sha256 against the digest GitHub publishes, and returns the path. Neither action installs: '
    + 'installing rewrites the Harness profile and needs approval, so it goes through '
    + '`plugin_manager` (`install_bundle`) with the returned path. Whether a restart is needed depends '
    + 'on the install: the plugin manager re-activates the entry, and a measured install served the new '
    + 'generation immediately while an earlier one did not. Verify the running generation (a tool or '
    + 'Config key that only exists in the new version) rather than assuming it from the installed version.',
  params: {
    // Named for what it selects rather than "latest", which would collide with the
    // meaning of the version itself.
    channel: enumStr(['stable', 'latest'], 'check/stage: "stable" ignores prereleases (default). "latest" takes the newest release, prerelease included.'),
    tag: str('stage: the release tag to stage. Omit to use the newest release for the channel.'),
    force: bool('stage: re-download even when an intact copy of that artifact is already staged.'),
    timeoutMs: int('Optional per-call timeout in milliseconds; the configured timeoutMs is used when absent.'),
  },
  actions: {
    check: {
      help: 'Report the installed version, the latest release for the channel, and whether an upgrade is available.',
      needs: [],
      // Own execution: it composes an API read with the local version and the local
      // staging directory, which no single argv can express.
      custom: async ({ args, cfg, deps, exec }) => {
        const started = Date.now()
        const installed = typeof deps.pluginVersion === 'function' ? deps.pluginVersion() : ''
        const channel = typeof args.channel === 'string' ? args.channel : 'stable'
        const found = await fetchLatestRelease({ runner: deps.runner, cfg, channel, exec })
        if (found.error !== undefined) {
          return rejection(`github_update check: ${found.error}`, {
            command: '(plugin update check)',
            durationMs: Date.now() - started,
          })
        }
        const release = found.release
        const asset = pickTarball(release)
        const dir = updateCacheDir(cfg.updateCacheDir)
        const staged = asset === undefined ? undefined : findStaged(dir, asset)
        const relation = releaseRelation(installed, release.version)
        const upgrade = relation === 'newer'

        const lines = [
          `installed: ${installed === '' ? '(unknown)' : installed}`,
          `latest:    ${release.version === '' ? '(no tag)' : release.version}${release.prerelease ? ' (prerelease)' : ''}${release.tag !== '' ? ` [${release.tag}]` : ''}`,
          `channel:   ${channel}`,
          `status:    ${relation === 'newer' ? 'an upgrade is available' : relation === 'same' ? 'up to date' : relation === 'older' ? `installed is AHEAD of the newest ${channel} release` : 'versions could not be compared'}`,
        ]
        if (release.url !== '') lines.push(`release:   ${release.url}`)
        if (asset === undefined) {
          lines.push('', 'This release carries no installable .tgz asset, so it cannot be staged.')
        } else {
          lines.push(`artifact:  ${asset.name} (${asset.size} bytes)`)
          lines.push(`digest:    ${asset.digest === '' ? '(none published — staging will report unverified)' : asset.digest}`)
        }
        if (staged !== undefined) lines.push(`staged:    ${staged.path} [${staged.verified}]`)
        if (upgrade === true && asset !== undefined) {
          lines.push('', `Next: stage it with github_update { action: "stage"${channel === 'latest' ? ', channel: "latest"' : ''} }, then install the returned path with the plugin manager and restart.`)
        }
        if (relation === 'older') {
          lines.push('', 'The running version is newer than any published release. That is expected on a source checkout; nothing to do.')
        }

        const value = completed({
          ok: true,
          durationMs: Date.now() - started,
          command: '(plugin update check)',
          stdout: lines.join('\n'),
          data: {
            installed,
            latest: release.version,
            tag: release.tag,
            channel,
            relation,
            upgradeAvailable: upgrade,
            prerelease: release.prerelease,
            releaseUrl: release.url,
            publishedAt: release.publishedAt,
            artifact: asset === undefined ? null : { name: asset.name, size: asset.size, digest: asset.digest, url: asset.url },
            staged: staged === undefined ? null : { path: staged.path, verified: staged.verified },
            stagedFiles: listStaged(dir),
            repo: repoFor(cfg),
          },
        })
        return value
      },
    },
    stage: {
      help: 'Download the release tarball into the update cache, verify its sha256 against the digest GitHub publishes, and return its path for install_bundle.',
      needs: [],
      custom: async ({ args, cfg, deps, exec }) => {
        const started = Date.now()
        const channel = typeof args.channel === 'string' ? args.channel : 'stable'
        let release
        if (typeof args.tag === 'string' && args.tag.trim() !== '') {
          // A named tag skips the "latest" lookup but still needs the asset digest,
          // which only the release payload carries.
          const result = await deps.runner.run(
            ['api', `repos/${repoFor(cfg)}/releases/tags/${encodeURIComponent(args.tag.trim())}`],
            { exec, timeoutMs: cfg.timeoutMs },
          )
          if (result.ok !== true) {
            return rejection(`github_update stage: could not read release "${args.tag}": ${String(result.stderr ?? '').trim().split('\n')[0] ?? 'gh api failed'}`, {
              command: '(plugin update stage)',
              durationMs: Date.now() - started,
            })
          }
          release = parseRelease(result.data)
        } else {
          const found = await fetchLatestRelease({ runner: deps.runner, cfg, channel, exec })
          if (found.error !== undefined) {
            return rejection(`github_update stage: ${found.error}`, {
              command: '(plugin update stage)',
              durationMs: Date.now() - started,
            })
          }
          release = found.release
        }
        const asset = pickTarball(release)
        if (asset === undefined) {
          return rejection(
            `github_update stage: release ${release.version || '(no tag)'} carries no installable .tgz asset (expected a name matching ${String(UPDATE_ASSET)}).`,
            { command: '(plugin update stage)', durationMs: Date.now() - started },
          )
        }

        const dir = updateCacheDir(cfg.updateCacheDir)
        const existing = findStaged(dir, asset)
        if (existing !== undefined && existing.verified === 'match' && args.force !== true) {
          return stageResult({
            started,
            release,
            asset,
            path: existing.path,
            verification: { state: 'match', actual: '', expected: '' },
            reused: true,
            repo: repoFor(cfg),
          })
        }

        // `gh release download` needs an existing directory and writes the asset
        // into it; it does not verify the digest, which is why the check below
        // exists rather than trusting the transfer.
        const result = await deps.runner.run(
          ['release', 'download', release.tag, '--repo', repoFor(cfg), '--pattern', asset.name, '--dir', dir, '--clobber'],
          { exec, timeoutMs: cfg.watchTimeoutMs },
        )
        if (result.ok !== true) {
          return rejection(
            `github_update stage: download failed: ${String(result.stderr ?? '').trim().split('\n')[0] ?? 'gh release download failed'}`,
            { command: '(plugin update stage)', durationMs: Date.now() - started },
          )
        }

        const path = join(dir, asset.name)
        const verification = verifyArtifact(path, asset.digest)
        if (verification.state === 'mismatch') {
          return rejection(
            `github_update stage: the downloaded artifact does not match the digest GitHub publishes for ${asset.name}.\n`
            + `  expected: ${verification.expected}\n  actual:   ${verification.actual}\n`
            + 'Refusing to stage it. Re-run with force: false after deleting the file, or check whether the release was replaced.',
            { command: '(plugin update stage)', durationMs: Date.now() - started },
          )
        }
        return stageResult({
          started,
          release,
          asset,
          path,
          verification,
          reused: false,
          repo: repoFor(cfg),
        })
      },
    },
  },
}

/**
 * The result value of a completed stage.
 *
 * @param {object} input the outcome
 * @param {number} input.started the start timestamp
 * @param {any} input.release the parsed release
 * @param {{ name: string, size: number, digest: string }} input.asset the artifact
 * @param {string} input.path where it landed
 * @param {{ state: string, actual: string, expected: string }} input.verification the digest comparison
 * @param {boolean} input.reused whether an intact copy was already present
 * @param {string} input.repo `owner/name`
 * @returns {any} a RESULT_SCHEMA-shaped value
 */
function stageResult({ started, release, asset, path, verification, reused, repo }) {
  const lines = [
    `${reused ? 'already staged' : 'staged'}: ${path}`,
    `release:  ${release.tag}${release.prerelease ? ' (prerelease)' : ''}`,
    `artifact: ${asset.name} (${asset.size} bytes)`,
    verification.state === 'match'
      ? `digest:   sha256 verified against the digest GitHub publishes`
      : verification.state === 'unverified'
        ? `digest:   NOT verified — this release published no sha256 digest, so only the size is known`
        : `digest:   MISMATCH (expected ${verification.expected}, got ${verification.actual})`,
    '',
    'Not installed. One step remains, and it does not belong to this plugin:',
    '  1. install the path above with plugin_manager action "install_bundle" (it needs approval —',
    '     that is the point at which downloaded code is allowed to run).',
    'Then VERIFY the running generation rather than assuming it: the plugin manager re-activates the',
    'entry, and a measured install served the new generation immediately while an earlier one needed',
    'a restart. A tool or Config key that only exists in the new version is the check; the installed',
    'package.json is not, because pnpm replaces it before the module is necessarily reloaded.',
  ]
  return completed({
    ok: true,
    durationMs: Date.now() - started,
    command: '(plugin update stage)',
    stdout: lines.join('\n'),
    data: {
      path,
      repo,
      tag: release.tag,
      version: release.version,
      artifact: { name: asset.name, size: asset.size, digest: asset.digest },
      verification: verification.state,
      expectedDigest: verification.expected,
      actualDigest: verification.actual,
      reused,
      installed: false,
      next: { action: 'install_bundle', target: path, restartRequired: 'unverified' },
    },
  })
}

export default domain

// Exported for tests: the activation-time cache helpers live in lib/update.js, and
// these two are re-exported here so a test can drive the same code the plugin does
// without importing a module that performs I/O at import time.
export { readCheckCache, writeCheckCache, updateCheckCachePath, isCacheFresh }
