/**
 * PM Copilot Host store: the single writer of `<workspace>/.pm-copilot/`.
 *
 * This module owns everything that touches durable cockpit state:
 *
 * - workspace validation (`workspace-invalid`): an absolute, existing directory;
 * - the state file (`state.json`) with atomic write (`state.json.tmp` → rename);
 * - the append-only audit log (`audit.jsonl`);
 * - `meta.lastRevision` bumping on every write (the client reads it to decide
 *   whether to refresh);
 * - one Promise serial queue per data root, so every read-modify-write runs
 *   alone (the queue is re-entrant, so a mutator may call another store helper);
 * - record id generation, local (Asia/Shanghai) timestamps, path containment,
 *   bounded text reads, and small shared result/error helpers.
 *
 * The store never deletes or overwrites an existing file. Directory creation is
 * on demand. Corrupt state is a typed error (`state-corrupt`), never a silent
 * reset: this module refuses to destroy the user's data.
 *
 * @module @local/dsh-pm-copilot/lib/store
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Name of the cockpit data directory inside a workspace. */
export const DATA_DIR_NAME = '.pm-copilot'

/** State file name inside the data directory. */
export const STATE_FILE_NAME = 'state.json'

/** Audit file name inside the data directory. */
export const AUDIT_FILE_NAME = 'audit.jsonl'

/** Maximum bytes returned by a bounded workspace text read (512 KiB). */
export const TEXT_READ_MAX_BYTES = 512 * 1024

/** Task type vocabulary, exactly as the client contract declares it. */
export const TASK_TYPES = ['requirement', 'business', 'design', 'prd', 'quality', 'other']

/** Task stage vocabulary. */
export const TASK_STAGES = [
  '需求理解',
  '业务分析',
  '业务流程',
  '业务规则',
  '产品架构',
  '产品方案',
  'PRD编写',
  '方案评审',
  '需求验收',
]

/** Task status vocabulary. */
export const TASK_STATUSES = [
  'todo',
  'analysis',
  'design',
  'executing',
  'confirming',
  'quality',
  'done',
  'paused',
  'terminated',
]

/** Task priority vocabulary. */
export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3']

/**
 * Progress a REAL stage advance represents. Used when a stage tuple changes or
 * when a completed turn is recorded: progress only ever moves forward.
 */
export const STAGE_PROGRESS = {
  需求理解: 25,
  业务分析: 25,
  业务流程: 25,
  业务规则: 25,
  产品架构: 50,
  产品方案: 50,
  PRD编写: 70,
  方案评审: 85,
  需求验收: 95,
}

/**
 * A structured failure carrying a stable machine code.
 * Every public function of the plugin throws this only for programmer errors;
 * domain refusals are returned as `{ ok:false, code, message }` objects.
 */
export class PmCopilotError extends Error {
  /**
   * @param {string} code - stable machine code (`identity-unverified`, ...).
   * @param {string} message - human readable explanation.
   * @param {Record<string, unknown>} [extra] - additional fields merged on the error.
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'PmCopilotError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * Build a positive result envelope.
 * @param {unknown} value - the payload the caller receives.
 * @param {Record<string, unknown>} [extra] - extra envelope fields.
 * @returns {{ok: true, value: unknown}}
 */
export function ok(value, extra = {}) {
  return { ok: true, value, ...extra }
}

/**
 * Build a negative result envelope.
 * @param {string} code - stable machine code.
 * @param {string} message - human readable explanation.
 * @param {Record<string, unknown>} [extra] - extra envelope fields.
 * @returns {{ok: false, code: string, message: string}}
 */
export function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

/**
 * Convert an arbitrary thrown value into a negative result envelope.
 * @param {unknown} error - anything thrown.
 * @param {string} [fallbackCode] - code used when the error carries none.
 * @returns {{ok: false, code: string, message: string}}
 */
export function failFromError(error, fallbackCode = 'internal') {
  if (error instanceof PmCopilotError) {
    const extra = {}
    for (const key of Object.keys(error)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'code') continue
      extra[key] = error[key]
    }
    return fail(error.code, error.message, extra)
  }
  const message = error instanceof Error ? error.message : String(error)
  return fail(fallbackCode, message)
}

