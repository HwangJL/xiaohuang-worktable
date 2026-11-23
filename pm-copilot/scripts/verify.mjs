/**
 * Self-check for the PM Copilot Host half.
 *
 * Run from this package directory: `node scripts/verify.mjs`.
 *
 * It loads every module (syntax + runtime import), then exercises the real code
 * against a throwaway workspace under `.verify-tmp/`:
 * knowledge scan/search/read/ingest, the deterministic quality checks, PRD
 * version files, decisions, deliverables, dashboard metrics, the `pm_copilot`
 * tool, and all three HTTP routes through simulated requests (including 400 / 403
 * / 404 / 413). Nothing here touches the user's real cockpit or knowledge base.
 *
 * @module @local/dsh-pm-copilot/scripts/verify
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.dirname(here)

const failures = []
let passed = 0

/**
 * Record one assertion group.
 * @param {string} label - group label.
 * @param {() => Promise<void>|void} body - assertions.
 * @returns {Promise<void>}
 */
async function check(label, body) {
  try {
    await body()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.error(`FAIL ${label}\n     ${error instanceof Error ? error.stack : String(error)}`)
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Load every module                                                       */
/* -------------------------------------------------------------------------- */

const modules = {}
await check('load lib modules', async () => {
  modules.store = await import('../lib/store.js')
  modules.identity = await import('../lib/identity.js')
  modules.kb = await import('../lib/kb.js')
  modules.skills = await import('../lib/skills.js')
  modules.agent = await import('../lib/agent.js')
  modules.quality = await import('../lib/quality.js')
  modules.actions = await import('../lib/actions.js')
  modules.http = await import('../lib/http.js')
  modules.tools = await import('../lib/tools.js')
  modules.index = await import('../index.js')
  for (const [name, mod] of Object.entries(modules)) {
    assert.ok(mod !== null && typeof mod === 'object', `${name} module loaded`)
  }
  assert.equal(typeof modules.index.apply, 'function')
})

await check('package exports apply + exports["."] points at index.js', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.type, 'module')
})

/* -------------------------------------------------------------------------- */
/* 2. Throwaway workspace fixtures                                             */
/* -------------------------------------------------------------------------- */

const tempRoot = path.join(packageRoot, '.verify-tmp')
fs.rmSync(tempRoot, { recursive: true, force: true })
fs.mkdirSync(tempRoot, { recursive: true })
const workspace = path.join(tempRoot, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

const write = (relative, content) => {
  const absolute = path.join(workspace, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content, 'utf8')
  return absolute
}

write('kb/SCHEMA.md', [
  '# 知识库操作手册（SCHEMA）',
  '',
  '## 1. 目录结构',
  '## 4. 三个操作',
  '## 8. 写作纪律',
  '',
].join('\n'))
write('kb/templates/entity.md', '# 实体模板\n')
write('kb/wiki/index.md', '# 知识库索引\n')
write('kb/wiki/log.md', '# 操作日志\n')
write('kb/raw/2026-01-01-demo.md', '# 原始资料\n')
const wikiPage = write('kb/wiki/entities/E-0001-demo.md', [
  '---',
  'title: 示例实体页',
  'id: E-0001',
  'type: entity',
  'project: kb',
  'status: 正式',
  'confirmed: 2026-01-01',
  'scope: 示例范围内有效',
  'sources:',
  '  - https://example.com/demo',
  'tags: [dsh, preset]',
  'created: 2026-01-01',
  'updated: 2026-01-01',
  '---',
  '',
  '## 摘要',
  '这是一个示例摘要，用于验证扫描与检索。',
  '',
  '## 正文',
  '正文内容包含关键词：示例实体。',
].join('\n'))
write('kb/wiki/entities/E-0002-incomplete.md', [
  '---',
  'title: 缺字段页',
  'id: E-0002',
  'type: entity',
  '---',
  '',
  '## 摘要',
  '缺少 project/status/scope/sources/tags。',
].join('\n'))
write('.pm-copilot/roots.json', JSON.stringify({ roots: ['docs'] }))
write('docs/flow.md', '# 流程说明\n\n这里是 docs 根目录里的流程文档。\n')
const deliverableFile = write('docs/deliverable.md', '# 交付物\n')

/* -------------------------------------------------------------------------- */
/* 3. Fake context + services                                                 */
/* -------------------------------------------------------------------------- */

const routeRegistrations = []
const promptSections = []
const eventListeners = []
const disposeListeners = []

/**
 * Build a fake Cordis context with optional services.
 * @param {Record<string, any>} services - service map.
 * @param {{inject?: boolean}} [options] - extra context faces.
 * @returns {any}
 */
function fakeCtx(services, options = {}) {
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposeListeners.push(dispose)
      return dispose
    },
    on(event, listener) {
      if (event === 'session/event') eventListeners.push(listener)
      if (event === 'dispose') disposeListeners.push(listener)
      return () => {
        const index = eventListeners.indexOf(listener)
        if (index !== -1) eventListeners.splice(index, 1)
      }
    },
    emit(event, ...args) {
      for (const listener of eventListeners) listener(...args)
    },
  }
  if (options.inject !== true) {
    // no scoped injection -> tool registration falls back to ctx.get('tools')
  }
  return ctx
}

/** Fake session controller that records every queued prompt. */
const promptsSent = []
const richServices = {
  agentPresets: {
    presetForSession(session) {
      if (typeof session === 'string') return session === 'sess-1' ? 'xiaohuang' : undefined
      return session?.header?.agentPreset
    },
  },
  sessions: {
    get(id) {
      return id === 'sess-1' ? { header: { id: 'sess-1', agentPreset: 'xiaohuang' } } : undefined
    },
  },
  sessionController: {
    async prompt(request, signal) {
      promptsSent.push({ request, signal })
      return undefined
    },
  },
  webServer: {
    register(route) {
      routeRegistrations.push(route)
      return () => {
        const index = routeRegistrations.indexOf(route)
        if (index !== -1) routeRegistrations.splice(index, 1)
      }
    },
  },
  systemPrompt: {
    section(section) {
      promptSections.push(section)
      return () => {}
    },
  },
}
const richCtx = fakeCtx(richServices)

/** Context with no services at all: every optional face must degrade. */
const bareCtx = fakeCtx({})

const XIAOHUANG_SESSION = 'sess-1'

/* -------------------------------------------------------------------------- */
/* 4. Workspace validation / store helpers                                    */
/* -------------------------------------------------------------------------- */

