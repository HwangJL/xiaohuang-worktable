/**
 * PM Copilot — Client half, part 45: 任务分析与拆解 / 专业 Skill / 项目知识中心.
 *
 * Render trees are built from local variables (one element per statement) so
 * each call site stays shallow and reviewable.
 */

/** Build one `h('div', { className }, ...children)` from a list, dropping nulls. */
function box(className, children, style) {
  const list = (Array.isArray(children) ? children : [children]).filter((x) => x !== null && x !== undefined && x !== false)
  const props = { className }
  if (style) props.style = style
  return h('div', props, list)
}

/** Render one completeness bucket as a titled line plus its real entries. */
function completenessRow(label, value, tone) {
  const items = PM.list(value)
  const entries = items.length === 0
    ? [h('div', { key: 'none', className: 'pmc-li-sub' }, '—')]
    : [h('div', { key: 'items', className: 'pmc-li-sub', style: { whiteSpace: 'pre-wrap' } },
        items.map((x) => '· ' + U.text(x)).join('\n'))]
  return h('div', null,
    h('div', { className: 'pmc-row', style: { justifyContent: 'space-between' } },
      h('span', { className: 'pmc-strong', style: { fontSize: 12 } }, label),
      h(Tag, { text: String(items.length), tone })),
    entries)
}

/** Join an array-ish value into readable text. */
function arrayText(value) {
  const items = PM.list(value)
  return items.length === 0 ? '—' : items.map((x) => U.text(x)).join('、')
}

/** Turn the stored plan into flow nodes; a string step is a step too. */
function planNodes(plan) {
  const items = PM.list(plan)
  return items.map((step, i) => ({
    id: 'p' + i,
    label: (typeof step === 'string' ? step : (step.step || step.title || step.action || ('步骤 ' + (i + 1)))),
    kind: i === 0 ? 'start' : (i === items.length - 1 ? 'end' : 'step'),
    actor: typeof step === 'object' ? step.owner : undefined,
  }))
}

/** Turn the stored plan into sequential flow edges. */
function planEdges(plan) {
  const items = PM.list(plan)
  const edges = []
  for (let i = 1; i < items.length; i += 1) edges.push({ from: 'p' + (i - 1), to: 'p' + i, label: '下一步' })
  return edges
}

