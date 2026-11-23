/**
 * Deterministic quality inspection for PM Copilot.
 *
 * Everything here is computed from the real cockpit state, the real PRD version
 * files, and the real `kb/wiki` pages. Nothing is invented: a check that has no
 * evidence produces no issue, and an empty cockpit produces an empty report.
 *
 * Seven dimensions are checked (requirement completeness, process completeness,
 * rule completeness, architecture consistency, data consistency, document
 * consistency, knowledge base hygiene). Reports are appended to
 * `state.quality.reports` and also written to `quality/<stamp>-<reportId>.json`;
 * issues go to `state.quality.issues`. A previously open issue with the same
 * target + dimension + title is marked `stale` before the new one is added, so
 * repeated checks do not pile up.
 *
 * @module @local/dsh-pm-copilot/lib/quality
 */

import path from 'node:path'

import { scanKnowledgeBase, KB_REQUIRED_FIELDS } from './kb.js'
import {
  PmCopilotError,
  appendAudit,
  arrayOf,
  dataRootOf,
  fail,
  isPlainObject,
  localDateTime,
  mutateState,
  newId,
  nonEmptyText,
  nowIso,
  ok,
  readState,
  readWorkspaceText,
  textOf,
  writeNewTextFile,
} from './store.js'

/** Dimension labels used on issues. */
export const QUALITY_DIMENSIONS = {
  requirement: '需求完整性',
  process: '流程完整性',
  rule: '规则完整性',
  architecture: '架构一致性',
  data: '数据一致性',
  document: '文档一致性',
  knowledge: '知识库',
}

/** Severity vocabulary. */
export const QUALITY_SEVERITIES = ['blocker', 'major', 'minor']

/** A decision reference in a document, per the contract regex. */
const DECISION_REFERENCE_PATTERN = /D-\d{4}/g

/** Report cap kept in state (newest kept). */
const REPORTS_MAX = 500

/** Issue cap kept in state (newest kept). */
const ISSUES_MAX = 2000

/**
 * Whether a value carries no information (missing / empty string / empty list or map / null).
 * @param {unknown} value - candidate.
 * @returns {boolean}
 */