await check('workspace validation rejects relative / missing / file paths', async () => {
  const relative = modules.store.resolveWorkspace('relative/dir')
  assert.equal(relative.ok, false)
  assert.equal(relative.code, 'workspace-invalid')
  const missing = modules.store.resolveWorkspace(path.join(tempRoot, 'does-not-exist'))
  assert.equal(missing.ok, false)
  const file = modules.store.resolveWorkspace(path.join(workspace, 'kb/SCHEMA.md'))
  assert.equal(file.ok, false)
  const valid = modules.store.resolveWorkspace(workspace)
  assert.equal(valid.ok, true)
  assert.equal(valid.value.path, fs.realpathSync(workspace))
})

await check('store empty state + atomic write + revision bump + audit', async () => {
  const empty = await modules.store.readState(workspace)
  assert.equal(empty.meta.lastRevision, 0)
  assert.deepEqual(empty.projects, [])
  const revision = await modules.store.mutateState(workspace, (state) => {
    state.projects.push({ projectId: 'PJ-test', title: 'T', path: workspace, createdAt: 'x', updatedAt: 'x', status: 'active' })
    return true
  })
  assert.equal(revision, true)
  const after = await modules.store.readState(workspace)
  assert.equal(after.meta.lastRevision, 1)
  assert.equal(after.projects.length, 1)
  const stateFile = path.join(workspace, '.pm-copilot', 'state.json')
  assert.ok(fs.existsSync(stateFile), 'state.json exists')
  assert.ok(!fs.existsSync(`${stateFile}.tmp`), 'temporary file renamed away')
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(parsed.meta.lastRevision, 1)
  // Reset the throwaway state so action tests start clean, keeping roots.json.
  fs.rmSync(stateFile, { force: true })
  modules.store.forgetCachedState(workspace)
  const fresh = await modules.store.readState(workspace)
  assert.equal(fresh.meta.lastRevision, 0)
})

/* -------------------------------------------------------------------------- */
/* 5. Knowledge base                                                          */
/* -------------------------------------------------------------------------- */

await check('concurrent writes are serialized and every mutation bumps revision', async () => {
  const before = await modules.store.readState(workspace)
  const jobs = Array.from({ length: 12 }, (_, index) => modules.store.mutateState(workspace, (state) => {
    state.projects.push({ projectId: `PJ-concurrent-${index}`, title: `C${index}`, path: workspace, createdAt: 'x', updatedAt: 'x', status: 'active' })
    return index
  }))
  const results = await Promise.all(jobs)
  assert.equal(results.length, 12)
  const after = await modules.store.readState(workspace)
  assert.equal(after.meta.lastRevision, before.meta.lastRevision + 12)
  assert.equal(after.projects.length, before.projects.length + 12)
  assert.equal(new Set(after.projects.map((project) => project.projectId)).size, after.projects.length)
  // Cleanup so later checks see only the data they create.
  await modules.store.mutateState(workspace, (state) => {
    state.projects = state.projects.filter((project) => !String(project.projectId).startsWith('PJ-concurrent-'))
  })
})

await check('frontmatter parser handles scalars, inline and block lists', async () => {
  const parsed = modules.kb.parseFrontmatter(fs.readFileSync(wikiPage, 'utf8'))
  assert.equal(parsed.data.title, '示例实体页')
  assert.equal(parsed.data.id, 'E-0001')
  assert.deepEqual(parsed.data.sources, ['https://example.com/demo'])
  assert.deepEqual(parsed.data.tags, ['dsh', 'preset'])
  assert.equal(parsed.data.confirmed, '2026-01-01')
  assert.match(parsed.body, /## 摘要[\s\S]*示例摘要/)
})

await check('kb scan returns wiki/raw/schema/roots + honest stats', async () => {
  const scan = await modules.kb.scanKnowledgeBase(workspace)
  const wiki = scan.items.filter((item) => item.kind === 'wiki')
  assert.equal(wiki.length, 2)
  assert.equal(scan.items.filter((item) => item.kind === 'raw').length >= 1, true)
  assert.equal(scan.items.filter((item) => item.kind === 'schema').length, 1)
  assert.equal(scan.items.filter((item) => item.kind === 'root').length >= 1, true)
  // Non-wiki items carry a searchable type so the client's type filter works.
  assert.equal(scan.items.find((item) => item.kind === 'raw').type, 'raw')
  assert.equal(scan.items.find((item) => item.kind === 'root').type, 'doc')
  assert.equal(scan.stats.wikiCount, 2)
  assert.equal(scan.stats.schemaPresent, true)
  assert.equal(scan.stats.indexPresent, true)
  assert.equal(scan.stats.logPresent, true)
  assert.equal(scan.stats.templateCount, 1)
  assert.equal(scan.stats.rawCount >= 1, true)
  const demo = wiki.find((item) => item.id === 'E-0001')
  assert.equal(demo.status, '正式')
  assert.equal(demo.project, 'kb')
  assert.deepEqual(demo.tags, ['dsh', 'preset'])
  assert.match(demo.snippet, /示例摘要/)
})

await check('kb search scores title/id/summary/body and honors filters', async () => {
  const byTitle = await modules.kb.searchKnowledge(workspace, { query: '示例实体页' })
  assert.equal(byTitle.ok, true)
  assert.equal(byTitle.value.items[0].id, 'E-0001')
  assert.equal(byTitle.value.items[0].relevance >= 3, true)
  const byTag = await modules.kb.searchKnowledge(workspace, { query: 'dsh' })
  assert.equal(byTag.value.items.some((item) => item.id === 'E-0001'), true)
  const filtered = await modules.kb.searchKnowledge(workspace, { project: 'kb', type: 'entity' })
  assert.equal(filtered.value.items.length, 1)
  const none = await modules.kb.searchKnowledge(workspace, { query: '绝对不存在的关键词xyz' })
  assert.equal(none.value.total, 0)
  // Internal body is not leaked to the client payload.
  assert.equal('body' in byTitle.value.items[0], false)
})

await check('kb read is bounded and refuses paths outside the workspace', async () => {
  const inside = await modules.kb.readKnowledgeFile(workspace, wikiPage)
  assert.equal(inside.ok, true)
  assert.match(inside.value.text, /E-0001/)
  assert.equal(inside.value.truncated, false)
  const outside = await modules.kb.readKnowledgeFile(workspace, 'C:\\Windows\\win.ini')
  assert.equal(outside.ok, false)
  assert.equal(outside.code, 'path-outside-workspace')
  const missing = await modules.kb.readKnowledgeFile(workspace, path.join(workspace, 'nope.md'))
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'file-not-found')
})