PM.pages.analysis = function Analysis(props) {
  const { t, snapshot, run } = props
  const tasks = PM.list(snapshot && snapshot.tasks)
  const [taskId, setTaskId] = React.useState('')
  const task = U.pickTask(snapshot, taskId)
  const analysis = task ? task.analysis : null
  const [instruction, setInstruction] = React.useState('')
  const [running, setRunning] = React.useState(false)

  const runAnalysis = async () => {
    if (!task) { props.toast('请先创建任务', 'danger'); return }
    setRunning(true)
    try {
      const base = U.taskInstruction(task)
      const text = instruction.trim() === ''
        ? base + '\n\n请对这个任务执行完整分析：需求理解、工作阶段识别（可多阶段）、信息完整性判断、任务拆解、执行计划，并推荐专业 Skill。完成后用 pm_copilot 工具写回。'
        : base + '\n\n' + instruction.trim()
      await run('task.analyze', { taskId: task.taskId, instruction: text },
        { label: '正在调用主 Agent 分析', success: '已指示主 Agent 分析并拆解' })
    } catch { /* toast */ } finally { setRunning(false) }
  }

  const head = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('an.title')), h('p', null, t('an.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h('div', { style: { width: 260 } }, h(U.TaskSelect, { tasks, value: task ? task.taskId : '', onChange: (v) => setTaskId(v) })),
    h(Button, { label: t('an.runAnalysis'), icon: 'analysis', variant: 'primary', disabled: running || !task, onClick: () => void runAnalysis() }))

  const out = [head]

  if (!task) {
    out.push(h(Card, { key: 'no-task', style: { marginTop: 12 } },
      h(Empty, { title: '还没有任务', hint: '先到任务中心创建一个任务，再让主 Agent 分析它。' })))
    return h('div', null, out)
  }

  if (!analysis) {
    out.push(h(Card, { key: 'none', style: { marginTop: 12 } },
      h(Banner, { tone: 'info', text: t('an.noAnalysis') + ' — ' + t('an.noAnalysisHint') }),
      h('div', { style: { marginTop: 10 } },
        h(Field, { label: '想补充给主 Agent 的说明（可选）' },
          h(Textarea, { value: instruction, onChange: setInstruction, placeholder: '例如：重点关注异常场景与计费规则', rows: 3 })))))
    return h('div', null, out)
  }

  const stageList = PM.list(analysis.stages)
  const stageRows = stageList.length === 0
    ? [h(Empty, { key: 'none', title: '未识别阶段', hint: '主 Agent 未写回阶段信息。' })]
    : stageList.map((stage, i) => {
        const name = typeof stage === 'string' ? stage : (stage.name || stage.stage || '阶段')
        const reason = typeof stage === 'object' && stage.reason ? stage.reason : ''
        const status = typeof stage === 'object' && stage.status ? String(stage.status) : ''
        return h('div', { key: 'st' + i, className: 'pmc-list-item' },
          h('div', { className: 'pmc-li-main' },
            h('div', { className: 'pmc-li-title' }, name),
            reason ? h('div', { className: 'pmc-li-sub' }, reason) : null),
          status === ''
            ? h(Tag, { text: '未标注状态', tone: 'mute' })
            : h(Tag, { text: status, tone: 'blue' }))
      })

  const completenessRows = [
    completenessRow(t('an.known'), analysis.completeness && analysis.completeness.knownKnown, 'ok'),
    completenessRow(t('an.retrieved'), analysis.completeness && analysis.completeness.retrieved, 'blue'),
    completenessRow(t('an.assumptions'), analysis.completeness && analysis.completeness.assumptions, 'warn'),
    completenessRow(t('an.toConfirm'), analysis.completeness && analysis.completeness.toConfirm, 'warn'),
    completenessRow(t('an.risks'), analysis.completeness && analysis.completeness.risks, 'danger'),
  ]

  const subtaskRows = PM.list(task.subtasks).map((row) => ({ ...row, rowKey: row.subtaskId || row.title }))
  const subtaskColumns = [
    { key: 'subtaskId', label: 'ID', render: (row) => h('span', { className: 'pmc-mono' }, row.subtaskId || '—') },
    { key: 'title', label: '子任务', render: (row) => U.text(row.title) },
    { key: 'status', label: '执行状态', render: (row) => (row.status ? String(row.status) : h(Tag, { text: '未标注', tone: 'mute' })) },
    { key: 'dependsOn', label: '前置依赖', render: (row) => PM.list(row.dependsOn).join(' → ') || '无' },
    { key: 'output', label: '输出成果', render: (row) => (row.output ? U.text(row.output) : '—') },
  ]
  const subtaskBody = subtaskRows.length === 0
    ? h(Empty, { title: '暂无子任务', hint: '主 Agent 完成拆解后会通过 task_subtasks_save 写回。' })
    : h(Table, { columns: subtaskColumns, rows: subtaskRows })

  const planItems = PM.list(analysis.plan)
  const planSteps = planItems.map((step, i) => {
    const title = typeof step === 'string' ? step : (step.step || step.title || step.action || ('步骤 ' + (i + 1)))
    const action = typeof step === 'object' && step.action ? step.action : ''
    const status = typeof step === 'object' && step.status ? String(step.status) : ''
    return h('div', { key: 'pl' + i, className: 'pmc-list-item' },
      h('div', { className: 'pmc-li-main' },
        h('div', { className: 'pmc-li-title' }, (i + 1) + '. ' + title),
        action && action !== title ? h('div', { className: 'pmc-li-sub' }, action) : null),
      status === '' ? h(Tag, { text: '未标注状态', tone: 'mute' })
        : h(Tag, { text: status, tone: status === '已完成' ? 'ok' : 'mute' }))
  })
  const planBody = planItems.length === 0
    ? h(Empty, { title: '暂无执行计划' })
    : h('div', null, h(Flow, { nodes: planNodes(planItems), edges: planEdges(planItems) }), box(null, planSteps, { marginTop: 8 }))

  const understandingCard = h(Card, { title: t('an.understanding'), hint: '由主 Agent 写回' },
    h(KV, { items: [
      { k: t('an.raw'), v: analysis.requirement && analysis.requirement.raw },
      { k: t('an.core'), v: analysis.requirement && analysis.requirement.coreProblem },
      { k: t('an.goal'), v: analysis.requirement && analysis.requirement.goal },
      { k: t('an.value'), v: analysis.requirement && analysis.requirement.businessValue },
      { k: t('an.scenes'), v: arrayText(analysis.requirement && analysis.requirement.scenarios) },
      { k: t('an.roles'), v: arrayText(analysis.requirement && analysis.requirement.roles) },
    ] }))

  const stageCard = h(Card, { title: t('an.stage'), hint: stageList.length + ' 个阶段' },
    stageList.length === 0 ? stageRows[0] : box('pmc-col', stageRows, { gap: 6 }))
  const completenessCard = h(Card, { title: t('an.completeness') }, box('pmc-col', completenessRows, { gap: 6 }))

  out.push(box('pmc-col', [
    understandingCard,
    box('pmc-split', [stageCard, completenessCard]),
    h(Card, { title: t('an.breakdown'), hint: subtaskRows.length + ' 个子任务' }, subtaskBody),
    h(Card, { title: t('an.plan'), hint: '执行顺序与下一步动作' }, planBody),
  ], { gap: 12 }))

  return h('div', null, out)
}

