/**
 * End-to-end check of the update feature against the REAL release on GitHub.
 *
 * Offline tests prove the logic; this proves the logic matches the actual payload
 * shape GitHub returns and that `gh release download` lands the file where the
 * digest check looks for it. Run manually — it needs network and a credential.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createRunner } from '../lib/runner.js'
import { normalizeConfig } from '../lib/config.js'
import updateDomain from '../lib/domains/update.js'
import { verifyArtifact } from '../lib/update.js'

const exec = promisify(execFile)
const cacheDir = join(tmpdir(), `dsh-update-live-${process.pid}`)

const cfg = normalizeConfig({ updateRepo: '1273984347/dsh-github-toolkit', updateCacheDir: cacheDir })
const runner = createRunner(cfg, null, async () => '')
const deps = {
  runner,
  pluginVersion: () => {
    // Report an OLD version so the live check has something to find.
    return '1.0.0'
  },
}

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `\n      ${detail}`}`)
  if (!ok) failures += 1
}

try {
  // 1. The release read works through gh against the real repository.
  const checked = await updateDomain.actions.check.custom({ args: {}, cfg, deps, exec: undefined })
  check(checked.ok === true, 'live: check succeeds against the real release', checked.stderr.slice(0, 160))
  check(/^\d+\.\d+\.\d+/.test(String(checked.data?.latest)), 'live: the release tag parses to a version', String(checked.data?.latest))
  check(checked.data?.artifact?.digest?.startsWith('sha256:') === true,
    'live: the API supplies a sha256 digest for the asset', String(checked.data?.artifact?.digest))
  check(checked.data?.relation === 'newer', 'live: 1.0.0 -> latest is an upgrade', String(checked.data?.relation))

  // 2. Staging downloads the real asset and verifies it against GitHub's digest.
  const staged = await updateDomain.actions.stage.custom({ args: {}, cfg, deps, exec: undefined })
  check(staged.ok === true, 'live: stage succeeds', staged.stderr.slice(0, 200))
  check(staged.data?.verification === 'match',
    'live: the downloaded bytes match the digest GitHub publishes',
    `state=${staged.data?.verification} expected=${staged.data?.expectedDigest?.slice(0, 16)}… actual=${staged.data?.actualDigest?.slice(0, 16)}…`)
  check(staged.data?.installed === false, 'live: stage does not install')
  check(staged.data?.next?.restartRequired === 'unverified',
    'live: the result does not claim to know whether a restart is needed',
    String(staged.data?.next?.restartRequired))

  // 3. The staged file really is the published tarball.
  //
  // The assertions are on files EVERY release of this plugin contains, not on the
  // newest source: the live release is whatever was published last, so asserting
  // that it carries a module written after it would fail for the right reason at
  // the wrong layer.
  const { stdout } = await exec('tar', ['-tzf', staged.data.path], { timeout: 60_000 })
  check(stdout.includes('package/package.json'), 'live: the staged tarball is a package', '')
  check(stdout.includes('package/index.js') && stdout.includes('package/cordis.patch.yml'),
    'live: the staged tarball carries the bundle entry points', '')
  check(stdout.includes('package/lib/registry.js'), 'live: the staged tarball carries the library', '')

  // 4. A second stage reuses the verified copy instead of downloading again.
  const again = await updateDomain.actions.stage.custom({ args: {}, cfg, deps, exec: undefined })
  check(again.ok === true && again.data?.reused === true,
    'live: re-staging an intact artifact reuses it', `reused=${again.data?.reused}`)

  // 5. A tampered file is caught rather than installed.
  const tampered = await exec('node', ['-e', `
    const fs = require('node:fs')
    fs.appendFileSync(${JSON.stringify(staged.data.path)}, 'x')
  `])
  void tampered
  const afterTamper = verifyArtifact(staged.data.path, staged.data.artifact.digest)
  check(afterTamper.state === 'mismatch', 'live: a tampered artifact fails verification', afterTamper.state)
} finally {
  rmSync(cacheDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n=== live update check passed ===' : `\n=== ${failures} check(s) failed ===`)
process.exitCode = failures === 0 ? 0 : 1