function isEmptyValue(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/**
 * Build one issue draft.
 * @param {string} dimension - dimension label.
 * @param {'blocker'|'major'|'minor'} severity - severity.
 * @param {string} title - short title.
 * @param {string} detail - evidence-based explanation.
 * @param {string} targetPath - record pointer (`task:<id>`) or file path.
 * @param {string[]} [docRefs] - related ids/paths.
 * @param {string} [suggestion] - declared fix.
 * @returns {{dimension: string, severity: string, title: string, detail: string, targetPath: string, docRefs: string[], suggestion: string}}
 */
function draft(dimension, severity, title, detail, targetPath, docRefs = [], suggestion = '') {
  return { dimension, severity, title, detail, targetPath, docRefs, suggestion }
}

/**
 * Requirement completeness: description, analysis presence, completeness payload.
 * @param {Array<Record<string, any>>} tasks - selected tasks.
 * @returns {Array<Record<string, any>>} issue drafts.
 */
function checkRequirement(tasks) {
  const issues = []
  for (const task of tasks) {
    if (textOf(task.description).trim() === '') {
      issues.push(draft(
        QUALITY_DIMENSIONS.requirement,
        'major',
        '任务缺少需求描述',
        `任务「${textOf(task.title)}」未填写需求描述，需求理解缺少输入。`,
        `task:${textOf(task.taskId)}`,
        [textOf(task.taskId)],
        '补充需求背景、目标、范围与验收口径。',
      ))
    }
    const analysis = isPlainObject(task.analysis) ? task.analysis : undefined
    if (analysis === undefined) {
      issues.push(draft(
        QUALITY_DIMENSIONS.requirement,
        'minor',
        '尚未完成需求分析',
        `任务「${textOf(task.title)}」还没有需求分析记录。`,
        `task:${textOf(task.taskId)}`,
        [textOf(task.taskId)],
        '让 Agent 执行需求理解并把 analysis 写回驾驶舱。',
      ))
      continue
    }
    const completeness = isPlainObject(analysis.completeness) ? analysis.completeness : undefined
    if (completeness === undefined) {
      issues.push(draft(
        QUALITY_DIMENSIONS.requirement,
        'minor',
        '需求分析缺少完整度信息',
        `任务「${textOf(task.title)}」的 analysis.completeness 缺失。`,
        `task:${textOf(task.taskId)}`,
        [textOf(task.taskId)],
        '补写 knownKnown / retrieved / assumptions / toConfirm / risks。',
      ))
      continue
    }
    const emptiness = [
      ['knownKnown', completeness.knownKnown],
      ['retrieved', completeness.retrieved],
      ['assumptions', completeness.assumptions],
      ['toConfirm', completeness.toConfirm],
      ['risks', completeness.risks],
    ]
    if (emptiness.every(([, value]) => isEmptyValue(value))) {
      issues.push(draft(
        QUALITY_DIMENSIONS.requirement,
        'minor',
        '需求分析完整度信息为空',
        `任务「${textOf(task.title)}」的完整度五项均为空，需求分析没有留下可核查的结构化结论。`,
        `task:${textOf(task.taskId)}`,
        [textOf(task.taskId)],
        '按需求理解结论填写完整度五项。',
      ))
    }
  }
  return issues
}

/**
 * Process completeness: edges and exception branches.
 * @param {Array<Record<string, any>>} tasks - selected tasks.
 * @returns {Array<Record<string, any>>} issue drafts.
 */
function checkProcess(tasks) {
  const issues = []
  for (const task of tasks) {
    const business = isPlainObject(task.business) ? task.business : undefined
    if (business === undefined) continue
    const process = isPlainObject(business.process) ? business.process : undefined
    const nodes = arrayOf(process?.nodes).filter(isPlainObject)
    if (nodes.length === 0) continue
    const edges = arrayOf(process?.edges).filter(isPlainObject)
    if (edges.length === 0) {
      issues.push(draft(
        QUALITY_DIMENSIONS.process,
        'major',
        '业务流程缺少连线',
        `任务「${textOf(task.title)}」的流程有 ${nodes.length} 个节点，但没有任何 edges，流程无法闭环。`,
        `task:${textOf(task.taskId)}`,
        [textOf(task.taskId)],
        '补齐节点之间的 edges（from / to / label）。',
      ))
    }
    if (!nodes.some((node) => textOf(node.kind) === 'exception')) {
      issues.push(draft(
        QUALITY_DIMENSIONS.process,
        'major',
        '业务流程缺少异常分支',
        `任务「${textOf(task.title)}」的流程没有任何 kind=exception 的节点，异常路径未定义。`,
        `task:${textOf(task.taskId)}`,
        [textOf(task.taskId)],
        '补一个异常分支节点并连接到主流程。',
      ))
    }
  }
  return issues
}

/**
 * Rule completeness: rules present, no placeholders or duplicates.
 * @param {Array<Record<string, any>>} tasks - selected tasks.
 * @returns {Array<Record<string, any>>} issue drafts.
 */
function checkRules(tasks) {
  const issues = []
  for (const task of tasks) {
    const business = isPlainObject(task.business) ? task.business : undefined
    if (business === undefined) continue
    const nodes = arrayOf(isPlainObject(business.process) ? business.process.nodes : undefined).filter(isPlainObject)
    const rules = arrayOf(business.rules).filter(isPlainObject)
    if (nodes.length > 0 && rules.length === 0) {
      issues.push(draft(
        QUALITY_DIMENSIONS.rule,
        'major',
        '业务规则缺失',
        `任务「${textOf(task.title)}」已有 ${nodes.length} 个流程节点，但 business.rules 为空。`,
        `task:${textOf(task.taskId)}`,
        [textOf(task.taskId)],
        '按流程节点梳理业务规则并写回 business.rules。',
      ))
    }
    const targetPath = `task:${textOf(task.taskId)}`
    const seen = new Map()
    for (const rule of rules) {
      const text = textOf(rule.text).trim()
      if (text === '') {
        issues.push(draft(
          QUALITY_DIMENSIONS.rule,
          'minor',
          '业务规则缺少文本',
          `任务「${textOf(task.title)}」有一条规则没有 text 内容。`,
          targetPath,
          [textOf(task.taskId)],
          '为每条规则写清规则文本与来源。',
        ))
        continue
      }
      if (/待定|TBD/i.test(text)) {
        issues.push(draft(
          QUALITY_DIMENSIONS.rule,
          'minor',
          '业务规则存在待定内容',
          `任务「${textOf(task.title)}」的规则含“待定/TBD”：${text}`,
          targetPath,
          [textOf(task.taskId)],
          '向业务方确认后替换掉占位表述。',
        ))
      }
      const normalized = text.toLowerCase().replace(/\s+/g, '').replace(/[。，、；：,.;:]/g, '')
      const previous = seen.get(normalized)
      if (previous === undefined) {
        seen.set(normalized, text)
      } else {
        issues.push(draft(
          QUALITY_DIMENSIONS.rule,
          'minor',
          '业务规则重复',
          `任务「${textOf(task.title)}」中规则「${text}」重复出现（与「${previous}」相同）。`,
          targetPath,
          [textOf(task.taskId)],
          '合并重复规则，保留一条。',
        ))
      }
    }
  }
  return issues
}

/**
 * Architecture consistency: boundary responsibilities present and distinct.
 * @param {Array<Record<string, any>>} tasks - selected tasks.
 * @returns {Array<Record<string, any>>} issue drafts.
 */
function checkArchitecture(tasks) {
  const issues = []
  for (const task of tasks) {
    const business = isPlainObject(task.business) ? task.business : undefined
    if (business === undefined) continue
    const boundary = arrayOf(business.boundary).filter(isPlainObject)
    if (boundary.length === 0) continue
    const targetPath = `task:${textOf(task.taskId)}`
    const seenResponsibilities = new Map()
    for (const entry of boundary) {
      const system = textOf(entry.system).trim() || '(未命名系统)'
      const responsibility = textOf(entry.responsibility).trim()
      if (responsibility === '') {
        issues.push(draft(
          QUALITY_DIMENSIONS.architecture,
          'major',
          '系统职责缺失',
          `任务「${textOf(task.title)}」的边界中「${system}」没有 responsibility。`,
          targetPath,
          [textOf(task.taskId)],
          '写明该系统承担的职责与数据归属。',
        ))
        continue
      }
      const previous = seenResponsibilities.get(responsibility)
      if (previous !== undefined) {
        issues.push(draft(
          QUALITY_DIMENSIONS.architecture,
          'major',
          '系统职责重复',
          `任务「${textOf(task.title)}」的「${previous}」与「${system}」职责文本完全相同：${responsibility}`,
          targetPath,
          [textOf(task.taskId)],
          '拆清两个系统的职责边界。',
        ))
      } else {
        seenResponsibilities.set(responsibility, system)
      }
    }
  }
  return issues
}

/**
 * Data consistency: data model presence and duplicate field names.
 * @param {Array<Record<string, any>>} tasks - selected tasks.
 * @returns {Array<Record<string, any>>} issue drafts.
 */
function checkData(tasks) {
  const issues = []
  for (const task of tasks) {
    const business = isPlainObject(task.business) ? task.business : undefined
    const solution = isPlainObject(task.solution) ? task.solution : undefined
    if (business === undefined) continue
    const objects = arrayOf(business.objects)
    if (objects.length === 0) continue
    const targetPath = `task:${textOf(task.taskId)}`
    if (isEmptyValue(solution?.dataModel)) {
      issues.push(draft(
        QUALITY_DIMENSIONS.data,
        'minor',
        '缺少数据模型',
        `任务「${textOf(task.title)}」有 ${objects.length} 个业务对象，但解决方案还没有 dataModel。`,
        targetPath,
        [textOf(task.taskId)],
        '在 solution.dataModel 中给出对象与字段定义。',
      ))
    }
    for (const object of objects) {
      const name = textOf(isPlainObject(object) ? object.name ?? object.objectName : object).trim()
      if (!isPlainObject(object)) continue
      const fields = arrayOf(object.fields ?? object.attributes).filter((field) => !isEmptyValue(field))
      const seen = new Set()
      for (const field of fields) {
        const fieldName = textOf(isPlainObject(field) ? field.name ?? field.field : field).trim()
        if (fieldName === '') continue
        if (seen.has(fieldName)) {
          issues.push(draft(
            QUALITY_DIMENSIONS.data,
            'major',
            '字段名重复',
            `任务「${textOf(task.title)}」的对象「${name || '(未命名对象)'}」中字段「${fieldName}」重复。`,
            targetPath,
            [textOf(task.taskId)],
            '删除或重命名重复字段。',
          ))
          break
        }
        seen.add(fieldName)
      }
    }
  }
  return issues
}

/**
 * Parse `## <name>` sections of one PRD markdown file.
 * @param {string} markdown - PRD file text.
 * @returns {Record<string, string>} section name -> body.
 */
export function parsePrdSections(markdown) {
  const sections = {}
  const lines = textOf(markdown).split(/\r?\n/)
  let current
  const buffer = []
  const commit = () => {
    if (current !== undefined) sections[current] = buffer.join('\n').trim()
    buffer.length = 0
  }
  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line.trim())
    if (heading !== null) {
      commit()
      current = heading[1].trim()
      continue
    }
    if (current !== undefined) buffer.push(line)
  }
  commit()
  return sections
}

