/**
 * Contract tests for the browser half.
 *
 * The client module is a plain script: it talks to `window.__ModuleLoader__`, gets
 * React from `require`, and returns a Cordis plugin object. None of that is
 * exercised by Node's module system, which is exactly why a broken client half can
 * ship — it fails only when a browser loads it.
 *
 * This file loads `client.js` the way the shell does: a fake loader collects the
 * factory, a minimal React stand-in lets the components be *called* (not rendered),
 * and a fake `ctx.slots` records the registrations. It then proves the two things a
 * reader cares about:
 *
 *   1. both contributions register into the right slots with their own ids, so
 *      loading the plugin does not replace a shipped tab or pill;
 *   2. the components return an element tree instead of throwing, because a
 *      throwing component blanks the whole slot it is mounted in.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client.js')

/**
 * A React stand-in sufficient to build the element tree without a DOM.
 *
 * Hooks are stubbed: `useState` returns a value and a no-op setter, `useEffect`
 * runs its body once, `useCallback` returns the function. That is enough for a
 * component to be CALLED, which is where a bad `h(...)` call or a missing import
 * would throw.
 */
function makeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
  })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (body) => { body() },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    Fragment: 'Fragment',
  }
}

/** Load the browser half the way the shell does. */
function loadClient() {
  const loaded = []
  const react = makeReact()
  const globalWindow = {
    __ModuleLoader__: {
      load: (descriptor) => loaded.push(descriptor),
    },
  }
  const previous = globalThis.window
  globalThis.window = globalWindow
  try {
    // The script is not an ES module; evaluate it with `window` and `require` in scope.
    const source = readFileSync(CLIENT, 'utf8')
    const React = react
    const requireShim = (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${JSON.stringify(name)}) in the browser half`)
    }
    // eslint-disable-next-line no-new-func -- the file is a shell script, not a module
    const run = new Function('window', 'require', source)
    run(globalWindow, requireShim)
  } finally {
    globalThis.window = previous
  }
  return { descriptors: loaded, react }
}

/** A fake slots service that records injections and registrations. */
function makeSlots() {
  const injected = []
  const registered = []
  return {
    injected,
    registered,
    service: {
      inject: (slot, callback) => {
        injected.push(slot)
        return callback()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
}

/** Run the plugin's apply() against the fake context. */
function applyClient({ descriptor, react }) {
  const slots = makeSlots()
  const ctx = {
    slots: slots.service,
    effect: (body) => body(),
  }
  // The factory's ONLY allowed import is `react`; anything else would be a Client
  // package this plugin does not own (and cannot keep stable). The require shim
  // enforces that by throwing on every other specifier.
  const requireShim = (name) => {
    if (name === 'react') return react
    throw new Error(`the browser half must not require ${JSON.stringify(name)}`)
  }
  const plugin = descriptor.factory(requireShim)
  assert.equal(typeof plugin.apply, 'function', 'the client half must export apply()')
  assert.deepEqual(plugin.inject, ['slots'], 'the client half needs the slots service')
  plugin.apply(ctx)
  return slots
}

test('client: the module registers through __ModuleLoader__ with the package id', () => {
  const { descriptors } = loadClient()
  assert.equal(descriptors.length, 1, 'exactly one module load per script')
  assert.equal(descriptors[0].id, 'dsh-github-gate', 'the loader keys a module by this id')
  assert.equal(typeof descriptors[0].factory, 'function')
})

test('client: both contributions register into their own slots with their own ids', () => {
  const { descriptors, react } = loadClient()
  const slots = applyClient({ descriptor: descriptors[0], react })

  assert.deepEqual(slots.injected, [
    'conversation.session.header.utilities',
    'settings.plugins.tab',
  ], 'two independent injections, one per slot')

  assert.equal(slots.registered.length, 2)
  const [pill, settings] = slots.registered
  assert.equal(pill.options.name, 'conversation.session.header.utilities')
  assert.equal(pill.options.id, 'dsh-github-gate-branch')
  assert.equal(settings.options.name, 'settings.plugins.tab')
  assert.equal(settings.options.id, 'dsh-github-gate-settings')
  assert.equal(settings.options.label, 'GitHub', 'a tab needs a label; the pill has none')

  // A fresh id sits BESIDE a shipped entry. Reusing one would replace it, which the
  // slot catalog warns about and this test pins.
  assert.notEqual(pill.options.id, 'open-in-app')
  assert.notEqual(settings.options.id, 'all')
})

test('client: the settings component builds an element tree instead of throwing', () => {
  const { descriptors, react } = loadClient()
  const slots = applyClient({ descriptor: descriptors[0], react })
  const settings = slots.registered.find((entry) => entry.options.name === 'settings.plugins.tab')
  assert.ok(settings !== undefined)

  // Called directly, the first render sees `status === null` and shows the loading
  // state. The point is that it RETURNS an element rather than throwing: a throwing
  // component blanks the entire slot it is mounted in.
  const tree = settings.component({})
  assert.equal(typeof tree, 'object')
  assert.equal(tree.props.className, 'ghg-page')
})

test('client: the branch pill component builds an element tree instead of throwing', () => {
  const { descriptors, react } = loadClient()
  const slots = applyClient({ descriptor: descriptors[0], react })
  const pill = slots.registered.find((entry) => entry.options.name === 'conversation.session.header.utilities')
  const tree = pill.component({ sessionId: '' })
  assert.equal(typeof tree, 'object')
  // The pill renders a root wrapper in every phase, including the idle one.
  assert.equal(tree.props.className, 'ghk-root')
})

test('client: the settings page only talks to its own namespaced routes', () => {
  // A hard-coded foreign path would be a capability leak across plugins. The prefixes
  // are the contract, so they are asserted rather than assumed.
  const source = readFileSync(CLIENT, 'utf8')
  const routes = [...source.matchAll(/'(\/[a-z0-9-]+\/[a-z0-9/-]+)'/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith('/'))
  assert.ok(routes.length > 0, 'the client half must address at least one route')
  for (const route of routes) {
    assert.match(route, /^\/dsh-github-gate\//, `route ${route} escapes this plugin's namespace`)
  }
})
