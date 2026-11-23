/**
 * Session identity resolution for PM Copilot.
 *
 * The cockpit is only writable by a Session composed from the `xiaohuang` Agent
 * preset. The one reliable signal is the session projection row `agentPreset`,
 * so this module resolves it in a documented priority order and reports exactly
 * three outcomes:
 *
 * 1. the optional `agentPresets` service's `presetForSession(session)`;
 * 2. `sessions.get(sessionId).header.agentPreset` (a header may lag);
 * 3. the persisted projection cache
 *    `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`, read-only,
 *    row `record.rows.agentPreset.val` — used only when 1 and 2 are unavailable.
 *
 * Any other value becomes `other:<value>`; an unreadable/unavailable identity is
 * `undefined`. Writes and Agent prompts must fail closed on `undefined`
 * (`identity-unverified`). This module never guesses.
 *
 * @module @local/dsh-pm-copilot/lib/identity
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fail, isPlainObject, nonEmptyText, tryGetService } from './store.js'

/** The Agent preset id that owns the cockpit. */
export const XIAOHUANG_PRESET = 'xiaohuang'

/**
 * Classify a raw preset value into the three-state identity contract.
 * @param {unknown} raw - preset id read from a service or projection cache.
 * @returns {'xiaohuang'|`other:${string}`|undefined}
 */
export function classifyPreset(raw) {
  const value = nonEmptyText(raw)
  if (value === undefined) return undefined
  if (value === XIAOHUANG_PRESET) return XIAOHUANG_PRESET
  return `other:${value}`
}

/**
 * Locate the DSH home directory that holds sessions and projection caches.
 * @returns {string}
 */
export function dshHome() {
  const fromEnvironment = nonEmptyText(process.env.DSH_HOME)
  if (fromEnvironment !== undefined) return fromEnvironment
  return path.join(os.homedir(), '.dsh')
}

/**
 * Projection cache file path of one Session.
 * @param {string} sessionId - session id.
 * @returns {string|undefined} absolute path, or undefined for an unsafe id.
 */
export function projectionCachePath(sessionId) {
  const id = nonEmptyText(sessionId)
  // Session ids are UUID-ish; anything else cannot be a cache file name.
  if (id === undefined || !/^[A-Za-z0-9._-]+$/.test(id)) return undefined
  return path.join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

/**
 * Read the preset id from the persisted projection cache, or undefined.
 *
 * Cache rows are persisted as `{ ver, seq, val }`; a bare value shape is also
 * accepted so a format change degrades to "unreadable" instead of crashing.
 * @param {string} sessionId - session id.
 * @returns {string|undefined}
 */
export function readPresetFromProjectionCache(sessionId) {
  const file = projectionCachePath(sessionId)
  if (file === undefined) return undefined
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) return undefined
    const record = isPlainObject(parsed.record) ? parsed.record : parsed
    const rows = isPlainObject(record.rows) ? record.rows : {}
    const candidates = [
      rows.agentPreset,
      record.agentPreset,
      isPlainObject(record.header) ? record.header.agentPreset : undefined,
      isPlainObject(parsed.header) ? parsed.header.agentPreset : undefined,
    ]
    for (const candidate of candidates) {
      const value = unwrapProjectionValue(candidate)
      const preset = nonEmptyText(value)
      if (preset !== undefined) return preset
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Unwrap a projection row into its value (`{val}` / `{value}` shape aware).
 * @param {unknown} row - projection row or bare value.
 * @returns {unknown}
 */
function unwrapProjectionValue(row) {
  if (isPlainObject(row)) {
    if ('val' in row) return row.val
    if ('value' in row) return row.value
    return undefined
  }
  return row
}

/**
 * Read the preset id from the `sessions` service header.
 * @param {any} ctx - plugin context.
 * @param {string} sessionId - session id.
 * @returns {string|undefined}
 */
function presetFromSessionHeader(ctx, sessionId) {
  const sessions = tryGetService(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.get !== 'function') return undefined
  try {
    const session = sessions.get(sessionId)
    if (!isPlainObject(session) && typeof session !== 'object') return undefined
    const header = isPlainObject(session?.header) ? session.header : undefined
    return nonEmptyText(header?.agentPreset) ?? nonEmptyText(session?.agentPreset)
  } catch {
    return undefined
  }
}

/**
 * Resolve the identity of one Session.
 *
 * @param {any} ctx - the plugin context (services are read lazily and optional).
 * @param {unknown} sessionId - the Session id asserted by the caller.
 * @returns {Promise<'xiaohuang'|`other:${string}`|undefined>} the identity, or
 *   undefined when it cannot be confirmed.
 */
export async function resolveIdentity(ctx, sessionId) {
  const id = nonEmptyText(sessionId)
  if (id === undefined) return undefined

  // 1. The agentPresets service, when it exposes presetForSession.
  const agentPresets = tryGetService(ctx, 'agentPresets')
  if (agentPresets !== undefined && typeof agentPresets.presetForSession === 'function') {
    const sessions = tryGetService(ctx, 'sessions')
    let session
    if (sessions !== undefined && typeof sessions.get === 'function') {
      try {
        session = sessions.get(id)
      } catch {
        session = undefined
      }
    }
    // The documented signature takes the session object. When the sessions
    // service is unavailable, try the id itself once; a signature mismatch
    // throws and is ignored, never guessed.
    for (const argument of [session, id]) {
      if (argument === undefined) continue
      try {
        const value = await agentPresets.presetForSession(argument)
        const identity = classifyPreset(value)
        if (identity !== undefined) return identity
      } catch {
        // Try the next argument shape / source.
      }
    }
  }

  // 2. The session header recorded when the session was created.
  const headerPreset = presetFromSessionHeader(ctx, id)
  const headerIdentity = classifyPreset(headerPreset)
  if (headerIdentity !== undefined) return headerIdentity

  // 3. The persisted projection cache (read-only, last resort).
  const cachedPreset = readPresetFromProjectionCache(id)
  return classifyPreset(cachedPreset)
}

/**
 * Client-facing projection of an identity.
 * `verified` is true only for the cockpit owner: an unreadable identity and any
 * other preset both refuse writes.
 * @param {'xiaohuang'|`other:${string}`|undefined} identity - resolved identity.
 * @returns {{preset: string|null, verified: boolean}}
 */
export function identityView(identity) {
  return {
    preset: identity === undefined ? null : identity,
    verified: identity === XIAOHUANG_PRESET,
  }
}

/**
 * Fail-closed gate for every write action and every Agent prompt.
 * @param {any} ctx - plugin context.
 * @param {unknown} sessionId - asserted Session id.
 * @returns {Promise<{ok: true, value: 'xiaohuang'}|{ok: false, code: 'identity-unverified', message: string}>}
 */
export async function requireXiaohuang(ctx, sessionId) {
  const identity = await resolveIdentity(ctx, sessionId)
  if (identity === XIAOHUANG_PRESET) return { ok: true, value: XIAOHUANG_PRESET }
  if (identity === undefined) {
    return fail(
      'identity-unverified',
      '无法确认当前会话的 Agent 预设（需要唯一可核实的信号 agentPreset），已拒绝该操作。',
    )
  }
  return fail(
    'identity-unverified',
    `当前会话使用的 Agent 预设是 ${identity}，驾驶舱只允许 xiaohuang 预设写操作。`,
  )
}