/**
 * Pull candidate flow-step names from a `业务流程` section: markdown list items
 * and numbered steps, with bold/backticks and trailing explanations removed.
 * @param {string} section - section body.
 * @returns {string[]} candidate names.
 */
export function extractFlowCandidates(section) {
  const output = []
  for (const line of textOf(section).split(/\r?\n/)) {
    const item = /^\s*(?:[-*+]|\d+[.、)])\s+(.+)$/.exec(line)
    if (item === null) continue
    let name = item[1]
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim()
    name = name.split(/[：:]/)[0].trim()
    name = name.replace(/（.*?）/g, '').replace(/\(.*?\)/g, '').trim()
    if (name === '' || name.length > 60) continue
    output.push(name)
  }
  return output
}

/**
 * Load every PRD current-version document once for the checks.
 * @param {string} workspacePath - canonical workspace path.
 * @param {Array<Record<string, any>>} prds - PRD records.
 * @returns {Promise<Map<string, {prd: Record<string, any>, text: string, path: string|undefined, error: string|undefined}>>}
 */
async function loadPrdDocuments(workspacePath, prds) {
  const documents = new Map()
  for (const prd of prds) {
    const versions = arrayOf(prd.versions)
    const current = versions.find((version) => Number(version.version) === Number(prd.currentVersion))
      ?? versions[versions.length - 1]
    const filePath = nonEmptyText(current?.path)
    if (filePath === undefined) {
      documents.set(textOf(prd.prdId), { prd, text: '', path: undefined, error: 'prd-version-missing' })
      continue
    }
    const read = await readWorkspaceText(workspacePath, filePath)
    if (!read.ok) {
      documents.set(textOf(prd.prdId), { prd, text: '', path: filePath, error: read.code })
      continue
    }
    documents.set(textOf(prd.prdId), { prd, text: read.value.text, path: read.value.path, error: undefined })
  }
  return documents
}

