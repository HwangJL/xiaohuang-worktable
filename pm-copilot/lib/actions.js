/**
 * PM Copilot action surface: ONE dispatcher shared by the HTTP routes and the
 * `pm_copilot` Agent tool, plus the cockpit snapshot and dashboard computation.
 *
 * Every action validates the workspace first (absolute, existing, directory),
 * then runs through the same code path. Write actions and Agent prompts require
 * a verified `xiaohuang` Session identity (`identity-unverified` otherwise); read
 * actions proceed, but cockpit-store reads degrade to an empty store when the
 * identity cannot be verified, as the contract requires.
 *
 * Metrics and the dashboard are derived from the real records only — an empty
 * cockpit yields zeros and empty lists, never placeholder data.
 *
 * @module @local/dsh-pm-copilot/lib/actions
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { promptAgent } from './agent.js'
import { identityView, requireXiaohuang, resolveIdentity, XIAOHUANG_PRESET } from './identity.js'
import {
  KB_TYPES,
  ingestKnowledge,
  listKnowledgeRoots,
  readKnowledgeFile,
  scanKnowledgeBase,
  searchKnowledge,
} from './kb.js'
import { getSkillDetail, listSkills } from './skills.js'
import { openIssueCount, parsePrdSections, resolveIssue, runQuality, markIssuesFixing } from './quality.js'
import {
  PmCopilotError,
  STAGE_PROGRESS,
  TASK_PRIORITIES,
  TASK_STAGES,
  TASK_STATUSES,
  TASK_TYPES,
  appendAudit,
  arrayOf,
  canWriteDirectory,
  clampInt,
  createEmptyState,
  dataRootOf,
  ensureDir,
  fail,
  failFromError,
  isPlainObject,
  mutateState,
  newId,
  nextNumericId,
  nonEmptyText,
  nowIso,
  ok,
  readState,
  readWorkspaceText,
  resolveWorkspace,
  resolveWorkspacePath,
  resolveWorkspaceTitle,
  runExclusive,
  shortHash,
  slugForTitle,
  stringList,
  textOf,
  tryGetService,
  writeNewTextFile,
} from './store.js'

/** Read actions: no identity gate; store-derived payloads degrade when unverified. */
export const READ_ACTIONS = new Set([
  'state',
  'knowledge.search',
  'knowledge.read',
  'knowledge.roots',
  'skill.list',
  'skill.detail',
  'prd.get',
  'prd.export',
])

/** Write actions: every one requires a verified `xiaohuang` identity. */
export const WRITE_ACTIONS = new Set([
  'project.create',
  'project.update',
  'project.archive',
  'task.create',
  'task.update',
  'task.delete',
  'task.stage',
  'task.link',
  'task.pause',
  'task.resume',
  'task.terminate',
  'task.analysisSave',
  'task.businessSave',
  'task.solutionSave',
  'task.subtasksSave',
  'task.analyze',
  'task.run',
  'task.continue',
  'skill.invoke',
  'agent.prompt',
  'knowledge.ingest',
  'decision.propose',
  'decision.confirm',
  'decision.change',
  'decision.deprecate',
  'decision.ingest',
  'deliverable.add',
  'prd.save',
  'prd.confirm',
  'quality.run',
  'quality.fix',
  'quality.resolve',
  'solution.save',
])

/** Project status vocabulary used by `project.archive`. */
export const PROJECT_STATUSES = ['active', 'archived']

/** Canonical PRD section keys, per the client contract / SCHEMA structure. */
export const PRD_SECTIONS = [
  '需求背景',
  '需求目标',
  '需求范围',
  '用户角色',
  '业务场景',
  '业务流程',
  '功能结构',
  '功能详细说明',
  '业务规则',
  '字段定义',
  '状态流转',
  '接口要求',
  '异常处理',
  '非功能需求',
  '验收标准',
]

/** Dashboard "todo item" categories; order is part of the client contract. */
export const TODO_CATEGORIES = ['等待业务确认', '等待产品决策', '等待补充资料', '等待知识审核', '待修正问题']

/** Max items listed per dashboard todo category. */
const TODO_ITEMS_MAX = 20

/* -------------------------------------------------------------------------- */
/* Snapshot + dashboard                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the cockpit snapshot for one workspace/session.
 *
 * @param {any} ctx - plugin context.
 * @param {{workspacePath: unknown, sessionId?: unknown}} request - snapshot request.
 * @returns {Promise<{ok: true, value: Record<string, any>}|{ok: false, code: string, message: string}>}
 */
export async function buildSnapshot(ctx, request = {}) {
  const workspace = resolveWorkspace(request.workspacePath)
  if (!workspace.ok) return workspace
  const workspacePath = workspace.value.path
  const identity = await resolveIdentity(ctx, request.sessionId)
  const verified = identity === XIAOHUANG_PRESET

  let state
  if (verified) {
    try {
      state = await readState(workspacePath)
    } catch (error) {
      return failFromError(error, 'state-corrupt')
    }
  } else {
    state = createEmptyState()
  }

  const title = await resolveWorkspaceTitle(ctx, workspacePath)
  const kbScan = await scanKnowledgeBase(workspacePath)
  const skillCatalog = await listSkills(ctx, workspacePath)
  const capabilities = {
    agent: typeof tryGetService(ctx, 'sessionController')?.prompt === 'function',
    skills: skillCatalog.available,
    knowledgeRead: true,
    knowledgeWrite: canWriteDirectory(workspacePath),
    quality: true,
    workspace: tryGetService(ctx, 'workspaceRegistry') !== undefined,
  }

  const executions = sortedByDate(state.executions, 'at').slice(0, 50)
  const reports = sortedByDate(state.quality.reports, 'at').slice(0, 20)
  const tasks = arrayOf(state.tasks)
  const decisions = arrayOf(state.decisions)
  const issues = arrayOf(state.quality.issues)

  const metrics = {
    todo: tasks.filter((task) => textOf(task.status) === 'todo').length,
    executing: tasks.filter((task) => ['analysis', 'design', 'executing'].includes(textOf(task.status))).length,
    confirming: tasks.filter((task) => textOf(task.status) === 'confirming').length
      + decisions.filter((decision) => textOf(decision.status) === 'pending').length,
    done: tasks.filter((task) => textOf(task.status) === 'done').length,
    knowledgePending: arrayOf(state.knowledge).filter((entry) => textOf(entry.status) === '待确认').length,
    qualityOpen: openIssueCount(state.quality),
  }

  const dashboard = buildDashboard(state)

  return ok({
    identity: identityView(identity),
    workspace: { path: workspacePath, title },
    projects: arrayOf(state.projects),
    tasks,
    executions,
    deliverables: arrayOf(state.deliverables),
    decisions,
    knowledge: arrayOf(state.knowledge),
    prds: arrayOf(state.prds),
    solutions: arrayOf(state.solutions),
    quality: { issues, reports },
    metrics,
    dashboard,
    skills: { available: skillCatalog.available, ...(skillCatalog.error === undefined ? {} : { error: skillCatalog.error }), items: skillCatalog.items },
    knowledgeStats: kbScan.stats,
    capabilities,
    skillUsage: isPlainObject(state.skillUsage) ? state.skillUsage : {},
    revision: clampInt(state.meta?.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0),
    generatedAt: nowIso(),
    sessionId: nonEmptyText(request.sessionId) ?? null,
    identityVerified: verified,
  })
}

/**
 * Sort a record list by an ISO date field, newest first.
 * @param {Array<Record<string, any>>} records - records.
 * @param {string} field - date field name.
 * @returns {Array<Record<string, any>>}
 */
function sortedByDate(records, field) {
  return arrayOf(records)
    .slice()
    .sort((left, right) => textOf(right?.[field]).localeCompare(textOf(left?.[field])))
}

/**
 * Derive the dashboard exclusively from real records.
 * @param {Record<string, any>} state - cockpit state.
 * @returns {Record<string, any>}
 */
