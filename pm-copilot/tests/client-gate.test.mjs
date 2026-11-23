/**
 * PM Copilot — Client registration-layer tests.
 *
 * These tests execute the real `client.js` factory against a stand-in Cordis
 * Client context and assert the registration contract: the sidebar entry and
 * the main panel are registered for EVERY composition, regardless of the Agent
 * preset the main-view Session runs.
 *
 * The preset is no longer a registration-layer decision — it surfaces inside
 * the rendered cockpit as a notice, while the Host keeps refusing writes from
 * a Session whose identity is not `xiaohuang`. A hidden entry would blank the
 * center column whenever the layout still pointed at it, so the entry is
 * always present and the panel explains itself instead.
 *
 * React is provided as a minimal stand-in: the plugin's page components are
 * never rendered here, so no hook is executed. Any hook the plugin calls during
 * `apply` is answered by the stub, which also documents which hooks the plugin
 * relies on.
 *
 * Run with: node tests/client-gate.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ARTIFACT = path.join(path.dirname(HERE), 'client.js')
const PACKAGE_NAME = '@local/dsh-pm-copilot'

/** A minimal React stand-in: only element creation and inert hooks. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (current) => ({ current }),
  // The page boundary is a class component, so the factory evaluates
  // `class PageBoundary extends React.Component` at load time.
  Component: class { constructor(props) { this.props = props; this.state = {} } },
  Fragment: 'fragment',
}
const jsxRuntimeStub = { jsx: reactStub.createElement, jsxs: reactStub.createElement, Fragment: 'fragment' }

/** Load the artifact and hand back its lazy factory. */
async function loadFactory() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
        return definition
      },
    },
  }
  await import(pathToFileURL(CLIENT_ARTIFACT).href)
  assert.ok(captured, 'the artifact registers one lazy factory')
  assert.equal(captured.id, PACKAGE_NAME, 'the factory id equals the package name')
  assert.equal(typeof captured.factory, 'function')
  const module = captured.factory((request) => {
    if (request === 'react') return reactStub
    if (request === 'react/jsx-runtime') return jsxRuntimeStub
    throw new Error('unexpected module request: ' + request)
  })
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots', 'sessions', 'locale', 'layout'])
  return module
}

/** One observed `ctx.slots.register` call. */
function makeSlots() {
  const live = []
  const slots = {
    inject(key, callback) {
      const disposers = []
      const result = callback()
      if (typeof result === 'function') disposers.push(result)
      live.push({ key, disposers })
      return () => { for (const dispose of disposers.splice(0)) dispose() }
    },
    register(options) {
      const record = { options, disposed: false }
      const dispose = () => {
        if (record.disposed) return
        record.disposed = true
        const index = registered.indexOf(record)
        if (index >= 0) registered.splice(index, 1)
      }
      registered.push(record)
      return dispose
    },
  }
  const registered = []
  return { slots, registered, live }
}

/** A minimal observable snapshot, the shape `ctx.sessions.list` publishes. */
function makeList(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

/** Build a stand-in Client context around a session catalog. */
function makeContext({ rows }) {
  const { slots, registered, live } = makeSlots()
  const list = makeList({ byId: rows, ids: Object.keys(rows), projectionsBySession: {} })
  const refreshCalls = []
  const selectedPanels = []
  const dictionaries = []
  const services = {
    slots,
    sessions: {
      list,
      refreshProjections: async (sessionId) => {
        refreshCalls.push(sessionId)
      },
    },
    locale: {
      bind: () => (key) => key,
      register: (namespace, dicts) => {
        dictionaries.push(namespace)
        return () => {}
      },
    },
    layout: {
      panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} },
      selectPanel: (id) => selectedPanels.push(id),
    },
  }
  const effects = []
  const listeners = new Map()
  const ctx = {
    get: (name) => services[name],
    effect: (factory) => {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    on: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {}
    },
  }
  // Cordis exposes every injected service as a context property as well as
  // through `get`, so the stub mirrors both faces.
  for (const [name, service] of Object.entries(services)) ctx[name] = service
  return {
    ctx, list, registered, live, refreshCalls, selectedPanels, dictionaries,
    services,
    emit: (name, ...args) => { for (const handler of listeners.get(name) || []) handler(...args) },
    teardown: () => { for (const dispose of effects.splice(0)) if (typeof dispose === 'function') dispose() },
  }
}

/** One catalog row; `preset` absent means the summary carries no projection. */
function row(id, preset) {
  return {
    id,
    title: 'session ' + id,
    displayTitle: 'session ' + id,
    cwd: 'D:\\work\\demo',
    running: false,
    blank: false,
    updatedAt: 1,
    retainedBy: { mainView: 1 },
    ...(preset === undefined ? {} : { projectionValues: { agentPreset: preset } }),
  }
}