/**
 * Document consistency: flow names vs analyzed nodes, decision references.
 * @param {Array<Record<string, any>>} selectedPrds - PRDs in scope.
 * @param {Map<string, {prd: Record<string, any>, text: string, path: string|undefined, error: string|undefined}>} documents - loaded PRD documents.
 * @param {Map<string, Record<string, any>>} tasksById - task lookup.
 * @param {Set<string>} decisionIds - existing decision ids across cockpit and kb.
 * @returns {Array<Record<string, any>>} issue drafts.
 */
function checkDocuments(selectedPrds, documents, tasksById, decisionIds) {
  const issues = []
  for (const prd of selectedPrds) {
    const document = documents.get(textOf(prd.prdId))
    const targetPath = document?.path ?? `prd:${textOf(prd.prdId)}`
    if (document === undefined) continue
    if (document.error !== undefined) {
      issues.push(draft(
        QUALITY_DIMENSIONS.document,
        'minor',
        'PRD 版本文件不可读',
        `PRD「${textOf(prd.title)}」当前版本 v${String(prd.currentVersion ?? '?')} 的文件不存或不可读（${document.error}）。`,
        targetPath,
        [textOf(prd.prdId)],
        '重新保存 PRD，让 Host 生成新的版本文件。',
      ))
      continue
    }
    const sections = parsePrdSections(document.text)
    const flowSection = sections['业务流程'] ?? ''
    const taskId = nonEmptyText(prd.taskId)
    const task = taskId === undefined ? undefined : tasksById.get(taskId)
    const nodes = arrayOf(isPlainObject(task?.business) ? task.business.process?.nodes : undefined).filter(isPlainObject)
    if (flowSection !== '' && nodes.length > 0) {
      const nodeLabels = nodes.map((node) => textOf(node.label).trim()).filter((label) => label !== '')
      const candidates = extractFlowCandidates(flowSection)
      for (const candidate of candidates) {
        if (nodeLabels.some((label) => label === candidate || candidate.includes(label) || label.includes(candidate))) {
          continue
        }
        issues.push(draft(
          QUALITY_DIMENSIONS.document,
          'major',
          'PRD 流程步骤无对应节点',
          `PRD「${textOf(prd.title)}」业务流程段列出「${candidate}」，但任务「${textOf(task?.title)}」的流程节点中没有同名节点。`,
          targetPath,
          [textOf(prd.prdId), taskId].filter((value) => value !== undefined),
          '在业务分析中补齐该流程节点，或修正 PRD 步骤名称。',
        ))
      }
    }
    const references = new Set(document.text.match(DECISION_REFERENCE_PATTERN) ?? [])
    for (const reference of references) {
      if (decisionIds.has(reference)) continue
      issues.push(draft(
        QUALITY_DIMENSIONS.document,
        'blocker',
        'PRD 引用了不存在的决策 ID',
        `PRD「${textOf(prd.title)}」引用了 ${reference}，但驾驶舱与知识库中都没有这个决策。`,
        targetPath,
        [textOf(prd.prdId), reference],
        '先确认该决策是否存在；不存在则从 PRD 中移除或先建决策页。',
      ))
    }
  }
  return issues
}