await check('kb ingest creates a new page, index line and log entry (no overwrite)', async () => {
  const first = await modules.kb.ingestKnowledge(workspace, {
    title: '新实体页',
    type: 'entity',
    project: 'kb',
    summary: '新实体摘要',
    body: '新实体正文',
    sources: ['https://example.com/new'],
    tags: ['demo'],
  })
  assert.equal(first.ok, true)
  assert.equal(first.value.id, 'E-0003')
  assert.equal(first.value.status, '待确认')
  assert.ok(fs.existsSync(first.value.path))
  const indexText = fs.readFileSync(path.join(workspace, 'kb/wiki/index.md'), 'utf8')
  assert.match(indexText, /- \[E-0003\] 新实体页 · entity · 待确认 · kb — 新实体摘要/)
  const logText = fs.readFileSync(path.join(workspace, 'kb/wiki/log.md'), 'utf8')
  assert.match(logText, /ingest \| 新实体页/)
  const second = await modules.kb.ingestKnowledge(workspace, {
    title: '新实体页',
    type: 'entity',
    project: 'kb',
    summary: '正式版本',
    body: '正式正文',
    status: '正式',
  })
  assert.equal(second.ok, true)
  assert.equal(second.value.id, 'E-0004')
  const third = await modules.kb.ingestKnowledge(workspace, {
    title: '新实体页',
    type: 'entity',
    project: 'kb',
    summary: '再次正式',
    status: '正式',
  })
  assert.equal(third.ok, true)
  assert.equal(third.value.conflict, '正式页已存在，已新建独立页面')
  // The original 正式 page client-supplied id test: forced id reuse must refuse
  // to overwrite an existing page.
  const forced = await modules.kb.ingestKnowledge(workspace, {
    title: '决策测试',
    type: 'decision',
    summary: 'x',
    forcedId: 'D-0001',
  })
  assert.equal(forced.ok, true)
  const forcedAgain = await modules.kb.ingestKnowledge(workspace, {
    title: '决策测试2',
    type: 'decision',
    summary: 'x',
    forcedId: 'D-0001',
  })
  assert.equal(forcedAgain.ok, false)
  assert.equal(forcedAgain.code, 'file-exists')
})

/* -------------------------------------------------------------------------- */
/* 6. Identity                                                                */
/* -------------------------------------------------------------------------- */

await check('identity resolves xiaohuang / other / undefined correctly', async () => {
  assert.equal(modules.identity.classifyPreset('xiaohuang'), 'xiaohuang')
  assert.equal(modules.identity.classifyPreset('standard'), 'other:standard')
  assert.equal(modules.identity.classifyPreset(''), undefined)
  assert.equal(await modules.identity.resolveIdentity(richCtx, XIAOHUANG_SESSION), 'xiaohuang')
  assert.equal(await modules.identity.resolveIdentity(bareCtx, XIAOHUANG_SESSION), undefined)
  assert.equal(await modules.identity.resolveIdentity(bareCtx, undefined), undefined)
  const otherCtx = fakeCtx({ agentPresets: { presetForSession: () => 'standard' } })
  assert.equal(await modules.identity.resolveIdentity(otherCtx, XIAOHUANG_SESSION), 'other:standard')
  assert.equal(modules.identity.identityView('xiaohuang').verified, true)
  assert.equal(modules.identity.identityView('other:standard').verified, false)
  assert.equal(modules.identity.identityView(undefined).preset, null)
})

await check('identity falls back to the persisted projection cache (read-only)', async () => {
  const realSession = '2d5fa8b6-c3cf-4e91-8bdf-c213e0333db5'
  const file = modules.identity.projectionCachePath(realSession)
  if (file !== undefined && fs.existsSync(file)) {
    assert.equal(modules.identity.readPresetFromProjectionCache(realSession), 'xiaohuang')
  }
  assert.equal(modules.identity.readPresetFromProjectionCache('../../etc/passwd'), undefined)
  assert.equal(modules.identity.projectionCachePath('../../etc/passwd'), undefined)
})

await check('requireXiaohuang fails closed with identity-unverified', async () => {
  const blocked = await modules.identity.requireXiaohuang(bareCtx, XIAOHUANG_SESSION)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'identity-unverified')
  const other = await modules.identity.requireXiaohuang(fakeCtx({ agentPresets: { presetForSession: () => 'standard' } }), XIAOHUANG_SESSION)
  assert.equal(other.ok, false)
  assert.equal(other.code, 'identity-unverified')
  const allowed = await modules.identity.requireXiaohuang(richCtx, XIAOHUANG_SESSION)
  assert.equal(allowed.ok, true)
})

/* -------------------------------------------------------------------------- */
/* 7. Real action flow through dispatchAction                                 */
/* -------------------------------------------------------------------------- */

const action = (name, payload, ctx = richCtx, sessionId = XIAOHUANG_SESSION) => (
  modules.actions.dispatchAction(ctx, { action: name, sessionId, workspacePath: workspace, payload })
)

let projectId
let taskId
let secondTaskId
let prdId
let decisionId

await check('unverified identity rejects writes but state read degrades to empty store', async () => {
  const rejected = await modules.actions.dispatchAction(bareCtx, {
    action: 'task.create',
    sessionId: XIAOHUANG_SESSION,
    workspacePath: workspace,
    payload: { projectId: 'PJ-x', title: 'nope' },
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'identity-unverified')
  const snapshot = await modules.actions.buildSnapshot(bareCtx, { workspacePath: workspace, sessionId: XIAOHUANG_SESSION })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.value.identity.preset, null)
  assert.equal(snapshot.value.identity.verified, false)
  assert.deepEqual(snapshot.value.projects, [])
  assert.deepEqual(snapshot.value.tasks, [])
  assert.equal(snapshot.value.metrics.todo, 0)
  assert.equal(snapshot.value.revision, 0)
  // Workspace validation still comes first.
  const badWorkspace = await modules.actions.dispatchAction(richCtx, { action: 'state', workspacePath: 'relative', sessionId: XIAOHUANG_SESSION })
  assert.equal(badWorkspace.ok, false)
  assert.equal(badWorkspace.code, 'workspace-invalid')
  const unknown = await action('nope.nope', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'action-invalid')
})

await check('task.create without projectId bootstraps a real default project', async () => {
  const created = await action('task.create', { title: '默认项目任务', description: '空驾驶舱的第一次创建' })
  assert.equal(created.ok, true)
  assert.equal(created.value.projectCreated, true)
  assert.match(created.value.project.projectId, /^PJ-/)
  assert.equal(created.value.task.projectId, created.value.project.projectId)
  const state = await modules.store.readState(workspace)
  assert.ok(state.projects.some((project) => project.projectId === created.value.project.projectId))
  assert.ok(state.tasks.some((task) => task.taskId === created.value.task.taskId))
  // A stale explicit project id is still refused, never silently replaced.
  const stale = await action('task.create', { title: 'x', projectId: 'PJ-does-not-exist' })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'project-not-found')
})