/**
 * Lazily resolve an optional Cordis service.
 *
 * `ctx.get(name)` throws in some Cordis call sites when the service was never
 * injected; the cockpit treats every service as optional and degrades, so this
 * helper swallows that failure and answers `undefined`.
 * @param {any} ctx - the plugin context (or a stand-in in tests).
 * @param {string} name - service name.
 * @returns {any} the service, or undefined.
 */
export function tryGetService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  try {
    if (typeof ctx.get !== 'function') return undefined
    const service = ctx.get(name)
    return service === null ? undefined : service
  } catch {
    return undefined
  }
}

/**
 * Whether a value is a plain JSON object.
 * @param {unknown} value - candidate.
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Trim a value into a string, or fall back when it is not a string.
 * @param {unknown} value - candidate.
 * @param {string} [fallback] - value used when `value` is not a string.
 * @returns {string}
 */
export function textOf(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * Trimmed non-empty string, or undefined.
 * @param {unknown} value - candidate.
 * @returns {string|undefined}
 */
export function nonEmptyText(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Filter an array down to strings.
 * @param {unknown} value - candidate array.
 * @returns {string[]}
 */
export function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/**
 * Coerce to an array (empty array when the value is not one).
 * @param {unknown} value - candidate.
 * @returns {unknown[]}
 */
export function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Clamp an integer into a closed range, falling back when unusable.
 * @param {unknown} value - candidate.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {number} fallback - returned when the value is not a finite number.
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Current wall clock as an ISO-8601 UTC string.
 * @param {Date} [date] - instant to format.
 * @returns {string}
 */
export function nowIso(date = new Date()) {
  return date.toISOString()
}

/** Fixed offset of Asia/Shanghai (China observes no daylight saving time). */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Format an instant as the local China calendar date (`YYYY-MM-DD`).
 * @param {Date} [date] - instant to format.
 * @returns {string}
 */
export function localDate(date = new Date()) {
  return toLocalParts(date).date
}

/**
 * Format an instant as local China date and minute (`YYYY-MM-DD HH:mm`).
 * @param {Date} [date] - instant to format.
 * @returns {string}
 */
export function localDateTime(date = new Date()) {
  const parts = toLocalParts(date)
  return `${parts.date} ${parts.time}`
}

/**
 * Split one instant into Shanghai calendar parts without relying on the host TZ.
 * @param {Date} date - instant.
 * @returns {{date: string, time: string}}
 */
function toLocalParts(date) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  const iso = shifted.toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}

/**
 * Generate a collision-resistant record id with a stable prefix.
 * @param {string} prefix - domain prefix (`T`, `EX`, `DL`, ...).
 * @returns {string} `<prefix>-<10 hex chars>`.
 */
export function newId(prefix) {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

/**
 * Allocate the next monotonic numeric id of a family (`D-0001`, `Q-0001`, ...).
 * Numeric ids are never reused: the scan takes the numeric maximum.
 * @param {string} prefix - family prefix, e.g. `D`.
 * @param {Array<unknown>} existing - existing ids (strings; others ignored).
 * @param {number} [width] - zero padding width, default 4.
 * @returns {string}
 */
export function nextNumericId(prefix, existing, width = 4) {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`)
  let max = 0
  for (const value of existing) {
    if (typeof value !== 'string') continue
    const match = pattern.exec(value)
    if (match === null) continue
    const number = Number(match[1])
    if (Number.isFinite(number) && number > max) max = Number(number)
  }
  return `${prefix}-${String(max + 1).padStart(width, '0')}`
}

/**
 * Escape a literal for use inside a regular expression.
 * @param {string} value - literal.
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Turn a title into an ASCII-only lowercase slug (`a-z0-9` and `-`).
 *
 * Chinese titles intentionally produce an empty slug: pinyin transliteration is
 * not reliable, so the caller falls back to a base36 short hash or the word
 * `entry` (see `slugForTitle`).
 * @param {string} title - human title.
 * @returns {string} slug candidates joined by `-`, possibly empty.
 */
export function asciiSlug(title) {
  return textOf(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48)
}

/**
 * Deterministic base36 short hash of a string (stable across processes).
 * @param {string} value - input text.
 * @param {number} [length] - output length, default 6.
 * @returns {string}
 */
export function shortHash(value, length = 6) {
  const digest = crypto.createHash('sha256').update(textOf(value), 'utf8').digest()
  let number = 0n
  for (let index = 0; index < 8; index += 1) {
    number = (number << 8n) | BigInt(digest[index])
  }
  return number.toString(36).padStart(length, '0').slice(0, length)
}

/**
 * Slug used in generated file names: an ASCII slug, or a base36 hash when the
 * title has no ASCII content, or `entry` when even that is empty.
 * @param {string} title - human title.
 * @returns {string}
 */
export function slugForTitle(title) {
  const slug = asciiSlug(title)
  if (slug !== '') return slug
  const hash = shortHash(title, 8)
  return hash === '' ? 'entry' : hash
}

/**
 * Workspace validation result.
 * @typedef {object} WorkspaceInfo
 * @property {string} path - canonical absolute directory path.
 * @property {string} inputPath - the caller supplied path, trimmed.
 * @property {string} title - display title (basename unless overridden).
 */

/**
 * Validate a workspace path: absolute, existing, and a directory.
 *
 * The spec requires the client to send the workspace root with every request, so
 * this is the first gate of every entry point. The canonical (realpath) value is
 * what the rest of the plugin writes into, so case/symlink differences between
 * requests cannot split one workspace into two data roots.
 * @param {unknown} workspacePath - raw client value.
 * @returns {{ok: true, value: WorkspaceInfo}|{ok: false, code: 'workspace-invalid', message: string}}
 */
export function resolveWorkspace(workspacePath) {
  const raw = nonEmptyText(workspacePath)
  if (raw === undefined) {
    return fail('workspace-invalid', 'workspacePath 必须是非空字符串')
  }
  if (!path.isAbsolute(raw)) {
    return fail('workspace-invalid', 'workspacePath 必须是绝对路径')
  }
  let stat
  try {
    stat = fs.statSync(raw)
  } catch {
    return fail('workspace-invalid', `工作区不存在：${raw}`)
  }
  if (!stat.isDirectory()) {
    return fail('workspace-invalid', `工作区不是目录：${raw}`)
  }
  let canonical = raw
  try {
    canonical = fs.realpathSync(raw)
  } catch {
    canonical = path.resolve(raw)
  }
  return ok({ path: canonical, inputPath: raw, title: path.basename(canonical) })
}

/**
 * Display title for a workspace: the registered workspace title when the
 * registry knows it, else the directory basename.
 * @param {any} ctx - plugin context.
 * @param {string} workspacePath - canonical workspace path.
 * @returns {Promise<string>}
 */
export async function resolveWorkspaceTitle(ctx, workspacePath) {
  const registry = tryGetService(ctx, 'workspaceRegistry')
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      const entries = await registry.list()
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!isPlainObject(entry)) continue
          const entryPath = nonEmptyText(entry.path)
          if (entryPath === undefined) continue
          let canonicalEntry = entryPath
          try {
            canonicalEntry = fs.realpathSync(entryPath)
          } catch {
            canonicalEntry = path.resolve(entryPath)
          }
          if (canonicalEntry === workspacePath) {
            const title = nonEmptyText(entry.title)
            if (title !== undefined) return title
          }
        }
      }
    } catch {
      // Registry unreadable: the basename is the honest fallback.
    }
  }
  return path.basename(workspacePath)
}

/**
 * Data root directory of a validated workspace.
 * @param {string} workspacePath - canonical workspace path.
 * @returns {string}
 */
export function dataRootOf(workspacePath) {
  return path.join(workspacePath, DATA_DIR_NAME)
}

/**
 * Whether `target` is strictly inside `root` (both absolute, normalized paths).
 * @param {string} root - container directory.
 * @param {string} target - candidate path.
 * @returns {boolean}
 */
export function isPathInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Resolve a client supplied path against a workspace and enforce containment.
 *
 * A relative value is resolved under the workspace root; an absolute value is
 * used as-is (and may be a real file only when it lives inside the workspace).
 * @param {string} workspacePath - canonical workspace path.
 * @param {unknown} filePath - absolute or workspace-relative path.
 * @returns {{ok: true, value: string}|{ok: false, code: string, message: string}}
 */
export function resolveWorkspacePath(workspacePath, filePath) {
  const raw = nonEmptyText(filePath)
  if (raw === undefined) return fail('path-invalid', 'path 必须是非空字符串')
  let target = raw
  if (!path.isAbsolute(raw)) {
    target = path.join(workspacePath, raw)
  }
  target = path.resolve(target)
  if (!isPathInside(workspacePath, target)) {
    return fail('path-outside-workspace', `路径不在工作区内：${raw}`)
  }
  return ok(target)
}

/**
 * Read a workspace text file with a hard byte bound.
 *
 * Used by `knowledge.read`, `GET /api/pm-copilot/file`, and PRD/quality readers.
 * The returned `truncated` flag is honest: it is true exactly when the file is
 * larger than the bound and only the head was read.
 * @param {string} workspacePath - canonical workspace path.
 * @param {unknown} filePath - absolute or workspace-relative path.
 * @param {number} [maxBytes] - byte bound, default 512 KiB.
 * @returns {Promise<{ok: true, value: {path: string, text: string, truncated: boolean, size: number, maxBytes: number}}|{ok: false, code: string, message: string}>}
 */
export async function readWorkspaceText(workspacePath, filePath, maxBytes = TEXT_READ_MAX_BYTES) {
  const resolved = resolveWorkspacePath(workspacePath, filePath)
  if (!resolved.ok) return resolved
  const target = resolved.value
  let stat
  try {
    stat = await fsp.stat(target)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return fail('file-not-found', `文件不存在：${filePath}`)
    }
    return fail('file-unreadable', `无法读取文件：${String(error?.message ?? error)}`)
  }
  if (!stat.isFile()) {
    return fail('file-not-found', `不是普通文件：${filePath}`)
  }
  const bound = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : TEXT_READ_MAX_BYTES
  try {
    if (stat.size <= bound) {
      const text = await fsp.readFile(target, 'utf8')
      return ok({ path: target, text, truncated: false, size: stat.size, maxBytes: bound })
    }
    const handle = await fsp.open(target, 'r')
    try {
      const buffer = Buffer.alloc(bound)
      const read = await handle.read(buffer, 0, bound, 0)
      const text = buffer.subarray(0, read.bytesRead).toString('utf8')
      return ok({ path: target, text, truncated: true, size: stat.size, maxBytes: bound })
    } finally {
      await handle.close()
    }
  } catch (error) {
    return fail('file-unreadable', `无法读取文件：${String(error?.message ?? error)}`)
  }
}

/**
 * Create a directory (recursively) and return it.
 * @param {string} dir - absolute directory.
 * @returns {Promise<string>}
 */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Write a text file that must not already exist (`wx` open flags).
 * @param {string} filePath - absolute target file.
 * @param {string} content - UTF-8 text.
 * @returns {Promise<{ok: true, value: string}|{ok: false, code: string, message: string}>}
 */
export async function writeNewTextFile(filePath, content) {
  try {
    await ensureDir(path.dirname(filePath))
    const handle = await fsp.open(filePath, 'wx')
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return ok(filePath)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
      return fail('file-exists', `文件已存在：${filePath}`)
    }
    return fail('file-write-failed', `写入失败：${String(error?.message ?? error)}`)
  }
}

/**
 * Append one line (newline added) to a text file, creating it on demand.
 * @param {string} filePath - absolute target file.
 * @param {string} line - single line, newline appended.
 * @returns {Promise<void>}
 */
export async function appendLine(filePath, line) {
  await ensureDir(path.dirname(filePath))
  await fsp.appendFile(filePath, `${line.replace(/\r?\n/g, ' ')}\n`, 'utf8')
}

/**
 * Read a file as UTF-8 text, or undefined when it does not exist / cannot decode.
 * @param {any} filePath - absolute path.
 * @returns {Promise<string|undefined>}
 */
export async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Read and parse JSON, or undefined when missing / invalid.
 * @param {any} filePath - absolute path.
 * @returns {Promise<unknown|undefined>}
 */
export async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath)
  if (text === undefined || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Walk a directory tree and return matching file paths, tolerant of I/O errors.
 * Symlinked directories are not followed (they could escape the workspace).
 * @param {string} root - absolute directory.
 * @param {{extensions?: string[], maxDepth?: number, maxFiles?: number}} [options] - walk options.
 * @returns {Promise<string[]>}
 */
export async function listFilesRecursive(root, options = {}) {
  const extensions = Array.isArray(options.extensions) ? options.extensions : undefined
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 8
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 5000
  const output = []
  /** @param {string} dir @param {number} depth */
  const walk = async (dir, depth) => {
    if (depth > maxDepth || output.length >= maxFiles) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (output.length >= maxFiles) return
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (extensions !== undefined && !extensions.some((ext) => entry.name.toLowerCase().endsWith(ext.toLowerCase()))) {
        continue
      }
      output.push(absolute)
    }
  }
  await walk(path.resolve(root), 0)
  return output
}

/**
 * Empty cockpit state matching the client contract exactly.
 * @returns {Record<string, any>}
 */
export function createEmptyState() {
  const timestamp = nowIso()
  return {
    version: 1,
    projects: [],
    tasks: [],
    executions: [],
    deliverables: [],
    decisions: [],
    knowledge: [],
    prds: [],
    quality: { reports: [], issues: [] },
    skillUsage: {},
    solutions: [],
    meta: { createdAt: timestamp, updatedAt: timestamp, lastRevision: 0 },
  }
}

/**
 * Normalize a persisted state object: fill missing families and fix records that
 * predate a field, without inventing data. Unknown extra keys are preserved.
 * @param {unknown} raw - parsed `state.json` value.
 * @returns {Record<string, any>}
 */
export function normalizeState(raw) {
  const base = createEmptyState()
  if (!isPlainObject(raw)) return base
  const state = { ...base, ...raw }
  state.version = 1
  for (const key of ['projects', 'tasks', 'executions', 'deliverables', 'decisions', 'knowledge', 'prds', 'solutions']) {
    state[key] = arrayOf(state[key])
  }
  state.quality = normalizeQuality(state.quality)
  state.skillUsage = isPlainObject(state.skillUsage) ? state.skillUsage : {}
  state.meta = isPlainObject(state.meta) ? { ...base.meta, ...state.meta } : base.meta
  state.meta.lastRevision = clampInt(state.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0)
  state.meta.createdAt = textOf(state.meta.createdAt, base.meta.createdAt)
  state.meta.updatedAt = textOf(state.meta.updatedAt, base.meta.updatedAt)
  state.tasks = state.tasks.map(normalizeTask)
  state.executions = state.executions.map(normalizeExecution)
  state.decisions = state.decisions.map(normalizeDecision)
  state.prds = state.prds.map(normalizePrd)
  return state
}

/**
 * Normalize the quality bucket shape.
 * @param {unknown} value - raw bucket.
 * @returns {{reports: unknown[], issues: unknown[]}}
 */
function normalizeQuality(value) {
  if (!isPlainObject(value)) return { reports: [], issues: [] }
  return {
    reports: arrayOf(value.reports),
    issues: arrayOf(value.issues),
  }
}

/**
 * Normalize one task record (vocabulary violations fall back, absent fields fill).
 * @param {unknown} raw - raw task.
 * @returns {Record<string, any>}
 */
function normalizeTask(raw) {
  if (!isPlainObject(raw)) return { ...raw }
  const value = { ...raw }
  value.taskId = textOf(value.taskId, newId('T'))
  value.projectId = textOf(value.projectId)
  value.title = textOf(value.title)
  value.description = textOf(value.description)
  value.type = TASK_TYPES.includes(value.type) ? value.type : 'other'
  value.stage = TASK_STAGES.includes(value.stage) ? value.stage : '需求理解'
  value.status = TASK_STATUSES.includes(value.status) ? value.status : 'todo'
  value.priority = TASK_PRIORITIES.includes(value.priority) ? value.priority : 'P2'
  value.progress = clampInt(value.progress, 0, 100, 0)
  value.skills = stringList(value.skills)
  value.deliverables = stringList(value.deliverables)
  value.dependencies = stringList(value.dependencies)
  value.subtasks = arrayOf(value.subtasks).filter(isPlainObject)
  value.analysis = isPlainObject(value.analysis) ? value.analysis : null
  value.business = isPlainObject(value.business) ? value.business : null
  value.solution = isPlainObject(value.solution) ? value.solution : null
  value.lastExecutionAt = textOf(value.lastExecutionAt) || null
  value.error = textOf(value.error) || null
  value.createdAt = textOf(value.createdAt, nowIso())
  value.updatedAt = textOf(value.updatedAt, value.createdAt)
  return value
}

/**
 * Normalize one execution record.
 * @param {unknown} raw - raw execution.
 * @returns {Record<string, any>}
 */
function normalizeExecution(raw) {
  if (!isPlainObject(raw)) return { ...raw }
  const value = { ...raw }
  value.executionId = textOf(value.executionId, newId('EX'))
  value.status = textOf(value.status, 'sent')
  value.events = arrayOf(value.events).filter(isPlainObject).slice(-300)
  return value
}

/**
 * Normalize one decision record.
 * @param {unknown} raw - raw decision.
 * @returns {Record<string, any>}
 */
function normalizeDecision(raw) {
  if (!isPlainObject(raw)) return { ...raw }
  const value = { ...raw }
  value.modules = stringList(value.modules)
  value.links = stringList(value.links)
  value.history = arrayOf(value.history).filter(isPlainObject)
  return value
}

/**
 * Normalize one PRD record.
 * @param {unknown} raw - raw PRD.
 * @returns {Record<string, any>}
 */
function normalizePrd(raw) {
  if (!isPlainObject(raw)) return { ...raw }
  const value = { ...raw }
  value.versions = arrayOf(value.versions).filter(isPlainObject)
  value.modules = stringList(value.modules)
  return value
}

/** Per-data-root serial queues (key: data root path). */
const queues = new Map()

/** Async-local marker so a store helper may call another one without deadlock. */
const queueScope = new AsyncLocalStorage()

/**
 * Run a task with exclusive access to one data root.
 *
 * The chain guarantees one read-modify-write at a time per workspace. Calls made
 * from inside a task of the same root run inline (re-entrant), which is what lets
 * `mutateState` mutators call `appendAudit` and other helpers.
 * @template T
 * @param {string} key - queue key (the data root).
 * @param {() => Promise<T>|T} task - work to run.
 * @returns {Promise<T>}
 */
export function runExclusive(key, task) {
  if (queueScope.getStore() === key) {
    return Promise.resolve().then(task)
  }
  const previous = queues.get(key) ?? Promise.resolve()
  const settledLink = previous.then(() => queueScope.run(key, () => Promise.resolve().then(task)))
  /** The chain link callers fall behind; it never rejects so later work still runs. */
  const link = settledLink.catch(() => undefined)
  queues.set(key, link)
  link.then(() => {
    // Drop the entry once this task is the tail and nothing newer replaced it.
    if (queues.get(key) === link) queues.delete(key)
  })
  return settledLink
}

/** In-memory state cache per data root (single process, single writer). */
const stateCaches = new Map()

/**
 * Load the state of a workspace (cached after the first read).
 *
 * A missing file is an empty store, not an error. A corrupt file throws
 * `state-corrupt` so the caller reports it instead of silently wiping data.
 * Must be called from inside `runExclusive`; the public wrapper is
 * `readState`.
 * @param {string} root - data root.
 * @returns {Promise<Record<string, any>>}
 */
async function loadStateUnsafe(root) {
  const cached = stateCaches.get(root)
  if (cached !== undefined) return cached
  const file = path.join(root, STATE_FILE_NAME)
  const text = await readTextIfExists(file)
  let state
  if (text === undefined) {
    state = createEmptyState()
  } else {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new PmCopilotError('state-corrupt', `state.json 解析失败，请人工检查：${file}（${String(error?.message ?? error)}）`)
    }
    state = normalizeState(parsed)
  }
  stateCaches.set(root, state)
  return state
}

/**
 * Read the whole state through the serial queue and hand back a deep copy.
 *
 * The copy protects a reader that awaits other work (skills, kb scan) from
 * observing a concurrent writer's half-applied mutation.
 * @param {string} workspacePath - canonical workspace path.
 * @returns {Promise<Record<string, any>>}
 */
export async function readState(workspacePath) {
  const root = dataRootOf(workspacePath)
  return runExclusive(root, async () => {
    const state = await loadStateUnsafe(root)
    return structuredClone(state)
  })
}

/**
 * Atomically (in memory terms) read, mutate, and persist the state.
 *
 * The mutator receives a deep clone, so a throw leaves both the cache and the
 * file untouched. A successful mutation bumps `meta.lastRevision` and
 * `meta.updatedAt`, then writes `state.json.tmp` and renames it over the file.
 * @template T
 * @param {string} workspacePath - canonical workspace path.
 * @param {(state: Record<string, any>) => T|Promise<T>} mutator - applies the change.
 * @returns {Promise<T>}
 */
export async function mutateState(workspacePath, mutator) {
  const root = dataRootOf(workspacePath)
  return runExclusive(root, async () => {
    const current = await loadStateUnsafe(root)
    const draft = structuredClone(current)
    const result = await mutator(draft)
    const timestamp = nowIso()
    draft.meta.updatedAt = timestamp
    draft.meta.lastRevision = clampInt(draft.meta.lastRevision, 0, Number.MAX_SAFE_INTEGER, 0) + 1
    await ensureDir(root)
    const target = path.join(root, STATE_FILE_NAME)
    const temporary = `${target}.tmp`
    await fsp.writeFile(temporary, `${JSON.stringify(draft)}\n`, 'utf8')
    await fsp.rename(temporary, target)
    stateCaches.set(root, draft)
    return result
  })
}

/**
 * Append one audit entry to `audit.jsonl` (append-only, never rewritten).
 *
 * Audit failures are swallowed on purpose: a log write must never make a
 * successful cockpit operation report as failed.
 * @param {string} workspacePath - canonical workspace path.
 * @param {Record<string, unknown>} entry - audit fields (`action`, `ok`, ...).
 * @returns {Promise<void>}
 */
export async function appendAudit(workspacePath, entry) {
  try {
    const root = dataRootOf(workspacePath)
    await runExclusive(root, async () => {
      await ensureDir(root)
      await appendLine(
        path.join(root, AUDIT_FILE_NAME),
        JSON.stringify({ at: nowIso(), ...entry }),
      )
    })
  } catch {
    // Best effort by design.
  }
}

/**
 * Reset the in-memory cache for one workspace (verification / tests only).
 * @param {string} workspacePath - canonical workspace path.
 * @returns {void}
 */
export function forgetCachedState(workspacePath) {
  stateCaches.delete(dataRootOf(workspacePath))
}

/**
 * Whether a directory can be written (capability probe; never throws).
 * @param {string} dir - absolute directory.
 * @returns {boolean}
 */
export function canWriteDirectory(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}
