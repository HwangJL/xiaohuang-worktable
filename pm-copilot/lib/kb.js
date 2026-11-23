/**
 * Knowledge base (kb) reader/writer for PM Copilot.
 *
 * Reads the workspace knowledge base exactly as `kb/SCHEMA.md` describes it:
 * `kb/wiki/**\/*.md` pages (YAML frontmatter + `## 摘要`), `kb/raw/**` sources,
 * `kb/SCHEMA.md` (returned as its operation headings), and any extra roots named
 * by `.pm-copilot/roots.json`.
 *
 * Writing is append-only: `ingestKnowledge` creates a brand-new page with the
 * next free numeric id, appends one line to `kb/wiki/index.md`, and one entry to
 * `kb/wiki/log.md`. A page is never overwritten, not even a `正式` page whose
 * title collides — the conflict is reported and a new independent page is made.
 *
 * Every path this module touches is validated against the workspace root, so a
 * `../` or absolute-outside path is refused (`path-outside-workspace`).
 *
 * @module @local/dsh-pm-copilot/lib/kb
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  appendLine,
  canWriteDirectory,
  dataRootOf,
  ensureDir,
  fail,
  isPathInside,
  isPlainObject,
  listFilesRecursive,
  localDate,
  localDateTime,
  nonEmptyText,
  ok,
  readJsonIfExists,
  readTextIfExists,
  readWorkspaceText,
  resolveWorkspacePath,
  runExclusive,
  shortHash,
  slugForTitle,
  textOf,
  stringList,
  writeNewTextFile,
} from './store.js'

/** wiki page type -> directory name and id prefix, per SCHEMA §5. */
export const KB_TYPES = {
  entity: { directory: 'entities', prefix: 'E' },
  concept: { directory: 'concepts', prefix: 'C' },
  decision: { directory: 'decisions', prefix: 'D' },
  summary: { directory: 'summaries', prefix: 'S' },
  comparison: { directory: 'comparisons', prefix: 'X' },
  issue: { directory: 'issues', prefix: 'I' },
  question: { directory: 'questions', prefix: 'Q' },
}

/** Knowledge page status vocabulary, per SCHEMA §6. */
export const KB_STATUSES = ['正式', '待确认', '历史']

/** Frontmatter fields that every page must carry (SCHEMA §6: required first 8). */
export const KB_REQUIRED_FIELDS = ['title', 'id', 'type', 'project', 'status', 'scope', 'sources', 'tags']

/** Byte bound for one page/source read, matching the cockpit file policy. */
const KB_READ_MAX_BYTES = 512 * 1024

/** Absolute `kb/` directory of a validated workspace. */
export function kbRootOf(workspacePath) {
  return path.join(workspacePath, 'kb')
}

/**
 * Parse a YAML frontmatter block with the tiny subset SCHEMA uses.
 *
 * Supported: `key: value` scalars, inline lists `key: [a, b]`, block lists
 * (`key:` followed by `- item` lines), quoted strings, `null`, `true`/`false`.
 * Everything else is ignored rather than guessed.
 * @param {string} text - full markdown file text.
 * @returns {{data: Record<string, any>, body: string}}
 */
export function parseFrontmatter(text) {
  const source = textOf(text).replace(/^\uFEFF/, '')
  if (source.startsWith('---')) {
    const lines = source.split(/\r?\n/)
    if (lines[0].trim() === '---') {
      let close = -1
      for (let index = 1; index < lines.length; index += 1) {
        if (lines[index].trim() === '---') {
          close = index
          break
        }
      }
      if (close !== -1) {
        const data = parseFrontmatterLines(lines.slice(1, close))
        const body = lines.slice(close + 1).join('\n').replace(/^\r?\n+/, '')
        return { data, body }
      }
    }
  }
  return { data: {}, body: source }
}

/**
 * Parse the YAML lines of one frontmatter block.
 * @param {string[]} lines - lines between the `---` fences.
 * @returns {Record<string, any>}
 */
