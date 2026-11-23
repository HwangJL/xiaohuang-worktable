/**
 * PM Copilot — Client half, part 50: 业务分析工作台 / 产品方案设计中心.
 *
 * Both pages are readers of the main Agent's own analysis records; every view
 * is backed by `task.business` or `task.solution` written through the
 * `pm_copilot` tool, so an empty state always means "the Agent has not written
 * this yet", never "we left it blank on purpose".
 */

/** Human-readable list from an array of strings or objects with a name field. */
function namesOf(value) {
  const items = PM.list(value)
  return items.length === 0 ? '—' : items.map((x) => (typeof x === 'string' ? x : (x.name || x.label || x.title || JSON.stringify(x)))).join('、')
}

/** Group business rules by their declared type. */
function groupRules(rules) {
  const groups = new Map()
  for (const rule of PM.list(rules)) {
    const type = rule.type || '未分类规则'
    if (!groups.has(type)) groups.set(type, [])
    groups.get(type).push(rule)
  }
  return [...groups.entries()].map(([type, items]) => ({ type, items }))
}

PM.pages.business = function Business(props) {
  const { t, snapshot, run } = props
  const tasks = PM.list(snapshot && snapshot.tasks)
  const [taskId, setTaskId] = React.useState('')
  const [view, setView] = React.useState('roles')
  const [busy, setBusy] = React.useState(false)
  const task = U.pickTask(snapshot, taskId)
  const business = (task && task.business) || null

  const askAnalysis = async () => {
    if (!task) { props.toast('请先创建任务', 'danger'); return }
    setBusy(true)
    try {
      await U.prompt(props, U.taskInstruction(task) +
        '\n\n请执行完整的【业务分析】：业务角色（职责/权限/上下游）、业务对象（属性/关联）、业务流程（正常/异常/状态流转/跨系统）、业务规则（准入/校验/计算/权限/状态/异常/互斥）、系统边界（职责/数据归属/接口/协同）、风险与问题。\n完成后用 pm_copilot 的 task_business_save 写回驾驶舱。',
        { kind: 'business.analysis', title: '业务分析', taskId: task.taskId, where: '「业务分析」页', label: '正在调用主 Agent 做业务分析' })
    } catch { /* toast */ } finally { setBusy(false) }
  }

  const head = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('ba.title')), h('p', null, t('ba.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h('div', { style: { width: 260 } }, h(U.TaskSelect, { tasks, value: task ? task.taskId : '', onChange: (v) => setTaskId(v) }),
    ),
    h(Button, {
      label: busy ? '发送中…' : '让主 Agent 做业务分析', icon: 'business', variant: 'primary',
      disabled: busy || !task,
      disabledReason: !task ? '当前没有任务可分析' : undefined,
      onClick: () => void askAnalysis(),
    }))

  if (!task) {
    return h('div', null, head, h(Card, { style: { marginTop: 12 } }, h(Empty, { title: '没有可分析的任务' })))
  }
  if (!business) {
    // No tabs before data exists: switching them would change nothing, so the
    // page shows one honest empty state and the way to fill it.
    return h('div', null, head,
      h(Card, { style: { marginTop: 12 } },
        h(Banner, { tone: 'info', text: t('ba.none') + ' — ' + t('ba.noneHint') }),
        h('div', { style: { marginTop: 10 } }, h(Button, { label: '让主 Agent 做业务分析', icon: 'business', variant: 'primary', disabled: busy, onClick: () => void askAnalysis() }))))
  }

  const tabs = h(Tabs, { items: [
    { key: 'roles', label: t('ba.roles') + ' ' + PM.list(business.roles).length },
    { key: 'objects', label: t('ba.objects') + ' ' + PM.list(business.objects).length },
    { key: 'process', label: t('ba.process') + ' ' + PM.list(business.process && business.process.nodes).length },
    { key: 'rules', label: t('ba.rules') + ' ' + PM.list(business.rules).length },
    { key: 'boundary', label: t('ba.boundary') + ' ' + PM.list(business.boundary).length },
    { key: 'risks', label: t('ba.risks') + ' ' + PM.list(business.risks).length },
  ], active: view, onChange: setView })

  const roleColumns = [
    { key: 'name', label: '角色', render: (row) => h('span', { className: 'pmc-strong' }, row.name || row.label || '—') },
    { key: 'responsibility', label: '职责', render: (row) => row.responsibility || row.duty || '—' },
    { key: 'permissions', label: '操作权限', render: (row) => namesOf(row.permissions) },
    { key: 'relations', label: '上下游关系', render: (row) => namesOf(row.relations || row.upstream) },
  ]
  const roleBody = PM.list(business.roles).length === 0
    ? h(Empty, { title: '暂无业务角色' })
    : h(Table, { columns: roleColumns, rows: PM.list(business.roles).map((row, i) => ({ ...row, rowKey: row.roleId || row.name || String(i) })) })

  const objectCards = PM.list(business.objects).length === 0
    ? [h(Empty, { key: 'none', title: '暂无业务对象' })]
    : PM.list(business.objects).map((obj, i) => h(Card, { key: obj.objectId || obj.name || i, title: obj.name || ('对象 ' + (i + 1)) },
        h(KV, { items: [
          { k: '对象属性', v: namesOf(obj.attributes || obj.fields) },
          { k: '关联关系', v: namesOf(obj.relations) },
        ] })))

  const processNodes = (business.process && business.process.nodes) || []
  const processEdges = (business.process && business.process.edges) || []
  const processBody = PM.list(processNodes).length === 0
    ? h(Empty, { title: '暂无业务流程', hint: '让主 Agent 完成业务流程分析后写回 business.process。' })
    : h(Flow, { nodes: processNodes, edges: processEdges })
  const processExtra = h(KV, { items: [
    { k: '异常流程', v: namesOf(business.process && business.process.exceptions) },
    { k: '状态流转', v: namesOf(business.process && business.process.states) },
    { k: '跨系统流程', v: namesOf(business.process && business.process.crossSystem) },
  ] })

  const ruleGroups = groupRules(business.rules)
  const ruleCards = ruleGroups.length === 0
    ? [h(Card, { key: 'none' }, h(Empty, { title: '暂无业务规则', hint: '让主 Agent 执行「业务规则分析」后写回 business.rules。' }))]
    : ruleGroups.map((group) => {
        const rows = group.items.map((rule, i) => h('div', { key: rule.ruleId || i, className: 'pmc-list-item' },
          h('div', { className: 'pmc-li-main' },
            h('div', { className: 'pmc-li-title' }, rule.text || rule.rule || JSON.stringify(rule)),
            h('div', { className: 'pmc-li-sub' }, (rule.ruleId ? rule.ruleId + ' · ' : '') + (rule.source ? '来源：' + rule.source : '来源未标注'))),
          rule.conflict ? h(Tag, { text: '冲突', tone: 'danger' }) : null))
        return h(Card, { key: group.type, title: group.type, hint: group.items.length + ' 条' }, box(null, rows))
      })

  const boundaryColumns = [
    { key: 'system', label: '系统', render: (row) => h('span', { className: 'pmc-strong' }, row.system || row.name || '—') },
    { key: 'responsibility', label: '功能职责', render: (row) => row.responsibility || row.duty || '—' },
    { key: 'dataOwnership', label: '数据归属', render: (row) => row.dataOwnership || row.data || '—' },
    { key: 'interfaces', label: '接口关系', render: (row) => namesOf(row.interfaces || row.apis) },
    { key: 'collaboration', label: '协同方式', render: (row) => row.collaboration || row.mode || '—' },
  ]
  const boundaryRows = PM.list(business.boundary).map((row, i) => ({ ...row, rowKey: row.systemId || row.system || String(i) }))
  const boundaryBody = boundaryRows.length === 0
    ? h(Empty, { title: '暂无系统边界分析' })
    : h(Table, { columns: boundaryColumns, rows: boundaryRows })
  // The cockpit only draws edges the Agent actually wrote; a node-only diagram
  // would imply relationships that do not exist in the data.
  const crossSystem = PM.list(business.process && business.process.crossSystem)
  const boundaryHandles = boundaryRows.map((row, i) => ({ key: 's' + i, label: row.system || row.name || ('系统 ' + (i + 1)), row }))
  const boundaryEdges = crossSystem
    .map((edge) => {
      const fromIndex = boundaryHandles.findIndex((candidate) => (candidate.row.system || candidate.row.name) === edge.from)
      const toIndex = boundaryHandles.findIndex((candidate) => (candidate.row.system || candidate.row.name) === edge.to)
      if (fromIndex === -1 || toIndex === -1) return null
      return { from: 's' + fromIndex, to: 's' + toIndex, label: edge.label || edge.via }
    })
    .filter((edge) => edge !== null)
  const boundaryDiagram = boundaryRows.length === 0
    ? h(Empty, { title: '暂无系统边界数据' })
    : h('div', null,
      h(Flow, {
        nodes: boundaryHandles.map((candidate, i) => ({ id: 's' + i, label: candidate.label, kind: 'system', actor: candidate.row.dataOwnership })),
        edges: boundaryEdges,
      }),
      boundaryEdges.length === 0
        ? h('div', { className: 'pmc-dim', style: { fontSize: 11.5, marginTop: 6 } },
            '主 Agent 尚未写回跨系统交互关系（process.crossSystem），因此这里只有系统节点，没有连线。')
        : null)

  const riskRows = PM.list(business.risks).map((risk, i) => h('div', { key: risk.riskId || i, className: 'pmc-list-item' },
    h('div', { className: 'pmc-li-main' },
      h('div', { className: 'pmc-li-title' }, risk.title || risk.risk || ('风险 ' + (i + 1))),
      h('div', { className: 'pmc-li-sub' }, risk.detail || risk.description || '—')),
    h(Tag, { text: risk.severity ? U.code('severity', risk.severity) : '未标注等级', tone: risk.severity ? U.severityTone(risk.severity) : 'mute' })))
  const riskBody = riskRows.length === 0
    ? h(Empty, { title: '暂无风险记录', hint: '风险由主 Agent 在业务分析中自动提取。' })
    : box(null, riskRows)

  const viewBody = view === 'roles' ? h(Card, { title: t('ba.roles'), hint: PM.list(business.roles).length + ' 个角色' }, roleBody)
    : view === 'objects' ? box('pmc-col', objectCards)
    : view === 'process' ? box('pmc-col', [
        h(Card, { key: 'flow', title: t('ba.process'), hint: PM.list(processNodes).length + ' 个节点' }, processBody),
        h(Card, { key: 'extra', title: '异常流程与状态流转' }, processExtra),
      ])
    : view === 'rules' ? box('pmc-col', ruleCards)
    : view === 'boundary' ? box('pmc-col', [
        h(Card, { key: 'table', title: t('ba.boundary'), hint: '职责 / 数据归属 / 接口 / 协同' }, boundaryBody),
        h(Card, { key: 'diagram', title: '系统协同关系' }, boundaryDiagram),
      ])
    : h(Card, { title: t('ba.risks'), hint: PM.list(business.risks).length + ' 项' }, riskBody)

  return h('div', null, head, tabs, viewBody)
}

