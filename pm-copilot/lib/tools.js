/**
 * The Agent-facing `pm_copilot` tool.
 *
 * The 小黄 Agent uses this one tool to persist real work products into the
 * cockpit. It calls the very same dispatcher the HTTP routes call
 * (`dispatchAction`), so one operation has two callers and no second
 * implementation. The Session id and workspace come from the executing Agent
 * (`exec.agent.session`), never from model arguments: the model cannot widen its
 * own identity.
 *
 * Registration uses scoped injection (`ctx.inject(['tools'], ...)`) so the tool
 * binds the moment the tool registry appears, and unregisters with the plugin
 * fiber. When neither path is available the cockpit simply has no Agent tool —
 * the HTTP surface keeps working.
 *
 * @module @local/dsh-pm-copilot/lib/tools
 */

import { READ_ACTIONS, WRITE_ACTIONS, dispatchAction } from './actions.js'
import { fail, failFromError, isPlainObject, nonEmptyText, resolveWorkspace, tryGetService } from './store.js'

/** Tool name registered on the Agent tool registry. */
export const PM_COPILOT_TOOL_NAME = 'pm_copilot'

/**
 * Snake-case (Agent tool) action names mapped onto the canonical action names.
 *
 * The frozen enum the client documents is:
 * `state | task_create | task_update | task_stage | analysis_save |
 *  task_business_save | task_solution_save | task_subtasks_save |
 *  decision_propose | knowledge_ingest | quality_report | prd_save |
 *  deliverable_add`. The remaining aliases exist so the Agent can also operate
 * the rest of the cockpit surface with the same tool.
 */
export const PM_COPILOT_ACTION_ALIASES = {
  state: 'state',
  project_create: 'project.create',
  project_update: 'project.update',
  project_archive: 'project.archive',
  task_create: 'task.create',
  task_update: 'task.update',
  task_delete: 'task.delete',
  task_stage: 'task.stage',
  task_link: 'task.link',
  task_pause: 'task.pause',
  task_resume: 'task.resume',
  task_terminate: 'task.terminate',
  analysis_save: 'task.analysisSave',
  task_analysis_save: 'task.analysisSave',
  task_business_save: 'task.businessSave',
  task_solution_save: 'task.solutionSave',
  task_subtasks_save: 'task.subtasksSave',
  task_analyze: 'task.analyze',
  task_run: 'task.run',
  task_continue: 'task.continue',
  skill_invoke: 'skill.invoke',
  agent_prompt: 'agent.prompt',
  knowledge_ingest: 'knowledge.ingest',
  knowledge_search: 'knowledge.search',
  knowledge_read: 'knowledge.read',
  knowledge_roots: 'knowledge.roots',
  skill_list: 'skill.list',
  skill_detail: 'skill.detail',
  decision_propose: 'decision.propose',
  decision_confirm: 'decision.confirm',
  decision_change: 'decision.change',
  decision_deprecate: 'decision.deprecate',
  decision_ingest: 'decision.ingest',
  deliverable_add: 'deliverable.add',
  prd_save: 'prd.save',
  prd_get: 'prd.get',
  prd_export: 'prd.export',
  quality_report: 'quality.run',
  quality_run: 'quality.run',
  quality_fix: 'quality.fix',
  quality_resolve: 'quality.resolve',
  solution_save: 'solution.save',
}

/** The frozen action enum advertised to the model. */
export const PM_COPILOT_TOOL_ACTIONS = [
  'state',
  'task_create',
  'task_update',
  'task_stage',
  'analysis_save',
  'task_business_save',
  'task_solution_save',
  'task_subtasks_save',
  'decision_propose',
  'knowledge_ingest',
  'quality_report',
  'prd_save',
  'deliverable_add',
]

/**
 * Session id of the calling Agent (never taken from tool arguments).
 * @param {{agent?: any}} exec - tool execution context.
 * @returns {string|undefined}
 */
export function callingSessionId(exec) {
  const agent = exec?.agent
  return nonEmptyText(agent?.session?.id) ?? nonEmptyText(agent?.session?.header?.id)
}

/**
 * Candidate workspace paths the calling Session belongs to, most reliable first.
 * @param {any} ctx - plugin context.
 * @param {{agent?: any}} exec - tool execution context.
 * @param {string|undefined} sessionId - calling session.
 * @returns {string[]}
 */
function workspaceCandidates(ctx, exec, sessionId) {
  const candidates = []
  const header = exec?.agent?.session?.header
  if (typeof header?.cwd === 'string' && header.cwd.trim() !== '') candidates.push(header.cwd)

  // `agents.get(id).session.header.cwd` is the documented fallback.
  const agents = tryGetService(ctx, 'agents')
  if (agents !== undefined && typeof agents.get === 'function' && sessionId !== undefined) {
    try {
      const agent = agents.get(sessionId)
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.trim() !== '') candidates.push(cwd)
    } catch {
      // Unreadable agent registry: keep the other candidates.
    }
  }

  // `workingDirectory` shape varies across DSH releases; probe safely.
  const workingDirectory = tryGetService(ctx, 'workingDirectory')
  if (workingDirectory !== undefined && workingDirectory !== null) {
    const values = []
    if (typeof workingDirectory === 'string') values.push(workingDirectory)
    if (typeof workingDirectory === 'function') {
      try {
        values.push(workingDirectory())
      } catch {
        // Not callable in this release.
      }
    }
    for (const key of ['path', 'cwd', 'current', 'get', 'resolve']) {
      const member = workingDirectory[key]
      if (typeof member === 'string') values.push(member)
      if (typeof member === 'function') {
        try {
          values.push(member.call(workingDirectory))
        } catch {
          // Signature mismatch; ignore this member.
        }
      }
    }
    for (const value of values) {
      if (typeof value === 'string' && value.trim() !== '') candidates.push(value)
    }
  }

  // The official workspace registry maps sessions to workspace roots.
  const registry = tryGetService(ctx, 'workspaceRegistry')
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      const entries = registry.list()
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!isPlainObject(entry)) continue
          const entryPath = nonEmptyText(entry.path)
          if (entryPath === undefined) continue
          const sessionIds = Array.isArray(entry.sessionIds) ? entry.sessionIds : []
          if (sessionId !== undefined && sessionIds.includes(sessionId)) candidates.push(entryPath)
        }
      }
    } catch {
      // Unreadable registry: keep the other candidates.
    }
  }
  return candidates
}