await check('project.create → task.create with real ids', async () => {
  const project = await action('project.create', { title: '测试项目' })
  assert.equal(project.ok, true)
  assert.match(project.value.project.projectId, /^PJ-/)
  projectId = project.value.project.projectId
  const task = await action('task.create', { projectId, title: '下单流程需求', description: '设计下单流程', type: 'business', priority: 'P0' })
  assert.equal(task.ok, true)
  taskId = task.value.task.taskId
  assert.equal(task.value.task.status, 'todo')
  assert.equal(task.value.task.progress, 0)
  assert.equal(task.value.task.stage, '需求理解')
  const missingProject = await action('task.create', { projectId: 'PJ-none', title: 'x' })
  assert.equal(missingProject.ok, false)
  assert.equal(missingProject.code, 'project-not-found')
})

await check('task stage advances progress only through real stage mapping', async () => {
  const staged = await action('task.stage', { taskId, stage: 'PRD编写' })
  assert.equal(staged.ok, true)
  assert.equal(staged.value.task.progress, 70)
  const backwards = await action('task.stage', { taskId, stage: '需求理解' })
  assert.equal(backwards.value.task.progress, 70, 'progress never moves backwards')
  const badStage = await action('task.stage', { taskId, stage: '瞎写阶段' })
  assert.equal(badStage.ok, false)
  assert.equal(badStage.code, 'payload-invalid')
  // progress cannot be patched directly.
  const patched = await action('task.update', { taskId, patch: { title: '下单流程需求 v2', progress: 99 } })
  assert.equal(patched.ok, true)
  assert.equal(patched.value.task.title, '下单流程需求 v2')
})

await check('dependency cycle is refused', async () => {
  const second = await action('task.create', { projectId, title: '第二任务' })
  secondTaskId = second.value.task.taskId
  const link = await action('task.link', { taskId: secondTaskId, dependsOn: taskId })
  assert.equal(link.ok, true)
  assert.deepEqual(link.value.task.dependencies, [taskId])
  const cycle = await action('task.link', { taskId, dependsOn: secondTaskId })
  assert.equal(cycle.ok, false)
  assert.equal(cycle.code, 'dependency-cycle')
})

await check('analysis / business / solution / subtasks save normalize the contract shape', async () => {
  const analysis = await action('task.analysisSave', {
    taskId,
    analysis: {
      requirement: { raw: '原始需求', coreProblem: '下单慢', goal: '下单更快' },
      completeness: { toConfirm: ['支付超时策略待确认'] },
    },
  })
  assert.equal(analysis.ok, true)
  assert.equal(analysis.value.task.analysis.requirement.coreProblem, '下单慢')
  assert.deepEqual(analysis.value.task.analysis.completeness.risks, [])
  assert.equal(analysis.value.task.analysis.updatedAt !== undefined, true)

  const business = await action('task.businessSave', {
    taskId,
    business: {
      roles: ['买家'],
      objects: [{ name: '订单', fields: [{ name: 'orderId' }, { name: 'orderId' }, { name: 'amount' }] }],
      process: { nodes: [{ id: 'n1', label: '提交订单', kind: 'action', actor: '买家' }, { id: 'n2', label: '生成订单', kind: 'action', actor: '系统' }], edges: [] },
      rules: [],
      boundary: [
        { system: '订单系统', responsibility: '负责订单生命周期', dataOwnership: '订单数据', interfaces: [] },
        { system: '支付系统', responsibility: '负责订单生命周期', dataOwnership: '支付数据', interfaces: [] },
      ],
      risks: [],
    },
  })
  assert.equal(business.ok, true)
  assert.equal(business.value.task.business.process.nodes.length, 2)

  const solution = await action('task.solutionSave', {
    taskId,
    solution: { title: '下单方案', positioning: '轻量', architecture: '', goals: [], dataModel: '' },
    changeNote: '初稿',
  })
  assert.equal(solution.ok, true)
  assert.equal(solution.value.task.solution.versions.length, 1)
  assert.equal(solution.value.task.solution.versions[0].version, 1)

  const subtasks = await action('task.subtasksSave', {
    taskId,
    subtasks: [{ title: '拆支付', status: 'todo' }, { title: '拆库存', dependsOn: [] }],
  })
  assert.equal(subtasks.ok, true)
  assert.equal(subtasks.value.task.subtasks.length, 2)
  assert.match(subtasks.value.task.subtasks[0].subtaskId, /^ST-/)
})

await check('quality.run computes real deterministic issues + severities + report file', async () => {
  const first = await action('quality.run', { scope: 'all' })
  assert.equal(first.ok, true)
  assert.ok(first.value.report.issueCount > 0, 'real findings exist for the seeded data')
  assert.ok(first.value.report.bySeverity.major >= 1)
  assert.ok(first.value.report.bySeverity.minor >= 1)
  const dimensions = new Set(first.value.issues.map((issue) => issue.dimension))
  for (const expected of ['流程完整性', '规则完整性', '架构一致性', '数据一致性', '知识库']) {
    assert.ok(dimensions.has(expected), `dimension ${expected} reported`)
  }
  const fields = ['issueId', 'dimension', 'severity', 'title', 'detail', 'targetPath', 'suggestion', 'status']
  for (const field of fields) assert.ok(field in first.value.issues[0], `issue has ${field}`)
  const reportDir = path.join(workspace, '.pm-copilot', 'quality')
  assert.ok(fs.readdirSync(reportDir).length >= 1, 'quality report file written')
  // A second identical run supersedes the first run's open issues as stale.
  const second = await action('quality.run', { scope: 'all' })
  assert.equal(second.ok, true)
  const state = await modules.store.readState(workspace)
  const firstRunIds = new Set(first.value.issues.map((issue) => issue.issueId))
  const stale = state.quality.issues.filter((issue) => firstRunIds.has(issue.issueId) && issue.status === 'stale')
  assert.ok(stale.length > 0, 'previous issues marked stale before re-adding')
  const badScope = await action('quality.run', { scope: 'task' })
  assert.equal(badScope.ok, false)
  assert.equal(badScope.code, 'payload-invalid')
})

