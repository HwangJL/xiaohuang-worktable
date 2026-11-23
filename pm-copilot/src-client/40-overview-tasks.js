/**
 * PM Copilot — Client half, part 40: 工作总览 (overview) and 任务中心 (task center).
 *
 * Every number on these pages is derived from the snapshot's real task,
 * decision and quality records; nothing is a placeholder value. Render trees
 * are assembled from local variables so each element stays readable.
 */

/** Focus hand-off between pages: recent-task clicks land in the task centre. */
PM.focus = { taskId: null }

/** Derive the six headline metrics from real records (fallback for a host that omits them). */
function deriveMetrics(snapshot) {
  if (snapshot && snapshot.metrics) return snapshot.metrics
  const tasks = PM.list(snapshot && snapshot.tasks)
  const decisions = PM.list(snapshot && snapshot.decisions)
  const issues = PM.list(snapshot && snapshot.quality && snapshot.quality.issues)
  return {
    todo: tasks.filter((x) => x.status === 'todo').length,
    executing: tasks.filter((x) => ['analysis', 'design', 'executing'].includes(x.status)).length,
    confirming: tasks.filter((x) => x.status === 'confirming').length + decisions.filter((x) => x.status === 'pending').length,
    done: tasks.filter((x) => x.status === 'done').length,
    knowledgePending: decisions.filter((x) => x.status === 'pending').length,
    qualityOpen: issues.filter((x) => x.status !== 'resolved' && x.status !== 'stale').length,
  }
}

/** Derive the five to-do groups from real records. */
function deriveTodos(snapshot) {
  const dashboard = (snapshot && snapshot.dashboard) || {}
  if (Array.isArray(dashboard.todoItems) && dashboard.todoItems.length > 0) return dashboard.todoItems
  const tasks = PM.list(snapshot && snapshot.tasks)
  const decisions = PM.list(snapshot && snapshot.decisions)
  const issues = PM.list(snapshot && snapshot.quality && snapshot.quality.issues)
  const open = issues.filter((x) => x.status !== 'resolved' && x.status !== 'stale')
  return [
    { key: 'business', title: '等待业务确认', items: tasks.filter((x) => x.status === 'confirming').map((x) => ({ id: x.taskId, title: x.title, detail: '阶段：' + (x.stage || '—'), taskId: x.taskId })) },
    { key: 'decision', title: '等待产品决策', items: decisions.filter((x) => x.status === 'pending').map((x) => ({ id: x.decisionId, title: x.title, detail: x.type || '决策', decisionId: x.decisionId })) },
    { key: 'material', title: '等待补充资料', items: tasks.filter((x) => x.analysis && x.analysis.completeness && PM.list(x.analysis.completeness.toConfirm).length > 0).map((x) => ({ id: x.taskId, title: x.title, detail: '待确认 ' + PM.list(x.analysis.completeness.toConfirm).length + ' 项', taskId: x.taskId })) },
    { key: 'knowledge', title: '等待知识审核', items: PM.list(snapshot && snapshot.knowledge).filter((x) => (x.status || '待确认') === '待确认').map((x) => ({ id: x.entryId, title: x.title, detail: x.type || '知识', entryId: x.entryId })) },
    { key: 'fix', title: '待修正问题', items: open.map((x) => ({ id: x.issueId, title: x.title, detail: x.dimension || '质量', issueId: x.issueId })) },
  ]
}

