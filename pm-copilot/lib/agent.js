/**
 * The cockpit's only path to the Agent "brain", plus the real execution trace.
 *
 * `promptAgent` queue-delivers one user message into the named Session through
 * `sessionController.prompt({requestId, sessionId, mode:'queue', content}, signal)`.
 * Before anything is sent it records a real execution (status `sent`) and moves
 * the task to `executing` (unless it is paused/done). There is no fallback
 * path: without the session controller it answers `agent-unavailable` instead of
 * pretending a message was delivered.
 *
 * The event recorder listens to the `session/event` stream and turns REAL events
 * into the execution trace: `tool/call` (including `skill` usage counters),
 * `assistant/message` (first 200 characters), and `turn/end` (completion/failure,
 * task status → `confirming`, progress from the stage map). Events are buffered
 * in memory and flushed at most every 500ms (immediately at `turn/end`) through
 * the store's serial queue, so the state file is never written per token.
 *
 * @module @local/dsh-pm-copilot/lib/agent
 */

import crypto from 'node:crypto'

import { requireXiaohuang } from './identity.js'
import {
  PmCopilotError,
  STAGE_PROGRESS,
  appendAudit,
  fail,
  mutateState,
  newId,
  nonEmptyText,
  nowIso,
  ok,
  textOf,
  tryGetService,
} from './store.js'

/** Hard cap for one composed prompt (characters). */
export const PROMPT_MAX_CHARS = 20_000

/** Cap for events kept on one execution record. */
export const EXECUTION_EVENTS_MAX = 300

/** Cap for execution records kept in `state.executions` (oldest dropped). */
export const EXECUTIONS_MAX = 1000

/** Cap for prompts queued behind one Session (defensive). */
const SESSION_QUEUE_MAX = 32

/** Execution statuses that no longer accept events. */
const TERMINAL_EXECUTION_STATUS = new Set(['completed', 'failed', 'cancelled'])

/**
 * Sessions whose real events belong to a recorded execution:
 * sessionId -> { workspacePath, queue: Array<{executionId, workspacePath}> }.
 * The oldest non-finished prompt owns the events currently streaming; `turn/end`
 * pops it so a queued follow-up takes over.
 */
const sessionTracks = new Map()

/** Buffered event accumulator: executionId -> accumulator. */
const pending = new Map()

/**
 * Extract the session id from a `session/event` session argument.
 * @param {unknown} session - session object from the event callback.
 * @returns {string|undefined}
 */
export function sessionIdOf(session) {
  if (session === null || typeof session !== 'object') return undefined
  const header = typeof session.header === 'object' && session.header !== null ? session.header : undefined
  return nonEmptyText(header?.id) ?? nonEmptyText(session.id)
}

/**
 * Extract the latest assistant text from an `assistant/message` event payload.
 * @param {unknown} message - event data (or message object).
 * @returns {string}
 */
export function assistantTextOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.message?.content ?? message.content
  if (typeof message.message === 'string') return message.message.trim()
  if (!Array.isArray(content)) return ''
  const texts = content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return texts
}

/**
 * Queue one user message into a real Session and record the execution.
 *
 * @param {any} ctx - plugin context.
 * @param {{
 *   workspacePath: string, sessionId: unknown, text: unknown,
 *   kind?: string, title?: string, taskId?: string
 * }} options - prompt request. `kind`/`title` label the execution record.
 * @returns {Promise<{ok: true, value: {sent: true, execution: Record<string, any>, requestId: string}}|{ok: false, code: string, message: string}>}
 */
