/**
 * Offline test harness: a fake plugin context that records what a plugin
 * registers, plus helpers to execute a registered tool.
 *
 * No network, no `gh` binary, no dsh runtime. Everything the plugin touches is
 * either pure or injected, which is the point of the design.
 */

import { normalizeConfig } from '../lib/config.js'

/**
 * A fake runner that records every invocation and replays scripted results.
 *
 * @param {object} [script] canned responses
 * @param {(argv: string[]) => object} [script.onGh] build a result for a gh argv
 * @param {(argv: string[]) => object} [script.onGit] build a result for a git argv
 * @returns {{ runner: any, calls: { gh: string[][], git: string[][] } }}
 */
export function makeRunner(script = {}) {
  const calls = { gh: [], git: [] }
  const result = (ok, stdout = '') => ({
    ok,
    exitCode: ok ? 0 : 1,
    signal: '',
    timedOut: false,
    durationMs: 1,
    command: 'fake',
    stdout,
    stderr: ok ? '' : 'fake failure',
    truncated: false,
    spillPath: '',
  })
  return {
    calls,
    runner: {
      async run(argv, options = {}) {
        calls.gh.push([...argv])
        if (typeof script.onGh === 'function') return script.onGh(argv, options)
        return result(true, '')
      },
      async runGit(argv, options = {}) {
        calls.git.push([...argv])
        if (typeof script.onGit === 'function') return script.onGit(argv, options)
        return result(true, '')
      },
      async probe() {
        return { available: true, version: 'gh version 2.89.0' }
      },
    },
  }
}

/**
 * A fake plugin context recording tool registrations, guards, and log lines.
 *
 * The logger applies printf-style interpolation (`%s`, `%d`) because that is
 * the real dsh Logger contract — shipped plugins call it as
 * `ctx.logger.warn('config update at %C failed', filename)`. A fake that merely
 * joined its arguments would hide a malformed format string.
 *
 * `ctx.inject(names, callback)` mirrors the real deferred injection: the callback
 * runs immediately with a scoped context when every named service is present, and
 * is skipped otherwise. Modelling that shape matters — the branch route first read
 * `ctx.get('webServer')` directly in `apply` and therefore never registered under
 * a real composition, because Cordis loads a plugin only once the services it
 * DECLARES are ready and this plugin declares only `tools`.
 *
 * @param {{ services?: Record<string, unknown> }} [options] services to compose
 * @returns {{ ctx: any, tools: Map<string, any>, guards: any[], logs: string[], listeners: Map<string, Function[]>, emit: Function, injected: string[][] }}
 */