/** The seven quick actions; each composes a real instruction for the main Agent. */
const QUICK_ACTIONS = [
  { key: 'requirement', icon: 'analysis', title: '新建需求分析', hint: '需求理解 → 拆解', instruction: (project, task) => '请对我的新需求执行完整的【需求理解与分析】：\n1) 先检索 kb/ 里相关的项目资料与历史决策；\n2) 拆解用户原始诉求、核心业务问题、真实目标、业务价值、适用场景与业务角色；\n3) 判断工作阶段与信息完整性（已明确/已检索/假设/待确认/风险）；\n4) 给出可执行子任务与执行计划，并推荐对应的专业 Skill。\n项目：' + project + '\n当前任务参考：' + (task ? task.title : '（无，本次为新需求）') + '\n分析完成后用 pm_copilot 工具（action: task_create + analysis_save 或 analysis_save）把结果写回驾驶舱。' },
  { key: 'business', icon: 'business', title: '业务流程分析', hint: '正常 + 异常 + 状态', instruction: (project, task) => '请对当前业务执行【业务流程分析】：梳理正常流程、异常流程、状态流转、跨系统流程与角色交互，标出流程断点。\n项目：' + project + '\n任务：' + (task ? task.title : '（未指定，请先确认任务）') + '\n完成后用 pm_copilot（action: task_business_save）写回驾驶舱的 business.process。' },
  { key: 'rule', icon: 'rules', title: '业务规则分析', hint: '准入/校验/权限', instruction: (project, task) => '请执行【业务规则分析】：按准入规则、校验规则、计算规则、权限规则、状态规则、异常处理规则、互斥与优先级规则分类提取，标注规则来源与冲突。\n项目：' + project + '\n任务：' + (task ? task.title : '（未指定）') + '\n完成后用 pm_copilot（action: task_business_save）写回 business.rules。' },
  { key: 'solution', icon: 'solution', title: '产品方案设计', hint: '架构 + MVP + 版本', instruction: (project, task) => '请执行【产品方案设计】：产品定位、建设目标、产品架构、功能架构、模块结构、数据模型、接口设计、权限设计、MVP 范围与版本规划。\n项目：' + project + '\n任务：' + (task ? task.title : '（未指定）') + '\n完成后用 pm_copilot（action: task_solution_save）写回驾驶舱。' },
  { key: 'prd', icon: 'prd', title: 'PRD 编写', hint: '15 段标准结构', instruction: (project, task) => '请加载 PRD Skill 并执行【PRD 编写】，覆盖全部 15 个结构章节（需求背景…验收标准），引用已确认的业务规则与决策 ID。\n项目：' + project + '\n任务：' + (task ? task.title : '（未指定）') + '\n完成后用 pm_copilot（action: prd_save）写回 PRD 文档中心。' },
  { key: 'quality', icon: 'quality', title: '需求质量检查', hint: '六维一致性', instruction: (project, task) => '请执行【需求质量检查】：需求完整性、流程完整性、规则完整性、架构一致性、数据一致性、文档一致性六个维度逐项检查，给出问题等级与修正建议。\n项目：' + project + '\n任务：' + (task ? task.title : '（未指定）') + '\n完成后用 pm_copilot（action: quality_report）写回质量检查中心。' },
  { key: 'knowledge', icon: 'knowledge', title: '项目知识检索', hint: '直接打开知识中心', navigate: 'knowledge' },
]

