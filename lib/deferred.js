/**
 * Install something once a service exists, and only then.
 *
 * ## Why this exists
 *
 * Cordis loads a plugin when the services it DECLARES in `inject` are ready. A
 * plugin that needs a service it must NOT hard-depend on — because a headless or
 * minimal composition legitimately lacks it — has to wait instead. Three ways were
 * tried against the running Desktop composition; two failed:
 *
 * 1. `ctx.get(name)` once in `apply` — not there yet. The caller skipped silently.
 * 2. `ctx.inject([name], cb)` — the callback did not run either, measured.
 * 3. `ctx.on('internal/service', …)` — **works**, and is what the shipped plugins
 *    use. Cordis emits `'internal/service'(this: Context, name: string, value: any)`
 *    for every service registration.
 *
 * The mechanism lived inside the branch-pill bridge until a second caller appeared.
 * It is extracted rather than copied on purpose: a subtle lifecycle rule duplicated
 * in two files is how the two copies drift apart, and this one already cost three
 * diagnosis rounds.
 *
 * ## Ownership
 *
 * The install callback runs inside `ctx.effect`, so whatever it registers is tied
 * to the plugin's fiber and released on disposal. That is not decoration: a route
 * registered OUTSIDE an effect leaked, and the next activation failed with
 * `webserver: duplicate exact route`.
 *
 * @param {any} ctx the plugin context
 * @param {string} serviceName the service to wait for
 * @param {(service: any) => unknown} install called once, with the service
 * @param {{ logger?: any, label?: string }} [options] logging
 * @returns {boolean} whether the service was already available at call time
 */
export function installWhenAvailable(ctx, serviceName, install, options = {}) {
  const { logger, label = serviceName } = options
  if (typeof ctx?.on !== 'function' || typeof ctx?.get !== 'function' || typeof ctx?.effect !== 'function') {
    logger?.warn?.('%s: this context cannot observe services, so it is not installed', label)
    return false
  }

  /** Whether the install already ran, so a repeat announcement is a no-op. */
  let installed = false
  /** Whether a failure was already reported, so the event does not spam the log. */
  let complained = false

  const attempt = () => {
    if (installed) return
    const service = ctx.get(serviceName)
    if (service === undefined) return
    // `installed` is set AFTER the effect is created: a throwing install must stay
    // retryable, and marking it done first would silently disable every later try.
    ctx.effect(() => install(service))
    installed = true
    complained = false
  }

  const guarded = () => {
    try {
      attempt()
    } catch (error) {
      if (!complained) {
        complained = true
        logger?.warn?.('%s could not be installed: %s', label, String(error?.message ?? error))
      }
    }
  }

  // The service may already be composed by the time this plugin activates.
  guarded()
  const already = installed

  // …and it may arrive later, which is the common case for an optional capability.
  ctx.effect(() => ctx.on('internal/service', (name) => {
    if (name === serviceName) guarded()
  }))

  return already
}
