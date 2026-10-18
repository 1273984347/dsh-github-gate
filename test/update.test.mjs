/**
 * Tests for the self-update feature: version comparison, release parsing, digest
 * verification, and the two tool actions.
 *
 * The design constraints that matter here are negative ones — what the feature
 * must NOT do:
 *
 *   - it must not install anything (installation rewrites the Harness profile and
 *     is approval-gated, so it belongs to `plugin_manager`);
 *   - it must not report a digest it did not check (an API response without a
 *     `digest` is UNVERIFIED, not PASS);
 *   - it must not claim an upgrade when the comparison could not be made.
 *
 * Each of those is asserted below, because each is a way the feature could be
 * useful-looking and wrong.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import { compareVersions } from '../lib/version.js'
import {
  DEFAULT_UPDATE_REPO,
  digestHex,
  findStaged,
  isCacheFresh,
  listStaged,
  parseRelease,
  pickTarball,
  readCheckCache,
  releaseRelation,
  updateCacheDir,
  UPDATE_CHECK_TTL_MS,
  verifyArtifact,
  writeCheckCache,
} from '../lib/update.js'
import updateDomain from '../lib/domains/update.js'

/** A fresh, empty cache directory for one test. */
function freshCache() {
  return mkdtempSync(join(tmpdir(), 'dsh-update-test-'))
}

/** A release payload shaped like the GitHub API's. */
function releasePayload(overrides = {}) {
  const body = 'artifact bytes'
  return {
    tag_name: 'v2.0.0',
    html_url: 'https://github.com/o/r/releases/tag/v2.0.0',
    published_at: '2026-02-01T00:00:00Z',
    prerelease: false,
    assets: [{
      name: 'dsh-github-toolkit-2.0.0.tgz',
      size: Buffer.byteLength(body),
      digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      browser_download_url: 'https://example.invalid/a.tgz',
    }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

test('update: versions compare numerically, not as strings', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '1.10.0 is newer than 1.9.0')
  assert.equal(compareVersions('v1.6.3', '1.6.3'), 0, 'a leading v is ignored')
  assert.equal(compareVersions('1.6.3', 'v1.6.3'), 0, 'in either direction')
  assert.equal(compareVersions('2', '2.0.0'), 0, 'a short version pads with zeros')
  assert.equal(compareVersions('1.6.3+build', '1.6.3'), 0, 'a build suffix is ignored')
  assert.equal(compareVersions('1.6.3-rc1', '1.6.3'), 0, 'a prerelease suffix is ignored by the numeric compare')
  assert.equal(compareVersions('', '1.0.0'), null, 'an unparseable side is null, not 0')
  assert.equal(compareVersions('nope', '1.0.0'), null)
})

test('update: an upgrade is only claimed when both versions parse', () => {
  assert.equal(releaseRelation('1.6.3', '2.0.0'), 'newer')
  assert.equal(releaseRelation('1.6.3', '1.6.3'), 'same')
  assert.equal(releaseRelation('2.0.0', '1.6.3'), 'older')
  // The distinction that stops a false "up to date": unknown is its own answer.
  assert.equal(releaseRelation('', '2.0.0'), 'unknown')
  assert.equal(releaseRelation('1.6.3', ''), 'unknown')
})

// ---------------------------------------------------------------------------
// Release parsing
// ---------------------------------------------------------------------------

test('update: a release payload is reduced without throwing on missing fields', () => {
  const parsed = parseRelease(releasePayload())
  assert.equal(parsed.tag, 'v2.0.0')
  assert.equal(parsed.version, '2.0.0', 'the v prefix is stripped for comparison')
  assert.equal(parsed.prerelease, false)
  assert.equal(parsed.assets.length, 1)

  assert.deepEqual(parseRelease(null), { tag: '', version: '', url: '', publishedAt: '', prerelease: false, assets: [] })
  assert.deepEqual(parseRelease({ assets: 'not-an-array' }).assets, [])
  assert.equal(parseRelease({ assets: [{ size: 1 }] }).assets.length, 0, 'an asset with no name is dropped')
})

test('update: the installable artifact is the tarball, and its absence is reported', () => {
  assert.equal(pickTarball(parseRelease(releasePayload()))?.name, 'dsh-github-toolkit-2.0.0.tgz')
  const noTarball = parseRelease(releasePayload({ assets: [{ name: 'notes.txt', size: 1, digest: '', browser_download_url: '' }] }))
  assert.equal(pickTarball(noTarball), undefined)
})

// ---------------------------------------------------------------------------
// Digest verification
// ---------------------------------------------------------------------------

test('update: digest verification has three outcomes, not two', () => {
  const dir = freshCache()
  const path = join(dir, 'a.tgz')
  const body = 'artifact bytes'
  writeFileSync(path, body)
  const good = `sha256:${createHash('sha256').update(body).digest('hex')}`

  assert.equal(verifyArtifact(path, good).state, 'match')
  assert.equal(verifyArtifact(path, `sha256:${'0'.repeat(64)}`).state, 'mismatch')
  // "No digest published" is NOT a pass — an older API response omits the field,
  // and treating that as verified would make the check decorative.
  assert.equal(verifyArtifact(path, '').state, 'unverified')
  assert.equal(verifyArtifact(path, 'sha512:abc').state, 'unverified', 'a non-sha256 digest cannot be compared')
  assert.equal(verifyArtifact(join(dir, 'missing.tgz'), good).state, 'mismatch', 'an unreadable file cannot match')

  assert.equal(digestHex(good), createHash('sha256').update(body).digest('hex'))
  assert.equal(digestHex('sha256:ABCD'), '', 'a wrong-length digest is not accepted')
})

test('update: a staged artifact is re-verified rather than trusted by name', () => {
  const dir = freshCache()
  const body = 'artifact bytes'
  const asset = {
    name: 'dsh-github-toolkit-2.0.0.tgz',
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
  }
  assert.equal(findStaged(dir, asset), undefined, 'nothing staged yet')
  writeFileSync(join(dir, asset.name), body)
  assert.equal(findStaged(dir, asset)?.verified, 'match')
  writeFileSync(join(dir, asset.name), 'tampered')
  assert.equal(findStaged(dir, asset)?.verified, 'mismatch', 'a modified file must not be offered for install')
  assert.equal(listStaged(dir).length, 1)
})

// ---------------------------------------------------------------------------
// Check cache
// ---------------------------------------------------------------------------

test('update: the check cache expires and degrades to absent', () => {
  const dir = freshCache()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'check.json')
  assert.equal(readCheckCache(path), undefined, 'an absent cache is not an error')

  writeFileSync(path, 'not json')
  assert.equal(readCheckCache(path), undefined, 'a corrupt cache is not an error either')

  writeCheckCache(path, { checkedAt: Date.now(), latest: '2.0.0' })
  const cached = readCheckCache(path)
  assert.equal(cached?.latest, '2.0.0')
  assert.equal(isCacheFresh(cached), true)
  assert.equal(isCacheFresh({ checkedAt: Date.now() - UPDATE_CHECK_TTL_MS - 1 }), false, 'stale after the TTL')
  assert.equal(isCacheFresh(undefined), false)
})