function parseFrontmatterLines(lines) {
  const data = {}
  let currentKey
  /** Keys still waiting to learn whether a block list follows. */
  const pending = new Set()
  for (const line of lines) {
    if (line.trim() === '') continue
    const listItem = /^(?:\s{2,}|\s*)-(?:\s+)?(.+)$/.exec(line)
    if (listItem !== null && currentKey !== undefined) {
      const value = scalarValue(listItem[1])
      if (!Array.isArray(data[currentKey])) data[currentKey] = []
      data[currentKey].push(value)
      pending.delete(currentKey)
      continue
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (pair === null) continue
    const key = pair[1]
    const rest = pair[2].trim()
    currentKey = key
    if (rest === '') {
      // Either a block list follows or the value is empty; resolve after the loop.
      data[key] = ''
      pending.add(key)
      continue
    }
    pending.delete(key)
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]$/, '')
      data[key] = inner
        .split(',')
        .map((item) => scalarValue(item.trim()))
        .filter((item) => item !== null && item !== '')
      continue
    }
    data[key] = scalarValue(rest)
  }
  for (const key of pending) {
    if (data[key] === '') data[key] = null
  }
  return data
}

/**
 * Decode one YAML scalar from the documented subset.
 * @param {string} raw - raw scalar text.
 * @returns {string|boolean|null}
 */
function scalarValue(raw) {
  let value = textOf(raw).trim()
  if (value === '') return ''
  if (/^null$/i.test(value) || value === '~') return null
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  const quoted = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value)
  if (quoted !== null) {
    value = quoted[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
    return value
  }
  return value
}