PM.pages.solution = function Solution(props) {
  const { t, snapshot } = props
  const tasks = PM.list(snapshot && snapshot.tasks)
  const [taskId, setTaskId] = React.useState('')
  const [activeNode, setActiveNode] = React.useState(null)
  const [draftOpen, setDraftOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const task = U.pickTask(snapshot, taskId)
  const solution = (task && task.solution) || null
  const business = (task && task.business) || null

  const askDesign = async () => {
    if (!task) { props.toast('请先选择任务', 'danger'); return }
    try {
      const text = U.taskInstruction(task) +
        '\n\n请执行【产品方案设计】：产品定位、建设目标、产品架构、功能架构（树形）、模块结构、数据模型、接口设计、权限设计、MVP 范围与版本规划。完成后用 pm_copilot 的 task_solution_save 写回驾驶舱。' +
        (draft.trim() ? '\n\n补充：' + draft.trim() : '')
      await U.prompt(props, text, { kind: 'solution.design', title: '产品方案设计', taskId: task.taskId, label: '正在调用主 Agent 设计方案' })
      setDraftOpen(false)
      setDraft('')
    } catch { /* toast */ }
  }

  const head = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('so.title')), h('p', null, t('so.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h('div', { style: { width: 260 } }, h(U.TaskSelect, { tasks, value: task ? task.taskId : '', onChange: (v) => setTaskId(v) })),
    h(Button, { label: '让主 Agent 设计', icon: 'solution', variant: 'primary', onClick: () => setDraftOpen((v) => !v) }))

  const draftCard = draftOpen
    ? h(Card, { title: '给主 Agent 的设计说明',
        actions: h(Button, { label: '发送', icon: 'send', size: 'sm', variant: 'primary', onClick: () => void askDesign() }) },
        h(Textarea, { value: draft, onChange: setDraft, rows: 3, placeholder: '可选：约束条件、目标读者、需要取舍的方案' }))
    : null

  if (!task) return h('div', null, head, draftCard, h(Card, { style: { marginTop: 12 } }, h(Empty, { title: '没有可设计的任务' })))
  if (!solution) {
    return h('div', null, head, draftCard,
      h(Card, { style: { marginTop: 12 } },
        h(Banner, { tone: 'info', text: '该任务还没有产品方案。点击「让主 Agent 设计」触发真实设计流程，结果会写回这里。' })))
  }

  const summaryCard = h(Card, { title: solution.title || '产品方案' },
    h(KV, { items: [
      { k: '产品定位', v: solution.positioning },
      { k: '建设目标', v: namesOf(solution.goals) },
      { k: '产品架构', v: solution.architecture },
      { k: 'MVP 范围', v: namesOf(solution.mvp) },
      { k: '版本规划', v: namesOf(solution.roadmap) },
    ] }))

  const modules = PM.list(solution.modules)
  const activeModule = activeNode
    ? modules.find((m) => m.moduleId === activeNode.nodeId || m.name === activeNode.name)
    : undefined
  const moduleBody = activeNode
    ? box('pmc-col', [
        h(KV, { key: 'kv', items: [{ k: '模块名称', v: activeNode.name }, { k: '模块 ID', v: activeNode.nodeId || '—' }] }),
        activeModule && activeModule.detail
          ? h('div', { key: 'detail' }, activeModule.detail)
          : h('span', { key: 'none', className: 'pmc-dim' }, '主 Agent 尚未为该模块写回详细方案。'),
      ])
    : h(Empty, { title: '选择一个功能节点', hint: '功能架构树来自 solution.functions；节点详情来自 solution.modules。' })

  const treeCard = h(Card, { title: t('so.tree'), hint: '点击节点查看模块' },
    h(TreeView, { nodes: solution.functions || [], activeId: activeNode ? (activeNode.nodeId || activeNode.name) : undefined, onSelect: (node) => setActiveNode(node) }))
  const moduleCard = h(Card, { title: t('so.module'), hint: activeNode ? activeNode.name : '未选择节点' }, moduleBody)

  const boundary = PM.list(business && business.boundary)
  const systemBody = boundary.length === 0
    ? h(Empty, { title: '暂无系统边界数据', hint: '先在「业务分析」页让主 Agent 完成系统边界分析。' })
    : h(Flow, {
        nodes: boundary.map((row, i) => ({ id: 'sy' + i, label: row.system || row.name || ('系统 ' + (i + 1)), kind: 'system', actor: row.dataOwnership })),
        edges: [],
      })

  const versionRows = PM.list(solution.versions).map((version, i) => h('div', { key: 'v' + i, className: 'pmc-list-item' },
    h('div', { className: 'pmc-li-main' },
      h('div', { className: 'pmc-li-title' }, String(version.version === undefined ? 'v' + (i + 1) : (String(version.version).startsWith('v') ? version.version : 'v' + version.version))),
      h('div', { className: 'pmc-li-sub' }, version.note || '—')),
    h('span', { className: 'pmc-dim' }, PM.env.fmtTime(version.at))))
  const versionBody = versionRows.length === 0 ? h(Empty, { title: '尚无版本记录' }) : box(null, versionRows)

  return h('div', null, head, draftCard,
    box('pmc-col', [
      summaryCard,
      box('pmc-split', [treeCard, moduleCard]),
      h(Card, { title: t('so.systems'), hint: '系统职责与交互' }, systemBody),
      h(Card, { title: t('so.versions') }, versionBody),
    ], { gap: 12, marginTop: 12 }))
}
