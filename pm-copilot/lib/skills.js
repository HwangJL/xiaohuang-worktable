/**
 * Skill catalog access for PM Copilot.
 *
 * DSH's `skills` service is the only source of skill truth. The cockpit never
 * invents skills, versions, or usage: it lists what `skills.list({ cwd })`
 * returns, reads a body with `skills.get(name, { cwd })`, and increments usage
 * only from real `tool/call` events (see `lib/agent.js`).
 *
 * The service is optional: a deployment without it answers
 * `skills-unavailable` and the snapshot reports `available: false`, so the UI can
 * disable the actions with a stated reason.
 *
 * @module @local/dsh-pm-copilot/lib/skills
 */

import { fail, nonEmptyText, ok, tryGetService } from './store.js'

/**
 * Normalize the invocation descriptor DSH returns for a skill.
 * @param {unknown} value - raw invocation value.
 * @returns {{modelInvocable: boolean, userInvocable: boolean}}
 */
function invocationView(value) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  return {
    modelInvocable: raw.modelInvocable === true,
    userInvocable: raw.userInvocable === true,
  }
}

/**
 * Normalize one skill entry into the cockpit's stable wire shape.
 *
 * A skill version does not exist in DSH, so it is never fabricated: the UI shows
 * `source` + `provider` instead.
 * @param {unknown} raw - raw `skills.list` entry.
 * @returns {Record<string, any>|undefined}
 */
function skillView(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const name = nonEmptyText(raw.name)
  if (name === undefined) return undefined
  const view = {
    name,
    description: nonEmptyText(raw.description) ?? '',
    invocation: invocationView(raw.invocation),
    source: nonEmptyText(raw.source) ?? '',
    provider: nonEmptyText(raw.provider) ?? '',
  }
  if (nonEmptyText(raw.whenToUse) !== undefined) view.whenToUse = nonEmptyText(raw.whenToUse)
  if (nonEmptyText(raw.path) !== undefined) view.path = nonEmptyText(raw.path)
  return view
}

/**
 * List the merged skill catalog for a workspace.
 * @param {any} ctx - plugin context.
 * @param {string} workspacePath - canonical workspace path (passed as `cwd`).
 * @returns {Promise<{available: boolean, error?: string, items: Array<Record<string, any>>}>}
 */
export async function listSkills(ctx, workspacePath) {
  const service = tryGetService(ctx, 'skills')
  if (service === undefined || typeof service.list !== 'function') {
    return { available: false, error: 'skills-unavailable', items: [] }
  }
  try {
    const result = await service.list({ cwd: workspacePath })
    const entries = Array.isArray(result) ? result : []
    const items = []
    for (const entry of entries) {
      const view = skillView(entry)
      if (view !== undefined) items.push(view)
    }
    return { available: true, items }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      items: [],
    }
  }
}

/**
 * Read one skill's detail (metadata + body) from the real catalog.
 * @param {any} ctx - plugin context.
 * @param {string} workspacePath - canonical workspace path.
 * @param {unknown} name - skill name.
 * @returns {Promise<{ok: true, value: Record<string, any>}|{ok: false, code: string, message: string}>}
 */
export async function getSkillDetail(ctx, workspacePath, name) {
  const skillName = nonEmptyText(name)
  if (skillName === undefined) return fail('payload-invalid', 'skillName 必须是非空字符串')
  const service = tryGetService(ctx, 'skills')
  if (service === undefined) return fail('skills-unavailable', '当前部署没有 skills 服务')
  if (typeof service.get !== 'function') {
    // Some deployments list only; answer from the catalog rather than guessing a body.
    const listed = await listSkills(ctx, workspacePath)
    if (!listed.available) return fail('skills-unavailable', listed.error ?? 'skills 服务不可用')
    const item = listed.items.find((entry) => entry.name === skillName)
    if (item === undefined) return fail('skill-not-found', `技能不存在：${skillName}`)
    return ok({ ...item, content: null, contentAvailable: false })
  }
  try {
    const raw = await service.get(skillName, { cwd: workspacePath })
    if (raw === null || typeof raw !== 'object') {
      return fail('skill-not-found', `技能不存在：${skillName}`)
    }
    const view = skillView(raw)
    if (view === undefined) return fail('skill-not-found', `技能不存在：${skillName}`)
    const content = typeof raw.content === 'string' ? raw.content : null
    return ok({ ...view, content, contentAvailable: content !== null })
  } catch (error) {
    return fail('skills-unavailable', `读取技能失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Skill usage bucket for one skill from real recorded usage.
 * @param {Record<string, any>|undefined} skillUsage - `state.skillUsage`.
 * @param {string} name - skill name.
 * @returns {{count: number, lastAt: string|null, lastTaskId: string|null}}
 */
export function skillUsageOf(skillUsage, name) {
  const bucket = skillUsage !== null && typeof skillUsage === 'object' ? skillUsage[name] : undefined
  return {
    count: bucket !== undefined && Number.isFinite(bucket.count) ? Number(bucket.count) : 0,
    lastAt: bucket !== undefined ? nonEmptyText(bucket.lastAt) ?? null : null,
    lastTaskId: bucket !== undefined ? nonEmptyText(bucket.lastTaskId) ?? null : null,
  }
}