/**
 * Encode one YAML scalar for a generated page, quoting only when required.
 * @param {string|null} value - scalar value.
 * @returns {string}
 */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  const text = String(value)
  if (text === '') return '""'
  if (/[:#[\]{}&*!|>'"%@`]/.test(text) || /^[-\s]/.test(text) || /\s$/.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  return text
}

/**
 * Encode one inline YAML list.
 * @param {string[]} values - list values.
 * @returns {string}
 */
function yamlInlineList(values) {
  if (!Array.isArray(values) || values.length === 0) return '[]'
  return `[${values.map((value) => yamlScalar(value)).join(', ')}]`
}

/**
 * Extract the `## 摘要` section body (empty string when absent).
 * @param {string} body - page body without frontmatter.
 * @returns {string}
 */
export function summarySection(body) {
  const lines = textOf(body).split(/\r?\n/)
  const output = []
  let capturing = false
  for (const line of lines) {
    if (/^##\s+摘要\s*$/.test(line.trim())) {
      capturing = true
      continue
    }
    if (capturing) {
      if (/^##\s+/.test(line.trim())) break
      output.push(line)
    }
  }
  return output.join('\n').trim()
}

/**
 * Honest page snippet: the `## 摘要` section, else the first 400 characters of
 * the body (headings stripped, because a heading is not a summary).
 * @param {string} body - page body without frontmatter.
 * @returns {string}
 */
export function pageSnippet(body) {
  const summary = summarySection(body)
  if (summary !== '') return summary
  const plain = textOf(body).replace(/^#{1,6}\s+.*$/gm, '').trim()
  return plain.slice(0, 400)
}

/**
 * Derive the page type from the wiki directory a file lives in.
 * @param {string} absolutePath - page file path.
 * @returns {string|undefined}
 */
function typeFromDirectory(absolutePath) {
  const directory = path.basename(path.dirname(absolutePath))
  for (const [type, value] of Object.entries(KB_TYPES)) {
    if (value.directory === directory) return type
  }
  return undefined
}

/**
 * Derive the page id from a file name (`E-0001-slug.md`) when frontmatter is missing.
 * @param {string} absolutePath - page file path.
 * @returns {string|undefined}
 */
function idFromFileName(absolutePath) {
  const base = path.basename(absolutePath, path.extname(absolutePath))
  const match = /^(E|C|D|S|X|I|Q)-\d{4}/.exec(base)
  return match === null ? undefined : match[0]
}

/**
 * Scan one wiki page into a knowledge item.
 *
 * Internal items carry `frontmatter` and `body` (full text) so search and quality
 * checks can score/reference the real content; `publicKnowledgeItem` strips them
 * before a response reaches the browser.
 * @param {string} workspacePath - canonical workspace path.
 * @param {string} absolutePath - absolute page path.
 * @returns {Promise<Record<string, any>|undefined>}
 */
async function scanWikiPage(workspacePath, absolutePath) {
  const read = await readWorkspaceText(workspacePath, absolutePath, KB_READ_MAX_BYTES)
  if (!read.ok) return undefined
  let updatedAt = ''
  try {
    const stat = await fsp.stat(absolutePath)
    updatedAt = stat.mtime.toISOString()
  } catch {
    updatedAt = ''
  }
  const parsed = parseFrontmatter(read.value.text)
  const frontmatter = parsed.data
  const body = parsed.body
  const title = nonEmptyText(frontmatter.title)
    ?? firstHeading(body)
    ?? path.basename(absolutePath, path.extname(absolutePath))
  return {
    kind: 'wiki',
    id: nonEmptyText(frontmatter.id) ?? idFromFileName(absolutePath),
    title,
    type: nonEmptyText(frontmatter.type) ?? typeFromDirectory(absolutePath),
    project: frontmatter.project === null || frontmatter.project === undefined ? undefined : textOf(frontmatter.project),
    status: nonEmptyText(frontmatter.status),
    confirmed: frontmatter.confirmed === null || frontmatter.confirmed === undefined ? null : textOf(frontmatter.confirmed),
    scope: nonEmptyText(frontmatter.scope),
    sources: stringList(frontmatter.sources).length > 0
      ? stringList(frontmatter.sources)
      : (typeof frontmatter.sources === 'string' && frontmatter.sources !== '' ? [frontmatter.sources] : []),
    tags: stringList(frontmatter.tags).length > 0
      ? stringList(frontmatter.tags)
      : (typeof frontmatter.tags === 'string' && frontmatter.tags !== '' ? [frontmatter.tags] : []),
    path: absolutePath,
    snippet: pageSnippet(body),
    updatedAt: nonEmptyText(frontmatter.updated) ?? updatedAt,
    body,
    frontmatter,
    truncated: read.value.truncated,
  }
}

/**
 * First ATX heading of a markdown body.
 * @param {string} body - markdown body.
 * @returns {string|undefined}
 */
function firstHeading(body) {
  const match = /^#\s+(.+)$/m.exec(textOf(body))
  return match === null ? undefined : match[1].trim()
}

/**
 * Strip internal-only fields from a knowledge item before returning it to a client.
 * @param {Record<string, any>} item - internal item.
 * @returns {Record<string, any>}
 */
export function publicKnowledgeItem(item) {
  const output = {
    kind: item.kind,
    title: item.title,
    path: item.path,
    updatedAt: item.updatedAt,
  }
  if (item.id !== undefined) output.id = item.id
  if (item.type !== undefined) output.type = item.type
  if (item.project !== undefined) output.project = item.project
  if (item.status !== undefined) output.status = item.status
  if (item.confirmed !== undefined && item.confirmed !== null) output.confirmed = item.confirmed
  if (item.scope !== undefined) output.scope = item.scope
  if (item.snippet !== undefined) output.snippet = item.snippet
  if (Array.isArray(item.tags) && item.tags.length > 0) output.tags = item.tags
  if (Array.isArray(item.sources) && item.sources.length > 0) output.sources = item.sources
  if (typeof item.size === 'number') output.size = item.size
  if (Array.isArray(item.headings)) output.headings = item.headings
  if (typeof item.relevance === 'number') output.relevance = item.relevance
  return output
}

/**
 * Read the extra knowledge roots declared by `.pm-copilot/roots.json`.
 * @param {string} workspacePath - canonical workspace path.
 * @returns {Promise<{roots: Array<{root: string, path: string}>, rootsFile: string, rootsFileExists: boolean, invalid: string[]}>}
 */
export async function listKnowledgeRoots(workspacePath) {
  const rootFile = path.join(dataRootOf(workspacePath), 'roots.json')
  const raw = await readJsonIfExists(rootFile)
  const declared = isPlainObject(raw) && Array.isArray(raw.roots) ? raw.roots : []
  const roots = []
  const invalid = []
  for (const entry of declared) {
    const relative = nonEmptyText(entry)
    if (relative === undefined) {
      invalid.push(String(entry))
      continue
    }
    const resolved = resolveWorkspacePath(workspacePath, relative)
    if (!resolved.ok) {
      invalid.push(relative)
      continue
    }
    let stat
    try {
      stat = await fsp.stat(resolved.value)
    } catch {
      stat = undefined
    }
    if (stat === undefined || !stat.isDirectory()) {
      invalid.push(relative)
      continue
    }
    roots.push({ root: relative, path: resolved.value })
  }
  return {
    roots,
    rootsFile: rootFile,
    rootsFileExists: await fileExists(rootFile),
    invalid,
  }
}

/**
 * Check file existence without throwing.
 * @param {string} filePath - absolute path.
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * Scan the whole knowledge base of a workspace.
 *
 * Never throws: an unreadable subtree degrades to being absent, which keeps the
 * cockpit snapshot honest ("no page found") instead of failing the request.
 * @param {string} workspacePath - canonical workspace path.
 * @returns {Promise<{items: Array<Record<string, any>>, stats: Record<string, any>, roots: Array<{root: string, path: string}>}>}
 */
export async function scanKnowledgeBase(workspacePath) {
  const kbRoot = kbRootOf(workspacePath)
  const wikiDir = path.join(kbRoot, 'wiki')
  const rawDir = path.join(kbRoot, 'raw')
  const templatesDir = path.join(kbRoot, 'templates')
  const indexFile = path.join(wikiDir, 'index.md')
  const logFile = path.join(wikiDir, 'log.md')
  const schemaFile = path.join(kbRoot, 'SCHEMA.md')

  const items = []
  let wikiCount = 0

  const wikiFiles = await listFilesRecursive(wikiDir, { extensions: ['.md'] })
  for (const file of wikiFiles) {
    const base = path.basename(file).toLowerCase()
    if (base === 'index.md' || base === 'log.md') continue
    const item = await scanWikiPage(workspacePath, file)
    if (item === undefined) continue
    wikiCount += 1
    items.push(item)
  }

  const rawFiles = await listFilesRecursive(rawDir)
  for (const file of rawFiles) {
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      continue
    }
    items.push({
      kind: 'raw',
      type: 'raw',
      title: path.basename(file),
      path: file,
      updatedAt: stat.mtime.toISOString(),
      size: stat.size,
    })
  }

  let schemaItem
  if (await fileExists(schemaFile)) {
    const schemaText = textOf(await readTextIfExists(schemaFile))
    const headings = schemaText
      .split(/\r?\n/)
      .map((line) => /^##\s+(.+)$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => match[1].trim())
    schemaItem = {
      kind: 'schema',
      type: 'schema',
      title: '知识库操作手册',
      path: schemaFile,
      headings,
      snippet: schemaText.replace(/^#{1,6}\s+.*$/gm, '').trim().slice(0, 400),
      updatedAt: '',
    }
    items.push(schemaItem)
  }

  const rootsInfo = await listKnowledgeRoots(workspacePath)
  for (const root of rootsInfo.roots) {
    const files = await listFilesRecursive(root.path, { extensions: ['.md'] })
    for (const file of files) {
      const read = await readWorkspaceText(workspacePath, file, KB_READ_MAX_BYTES)
      if (!read.ok) continue
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        stat = undefined
      }
      const parsed = parseFrontmatter(read.value.text)
      items.push({
        kind: 'root',
        type: 'doc',
        root: root.root,
        title: nonEmptyText(parsed.data.title) ?? firstHeading(parsed.body) ?? path.basename(file, path.extname(file)),
        path: file,
        updatedAt: nonEmptyText(parsed.data.updated) ?? (stat === undefined ? '' : stat.mtime.toISOString()),
        snippet: pageSnippet(parsed.body),
        body: parsed.body,
        frontmatter: parsed.data,
        truncated: read.value.truncated,
      })
    }
  }

  const templateFiles = await listFilesRecursive(templatesDir, { extensions: ['.md'] })
  const stats = {
    wikiCount,
    rawCount: rawFiles.length,
    schemaPresent: await fileExists(schemaFile),
    indexPresent: await fileExists(indexFile),
    logPresent: await fileExists(logFile),
    templateCount: templateFiles.length,
  }
  return { items, stats, roots: rootsInfo.roots }
}

/**
 * Case-insensitive "haystack contains needle".
 * @param {unknown} haystack - candidate text/list.
 * @param {string} needle - lower-cased query.
 * @returns {boolean}
 */
function includesNeedle(haystack, needle) {
  if (haystack === undefined || haystack === null) return false
  const text = Array.isArray(haystack) ? haystack.join(' ') : String(haystack)
  return text.toLowerCase().includes(needle)
}

/**
 * Score one knowledge item against a lower-cased query.
 * Title hit 3, id/tags hit 2, snippet hit 1, body hit 1 (SCHEMA-aware search).
 * @param {Record<string, any>} item - internal knowledge item.
 * @param {string} needle - lower-cased query.
 * @returns {number}
 */
function relevanceOf(item, needle) {
  let score = 0
  if (includesNeedle(item.title, needle)) score += 3
  if (includesNeedle(item.id, needle) || includesNeedle(item.tags, needle)) score += 2
  if (includesNeedle(item.snippet, needle)) score += 1
  if (includesNeedle(item.body, needle)) score += 1
  return score
}

/**
 * Search the knowledge base: keyword scoring plus project/type/status filters.
 * @param {string} workspacePath - canonical workspace path.
 * @param {{query?: string, project?: string, type?: string, status?: string, limit?: number}} [request] - search request.
 * @returns {Promise<{ok: true, value: {items: Array<Record<string, any>>, total: number}}>}
 */
export async function searchKnowledge(workspacePath, request = {}) {
  const scan = await scanKnowledgeBase(workspacePath)
  const query = nonEmptyText(request.query)?.toLowerCase()
  const project = nonEmptyText(request.project)
  const type = nonEmptyText(request.type)
  const status = nonEmptyText(request.status)
  const limit = Number.isFinite(request.limit)
    ? Math.max(1, Math.min(100, Math.trunc(request.limit)))
    : 20

  const rows = []
  for (const item of scan.items) {
    if (project !== undefined && item.project !== project) continue
    if (type !== undefined && item.type !== type) continue
    if (status !== undefined && item.status !== status) continue
    const relevance = query === undefined || query === '' ? 0 : relevanceOf(item, query)
    if (query !== undefined && query !== '' && relevance === 0) continue
    rows.push({ item, relevance })
  }
  rows.sort((left, right) => {
    if (right.relevance !== left.relevance) return right.relevance - left.relevance
    return String(right.item.updatedAt ?? '').localeCompare(String(left.item.updatedAt ?? ''))
  })
  const items = rows.slice(0, limit).map((row) => ({ ...publicKnowledgeItem(row.item), relevance: row.relevance }))
  return ok({ items, total: rows.length, query: request.query ?? '', limit })
}

/**
 * Read one knowledge/deliverable text file through the workspace-bounded reader.
 * @param {string} workspacePath - canonical workspace path.
 * @param {unknown} filePath - absolute or workspace-relative path.
 * @param {number} [maxBytes] - byte bound.
 * @returns {Promise<{ok: true, value: Record<string, any>}|{ok: false, code: string, message: string}>}
 */
export async function readKnowledgeFile(workspacePath, filePath, maxBytes) {
  return readWorkspaceText(workspacePath, filePath, maxBytes)
}

/**
 * Allocate the next free numeric knowledge id in a type directory.
 * @param {string} directory - absolute wiki type directory.
 * @param {string} prefix - id prefix (`E`, `C`, ...).
 * @returns {Promise<string>} `<prefix>-NNNN`.
 */
async function nextKnowledgeId(directory, prefix) {
  let files = []
  try {
    files = await fsp.readdir(directory)
  } catch {
    files = []
  }
  const pattern = new RegExp(`^${prefix}-(\\d{4})-`)
  let max = 0
  for (const file of files) {
    const match = pattern.exec(file)
    if (match === null) continue
    const number = Number(match[1])
    if (number > max) max = number
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

/**
 * Render one knowledge page markdown (frontmatter + SCHEMA §6 sections).
 * @param {Record<string, any>} page - page fields.
 * @returns {string}
 */
function renderKnowledgePage(page) {
  const sources = page.sources.length > 0 ? page.sources : ['(推断)']
  const lines = [
    '---',
    `title: ${yamlScalar(page.title)}`,
    `id: ${page.id}`,
    `type: ${page.type}`,
    `project: ${yamlScalar(page.project)}`,
    `status: ${page.status}`,
    `confirmed: ${page.confirmed === null ? 'null' : yamlScalar(page.confirmed)}`,
    `scope: ${yamlScalar(page.scope)}`,
    'sources:',
    ...sources.map((source) => `  - ${yamlScalar(source)}`),
    `tags: ${yamlInlineList(page.tags)}`,
    `created: ${page.created}`,
    `updated: ${page.updated}`,
    '---',
    '',
    '## 摘要',
    page.summary === '' ? '（未提供摘要）' : page.summary,
    '',
    '## 正文',
    page.body === '' ? '（未提供正文）' : page.body,
    '',
    '## 关联',
    '- 无',
    '',
    '## 冲突/存疑',
    '无',
    '',
    '## 变更记录',
    `- ${page.created} 建页（来源：${sources.join('、')}）`,
    '',
  ]
  return lines.join('\n')
}

/**
 * Append one page row to `kb/wiki/index.md`, creating the file with its heading
 * when absent.
 * @param {string} workspacePath - canonical workspace path.
 * @param {Record<string, any>} page - written page.
 * @returns {Promise<void>}
 */
async function appendKnowledgeIndex(workspacePath, page) {
  const wikiDir = path.join(kbRootOf(workspacePath), 'wiki')
  const indexFile = path.join(wikiDir, 'index.md')
  await ensureDir(wikiDir)
  if (!(await fileExists(indexFile))) {
    const created = await writeNewTextFile(indexFile, '# 知识库索引\n')
    if (!created.ok && created.code !== 'file-exists') throw new Error(created.message)
  }
  const summary = page.summary.replace(/\s+/g, ' ').slice(0, 60)
  await appendLine(
    indexFile,
    `- [${page.id}] ${page.title} · ${page.type} · ${page.status} · ${page.project} — ${summary}`,
  )
}

/**
 * Append one ingest entry to `kb/wiki/log.md`.
 * @param {string} workspacePath - canonical workspace path.
 * @param {Record<string, any>} page - written page.
 * @param {string|undefined} conflict - reported conflict, if any.
 * @returns {Promise<void>}
 */
async function appendKnowledgeLog(workspacePath, page, conflict) {
  const logFile = path.join(kbRootOf(workspacePath), 'wiki', 'log.md')
  await ensureDir(path.dirname(logFile))
  await appendLine(logFile, `## [${localDateTime()}] ingest | ${page.title}`)
  await appendLine(
    logFile,
    `- 新建 ${page.id}（${page.type} / ${page.status} / ${page.project}）${conflict === undefined ? '' : `；${conflict}`}`,
  )
}

/**
 * Ingest one new knowledge page (append-only).
 *
 * @param {string} workspacePath - canonical workspace path.
 * @param {{
 *   title?: string, type?: string, project?: string, summary?: string,
 *   body?: string, sources?: string[], tags?: string[], status?: string,
 *   scope?: string, forcedId?: string
 * }} input - page request. `forcedId` lets a cockpit decision page reuse its
 *   `D-NNNN` decision id so both surfaces speak one id space.
 * @returns {Promise<{ok: true, value: Record<string, any>}|{ok: false, code: string, message: string}>}
 */
export async function ingestKnowledge(workspacePath, input = {}) {
  const title = nonEmptyText(input.title)
  if (title === undefined) return fail('payload-invalid', 'title 必须是非空字符串')
  const type = nonEmptyText(input.type)
  if (type === undefined || !Object.hasOwn(KB_TYPES, type)) {
    return fail('payload-invalid', `type 必须是 ${Object.keys(KB_TYPES).join(' / ')} 之一`)
  }
  const project = nonEmptyText(input.project) ?? 'kb'
  const status = KB_STATUSES.includes(input.status) ? input.status : '待确认'
  const summary = textOf(input.summary).trim()
  const body = textOf(input.body).trim()
  const sources = stringList(input.sources)
  const tags = stringList(input.tags)
  const scope = nonEmptyText(input.scope) ?? `${project} 范围内有效`
  const typeInfo = KB_TYPES[type]
  const root = dataRootOf(workspacePath)

  return runExclusive(root, async () => {
    const kbRoot = kbRootOf(workspacePath)
    if (!canWriteDirectory(workspacePath)) {
      return fail('knowledge-write-unavailable', `工作区不可写：${workspacePath}`)
    }
    const directory = path.join(kbRoot, 'wiki', typeInfo.directory)
    await ensureDir(directory)

    // Conflict detection: a `正式` page of the same title/type already exists.
    const scan = await scanKnowledgeBase(workspacePath)
    const conflictSource = scan.items.find(
      (item) => item.kind === 'wiki' && item.type === type && item.status === '正式' && item.title === title,
    )
    const conflict = conflictSource === undefined ? undefined : '正式页已存在，已新建独立页面'

    let id = nonEmptyText(input.forcedId)
    let created = null
    if (id !== undefined) {
      // A forced id (a cockpit decision reusing its D-NNNN) must never overwrite
      // an existing page, even when its slug differs.
      let existing = []
      try {
        existing = await fsp.readdir(directory)
      } catch {
        existing = []
      }
      const prefixPattern = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-`)
      if (existing.some((file) => prefixPattern.test(file))) {
        return fail('file-exists', `知识页已存在：${path.join(directory, `${id}-*.md`)}`)
      }
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (id === undefined) id = await nextKnowledgeId(directory, typeInfo.prefix)
      const slug = slugForTitle(title)
      const file = path.join(directory, `${id}-${slug}.md`)
      const page = {
        id,
        title,
        type,
        project,
        status,
        confirmed: status === '正式' ? localDate() : null,
        scope,
        sources,
        tags,
        created: localDate(),
        updated: localDate(),
        summary,
        body,
      }
      const written = await writeNewTextFile(file, renderKnowledgePage(page))
      if (written.ok) {
        created = { ...page, path: file }
        break
      }
      if (written.code === 'file-exists' && nonEmptyText(input.forcedId) !== undefined) {
        return fail('file-exists', `知识页已存在：${file}`)
      }
      // Numeric id race or slug collision: advance the id and retry.
      id = undefined
    }
    if (created === null) {
      return fail('knowledge-write-failed', '无法分配新的知识页 ID（重试次数已用尽）')
    }

    await appendKnowledgeIndex(workspacePath, created)
    await appendKnowledgeLog(workspacePath, created, conflict)
    const result = {
      kind: 'wiki',
      id: created.id,
      entryId: created.id,
      title: created.title,
      type: created.type,
      project: created.project,
      status: created.status,
      path: created.path,
      scope: created.scope,
      summary,
      sources,
      tags,
      createdAt: created.created,
    }
    if (conflict !== undefined) result.conflict = conflict
    return ok(result)
  })
}

/**
 * Public knowledge capability descriptor used by snapshots.
 * @param {string} workspacePath - canonical workspace path.
 * @returns {Promise<{readable: boolean, writable: boolean}>}
 */
export async function knowledgeCapability(workspacePath) {
  return {
    // The workspace itself was already validated as an existing directory by
    // resolveWorkspace; readability of the kb subtree degrades per file.
    readable: true,
    writable: canWriteDirectory(workspacePath),
  }
}

/**
 * Hash helper re-exported for deterministic file-name generation in callers.
 * @param {string} value - input text.
 * @returns {string}
 */
export function knowledgeShortHash(value) {
  return shortHash(value, 8)
}

/**
 * Whether a path is contained by a workspace (exposed for HTTP/knowledge.read
 * callers that need the same fence as the store).
 * @param {string} workspacePath - canonical workspace path.
 * @param {string} targetPath - absolute candidate path.
 * @returns {boolean}
 */
export function pathIsInsideWorkspace(workspacePath, targetPath) {
  return isPathInside(workspacePath, path.resolve(targetPath))
}
