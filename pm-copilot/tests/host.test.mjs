/**
 * PM Copilot — Host half integration tests.
 *
 * These tests drive the real `apply()`, the real routes and the real action
 * layer against a temporary workspace, with a stand-in Cordis context. They do
 * not need a running DSH: they prove the Host half's own behavior — empty state
 * is genuinely empty, a created task persists, knowledge ingest writes real
 * files per `kb/SCHEMA.md`, quality issues are computed from real records, an
 * Agent call reaches `sessionController.prompt`, session events become trace
 * entries, and an unverified identity is refused.
 *
 * Run with: node --test tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { apply } from '../index.js'

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const WORKSPACE_ROOT = path.dirname(REPO_ROOT)

/**
 * Build a temporary workspace carrying a knowledge base.
 *
 * The starter shipped at the repository root (`kb-starter/`) wins, so a fresh
 * clone is self-sufficient. A checkout that sits inside a real DSH workspace
 * (`../kb`, the sibling of the repository) is the second choice, and a bare
 * schema is the last resort.
 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-copilot-test-'))
  const kbTarget = path.join(root, 'kb')
  const starter = path.join(WORKSPACE_ROOT, 'kb-starter')
  const liveWorkspaceKb = path.join(WORKSPACE_ROOT, 'kb')
  const kbSource = [starter, liveWorkspaceKb].find((candidate) => fs.existsSync(candidate))
  if (kbSource) {
    fs.cpSync(kbSource, kbTarget, { recursive: true })
  } else {
    fs.mkdirSync(kbTarget, { recursive: true })
    fs.writeFileSync(path.join(kbTarget, 'SCHEMA.md'), '# 知识库操作手册\n\n## 1. 目录结构\n\n## 8. 写作纪律\n', 'utf8')
  }
  return root
}

/** A stand-in Cordis context exposing only the services under test. */
function makeContext(options) {
  const state = {
    routes: [],
    listeners: new Map(),
    prompts: [],
    disposers: [],
  }
  const services = {
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => { state.routes = state.routes.filter((candidate) => candidate !== route) }
      },
    },
    connection: { requestRejection: () => undefined },
    skills: {
      async list() {
        return [
          { name: 'prd-writer', description: 'Writes PRDs from confirmed analysis', invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'filesystem', path: '/skills/prd-writer/SKILL.md' },
          { name: 'business-flow-analysis', description: 'Business flow analysis skill', invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'filesystem' },
        ]
      },
      async get(name) {
        return { name, description: 'stub', content: '# ' + name + '\n\nbody', invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'filesystem' }
      },
    },
    sessionController: {
      async prompt(request) {
        state.prompts.push(request)
        return { accepted: true }
      },
    },
    agentPresets: {
      async presetForSession(session) {
        return session && session.preset ? session.preset : null
      },
    },
    sessions: {
      get(sessionId) {
        const preset = options.presets[sessionId]
        return preset === undefined ? undefined : { header: { agentPreset: preset }, preset }
      },
    },
    workspaceRegistry: {
      list() {
        return []
      },
    },
    systemPrompt: {
      sections: [],
      section(definition) {
        this.sections.push(definition)
        return () => { this.sections = this.sections.filter((item) => item !== definition) }
      },
    },
    agents: {
      list() {
        return []
      },
    },
    tools: {
      tools: [],
      register(definition) {
        this.tools.push(definition)
        return () => { this.tools = this.tools.filter((item) => item !== definition) }
      },
    },
  }
  const ctx = {
    get(name) { return services[name] },
    inject(names, callback) {
      const scoped = { get: (name) => services[name], effect: (fn) => { const dispose = fn(); state.disposers.push(dispose); return dispose } }
      callback(scoped)
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') state.disposers.push(dispose)
      return dispose
    },
    on(name, handler) {
      if (!state.listeners.has(name)) state.listeners.set(name, [])
      state.listeners.get(name).push(handler)
      return () => { state.listeners.set(name, (state.listeners.get(name) || []).filter((h) => h !== handler)) }
    },
    emit(name, ...args) {
      for (const handler of state.listeners.get(name) || []) handler(...args)
    },
  }
  return { ctx, state, services }
}