/**
 * Knowledge base hygiene: missing frontmatter fields, unconfirmed references,
 * and a missing index.
 * @param {string} workspacePath - canonical workspace path.
 * @param {Array<Record<string, any>>} allPrdDocuments - all loaded PRD documents.
 * @returns {Promise<Array<Record<string, any>>>} issue drafts.
 */
async function checkKnowledge(workspacePath, allPrdDocuments) {
  const issues = []
  const scan = await scanKnowledgeBase(workspacePath)
  const pages = scan.items.filter((item) => item.kind === 'wiki')
  for (const page of pages) {
    const missing = []
    if (nonEmptyText(page.title) === undefined) missing.push('title')
    if (nonEmptyText(page.id) === undefined) missing.push('id')
    if (nonEmptyText(page.type) === undefined) missing.push('type')
    if (nonEmptyText(page.project) === undefined) missing.push('project')
    if (nonEmptyText(page.status) === undefined) missing.push('status')
    if (nonEmptyText(page.scope) === undefined) missing.push('scope')
    if (!Array.isArray(page.sources) || page.sources.length === 0) missing.push('sources')
    if (!Array.isArray(page.tags) || page.tags.length === 0) missing.push('tags')
    if (missing.length > 0) {
      const critical = missing.includes('title') || missing.includes('id') || missing.includes('type')
      issues.push(draft(
        QUALITY_DIMENSIONS.knowledge,
        critical || missing.length >= 3 ? 'major' : 'minor',
        '知识页缺少必填字段',
        `知识页「${textOf(page.title)}」缺少 frontmatter 字段：${missing.join('、')}（SCHEMA §6 要求前 8 项必填）。`,
        page.path,
        [nonEmptyText(page.id) ?? page.path],
        '按 kb/SCHEMA.md §6 补齐 frontmatter 必填字段。',
      ))
    }
  }

  // A 待确认 page used as a formal basis in any PRD is a real contradiction.
  for (const page of pages) {
    if (textOf(page.status) !== '待确认') continue
    const pageId = nonEmptyText(page.id)
    if (pageId === undefined) continue
    for (const document of allPrdDocuments.values()) {
      if (document.text === '' || !document.text.includes(pageId)) continue
      issues.push(draft(
        QUALITY_DIMENSIONS.knowledge,
        'major',
        'PRD 将待确认知识当作正式依据',
        `PRD「${textOf(document.prd.title)}」引用了状态为「待确认」的知识页 ${pageId}（${textOf(page.title)}）。`,
        document.path ?? `prd:${textOf(document.prd.prdId)}`,
        [textOf(document.prd.prdId), pageId],
        '先确认该知识页并改为「正式」，或在 PRD 中标注这是参考而非依据。',
      ))
    }
  }

  if (pages.length > 0 && !scan.stats.indexPresent) {
    issues.push(draft(
      QUALITY_DIMENSIONS.knowledge,
      'minor',
      '知识库索引缺失',
      `kb/wiki 下已有 ${pages.length} 个页面，但 kb/wiki/index.md 不存在。`,
      path.join(workspacePath, 'kb', 'wiki', 'index.md'),
      [path.join(workspacePath, 'kb', 'wiki')],
      '按 SCHEMA §4.1 第 6 步补建 index.md。',
    ))
  }
  return issues
}

