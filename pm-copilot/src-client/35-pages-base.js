/**
 * PM Copilot — Client half, part 35: page registry and cross-page helpers.
 *
 * Pages are ordinary React components mounted by the cockpit shell, so each
 * module keeps its own hook order and unmounts cleanly when the user switches.
 */

/** Page components, keyed by navigation id. */
PM.pages = {}

/** Shared page helpers: task pickers, prompt builders, formatting. */
const U = {}

/**
 * Display labels for the codes the Host stores. Raw codes stay available in a
 * tooltip so nothing is hidden, but a user never reads `completed` in a Chinese
 * table.
 */
U.CODES = {
  status: { sent: '已发送', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' },
  kind: {
    'task.analyze': '分析拆解', 'task.run': '任务执行', 'task.continue': '继续执行',
    'skill.combine': 'Skill 组合', 'skill.invoke': 'Skill 调用', 'agent.prompt': 'Agent 指令',
    'quality.fix': '质量修正', 'solution.design': '方案设计', 'prd.writer': 'PRD 编写',
    cockpit: '驾驶舱指令',
  },
  severity: { blocker: '阻断', major: '严重', minor: '一般' },
  scope: { all: '全部对象', task: '单个任务', prd: '单份 PRD', project: '单个项目' },
  prdStatus: { draft: '草稿', review: '评审中', confirmed: '已确认', archived: '已归档' },
  knowledgeType: { entity: '实体', concept: '概念', decision: '决策', summary: '摘要', comparison: '对比', issue: '故障', question: '待确认', raw: '原始资料', doc: '项目文档', schema: '规则' },
  invocation: { model: '模型可调用', user: '用户可调用' },
  issueStatus: { open: '待修正', fixing: '修正中', resolved: '已解决', stale: '已过期' },
  decisionType: { business: '业务规则', scope: '产品范围', architecture: '架构选型', data: '数据口径', process: '流程变更', other: '其它' },
}

/**
 * Translate one stored code, falling back to the raw value.
 * @param group - dictionary group in {@link U.CODES}.
 * @param code - stored code.
 * @returns {string} display label.
 */
U.code = (group, code) => {
  if (code === undefined || code === null || code === '') return '未标注'
  const map = U.CODES[group] || {}
  return map[code] || String(code)
}

/**
 * Render one arbitrary Agent-written value as readable text.
 *
 * Agent payloads mix strings, `{text}` / `{question}` / `{title}` objects and
 * plain structures. Showing `JSON.stringify` to a product manager is noise, so
 * a recognisable field is used first and the raw JSON is only kept as a last
 * resort.
 * @param value - any stored entry.
 * @returns {string}
 */
U.text = (value) => {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map((item) => U.text(item)).join('；')
  if (typeof value === 'object') {
    for (const key of ['text', 'question', 'title', 'detail', 'name', 'label', 'value', 'description']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

/** A select over the real task collection. */
U.TaskSelect = function TaskSelect({ tasks, value, onChange, placeholder }) {
  return h('select', { className: 'pmc-select', value: value || '', onChange: (e) => onChange(e.target.value) },
    h('option', { value: '' }, placeholder || '选择任务'),
    tasks.map((task) => h('option', { key: task.taskId, value: task.taskId }, '[' + (U.statusLabel(task.status)) + '] ' + task.title)))
}

/** Status label that tolerates an unknown code without inventing one. */
function STATUS_LABEL_SAFE(status) {
  const map = { todo: '待开始', analysis: '分析中', design: '设计中', executing: '执行中', confirming: '待确认', quality: '质量检查中', done: '已完成', paused: '已暂停', terminated: '已终止' }
  return map[status] || status
}

/** Human label for a task type. */
U.typeLabel = (t, type) => t('task.type.' + (type || 'other')) === 'task.type.' + (type || 'other') ? (type || '其它') : t('task.type.' + type)

/** Find the task a page should focus on: an explicit focus id or the first real task. */
U.pickTask = function pickTask(snapshot, preferredId) {
  const tasks = PM.list(snapshot && snapshot.tasks)
  if (preferredId) {
    const found = tasks.find((x) => x.taskId === preferredId)
    if (found) return found
  }
  return tasks.find((x) => x.status === 'executing') || tasks.find((x) => x.status === 'analysis') || tasks[0]
}

/** Compose a real instruction for the main Agent from a task's stored facts. */
U.taskInstruction = function taskInstruction(task) {
  const lines = [
    '驾驶舱任务：' + task.title,
    '任务 ID：' + task.taskId,
    '任务类型：' + (task.type || 'other'),
    '当前阶段：' + (task.stage || '需求理解'),
    '任务描述：' + (task.description || '（无，见用户原始诉求）'),
    '关联 Skill：' + (PM.list(task.skills).length ? PM.list(task.skills).join('、') : '未指定'),
  ]
  return lines.join('\n')
}

/**
 * The shared "send this to the main Agent" helper every page uses.
 *
 * The success message names where the result will appear, because a queued
 * prompt is not a result: the Agent works asynchronously and writes back
 * through `pm_copilot`, so the user must know which page to watch.
 */
U.prompt = async function prompt(pageCtx, text, options) {
  const where = (options && options.where) || '「任务中心 → 执行轨迹」与相关页面'
  return pageCtx.run('agent.prompt', {
    text,
    kind: (options && options.kind) || 'cockpit',
    title: (options && options.title) || '驾驶舱指令',
    taskId: options && options.taskId,
  }, {
    label: (options && options.label) || '正在发送给主 Agent',
    success: (options && options.success) || ('已发送给主 Agent，结果会写入 ' + where + '（可点刷新查看）'),
  })
}

/** Status label for a task code, through the locale dictionary. */
U.statusLabel = (status) => {
  const zh = { todo: '待开始', analysis: '分析中', design: '设计中', executing: '执行中', confirming: '待确认', quality: '质量检查中', done: '已完成', paused: '已暂停', terminated: '已终止' }
  return zh[status] || String(status)
}

/** Whether a quality issue is still open, used by every quality count. */
U.isOpenIssue = (issue) => issue !== null && issue !== undefined && issue.status !== 'resolved' && issue.status !== 'stale'

/** Metric tone for a quality/decision count. */
U.countTone = (n) => (n > 0 ? 'warn' : 'ok')

/** Severity tone used by the quality centre. */
U.severityTone = (severity) => (severity === 'blocker' ? 'danger' : severity === 'major' ? 'warn' : 'mute')

PM.pagesUtil = U
PM.alias = { Card, Metric, Tag, Bar, Button, Empty, Field, Input, Textarea, Select, Tabs, KV, Table, Banner, Drawer, Flow, TreeView, Icon, U }