export async function promptAgent(ctx, options = {}) {
  const workspacePath = nonEmptyText(options.workspacePath)
  if (workspacePath === undefined) return fail('workspace-invalid', 'workspacePath 缺失')
  const sessionId = nonEmptyText(options.sessionId)
  if (sessionId === undefined) return fail('payload-invalid', 'sessionId 缺失：无法向 Agent 发送消息')
  const text = nonEmptyText(options.text)
  if (text === undefined) return fail('payload-invalid', 'text 必须是非空字符串')

  const authority = await requireXiaohuang(ctx, sessionId)
  if (!authority.ok) return authority

  const controller = tryGetService(ctx, 'sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function') {
    return fail('agent-unavailable', '当前部署没有 sessionController，无法向 Agent 发送消息。')
  }

  const kind = nonEmptyText(options.kind) ?? 'agent'
  const title = nonEmptyText(options.title) ?? `${kind} 执行`
  const taskId = nonEmptyText(options.taskId)
  const executionId = newId('EX')
  const requestId = `pm-copilot-${crypto.randomUUID()}`
  const at = nowIso()
  const prompt = text.slice(0, PROMPT_MAX_CHARS)

  // Record the execution BEFORE sending: a delivered message is never untraceable.
  const execution = await mutateState(workspacePath, (state) => {
    let task
    if (taskId !== undefined) {
      task = state.tasks.find((entry) => entry.taskId === taskId)
      if (task === undefined) {
        throw new PmCopilotError('task-not-found', `任务不存在：${taskId}`)
      }
      if (task.status !== 'paused' && task.status !== 'done') {
        task.status = 'executing'
      }
      task.updatedAt = at
    }
    const record = {
      executionId,
      taskId: taskId ?? null,
      kind,
      title,
      sessionId,
      prompt,
      status: 'sent',
      at,
      endedAt: null,
      events: [],
      summary: null,
    }
    state.executions.push(record)
    if (state.executions.length > EXECUTIONS_MAX) {
      state.executions.splice(0, state.executions.length - EXECUTIONS_MAX)
    }
    return record
  })

  try {
    await controller.prompt(
      {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      },
      AbortSignal.timeout(30_000),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const endedAt = nowIso()
    try {
      await mutateState(workspacePath, (state) => {
        const record = state.executions.find((entry) => entry.executionId === executionId)
        if (record !== undefined) {
          record.status = 'failed'
          record.endedAt = endedAt
          record.summary = `发送失败：${message}`
        }
        if (taskId !== undefined) {
          const task = state.tasks.find((entry) => entry.taskId === taskId)
          if (task !== undefined) {
            task.error = `发送失败：${message}`
            task.updatedAt = endedAt
          }
        }
      })
    } catch {
      // The failure envelope is what matters; the record update is best effort.
    }
    await appendAudit(workspacePath, {
      action: 'agent.prompt',
      ok: false,
      code: 'agent-prompt-failed',
      sessionId,
      executionId,
      taskId: taskId ?? null,
      kind,
      message,
    })
    return fail('agent-prompt-failed', `向 Agent 发送消息失败：${message}`)
  }

  // Track this execution so real session events land on the right record.
  const track = sessionTracks.get(sessionId) ?? { workspacePath, queue: [] }
  track.workspacePath = workspacePath
  track.queue.push({ executionId, workspacePath })
  if (track.queue.length > SESSION_QUEUE_MAX) track.queue.splice(0, track.queue.length - SESSION_QUEUE_MAX)
  sessionTracks.set(sessionId, track)

  await appendAudit(workspacePath, {
    action: 'agent.prompt',
    ok: true,
    sessionId,
    executionId,
    taskId: taskId ?? null,
    kind,
    title,
    requestId,
  })
  return ok({ sent: true, execution, requestId })
}

/**
 * Get (or create) the buffered accumulator of one execution.
 * @param {{executionId: string, workspacePath: string}} entry - session queue entry.
 * @returns {{executionId: string, workspacePath: string, events: Array<Record<string, any>>, skillCalls: string[], ended: null|{kind: string, at: string}}}
 */
function accumulatorOf(entry) {
  let accumulator = pending.get(entry.executionId)
  if (accumulator === undefined) {
    accumulator = {
      executionId: entry.executionId,
      workspacePath: entry.workspacePath,
      events: [],
      skillCalls: [],
      ended: null,
    }
    pending.set(entry.executionId, accumulator)
  }
  return accumulator
}

/**
 * Append one trace event onto an execution record (bounded to the newest events).
 * @param {Record<string, any>} execution - execution record inside a state draft.
 * @param {Record<string, any>} event - trace event.
 * @returns {void}
 */
function pushExecutionEvent(execution, event) {
  if (!Array.isArray(execution.events)) execution.events = []
  execution.events.push(event)
  if (execution.events.length > EXECUTION_EVENTS_MAX) {
    execution.events.splice(0, execution.events.length - EXECUTION_EVENTS_MAX)
  }
}

/**
 * Apply one buffered accumulator to the persisted state.
 * @param {{executionId: string, workspacePath: string, events: Array<Record<string, any>>, skillCalls: string[], ended: null|{kind: string, at: string}}} accumulator - buffered events.
 * @returns {Promise<void>}
 */
async function applyAccumulator(accumulator) {
  const audit = await mutateState(accumulator.workspacePath, (state) => {
    const execution = state.executions.find((entry) => entry.executionId === accumulator.executionId)
    if (execution === undefined) return null
    if (TERMINAL_EXECUTION_STATUS.has(execution.status)) return null

    for (const event of accumulator.events) pushExecutionEvent(execution, event)

    const stamp = nowIso()
    for (const skillName of accumulator.skillCalls) {
      const bucket = state.skillUsage[skillName] !== null && typeof state.skillUsage[skillName] === 'object'
        ? state.skillUsage[skillName]
        : { count: 0, lastAt: null, lastTaskId: null }
      bucket.count = (Number.isFinite(bucket.count) ? Number(bucket.count) : 0) + 1
      bucket.lastAt = stamp
      if (execution.taskId !== null && execution.taskId !== undefined) bucket.lastTaskId = execution.taskId
      state.skillUsage[skillName] = bucket
    }

    if (accumulator.ended === null) return null

    const completed = accumulator.ended.kind === 'completed'
    execution.status = completed ? 'completed' : 'failed'
    execution.endedAt = accumulator.ended.at
    execution.summary = completed ? null : `回合结束：${accumulator.ended.kind}`

    if (execution.taskId !== null && execution.taskId !== undefined) {
      const task = state.tasks.find((entry) => entry.taskId === execution.taskId)
      if (task !== undefined) {
        task.lastExecutionAt = accumulator.ended.at
        task.updatedAt = accumulator.ended.at
        if (completed) {
          task.status = 'confirming'
          task.error = null
          const stageProgress = STAGE_PROGRESS[task.stage]
          if (typeof stageProgress === 'number') {
            task.progress = Math.max(Number.isFinite(task.progress) ? task.progress : 0, stageProgress)
          }
        } else {
          task.error = `回合结束：${accumulator.ended.kind}`
        }
      }
    }
    return {
      executionId: accumulator.executionId,
      sessionId: execution.sessionId,
      taskId: execution.taskId ?? null,
      kind: accumulator.ended.kind,
      status: execution.status,
    }
  })
  if (audit !== null && audit !== undefined) {
    await appendAudit(accumulator.workspacePath, { action: 'execution.turn-end', ok: true, ...audit })
  }
}

/**
 * Create the `session/event` recorder of this plugin instance.
 *
 * @param {any} ctx - plugin context (reserved for logging/forward compatibility).
 * @returns {{record: (session: any, event: any) => void, flush: () => Promise<void>, dispose: () => void}}
 */
export function createSessionEventRecorder(ctx) {
  let timer = null
  let disposed = false

  const schedule = () => {
    if (disposed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void flushBuffered().catch((error) => {
        console.warn('[pm-copilot] flush execution events failed', error)
      })
    }, 500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const flushBuffered = async () => {
    const accumulators = [...pending.values()]
    pending.clear()
    for (const accumulator of accumulators) {
      try {
        await applyAccumulator(accumulator)
      } catch (error) {
        console.warn('[pm-copilot] apply execution events failed', error)
      }
    }
  }

  /**
   * Handle one real session event.
   * @param {any} session - session object.
   * @param {any} event - the event.
   * @returns {void}
   */
  const record = (session, event) => {
    if (disposed) return
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    const type = nonEmptyText(event?.type)
    if (type === undefined) return
    const track = sessionTracks.get(sessionId)
    if (track === undefined || track.queue.length === 0) return

    if (type === 'tool/call') {
      const name = nonEmptyText(event?.data?.name)
      if (name === undefined) return
      const accumulator = accumulatorOf(track.queue[0])
      accumulator.events.push({ at: nowIso(), type: '工具调用', detail: name })
      if (accumulator.events.length > EXECUTION_EVENTS_MAX) {
        accumulator.events.splice(0, accumulator.events.length - EXECUTION_EVENTS_MAX)
      }
      if (name === 'skill') {
        const skillName = skillNameFromArguments(event?.data?.arguments)
        if (skillName !== undefined) accumulator.skillCalls.push(skillName)
      }
      schedule()
      return
    }

    if (type === 'assistant/message') {
      const text = assistantTextOf(event?.data)
      if (text === '') return
      const accumulator = accumulatorOf(track.queue[0])
      accumulator.events.push({ at: nowIso(), type: '模型输出', detail: text.slice(0, 200) })
      if (accumulator.events.length > EXECUTION_EVENTS_MAX) {
        accumulator.events.splice(0, accumulator.events.length - EXECUTION_EVENTS_MAX)
      }
      schedule()
      return
    }

    if (type === 'turn/end') {
      const kind = nonEmptyText(event?.data?.reason?.kind) ?? 'unknown'
      const entry = track.queue.shift()
      if (entry !== undefined) {
        const accumulator = accumulatorOf(entry)
        accumulator.ended = { kind, at: nowIso() }
      }
      if (track.queue.length === 0) sessionTracks.delete(sessionId)
      void flushBuffered().catch((error) => {
        console.warn('[pm-copilot] flush execution turn/end failed', error)
      })
    }
  }

  /**
   * Extract `name` from the JSON string arguments of a `skill` tool call.
   * @param {unknown} raw - arguments value (JSON string per the event contract).
   * @returns {string|undefined}
   */
  const skillNameFromArguments = (raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    try {
      const parsed = JSON.parse(raw)
      return nonEmptyText(parsed?.name) ?? nonEmptyText(parsed?.skillName)
    } catch {
      return undefined
    }
  }

  return {
    record,
    flush: flushBuffered,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      void flushBuffered().catch(() => undefined)
      sessionTracks.clear()
    },
  }
}

/**
 * Stage advance a task's progress represents (exported for stage actions).
 * @param {string} stage - task stage.
 * @returns {number|undefined}
 */
export function progressForStage(stage) {
  return STAGE_PROGRESS[stage]
}

/**
 * Whether an execution status is terminal (no further events accepted).
 * @param {string} status - execution status.
 * @returns {boolean}
 */
export function isTerminalExecutionStatus(status) {
  return TERMINAL_EXECUTION_STATUS.has(textOf(status))
}