test('update: the default cache directory is under the system temp dir', () => {
  assert.equal(updateCacheDir(''), join(tmpdir(), 'dsh-github-toolkit-updates'))
  assert.equal(updateCacheDir('D:/custom'), 'D:/custom')
  assert.equal(DEFAULT_UPDATE_REPO, '1273984347/dsh-github-toolkit')
})

// ---------------------------------------------------------------------------
// The tool actions
// ---------------------------------------------------------------------------

/** A recording runner that answers the release read and materialises the download. */
function updateRunner({ release = releasePayload(), body = 'artifact bytes', downloadOk = true } = {}) {
  const calls = []
  return {
    calls,
    runner: {
      async run(argv, options = {}) {
        calls.push({ argv, options })
        if (argv[0] === 'api') {
          return { ok: true, exitCode: 0, stdout: '', stderr: '', data: release }
        }
        if (argv[0] === 'release') {
          if (!downloadOk) return { ok: false, exitCode: 1, stdout: '', stderr: 'gh: not found' }
          const dirIndex = argv.indexOf('--dir')
          const dir = dirIndex === -1 ? undefined : argv[dirIndex + 1]
          const patternIndex = argv.indexOf('--pattern')
          const name = patternIndex === -1 ? 'a.tgz' : argv[patternIndex + 1]
          if (dir !== undefined) {
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, name), body)
          }
          return { ok: true, exitCode: 0, stdout: '', stderr: '' }
        }
        return { ok: true, exitCode: 0, stdout: '', stderr: '' }
      },
    },
  }
}

/** Run one update action against a fake runner. */
async function runUpdate(action, args, { cfg = {}, runner = updateRunner().runner, version = '1.0.0' } = {}) {
  const dir = freshCache()
  return updateDomain.actions[action].custom({
    args,
    cfg: { updateRepo: 'o/r', updateChannel: 'stable', updateCacheDir: dir, timeoutMs: 60_000, watchTimeoutMs: 300_000, ...cfg },
    deps: { runner, pluginVersion: () => version },
    exec: undefined,
  })
}

test('update check: reports the installed and published versions and the relation', async () => {
  const behind = await runUpdate('check', {}, { version: '1.0.0' })
  assert.equal(behind.ok, true, behind.stderr)
  assert.equal(behind.data.installed, '1.0.0')
  assert.equal(behind.data.latest, '2.0.0')
  assert.equal(behind.data.relation, 'newer')
  assert.equal(behind.data.upgradeAvailable, true)
  assert.match(behind.stdout, /an upgrade is available/)

  const current = await runUpdate('check', {}, { version: '2.0.0' })
  assert.equal(current.data.relation, 'same')
  assert.equal(current.data.upgradeAvailable, false)

  const ahead = await runUpdate('check', {}, { version: '3.0.0' })
  assert.equal(ahead.data.relation, 'older')
  assert.equal(ahead.data.upgradeAvailable, false)
  assert.match(ahead.stdout, /AHEAD/, 'a source checkout must not be told to downgrade')
})