/**
 * Resolve the tasks/PRDs one requested scope covers.
 * @param {Record<string, any>} state - state draft (read copy).
 * @param {{scope?: string, targetId?: string}} request - quality request.
 * @returns {{ok: true, value: {scope: string, targetId: string|null, tasks: Array<Record<string, any>>, prds: Array<Record<string, any>>}}|{ok: false, code: string, message: string}}
 */
function selectScope(state, request) {
  const scope = nonEmptyText(request.scope) ?? 'all'
  const targetId = nonEmptyText(request.targetId)
  const allowedScopes = ['all', 'task', 'prd', 'project', 'knowledge']
  if (!allowedScopes.includes(scope)) {
    return fail('payload-invalid', `scope 必须是 ${allowedScopes.join(' / ')} 之一`)
  }
  const allTasks = arrayOf(state.tasks)
  const allPrds = arrayOf(state.prds)
  if (scope === 'all' || scope === 'knowledge') {
    return ok({ scope, targetId: targetId ?? null, tasks: allTasks, prds: allPrds })
  }
  if (targetId === undefined) {
    return fail('payload-invalid', `scope=${scope} 时必须提供 targetId`)
  }
  if (scope === 'task') {
    const task = allTasks.find((entry) => textOf(entry.taskId) === targetId)
    if (task === undefined) return fail('task-not-found', `任务不存在：${targetId}`)
    return ok({
      scope,
      targetId,
      tasks: [task],
      prds: allPrds.filter((entry) => textOf(entry.taskId) === targetId),
    })
  }
  if (scope === 'prd') {
    const prd = allPrds.find((entry) => textOf(entry.prdId) === targetId)
    if (prd === undefined) return fail('prd-not-found', `PRD 不存在：${targetId}`)
    return ok({ scope, targetId, tasks: allTasks, prds: [prd] })
  }
  const project = arrayOf(state.projects).find((entry) => textOf(entry.projectId) === targetId)
  if (project === undefined) return fail('project-not-found', `项目不存在：${targetId}`)
  return ok({
    scope,
    targetId,
    tasks: allTasks.filter((entry) => textOf(entry.projectId) === targetId),
    prds: allPrds.filter((entry) => textOf(entry.projectId) === targetId),
  })
}

