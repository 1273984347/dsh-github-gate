/**
 * Process runner: the single place this plugin talks to `gh` and `git`.
 *
 * Distilled from dsh-plugin-github-workflows' `lib/gh.js` with three changes:
 *
 * 1. **Signal escalation.** The source called `child.kill()` once, which sends
 *    SIGTERM. A `gh` invocation that ignores it (or a git process waiting on a
 *    credential helper) would keep the host turn alive until the caller's own
 *    deadline. Here a kill escalates SIGTERM → SIGKILL after `killGraceMs`.
 * 2. **No cached authorization conclusion.** The source memoized "is gh
 *    authenticated?" in a promise for the process lifetime. The credentials
 *    seam contract requires a per-operation re-read, so the token lookup is an
 *    injected async callback that runs on every invocation (see auth.js).
 * 3. **Spill cleanup is unconditional.** Only a truncated run may expose a
 *    spill path, so a non-truncated run can never leave a temp file behind.
 *
 * Invariants kept from the source, because they are the reason it is safe:
 * - argv arrays are spawned with `shell: false`, so model-supplied text is
 *   never re-interpreted by a shell;
 * - secrets never enter argv (token login pipes through stdin, the credential
 *   fallback keeps the token in the child environment);
 * - interactive prompts are hard-disabled so nothing can hang the host;
 * - a non-zero exit is REPORTED (`ok: false`), not thrown — the model decides.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Thrown when the `gh` executable itself is unavailable. */
export class GhMissingError extends Error {
  /** @param {string} detail what the spawn attempt reported */
  constructor(detail) {
    super(
      `GitHub CLI (gh) is not available: ${detail}\n` +
        'Install it from https://cli.github.com/ (winget install GitHub.cli on ' +
        'Windows), or set the plugin config "ghPath" to the gh executable.',
    )
    this.name = 'GhMissingError'
  }
}

/**
 * Render a command for display, quoting any argument that would otherwise be
 * ambiguous. Exported because the registry needs the same rendering to label a
 * background job, and two renderings of one command would be a bug waiting to
 * happen.
 *
 * @param {string} executable the executable path or name
 * @param {string[]} argv the arguments after it
 * @returns {string} the display form
 */