export function buildDashboard(state) {
  const tasks = arrayOf(state.tasks)
  const decisions = arrayOf(state.decisions)
  const knowledge = arrayOf(state.knowledge)
  const issues = arrayOf(state.quality?.issues)
  const sortedTasks = sortedByDate(tasks, 'updatedAt')

  const activeStatuses = new Set(['executing', 'analysis', 'design', 'confirming', 'quality'])
  const executing = sortedTasks.find((task) => textOf(task.status) === 'executing')
  const currentWork = executing ?? sortedTasks.find((task) => activeStatuses.has(textOf(task.status))) ?? null

  // The client renders these as an array of `{ key, title, items }` groups.
  const groups = [
    { key: 'business', title: '等待业务确认', items: [] },
    { key: 'decision', title: '等待产品决策', items: [] },
    { key: 'material', title: '等待补充资料', items: [] },
    { key: 'knowledge', title: '等待知识审核', items: [] },
    { key: 'fix', title: '待修正问题', items: [] },
  ]
  const group = (key) => groups.find((entry) => entry.key === key).items

  for (const task of sortedTasks) {
    const status = textOf(task.status)
    if (status === 'done' || status === 'terminated') continue
    const taskId = textOf(task.taskId)
    const toConfirm = arrayOf(isPlainObject(task.analysis?.completeness) ? task.analysis.completeness.toConfirm : undefined)
    const confirmations = toConfirm
      .map((entry) => (isPlainObject(entry) ? textOf(entry.text ?? entry.question) : textOf(entry)))
      .filter((entry) => entry !== '')
    if (status === 'confirming' || confirmations.length > 0) {
      group('business').push({
        id: taskId,
        taskId,
        title: textOf(task.title),
        detail: confirmations.length > 0
          ? `待确认 ${confirmations.length} 项`
          : `阶段：${textOf(task.stage)}`,
        at: textOf(task.updatedAt),
      })
    }
    if (confirmations.length > 0) {
      group('material').push({
        id: taskId,
        taskId,
        title: textOf(task.title),
        detail: `待确认 ${confirmations.length} 项：${confirmations.slice(0, 2).join('；')}`,
        at: textOf(task.updatedAt),
      })
    } else if (textOf(task.description).trim() === '' || !isPlainObject(task.analysis)) {
      group('material').push({
        id: taskId,
        taskId,
        title: textOf(task.title),
        detail: textOf(task.description).trim() === '' ? '缺少需求描述，等待补充资料' : '缺少需求分析记录，等待补充分析',
        at: textOf(task.updatedAt),
      })
    }
  }
  for (const decision of sortedByDate(decisions, 'updatedAt')) {
    if (textOf(decision.status) !== 'pending') continue
    group('decision').push({
      id: textOf(decision.decisionId),
      decisionId: textOf(decision.decisionId),
      title: textOf(decision.title),
      detail: textOf(decision.type) || '决策',
      at: textOf(decision.updatedAt ?? decision.createdAt),
    })
  }
  for (const entry of sortedByDate(knowledge, 'createdAt')) {
    if (textOf(entry.status) !== '待确认') continue
    group('knowledge').push({
      id: textOf(entry.entryId),
      entryId: textOf(entry.entryId),
      title: textOf(entry.title),
      detail: textOf(entry.type) || '知识页',
      at: textOf(entry.createdAt),
    })
  }
  for (const issue of sortedByDate(issues, 'createdAt')) {
    const status = textOf(issue.status)
    if (status !== 'open' && status !== 'fixing') continue
    group('fix').push({
      id: textOf(issue.issueId),
      issueId: textOf(issue.issueId),
      title: textOf(issue.title),
      detail: `[${textOf(issue.severity)}] ${textOf(issue.dimension)}`,
      at: textOf(issue.createdAt),
    })
  }
  for (const entry of groups) {
    entry.items = sortedByDate(entry.items, 'at').slice(0, TODO_ITEMS_MAX)
  }

  return {
    currentWork,
    recentTasks: sortedTasks.slice(0, 8),
    todoItems: groups,
  }
}

/* -------------------------------------------------------------------------- */
/* Dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Dispatch one action — the single entry point for both HTTP and the Agent tool.
 *
 * @param {any} ctx - plugin context.
 * @param {{action?: unknown, sessionId?: unknown, workspacePath?: unknown, payload?: unknown, source?: unknown}} request - action envelope.
 * @returns {Promise<{ok: true, value: unknown}|{ok: false, code: string, message: string}>}
 */
export async function dispatchAction(ctx, request = {}) {
  const action = nonEmptyText(request.action)
  if (action === undefined) return fail('action-invalid', 'action 缺失')
  const workspace = resolveWorkspace(request.workspacePath)
  if (!workspace.ok) {
    return fail('workspace-invalid', workspace.message)
  }
  const workspacePath = workspace.value.path
  const sessionId = nonEmptyText(request.sessionId)
  const payload = isPlainObject(request.payload) ? request.payload : {}
  const isWrite = WRITE_ACTIONS.has(action)
  if (!isWrite && !READ_ACTIONS.has(action)) {
    return fail('action-invalid', `未知 action：${action}`)
  }
  const source = nonEmptyText(request.source) ?? 'http'

  let result
  if (isWrite) {
    const authority = await requireXiaohuang(ctx, sessionId)
    if (!authority.ok) {
      await appendAudit(workspacePath, {
        action,
        ok: false,
        code: authority.code,
        message: authority.message,
        sessionId: sessionId ?? null,
        source,
      })
      return fail(authority.code, authority.message)
    }
  }

  try {
    const handler = HANDLERS[action]
    result = await handler({ ctx, workspacePath, payload, sessionId, source })
  } catch (error) {
    result = failFromError(error)
  }

  if (isWrite) {
    await appendAudit(workspacePath, {
      action,
      ok: result.ok,
      ...(result.ok ? {} : { code: result.code, message: String(result.message).slice(0, 300) }),
      sessionId: sessionId ?? null,
      source,
    })
  }
  return result
}

/** Action -> handler table (built after the individual handlers). */
const HANDLERS = {}

/**
 * Register one action handler.
 * @param {string} name - action name.
 * @param {(request: {ctx: any, workspacePath: string, payload: Record<string, any>, sessionId: string|undefined, source: string}) => Promise<any>} handler - implementation.
 * @returns {void}
 */