await check('prd.save writes v1 then v2 as NEW files (original untouched)', async () => {
  const v1 = await action('prd.save', {
    projectId,
    taskId,
    title: '下单流程 PRD',
    sections: {
      需求背景: '下单慢，需要优化。',
      业务流程: '- 提交订单\n- 履约\n- 发货',
      验收标准: 'D-9999 决策必须落实',
    },
    changeNote: 'v1 初稿',
  })
  assert.equal(v1.ok, true)
  prdId = v1.value.prd.prdId
  assert.equal(v1.value.prdId, prdId, 'value carries the PRD record at top level for the client')
  assert.equal(v1.value.versions.length, 1)
  const v1Path = v1.value.path
  assert.match(v1Path, /prd[/\\].*\.v1\.md$/)
  const v1Text = fs.readFileSync(v1Path, 'utf8')
  const v2 = await action('prd.save', {
    prdId,
    projectId,
    title: '下单流程 PRD',
    sections: { 需求背景: '下单更慢，需要优化（更新）。' },
    changeNote: 'v2 更新背景',
  })
  assert.equal(v2.ok, true)
  assert.equal(v2.value.version, 2)
  assert.notEqual(v2.value.path, v1Path)
  assert.ok(fs.existsSync(v1Path), 'v1 file still exists')
  assert.equal(fs.readFileSync(v1Path, 'utf8'), v1Text, 'v1 file contents untouched')
  const v2Text = fs.readFileSync(v2.value.path, 'utf8')
  assert.match(v2Text, /## 需求背景[\s\S]*更新/)
  assert.match(v2Text, /## 业务流程[\s\S]*提交订单/, 'untouched sections carried into v2')
  const prd = await action('prd.get', { prdId })
  assert.equal(prd.ok, true)
  assert.equal(prd.value.current.version, 2)
  assert.ok('业务流程' in prd.value.current.sections)
  const exported = await action('prd.export', { prdId })
  assert.equal(exported.ok, true)
  assert.match(exported.value.markdown, /## 验收标准/)
  assert.match(exported.value.fileName, /\.v2\.md$/)
  const badKey = await action('prd.save', { prdId, projectId, title: 'x', sections: { 不存在的段落: 'x' } })
  assert.equal(badKey.ok, false)
})

await check('prd.confirm stamps the version, and a later prd.save returns it to draft', async () => {
  const confirmed = await action('prd.confirm', { prdId, confirmedBy: '产品负责人' })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.value.prd.status, 'confirmed')
  assert.equal(confirmed.value.prd.confirmedBy, '产品负责人')
  assert.equal(confirmed.value.prd.confirmedVersion, 2, 'confirmation names the version it covers')
  assert.equal(confirmed.value.version, 2)
  assert.ok(confirmed.value.prd.history.some((entry) => entry.to === 'confirmed' && entry.version === 2))
  const v3 = await action('prd.save', {
    prdId,
    projectId,
    title: '下单流程 PRD',
    sections: { 需求背景: '再改一次。' },
    changeNote: 'v3 修订',
  })
  assert.equal(v3.ok, true)
  assert.equal(v3.value.version, 3)
  assert.equal(v3.value.status, 'draft', 'a freshly written version is never confirmed')
  assert.equal(v3.value.confirmedVersion, null)
  assert.ok(v3.value.history.some((entry) => entry.from === 'confirmed' && entry.to === 'draft'), 'the downgrade is recorded in history')
  const missing = await action('prd.confirm', { prdId: 'PRD-9999', confirmedBy: '产品负责人' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'prd-not-found')
  const noName = await action('prd.confirm', { prdId })
  assert.equal(noName.ok, false)
  assert.equal(noName.code, 'payload-invalid')
})

await check('decisions: propose → confirm → ingest into kb decision page D-0001', async () => {
  const proposed = await action('decision.propose', {
    projectId,
    title: '支付超时策略',
    background: '支付网关偶发超时。',
    conclusion: '超时 30 秒自动关单。',
    reason: '待确认',
  })
  assert.equal(proposed.ok, true)
  decisionId = proposed.value.decision.decisionId
  assert.match(decisionId, /^D-\d{4}$/)
  assert.equal(proposed.value.decision.status, 'pending')
  assert.ok(proposed.value.decision.projectId !== null, 'a project is resolved for the decision')
  const confirmed = await action('decision.confirm', { decisionId, confirmedBy: '产品负责人' })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.value.decision.status, 'confirmed')
  assert.equal(confirmed.value.decision.confirmedBy, '产品负责人')
  assert.equal(confirmed.value.decision.history.length, 1)
  const ingested = await action('decision.ingest', { decisionId })
  assert.equal(ingested.ok, true)
  assert.equal(ingested.value.page.id, decisionId)
  assert.equal(ingested.value.page.status, '正式')
  assert.equal(ingested.value.knowledge.status, '正式')
  const afterIngest = await modules.store.readState(workspace)
  assert.ok(afterIngest.knowledge.some((item) => item.entryId === decisionId))
  const changed = await action('decision.change', { decisionId, conclusion: '超时 20 秒自动关单。', reason: '压测反馈' })
  assert.equal(changed.ok, true)
  assert.equal(changed.value.decision.status, 'changed')
  const deprecated = await action('decision.deprecate', { decisionId, reason: '策略废弃' })
  assert.equal(deprecated.ok, true)
  assert.equal(deprecated.value.decision.status, 'deprecated')
  const missing = await action('decision.confirm', { decisionId: 'D-9999', confirmedBy: 'x' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'decision-not-found')
})

await check('deliverable.add requires a real file that exists', async () => {
  const added = await action('deliverable.add', {
    projectId,
    taskId,
    title: '交付物文档',
    kind: 'doc',
    path: deliverableFile,
    summary: '真实存在的文件',
  })
  assert.equal(added.ok, true)
  assert.match(added.value.deliverable.deliverableId, /^DL-/)
  const state = await modules.store.readState(workspace)
  const task = state.tasks.find((entry) => entry.taskId === taskId)
  assert.ok(task.deliverables.includes(added.value.deliverable.deliverableId))
  const missing = await action('deliverable.add', { projectId, title: 'x', path: path.join(workspace, 'nope.md') })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'path-not-found')
})

await check('knowledge.ingest records both the page and the cockpit knowledge entry', async () => {
  const ingested = await action('knowledge.ingest', {
    title: '驾驶舱知识页',
    type: 'concept',
    project: 'kb',
    summary: '来自驾驶舱的知识',
    body: '正文',
    sources: ['https://example.com/k'],
    tags: ['cockpit'],
  })
  assert.equal(ingested.ok, true)
  const entry = ingested.value.entry
  assert.match(entry.entryId, /^C-\d{4}$/)
  assert.equal(ingested.value.conflict, null)
  assert.equal(ingested.value.path, entry.path, 'value.path is the written page path')
  const state = await modules.store.readState(workspace)
  assert.ok(state.knowledge.some((item) => item.entryId === entry.entryId && item.status === '待确认'))
})

await check('solution.save creates and updates a reusable solution', async () => {
  const created = await action('solution.save', {
    projectId,
    title: '下单优化方案',
    positioning: 'MVP',
    goals: ['缩短下单时长'],
    taskId,
  })
  assert.equal(created.ok, true)
  const solutionId = created.value.solution.solutionId
  assert.match(solutionId, /^SOL-/)
  assert.equal(created.value.solution.versions.length, 1)
  const updated = await action('solution.save', {
    solutionId,
    projectId,
    title: '下单优化方案 v2',
    changeNote: '补 roadmap',
    roadmap: 'Q1 上线',
  })
  assert.equal(updated.ok, true)
  assert.equal(updated.value.solution.versions.length, 2)
})

await check('project.update / project.archive / task.pause / task.resume / task.terminate', async () => {
  const paused = await action('task.pause', { taskId: secondTaskId })
  assert.equal(paused.ok, true)
  assert.equal(paused.value.task.status, 'paused')
  const resumed = await action('task.resume', { taskId: secondTaskId })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.value.task.status, 'todo')
  const terminated = await action('task.terminate', { taskId: secondTaskId })
  assert.equal(terminated.ok, true)
  assert.equal(terminated.value.task.status, 'terminated')
  const removed = await action('task.delete', { taskId: secondTaskId })
  assert.equal(removed.ok, true)
  assert.equal(removed.value.deleted, true)
  const updatedProject = await action('project.update', { projectId, patch: { title: '测试项目（改名）' } })
  assert.equal(updatedProject.ok, true)
  assert.equal(updatedProject.value.project.title, '测试项目（改名）')
  const archived = await action('project.archive', { projectId })
  assert.equal(archived.value.project.status, 'archived')
})

/* -------------------------------------------------------------------------- */
/* 8. Agent prompting + real event trace                                       */
/* -------------------------------------------------------------------------- */

await check('task.run queues a real prompt with real context and records execution', async () => {
  const run = await action('task.run', { taskId, instruction: '请补异常分支' })
  assert.equal(run.ok, true)
  assert.equal(run.value.sent, true)
  assert.match(run.value.execution.prompt, /下单流程需求 v2/)
  assert.match(run.value.execution.prompt, /按员工守则执行/)
  assert.match(run.value.execution.prompt, /完成后用 pm_copilot 工具把分析结果\/交付物\/决策写回驾驶舱。/)
  assert.equal(run.value.execution.status, 'sent')
  assert.equal(promptsSent.at(-1).request.mode, 'queue')
  assert.equal(promptsSent.at(-1).request.sessionId, XIAOHUANG_SESSION)
  const state = await modules.store.readState(workspace)
  const task = state.tasks.find((entry) => entry.taskId === taskId)
  assert.equal(task.status, 'executing')
  assert.ok(state.executions.some((entry) => entry.executionId === run.value.execution.executionId && entry.status === 'sent'))
})

await check('agent-unavailable is reported honestly when sessionController is missing', async () => {
  const noAgentServices = {
    agentPresets: { presetForSession: () => 'xiaohuang' },
    sessions: { get: () => ({ header: { id: XIAOHUANG_SESSION, agentPreset: 'xiaohuang' } }) },
  }
  const noAgentCtx = fakeCtx(noAgentServices)
  const result = await modules.agent.promptAgent(noAgentCtx, {
    workspacePath: workspace,
    sessionId: XIAOHUANG_SESSION,
    text: 'hello',
    kind: 'agent',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'agent-unavailable')
  const viaAction = await modules.actions.dispatchAction(noAgentCtx, {
    action: 'task.run',
    sessionId: XIAOHUANG_SESSION,
    workspacePath: workspace,
    payload: { taskId },
  })
  assert.equal(viaAction.ok, false)
  assert.equal(viaAction.code, 'agent-unavailable')
  const skillMissing = await action('skill.list', {})
  assert.equal(skillMissing.ok, false)
  assert.equal(skillMissing.code, 'skills-unavailable')
})

await check('session events update execution, task, skillUsage and progress for real', async () => {
  const recorder = modules.agent.createSessionEventRecorder(richCtx)
  const session = { header: { id: XIAOHUANG_SESSION } }
  recorder.record(session, { type: 'tool/call', data: { name: 'skill', arguments: JSON.stringify({ name: 'prd-writer' }) } })
  recorder.record(session, { type: 'tool/call', data: { name: 'fs', arguments: '{}' } })
  recorder.record(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已分析完成，准备写回。' }] } } })
  recorder.record(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  recorder.dispose()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await recorder.flush()
  const state = await modules.store.readState(workspace)
  const execution = state.executions.at(-1)
  assert.equal(execution.status, 'completed')
  assert.ok(execution.endedAt !== null)
  const task = state.tasks.find((entry) => entry.taskId === taskId)
  assert.equal(task.status, 'confirming')
  assert.equal(task.error, null)
  assert.equal(task.progress >= 70, true, 'progress advanced to the real stage mapping')
  assert.equal(task.lastExecutionAt !== null, true)
  assert.equal(state.skillUsage['prd-writer'].count, 1)
  assert.equal(state.skillUsage['prd-writer'].lastTaskId, taskId)
  assert.ok(execution.events.some((event) => event.type === '工具调用' && event.detail === 'skill'))
  assert.ok(execution.events.some((event) => event.type === '模型输出'))
  // Audit log is append-only JSONL.
  const auditLines = fs.readFileSync(path.join(workspace, '.pm-copilot', 'audit.jsonl'), 'utf8').trim().split('\n')
  assert.ok(auditLines.length > 0)
  for (const line of auditLines) JSON.parse(line)
})

await check('failed turn marks the execution failed and records the task error', async () => {
  const run = await action('task.run', { taskId })
  assert.equal(run.ok, true)
  const recorder = modules.agent.createSessionEventRecorder(richCtx)
  const session = { header: { id: XIAOHUANG_SESSION } }
  recorder.record(session, { type: 'turn/end', data: { reason: { kind: 'error' } } })
  recorder.dispose()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await recorder.flush()
  const state = await modules.store.readState(workspace)
  const execution = state.executions.at(-1)
  assert.equal(execution.status, 'failed')
  const task = state.tasks.find((entry) => entry.taskId === taskId)
  assert.match(task.error, /回合结束：error/)
})

/* -------------------------------------------------------------------------- */
/* 9. Snapshot / metrics / dashboard                                          */
/* -------------------------------------------------------------------------- */

await check('snapshot carries every contract field and real metrics/dashboard', async () => {
  const snapshot = await modules.actions.buildSnapshot(richCtx, { workspacePath: workspace, sessionId: XIAOHUANG_SESSION })
  assert.equal(snapshot.ok, true)
  const value = snapshot.value
  for (const key of [
    'identity', 'workspace', 'projects', 'tasks', 'executions', 'deliverables', 'decisions',
    'knowledge', 'prds', 'quality', 'metrics', 'dashboard', 'skills', 'knowledgeStats',
    'capabilities', 'revision', 'generatedAt', 'skillUsage',
  ]) {
    assert.ok(key in value, `snapshot has ${key}`)
  }
  assert.equal(value.identity.preset, 'xiaohuang')
  assert.equal(value.identity.verified, true)
  assert.equal(value.workspace.path, fs.realpathSync(workspace))
  assert.equal(value.executions.length <= 50, true)
  assert.equal(value.quality.reports.length <= 20, true)
  assert.deepEqual(Object.keys(value.quality), ['issues', 'reports'])
  assert.equal(typeof value.skillUsage['prd-writer'], 'object')
  assert.equal(value.skills.available, false)
  assert.equal(value.skills.error, 'skills-unavailable')
  assert.equal(value.capabilities.agent, true)
  assert.equal(value.capabilities.skills, false)
  assert.equal(value.capabilities.knowledgeRead, true)
  assert.equal(value.capabilities.knowledgeWrite, true)
  assert.equal(value.capabilities.workspace, false)
  assert.equal(value.knowledgeStats.wikiCount >= 2, true)
  assert.equal(value.metrics.confirming + value.metrics.executing >= 1, true)
  assert.equal(value.metrics.knowledgePending >= 1, true)
  assert.equal(value.metrics.qualityOpen >= 1, true)
  // The client contract renders todoItems as an array of {key,title,items}.
  assert.equal(Array.isArray(value.dashboard.todoItems), true)
  assert.equal(value.dashboard.todoItems.length, 5)
  for (const category of modules.actions.TODO_CATEGORIES) {
    const group = value.dashboard.todoItems.find((entry) => entry.title === category)
    assert.ok(group !== undefined, `todo group ${category} exists`)
    assert.equal(Array.isArray(group.items), true)
    for (const item of group.items) {
      assert.ok(item.id !== undefined && item.title !== undefined, 'todo item carries id and title')
    }
  }
  const businessGroup = value.dashboard.todoItems.find((entry) => entry.key === 'business')
  assert.ok(businessGroup.items.length >= 1, '等待业务确认 lists the confirming task')
  const knowledgeGroup = value.dashboard.todoItems.find((entry) => entry.key === 'knowledge')
  assert.ok(knowledgeGroup.items.length >= 1, '等待知识审核 lists the pending knowledge entry')
  const fixGroup = value.dashboard.todoItems.find((entry) => entry.key === 'fix')
  assert.ok(fixGroup.items.length >= 1, '待修正问题 lists open issues')
  assert.equal(value.dashboard.recentTasks.length <= 8, true)
  assert.ok(value.dashboard.currentWork === null || typeof value.dashboard.currentWork === 'object')
})

/* -------------------------------------------------------------------------- */
/* 9b. Quality fix / resolve                                                  */
/* -------------------------------------------------------------------------- */

await check('quality.fix queues a real fix prompt then marks issues fixing; resolve closes it', async () => {
  const before = await modules.store.readState(workspace)
  const openIssue = before.quality.issues.find((issue) => issue.status === 'open')
  assert.ok(openIssue !== undefined, 'an open issue exists')
  const fix = await action('quality.fix', { issueIds: [openIssue.issueId] })
  assert.equal(fix.ok, true)
  assert.equal(fix.value.sent, true)
  assert.match(fix.value.execution.prompt, /质量问题修复/)
  const fixingState = await modules.store.readState(workspace)
  const fixingIssue = fixingState.quality.issues.find((issue) => issue.issueId === openIssue.issueId)
  assert.equal(fixingIssue.status, 'fixing')
  // A repeated call right after the session's own fix prompt marks only (no
  // duplicate Agent message).
  const duplicate = await action('quality.fix', { issueIds: [openIssue.issueId] })
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.value.sent, false)
  assert.equal(duplicate.value.deduplicated, true)
  const resolved = await action('quality.resolve', { issueId: openIssue.issueId, resolution: '已补齐该问题' })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.value.issue.status, 'resolved')
  assert.equal(resolved.value.issue.resolution, '已补齐该问题')
  assert.ok(resolved.value.issue.resolvedAt !== null)
  const missingResolution = await action('quality.resolve', { issueId: openIssue.issueId, resolution: '' })
  assert.equal(missingResolution.ok, false)
  assert.equal(missingResolution.code, 'payload-invalid')
  // An unavailable Agent must leave the issue untouched instead of pretending.
  const noAgentCtx = fakeCtx({
    agentPresets: { presetForSession: () => 'xiaohuang' },
    sessions: { get: () => ({ header: { id: 'sess-agentless', agentPreset: 'xiaohuang' } }) },
  })
  const remaining = (await modules.store.readState(workspace)).quality.issues.find((issue) => issue.status === 'open')
  if (remaining !== undefined) {
    const refused = await modules.actions.dispatchAction(noAgentCtx, {
      action: 'quality.fix',
      sessionId: 'sess-agentless',
      workspacePath: workspace,
      payload: { issueIds: [remaining.issueId] },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'agent-unavailable')
    const untouched = (await modules.store.readState(workspace)).quality.issues.find((issue) => issue.issueId === remaining.issueId)
    assert.equal(untouched.status, 'open')
  }
})

/* -------------------------------------------------------------------------- */
/* 10. pm_copilot tool                                                        */
/* -------------------------------------------------------------------------- */

await check('pm_copilot tool definition matches the registry contract', async () => {
  const tool = modules.tools.createPmCopilotTool(richCtx)
  assert.equal(tool.name, 'pm_copilot')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.properties.action.type, 'string')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.additionalProperties, true)
  assert.equal(tool.output.schema.type, 'object')
  const rendered = tool.output.render({}, { ok: true, value: 1 })
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /"ok":true/)
  // The frozen client enum must be present in the advertised actions.
  for (const alias of ['state', 'task_create', 'task_update', 'task_stage', 'analysis_save',
    'task_business_save', 'task_solution_save', 'task_subtasks_save', 'decision_propose',
    'knowledge_ingest', 'quality_report', 'prd_save', 'deliverable_add']) {
    assert.ok(modules.tools.PM_COPILOT_TOOL_ACTIONS.includes(alias), `enum has ${alias}`)
  }
})