PM.pages.skills = function Skills(props) {
  const { t, snapshot, run } = props
  const skillsPayload = (snapshot && snapshot.skills) || { available: false, items: [] }
  const items = PM.list(skillsPayload.items)
  const usage = (snapshot && snapshot.skillUsage) || {}
  const [query, setQuery] = React.useState('')
  const [detail, setDetail] = React.useState(null)
  const [detailError, setDetailError] = React.useState(null)
  const [selected, setSelected] = React.useState([])
  const [instruction, setInstruction] = React.useState('')
  const [composing, setComposing] = React.useState(false)

  const categoryOf = (skill) => {
    const hay = (skill.name + ' ' + (skill.description || '') + ' ' + (skill.whenToUse || '')).toLowerCase()
    if (/质量|检查|quality|lint|一致性|校验/.test(hay)) return '质量管理'
    if (/流程|规则|业务|business|process|rule/.test(hay)) return '业务分析'
    if (/架构|设计|模型|接口|design|architecture|api/.test(hay)) return '产品设计'
    if (/需求|requirement|prd|文档|review|评审|验收/.test(hay)) return '文档交付'
    return '需求分析'
  }

  const filtered = items.filter((skill) => !query || (skill.name + ' ' + (skill.description || '')).toLowerCase().includes(query.toLowerCase()))

  const openDetail = async (skill) => {
    setDetail({ skill, content: null })
    setDetailError(null)
    try {
      const value = await run('skill.detail', { name: skill.name }, { label: '正在读取 Skill 内容' })
      setDetail({ skill, content: (value && value.content) || '' })
    } catch (err) {
      // A failed read must leave the "loading" state, otherwise the drawer spins
      // forever behind an error banner.
      setDetail({ skill, content: '' })
      setDetailError(err.message || '读取失败')
    }
  }

  const invokeCombined = async () => {
    if (selected.length === 0) { props.toast('请先选择至少一个 Skill', 'danger'); return }
    setComposing(true)
    try {
      const picked = U.pickTask(snapshot, null)
      const text = '请按员工守则执行组合分析，并依次使用以下专业 Skill：\n' + selected.map((name, i) => (i + 1) + '. ' + name).join('\n') +
        '\n\n任务上下文：' + (picked ? U.taskInstruction(picked) : '（当前没有任务，请先判断任务并创建）') +
        '\n\n要求：每个 Skill 的输出单独成段，互相校验一致性；完成后用 pm_copilot 工具写回驾驶舱（analysis_save / task_business_save / task_solution_save / prd_save）。' +
        (instruction.trim() ? '\n\n补充说明：' + instruction.trim() : '')
      await U.prompt(props, text, { kind: 'skill.combine', title: '组合 Skill 执行', label: '正在调用主 Agent 组合执行' })
      setSelected([])
      setInstruction('')
    } catch { /* toast */ } finally { setComposing(false) }
  }

  const head = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('sk.title')), h('p', null, t('sk.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h('span', { className: 'pmc-chip', style: { background: 'var(--pmc-blue-soft)', color: 'var(--pmc-blue-strong)' } },
      t('sk.count') + ': ' + items.length))

  const warn = !skillsPayload.available
    ? h('div', { style: { marginBottom: 10 } }, h(Banner, { tone: 'warn', text: t('common.unverified') + '：' + (skillsPayload.error || 'ctx.skills 未挂载') }))
    : null

  const columns = [
    { key: 'select', label: '', render: (row) => h('input', {
        type: 'checkbox', checked: selected.includes(row.name),
        onChange: () => setSelected((prev) => prev.includes(row.name) ? prev.filter((x) => x !== row.name) : prev.concat([row.name])) }) },
    { key: 'name', label: 'Skill', render: (row) => h('div', null,
        h('div', { className: 'pmc-strong' }, row.name),
        h('div', { className: 'pmc-li-sub' }, PM.env.clip(row.description, 70))) },
    { key: 'category', label: '归类（启发式）', render: (row) => h('span', { title: '按名称与描述关键词自动归类，仅供浏览参考，不是 DSH 的正式分类字段' },
        h(Tag, { text: categoryOf(row), tone: 'mute' })) },
    { key: 'source', label: t('sk.source'), render: (row) => h('span', { className: 'pmc-mono' }, row.source || '—') },
    { key: 'provider', label: t('sk.provider'), render: (row) => h('span', { className: 'pmc-mono' }, row.provider || '—') },
    { key: 'count', label: t('sk.invocations'), render: (row) => (usage[row.name] ? String(usage[row.name].count) : '0') },
    { key: 'lastAt', label: t('sk.lastAt'), render: (row) => (usage[row.name] && usage[row.name].lastAt ? PM.env.fmtTime(usage[row.name].lastAt) : '—') },
    { key: 'actions', label: '', render: (row) => h(Button, { label: t('sk.view'), size: 'sm', icon: 'external', onClick: () => void openDetail(row) }) },
  ]
  const listBody = items.length === 0
    ? h(Empty, { title: t('sk.emptyTitle'), hint: t('sk.emptyHint') })
    : h(Table, { columns, rows: filtered.map((row) => ({ ...row, rowKey: row.name })), onRowClick: (row) => void openDetail(row) })

  const listCard = h(Card, { title: t('nav.skills'), hint: t('sk.versionNote') },
    h('div', { className: 'pmc-row', style: { marginBottom: 10 } },
      h('div', { style: { flex: 1, minWidth: 200 } }, h(Input, { value: query, onChange: setQuery, placeholder: t('sk.search') }))),
    listBody)

  const chips = selected.length === 0
    ? [h('span', { key: 'none', className: 'pmc-dim' }, '尚未选择 Skill')]
    : selected.map((name) => h(Tag, { key: name, text: name, tone: 'violet' }))
  const combineTarget = U.pickTask(snapshot, null)
  const invokeCard = h(Card, { title: t('sk.invoke'), hint: '多个 Skill 组合执行会真实调用主 Agent', style: { marginTop: 12 } },
    box('pmc-col', [
      h('div', { key: 'chips', className: 'pmc-row' }, chips),
      h('div', { key: 'target', className: 'pmc-dim', style: { fontSize: 11.5 } },
        combineTarget === undefined
          ? '当前没有可关联的任务：执行时会让主 Agent 先判断任务范围。'
          : '组合执行将作用于任务：' + combineTarget.taskId + ' · ' + combineTarget.title),
      h(Field, { key: 'note', label: '补充说明（可选）' }, h(Textarea, { value: instruction, onChange: setInstruction, rows: 2 })),
      h(Button, {
        key: 'go', label: composing ? '发送中…' : '组合执行所选 Skill', icon: 'play', variant: 'primary',
        disabled: composing || selected.length === 0,
        disabledReason: selected.length === 0 ? '先在列表里勾选至少一个 Skill' : undefined,
        onClick: () => void invokeCombined(),
      }),
    ]))

  const detailLabels = { description: '简介', whenToUse: '何时使用', source: '来源', provider: '提供方', path: '指令文件', invocation: '可调用面' }
  const drawerBody = detail
    ? box('pmc-col', [
        h(KV, { key: 'kv', items: [
          { k: detailLabels.description, v: detail.skill.description },
          { k: detailLabels.whenToUse, v: detail.skill.whenToUse || '—' },
          { k: detailLabels.source, v: detail.skill.source },
          { k: detailLabels.provider, v: detail.skill.provider },
          { k: detailLabels.path, v: h('span', { className: 'pmc-mono' }, detail.skill.path || '—') },
          { k: detailLabels.invocation, v: detail.skill.invocation
              ? ((detail.skill.invocation.modelInvocable ? '模型' : '') + (detail.skill.invocation.userInvocable ? (detail.skill.invocation.modelInvocable ? '+用户' : '用户') : '') || '—')
              : '—' },
        ] }),
        detailError ? h(Banner, { key: 'err', tone: 'danger', text: detailError }) : null,
        detail.content === null
          ? h('div', { key: 'loading', className: 'pmc-dim' }, t('common.loading'))
          : h('div', { key: 'body', className: 'pmc-preview', style: { maxHeight: 420 } }, detail.content),
      ])
    : null

  const drawer = detail
    ? h(Drawer, { title: detail.skill.name, onClose: () => setDetail(null),
        footer: h(Button, {
          label: '加入组合执行', icon: 'play',
          disabled: selected.includes(detail.skill.name),
          disabledReason: selected.includes(detail.skill.name) ? '该 Skill 已在组合里' : undefined,
          onClick: () => {
            // Append instead of replacing: the previous selections are part of
            // the combination the user is building.
            setSelected((prev) => (prev.includes(detail.skill.name) ? prev : prev.concat([detail.skill.name])))
            setDetail(null)
          },
        }) },
        drawerBody)
    : null

  return box(null, [head, warn, listCard, invokeCard, drawer])
}