function defineHandler(name, handler) {
  HANDLERS[name] = handler
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read the cockpit state (fresh copy) for a handler.
 * @param {string} workspacePath - canonical workspace path.
 * @returns {Promise<Record<string, any>>}
 */
async function stateOf(workspacePath) {
  return readState(workspacePath)
}

/**
 * Default project for a workspace that has none yet.
 *
 * The cockpit has no project-creation UI in the client half, so the first task
 * (or PRD/decision) without an explicit projectId bootstraps one real project
 * record named after the workspace. An explicitly named but unknown project id
 * is never silently replaced.
 * @param {Record<string, any>} state - state draft.
 * @param {string} workspacePath - canonical workspace path.
 * @returns {Record<string, any>} the existing first project or the new one.
 */
function ensureDefaultProject(state, workspacePath) {
  const existing = arrayOf(state.projects)[0]
  if (existing !== undefined) return existing
  const at = nowIso()
  const project = {
    projectId: newId('PJ'),
    title: path.basename(workspacePath) || '默认项目',
    path: workspacePath,
    createdAt: at,
    updatedAt: at,
    status: 'active',
  }
  state.projects.push(project)
  return project
}

/**
 * Resolve the requested project, or bootstrap the workspace default when the
 * caller did not name one.
 * @param {Record<string, any>} state - state draft.
 * @param {unknown} projectId - caller supplied project id (may be missing).
 * @param {string} workspacePath - canonical workspace path.
 * @returns {Record<string, any>}
 */
function resolveOrCreateProject(state, projectId, workspacePath) {
  const requested = nonEmptyText(projectId)
  if (requested === undefined) return ensureDefaultProject(state, workspacePath)
  return requireProject(state, requested)
}

/**
 * Find one task inside a mutable state draft, throwing a typed error when absent.
 * @param {Record<string, any>} state - state draft.
 * @param {unknown} taskId - requested id.
 * @returns {Record<string, any>}
 */
function requireTask(state, taskId) {
  const id = nonEmptyText(taskId)
  if (id === undefined) throw new PmCopilotError('payload-invalid', 'taskId 缺失')
  const task = arrayOf(state.tasks).find((entry) => textOf(entry.taskId) === id)
  if (task === undefined) throw new PmCopilotError('task-not-found', `任务不存在：${id}`)
  return task
}

/**
 * Find one project inside a state draft.
 * @param {Record<string, any>} state - state draft.
 * @param {unknown} projectId - requested id.
 * @returns {Record<string, any>}
 */
function requireProject(state, projectId) {
  const id = nonEmptyText(projectId)
  if (id === undefined) throw new PmCopilotError('payload-invalid', 'projectId 缺失')
  const project = arrayOf(state.projects).find((entry) => textOf(entry.projectId) === id)
  if (project === undefined) throw new PmCopilotError('project-not-found', `项目不存在：${id}`)
  return project
}

/**
 * Resolve the project a write belongs to, creating the workspace's default
 * project when the caller did not name one.
 *
 * The cockpit must be usable from a genuinely empty workspace: the first task,
 * PRD, decision or deliverable should not require a separate project-creation
 * step. Only when no project exists yet does this create one, named after the
 * workspace, so no fabricated project ever appears next to real ones.
 *
 * @param {Record<string, any>} state - mutable state draft.
 * @param {unknown} rawProjectId - requested project id (may be absent).
 * @param {string} workspacePath - canonical workspace path.
 * @param {string} [fallbackTitle] - title for the created default project.
 * @returns {Record<string, any>} the resolved project record.
 */
function ensureProject(state, rawProjectId, workspacePath, fallbackTitle) {
  const id = nonEmptyText(rawProjectId)
  if (id !== undefined) return requireProject(state, id)
  state.projects = arrayOf(state.projects)
  const existing = state.projects[0]
  if (existing !== undefined) return existing
  const at = nowIso()
  const project = {
    projectId: newId('PJ'),
    title: nonEmptyText(fallbackTitle) ?? '当前工作区',
    path: textOf(workspacePath),
    createdAt: at,
    updatedAt: at,
    status: 'active',
  }
  state.projects.push(project)
  return project
}

/**
 * Find one decision inside a state draft. * @param {Record<string, any>} state - state draft.
 * @param {unknown} decisionId - requested id.
 * @returns {Record<string, any>}
 */
function requireDecision(state, decisionId) {
  const id = nonEmptyText(decisionId)
  if (id === undefined) throw new PmCopilotError('payload-invalid', 'decisionId 缺失')
  const decision = arrayOf(state.decisions).find((entry) => textOf(entry.decisionId) === id)
  if (decision === undefined) throw new PmCopilotError('decision-not-found', `决策不存在：${id}`)
  return decision
}

/**
 * Find one PRD inside a state draft.
 * @param {Record<string, any>} state - state draft.
 * @param {unknown} prdId - requested id.
 * @returns {Record<string, any>}
 */
function requirePrd(state, prdId) {
  const id = nonEmptyText(prdId)
  if (id === undefined) throw new PmCopilotError('payload-invalid', 'prdId 缺失')
  const prd = arrayOf(state.prds).find((entry) => textOf(entry.prdId) === id)
  if (prd === undefined) throw new PmCopilotError('prd-not-found', `PRD 不存在：${id}`)
  return prd
}

/**
 * Validate an enum-valued field, throwing when invalid.
 * @param {unknown} value - raw value.
 * @param {string} field - field name (for the message).
 * @param {readonly string[]} allowed - vocabulary.
 * @returns {string}
 */
function requireEnum(value, field, allowed) {
  const text = nonEmptyText(value)
  if (text === undefined || !allowed.includes(text)) {
    throw new PmCopilotError('payload-invalid', `${field} 必须是 ${allowed.join(' / ')} 之一`)
  }
  return text
}

/**
 * Merge one value into a clone when it is a plain object.
 * @param {unknown} value - candidate object.
 * @returns {Record<string, any>|undefined}
 */
function plainClone(value) {
  return isPlainObject(value) ? structuredClone(value) : undefined
}

/**
 * Normalize a saved requirement analysis payload to the contract shape.
 * @param {Record<string, any>} raw - payload.analysis.
 * @param {string} updatedAt - save timestamp.
 * @returns {Record<string, any>}
 */
function normalizeAnalysis(raw, updatedAt) {
  const defaults = {
    requirement: { raw: '', coreProblem: '', goal: '', businessValue: '', scenarios: [], roles: [] },
    stages: [],
    completeness: { knownKnown: [], retrieved: [], assumptions: [], toConfirm: [], risks: [] },
    plan: [],
    updatedAt,
  }
  const value = { ...defaults, ...structuredClone(raw) }
  value.requirement = { ...defaults.requirement, ...(isPlainObject(raw.requirement) ? structuredClone(raw.requirement) : {}) }
  value.completeness = { ...defaults.completeness, ...(isPlainObject(raw.completeness) ? structuredClone(raw.completeness) : {}) }
  value.stages = arrayOf(value.stages)
  value.plan = arrayOf(value.plan)
  value.updatedAt = updatedAt
  return value
}

/**
 * Normalize a saved business analysis payload to the contract shape.
 * @param {Record<string, any>} raw - payload.business.
 * @param {string} updatedAt - save timestamp.
 * @returns {Record<string, any>}
 */
function normalizeBusiness(raw, updatedAt) {
  const defaults = {
    roles: [],
    objects: [],
    process: { nodes: [], edges: [] },
    rules: [],
    boundary: [],
    risks: [],
    updatedAt,
  }
  const value = { ...defaults, ...structuredClone(raw) }
  value.roles = arrayOf(value.roles)
  value.objects = arrayOf(value.objects)
  value.process = {
    nodes: arrayOf(isPlainObject(value.process) ? value.process.nodes : undefined),
    edges: arrayOf(isPlainObject(value.process) ? value.process.edges : undefined),
  }
  value.rules = arrayOf(value.rules)
  value.boundary = arrayOf(value.boundary)
  value.risks = arrayOf(value.risks)
  value.updatedAt = updatedAt
  return value
}

/**
 * Normalize a saved solution payload to the contract shape.
 * @param {Record<string, any>} raw - payload.solution.
 * @param {Array<Record<string, any>>} versions - version history.
 * @returns {Record<string, any>}
 */
function normalizeSolution(raw, versions) {
  const defaults = {
    title: '',
    positioning: '',
    goals: [],
    architecture: '',
    functions: [],
    modules: [],
    dataModel: '',
    interfaces: '',
    permissions: '',
    mvp: '',
    roadmap: '',
    versions: [],
  }
  const value = { ...defaults, ...structuredClone(raw) }
  for (const key of ['goals', 'functions', 'modules']) value[key] = arrayOf(value[key])
  value.versions = arrayOf(versions)
  if (value.title === undefined) value.title = ''
  return value
}

/**
 * Normalize a saved subtask list.
 * @param {unknown} raw - payload.subtasks.
 * @returns {Array<Record<string, any>>}
 */
function normalizeSubtasks(raw) {
  return arrayOf(raw)
    .filter(isPlainObject)
    .map((entry) => ({
      subtaskId: nonEmptyText(entry.subtaskId) ?? newId('ST'),
      title: textOf(entry.title),
      status: nonEmptyText(entry.status) ?? 'todo',
      dependsOn: stringList(entry.dependsOn),
      output: entry.output === undefined ? null : entry.output,
    }))
}

/**
 * Whether adding `candidate` to `taskId`'s dependencies would create a cycle.
 * @param {Record<string, any>} state - state draft.
 * @param {string} taskId - dependent task.
 * @param {string} candidate - dependency to add.
 * @returns {boolean}
 */
function wouldCreateDependencyCycle(state, taskId, candidate) {
  if (candidate === taskId) return true
  const byId = new Map(arrayOf(state.tasks).map((task) => [textOf(task.taskId), task]))
  const stack = [candidate]
  const seen = new Set()
  while (stack.length > 0) {
    const current = stack.pop()
    if (seen.has(current)) continue
    seen.add(current)
    if (current === taskId) return true
    const task = byId.get(current)
    if (task === undefined) continue
    for (const dependency of stringList(task.dependencies)) stack.push(dependency)
  }
  return false
}

/**
 * Compose the real-context block shared by every generated prompt.
 * @param {Record<string, any>} state - cockpit state copy.
 * @param {Record<string, any>} task - task record.
 * @returns {Promise<string>}
 */
async function taskContextBlock(state, task, workspacePath) {
  const project = arrayOf(state.projects).find((entry) => textOf(entry.projectId) === textOf(task.projectId))
  const lines = [
    `项目：${textOf(project?.title) || '(未命名项目)'}（${textOf(task.projectId)}）`,
    `任务：${textOf(task.title)}（${textOf(task.taskId)}）`,
    `任务类型：${textOf(task.type)}｜阶段：${textOf(task.stage)}｜状态：${textOf(task.status)}｜优先级：${textOf(task.priority)}｜进度：${clampInt(task.progress, 0, 100, 0)}%`,
  ]
  const description = textOf(task.description).trim()
  lines.push(`需求描述：${description === '' ? '（任务未填写需求描述，请先向用户确认需求）' : description}`)
  const skills = stringList(task.skills)
  lines.push(`关联 Skill：${skills.length === 0 ? '（无）' : skills.join('、')}`)
  let knowledge = []
  try {
    const result = await searchKnowledge(workspacePath, { query: textOf(task.title), limit: 5 })
    if (result.ok) knowledge = result.value.items
  } catch {
    knowledge = []
  }
  lines.push(
    knowledge.length === 0
      ? '相关知识：知识库中没有命中本任务标题的页面（可先用 knowledge.search 检索）。'
      : `相关知识（真实路径，可读取）：\n${knowledge.map((item) => `- ${item.path}（${textOf(item.title)}${item.id === undefined ? '' : `，${item.id}`}）`).join('\n')}`,
  )
  if (isPlainObject(task.analysis?.completeness)) {
    const toConfirm = arrayOf(task.analysis.completeness.toConfirm)
      .map((entry) => (isPlainObject(entry) ? textOf(entry.text ?? entry.question) : textOf(entry)))
      .filter((entry) => entry !== '')
    if (toConfirm.length > 0) lines.push(`待确认事项：${toConfirm.slice(0, 5).join('；')}`)
  }
  return lines.join('\n')
}

/**
 * Compose the prompt for `task.analyze` / `task.run` / `task.continue`.
 * @param {{
 *   ctx: any, workspacePath: string, state: Record<string, any>,
 *   task: Record<string, any>, mode: string, instruction: string|undefined
 * }} input - prompt input.
 * @returns {Promise<string>}
 */
async function composeTaskPrompt(input) {
  const modeText = input.mode === 'analyze'
    ? '对当前任务做需求理解与分析（需求背景、核心问题、目标、业务价值、场景、角色与完整度五项）。'
    : input.mode === 'run'
      ? '按当前阶段推进本任务的产出（按阶段要求逐项完成，不要跳过前置阶段）。'
      : '继续推进本任务的下一步工作：先核对已有产出与待确认事项，再补齐缺口。'
  return [
    '【PM Copilot 任务执行】',
    await taskContextBlock(input.state, input.task, input.workspacePath),
    `本次执行：${modeText}`,
    `额外指令：${input.instruction === undefined || input.instruction === '' ? '（无）' : input.instruction}`,
    '要求：',
    '1. 按员工守则执行，使用真实数据与真实文件，不编造结论；需要用户决策的事项写进 analysis.completeness.toConfirm。',
    '2. 产出必须写回驾驶舱：分析用 task_analysis_save / task_business_save，方案用 task_solution_save，文档用 prd_save，知识用 knowledge_ingest。',
    '完成后用 pm_copilot 工具把分析结果/交付物/决策写回驾驶舱。',
  ].join('\n')
}

/**
 * Compose the prompt for `skill.invoke`.
 * @param {{
 *   state: Record<string, any>, skillName: string, task: Record<string, any>|undefined,
 *   instruction: string|undefined, workspacePath: string
 * }} input - prompt input.
 * @returns {Promise<string>}
 */
async function composeSkillPrompt(input) {
  const lines = [
    '【PM Copilot 技能执行】',
    `请使用 skill 工具加载并执行技能「${input.skillName}」。`,
  ]
  if (input.task !== undefined) lines.push(await taskContextBlock(input.state, input.task, input.workspacePath))
  lines.push(`额外指令：${input.instruction === undefined || input.instruction === '' ? '（无）' : input.instruction}`)
  lines.push('要求：严格按该技能定义的方法与输出结构执行；技能输出质量不达标时补充分析或重新执行。')
  lines.push('完成后用 pm_copilot 工具把分析结果/交付物/决策写回驾驶舱。')
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* Read handlers                                                              */
/* -------------------------------------------------------------------------- */

defineHandler('state', async ({ ctx, workspacePath, sessionId }) => (
  buildSnapshot(ctx, { workspacePath, sessionId })
))

defineHandler('knowledge.search', async ({ workspacePath, payload }) => (
  searchKnowledge(workspacePath, {
    query: payload.query,
    project: payload.project,
    type: payload.type,
    status: payload.status,
    limit: payload.limit,
  })
))

defineHandler('knowledge.read', async ({ workspacePath, payload }) => {
  const target = nonEmptyText(payload.path)
  if (target === undefined) return fail('path-invalid', 'path 缺失')
  const read = await readKnowledgeFile(workspacePath, target, 512 * 1024)
  if (!read.ok) return read
  return ok({
    path: read.value.path,
    text: read.value.text,
    size: read.value.size,
    truncated: read.value.truncated,
    maxBytes: read.value.maxBytes,
  })
})

defineHandler('knowledge.roots', async ({ workspacePath }) => {
  const roots = await listKnowledgeRoots(workspacePath)
  return ok({
    roots: roots.roots,
    rootsFile: roots.rootsFile,
    rootsFileExists: roots.rootsFileExists,
    invalid: roots.invalid,
  })
})

defineHandler('skill.list', async ({ ctx, workspacePath }) => {
  const catalog = await listSkills(ctx, workspacePath)
  return catalog.available
    ? ok({ available: true, items: catalog.items })
    : fail('skills-unavailable', catalog.error ?? '当前部署没有 skills 服务')
})

defineHandler('skill.detail', async ({ ctx, workspacePath, payload }) => (
  getSkillDetail(ctx, workspacePath, payload.name ?? payload.skillName)
))

defineHandler('prd.get', async ({ ctx, workspacePath, payload, sessionId }) => {
  const identity = await resolveIdentity(ctx, sessionId)
  if (identity !== XIAOHUANG_PRESET) return ok({ prd: null, degraded: 'identity-unverified' })
  const state = await stateOf(workspacePath)
  const prd = arrayOf(state.prds).find((entry) => textOf(entry.prdId) === nonEmptyText(payload.prdId))
  if (prd === undefined) return fail('prd-not-found', `PRD 不存在：${textOf(payload.prdId)}`)
  const current = await loadPrdCurrent(workspacePath, prd)
  return ok({ prd, current })
})

defineHandler('prd.export', async ({ ctx, workspacePath, payload, sessionId }) => {
  const identity = await resolveIdentity(ctx, sessionId)
  if (identity !== XIAOHUANG_PRESET) {
    // Read, not a write: degrade to the empty store instead of erroring.
    return ok({ prd: null, version: null, markdown: '', sections: {}, degraded: 'identity-unverified' })
  }
  const state = await stateOf(workspacePath)
  const prd = arrayOf(state.prds).find((entry) => textOf(entry.prdId) === nonEmptyText(payload.prdId))
  if (prd === undefined) return fail('prd-not-found', `PRD 不存在：${textOf(payload.prdId)}`)
  const current = await loadPrdCurrent(workspacePath, prd)
  if (current === undefined) return fail('prd-file-missing', 'PRD 当前版本文件不可读')
  if (current.error !== undefined) return fail(current.error, `PRD 当前版本文件不可读：${current.path ?? ''}`)
  return ok({
    prd,
    version: current.version,
    markdown: current.markdown,
    sections: current.sections,
    path: current.path,
    fileName: current.path === undefined ? undefined : path.basename(current.path),
  })
})

/**
 * Confirm the CURRENT version of one PRD.
 *
 * Only a human pressing the button in the cockpit reaches this handler; the
 * agent tool never advertises it. The confirmed version is recorded so the UI
 * can state exactly which version a `已确认` badge refers to, and `prd.save`
 * resets such a PRD to `draft` as soon as it writes a newer version.
 */
defineHandler('prd.confirm', async ({ workspacePath, payload }) => {
  const prdId = nonEmptyText(payload.prdId)
  if (prdId === undefined) return fail('payload-invalid', 'prdId 缺失')
  const confirmedBy = nonEmptyText(payload.confirmedBy)
  if (confirmedBy === undefined) return fail('payload-invalid', 'confirmedBy 必须是确认人')
  const at = nowIso()
  const result = await mutateState(workspacePath, (draft) => {
    const prd = requirePrd(draft, prdId)
    const from = textOf(prd.status) || 'draft'
    const version = Number(prd.currentVersion) || 1
    prd.status = 'confirmed'
    prd.confirmedBy = confirmedBy
    prd.confirmedAt = at
    prd.confirmedVersion = version
    prd.updatedAt = at
    prd.history = arrayOf(prd.history)
    prd.history.push({ at, from, to: 'confirmed', version, reason: `由 ${confirmedBy} 确认 v${version}` })
    return { prd, version, revision: clampInt(draft.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

/**
 * Load the current version document of one PRD.
 * @param {string} workspacePath - canonical workspace path.
 * @param {Record<string, any>} prd - PRD record.
 * @returns {Promise<Record<string, any>|undefined>}
 */
async function loadPrdCurrent(workspacePath, prd) {
  const versions = arrayOf(prd.versions)
  const current = versions.find((version) => Number(version.version) === Number(prd.currentVersion))
    ?? versions[versions.length - 1]
  const filePath = nonEmptyText(current?.path)
  if (filePath === undefined) return { version: prd.currentVersion, at: null, note: null, path: undefined, markdown: '', sections: {}, error: 'prd-file-missing' }
  const read = await readWorkspaceText(workspacePath, filePath)
  if (!read.ok) return { version: prd.currentVersion, at: current?.at ?? null, note: current?.note ?? null, path: filePath, markdown: '', sections: {}, error: read.code }
  return {
    version: current?.version ?? prd.currentVersion,
    at: current?.at ?? null,
    note: current?.note ?? null,
    path: read.value.path,
    markdown: read.value.text,
    sections: parsePrdSections(read.value.text),
    truncated: read.value.truncated,
  }
}

/* -------------------------------------------------------------------------- */
/* Project handlers                                                           */
/* -------------------------------------------------------------------------- */

defineHandler('project.create', async ({ workspacePath, payload }) => {
  const title = nonEmptyText(payload.title)
  if (title === undefined) return fail('payload-invalid', 'title 必须是非空字符串')
  const projectId = newId('PJ')
  const at = nowIso()
  const project = {
    projectId,
    title,
    path: nonEmptyText(payload.path) ?? workspacePath,
    createdAt: at,
    updatedAt: at,
    status: 'active',
  }
  const result = await mutateState(workspacePath, (state) => {
    state.projects.push(project)
    return { project, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('project.update', async ({ workspacePath, payload }) => {
  const patch = isPlainObject(payload.patch) ? payload.patch : {}
  // Accept both the contract shape `{ projectId, patch }` and flat fields.
  const values = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.path !== undefined ? { path: patch.path } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.path !== undefined ? { path: payload.path } : {}),
    ...(payload.status !== undefined ? { status: payload.status } : {}),
  }
  const result = await mutateState(workspacePath, (state) => {
    const project = requireProject(state, payload.projectId)
    if (values.title !== undefined) {
      const title = nonEmptyText(values.title)
      if (title === undefined) throw new PmCopilotError('payload-invalid', 'title 必须是非空字符串')
      project.title = title
    }
    if (values.path !== undefined) {
      const projectPath = nonEmptyText(values.path)
      if (projectPath === undefined) throw new PmCopilotError('payload-invalid', 'path 必须是非空字符串')
      project.path = projectPath
    }
    if (values.status !== undefined) {
      // The project status vocabulary is not pinned by the contract, so accept
      // any short non-empty label instead of rejecting a client-specific one.
      const status = nonEmptyText(values.status)
      if (status === undefined) throw new PmCopilotError('payload-invalid', 'status 必须是非空字符串')
      project.status = status
    }
    project.updatedAt = nowIso()
    return { project, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('project.archive', async ({ workspacePath, payload }) => {
  const result = await mutateState(workspacePath, (state) => {
    const project = requireProject(state, payload.projectId)
    project.status = 'archived'
    project.updatedAt = nowIso()
    return { project, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

/* -------------------------------------------------------------------------- */
/* Task handlers                                                              */
/* -------------------------------------------------------------------------- */

defineHandler('task.create', async ({ workspacePath, payload }) => {
  const title = nonEmptyText(payload.title)
  if (title === undefined) return fail('payload-invalid', 'title 必须是非空字符串')
  const type = payload.type === undefined ? 'requirement' : requireEnum(payload.type, 'type', TASK_TYPES)
  const priority = payload.priority === undefined ? 'P2' : requireEnum(payload.priority, 'priority', TASK_PRIORITIES)
  const at = nowIso()
  const task = {
    taskId: newId('T'),
    projectId: '',
    title,
    description: textOf(payload.description).trim(),
    type,
    stage: TASK_STAGES[0],
    status: 'todo',
    priority,
    progress: 0,
    createdAt: at,
    updatedAt: at,
    skills: [],
    deliverables: [],
    dependencies: [],
    subtasks: [],
    analysis: null,
    business: null,
    solution: null,
    lastExecutionAt: null,
    error: null,
  }
  const result = await mutateState(workspacePath, (state) => {
    const projectCountBefore = arrayOf(state.projects).length
    const project = resolveOrCreateProject(state, payload.projectId, workspacePath)
    task.projectId = textOf(project.projectId)
    if (stringList(payload.skills).length > 0) task.skills = stringList(payload.skills)
    state.tasks.push(task)
    return {
      task,
      project,
      projectCreated: arrayOf(state.projects).length > projectCountBefore,
      revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1,
    }
  })
  return ok(result)
})

defineHandler('task.update', async ({ workspacePath, payload }) => {
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, payload.taskId)
    const patch = isPlainObject(payload.patch) ? payload.patch : {}
    if (patch.title !== undefined) {
      const title = nonEmptyText(patch.title)
      if (title === undefined) throw new PmCopilotError('payload-invalid', 'title 必须是非空字符串')
      task.title = title
    }
    if (patch.description !== undefined) task.description = textOf(patch.description)
    if (patch.type !== undefined) task.type = requireEnum(patch.type, 'type', TASK_TYPES)
    if (patch.priority !== undefined) task.priority = requireEnum(patch.priority, 'priority', TASK_PRIORITIES)
    if (patch.status !== undefined) task.status = requireEnum(patch.status, 'status', TASK_STATUSES)
    if (patch.projectId !== undefined) task.projectId = textOf(requireProject(state, patch.projectId).projectId)
    if (patch.stage !== undefined) {
      const stage = requireEnum(patch.stage, 'stage', TASK_STAGES)
      task.stage = stage
      const mapped = STAGE_PROGRESS[stage]
      if (typeof mapped === 'number') task.progress = Math.max(clampInt(task.progress, 0, 100, 0), mapped)
    }
    if (patch.skills !== undefined) task.skills = stringList(patch.skills)
    if (patch.deliverables !== undefined) task.deliverables = stringList(patch.deliverables)
    if (patch.dependencies !== undefined) task.dependencies = stringList(patch.dependencies)
    // `progress` is intentionally not writable: it only moves on real stage
    // advances and completed Agent turns.
    task.updatedAt = nowIso()
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.delete', async ({ workspacePath, payload }) => {
  const result = await mutateState(workspacePath, (state) => {
    const taskId = nonEmptyText(payload.taskId)
    if (taskId === undefined) throw new PmCopilotError('payload-invalid', 'taskId 缺失')
    const index = arrayOf(state.tasks).findIndex((entry) => textOf(entry.taskId) === taskId)
    if (index === -1) throw new PmCopilotError('task-not-found', `任务不存在：${taskId}`)
    state.tasks.splice(index, 1)
    for (const task of arrayOf(state.tasks)) {
      if (stringList(task.dependencies).includes(taskId)) {
        task.dependencies = task.dependencies.filter((dependency) => dependency !== taskId)
      }
    }
    return { taskId, deleted: true, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.stage', async ({ workspacePath, payload }) => {
  const stage = requireEnum(payload.stage, 'stage', TASK_STAGES)
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, payload.taskId)
    task.stage = stage
    const mapped = STAGE_PROGRESS[stage]
    if (typeof mapped === 'number') task.progress = Math.max(clampInt(task.progress, 0, 100, 0), mapped)
    task.updatedAt = nowIso()
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.link', async ({ workspacePath, payload }) => {
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, payload.taskId)
    const requested = Array.isArray(payload.dependsOn)
      ? payload.dependsOn.map((value) => nonEmptyText(value)).filter((value) => value !== undefined)
      : [nonEmptyText(payload.dependsOn)].filter((value) => value !== undefined)
    if (requested.length === 0) throw new PmCopilotError('payload-invalid', 'dependsOn 必须是非空 taskId 或数组')
    for (const dependencyId of requested) {
      requireTask(state, dependencyId)
      if (wouldCreateDependencyCycle(state, textOf(task.taskId), dependencyId)) {
        throw new PmCopilotError('dependency-cycle', `会形成任务依赖环：${textOf(task.taskId)} -> ${dependencyId}`)
      }
      if (!task.dependencies.includes(dependencyId)) task.dependencies.push(dependencyId)
    }
    task.updatedAt = nowIso()
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

/**
 * Read task id payload for a lifecycle action.
 * @param {Record<string, any>} payload - action payload.
 * @returns {string}
 */
function requirePayloadTaskId(payload) {
  const id = nonEmptyText(payload.taskId)
  if (id === undefined) throw new PmCopilotError('payload-invalid', 'taskId 缺失')
  return id
}

defineHandler('task.pause', async ({ workspacePath, payload }) => {
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, requirePayloadTaskId(payload))
    if (['done', 'terminated'].includes(textOf(task.status))) {
      throw new PmCopilotError('task-state-invalid', `任务当前状态为 ${textOf(task.status)}，不能暂停`)
    }
    task.status = 'paused'
    task.updatedAt = nowIso()
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.resume', async ({ workspacePath, payload }) => {
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, requirePayloadTaskId(payload))
    if (textOf(task.status) !== 'paused') {
      throw new PmCopilotError('task-state-invalid', `任务当前状态为 ${textOf(task.status)}，不是暂停状态`)
    }
    // The previous status is not part of the contract, so resume lands on the
    // neutral waiting state and the next real stage/prompt advance moves it.
    task.status = 'todo'
    task.error = null
    task.updatedAt = nowIso()
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.terminate', async ({ workspacePath, payload }) => {
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, requirePayloadTaskId(payload))
    if (textOf(task.status) === 'done') {
      throw new PmCopilotError('task-state-invalid', '任务已完成，不能终止')
    }
    task.status = 'terminated'
    task.updatedAt = nowIso()
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.analysisSave', async ({ workspacePath, payload }) => {
  const raw = plainClone(payload.analysis)
  if (raw === undefined) return fail('payload-invalid', 'analysis 必须是对象')
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, payload.taskId)
    const at = nowIso()
    task.analysis = normalizeAnalysis(raw, at)
    task.updatedAt = at
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.businessSave', async ({ workspacePath, payload }) => {
  const raw = plainClone(payload.business)
  if (raw === undefined) return fail('payload-invalid', 'business 必须是对象')
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, payload.taskId)
    const at = nowIso()
    task.business = normalizeBusiness(raw, at)
    task.updatedAt = at
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.solutionSave', async ({ workspacePath, payload }) => {
  const raw = plainClone(payload.solution)
  if (raw === undefined) return fail('payload-invalid', 'solution 必须是对象')
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, payload.taskId)
    const at = nowIso()
    const existingVersions = arrayOf(isPlainObject(task.solution) ? task.solution.versions : undefined)
    const maxVersion = existingVersions.reduce((max, version) => Math.max(max, Number(version.version) || 0), 0)
    const versions = [
      ...existingVersions,
      {
        version: maxVersion + 1,
        at,
        note: nonEmptyText(payload.changeNote) ?? '保存产品方案',
      },
    ]
    task.solution = normalizeSolution(raw, versions)
    task.updatedAt = at
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

defineHandler('task.subtasksSave', async ({ workspacePath, payload }) => {
  if (!Array.isArray(payload.subtasks)) return fail('payload-invalid', 'subtasks 必须是数组')
  const subtasks = normalizeSubtasks(payload.subtasks)
  const result = await mutateState(workspacePath, (state) => {
    const task = requireTask(state, payload.taskId)
    task.subtasks = subtasks
    task.updatedAt = nowIso()
    return { task, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

/**
 * Shared implementation of the three Agent-driving task actions.
 * @param {'analyze'|'run'|'continue'} mode - execution mode.
 * @param {{ctx: any, workspacePath: string, payload: Record<string, any>, sessionId: string|undefined}} request - handler request.
 * @returns {Promise<any>}
 */
async function runTaskPrompt(mode, request) {
  const state = await stateOf(request.workspacePath)
  const task = arrayOf(state.tasks).find((entry) => textOf(entry.taskId) === nonEmptyText(request.payload.taskId))
  if (task === undefined) return fail('task-not-found', `任务不存在：${textOf(request.payload.taskId)}`)
  const instruction = nonEmptyText(request.payload.instruction)
  const prompt = await composeTaskPrompt({
    ctx: request.ctx,
    workspacePath: request.workspacePath,
    state,
    task,
    mode,
    instruction,
  })
  const sent = await promptAgent(request.ctx, {
    workspacePath: request.workspacePath,
    sessionId: request.sessionId,
    text: prompt,
    kind: `task.${mode}`,
    title: `任务${mode === 'analyze' ? '分析' : mode === 'run' ? '执行' : '续做'}：${textOf(task.title)}`,
    taskId: textOf(task.taskId),
  })
  if (!sent.ok) return sent
  return ok({ sent: true, execution: sent.value.execution, taskId: textOf(task.taskId), mode })
}

defineHandler('task.analyze', async (request) => runTaskPrompt('analyze', request))
defineHandler('task.run', async (request) => runTaskPrompt('run', request))
defineHandler('task.continue', async (request) => runTaskPrompt('continue', request))

defineHandler('skill.invoke', async ({ ctx, workspacePath, payload, sessionId }) => {
  const skillName = nonEmptyText(payload.skillName) ?? nonEmptyText(payload.name)
  if (skillName === undefined) return fail('payload-invalid', 'skillName 缺失')
  const detail = await getSkillDetail(ctx, workspacePath, skillName)
  if (!detail.ok) return detail
  const state = await stateOf(workspacePath)
  const task = arrayOf(state.tasks).find((entry) => textOf(entry.taskId) === nonEmptyText(payload.taskId))
  const prompt = await composeSkillPrompt({
    state,
    skillName,
    task,
    instruction: nonEmptyText(payload.instruction),
    workspacePath,
  })
  const sent = await promptAgent(ctx, {
    workspacePath,
    sessionId,
    text: prompt,
    kind: 'skill.invoke',
    title: `执行技能：${skillName}`,
    ...(task === undefined ? {} : { taskId: textOf(task.taskId) }),
  })
  if (!sent.ok) return sent
  return ok({ sent: true, skillName, execution: sent.value.execution })
})

defineHandler('agent.prompt', async ({ ctx, workspacePath, payload, sessionId }) => {
  const text = nonEmptyText(payload.text)
  if (text === undefined) return fail('payload-invalid', 'text 必须是非空字符串')
  const state = await stateOf(workspacePath)
  const task = arrayOf(state.tasks).find((entry) => textOf(entry.taskId) === nonEmptyText(payload.taskId))
  const sent = await promptAgent(ctx, {
    workspacePath,
    sessionId,
    text,
    kind: nonEmptyText(payload.kind) ?? 'agent',
    title: nonEmptyText(payload.title) ?? '通用指令',
    ...(task === undefined ? {} : { taskId: textOf(task.taskId) }),
  })
  if (!sent.ok) return sent
  return ok({ sent: true, execution: sent.value.execution })
})

/* -------------------------------------------------------------------------- */
/* Knowledge handlers                                                         */
/* -------------------------------------------------------------------------- */

defineHandler('knowledge.ingest', async ({ workspacePath, payload }) => {
  const ingested = await ingestKnowledge(workspacePath, {
    title: payload.title,
    type: payload.type,
    project: payload.project,
    summary: payload.summary,
    body: payload.body,
    sources: payload.sources,
    tags: payload.tags,
    status: payload.status,
    scope: payload.scope,
  })
  if (!ingested.ok) return ingested
  const entry = ingested.value
  const at = nowIso()
  const knowledgeEntry = {
    entryId: entry.entryId,
    title: entry.title,
    type: entry.type,
    project: entry.project,
    status: entry.status,
    path: entry.path,
    summary: entry.summary,
    sources: entry.sources,
    tags: entry.tags,
    createdAt: at,
    confirmedAt: entry.status === '正式' ? at : null,
  }
  const result = await mutateState(workspacePath, (state) => {
    state.knowledge.push(knowledgeEntry)
    return {
      entry: knowledgeEntry,
      page: entry,
      // Top-level aliases the client reads after an ingest (e.g. the written path).
      id: entry.id,
      entryId: entry.entryId,
      title: entry.title,
      type: entry.type,
      status: entry.status,
      path: entry.path,
      conflict: entry.conflict ?? null,
      revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1,
    }
  })
  return ok(result)
})

/* -------------------------------------------------------------------------- */
/* Decision handlers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Next free `D-NNNN` decision id, considering both cockpit decisions and the
 * knowledge base decision pages so both surfaces share one id space.
 * @param {string} workspacePath - canonical workspace path.
 * @param {Record<string, any>} state - state copy.
 * @returns {Promise<string>}
 */
async function nextDecisionId(workspacePath, state) {
  const existing = arrayOf(state.decisions).map((decision) => textOf(decision.decisionId))
  try {
    const scan = await scanKnowledgeBase(workspacePath)
    for (const item of scan.items) {
      if (item.kind === 'wiki' && item.type === 'decision' && item.id !== undefined) existing.push(item.id)
    }
  } catch {
    // Knowledge base unreadable: the cockpit ids alone are still unique.
  }
  return nextNumericId('D', existing)
}

defineHandler('decision.propose', async ({ workspacePath, payload }) => {
  const title = nonEmptyText(payload.title)
  if (title === undefined) return fail('payload-invalid', 'title 必须是非空字符串')
  const state = await stateOf(workspacePath)
  const requestedProjectId = nonEmptyText(payload.projectId)
  if (requestedProjectId !== undefined && !arrayOf(state.projects).some((entry) => textOf(entry.projectId) === requestedProjectId)) {
    return fail('project-not-found', `项目不存在：${requestedProjectId}`)
  }
  const decisionId = await nextDecisionId(workspacePath, state)
  const at = nowIso()
  const decision = {
    decisionId,
    projectId: requestedProjectId ?? null,
    title,
    type: nonEmptyText(payload.type) ?? 'business',
    background: textOf(payload.background),
    discussion: textOf(payload.discussion),
    conclusion: textOf(payload.conclusion),
    basis: textOf(payload.basis),
    scope: textOf(payload.scope),
    impact: textOf(payload.impact),
    modules: stringList(payload.modules),
    links: stringList(payload.links),
    status: 'pending',
    confirmedBy: null,
    confirmedAt: null,
    createdAt: at,
    updatedAt: at,
    history: [],
  }
  const result = await mutateState(workspacePath, (draft) => {
    if (decision.projectId === null) {
      decision.projectId = textOf(ensureDefaultProject(draft, workspacePath).projectId)
    }
    draft.decisions.push(decision)
    return { decision, revision: clampInt(draft.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

/**
 * Shared status transition for decision lifecycle actions.
 * @param {string} workspacePath - canonical workspace path.
 * @param {string} decisionId - target.
 * @param {'confirmed'|'changed'|'deprecated'} nextStatus - new status.
 * @param {{conclusion?: string, reason?: string, confirmedBy?: string, at: string}} change - applied fields.
 * @returns {Promise<any>}
 */
async function transitionDecision(workspacePath, decisionId, nextStatus, change) {
  const result = await mutateState(workspacePath, (state) => {
    const decision = requireDecision(state, decisionId)
    const from = textOf(decision.status)
    if (change.conclusion !== undefined) decision.conclusion = change.conclusion
    if (change.confirmedBy !== undefined) decision.confirmedBy = change.confirmedBy
    if (nextStatus === 'confirmed') decision.confirmedAt = change.at
    decision.status = nextStatus
    decision.updatedAt = change.at
    decision.history = arrayOf(decision.history)
    decision.history.push({ at: change.at, from, to: nextStatus, reason: change.reason ?? '' })
    return { decision, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
}

defineHandler('decision.confirm', async ({ workspacePath, payload }) => {
  const decisionId = nonEmptyText(payload.decisionId)
  if (decisionId === undefined) return fail('payload-invalid', 'decisionId 缺失')
  const confirmedBy = nonEmptyText(payload.confirmedBy)
  if (confirmedBy === undefined) return fail('payload-invalid', 'confirmedBy 必须是确认人')
  return transitionDecision(workspacePath, decisionId, 'confirmed', {
    at: nowIso(),
    confirmedBy,
    reason: `由 ${confirmedBy} 确认`,
  })
})

defineHandler('decision.change', async ({ workspacePath, payload }) => {
  const decisionId = nonEmptyText(payload.decisionId)
  if (decisionId === undefined) return fail('payload-invalid', 'decisionId 缺失')
  const conclusion = nonEmptyText(payload.conclusion)
  if (conclusion === undefined) return fail('payload-invalid', 'conclusion 必须是非空字符串')
  const reason = nonEmptyText(payload.reason)
  if (reason === undefined) return fail('payload-invalid', 'reason 必须是非空字符串')
  return transitionDecision(workspacePath, decisionId, 'changed', { at: nowIso(), conclusion, reason })
})

defineHandler('decision.deprecate', async ({ workspacePath, payload }) => {
  const decisionId = nonEmptyText(payload.decisionId)
  if (decisionId === undefined) return fail('payload-invalid', 'decisionId 缺失')
  const reason = nonEmptyText(payload.reason)
  if (reason === undefined) return fail('payload-invalid', 'reason 必须是非空字符串')
  return transitionDecision(workspacePath, decisionId, 'deprecated', { at: nowIso(), reason })
})

defineHandler('decision.ingest', async ({ workspacePath, payload }) => {
  const state = await stateOf(workspacePath)
  const decisionId = nonEmptyText(payload.decisionId)
  if (decisionId === undefined) return fail('payload-invalid', 'decisionId 缺失')
  const decision = arrayOf(state.decisions).find((entry) => textOf(entry.decisionId) === decisionId)
  if (decision === undefined) return fail('decision-not-found', `决策不存在：${decisionId}`)
  const projectRecord = arrayOf(state.projects).find((entry) => textOf(entry.projectId) === textOf(decision.projectId))
  const summary = textOf(decision.conclusion) || textOf(decision.background)
  const body = [
    `## 背景\n${textOf(decision.background) || '（未填写）'}`,
    `## 决策\n${textOf(decision.conclusion) || '（未填写）'}`,
    `## 讨论\n${textOf(decision.discussion) || '（未填写）'}`,
    `## 依据\n${textOf(decision.basis) || '（未填写）'}`,
    `## 影响\n${textOf(decision.impact) || '（未填写）'}`,
    `## 范围\n${textOf(decision.scope) || '（未填写）'}`,
  ].join('\n\n')
  const ingested = await ingestKnowledge(workspacePath, {
    title: textOf(decision.title),
    type: 'decision',
    project: textOf(projectRecord?.title) || textOf(decision.projectId) || 'kb',
    summary,
    body,
    sources: stringList(decision.links),
    tags: stringList(decision.modules),
    status: textOf(decision.status) === 'confirmed' ? '正式' : '待确认',
    scope: `决策 ${decisionId} 的适用范围：${textOf(decision.scope) || '（未填写）'}`,
    forcedId: /^D-\d{4}$/.test(decisionId) ? decisionId : undefined,
  })
  if (!ingested.ok) return ingested
  const page = ingested.value
  const at = nowIso()
  const knowledgeEntry = {
    entryId: page.id,
    title: textOf(decision.title),
    type: 'decision',
    project: page.project,
    status: page.status,
    path: page.path,
    summary,
    sources: stringList(decision.links),
    tags: stringList(decision.modules),
    createdAt: at,
    confirmedAt: page.status === '正式' ? at : null,
  }
  const stored = await mutateState(workspacePath, (draft) => {
    draft.knowledge.push(knowledgeEntry)
    return { decision, knowledge: knowledgeEntry, revision: clampInt(draft.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok({ decision: stored.decision, page, knowledge: stored.knowledge })
})

/* -------------------------------------------------------------------------- */
/* Deliverable handlers                                                       */
/* -------------------------------------------------------------------------- */

defineHandler('deliverable.add', async ({ workspacePath, payload }) => {
  const title = nonEmptyText(payload.title)
  if (title === undefined) return fail('payload-invalid', 'title 必须是非空字符串')
  const projectId = nonEmptyText(payload.projectId)
  if (projectId === undefined) return fail('payload-invalid', 'projectId 缺失')
  const plan = await stateOf(workspacePath)
  if (!arrayOf(plan.projects).some((entry) => textOf(entry.projectId) === projectId)) {
    return fail('project-not-found', `项目不存在：${projectId}`)
  }
  const taskId = nonEmptyText(payload.taskId)
  if (taskId !== undefined && !arrayOf(plan.tasks).some((entry) => textOf(entry.taskId) === taskId)) {
    return fail('task-not-found', `任务不存在：${taskId}`)
  }
  const rawPath = nonEmptyText(payload.path)
  if (rawPath === undefined) return fail('payload-invalid', 'path 缺失：交付物必须指向真实文件')
  const resolved = resolveWorkspacePath(workspacePath, rawPath)
  if (!resolved.ok) return resolved
  let stat
  try {
    stat = await fsp.stat(resolved.value)
  } catch {
    return fail('path-not-found', `交付物文件不存在：${rawPath}`)
  }
  if (!stat.isFile()) return fail('path-not-found', `交付物不是普通文件：${rawPath}`)
  const deliverable = {
    deliverableId: newId('DL'),
    taskId: taskId ?? null,
    projectId,
    title,
    kind: nonEmptyText(payload.kind) ?? 'doc',
    path: resolved.value,
    summary: textOf(payload.summary),
    createdAt: nowIso(),
  }
  const result = await mutateState(workspacePath, (state) => {
    requireProject(state, projectId)
    if (taskId !== undefined) requireTask(state, taskId)
    state.deliverables.push(deliverable)
    if (taskId !== undefined) {
      const task = requireTask(state, taskId)
      if (!task.deliverables.includes(deliverable.deliverableId)) task.deliverables.push(deliverable.deliverableId)
      task.updatedAt = deliverable.createdAt
    }
    return { deliverable, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

/* -------------------------------------------------------------------------- */
/* PRD handlers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Validate the sections object of `prd.save`.
 * @param {unknown} raw - payload.sections.
 * @returns {{ok: true, value: Record<string, string>}|{ok: false, code: string, message: string}}
 */
function normalizePrdSections(raw) {
  if (!isPlainObject(raw)) return fail('payload-invalid', 'sections 必须是对象')
  const sections = {}
  let unknownKeys = []
  for (const key of Object.keys(raw)) {
    if (!PRD_SECTIONS.includes(key)) {
      unknownKeys.push(key)
      continue
    }
    sections[key] = textOf(raw[key])
  }
  if (unknownKeys.length > 0) {
    return fail('payload-invalid', `sections 含未知结构项：${unknownKeys.join('、')}（允许：${PRD_SECTIONS.join('、')}）`)
  }
  if (Object.values(sections).every((value) => value.trim() === '')) {
    return fail('payload-invalid', 'sections 至少需要一个非空结构项')
  }
  return ok(sections)
}

/**
 * Render a PRD version markdown file.
 * @param {string} title - PRD title.
 * @param {Record<string, string>} sections - sections in canonical order.
 * @param {{version: number, note: string, at: string}} meta - version metadata.
 * @returns {string}
 */
function renderPrdMarkdown(title, sections, meta) {
  const lines = [
    `# ${title}`,
    '',
    `> 版本 v${meta.version} · 生成时间 ${meta.at} · 变更说明：${meta.note}`,
    '',
  ]
  for (const key of PRD_SECTIONS) {
    if (!Object.hasOwn(sections, key)) continue
    lines.push(`## ${key}`, '', sections[key].trim(), '')
  }
  return lines.join('\n')
}

/**
 * Project slug used in the PRD directory name.
 * @param {Record<string, any>} project - project record.
 * @returns {string}
 */
function projectSlugOf(project) {
  const slug = requireAsciiSlugOptimistic(textOf(project.title))
  if (slug !== '') return slug
  // Chinese project titles have no ASCII slug; projectId is the stable fallback.
  return requireAsciiSlugOptimistic(textOf(project.projectId)) || 'project'
}

/**
 * ASCII slug helper that does not fall back to a hash.
 * @param {string} title - title.
 * @returns {string}
 */
function requireAsciiSlugOptimistic(title) {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
  return normalized.slice(0, 40)
}

/**
 * Scan one PRD directory for the highest existing version number of a slug.
 * @param {string} directory - absolute PRD project directory.
 * @param {string} slug - PRD slug.
 * @returns {Promise<number>}
 */
async function maxPrdVersionOnDisk(directory, slug) {
  let files = []
  try {
    files = await fsp.readdir(directory)
  } catch {
    return 0
  }
  const pattern = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.v(\\d+)\\.md$`)
  let max = 0
  for (const file of files) {
    const match = pattern.exec(file)
    if (match === null) continue
    max = Math.max(max, Number(match[1]))
  }
  return max
}

defineHandler('prd.save', async ({ workspacePath, payload }) => runExclusive(dataRootOf(workspacePath), async () => {
  const sectionsResult = normalizePrdSections(payload.sections)
  if (!sectionsResult.ok) return sectionsResult
  const requestedSections = sectionsResult.value
  let state = await stateOf(workspacePath)
  const prdId = nonEmptyText(payload.prdId)
  let existingPrd
  if (prdId !== undefined) {
    existingPrd = arrayOf(state.prds).find((entry) => textOf(entry.prdId) === prdId)
    if (existingPrd === undefined) return fail('prd-not-found', `PRD 不存在：${prdId}`)
  }
  let projectId = nonEmptyText(payload.projectId) ?? nonEmptyText(existingPrd?.projectId)
  let project = projectId === undefined
    ? undefined
    : arrayOf(state.projects).find((entry) => textOf(entry.projectId) === projectId)
  if (projectId !== undefined && project === undefined) {
    return fail('project-not-found', `项目不存在：${projectId}`)
  }
  if (existingPrd !== undefined && textOf(existingPrd.projectId) !== projectId) {
    return fail('payload-invalid', `PRD ${prdId} 属于项目 ${textOf(existingPrd.projectId)}，与请求的 projectId ${projectId} 不一致`)
  }
  if (project === undefined) {
    // No project named and none exists yet: bootstrap the workspace default,
    // exactly like the first task does.
    project = await mutateState(workspacePath, (draft) => ensureDefaultProject(draft, workspacePath))
    projectId = textOf(project.projectId)
    state = await stateOf(workspacePath)
  }
  const taskId = nonEmptyText(payload.taskId) ?? nonEmptyText(existingPrd?.taskId)
  const linkedTask = taskId === undefined ? undefined : arrayOf(state.tasks).find((entry) => textOf(entry.taskId) === taskId)
  if (taskId !== undefined && linkedTask === undefined) {
    return fail('task-not-found', `任务不存在：${taskId}`)
  }
  const title = nonEmptyText(payload.title)
    ?? (textOf(existingPrd?.title) || textOf(linkedTask?.title))
  if (title === '') return fail('payload-invalid', 'title 缺失')

  const at = nowIso()
  const changeNote = nonEmptyText(payload.changeNote) ?? (existingPrd === undefined ? '创建 PRD v1' : '更新 PRD')
  const projectSlug = projectSlugOf(project)
  const newPrdId = existingPrd === undefined ? newId('PRD') : textOf(existingPrd.prdId)
  let slug = textOf(existingPrd?.slug)
  if (slug === '') {
    slug = slugForTitle(title)
    const used = arrayOf(state.prds).some((entry) => textOf(entry.projectId) === projectId && textOf(entry.slug) === slug)
    if (used) slug = `${slug}-${shortHash(newPrdId)}`
  }
  // An existing PRD keeps the directory its first version was written to, so a
  // later project rename cannot split its version history across two folders.
  let directory = path.join(dataRootOf(workspacePath), 'prd', projectSlug)
  if (existingPrd !== undefined) {
    const firstPath = nonEmptyText(arrayOf(existingPrd.versions)[0]?.path)
    if (firstPath !== undefined) {
      const candidate = path.dirname(firstPath)
      const expectedRoot = path.join(dataRootOf(workspacePath), 'prd')
      if (candidate.startsWith(expectedRoot)) directory = candidate
    }
  }
  await ensureDir(directory)

  // Merge with the previous version so a partial update never silently drops
  // untouched sections; the new version is a NEW file, the old one is untouched.
  let mergedSections = { ...requestedSections }
  if (existingPrd !== undefined) {
    const previous = await loadPrdCurrent(workspacePath, existingPrd)
    if (previous !== undefined && previous.error === undefined) {
      mergedSections = { ...previous.sections, ...requestedSections }
    }
  }
  const nextVersion = Math.max(await maxPrdVersionOnDisk(directory, slug), Number(existingPrd?.currentVersion) || 0) + 1
  const fileName = `${slug}.v${nextVersion}.md`
  const filePath = path.join(directory, fileName)
  const markdown = renderPrdMarkdown(title, mergedSections, { version: nextVersion, note: changeNote, at })
  const written = await writeNewTextFile(filePath, markdown)
  if (!written.ok) return written

  const result = await mutateState(workspacePath, (draft) => {
    requireProject(draft, projectId)
    const modules = stringList(payload.modules)
    let prd
    if (existingPrd === undefined) {
      prd = {
        prdId: newPrdId,
        projectId,
        taskId: taskId ?? null,
        title,
        slug,
        currentVersion: nextVersion,
        versions: [{ version: nextVersion, at, note: changeNote, path: filePath }],
        status: 'draft',
        modules,
        createdAt: at,
        updatedAt: at,
      }
      draft.prds.push(prd)
    } else {
      prd = requirePrd(draft, newPrdId)
      prd.title = title
      if (taskId !== undefined) prd.taskId = taskId
      prd.currentVersion = nextVersion
      prd.versions = arrayOf(prd.versions)
      prd.versions.push({ version: nextVersion, at, note: changeNote, path: filePath })
      // A confirmation only ever covers the version it was given for; writing a
      // new version therefore returns the PRD to `draft` so the cockpit cannot
      // keep showing 已确认 for text nobody confirmed.
      if (textOf(prd.status) === 'confirmed') {
        prd.history = arrayOf(prd.history)
        prd.history.push({ at, from: 'confirmed', to: 'draft', version: nextVersion, reason: `写入新版本 v${nextVersion}，需重新确认` })
        prd.status = 'draft'
        prd.confirmedBy = null
        prd.confirmedAt = null
        prd.confirmedVersion = null
      }
      if (modules.length > 0) prd.modules = modules
      prd.updatedAt = at
    }
    return {
      ...prd,
      prd,
      version: nextVersion,
      path: filePath,
      revision: clampInt(draft.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1,
    }
  })
  return ok(result)
}))

/* -------------------------------------------------------------------------- */
/* Quality handlers                                                           */
/* -------------------------------------------------------------------------- */

defineHandler('quality.run', async ({ workspacePath, payload }) => (
  runQuality(workspacePath, { scope: payload.scope, targetId: payload.targetId })
))

defineHandler('quality.fix', async ({ ctx, workspacePath, payload, sessionId }) => {
  const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds : []
  if (issueIds.length === 0) return fail('payload-invalid', 'issueIds 必须是非空数组')
  const state = await stateOf(workspacePath)
  const issues = arrayOf(state.quality.issues).filter((issue) => issueIds.includes(textOf(issue.issueId)))
  if (issues.length === 0) return fail('issue-not-found', `没有匹配的问题：${issueIds.join(', ')}`)

  const taskIds = issues
    .map((issue) => /^task:(.+)$/.exec(textOf(issue.targetPath)))
    .filter((match) => match !== null)
    .map((match) => match[1])
  const linkedTaskId = taskIds.length === 1
    ? arrayOf(state.tasks).find((task) => textOf(task.taskId) === taskIds[0])?.taskId
    : undefined
  // The client first queues its own detailed fix instruction through agent.prompt
  // and then calls quality.fix to mark the issues. Do not hand the Agent a
  // second, duplicate fix prompt in that case: only a standalone call sends.
  const alreadyPrompted = sessionId !== undefined && arrayOf(state.executions).some((execution) => {
    if (textOf(execution.sessionId) !== sessionId) return false
    if (textOf(execution.kind) !== 'quality.fix') return false
    if (textOf(execution.status) !== 'sent') return false
    const at = Date.parse(textOf(execution.at))
    return Number.isFinite(at) && Date.now() - at < 120_000
  })
  if (alreadyPrompted) {
    const markedOnly = await markIssuesFixing(workspacePath, issueIds)
    if (!markedOnly.ok) return markedOnly
    return ok({
      issues: markedOnly.value.issues,
      sent: false,
      deduplicated: true,
      note: '同一会话已有近期的质量修复指令，本次只标记问题为修复中。',
    })
  }
  const lines = [
    '【PM Copilot 质量问题修复】',
    '以下问题来自 Host 对真实数据的确定性检查，请逐条修复：',
    ...issues.map((issue) => `- [${textOf(issue.severity)}] ${textOf(issue.dimension)}｜${textOf(issue.title)}：${textOf(issue.detail)}（目标：${textOf(issue.targetPath)}）`),
    '要求：',
    '1. 修改真实文档/数据，不要修改检查规则，也不要用占位内容敷衍。',
    '2. 修完后用 pm_copilot 的 quality_resolve 标记问题已解决，resolution 写清改了什么。',
    '完成后用 pm_copilot 工具把分析结果/交付物/决策写回驾驶舱。',
  ]
  const sent = await promptAgent(ctx, {
    workspacePath,
    sessionId,
    text: lines.join('\n'),
    kind: 'quality.fix',
    title: `修复质量问题（${issues.length} 项）`,
    ...(linkedTaskId === undefined ? {} : { taskId: linkedTaskId }),
  })
  if (!sent.ok) return sent
  // Mark the issues only after the fix prompt was really queued: an unavailable
  // Agent must leave the issues open rather than pretend they are being fixed.
  const marked = await markIssuesFixing(workspacePath, issueIds)
  if (!marked.ok) {
    return ok({ issues: [], sent: true, execution: sent.value.execution, warning: marked.message })
  }
  return ok({ issues: marked.value.issues, sent: true, execution: sent.value.execution })
})

defineHandler('quality.resolve', async ({ workspacePath, payload }) => {
  const result = await resolveIssue(workspacePath, payload.issueId, payload.resolution)
  if (!result.ok) return result
  return ok({ issue: result.value })
})

/* -------------------------------------------------------------------------- */
/* Solution handlers                                                          */
/* -------------------------------------------------------------------------- */

defineHandler('solution.save', async ({ workspacePath, payload }) => {
  const projectId = nonEmptyText(payload.projectId)
  if (projectId === undefined) return fail('payload-invalid', 'projectId 缺失')
  const title = nonEmptyText(payload.title)
  if (title === undefined) return fail('payload-invalid', 'title 必须是非空字符串')
  const solutionId = nonEmptyText(payload.solutionId)
  const at = nowIso()
  const fields = {
    title,
    positioning: textOf(payload.positioning),
    goals: stringList(payload.goals),
    architecture: textOf(payload.architecture),
    functions: arrayOf(payload.functions),
    modules: arrayOf(payload.modules),
    dataModel: isPlainObject(payload.dataModel) ? payload.dataModel : textOf(payload.dataModel),
    interfaces: textOf(payload.interfaces),
    permissions: textOf(payload.permissions),
    mvp: textOf(payload.mvp),
    roadmap: textOf(payload.roadmap),
  }
  const result = await mutateState(workspacePath, (state) => {
    requireProject(state, projectId)
    let solution
    if (solutionId !== undefined) {
      solution = arrayOf(state.solutions).find((entry) => textOf(entry.solutionId) === solutionId)
      if (solution === undefined) throw new PmCopilotError('solution-not-found', `方案不存在：${solutionId}`)
      Object.assign(solution, fields)
      solution.updatedAt = at
      solution.versions = arrayOf(solution.versions)
      const nextVersion = solution.versions.reduce((max, version) => Math.max(max, Number(version.version) || 0), 0) + 1
      solution.versions.push({ version: nextVersion, at, note: nonEmptyText(payload.changeNote) ?? '更新方案' })
    } else {
      solution = {
        solutionId: newId('SOL'),
        projectId,
        ...fields,
        versions: [{ version: 1, at, note: nonEmptyText(payload.changeNote) ?? '创建方案' }],
        createdAt: at,
        updatedAt: at,
      }
      state.solutions.push(solution)
    }
    const taskId = nonEmptyText(payload.taskId)
    if (taskId !== undefined) {
      const task = requireTask(state, taskId)
      task.solution = normalizeSolution({ ...solution }, arrayOf(solution.versions))
      task.updatedAt = at
    }
    return { solution, revision: clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1 }
  })
  return ok(result)
})

/* Re-export of the public knowledge type map (used by the Agent tool description). */
export { KB_TYPES }
