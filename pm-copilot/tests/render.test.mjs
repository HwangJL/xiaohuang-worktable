/**
 * PM Copilot — Client render test.
 *
 * The registration tests never mounted the panel, so a part-ordering bug could
 * ship a bundle whose pages were never registered: the runtime then retired the
 * entry on the first render and the center column simply went blank. This test
 * mounts the panel through a miniature React that executes function components
 * and hooks, so a throwing first render fails here instead of in the GUI.
 *
 * Run with: node tests/render.test.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ARTIFACT = path.join(path.dirname(HERE), 'client.js')
const PACKAGE_NAME = '@local/dsh-pm-copilot'

/** The real `GET /state` value for an empty cockpit, copied from the Host. */
const SNAPSHOT = {
  identity: { preset: 'xiaohuang', verified: true },
  workspace: { path: 'D:\\project', title: 'project' },
  projects: [], tasks: [], executions: [], deliverables: [], decisions: [],
  knowledge: [], prds: [], solutions: [],
  quality: { issues: [], reports: [] },
  metrics: { todo: 0, executing: 0, confirming: 0, done: 0, knowledgePending: 0, qualityOpen: 0 },
  dashboard: {
    currentWork: null, recentTasks: [],
    todoItems: [
      { key: 'business', title: '等待业务确认', items: [] },
      { key: 'decision', title: '等待产品决策', items: [] },
      { key: 'material', title: '等待补充资料', items: [] },
      { key: 'knowledge', title: '等待知识审核', items: [] },
      { key: 'fix', title: '待修正问题', items: [] },
    ],
  },
  skills: { available: true, items: [] },
  knowledgeStats: { wikiCount: 0, rawCount: 0, indexPresent: false, templateCount: 7 },
  capabilities: { agent: true, skills: true, knowledgeRead: true, knowledgeWrite: true, quality: true, workspace: true },
  skillUsage: {}, revision: 0, generatedAt: '2026-01-01T00:00:00.000Z',
  sessionId: 'session-test', identityVerified: true,
}

/* ------------------------------------------------------------------ mini React */

const hooks = new Map()
let renderingKey = null
let hookIndex = 0
let dirty = false
let effectQueue = []
let collected = []

function storeFor(key) {
  if (!hooks.has(key)) hooks.set(key, [])
  return hooks.get(key)
}

function createElement(type, props, ...children) {
  const merged = { ...(props || {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}

const Fragment = Symbol('fragment')

/** Minimal React class base, enough for the plugin's page boundary. */
class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }
}

function sameDeps(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

const React = {
  createElement,
  Fragment,
  Component,
  useState(initial) {
    const store = storeFor(renderingKey)
    const index = hookIndex++
    if (!(index in store)) store[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = store[index]
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (value !== slot.value) {
        slot.value = value
        dirty = true
      }
    }
    return [slot.value, set]
  },
  useEffect(fn, deps) {
    const store = storeFor(renderingKey)
    const index = hookIndex++
    const previous = store[index]
    const changed = !previous || !sameDeps(previous.deps, deps)
    store[index] = { deps, fn }
    if (changed) effectQueue.push(fn)
  },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useRef(current) {
    const store = storeFor(renderingKey)
    const index = hookIndex++
    if (!(index in store)) store[index] = { current }
    return store[index]
  },
  useSyncExternalStore(getSnapshot) { return getSnapshot() },
}

function renderNode(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
  if (Array.isArray(node)) { for (const child of node) renderNode(child, out); return }
  collected.push(node)
  if (typeof node.type === 'function') {
    const outer = renderingKey
    const outerIndex = hookIndex
    renderingKey = node.type
    hookIndex = 0
    // A class component (the page boundary) is rendered from its prototype.
    if (node.type.prototype && typeof node.type.prototype.render === 'function') {
      const instance = new node.type(node.props || {})
      renderingKey = outer
      hookIndex = outerIndex
      renderNode(instance.render(), out)
      return
    }
    const result = node.type(node.props || {})
    renderingKey = outer
    hookIndex = outerIndex
    renderNode(result, out)
    return
  }
  if (node.type === Fragment) { renderNode(node.props.children, out); return }
  if (typeof node.type === 'string') { renderNode(node.props.children, out); return }
  throw new Error('Invalid element type: ' + String(node.type))
}

/* ------------------------------------------------------------------ transport */

globalThis.fetch = async () => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  async text() { return JSON.stringify({ ok: true, value: SNAPSHOT }) },
})
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }

/* ------------------------------------------------------------------ module */

const registrations = []
let captured

globalThis.window = {
  __ModuleLoader__: { load(definition) { captured = definition; return definition } },
}

await import(pathToFileURL(CLIENT_ARTIFACT).href)

assert.ok(captured, 'the artifact registers one lazy factory')
assert.equal(captured.id, PACKAGE_NAME, 'the factory id equals the package name')

const module = captured.factory((request) => {
  if (request === 'react') return React
  if (request === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement, Fragment }
  throw new Error('unexpected module request: ' + request)
})

const SESSION_STATE = {
  byId: { [SNAPSHOT.sessionId]: { cwd: SNAPSHOT.workspace.path, retainedBy: { mainView: 1 } } },
  allIds: [SNAPSHOT.sessionId],
}

const ctx = {
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  slots: {
    inject(key, callback) { callback(); return () => {} },
    register(options, component) { registrations.push({ slot: options.name, options, component }); return () => {} },
  },
  sessions: { list: { getSnapshot: () => SESSION_STATE, subscribe: () => () => {} } },
  locale: { bind: () => (key) => key, register: () => () => {} },
  layout: {},
}

module.apply(ctx, {})

const main = registrations.find((entry) => entry.slot === 'main')
assert.ok(main, 'apply registers the main panel')

/* ------------------------------------------------------------------ render */

async function settle() {
  const root = main.component({})
  let text = ''
  let buttons = []
  for (let pass = 0; pass < 24; pass += 1) {
    dirty = false
    effectQueue = []
    collected = []
    const out = []
    renderNode(root, out)
    text = out.join('')
    buttons = collected
    for (const effect of effectQueue) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) return { text, buttons }
  }
  return { text, buttons }
}

test('the first render reaches a cockpit page instead of throwing', async () => {
  // The runtime retires a panel entry that throws on its first render, which is
  // what silently blanked the center column. Reaching the page shell proves the
  // pages registry, the shared helpers and the data hook all resolved.
  const first = await settle()
  assert.match(first.text, /pmc-page/, 'the page shell renders')
  assert.match(first.text, /ov\.metric\.todo/, 'the overview page renders its own content')
  assert.match(first.text, /nav\.overview/, 'the navigation renders')
})

test('every navigation entry renders its page', async () => {
  const first = await settle()
  const navs = first.buttons.filter((node) => typeof node.type === 'string' && node.type === 'button'
    && node.props && typeof node.props.title === 'string' && node.props.title.startsWith('nav.'))
  assert.equal(navs.length, 10, 'all ten navigation entries are present')
  for (const nav of navs) {
    nav.props.onClick()
    const next = await settle()
    assert.match(next.text, /pmc-page/, 'page body renders for ' + nav.props.title)
    assert.ok(next.text.length > 10000, 'page ' + nav.props.title + ' has content')
  }
})