export function makeContext(options = {}) {
  const services = options.services ?? {}
  const tools = new Map()
  const guards = []
  const logs = []
  const listeners = new Map()
  /** Every `inject()` call, so a test can assert one happened at all. */
  const injected = []
  /**
   * Interpolate the printf subset the plugin uses.
   * @param {unknown[]} args the raw logger arguments
   * @returns {string} the rendered line
   */
  const format = (args) => {
    const [first, ...rest] = args
    if (typeof first !== 'string') return args.map((a) => String(a)).join(' ')
    let index = 0
    return first.replace(/%[sdCoO%]/g, (match) => {
      if (match === '%%') return '%'
      if (index >= rest.length) return match
      const value = rest[index]
      index += 1
      return typeof value === 'string' ? value : JSON.stringify(value)
    }) + (index < rest.length ? ' ' + rest.slice(index).map((a) => String(a)).join(' ') : '')
  }
  const logger = {
    info: (...args) => logs.push(format(args)),
    warn: (...args) => logs.push(format(args)),
    error: (...args) => logs.push(format(args)),
    debug: (...args) => logs.push(format(args)),
  }
  /** Run one resource-registering callback, mirroring `ctx.effect`. */
  const ctxEffect = (fn) => {
    const disposer = typeof fn === 'function' ? fn() : undefined
    return typeof disposer === 'function' ? disposer : () => {}
  }
  /** Register one event listener, returning its real disposer. */
  const ctxOn = (event, listener) => {
    const bucket = listeners.get(event) ?? []
    bucket.push(listener)
    listeners.set(event, bucket)
    return () => {
      const current = listeners.get(event) ?? []
      const at = current.indexOf(listener)
      if (at !== -1) current.splice(at, 1)
    }
  }
  /**
   * A scoped context with exactly what `ctx.inject` hands a callback.
   *
   * `inject` gates TIMING — it decides when the callback runs — while `ctx.get`
   * stays a lookup against the whole service registry. Modelling `get` as limited
   * to the injected names would be wrong and was: it made a route that reads
   * `get('workspaceRegistry')` inside a `['webServer']` injection look broken.
   * Only the direct property access reflects the injected set.
   *
   * @param {string[]} names the injected service names
   * @returns {any} the scoped context
   */
  const scopeOf = (names) => ({
    logger,
    get: (name) => services[name],
    effect: ctxEffect,
    on: ctxOn,
    ...Object.fromEntries(names.filter((name) => name in services).map((name) => [name, services[name]])),
  })

  const ctx = {
    logger,
    get: (name) => services[name],
    effect: ctxEffect,
    on: ctxOn,
    /**
     * Deferred optional injection, mirroring the framework: the callback runs only
     * when every named service exists, and never when one is missing — which is
     * the behaviour the branch route depends on.
     * @param {string[]} names the service names
     * @param {(scoped: any) => unknown} callback the body
     * @returns {() => void} the disposer
     */
    inject: (names, callback) => {
      const list = Array.isArray(names) ? names : [names]
      injected.push(list)
      if (list.every((name) => services[name] !== undefined)) callback(scopeOf(list))
      return () => {}
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      guard: (guard) => {
        guards.push(guard)
        return () => {
          const index = guards.indexOf(guard)
          if (index !== -1) guards.splice(index, 1)
        }
      },
    },
  }
  /**
   * Dispatch a `tools/pre-execute` waterfall the way the registry does: each
   * listener may return an outcome, or call `next()` to defer to the rest.
   * @param {any} execution the execution identity
   * @param {() => Promise<any>} [terminal] the outcome when nothing objects
   * @returns {Promise<any>} the first non-deferred outcome
   */
  const emit = async (execution, terminal = async () => ({ kind: 'allow' })) => {
    const chain = listeners.get('tools/pre-execute') ?? []
    let index = -1
    const next = async () => {
      index += 1
      if (index >= chain.length) return terminal()
      return chain[index](execution, next)
    }
    return next()
  }
  return { ctx, tools, guards, logs, listeners, emit, injected }
}

/**
 * A normalized config with test-friendly defaults.
 *
 * The Config schema normally runs inside Cordis during activation; the offline
 * suite calls `normalizeConfig` directly, which is the same normalization the
 * plugin applies to the framework's validated output.
 *
 * @param {object} [overrides] config keys to override
 * @returns {any} the normalized config
 */
export function testConfig(overrides = {}) {
  return normalizeConfig(overrides)
}

/**
 * Execute a registered tool action and return its result.
 *
 * The arguments are DETACHED and FROZEN first, because that is what the registry
 * does before dispatch — it materializes `arguments` as lossless JSON and freezes
 * that value before policy begins. A plugin that writes a resolved value back
 * into `args` therefore throws `Cannot assign to read only property` in
 * production, and handing it a plain mutable object here hides exactly that. It
 * did hide it: the ref sentinels mutated `args`, every offline check passed, and
 * the first live call failed.
 *
 * @param {any} definition the registered tool definition
 * @param {object} args the action arguments
 * @returns {Promise<any>} the tool result
 */
export async function call(definition, args) {
  return definition.execute(deepFreeze(JSON.parse(JSON.stringify(args))), { signal: undefined })
}

/**
 * Freeze an object graph in place.
 * @template T
 * @param {T} value the value to freeze
 * @returns {T} the same value, frozen
 */
export function deepFreeze(value) {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/**
 * Collect every keyword used anywhere in a schema tree.
 * @param {any} schema the schema to walk
 * @param {Set<string>} [seen] accumulator
 * @returns {Set<string>} the keyword set
 */
export function keywordsOf(schema, seen = new Set()) {
  if (typeof schema !== 'object' || schema === null) return seen
  for (const [key, value] of Object.entries(schema)) {
    seen.add(key)
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) keywordsOf(child, seen)
    } else if (key === 'items' || key === 'oneOf') {
      if (Array.isArray(value)) value.forEach((child) => keywordsOf(child, seen))
      else keywordsOf(value, seen)
    }
  }
  return seen
}