PM.pages.knowledge = function Knowledge(props) {
  const { t, snapshot, run, workspacePath } = props
  const stats = (snapshot && snapshot.knowledgeStats) || {}
  const [query, setQuery] = React.useState('')
  const [type, setType] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [results, setResults] = React.useState(null)
  const [searching, setSearching] = React.useState(false)
  const [preview, setPreview] = React.useState(null)
  const [ingestOpen, setIngestOpen] = React.useState(false)
  const emptyForm = { title: '', type: 'summary', project: '', summary: '', body: '', sources: '', tags: '', status: '待确认' }
  const [form, setForm] = React.useState(emptyForm)

  const search = async () => {
    setSearching(true)
    try {
      const value = await run('knowledge.search', {
        query: query.trim(), type: type || undefined, status: status || undefined, limit: 40,
      }, { label: '正在检索真实文件' })
      setResults(PM.list(value && value.items ? value.items : value))
    } catch { /* toast */ } finally { setSearching(false) }
  }

  const openFile = async (item) => {
    try {
      const file = await PM.api.file(item.path, workspacePath)
      setPreview({ item, text: file.text, truncated: file.truncated })
    } catch (err) { props.toast(err.message || '无法打开该文件', 'danger') }
  }

  const ingest = async () => {
    if (form.title.trim() === '' || form.summary.trim() === '') { props.toast('标题与摘要必填', 'danger'); return }
    try {
      const value = await run('knowledge.ingest', {
        title: form.title, type: form.type, project: form.project || 'xiaohuang-mode',
        summary: form.summary, body: form.body,
        sources: form.sources ? form.sources.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : [],
        tags: form.tags ? form.tags.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : [],
        status: form.status,
      }, { label: '正在写入知识库', success: '知识页面已按 SCHEMA 写入 kb/wiki' })
      props.toast('写入路径：' + (value && value.path ? value.path : '—'), 'ok')
      setIngestOpen(false)
      setForm(emptyForm)
      await search()
    } catch { /* toast */ }
  }

  const head = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('kn.title')), h('p', null, t('kn.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h(Button, { label: t('kn.ingest'), icon: 'plus', variant: 'primary', onClick: () => setIngestOpen(true) }))

  const missingBanner = (stats.wikiCount === 0 && !stats.indexPresent)
    ? h('div', { style: { marginBottom: 12 } }, h(Banner, { tone: 'warn', text: t('kn.missing') + ' — ' + t('kn.missingHint') }))
    : null

  const metricTiles = [
    h(Metric, { key: 'wiki', label: t('kn.wiki'), value: stats.wikiCount || 0, hint: 'kb/wiki 下的真实页面' }),
    h(Metric, { key: 'raw', label: t('kn.raw'), value: stats.rawCount || 0, hint: 'kb/raw 下的原始资料', tone: 'ok' }),
    h(Metric, { key: 'tpl', label: t('kn.templates'), value: stats.templateCount || 0, hint: 'kb/templates 模板' }),
    h(Metric, { key: 'index', label: 'index.md', value: stats.indexPresent ? '已建立' : '缺失', tone: stats.indexPresent ? 'ok' : 'warn', hint: 'kb/wiki/index.md' }),
    h(Metric, { key: 'log', label: 'log.md', value: stats.logPresent ? '已建立' : '缺失', tone: stats.logPresent ? 'ok' : 'warn', hint: 'kb/wiki/log.md' }),
  ]
  const metricsBlock = h('div', { className: 'pmc-grid pmc-metrics', style: { marginBottom: 12 } }, metricTiles)

  const searchCard = h(Card, { title: t('kn.query'), hint: '真实文件检索，非前端模拟' },
    h('div', { className: 'pmc-row' },
      h('div', { style: { flex: 1, minWidth: 200 } }, h(Input, { value: query, onChange: setQuery, placeholder: '关键词：例如 计费、流程、决策 ID' })),
      h(Select, { value: type, onChange: setType, options: ['entity', 'concept', 'decision', 'summary', 'comparison', 'issue', 'question', 'raw', 'doc'].map((x) => ({ value: x, label: x })), placeholder: '全部类型' }),
      h(Select, { value: status, onChange: setStatus, options: ['正式', '待确认', '历史'].map((x) => ({ value: x, label: x })), placeholder: '全部状态' }),
      h(Button, { label: t('kn.search'), icon: 'search', variant: 'primary', disabled: searching, onClick: () => void search() })))

  const columns = [
    { key: 'title', label: '名称', render: (row) => h('div', null,
        h('div', { className: 'pmc-strong' }, row.title),
        h('div', { className: 'pmc-li-sub pmc-mono' }, PM.env.baseName(row.path))) },
    { key: 'type', label: '类型', render: (row) => h(Tag, { text: row.type || row.kind || '—', tone: 'blue' }) },
    { key: 'project', label: '项目' },
    { key: 'status', label: '状态', render: (row) => h(Tag, { text: row.status || '—', tone: row.status === '正式' ? 'ok' : row.status === '待确认' ? 'warn' : 'mute' }) },
    { key: 'snippet', label: '摘要', render: (row) => PM.env.clip(row.snippet, 60) },
    { key: 'updatedAt', label: '更新时间', render: (row) => PM.env.fmtDate(row.updatedAt) },
    { key: 'open', label: '来源', render: (row) => h(Button, { label: '打开', size: 'sm', icon: 'external', onClick: () => void openFile(row) }) },
  ]
  const rows = PM.list(results).map((item) => ({ ...item, rowKey: item.path || item.title }))
  const resultBody = results === null
    ? h(Empty, { title: '输入关键词开始检索', hint: '检索范围：kb/wiki、kb/raw、kb/SCHEMA.md 以及 roots.json 声明的额外目录。' })
    : rows.length === 0
      ? h(Empty, { title: '没有命中', hint: '当前关键词在真实文件中没有匹配；知识库可能尚未沉淀相关内容。' })
      : h(Table, { columns, rows, onRowClick: (row) => void openFile(row) })
  const resultCard = h(Card, { title: t('kn.result'), hint: results === null ? '尚未检索' : rows.length + ' 条', style: { marginTop: 12 } }, resultBody)

  const ingestBody = box('pmc-col', [
    h(Banner, { key: 'note', tone: 'info', text: '写入遵循 kb/SCHEMA.md：新建 kb/wiki/<type>/<ID>-<slug>.md，并追加 index.md 与 log.md；不会覆盖任何正式页面。手工沉淀默认「待确认」——只有确认过的内容才应标为「正式」。' }),
    h(Field, { key: 'title', label: '标题' }, h(Input, { value: form.title, onChange: (v) => setForm({ ...form, title: v }) })),
    h('div', { key: 'row1', className: 'pmc-grid', style: { gridTemplateColumns: '1fr 1fr' } }, [
      h(Field, { key: 'type', label: '类型' }, h(Select, { value: form.type, onChange: (v) => setForm({ ...form, type: v }), options: ['entity', 'concept', 'decision', 'summary', 'comparison', 'issue', 'question'].map((x) => ({ value: x, label: x })) })),
      h(Field, { key: 'status', label: '状态' }, h(Select, { value: form.status, onChange: (v) => setForm({ ...form, status: v }), options: ['待确认', '正式', '历史'].map((x) => ({ value: x, label: x })) })),
      h(Field, { key: 'project', label: '项目' }, h(Input, { value: form.project, onChange: (v) => setForm({ ...form, project: v }), placeholder: 'xiaohuang-mode / 业务项目名' })),
      h(Field, { key: 'tags', label: '标签（逗号分隔）' }, h(Input, { value: form.tags, onChange: (v) => setForm({ ...form, tags: v }) })),
    ]),
    h(Field, { key: 'summary', label: '摘要（1–3 行）' }, h(Textarea, { value: form.summary, onChange: (v) => setForm({ ...form, summary: v }), rows: 2 })),
    h(Field, { key: 'body', label: '正文' }, h(Textarea, { value: form.body, onChange: (v) => setForm({ ...form, body: v }), rows: 8 })),
    h(Field, { key: 'sources', label: '来源（每行一个）' }, h(Textarea, { value: form.sources, onChange: (v) => setForm({ ...form, sources: v }), rows: 2 })),
  ])
  const ingestDrawer = ingestOpen
    ? h(Drawer, { title: t('kn.ingest'), onClose: () => setIngestOpen(false),
        footer: h(Button, { label: t('common.save'), icon: 'check', variant: 'primary', onClick: () => void ingest() }) }, ingestBody)
    : null

  const previewBody = preview
    ? box('pmc-col', [
        h(KV, { key: 'kv', items: [
          { k: '路径', v: h('span', { className: 'pmc-mono' }, preview.item.path) },
          { k: '类型', v: U.code('knowledgeType', preview.item.type || preview.item.kind) },
          { k: '状态', v: preview.item.status || '—' },
        ] }),
        preview.truncated ? h(Banner, { key: 'cut', tone: 'warn', text: '该文件超过 512KB，预览只显示前面一部分；完整内容请用文件管理器打开原文件。' }) : null,
        h('div', { key: 'text', className: 'pmc-preview' }, preview.text),
      ])
    : null
  const previewDrawer = preview
    ? h(Drawer, { title: preview.item.title, onClose: () => setPreview(null) }, previewBody)
    : null

  return box(null, [head, missingBanner, metricsBlock, searchCard, resultCard, ingestDrawer, previewDrawer])
}
