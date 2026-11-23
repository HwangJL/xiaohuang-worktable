/**
 * PM Copilot (产品经理驾驶舱) — Host half entry point.
 *
 * A DSH Cordis plugin. On `apply` it assembles, each under its own Cordis
 * lifecycle effect so unload releases everything:
 *
 * 1. the three `/api/pm-copilot` HTTP routes (via the optional `webServer`);
 * 2. the `pm_copilot` Agent tool (via scoped injection of `tools`);
 * 3. one `systemPrompt` section telling the 小黄 Agent to write real work back
 *    into the cockpit;
 * 4. the `session/event` recorder that turns real execution events into the
 *    cockpit trace.
 *
 * Every service is optional and read lazily: a deployment without `webServer`,
 * `tools`, `skills`, `sessionController` or `systemPrompt` still loads, and the
 * missing capability is reported (`capabilities`, `agent-unavailable`,
 * `skills-unavailable`) instead of crashing the Host process.
 *
 * The package never imports `@deepseek-ai/*` (the profile cannot resolve them);
 * only Node built-ins are used.
 *
 * @module @local/dsh-pm-copilot
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createSessionEventRecorder } from './lib/agent.js'
import { XIAOHUANG_PRESET, resolveIdentity } from './lib/identity.js'
import { registerHttpRoutes } from './lib/http.js'
import { tryGetService } from './lib/store.js'
import { registerPmCopilotTool } from './lib/tools.js'

/**
 * Required Host services. `webServer` is the only hard dependency: without an
 * HTTP surface the cockpit has no browser half to serve. Every other service
 * (`tools`, `systemPrompt`, `skills`, `sessionController`, `connection`,
 * `agentPresets`, `workspaceRegistry`) is optional and read lazily, so a
 * deployment that lacks one still loads and reports the capability as absent.
 */
export const inject = ['webServer']

/** Name of the registered system-prompt section. */
export const PROMPT_SECTION_NAME = 'plugin:pm-copilot'

/** Order of the cockpit prompt section (runs after the base instructions). */
export const PROMPT_SECTION_ORDER = 1400

/** Text announced to the 小黄 Agent when the system prompt registry exists. */
export const PROMPT_SECTION_TEXT = [
  '【PM Copilot 驾驶舱】',
  '本会话的产出属于 PM Copilot（产品经理驾驶舱）。驾驶舱数据落在当前工作区的 .pm-copilot/（state.json、audit.jsonl、prd/、quality/），工作区知识库在 kb/（操作规则见 kb/SCHEMA.md）。',
  '- 用 pm_copilot 工具读取现状（action=state）并在每个阶段把真实产出写回驾驶舱：分析用 analysis_save / task_business_save，方案用 task_solution_save，任务拆分用 task_subtasks_save，文档用 prd_save，交付物用 deliverable_add，决策用 decision_propose，知识用 knowledge_ingest，检查用 quality_report。',
  '- 只写在聊天里的结论视为未完成；不编造数据，需要用户确认的事项写进 analysis.completeness.toConfirm。',
  '- 写操作只接受 xiaohuang 预设的会话；身份无法确认时工具会返回 identity-unverified，此时如实告知用户，不要绕开。',
].join('\n')

/** Directory and file that record one line per Host activation attempt. */
const TRACE_DIR = fileURLToPath(new URL('./.runtime/', import.meta.url))
const TRACE_FILE = fileURLToPath(new URL('./.runtime/host-boot.log', import.meta.url))

/**
 * Append one activation line to `.runtime/host-boot.log`.
 *
 * Route mounting depends on when `webServer` activates relative to this plugin,
 * which is invisible from outside the Host process: the Client half only sees a
 * 404. Recording each step lets a single restart answer whether `apply` ran, the
 * scoped injection fired, and how many routes the server accepted.
 *
 * @param {string} message - line to record.
 * @returns {void}
 */