/**
 * Resolve the validated workspace of the calling Session.
 * @param {any} ctx - plugin context.
 * @param {{agent?: any}} exec - tool execution context.
 * @param {string|undefined} sessionId - calling session.
 * @returns {Promise<{path: string, title: string}|undefined>}
 */
async function workspaceOfCaller(ctx, exec, sessionId) {
  for (const candidate of workspaceCandidates(ctx, exec, sessionId)) {
    const workspace = resolveWorkspace(candidate)
    if (workspace.ok) return workspace.value
  }
  return undefined
}

/**
 * Build the `pm_copilot` tool definition bound to the plugin context.
 *
 * @param {any} ctx - plugin context.
 * @returns {Record<string, any>} a `ToolDefinition`-shaped object.
 */
export function createPmCopilotTool(ctx) {
  return {
    name: PM_COPILOT_TOOL_NAME,
    description: [
      'PM Copilot 驾驶舱工具：把真实的分析结果、方案、PRD、决策、知识页与交付物写回驾驶舱，或读取驾驶舱状态。',
      `可用 action：${PM_COPILOT_TOOL_ACTIONS.join(' | ')}（此外还接受其余写操作对应的下划线别名）。`,
      '写操作要求当前会话的 Agent 预设是 xiaohuang；身份无法确认时会被拒绝（identity-unverified），不要伪造成果。',
      '数据落盘在 <会话工作区>/.pm-copilot/ 与工作区的 kb/，所有写入只新建、不覆盖既有文件。',
      '调用时把参数平铺在工具参数里（如 action=prd_save, projectId=..., title=..., sections={...}）；sessionId/workspacePath 由 Host 从当前会话取得，不要传。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: `要执行的动作：${PM_COPILOT_TOOL_ACTIONS.join(' | ')}`,
        },
      },
      required: ['action'],
      additionalProperties: true,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      try {
        const requested = nonEmptyText(args?.action)
        if (requested === undefined) return fail('action-invalid', 'action 缺失')
        const action = PM_COPILOT_ACTION_ALIASES[requested] ?? requested
        if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) {
          return fail('action-invalid', `未知 action：${requested}`)
        }
        const sessionId = callingSessionId(exec)
        if (sessionId === undefined) {
          return fail('session-unavailable', '无法从执行上下文取得当前会话 id')
        }
        const workspace = await workspaceOfCaller(ctx, exec, sessionId)
        if (workspace === undefined) {
          return fail('workspace-unavailable', '无法从当前会话取得已存在的工作区绝对路径')
        }
        const payload = {}
        for (const [key, value] of Object.entries(args ?? {})) {
          if (key === 'action' || key === 'sessionId' || key === 'workspacePath') continue
          payload[key] = value
        }
        if (isPlainObject(args?.payload)) Object.assign(payload, args.payload)
        return await dispatchAction(ctx, {
          action,
          sessionId,
          workspacePath: workspace.path,
          payload,
          source: 'tool',
        })
      } catch (error) {
        return failFromError(error)
      }
    },
  }
}

/**
 * Register the `pm_copilot` tool on the Agent tool registry.
 *
 * @param {any} ctx - plugin context.
 * @returns {() => void} disposer releasing the registration (no-op when the
 *   deployment serves no tool registry).
 */
export function registerPmCopilotTool(ctx) {
  const definition = createPmCopilotTool(ctx)
  const disposers = []

  /**
   * Bind the definition to one registry instance.
   * @param {any} registry - tool registry face.
   * @returns {() => void} disposer.
   */
  const bind = (registry) => {
    if (registry === undefined || typeof registry.register !== 'function') return () => {}
    try {
      const dispose = registry.register(definition)
      if (typeof dispose === 'function') {
        disposers.push(dispose)
        return () => {
          try {
            dispose()
          } catch {
            // Ignore unload races.
          }
        }
      }
    } catch (error) {
      console.warn('[pm-copilot] registering pm_copilot tool failed', error)
    }
    return () => {}
  }

  // Preferred path: scoped injection keeps the tool bound whenever the registry
  // exists, including a registry that activates after this plugin row.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (inner) => {
        let registry
        try {
          registry = inner.get('tools')
        } catch (error) {
          console.warn('[pm-copilot] scoped tools lookup failed', error)
          return () => {}
        }
        return bind(registry)
      })
    } catch (error) {
      console.warn('[pm-copilot] scoped tool injection unavailable', error)
    }
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // Ignore unload races.
        }
      }
    }
  }

  // Fallback for a plain Cordis context without scoped injection.
  return bind(tryGetService(ctx, 'tools'))
}
