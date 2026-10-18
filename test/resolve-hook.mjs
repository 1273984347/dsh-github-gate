/**
 * Test-only module resolution hook.
 *
 * The plugin imports `@deepseek-ai/schemastery` (its Config schema) and
 * `@deepseek-ai/dsh-tools` (tool definitions). Inside the Harness those bare
 * names resolve through the runtime resolution the launcher installs on Node's
 * resolvers — an in-process interception that a standalone `node` run cannot
 * see, so an unmodified test run would fail to import the plugin at all.
 *
 * This hook redirects ONLY those bare `@deepseek-ai/*` specifiers to the
 * vendored copies in `test/.vendor/node_modules`, which tools/asar-vendor.mjs
 * reconstructs byte-for-byte from the same installation the Harness will use.
 * Everything else — especially the plugin's own relative imports — resolves
 * normally, so the tests still exercise the real source tree.
 *
 * Redirecting is done by re-resolving the specifier with a parentURL inside the
 * vendor directory, which lets Node apply its ordinary algorithm there instead
 * of this hook reimplementing package resolution.
 */

import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const anchor = pathToFileURL(join(here, '.vendor', 'anchor.mjs')).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return nextResolve(specifier, { ...context, parentURL: anchor })
  }
  return nextResolve(specifier, context)
}