PM.pages.overview = function Overview(props) {
  const { t, snapshot, navigate } = props
  const metrics = deriveMetrics(snapshot)
  const todos = deriveTodos(snapshot)
  const dashboard = (snapshot && snapshot.dashboard) || {}
  const tasks = PM.list(snapshot && snapshot.tasks)
  const currentWork = dashboard.currentWork || tasks.find((x) => ['executing', 'analysis', 'design'].includes(x.status)) || null
  const recentList = PM.list(dashboard.recentTasks)
  const recent = recentList.length > 0 ? recentList : tasks.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8)
  const projectName = (snapshot && snapshot.workspace && (snapshot.workspace.title || snapshot.workspace.path)) || '—'
  const capabilities = (snapshot && snapshot.capabilities) || {}
  const inFlightCount = PM.list(snapshot && snapshot.executions)
    .filter((execution) => execution.status === 'sent' || execution.status === 'running').length
  const presetLine = snapshot && snapshot.identity && snapshot.identity.preset ? 'Agent preset: ' + snapshot.identity.preset + ' · ' : ''
  const [quick, setQuick] = React.useState(null)
  const [draft, setDraft] = React.useState('')
  const [sending, setSending] = React.useState(false)

  const openTask = (taskId) => { PM.focus.taskId = taskId; navigate('tasks') }
  const openItem = (item) => {
    if (item.taskId) return openTask(item.taskId)
    if (item.decisionId) return navigate('decisions')
    return navigate('knowledge')
  }

  const startQuick = (action) => {
    if (action.navigate) { navigate(action.navigate); return }
    setQuick(action)
    setDraft(action.instruction(projectName, currentWork))
  }
  const sendQuick = async () => {
    if (!quick || draft.trim() === '') return
    setSending(true)
    try {
      await U.prompt(props, draft.trim(), {
        kind: 'quick:' + quick.key, title: quick.title,
        taskId: currentWork ? currentWork.taskId : undefined,
        label: '正在调用主 Agent：' + quick.title,
      })
      setQuick(null)
      setDraft('')
    } catch { /* the toast carries the Host's reason */ } finally { setSending(false) }
  }

  const degraded = [
    !capabilities.agent ? '主 Agent 调用（sessionController 未挂载）' : null,
    !capabilities.skills ? 'Skill 注册表（ctx.skills 未挂载）' : null,
    !capabilities.knowledgeRead ? '项目文件读取' : null,
  ].filter(Boolean)

  const headBlock = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('nav.overview')), h('p', null, presetLine + projectName)))

  const degradedBlock = degraded.length > 0
    ? h('div', { style: { marginBottom: 12 } }, h(Banner, { tone: 'warn', text: t('sys.degraded') + ' ' + degraded.join('、') }))
    : null

  const metricTiles = [
    h(Metric, { key: 'todo', label: t('ov.metric.todo'), value: metrics.todo, hint: t('ov.metricHint.todo') }),
    h(Metric, { key: 'exec', label: t('ov.metric.executing'), value: metrics.executing, hint: t('ov.metricHint.executing') }),
    h(Metric, { key: 'confirm', label: t('ov.metric.confirming'), value: metrics.confirming, tone: 'warn', hint: t('ov.metricHint.confirming') }),
    h(Metric, { key: 'done', label: t('ov.metric.done'), value: metrics.done, tone: 'ok', hint: t('ov.metricHint.done') }),
    h(Metric, { key: 'kb', label: t('ov.metric.knowledge'), value: metrics.knowledgePending, tone: 'warn', hint: t('ov.metricHint.knowledge') }),
    h(Metric, { key: 'quality', label: t('ov.metric.quality'), value: metrics.qualityOpen, tone: metrics.qualityOpen > 0 ? 'danger' : 'ok', hint: t('ov.metricHint.quality') }),
  ]
  const metricsBlock = h('div', { className: 'pmc-grid pmc-metrics', style: { marginBottom: 12 } }, metricTiles)

  const progressRow = h('div', null,
    h('div', { className: 'pmc-row', style: { justifyContent: 'space-between', fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, #8a9bb0)' } },
      h('span', { title: '按工作阶段估算，不代表实际工时完成度' }, t('ov.current.progress')),
      h('span', null, String(currentWork ? (currentWork.progress || 0) : 0) + '%')),
    h(Bar, { value: currentWork ? currentWork.progress : 0 }))

  const currentBody = currentWork
    ? h('div', { className: 'pmc-col' },
      h('div', { className: 'pmc-row' },
        h('strong', { style: { fontSize: 14 } }, currentWork.title),
        h(Tag, { text: STATUS_LABEL(t, currentWork.status), tone: STATUS_TONE(t, currentWork.status) })),
      h(KV, { items: [
        { k: t('top.project'), v: projectName },
        { k: t('ov.current.stage'), v: currentWork.stage || '—' },
        { k: t('ov.current.skills'), v: PM.list(currentWork.skills).join('、') || '—' },
      ] }),
      progressRow,
      h(KV, { items: [
        { k: t('ov.current.step'), v: currentWork.currentStep || '—' },
        { k: t('ov.current.blocker'), v: currentWork.blocker || '—' },
        { k: t('ov.current.next'), v: currentWork.nextStep || '—' },
      ] }),
      h('div', { className: 'pmc-row' },
        h(Button, { label: t('task.detail.trace'), icon: 'chevron', onClick: () => openTask(currentWork.taskId) })))
    : h(Empty, { title: t('ov.current.empty'), hint: t('common.emptyHint') })

  const currentCard = h(Card, { title: t('ov.current'), hint: currentWork ? currentWork.status : undefined }, currentBody)

  const todoRows = todos.map((group) => {
    const items = PM.list(group.items)
    const itemLines = items.length === 0
      ? [h('div', { key: 'none', className: 'pmc-li-sub', style: { color: 'var(--dsw-alias-label-tertiary, #8a9bb0)' } }, '当前无此类待办')]
      : items.slice(0, 3).map((item) => h('div', {
          key: item.id || item.title,
          className: 'pmc-li-sub pmc-link',
          onClick: () => openItem(item),
        }, '· ' + item.title + (item.detail ? ' — ' + item.detail : '')))
    return h('div', { key: group.key || group.title, className: 'pmc-list-item' },
      h('div', { className: 'pmc-li-main' },
        h('div', { className: 'pmc-li-title' }, (group.title || group.label || group.key) + ' · ' + items.length),
        itemLines))
  })
  const todoCard = h(Card, { title: t('ov.todo') }, h('div', { className: 'pmc-col', style: { gap: 4 } }, todoRows))

  const recentRows = recent.length === 0
    ? [h(Empty, { key: 'none', title: t('common.emptyTitle'), hint: t('common.emptyHint') })]
    : recent.map((task) => h('div', { key: task.taskId, className: 'pmc-list-item' },
      h('div', { className: 'pmc-li-main' },
        h('div', { className: 'pmc-li-title pmc-link', onClick: () => openTask(task.taskId) }, task.title),
        h('div', { className: 'pmc-li-sub' }, (task.stage || '') + ' · ' + PM.env.fmtTime(task.updatedAt) + ' · ' + (PM.list(task.skills).join('、') || '无 Skill'))),
      h(Tag, { text: STATUS_LABEL(t, task.status), tone: STATUS_TONE(t, task.status) })))
  const recentCard = h(Card, {
    title: t('ov.recent'),
    actions: h(Button, { label: t('common.detail'), icon: 'chevron', size: 'sm', onClick: () => navigate('tasks') }),
  }, h('div', null, recentRows))

  const quickButtons = QUICK_ACTIONS.map((action) => h('button', {
    key: action.key, type: 'button', onClick: () => startQuick(action),
  }, h('b', null, action.title), h('span', null, action.hint)))
  const composer = quick
    ? h('div', { className: 'pmc-col', style: { marginTop: 10, gap: 8 } },
      h(Field, { label: '发送给主 Agent 的指令（可编辑）' }, h(Textarea, { value: draft, onChange: setDraft, rows: 6 })),
      h('div', { className: 'pmc-row' },
        h(Button, { label: sending ? '发送中…' : '发送并执行', icon: 'send', variant: 'primary', disabled: sending, onClick: () => void sendQuick() }),
        h(Button, { label: t('common.cancel'), variant: 'ghost', onClick: () => { setQuick(null); setDraft('') } }),
        h('span', { className: 'pmc-dim', style: { fontSize: 11.5 } }, '指令走 sessionController.prompt，进入当前会话的主 Agent')))
    : null
  const quickCard = h(Card, { title: t('ov.quick'), hint: '调用主 Agent 真实执行' },
    h('div', { className: 'pmc-quick' }, quickButtons), composer)

  // Executions are real records, some of them not attached to a task (a Skill
  // combination, a quick analysis). The overview lists all of them so nothing
  // the Agent was asked to do can silently disappear.
  const executions = PM.list(snapshot && snapshot.executions)
  const recentExecutions = executions.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 5)
  const executionRows = recentExecutions.length === 0
    ? [h('div', { key: 'none', className: 'pmc-li-sub' }, '当前没有执行记录')]
    : recentExecutions.map((execution) => h('div', { key: execution.executionId, className: 'pmc-list-item' },
      h('div', { className: 'pmc-li-main' },
        h('div', { className: 'pmc-li-title' }, execution.title || '执行'),
        h('div', { className: 'pmc-li-sub' },
          U.code('kind', execution.kind) + ' · ' + PM.env.fmtTime(execution.at) + (execution.taskId ? ' · ' + execution.taskId : ' · 未关联任务'))),
      h(Tag, { text: U.code('status', execution.status), tone: execution.status === 'completed' ? 'ok' : execution.status === 'failed' ? 'danger' : 'blue' })))
  const executionCard = h(Card, {
    title: '最近执行',
    hint: inFlightCount > 0 ? inFlightCount + ' 项进行中（自动刷新）' : '真实调用记录',
    actions: h(Button, { label: t('common.refresh'), icon: 'refresh', size: 'sm', onClick: () => void props.refresh() }),
  }, h('div', null, executionRows))

  return h('div', null, headBlock, degradedBlock, metricsBlock,
    h('div', { className: 'pmc-split', style: { marginBottom: 12 } }, currentCard, todoCard),
    h('div', { className: 'pmc-split', style: { marginBottom: 12 } }, recentCard, quickCard),
    executionCard)
}