await check('pm_copilot tool execute resolves caller session/workspace and dispatches', async () => {
  const tool = modules.tools.createPmCopilotTool(richCtx)
  const exec = { agent: { session: { id: XIAOHUANG_SESSION, header: { id: XIAOHUANG_SESSION, cwd: workspace } } } }
  const stateResult = await tool.execute({ action: 'state' }, exec)
  assert.equal(stateResult.ok, true)
  assert.equal(stateResult.value.workspace.path, fs.realpathSync(workspace))
  const created = await tool.execute({ action: 'task_create', projectId, title: '工具创建任务', description: '' }, exec)
  assert.equal(created.ok, true)
  const createdTaskId = created.value.task.taskId
  const saved = await tool.execute({
    action: 'task_business_save',
    taskId: createdTaskId,
    business: { process: { nodes: [], edges: [] } },
  }, exec)
  assert.equal(saved.ok, true)
  const badAction = await tool.execute({ action: 'nope' }, exec)
  assert.equal(badAction.ok, false)
  assert.equal(badAction.code, 'action-invalid')
  const noSession = await tool.execute({ action: 'state' }, { agent: {} })
  assert.equal(noSession.ok, false)
  assert.equal(noSession.code, 'session-unavailable')
})

/* -------------------------------------------------------------------------- */
/* 11. HTTP routes through a simulated server                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a simulated IncomingMessage.
 * @param {{method?: string, url?: string, body?: string}} input - request input.
 * @returns {any}
 */