const panelRegistrations = (harness) => harness.registered.map((record) => record.options)
const sidebarIds = (harness) => panelRegistrations(harness)
  .filter((options) => options.name === 'sidebar.panellist')
  .map((options) => options.id)
const mainKeys = (harness) => panelRegistrations(harness)
  .filter((options) => options.name === 'main')
  .map((options) => options.key)

test('PM Copilot Client registration', async (t) => {
  const module = await loadFactory()

  await t.test('every catalog gets the sidebar entry and the main panel', () => {
    const catalogs = [{}, { s1: row('s1', 'standard') }, { s1: row('s1', 'cordis') }, { s1: row('s1', 'xiaohuang') }]
    for (const rows of catalogs) {
      const harness = makeContext({ rows })
      module.apply(harness.ctx)
      assert.deepEqual(sidebarIds(harness), ['pm-copilot'], 'the left sidebar entry is registered for ' + JSON.stringify(Object.keys(rows)))
      assert.deepEqual(mainKeys(harness), ['pm-copilot'], 'the matching main panel is registered')
      harness.teardown()
    }
  })

  await t.test('a preset change never adds or drops a registration', () => {
    const harness = makeContext({ rows: { s1: row('s1', 'xiaohuang') } })
    module.apply(harness.ctx)
    assert.deepEqual(sidebarIds(harness), ['pm-copilot'])
    // The main view moves to another Session; the preset changes meaning, not
    // the existence of the entry. A registration churn here used to leave the
    // center column blank whenever the layout still pointed at the panel.
    harness.list.set({
      byId: { s1: { ...row('s1', 'xiaohuang'), retainedBy: {} }, s2: row('s2', 'standard') },
      ids: ['s1', 's2'],
      projectionsBySession: {},
    })
    assert.deepEqual(sidebarIds(harness), ['pm-copilot'], 'the entry survives a move to a non-小黄 Session')
    assert.deepEqual(mainKeys(harness), ['pm-copilot'])
    harness.list.set({ byId: { s1: row('s1', 'cordis') }, ids: ['s1'], projectionsBySession: {} })
    assert.deepEqual(sidebarIds(harness), ['pm-copilot'], 'and survives a live preset change')
    harness.teardown()
  })

  await t.test('the entry keeps its id, order and localized label', () => {
    const harness = makeContext({ rows: { s1: row('s1', 'standard') } })
    module.apply(harness.ctx)
    const entry = panelRegistrations(harness).find((options) => options.name === 'sidebar.panellist')
    assert.equal(entry.id, 'pm-copilot')
    assert.equal(entry.order, 15)
    assert.equal(typeof entry.label, 'function')
    assert.ok(harness.live.some((item) => item.key === 'sidebar.panellist'), 'registration waits on the shell declaration')
    assert.ok(harness.live.some((item) => item.key === 'main'), 'panel waits on the layout declaration')
    harness.teardown()
  })

  await t.test('unload disposes every registration it created', () => {
    const harness = makeContext({ rows: { s1: row('s1', 'xiaohuang') } })
    module.apply(harness.ctx)
    assert.deepEqual(sidebarIds(harness), ['pm-copilot'])
    harness.teardown()
    assert.deepEqual(sidebarIds(harness), [], 'plugin unload removes the sidebar entry')
    assert.deepEqual(mainKeys(harness), [])
    assert.ok(harness.registered.length === 0, 'no registration survives teardown')
  })

  await t.test('the dictionaries are registered for both shipped locales', () => {
    const harness = makeContext({ rows: {} })
    module.apply(harness.ctx)
    assert.ok(harness.dictionaries.includes('pm-copilot'), 'the locale namespace is registered')
    harness.teardown()
  })

  await t.test('the artifact carries the mode notice and no baked-in identity', () => {
    const source = fs.readFileSync(CLIENT_ARTIFACT, 'utf8')
    for (const forbidden of ['os.userInfo', 'process.env.USERNAME', 'navigator.userAgent', 'localStorage.pmCopilotUser']) {
      assert.equal(source.includes(forbidden), false, 'the client half must not use ' + forbidden)
    }
    // The preset is no longer a registration decision: the Host reports the
    // identity it verified, and the panel repeats that as a notice.
    assert.ok(source.includes('top.notXiaohuang'), 'the notice text ships in both dictionaries')
    assert.ok(source.includes('identity.verified'), 'the notice is driven by the Host report, not by a guess')
  })
})