PM.pages.tasks = function Tasks(props) {
  const { t, snapshot, run } = props
  const tasks = PM.list(snapshot && snapshot.tasks)
  const projects = PM.list(snapshot && snapshot.projects)
  const executions = PM.list(snapshot && snapshot.executions)
  const deliverables = PM.list(snapshot && snapshot.deliverables)
  const [query, setQuery] = React.useState('')
  const [statusFilter, setStatusFilter] = React.useState('')
  const [typeFilter, setTypeFilter] = React.useState('')
  const [projectFilter, setProjectFilter] = React.useState('')
  const [detailId, setDetailId] = React.useState(PM.focus.taskId || null)
  const [creating, setCreating] = React.useState(false)
  const emptyForm = { title: '', description: '', type: 'requirement', priority: 'P1', projectId: '' }
  const [form, setForm] = React.useState(emptyForm)
  const [tab, setTab] = React.useState('basic')
  const [stageEdit, setStageEdit] = React.useState('')

  React.useEffect(() => {
    if (PM.focus.taskId) { setDetailId(PM.focus.taskId); PM.focus.taskId = null }
    if (PM.focus.create) { PM.focus.create = false; setCreating(true) }
  }, [])

  const detail = detailId ? tasks.find((x) => x.taskId === detailId) : null
  const detailStage = detail ? detail.stage : undefined
  React.useEffect(() => { if (detailStage) setStageEdit(detailStage) }, [detailStage])

  const filtered = tasks.filter((task) => {
    if (statusFilter && task.status !== statusFilter) return false
    if (typeFilter && task.type !== typeFilter) return false
    if (projectFilter && task.projectId !== projectFilter) return false
    if (query) {
      const hay = (task.title + ' ' + (task.description || '') + ' ' + task.taskId).toLowerCase()
      if (!hay.includes(query.toLowerCase())) return false
    }
    return true
  })

  const create = async () => {
    if (form.title.trim() === '') { props.toast('任务名称不能为空', 'danger'); return }
    try {
      const value = await run('task.create', { ...form, projectId: form.projectId || (projects[0] ? projects[0].projectId : undefined) }, { label: '正在创建任务', success: '任务已创建并落盘' })
      setCreating(false)
      setForm(emptyForm)
      // Open the new task immediately: creating a task is the start of work, not
      // a dead end, and the next step (分析拆解) lives in its detail drawer.
      const created = value && value.task ? value.task : null
      if (created !== null) { setDetailId(created.taskId); setTab('basic') }
    } catch { /* toast */ }
  }
  const act = async (action, payload, options) => { try { await run(action, payload, options) } catch { /* toast */ } }

  const statusOptions = [
    { value: 'todo', label: t('status.todo') }, { value: 'analysis', label: t('status.analysis') },
    { value: 'design', label: t('status.design') }, { value: 'executing', label: t('status.executing') },
    { value: 'confirming', label: t('status.confirming') }, { value: 'quality', label: t('status.quality') },
    { value: 'done', label: t('status.done') }, { value: 'paused', label: t('status.paused') },
    { value: 'terminated', label: t('status.terminated') },
  ]
  const typeOptions = [
    { value: 'requirement', label: t('task.type.requirement') }, { value: 'business', label: t('task.type.business') },
    { value: 'design', label: t('task.type.design') }, { value: 'prd', label: t('task.type.prd') },
    { value: 'quality', label: t('task.type.quality') }, { value: 'other', label: t('task.type.other') },
  ]
  const stageOptions = ['需求理解', '业务分析', '业务流程', '业务规则', '产品架构', '产品方案', 'PRD编写', '方案评审', '需求验收']

  const taskExecutions = detail ? executions.filter((x) => x.taskId === detail.taskId) : []
  const taskDeliverables = detail ? deliverables.filter((x) => x.taskId === detail.taskId) : []
  const capabilities = (snapshot && snapshot.capabilities) || {}
  const agentReady = capabilities.agent !== false

  const headBlock = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('task.title')), h('p', null, t('task.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h(Button, { label: t('common.refresh'), icon: 'refresh', onClick: () => void props.refresh() }),
    h(Button, { label: t('task.new'), icon: 'plus', variant: 'primary', onClick: () => setCreating((v) => !v) }))

  const formCard = creating
    ? h(Card, { title: t('task.new'), actions: h(Button, { label: t('common.cancel'), variant: 'ghost', size: 'sm', onClick: () => setCreating(false) }) },
      h('div', { className: 'pmc-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } },
        h(Field, { label: '任务名称' }, h(Input, { value: form.title, onChange: (v) => setForm({ ...form, title: v }), placeholder: '例如：运输计费规则重构' })),
        h(Field, { label: '所属项目' }, h(Select, { value: form.projectId, onChange: (v) => setForm({ ...form, projectId: v }), options: projects.map((p) => ({ value: p.projectId, label: p.title })), placeholder: projects.length ? '未指定' : '尚无项目，将创建默认项目' })),
        h(Field, { label: '任务类型' }, h(Select, { value: form.type, onChange: (v) => setForm({ ...form, type: v }), options: typeOptions })),
        h(Field, { label: '优先级' }, h(Select, { value: form.priority, onChange: (v) => setForm({ ...form, priority: v }), options: ['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p })) }))),
      h('div', { style: { marginTop: 8 } }, h(Field, { label: '任务描述' }, h(Textarea, { value: form.description, onChange: (v) => setForm({ ...form, description: v }), rows: 3, placeholder: '用户原始诉求、业务背景、期望结果' }))),
      h('div', { className: 'pmc-row', style: { marginTop: 10 } }, h(Button, { label: t('common.save'), icon: 'check', variant: 'primary', onClick: () => void create() })))
    : null

  const listColumns = [
    { key: 'taskId', label: t('task.col.id'), render: (row) => h('span', { className: 'pmc-mono' }, row.taskId) },
    { key: 'title', label: t('task.col.title'), render: (row) => h('div', null, h('div', { className: 'pmc-strong' }, row.title), h('div', { className: 'pmc-li-sub' }, PM.env.clip(row.description, 46))) },
    { key: 'projectId', label: t('task.col.project'), render: (row) => (projects.find((p) => p.projectId === row.projectId) || {}).title || '—' },
    { key: 'type', label: t('task.col.type'), render: (row) => U.typeLabel(t, row.type) },
    { key: 'stage', label: t('task.col.stage') },
    { key: 'priority', label: t('task.col.priority'), render: (row) => h(Tag, { text: row.priority || 'P2', tone: row.priority === 'P0' ? 'danger' : row.priority === 'P1' ? 'warn' : 'mute' }) },
    { key: 'status', label: t('task.col.status'), render: (row) => h(Tag, { text: STATUS_LABEL(t, row.status), tone: STATUS_TONE(t, row.status) }) },
    { key: 'skills', label: t('task.col.skills'), render: (row) => (PM.list(row.skills).length ? h('span', { className: 'pmc-mono' }, PM.list(row.skills).join(', ')) : '—') },
    { key: 'updatedAt', label: t('task.col.updated'), render: (row) => PM.env.fmtTime(row.updatedAt) },
  ]

  const listCard = h(Card, { title: t('task.col.title'), hint: filtered.length + ' / ' + tasks.length, style: { marginTop: 12 } },
    h('div', { className: 'pmc-row', style: { marginBottom: 10 } },
      h('div', { style: { flex: 1, minWidth: 180 } }, h(Input, { value: query, onChange: setQuery, placeholder: t('task.searchPlaceholder') })),
      h(Select, { value: statusFilter, onChange: setStatusFilter, options: statusOptions, placeholder: '全部状态' }),
      h(Select, { value: typeFilter, onChange: setTypeFilter, options: typeOptions, placeholder: '全部类型' }),
      h(Select, { value: projectFilter, onChange: setProjectFilter, options: projects.map((p) => ({ value: p.projectId, label: p.title })), placeholder: '全部项目' })),
    h(Table, { columns: listColumns, rows: filtered.map((row) => ({ ...row, rowKey: row.taskId })), onRowClick: (row) => { setDetailId(row.taskId); setTab('basic') } }))

  let detailTabs = null
  if (detail) {
    const basicTab = h('div', { className: 'pmc-col' },
      h(KV, { items: [
        { k: t('task.col.id'), v: h('span', { className: 'pmc-mono' }, detail.taskId) },
        { k: t('task.col.project'), v: (projects.find((p) => p.projectId === detail.projectId) || {}).title || '—' },
        { k: t('task.col.type'), v: U.typeLabel(t, detail.type) },
        { k: t('task.col.stage'), v: detail.stage || '—' },
        { k: t('task.col.status'), v: h(Tag, { text: STATUS_LABEL(t, detail.status), tone: STATUS_TONE(t, detail.status) }) },
        { k: t('task.col.priority'), v: detail.priority || 'P2' },
        { k: '创建时间', v: PM.env.fmtTime(detail.createdAt) },
        { k: t('task.col.updated'), v: PM.env.fmtTime(detail.updatedAt) },
        { k: '任务描述', v: detail.description || '—' },
      ] }),
      h('div', { className: 'pmc-row', style: { marginTop: 10 } },
        h('div', { style: { width: 180 } }, h(Select, { value: stageEdit || detail.stage || '', onChange: setStageEdit, options: stageOptions.map((s) => ({ value: s, label: s })), placeholder: '切换阶段' })),
        h(Button, { label: '更新阶段', icon: 'check', onClick: () => stageEdit && void act('task.stage', { taskId: detail.taskId, stage: stageEdit }, { success: '阶段已更新为 ' + stageEdit }) })))

    const traceTab = taskExecutions.length === 0
      ? h(Empty, { title: '尚无执行记录', hint: '执行轨迹由真实的 session/event 事件记录；先点击「继续执行」触发一次真实调用。' })
      : h('div', { className: 'pmc-col' }, taskExecutions.slice().reverse().map((execution) => h(Card, {
          key: execution.executionId,
          title: (execution.title || '执行') + ' · ' + U.code('kind', execution.kind),
          hint: PM.env.fmtTime(execution.at),
        },
        h(KV, { items: [
          { k: '状态', v: h(Tag, { text: U.code('status', execution.status), tone: execution.status === 'completed' ? 'ok' : execution.status === 'failed' ? 'danger' : 'blue' }) },
          { k: '会话', v: h('span', { className: 'pmc-mono' }, execution.sessionId || '—') },
          { k: '指令', v: h('div', { className: 'pmc-preview', style: { maxHeight: 120 } }, PM.env.clip(execution.prompt, 500)) },
        ] }),
        h('div', { className: 'pmc-col', style: { marginTop: 8, gap: 2 } },
          PM.list(execution.events).slice(-20).map((event, i) => h('div', { key: i, className: 'pmc-li-sub' },
            PM.env.fmtTime(event.at) + ' · ' + (event.type || '') + ' · ' + PM.env.clip(event.detail, 90)))))))

    const subtaskTab = PM.list(detail.subtasks).length === 0
      ? h(Empty, { title: '尚无子任务', hint: '让主 Agent 执行「分析并拆解」后，子任务会写回这里。' })
      : h(Table, { columns: [
          { key: 'subtaskId', label: 'ID', render: (row) => h('span', { className: 'pmc-mono' }, row.subtaskId) },
          { key: 'title', label: '子任务' },
          { key: 'status', label: '状态' },
          { key: 'dependsOn', label: '前置依赖', render: (row) => PM.list(row.dependsOn).join(', ') || '—' },
          { key: 'output', label: '输出成果', render: (row) => PM.env.clip(row.output, 40) || '—' },
        ], rows: PM.list(detail.subtasks).map((row) => ({ ...row, rowKey: row.subtaskId })) })

    const depsTab = PM.list(detail.dependencies).length === 0
      ? h(Empty, { title: '无任务依赖', hint: '当前任务不依赖其它任务。' })
      : h('div', null, PM.list(detail.dependencies).map((depId) => {
          const dep = tasks.find((x) => x.taskId === depId)
          return h('div', { key: depId, className: 'pmc-list-item' },
            h('div', { className: 'pmc-li-main' },
              h('div', { className: 'pmc-li-title' }, dep ? dep.title : depId),
              h('div', { className: 'pmc-li-sub' }, dep ? (dep.stage || '') + ' · ' + STATUS_LABEL_SAFE(dep.status) : '任务不存在')),
            dep ? h(Tag, { text: STATUS_LABEL(t, dep.status), tone: STATUS_TONE(t, dep.status) }) : null)
        }))

    const deliverableTab = taskDeliverables.length === 0
      ? h(Empty, { title: '尚无交付物', hint: '交付物由主 Agent 通过 pm_copilot 的 deliverable_add 或 prd_save 真实写入。' })
      : h('div', null, taskDeliverables.map((item) => h('div', { key: item.deliverableId, className: 'pmc-list-item' },
          h('div', { className: 'pmc-li-main' },
            h('div', { className: 'pmc-li-title' }, item.title),
            h('div', { className: 'pmc-li-sub pmc-mono' }, item.path || '—')),
          h(Button, { label: '打开', size: 'sm', icon: 'external', onClick: () => void PM.api.file(item.path, props.workspacePath).then((file) => props.toast(PM.env.clip(file.text, 200), 'ok')).catch((err) => props.toast(err.message, 'danger')) }))))

    // Lifecycle buttons go through the Host's dedicated actions, which validate
    // the current status. A raw `task.update {status}` would let a terminated or
    // completed task be moved again.
    const terminal = detail.status === 'done' || detail.status === 'terminated'
    const lifecycle = terminal
      ? [h('span', { key: 'end', className: 'pmc-dim', style: { fontSize: 11.5 } }, '该任务已' + (detail.status === 'done' ? '完成' : '终止') + '，不能再推进')]
      : [
          h(Button, {
            key: 'analyze', label: t('task.analyze'), icon: 'analysis',
            disabled: !agentReady,
            disabledReason: agentReady ? undefined : '主 Agent 不可用（sessionController 未挂载）',
            onClick: () => void act('task.analyze', { taskId: detail.taskId }, { label: '正在调用主 Agent 分析', success: '已指示主 Agent 分析并拆解，结果写入「任务分析」页（可点刷新查看）' }),
          }),
          h(Button, {
            key: 'run', label: t('task.run'), icon: 'play', variant: 'primary',
            disabled: !agentReady,
            disabledReason: agentReady ? undefined : '主 Agent 不可用（sessionController 未挂载）',
            onClick: () => void act('task.run', { taskId: detail.taskId, instruction: U.taskInstruction(detail) }, { label: '正在调用主 Agent 执行', success: '已发送执行指令，执行轨迹见于本抽屉的「执行轨迹」页签' }),
          }),
          detail.status === 'paused'
            ? h(Button, { key: 'resume', label: t('task.resume'), icon: 'play', onClick: () => void act('task.resume', { taskId: detail.taskId }, { success: '任务已恢复为待开始' }) })
            : h(Button, { key: 'pause', label: t('task.pause'), icon: 'pause', onClick: () => void act('task.pause', { taskId: detail.taskId }, { success: '任务已暂停' }) }),
          h(Button, { key: 'end', label: t('task.terminate'), variant: 'danger', onClick: () => void act('task.terminate', { taskId: detail.taskId }, { success: '任务已终止' }) }),
        ]

    detailTabs = h(Drawer, { title: detail.title, onClose: () => setDetailId(null), footer: h('div', { className: 'pmc-row', style: { flexWrap: 'wrap' } }, lifecycle) },
      h(Tabs, { items: [
        { key: 'basic', label: t('task.detail.basic') },
        { key: 'trace', label: t('task.detail.trace') },
        { key: 'subtasks', label: t('task.detail.subtasks') },
        { key: 'deps', label: t('task.detail.deps') },
        { key: 'deliverables', label: t('task.detail.deliverables') },
      ], active: tab, onChange: setTab }),
      tab === 'basic' ? basicTab
        : tab === 'trace' ? traceTab
        : tab === 'subtasks' ? subtaskTab
        : tab === 'deps' ? depsTab
        : deliverableTab)
  }

  return h('div', null, headBlock, formCard, listCard, detailTabs)
}
