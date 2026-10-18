/**
 * Registers test/resolve-hook.mjs so the offline suite can import the plugin's
 * bare `@deepseek-ai/*` imports against the vendored copies.
 *
 * Used as: node --import ./test/register-hook.mjs --test ...
 */

import { register } from 'node:module'

register('./resolve-hook.mjs', import.meta.url)