/** Call one registered route through a fake request/response pair. */
async function callRoute(routes, pathname, { method = 'GET', query = {}, body } = {}) {
  const route = routes.find((candidate) => candidate.path === pathname)
  assert.ok(route, 'route ' + pathname + ' is registered')
  const url = pathname + '?' + new URLSearchParams(query).toString()
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  const captured = { status: 200, headers: {}, text: null }
  const res = {
    headersSent: false,
    writeHead(status, headers) { captured.status = status; captured.headers = headers || {}; this.headersSent = true },
    end(text) { if (text !== undefined) captured.text = String(text) },
  }
  await route.handler(req, res)
  let json = null
  try { json = captured.text === null ? null : JSON.parse(captured.text) } catch { json = null }
  return { status: captured.status, headers: captured.headers, text: captured.text, json }
}

/** Read the cockpit state file of a temporary workspace. */
function readState(workspace) {
  const file = path.join(workspace, '.pm-copilot', 'state.json')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('PM Copilot Host half', async (t) => {
  const workspace = makeWorkspace()
  const { ctx, state, services } = makeContext({ presets: { 'xiaohuang-session': 'xiaohuang', 'standard-session': 'standard' } })
  apply(ctx)

  const ROUTES = ['/api/pm-copilot/state', '/api/pm-copilot/action', '/api/pm-copilot/file']
  assert.equal(state.routes.length, 3, 'three exact routes are registered')
  for (const route of state.routes) assert.equal(route.kind, 'exact')

  await t.test('empty state is genuinely empty and reports real capabilities', async () => {
    const answer = await callRoute(state.routes, ROUTES[0], { query: { sessionId: 'xiaohuang-session', workspacePath: workspace } })
    assert.equal(answer.json.ok, true)
    const value = answer.json.value
    assert.deepEqual(value.tasks, [])
    assert.equal(value.metrics.todo, 0)
    assert.equal(value.metrics.done, 0)
    assert.equal(value.identity.preset, 'xiaohuang')
    assert.equal(value.identity.verified, true)
    assert.equal(value.skills.available, true)
    assert.equal(value.skills.items.length, 2)
    assert.equal(value.capabilities.agent, true)
    assert.ok(value.knowledgeStats.templateCount >= 1, 'the real kb templates are counted')
  })

  await t.test('an unverified identity is refused for writes', async () => {
    const answer = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: { action: 'task.create', sessionId: 'standard-session', workspacePath: workspace, payload: { title: 'should not exist', description: '', type: 'requirement', priority: 'P1' } },
    })
    assert.equal(answer.json.ok, false)
    assert.equal(answer.json.code, 'identity-unverified')
    assert.equal(fs.existsSync(path.join(workspace, '.pm-copilot', 'state.json')), false, 'no state file was created by the refused write')
  })

  await t.test('a task is created and persisted', async () => {
    const answer = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: {
        action: 'task.create',
        sessionId: 'xiaohuang-session',
        workspacePath: workspace,
        payload: { title: '运输计费规则重构', description: '重构计费规则并补齐异常场景', type: 'business', priority: 'P1' },
      },
    })
    assert.equal(answer.json.ok, true, 'task.create answered: ' + JSON.stringify(answer.json))
    const created = answer.json.value && answer.json.value.task
    assert.ok(created && created.taskId, 'the created task is returned')
    const stored = readState(workspace)
    assert.equal(stored.tasks.length, 1)
    assert.equal(stored.tasks[0].title, '运输计费规则重构')
    const audit = fs.readFileSync(path.join(workspace, '.pm-copilot', 'audit.jsonl'), 'utf8').trim().split('\n')
    assert.ok(audit.length >= 1, 'the write is audited')
  })

  await t.test('an Agent call reaches sessionController.prompt and is traced', async () => {
    const stored = readState(workspace)
    const taskId = stored.tasks[0].taskId
    const answer = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: { action: 'task.run', sessionId: 'xiaohuang-session', workspacePath: workspace, payload: { taskId } },
    })
    assert.equal(answer.json.ok, true)
    assert.equal(state.prompts.length, 1, 'exactly one real prompt was queued')
    const prompt = state.prompts[0]
    assert.equal(prompt.sessionId, 'xiaohuang-session')
    assert.equal(prompt.mode, 'queue')
    assert.ok(prompt.content[0].text.includes('运输计费规则重构'), 'the prompt carries the real task context')
    const after = readState(workspace)
    assert.ok(after.executions.length >= 1, 'the execution is recorded before it is sent')
    assert.equal(after.tasks[0].status, 'executing')
  })

  await t.test('session events become trace entries and skill usage', async () => {
    const before = readState(workspace)
    const execution = before.executions[before.executions.length - 1]
    const session = { id: execution.sessionId }
    ctx.emit('session/event', session, { type: 'tool/call', time: Date.now(), data: { name: 'skill', arguments: JSON.stringify({ name: 'prd-writer' }) } })
    ctx.emit('session/event', session, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: '已按 PRD Skill 完成编写' }] } } })
    ctx.emit('session/event', session, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 700))
    const after = readState(workspace)
    assert.equal(after.skillUsage['prd-writer'].count, 1, 'skill usage incremented from a REAL tool/call event')
    assert.equal(after.tasks[0].status, 'confirming', 'a completed turn moves the task to 待确认')
    const traced = after.executions.find((item) => item.executionId === execution.executionId)
    assert.equal(traced.status, 'completed')
    assert.ok(traced.events.length >= 2)
  })

  await t.test('knowledge ingest writes real SCHEMA files', async () => {
    const answer = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: {
        action: 'knowledge.ingest', sessionId: 'xiaohuang-session', workspacePath: workspace,
        payload: {
          title: '计费规则口径决策', type: 'decision', project: 'xiaohuang-mode',
          summary: '计费按里程阶梯计价，异常场景走人工复核。', body: '## 正文\n\n详见会话记录。',
          sources: ['会话记录'], tags: ['计费', '规则'], status: '待确认',
        },
      },
    })
    assert.equal(answer.json.ok, true)
    const pagePath = answer.json.value.path
    assert.ok(fs.existsSync(pagePath), 'the knowledge page exists on disk')
    const text = fs.readFileSync(pagePath, 'utf8')
    assert.ok(text.startsWith('---\n'), 'frontmatter is written per SCHEMA §6')
    for (const key of ['title:', 'id:', 'type:', 'project:', 'status:', 'scope:', 'sources:', 'tags:', 'created:', 'updated:']) {
      assert.ok(text.includes(key), 'frontmatter carries ' + key)
    }
    assert.ok(text.includes('status: 待确认'))
    const indexFile = path.join(workspace, 'kb', 'wiki', 'index.md')
    const logFile = path.join(workspace, 'kb', 'wiki', 'log.md')
    assert.ok(fs.existsSync(indexFile), 'index.md is appended')
    assert.ok(fs.existsSync(logFile), 'log.md is appended')
    assert.ok(fs.readFileSync(logFile, 'utf8').includes('ingest'))
    assert.ok(!answer.json.value.conflict || typeof answer.json.value.conflict === 'string')
  })

  await t.test('knowledge search reads the real files', async () => {
    const answer = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: { action: 'knowledge.search', sessionId: 'xiaohuang-session', workspacePath: workspace, payload: { query: '计费' } },
    })
    assert.equal(answer.json.ok, true)
    const items = answer.json.value.items
    assert.ok(items.length >= 1, 'the ingested page is found')
    const found = items.find((item) => String(item.title).includes('计费'))
    assert.ok(found, 'the decision page is among the hits')
    assert.equal(found.status, '待确认')
  })

  await t.test('quality check computes issues from real records', async () => {
    const answer = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: { action: 'quality.run', sessionId: 'xiaohuang-session', workspacePath: workspace, payload: { scope: 'all' } },
    })
    assert.equal(answer.json.ok, true)
    const issues = answer.json.value.issues
    assert.ok(issues.length >= 1, 'an incomplete task yields real issues')
    for (const issue of issues) {
      assert.ok(issue.dimension, 'every issue names a dimension')
      assert.ok(['blocker', 'major', 'minor'].includes(issue.severity))
      assert.ok(issue.title && issue.suggestion)
    }
    const after = readState(workspace)
    assert.ok(after.quality.reports.length >= 1)
  })

  await t.test('PRD save appends an immutable version file', async () => {
    const first = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: {
        action: 'prd.save', sessionId: 'xiaohuang-session', workspacePath: workspace,
        payload: { title: '计费重构 PRD', projectId: undefined, sections: { 需求背景: '背景', 验收标准: '验收' }, changeNote: 'v1' },
      },
    })
    assert.equal(first.json.ok, true)
    const prdId = first.json.value.prdId
    const v1Path = first.json.value.path
    assert.ok(fs.existsSync(v1Path), 'v1 exists')
    const v1Text = fs.readFileSync(v1Path, 'utf8')
    const second = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: { action: 'prd.save', sessionId: 'xiaohuang-session', workspacePath: workspace, payload: { prdId, title: '计费重构 PRD', sections: { 需求背景: '背景（修订）' }, changeNote: 'v2' } },
    })
    assert.equal(second.json.ok, true)
    assert.notEqual(second.json.value.path, v1Path, 'saving creates a new version file')
    assert.equal(fs.readFileSync(v1Path, 'utf8'), v1Text, 'the original version is untouched')
  })

  await t.test('file reads are fenced to the workspace and above are 403', async () => {
    const inside = await callRoute(state.routes, ROUTES[2], { query: { workspacePath: workspace, path: path.join(workspace, 'kb', 'SCHEMA.md') } })
    assert.equal(inside.status, 200)
    assert.ok(inside.text.includes('知识库'))
    const outside = await callRoute(state.routes, ROUTES[2], { query: { workspacePath: workspace, path: path.join(os.tmpdir(), 'not-in-workspace.txt') } })
    assert.equal(outside.status, 403)
  })

  await t.test('unknown actions are refused with a stable code', async () => {
    const answer = await callRoute(state.routes, ROUTES[1], {
      method: 'POST',
      body: { action: 'not-a-real-action', sessionId: 'xiaohuang-session', workspacePath: workspace, payload: {} },
    })
    assert.equal(answer.json.ok, false)
    assert.ok(['unknown-action', 'action-invalid'].includes(answer.json.code))
  })

  await t.test('the pm_copilot tool is registered for the Agent', () => {
    const tools = services.tools.tools
    assert.equal(tools.length, 1, 'exactly one tool is registered')
    const tool = tools[0]
    assert.equal(tool.name, 'pm_copilot')
    assert.ok(tool.description.includes('pm_copilot') || tool.description.length > 0)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    const rendered = tool.output.render({ action: 'state' }, { ok: true })
    assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
  })

  await t.test('the cockpit announcement is scoped to the xiaohuang Agent only', async () => {
    const standardAgent = {
      session: { id: 'standard-session' },
      ctx: { get: (name) => (name === 'systemPrompt' ? services.systemPrompt : undefined) },
    }
    const cockpitAgent = {
      session: { id: 'xiaohuang-session' },
      ctx: { get: (name) => (name === 'systemPrompt' ? services.systemPrompt : undefined) },
    }
    ctx.emit('agent/created', { agent: standardAgent, source: 'startup' })
    ctx.emit('agent/created', { agent: cockpitAgent, source: 'startup' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const sections = services.systemPrompt.sections
    assert.equal(sections.length, 1, 'only the 小黄 Agent receives the announcement')
    assert.equal(sections[0].name, 'plugin:pm-copilot')
    assert.ok(sections[0].text.includes('PM Copilot'))
    assert.ok(sections[0].text.includes('pm_copilot'))
  })
})