/**
 * Run one deterministic quality inspection.
 *
 * @param {string} workspacePath - canonical workspace path.
 * @param {{scope?: string, targetId?: string}} [request] - scope request.
 * @returns {Promise<{ok: true, value: {report: Record<string, any>, issues: Array<Record<string, any>>}}|{ok: false, code: string, message: string}>}
 */
export async function runQuality(workspacePath, request = {}) {
  const state = await readState(workspacePath)
  const selection = selectScope(state, request)
  if (!selection.ok) return selection
  const { tasks, prds: selectedPrds, scope, targetId } = selection.value

  const documents = await loadPrdDocuments(workspacePath, selectedPrds)
  const allPrds = arrayOf(state.prds)
  const allDocuments = await loadPrdDocuments(workspacePath, allPrds)

  const tasksById = new Map(tasks.map((task) => [textOf(task.taskId), task]))
  const decisionIds = new Set()
  for (const decision of arrayOf(state.decisions)) {
    const id = textOf(decision.decisionId)
    if (/^D-\d{4}$/.test(id)) decisionIds.add(id)
  }
  const scan = await scanKnowledgeBase(workspacePath)
  for (const page of scan.items) {
    if (page.kind !== 'wiki') continue
    const id = textOf(page.id)
    if (/^D-\d{4}$/.test(id)) decisionIds.add(id)
  }

  const drafts = [
    ...checkRequirement(tasks),
    ...checkProcess(tasks),
    ...checkRules(tasks),
    ...checkArchitecture(tasks),
    ...checkData(tasks),
    ...checkDocuments(selectedPrds, documents, tasksById, decisionIds),
    ...(await checkKnowledge(workspacePath, allDocuments)),
  ]

  const at = nowIso()
  const reportId = newId('QR')
  const report = {
    reportId,
    at,
    scope,
    targetId,
    issueCount: drafts.length,
    bySeverity: {
      blocker: drafts.filter((issue) => issue.severity === 'blocker').length,
      major: drafts.filter((issue) => issue.severity === 'major').length,
      minor: drafts.filter((issue) => issue.severity === 'minor').length,
    },
  }

  const created = await mutateState(workspacePath, (state) => {
    state.quality = isPlainObject(state.quality) ? state.quality : { reports: [], issues: [] }
    state.quality.reports.push(report)
    if (state.quality.reports.length > REPORTS_MAX) {
      state.quality.reports.splice(0, state.quality.reports.length - REPORTS_MAX)
    }
    const newIssues = []
    for (const issueDraft of drafts) {
      // Supersede a previously open issue for the very same finding.
      for (const existing of state.quality.issues) {
        if (textOf(existing.status) === 'resolved' || textOf(existing.status) === 'stale') continue
        if (
          textOf(existing.targetPath) === issueDraft.targetPath
          && textOf(existing.dimension) === issueDraft.dimension
          && textOf(existing.title) === issueDraft.title
        ) {
          existing.status = 'stale'
          existing.resolvedAt = at
          existing.resolution = '已被新一轮检查替代'
        }
      }
      const issue = {
        issueId: newId('QI'),
        reportId,
        dimension: issueDraft.dimension,
        severity: issueDraft.severity,
        title: issueDraft.title,
        detail: issueDraft.detail,
        targetPath: issueDraft.targetPath,
        docRefs: issueDraft.docRefs,
        suggestion: issueDraft.suggestion,
        status: 'open',
        createdAt: at,
        resolvedAt: null,
        resolution: null,
      }
      state.quality.issues.push(issue)
      newIssues.push(issue)
    }
    if (state.quality.issues.length > ISSUES_MAX) {
      state.quality.issues.splice(0, state.quality.issues.length - ISSUES_MAX)
    }
    return { report, issues: newIssues }
  })

  // SPEC.md: every report also lands as a real file under quality/<stamp>.json.
  await writeQualityReportFile(workspacePath, report, created.issues)

  await appendAudit(workspacePath, {
    action: 'quality.run',
    ok: true,
    reportId,
    scope,
    targetId,
    issueCount: report.issueCount,
    bySeverity: report.bySeverity,
  })
  return ok(created)
}