test('update check: uses the endpoint the channel selects', async () => {
  const stable = updateRunner()
  await runUpdate('check', {}, { runner: stable.runner })
  assert.ok(stable.calls[0].argv.includes('repos/o/r/releases/latest'), JSON.stringify(stable.calls[0].argv))

  const latest = updateRunner()
  await runUpdate('check', { channel: 'latest' }, { runner: latest.runner })
  assert.ok(latest.calls[0].argv.some((part) => part.includes('releases?per_page=1')), JSON.stringify(latest.calls[0].argv))
})

test('update check: a failed release read is a clean refusal, not a thrown error', async () => {
  const failing = {
    async run() {
      return { ok: false, exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
    },
  }
  const result = await runUpdate('check', {}, { runner: failing })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /could not read releases for o\/r/)
  assert.match(result.stderr, /404/)
})

test('update stage: downloads, verifies the digest, and never claims to install', async () => {
  const runner = updateRunner()
  const result = await runUpdate('stage', {}, { runner: runner.runner })
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.data.verification, 'match')
  assert.equal(result.data.installed, false, 'staging is not installing')
  assert.equal(result.data.next.action, 'install_bundle')
  // The restart question is deliberately not answered with a boolean: a measured
  // install loaded the new generation immediately, while an earlier one did not. The
  // honest field is "unverified", which tells the caller to check instead of guess.
  assert.equal(result.data.next.restartRequired, 'unverified')
  assert.match(result.stdout, /VERIFY the running generation/)
  assert.ok(result.data.path.endsWith('dsh-github-toolkit-2.0.0.tgz'))
  assert.match(result.stdout, /Not installed/)
  // The download used the release tag, not "latest".
  const download = runner.calls.find((call) => call.argv[0] === 'release')
  assert.ok(download.argv.includes('v2.0.0'), JSON.stringify(download.argv))
  assert.ok(download.argv.includes('--pattern'), 'the asset is selected by name, not by guessing the directory contents')
})

test('update stage: refuses an artifact whose digest does not match', async () => {
  // The payload advertises a digest, but the runner writes different bytes — the
  // exact shape of a replaced or corrupted download.
  const runner = updateRunner({ body: 'tampered' })
  const result = await runUpdate('stage', {}, { runner: runner.runner })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /does not match the digest/)
  assert.equal(result.data, undefined, 'a rejected artifact carries no install path')
})

test('update stage: an artifact with no published digest is staged as UNVERIFIED', async () => {
  const release = releasePayload()
  release.assets[0].digest = ''
  const result = await runUpdate('stage', {}, { runner: updateRunner({ release }).runner })
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.data.verification, 'unverified')
  assert.match(result.stdout, /NOT verified/)
})

test('update stage: a failed download is a clean refusal', async () => {
  const result = await runUpdate('stage', {}, { runner: updateRunner({ downloadOk: false }).runner })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /download failed/)
})

test('update stage: refuses a release that carries no tarball', async () => {
  const release = releasePayload({ assets: [{ name: 'notes.txt', size: 1, digest: '', browser_download_url: '' }] })
  const result = await runUpdate('stage', {}, { runner: updateRunner({ release }).runner })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /no installable \.tgz asset/)
})

test('update: the feature never claims to know whether a restart is required', async () => {
  // 1.7.0 said "restart required". Measurement said otherwise: installing 1.7.0 over
  // 1.6.1 served the new tool set and the new Config keys with no restart, while an
  // earlier install in the same environment did need one. Two opposite observations
  // mean the boolean was always a guess. The field is 'unverified' so a caller is told
  // to CHECK rather than handed a confident wrong answer — and the checks that mean
  // something are a tool or Config key unique to the new version, not package.json,
  // which pnpm replaces before the module is necessarily reloaded.
  const staged = await runUpdate('stage', {})
  assert.equal(staged.data.next.restartRequired, 'unverified')
  assert.equal(typeof staged.data.next.restartRequired, 'string', 'not a boolean: the honest answer is a state, not a verdict')
  assert.match(staged.stdout, /VERIFY the running generation/)
  assert.doesNotMatch(staged.stdout, /restart the Harness, because/, 'the old unconditional advice must be gone')
})

test('update: every action is classified, and staging is not read-only', () => {
  assert.deepEqual(updateDomain.readOnlyActions, ['check'], 'staging writes a local file, so it must not be concurrency-safe')
  assert.equal(updateDomain.actions.check.destructive, undefined, 'checking changes nothing remote')
  assert.equal(updateDomain.actions.stage.destructive, undefined, 'staging writes only the local cache')
})