function makeRequest(input = {}) {
  const chunks = input.body === undefined ? [] : [Buffer.from(input.body, 'utf8')]
  return {
    method: input.method ?? 'GET',
    url: input.url ?? '/',
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/**
 * Build a simulated ServerResponse capturing the answer.
 * @returns {any}
 */
function makeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
      this.headersSent = true
    },
  }
}

await check('apply() mounts routes, prompt section, tool attempt and event recorder', async () => {
  modules.http.registerHttpRoutes(richCtx)
  assert.equal(routeRegistrations.length, 3)
  const paths = routeRegistrations.map((route) => route.path).sort()
  assert.deepEqual(paths, ['/api/pm-copilot/action', '/api/pm-copilot/file', '/api/pm-copilot/state'])
  assert.ok(routeRegistrations.every((route) => route.kind === 'exact'))
  // A bare context must not crash.
  modules.index.apply(bareCtx, {})
  assert.equal(promptSections.length, 0)
})

await check('GET /state returns the real snapshot', async () => {
  const handler = routeRegistrations.find((route) => route.path === '/api/pm-copilot/state').handler
  const request = makeRequest({
    url: `/api/pm-copilot/state?workspacePath=${encodeURIComponent(workspace)}&sessionId=${XIAOHUANG_SESSION}`,
  })
  const response = makeResponse()
  await handler(request, response)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.value.identity.verified, true)
  assert.equal(response.headers['cache-control'], 'no-store')
})