function bootTrace(message) {
  try {
    mkdirSync(TRACE_DIR, { recursive: true })
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} pid=${process.pid} ${message}\n`, 'utf8')
  } catch {
    // Diagnostics are best-effort; a log write must never fail activation.
  }
}

/**
 * Run one assembly step under a Cordis lifecycle effect.
 *
 * @param {any} ctx - plugin context.
 * @param {() => (() => void)|void} factory - builds resources, returns a disposer.
 * @param {string} label - effect label (shows in DSH logs).
 * @param {Array<() => void>} fallbackDisposers - collected when the context has no `effect`.
 * @returns {void}
 */
function mountEffect(ctx, factory, label, fallbackDisposers) {
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(factory, label)
      return
    } catch (error) {
      console.warn(`[pm-copilot] effect "${label}" failed to mount`, error)
      return
    }
  }
  try {
    const dispose = factory()
    if (typeof dispose === 'function') fallbackDisposers.push(dispose)
  } catch (error) {
    console.warn(`[pm-copilot] step "${label}" failed to mount`, error)
  }
}

/**
 * Mount the three `/api/pm-copilot` routes once `webServer` exists.
 *
 * The route table is the only hard dependency, so it is mounted through scoped
 * injection rather than read once: a Loader that applies this plugin before
 * `webServer` has activated would otherwise find `ctx.get('webServer')`
 * undefined and silently install no routes at all (the Client half then reads
 * 404 and reports "Host 半边未挂载"). `ctx.inject` re-runs the callback when
 * the service appears, which is the same pattern `lib/tools.js` uses for
 * `tools`.
 *
 * @param {any} ctx - plugin context.
 * @param {Array<() => void>} fallbackDisposers - collected when the context has no `inject`.
 * @returns {void}
 */
function mountHttpRoutes(ctx, fallbackDisposers) {
  const hasInject = typeof ctx.inject === 'function'
  bootTrace(`mountHttpRoutes start inject=${hasInject}`)
  if (hasInject) {
    try {
      ctx.inject(['webServer'], (webCtx) => {
        bootTrace('webServer scope ready')
        mountEffect(webCtx, () => registerHttpRoutes(webCtx, bootTrace), 'pm-copilot: http routes', fallbackDisposers)
      })
      bootTrace('mountHttpRoutes inject scheduled')
      return
    } catch (error) {
      bootTrace(`mountHttpRoutes inject failed: ${error instanceof Error ? error.message : String(error)}`)
      console.warn('[pm-copilot] scoped webServer injection unavailable', error)
    }
  }
  bootTrace('mountHttpRoutes falling back to immediate mount')
  mountEffect(ctx, () => registerHttpRoutes(ctx, bootTrace), 'pm-copilot: http routes', fallbackDisposers)
}

/**
 * Announce the cockpit to the 小黄 Agent only.
 *
 * The announcement is registered on `agent.ctx` — not on the plugin context —
 * so it belongs to that Agent's scope and disappears with it, and it is added
 * only for a Session whose Agent preset resolves to `xiaohuang`. Every other
 * Agent (standard, subagents, other presets) never sees this section, matching
 * the registration-layer rule the Client half enforces for the sidebar entry.
 *
 * @param {any} ctx - plugin context.
 * @returns {() => void} disposer releasing every per-Agent section it added.
 */
function mountPromptSection(ctx) {
  const registry = tryGetService(ctx, 'systemPrompt')
  if (registry === undefined || typeof registry.section !== 'function') return () => {}
  if (typeof ctx.on !== 'function') return () => {}

  /** Live sections, keyed by the Session id that owns them. */
  const owned = new Map()
  let stopped = false

  /** Add the section to one Agent when that Agent's Session is the cockpit owner. */
  const attach = async (agent) => {
    if (stopped || agent === undefined || agent === null) return
    const sessionId = agent.session === undefined ? undefined : agent.session.id
    if (sessionId === undefined || owned.has(sessionId)) return
    let identity
    try {
      identity = await resolveIdentity(ctx, sessionId)
    } catch {
      identity = undefined
    }
    if (stopped || identity !== XIAOHUANG_PRESET) return
    // Prefer the Agent's own registry so the section lives and dies with it.
    const scope = agent.ctx === undefined ? ctx : agent.ctx
    const scoped = scope.get === undefined ? undefined : scope.get('systemPrompt')
    const target = scoped !== undefined && typeof scoped.section === 'function' ? scoped : registry
    try {
      const dispose = target.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        text: PROMPT_SECTION_TEXT,
      })
      if (typeof dispose === 'function') owned.set(sessionId, dispose)
    } catch (error) {
      console.warn('[pm-copilot] systemPrompt.section registration failed', error)
    }
  }

  let offCreated
  try {
    offCreated = ctx.on('agent/created', (payload) => {
      void attach(payload === undefined || payload === null ? undefined : payload.agent)
    })
  } catch (error) {
    console.warn('[pm-copilot] agent/created subscription failed', error)
    return () => {}
  }

  // Agents already live when the plugin mounts (a profile restart re-applies
  // the row after sessions may have resumed) get the section too.
  const agents = tryGetService(ctx, 'agents')
  if (agents !== undefined && typeof agents.list === 'function') {
    try {
      for (const agent of agents.list()) void attach(agent)
    } catch { /* an unreadable registry simply announces nothing */ }
  }

  return () => {
    stopped = true
    if (typeof offCreated === 'function') {
      try {
        offCreated()
      } catch { /* already disposed */ }
    }
    for (const dispose of owned.values()) {
      try {
        dispose()
      } catch { /* the Agent is already gone */ }
    }
    owned.clear()
  }
}

/**
 * Mount the `session/event` recorder.
 * @param {any} ctx - plugin context.
 * @returns {() => void} disposer.
 */
function mountSessionEvents(ctx) {
  const recorder = createSessionEventRecorder(ctx)
  if (typeof ctx.on !== 'function') return () => recorder.dispose()
  let dispose
  try {
    dispose = ctx.on('session/event', (session, event) => {
      recorder.record(session, event)
    })
  } catch (error) {
    console.warn('[pm-copilot] session/event subscription failed', error)
    return () => recorder.dispose()
  }
  return () => {
    recorder.dispose()
    if (typeof dispose === 'function') {
      try {
        dispose()
      } catch {
        // Ignore unload races.
      }
    }
  }
}

/**
 * Apply the PM Copilot Host half to a Cordis context.
 *
 * @param {any} ctx - Cordis plugin context.
 * @param {{enabled?: boolean}} [config] - plugin configuration. `enabled: false`
 *   mounts nothing (the bundle row stays installed but inert).
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  bootTrace('apply entered')
  if (config === null || typeof config !== 'object') config = {}
  if (config.enabled === false) return
  if (ctx === null || typeof ctx !== 'object') {
    console.warn('[pm-copilot] apply received no context; nothing mounted')
    return
  }
  const fallbackDisposers = []

  mountHttpRoutes(ctx, fallbackDisposers)
  mountEffect(ctx, () => registerPmCopilotTool(ctx), 'pm-copilot: pm_copilot tool', fallbackDisposers)
  mountEffect(ctx, () => mountPromptSection(ctx), 'pm-copilot: prompt section', fallbackDisposers)
  mountEffect(ctx, () => mountSessionEvents(ctx), 'pm-copilot: execution trace', fallbackDisposers)

  // A context without `effect` still gets a manual teardown hook.
  if (fallbackDisposers.length > 0 && typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => {
        for (const dispose of fallbackDisposers.splice(0)) {
          try {
            dispose()
          } catch {
            // Ignore unload races.
          }
        }
      })
    } catch {
      // No dispose event in this context.
    }
  }
}