test('routes mount once webServer activates after apply', () => {
  // A Loader may apply this plugin before `webServer` exists. Reading the
  // service once at apply time would then install no routes at all, which the
  // Client half reports as "Host 半边未挂载": its `fetch` gets a 404 from the
  // connection bridge instead of this plugin's JSON. Scoped injection must
  // therefore defer the mount until the service appears.
  const pending = []
  const services = {}
  const injected = []
  const ctx = {
    get(name) { return services[name] },
    inject(names, callback) {
      injected.push(names.slice())
      // Only the route mount is deferred here; the tool registration has its
      // own test above and must not be conflated with this one.
      if (names.includes('webServer')) pending.push(callback)
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      return dispose === undefined ? () => {} : dispose
    },
    on() { return () => {} },
  }
  apply(ctx)
  assert.ok(injected.some((names) => names.includes('webServer')), 'the route mount asks for webServer by scoped injection')
  assert.equal(pending.length, 1, 'the route mount waits for the scoped injection')
  assert.deepEqual(Object.keys(services), [], 'nothing is read before the service exists')

  const routes = []
  services.webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  pending[0]({
    get: (name) => services[name],
    effect: (factory) => {
      const dispose = factory()
      return dispose === undefined ? () => {} : dispose
    },
  })
  assert.deepEqual(routes.map((route) => route.path), [
    '/api/pm-copilot/state',
    '/api/pm-copilot/action',
    '/api/pm-copilot/file',
  ])
  for (const route of routes) assert.equal(route.kind, 'exact')
})