/**
 * Write the report file (`quality/<stamp>-<reportId>.json`), never overwriting.
 * @param {string} workspacePath - canonical workspace path.
 * @param {Record<string, any>} report - report record.
 * @param {Array<Record<string, any>>} issues - created issues.
 * @returns {Promise<void>}
 */
async function writeQualityReportFile(workspacePath, report, issues) {
  const stamp = localDateTime().replace(/[^0-9]/g, '')
  const file = path.join(dataRootOf(workspacePath), 'quality', `${stamp}-${report.reportId}.json`)
  const written = await writeNewTextFile(file, `${JSON.stringify({ report, issues }, null, 2)}\n`)
  if (!written.ok && written.code !== 'file-exists') {
    console.warn('[pm-copilot] quality report file not written:', written.message)
  }
}

/**
 * Mark issues as being fixed (called after a fix prompt was queued).
 * @param {string} workspacePath - canonical workspace path.
 * @param {unknown} issueIds - issue ids to mark.
 * @returns {Promise<{ok: true, value: {issues: Array<Record<string, any>>}}|{ok: false, code: string, message: string}>}
 */
export async function markIssuesFixing(workspacePath, issueIds) {
  const ids = Array.isArray(issueIds) ? issueIds.filter((id) => typeof id === 'string' && id.trim() !== '') : []
  if (ids.length === 0) return fail('payload-invalid', 'issueIds 必须是非空字符串数组')
  const result = await mutateState(workspacePath, (state) => {
    state.quality = isPlainObject(state.quality) ? state.quality : { reports: [], issues: [] }
    const updated = []
    for (const issueId of ids) {
      const issue = state.quality.issues.find((entry) => textOf(entry.issueId) === issueId)
      if (issue === undefined) continue
      if (textOf(issue.status) === 'resolved') continue
      issue.status = 'fixing'
      updated.push(issue)
    }
    return { issues: updated, missing: ids.filter((id) => !updated.some((issue) => textOf(issue.issueId) === id)) }
  })
  if (result.issues.length === 0) {
    return fail('issue-not-found', `没有可标记为修复中的问题：${ids.join(', ')}`)
  }
  await appendAudit(workspacePath, {
    action: 'quality.fix',
    ok: true,
    issueIds: result.issues.map((issue) => issue.issueId),
    missing: result.missing,
  })
  return ok(result)
}

/**
 * Resolve one issue with the real resolution note.
 * @param {string} workspacePath - canonical workspace path.
 * @param {unknown} issueId - issue id.
 * @param {unknown} resolution - what was actually done.
 * @returns {Promise<{ok: true, value: Record<string, any>}|{ok: false, code: string, message: string}>}
 */
export async function resolveIssue(workspacePath, issueId, resolution) {
  const id = nonEmptyText(issueId)
  if (id === undefined) return fail('payload-invalid', 'issueId 缺失')
  const note = nonEmptyText(resolution)
  if (note === undefined) return fail('payload-invalid', 'resolution 必须是非空说明')
  const issue = await mutateState(workspacePath, (state) => {
    state.quality = isPlainObject(state.quality) ? state.quality : { reports: [], issues: [] }
    const found = state.quality.issues.find((entry) => textOf(entry.issueId) === id)
    if (found === undefined) throw new PmCopilotError('issue-not-found', `问题不存在：${id}`)
    found.status = 'resolved'
    found.resolvedAt = nowIso()
    found.resolution = note
    return found
  })
  await appendAudit(workspacePath, { action: 'quality.resolve', ok: true, issueId: id, resolution: note })
  return ok(issue)
}

/**
 * Count issues that still need attention (`open` or `fixing`).
 * @param {Record<string, any>} quality - `state.quality`.
 * @returns {number}
 */
export function openIssueCount(quality) {
  const issues = arrayOf(isPlainObject(quality) ? quality.issues : undefined)
  return issues.filter((issue) => ['open', 'fixing'].includes(textOf(issue.status))).length
}

/** Re-exported for callers that want the exact required-field list. */
export const KNOWLEDGE_REQUIRED_FIELDS = KB_REQUIRED_FIELDS