export function displayArgv(executable, argv) {
  return [executable, ...argv]
    .map((part) => (/[\s"'`<>|&;^]/.test(part) ? JSON.stringify(part) : part))
    .join(' ')
}

/**
 * The longest prefix of `buffer` that ends on a UTF-8 character boundary and is
 * no longer than `limit` bytes.
 *
 * A raw `buffer.subarray(0, limit)` can split a multi-byte character, and
 * `toString('utf8')` then emits U+FFFD for the orphaned bytes — so a truncated
 * log would contain a replacement character that was never in the output. Walking
 * back over continuation bytes (`0b10xxxxxx`) finds the last whole character
 * instead.
 *
 * @param {Buffer} buffer the chunk to trim
 * @param {number} limit the byte budget left
 * @returns {Buffer} a prefix that decodes without replacement characters
 */
function utf8Prefix(buffer, limit) {
  if (limit <= 0) return buffer.subarray(0, 0)
  if (limit >= buffer.length) return buffer
  let end = limit
  // At most three continuation bytes can belong to one character, so this loop
  // never walks back further than that.
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end -= 1
  return buffer.subarray(0, end)
}

/**
 * The executable for one binary kind, honouring the configured override.
 *
 * Single source of truth: the registry needs the same answer to label a background
 * job, and two independent spellings of `cfg.ghPath !== '' ? cfg.ghPath : 'gh'`
 * is how a job label ends up naming a binary the run did not use.
 *
 * @param {import('./types.js').PluginConfig} cfg resolved plugin config
 * @param {'gh'|'git'} [kind] which binary
 * @returns {string} the executable path or bare name
 */
export function executableFor(cfg, kind = 'gh') {
  if (kind === 'git') return cfg.gitPath !== '' ? cfg.gitPath : 'git'
  return cfg.ghPath !== '' ? cfg.ghPath : 'gh'
}

/**
 * Create the configured runner.
 *
 * @param {import('./types.js').PluginConfig} cfg resolved plugin config
 * @param {{ info?: Function, warn?: Function }} [logger] plugin logger
 * @param {() => Promise<string>} [resolveToken] async token lookup run per gh invocation
 * @returns {import('./types.js').Runner}
 */
export function createRunner(cfg, logger, resolveToken) {
  const bin = executableFor(cfg, 'gh')
  const gitBin = executableFor(cfg, 'git')

  /** Base environment for gh: prompts off, no color, no update nags. */
  const baseEnv = {
    ...globalThis.process?.env,
    ...(cfg.env ?? {}),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  }

  /** Environment for git: additionally refuses every interactive prompt. */
  const quietEnv = {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  }

  let probePromise = null

  /**
   * Run `gh --version` once and cache availability plus the version string.
   * Caching is safe here: the executable path does not change during a process
   * lifetime, unlike a credential value.
   * @returns {Promise<{ available: boolean, version: string, error?: string }>}
   */
  function probe() {
    if (probePromise === null) {
      probePromise = spawnRun(bin, ['--version'], { timeoutMs: 10_000, env: baseEnv })
        .then((r) => ({
          available: r.ok,
          version: String(r.stdout ?? '').split(/\r?\n/, 1)[0].trim(),
        }))
        .catch((error) => ({ available: false, version: '', error: String(error?.message ?? error) }))
    }
    return probePromise
  }

  /**
   * Run `gh <argv...>`, injecting the resolved token when the ambient
   * environment carries none.
   *
   * @param {string[]} argv arguments after the executable
   * @param {import('./types.js').RunOptions} [options] exec context, timeout, stdin
   * @returns {Promise<import('./types.js').RunResult>} the RESULT_SCHEMA-shaped result
   */
  async function run(argv, options = {}) {
    let env = baseEnv
    if (!options.internal && !baseEnv.GH_TOKEN && !baseEnv.GITHUB_TOKEN && resolveToken !== undefined) {
      // Re-resolved on every call on purpose: a credential stored mid-session
      // must reach the next invocation without a restart.
      const token = await resolveToken()
      if (token !== '') env = { ...baseEnv, GH_TOKEN: token }
    }
    return spawnRun(bin, argv, { ...options, env })
  }

  /**
   * Run `git <argv...>` with every interactive prompt disabled.
   * @param {string[]} argv arguments after the executable
   * @param {import('./types.js').RunOptions} [options] exec context, timeout, stdin
   * @returns {Promise<import('./types.js').RunResult>}
   */
  function runGit(argv, options = {}) {
    return spawnRun(gitBin, argv, { ...options, env: quietEnv })
  }

  /**
   * Human-readable command line for logs and the model-visible render. Secrets
   * never travel in argv with this plugin, so this is safe to display.
   * @param {string} executable the binary name
   * @param {string[]} argv the argument array
   * @returns {string} the quoted command line
   */
  function displayCommand(executable, argv) {
    return displayArgv(executable, argv)
  }

  /**
   * Shared spawn implementation for both executables.
   *
   * @param {string} executable gh or git path
   * @param {string[]} argv arguments after the executable
   * @param {import('./types.js').RunOptions} options
   * @returns {Promise<import('./types.js').RunResult>}
   */
  async function spawnRun(executable, argv, options = {}) {
    const started = Date.now()
    const cap = Math.max(1024, cfg.maxOutputBytes | 0)
    // A background job runs under the job registry's lifecycle, not this
    // plugin's, so it must not inherit the foreground deadline: the shipped
    // convention is that no background execution timeout applies. Cancellation
    // still works through `options.exec.signal`, which is how job_kill stops it.
    const noTimeout = options.noTimeout === true
    const timeoutMs = noTimeout ? 0 : Math.max(1_000, Math.min(options.timeoutMs ?? cfg.timeoutMs, 600_000))

    let stdoutText = ''
    let stderrText = ''
    // Byte counts, tracked separately from the strings: `.length` is UTF-16 code
    // units and the cap is a byte budget. See the sink below.
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let spillFd = null
    let spillPath = ''
    let stderrMarked = false

    /** Create the spill file lazily, on the first chunk that overflows the cap. */
    const ensureSpill = () => {
      spillPath = join(tmpdir(), `dsh-gh-${randomUUID()}.log`)
      spillFd = openSync(spillPath, 'wx')
    }

    /**
     * Close the spill descriptor. Only a truncated run keeps the file: a run
     * that fits in memory must not leave a temp file behind.
     * @param {boolean} keep whether the path should survive for the caller
     */
    const closeSpill = (keep) => {
      if (spillFd === null) return
      try { closeSync(spillFd) } catch { /* best effort */ }
      spillFd = null
      if (!keep) {
        try { unlinkSync(spillPath) } catch { /* best effort */ }
        spillPath = ''
      }
    }

    /**
     * Chunk sink: in-memory up to the cap, spill file for everything after it.
     * The in-memory prefix plus the spill tail is the complete output.
     *
     * The cap is ONE BUDGET ACROSS BOTH CHANNELS, measured in BYTES. It used to be
     * per-channel, so a run that wrote 60 KB to stdout and 60 KB to stderr held
     * 120 KB while `maxOutputBytes` said 64 KB — and `truncated` stayed false, so
     * the caller was told the output was complete when it was not.
     *
     * Both facts are tracked as byte counts, not string lengths: a string's
     * `.length` is UTF-16 code units, and three CJK characters occupy nine bytes
     * while reading as length 3. Mixing the two let the buffer exceed the cap on
     * non-ASCII output, and `subarray` on a byte offset cut multi-byte characters
     * in half. The slice is therefore decoded with `fatal: false` after being
     * trimmed back to a character boundary, so no replacement character appears.
     *
     * @param {'stdout'|'stderr'} channel which stream this chunk came from
     * @returns {(chunk: Buffer) => void} the stream data handler
     */
    const sink = (channel) => (chunk) => {
      if (chunk.length === 0) return
      // Forward each chunk before buffering, so a background job's output ring
      // sees the stream live rather than only at close. The callback is
      // best-effort by contract: the registry owns the ring, and a full ring
      // must never break the run.
      if (typeof options.onOutput === 'function') {
        try {
          options.onOutput(channel, chunk.toString('utf8'))
        } catch { /* the reader's problem, not the process's */ }
      }
      const used = stdoutBytes + stderrBytes
      if (spillFd === null && used + chunk.length > cap) ensureSpill()
      if (spillFd !== null) {
        if (channel === 'stderr' && !stderrMarked) {
          try { appendFileSync(spillFd, '\n[stderr]\n') } catch { /* best effort */ }
          stderrMarked = true
        }
        try { appendFileSync(spillFd, chunk) } catch { /* best effort */ }
      }
      // What is left of the SHARED byte budget. A non-positive value means the
      // budget is spent and nothing more is buffered.
      const remaining = cap - used
      if (remaining <= 0) {
        truncated = true
        return
      }
      if (chunk.length > remaining) truncated = true
      const slice = chunk.length > remaining ? utf8Prefix(chunk, remaining) : chunk
      if (channel === 'stdout') {
        stdoutText += slice.toString('utf8')
        stdoutBytes += slice.length
      } else {
        stderrText += slice.toString('utf8')
        stderrBytes += slice.length
      }
    }

    return await new Promise((resolve) => {
      let child
      try {
        child = spawn(executable, argv, {
          shell: false,
          windowsHide: true,
          cwd: options.cwd,
          env: options.env ?? baseEnv,
        })
      } catch (error) {
        resolve({
          ok: false,
          exitCode: -1,
          signal: '',
          timedOut: false,
          durationMs: Date.now() - started,
          command: displayCommand(executable, argv),
          stdout: '',
          stderr: `failed to spawn ${executable}: ${String(error?.message ?? error)}`,
          truncated: false,
          spillPath: '',
        })
        return
      }

      let settled = false
      let timedOut = false
      let killReason = ''
      let killTimer = null

      /**
       * Request termination, escalating to SIGKILL if the child ignores the
       * first signal. Without the escalation a stuck `gh`/`git` would outlive
       * its own timeout and keep the host turn open.
       * @param {string} reason 'timeout' | 'aborted'
       */
      const onKill = (reason) => {
        if (settled) return
        if (reason === 'timeout') timedOut = true
        killReason = reason
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        if (cfg.killGraceMs > 0) {
          killTimer = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* already gone */ }
          }, cfg.killGraceMs)
        } else {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }
      }

      const signal = options.exec?.signal
      if (signal?.aborted) onKill('aborted')
      else if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => onKill('aborted'), { once: true })
      }
      // `timeoutMs` is 0 only in the no-timeout background mode, where a timer
      // would either fire immediately or never; either way it is not the thing
      // that ends the run.
      const timer = timeoutMs > 0 ? setTimeout(() => onKill('timeout'), timeoutMs) : null

      /** Clear both timers on settlement. */
      const clearTimers = () => {
        if (timer !== null) clearTimeout(timer)
        if (killTimer !== null) clearTimeout(killTimer)
      }

      child.stdout?.on('data', sink('stdout'))
      child.stderr?.on('data', sink('stderr'))
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimers()
        closeSpill(false)
        resolve({
          ok: false,
          exitCode: -1,
          signal: '',
          timedOut: false,
          durationMs: Date.now() - started,
          command: displayCommand(executable, argv),
          stdout: stdoutText,
          stderr: `failed to run ${executable}: ${String(error?.message ?? error)}`,
          truncated: false,
          spillPath: '',
        })
      })

      if (options.stdin !== undefined && child.stdin) {
        child.stdin.on('error', () => { /* EPIPE when the child rejects early */ })
        child.stdin.write(options.stdin)
        child.stdin.end()
      }

      child.on('close', (code, closeSignal) => {
        if (settled) return
        settled = true
        clearTimers()
        const durationMs = Date.now() - started

        if (timedOut) {
          const note = `[dsh-github-gate] timed out after ${timeoutMs}ms — process killed. ` +
            'Raise the per-call timeoutMs (capped at 600000) or the plugin watchTimeoutMs for long-running commands.'
          stderrText = (stderrText ? stderrText + '\n' : '') + note
        }
        closeSpill(truncated)

        let data
        {
          // gh prints JSON for `--json` commands and for `gh api` responses;
          // parse whenever the output is JSON-shaped so both reach `data`.
          const text = stdoutText.trim()
          if (text.startsWith('{') || text.startsWith('[')) {
            try { data = JSON.parse(text) } catch { /* not JSON; leave data unset */ }
          }
        }

        const result = {
          ok: code === 0 && !timedOut,
          exitCode: code ?? -1,
          signal: closeSignal ?? (killReason !== '' ? `killed(${killReason})` : ''),
          timedOut,
          durationMs,
          command: displayCommand(executable, argv),
          stdout: stdoutText,
          stderr: stderrText,
          truncated,
          spillPath,
        }
        if (data !== undefined) result.data = data
        resolve(result)
      })
    })
  }

  return { run, runGit, probe }
}