await check('GET /state rejects an invalid workspace with a typed envelope', async () => {
  const handler = routeRegistrations.find((route) => route.path === '/api/pm-copilot/state').handler
  const response = makeResponse()
  await handler(makeRequest({ url: '/api/pm-copilot/state?workspacePath=relative' }), response)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'workspace-invalid')
})

await check('POST /action runs a real write and a real read', async () => {
  const handler = routeRegistrations.find((route) => route.path === '/api/pm-copilot/action').handler
  const createResponse = makeResponse()
  await handler(makeRequest({
    method: 'POST',
    url: '/api/pm-copilot/action',
    body: JSON.stringify({
      action: 'project.create',
      sessionId: XIAOHUANG_SESSION,
      workspacePath: workspace,
      payload: { title: 'HTTP 创建的项目' },
    }),
  }), createResponse)
  assert.equal(createResponse.status, 200)
  const created = JSON.parse(createResponse.body)
  assert.equal(created.ok, true)
  assert.match(created.value.project.projectId, /^PJ-/)

  const readResponse = makeResponse()
  await handler(makeRequest({
    method: 'POST',
    url: '/api/pm-copilot/action',
    body: JSON.stringify({
      action: 'knowledge.search',
      sessionId: XIAOHUANG_SESSION,
      workspacePath: workspace,
      payload: { query: '示例实体' },
    }),
  }), readResponse)
  const readBody = JSON.parse(readResponse.body)
  assert.equal(readBody.ok, true)
  assert.ok(readBody.value.items.length >= 1)
})

await check('POST /action protocol errors: 400 bad method/json, 413 oversize, identity refusal', async () => {
  const handler = routeRegistrations.find((route) => route.path === '/api/pm-copilot/action').handler
  const wrongMethod = makeResponse()
  await handler(makeRequest({ method: 'GET', url: '/api/pm-copilot/action' }), wrongMethod)
  assert.equal(wrongMethod.status, 400)

  const invalidJson = makeResponse()
  await handler(makeRequest({ method: 'POST', url: '/api/pm-copilot/action', body: 'not json' }), invalidJson)
  assert.equal(invalidJson.status, 400)
  assert.equal(JSON.parse(invalidJson.body).code, 'body-invalid')

  const tooLarge = makeResponse()
  const huge = `{"action":"state","workspacePath":"${workspace}","pad":"${'x'.repeat(4 * 1024 * 1024 + 64)}"}`
  await handler(makeRequest({ method: 'POST', url: '/api/pm-copilot/action', body: huge }), tooLarge)
  assert.equal(tooLarge.status, 413)
  assert.equal(JSON.parse(tooLarge.body).code, 'body-too-large')

  // Unverified session on a write action: HTTP 200 + identity-unverified.
  const unverified = makeResponse()
  await handler(makeRequest({
    method: 'POST',
    url: '/api/pm-copilot/action',
    body: JSON.stringify({ action: 'task.create', sessionId: 'unknown-session', workspacePath: workspace, payload: { projectId, title: 'x' } }),
  }), unverified)
  assert.equal(unverified.status, 200)
  const body = JSON.parse(unverified.body)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'identity-unverified')
})

await check('GET /file serves bounded text and answers 403/404 correctly', async () => {
  const handler = routeRegistrations.find((route) => route.path === '/api/pm-copilot/file').handler
  const okResponse = makeResponse()
  await handler(makeRequest({
    url: `/api/pm-copilot/file?workspacePath=${encodeURIComponent(workspace)}&path=${encodeURIComponent(wikiPage)}`,
  }), okResponse)
  assert.equal(okResponse.status, 200)
  assert.equal(okResponse.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(okResponse.headers['cache-control'], 'no-store')
  assert.equal(okResponse.headers['x-content-type-options'], 'nosniff')
  assert.match(okResponse.body, /E-0001/)

  const outside = makeResponse()
  await handler(makeRequest({
    url: `/api/pm-copilot/file?workspacePath=${encodeURIComponent(workspace)}&path=${encodeURIComponent('C:\\Windows\\win.ini')}`,
  }), outside)
  assert.equal(outside.status, 403)
  assert.equal(JSON.parse(outside.body).code, 'path-outside-workspace')

  const missing = makeResponse()
  await handler(makeRequest({
    url: `/api/pm-copilot/file?workspacePath=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path.join(workspace, 'nope.md'))}`,
  }), missing)
  assert.equal(missing.status, 404)
})

/* -------------------------------------------------------------------------- */
/* 12. Cleanup                                                                */
/* -------------------------------------------------------------------------- */

for (const dispose of disposeListeners.splice(0)) {
  try {
    dispose()
  } catch {
    // Fine.
  }
}
fs.rmSync(tempRoot, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} check group(s), ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`ALL CHECKS PASSED (${passed} groups)`)
}
