/**
 * PM Copilot — Client half, part 55: PRD 文档中心 / 质量检查中心 / 决策与知识沉淀.
 *
 * PRD saving always appends a new immutable version file; quality issues are
 * computed by the Host from real documents; a decision only enters the formal
 * knowledge base after an explicit user confirmation.
 */

/** The fifteen PRD sections the cockpit and the PRD skill share. */
const PRD_SECTIONS = [
  ['背景', '需求背景'], ['目标', '需求目标'], ['范围', '需求范围'], ['角色', '用户角色'],
  ['场景', '业务场景'], ['流程', '业务流程'], ['功能结构', '功能结构'], ['功能说明', '功能详细说明'],
  ['规则', '业务规则'], ['字段', '字段定义'], ['状态', '状态流转'], ['接口', '接口要求'],
  ['异常', '异常处理'], ['非功能', '非功能需求'], ['验收', '验收标准'],
]

/** Decision status label through the locale dictionary. */
function tabLabel(t, status) {
  const key = 'dc.status.' + status
  const value = t(key)
  return value === key ? status : value
}

PM.pages.prd = function Prd(props) {
  const { t, snapshot, run, workspacePath } = props
  const prds = PM.list(snapshot && snapshot.prds)
  const tasks = PM.list(snapshot && snapshot.tasks)
  const projects = PM.list(snapshot && snapshot.projects)
  const [selectedId, setSelectedId] = React.useState(null)
  const [creating, setCreating] = React.useState(false)
  const [view, setView] = React.useState('preview')
  const [preview, setPreview] = React.useState(null)
  const emptyForm = { title: '', projectId: '', taskId: '', sections: {}, changeNote: '' }
  const [form, setForm] = React.useState(emptyForm)
  /** Non-null while editing an existing PRD: a save then appends a new version. */
  const [editing, setEditing] = React.useState(null)
  const [confirmBy, setConfirmBy] = React.useState('用户')
  const selected = prds.find((x) => x.prdId === selectedId) || null

  const openPreview = async (prd) => {
    const versions = PM.list(prd.versions)
    const current = versions.length > 0 ? versions[versions.length - 1] : null
    setSelectedId(prd.prdId)
    setView('preview')
    if (!current || !current.path) { setPreview(null); return }
    try {
      const file = await PM.api.file(current.path, workspacePath)
      setPreview({ ...current, text: file.text, truncated: file.truncated })
    } catch (err) {
      setPreview(null)
      props.toast('无法读取版本文件：' + (err.message || ''), 'danger')
    }
  }

  /** Load the current version's sections so "编辑并新建版本" starts from real text. */
  const startEdit = async (prd) => {
    try {
      const value = await run('prd.get', { prdId: prd.prdId }, { label: '正在读取当前版本' })
      // `prd.get` answers `{ prd, current }`; `current.sections` is the parsed
      // current version file. Never start an edit from blank fields, or saving
      // would look like it "preserved" sections the user could not see.
      const source = (value && value.current && value.current.sections) || (value && value.sections) || {}
      const sections = {}
      for (const [, label] of PRD_SECTIONS) {
        const found = source[label]
        sections[label] = typeof found === 'string' ? found : ''
      }
      setForm({
        title: prd.title || '',
        projectId: prd.projectId || '',
        taskId: prd.taskId || '',
        sections: {},
        changeNote: '',
      })
      setEditing({ prdId: prd.prdId, currentVersion: prd.currentVersion || PM.list(prd.versions).length, sections })
      setCreating(false)
    } catch (err) {
      props.toast('无法读取当前版本：' + (err.message || ''), 'danger')
    }
  }

  const newPrd = async () => {
    const editingId = editing === null ? undefined : editing.prdId
    if (form.title.trim() === '') { props.toast('PRD 标题必填', 'danger'); return }
    const sections = {}
    const source = editing === null ? form.sections : editing.sections
    for (const [key, label] of PRD_SECTIONS) {
      const value = source[key]
      if (value !== undefined && String(value).trim() !== '') sections[label] = String(value).trim()
    }
    try {
      const value = await run('prd.save', {
        prdId: editingId,
        projectId: form.projectId || (projects[0] ? projects[0].projectId : undefined),
        taskId: form.taskId || undefined,
        title: form.title,
        sections,
        changeNote: form.changeNote || (editingId === undefined ? '初始版本' : '手工修订'),
      }, {
        label: editingId === undefined ? '正在写入 PRD' : '正在生成新版本',
        success: editingId === undefined ? 'PRD 已写入，原文件不会被覆盖' : '已生成新版本，旧版本文件保持原样',
      })
      setCreating(false)
      setEditing(null)
      setForm(emptyForm)
      if (value && value.prdId) await openPreview(value)
    } catch { /* toast */ }
  }

  const exportPrd = async (prd) => {
    try {
      const value = await run('prd.export', { prdId: prd.prdId }, { label: '正在导出' })
      const markdown = typeof value === 'string' ? value : ((value && (value.markdown || value.text)) || '')
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = (prd.slug || prd.prdId) + '.md'
      anchor.click()
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 2000)
      props.toast('已导出 Markdown', 'ok')
    } catch (err) { props.toast(err.message || '导出失败', 'danger') }
  }

  /** Confirm the version the user is looking at, not "the PRD" in the abstract. */
  const confirmPrd = async (prd) => {
    const version = prd.currentVersion || PM.list(prd.versions).length || 1
    try {
      await run('prd.confirm', { prdId: prd.prdId, confirmedBy: confirmBy || '用户' }, {
        label: '正在确认 v' + version,
        success: '已确认 v' + version + '；之后保存新版本会自动回到草稿，需要重新确认',
      })
    } catch { /* toast */ }
  }

  const askPrd = async () => {
    const target = U.pickTask(snapshot, form.taskId || null)
    if (!target) { props.toast('请先选择任务', 'danger'); return }
    try {
      await U.prompt(props, U.taskInstruction(target) + '\n\n请加载 PRD Skill 并按 15 个章节编写 PRD，完成后用 pm_copilot 的 prd_save 写回 PRD 文档中心。',
        { kind: 'prd.writer', title: 'PRD 编写', taskId: target.taskId, label: '正在调用主 Agent 编写 PRD' })
      setCreating(false)
    } catch { /* toast */ }
  }

  const head = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('prd.title')), h('p', null, t('prd.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h('div', { style: { width: 120 } }, h(Input, { value: confirmBy, onChange: setConfirmBy, placeholder: '确认人' })),
    h(Button, { label: '让主 Agent 编写 PRD', icon: 'send', onClick: () => void askPrd() }),
    h(Button, { label: t('prd.new'), icon: 'plus', variant: 'primary', onClick: () => setCreating((v) => !v) }))

  /** A confirmation covers exactly one version, so the badge names it. */
  const prdStatusTag = (prd) => {
    const status = prd.status || 'draft'
    const confirmedVersion = Number(prd.confirmedVersion) || null
    if (status === 'confirmed') {
      return h(Tag, {
        text: confirmedVersion === null ? '已确认（版本未记录）' : U.code('prdStatus', status) + ' v' + confirmedVersion,
        tone: confirmedVersion === null ? 'warn' : 'ok',
      })
    }
    return h(Tag, { text: U.code('prdStatus', status), tone: status === 'draft' || status === 'review' ? 'warn' : 'blue' })
  }

  const activeSections = editing === null ? form.sections : editing.sections
  const sectionFields = PRD_SECTIONS.map(([key, label]) => h(Field, { key, label },
    h(Textarea, {
      value: activeSections[key] || '', rows: 3,
      onChange: (v) => {
        if (editing === null) { setForm({ ...form, sections: { ...form.sections, [key]: v } }); return }
        setEditing({ ...editing, sections: { ...editing.sections, [key]: v } })
      },
    })))
  const editMode = editing !== null
  const formOpen = creating || editMode
  const formCard = formOpen
    ? h(Card, {
        title: editMode ? '编辑并生成新版本（当前 v' + editing.currentVersion + '）' : t('prd.new'),
        actions: h(Button, {
          label: t('common.cancel'), size: 'sm', variant: 'ghost',
          onClick: () => { setCreating(false); setEditing(null); setForm(emptyForm) },
        }),
      },
      box('pmc-col', [
        h('div', { key: 'row', className: 'pmc-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' } }, [
          h(Field, { key: 'title', label: 'PRD 标题' }, h(Input, { value: form.title, onChange: (v) => setForm({ ...form, title: v }), disabled: editMode })),
          h(Field, { key: 'project', label: '所属项目' }, h(Select, { value: form.projectId, onChange: (v) => setForm({ ...form, projectId: v }), options: projects.map((p) => ({ value: p.projectId, label: p.title })), placeholder: '默认项目' })),
          h(Field, { key: 'task', label: '关联任务' }, h(Select, { value: form.taskId, onChange: (v) => setForm({ ...form, taskId: v }), options: tasks.map((x) => ({ value: x.taskId, label: x.title })), placeholder: '不关联' })),
        ]),
        h(Banner, { key: 'note', tone: 'info', text: editMode
          ? '保存会写入新的版本文件（v' + (editing.currentVersion + 1) + '），当前版本文件保持原样；未改动的章节会沿用上一版本内容。'
          : 'PRD 内容必须来自主 Agent / PRD Skill 产出；此处的章节字段仅在需要手工修正时使用，保存会生成版本文件。' }),
        box(null, sectionFields),
        h(Field, { key: 'note2', label: '变更说明' }, h(Input, { value: form.changeNote, onChange: (v) => setForm({ ...form, changeNote: v }), placeholder: editMode ? '例如：补充异常处理与验收标准' : '例如：初始版本' })),
        h(Button, {
          key: 'save', label: editMode ? '保存为新版本' : t('common.save'), icon: 'check', variant: 'primary',
          onClick: () => void newPrd(),
        }),
      ]))
    : null

  const listRows = prds.map((prd) => h('div', { key: prd.prdId, className: 'pmc-list-item' },
    h('div', { className: 'pmc-li-main' },
      h('div', { className: 'pmc-li-title pmc-link', onClick: () => void openPreview(prd) }, prd.title),
      h('div', { className: 'pmc-li-sub' }, 'v' + (prd.currentVersion || PM.list(prd.versions).length || 1) + ' · ' + PM.env.fmtTime(prd.updatedAt))),
    prdStatusTag(prd),
    prd.status === 'confirmed'
      ? null
      : h(Button, { label: t('prd.confirm'), size: 'sm', icon: 'check', onClick: () => void confirmPrd(prd) }),
    h(Button, { label: '编辑新版本', size: 'sm', icon: 'edit', onClick: () => void startEdit(prd) }),
    h(Button, { label: t('prd.export'), size: 'sm', icon: 'external', onClick: () => void exportPrd(prd) })))
  const listBody = listRows.length === 0
    ? h(Empty, { title: '还没有 PRD', hint: '点击「新建 PRD」或让主 Agent 通过 PRD Skill 生成。' })
    : box(null, listRows)
  const listCard = h(Card, { title: t('prd.title'), hint: prds.length + ' 份' }, listBody)

  const previewBody = preview
    ? box('pmc-col', [
        preview.truncated ? h(Banner, { key: 'cut', tone: 'warn', text: '该版本文件超过 512KB，预览只显示前面一部分。' }) : null,
        h('div', { key: 'text', className: 'pmc-preview' }, preview.text),
      ])
    : h(Empty, { title: '无法预览', hint: '该 PRD 没有可读取的版本文件路径。' })
  const versionBody = selected
    ? box(null, PM.list(selected.versions).map((version, i) => h('div', { key: 'v' + i, className: 'pmc-list-item' },
        h('div', { className: 'pmc-li-main' },
          h('div', { className: 'pmc-li-title pmc-link', onClick: () => {
            if (!version.path) return
            void PM.api.file(version.path, workspacePath)
              .then((file) => setPreview({ ...version, text: file.text, truncated: file.truncated }))
              .catch((err) => props.toast(err.message || '无法打开该版本', 'danger'))
            setView('preview')
          } }, String(version.version === undefined ? 'v' + (i + 1) : (String(version.version).startsWith('v') ? version.version : 'v' + version.version))),
          h('div', { className: 'pmc-li-sub pmc-mono' }, version.path || '—')),
        h('span', { className: 'pmc-dim' }, PM.env.fmtTime(version.at)))))
    : null
  const detailBody = selected
    ? box('pmc-col', [
        h(Tabs, { key: 'tabs', items: [{ key: 'preview', label: t('prd.preview') }, { key: 'versions', label: t('prd.versions') }], active: view, onChange: setView }),
        view === 'preview' ? previewBody : versionBody,
      ])
    : h(Empty, { title: '预览区', hint: '点击左侧任意 PRD 打开其当前版本文件。' })
  const detailCard = h(Card, {
    title: selected ? selected.title : '选择一个 PRD',
    hint: selected ? 'v' + (selected.currentVersion || 1) : undefined,
  }, detailBody)

  return h('div', null, head, formCard, h('div', { className: 'pmc-split', style: { marginTop: 12 } }, listCard, detailCard))
}

PM.pages.quality = function Quality(props) {
  const { t, snapshot, run } = props
  const quality = (snapshot && snapshot.quality) || { issues: [], reports: [] }
  const issues = PM.list(quality.issues)
  const reports = PM.list(quality.reports)
  const [dimension, setDimension] = React.useState('')
  const [selected, setSelected] = React.useState([])
  const [running, setRunning] = React.useState(false)
  const capabilities = (snapshot && snapshot.capabilities) || {}
  const agentReady = capabilities.agent !== false

  const runCheck = async () => {
    setRunning(true)
    try { await run('quality.run', { scope: 'all' }, { label: '正在执行质量检查', success: '质量检查完成，结果来自真实文档' }) }
    catch { /* toast */ } finally { setRunning(false) }
  }
  const fixSelected = async () => {
    if (selected.length === 0) { props.toast('请先勾选要修正的问题', 'danger'); return }
    try {
      const chosen = issues.filter((x) => selected.includes(x.issueId))
      const detail = chosen.map((x, i) => (i + 1) + '. [' + x.severity + '] ' + x.title + '\n   建议：' + (x.suggestion || '')).join('\n')
      await U.prompt(props, '请按员工守则修正以下质量问题，并在修改后重新自检：\n' + detail +
        '\n\n注意：涉及已确认业务决策的变更不得自动改变原决策，必须提交用户确认。修正完成后用 pm_copilot 的 quality_report 更新状态。',
        { kind: 'quality.fix', title: '质量修正', label: '正在调用主 Agent 修正' })
      await run('quality.fix', { issueIds: selected }, { label: '标记修正中' })
      setSelected([])
    } catch { /* toast */ }
  }

  const visible = issues.filter((x) => x.status !== 'stale' && (!dimension || x.dimension === dimension))
  const dimensions = [...new Set(issues.map((x) => x.dimension).filter(Boolean))]
  // One definition of "open" for every count on this page, so the headline
  // number and the severity columns can never disagree.
  const openIssues = issues.filter((issue) => U.isOpenIssue(issue))
  const openCount = openIssues.length
  const countBy = (severity) => openIssues.filter((issue) => issue.severity === severity).length

  const head = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('qt.title')), h('p', null, t('qt.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h(Button, {
      label: selected.length === 0 ? t('qt.fix') : t('qt.fix') + ' (' + selected.length + ')',
      icon: 'send', disabled: selected.length === 0 || !agentReady,
      disabledReason: selected.length === 0 ? '先在问题列表里勾选要修正的问题' : (!agentReady ? '主 Agent 不可用（sessionController 未挂载）' : undefined),
      onClick: () => void fixSelected(),
    }),
    h(Button, { label: running ? '检查中…' : t('qt.run'), icon: 'quality', variant: 'primary', disabled: running, onClick: () => void runCheck() }))

  const metricTiles = [
    h(Metric, { key: 'open', label: '未解决', value: openCount, tone: openCount === 0 ? 'ok' : (countBy('blocker') > 0 ? 'danger' : 'warn') }),
    h(Metric, { key: 'blocker', label: U.code('severity', 'blocker'), value: countBy('blocker'), tone: 'danger' }),
    h(Metric, { key: 'major', label: U.code('severity', 'major'), value: countBy('major'), tone: 'warn' }),
    h(Metric, { key: 'minor', label: U.code('severity', 'minor'), value: countBy('minor') }),
    h(Metric, { key: 'reports', label: '检查报告', value: reports.length, hint: '最近一次：' + (reports.length ? PM.env.fmtTime(reports[reports.length - 1].at) : '尚未运行'), tone: 'ok' }),
  ]
  const metricsBlock = h('div', { className: 'pmc-grid pmc-metrics', style: { marginBottom: 12 } }, metricTiles)

  const issueRows = visible.map((issue) => {
    const open = U.isOpenIssue(issue)
    const fixing = issue.status === 'fixing'
    return h('div', { key: issue.issueId, className: 'pmc-list-item' },
      h('input', {
        type: 'checkbox', checked: selected.includes(issue.issueId), disabled: !open,
        onChange: () => setSelected((prev) => prev.includes(issue.issueId) ? prev.filter((x) => x !== issue.issueId) : prev.concat([issue.issueId])),
      }),
      h('div', { className: 'pmc-li-main' },
        h('div', { className: 'pmc-li-title' }, issue.title),
        h('div', { className: 'pmc-li-sub' }, issue.detail || ''),
        h('div', { className: 'pmc-li-sub' }, t('qt.suggestion') + '：' + (issue.suggestion || '—')),
        issue.targetPath ? h('div', { className: 'pmc-li-sub pmc-mono' }, issue.targetPath) : null),
      h(Tag, { text: U.code('severity', issue.severity), tone: U.severityTone(issue.severity) }),
      h(Tag, { text: issue.dimension || '—', tone: 'blue' }),
      h(Tag, { text: U.code('issueStatus', issue.status || 'open'), tone: open ? (fixing ? 'violet' : 'warn') : 'ok' }),
      open
        ? h(Button, {
            label: fixing ? '确认修正完成' : t('qt.resolve'), size: 'sm', icon: 'check',
            onClick: () => void run('quality.resolve', { issueId: issue.issueId, resolution: fixing ? '主 Agent 修正完成，已人工确认' : '用户确认无需修改' }, { success: '已标记解决' }),
          })
        : null)
  })
  const issueBody = visible.length === 0
    ? h('div', null, h(Empty, {
        title: reports.length === 0 ? '尚未运行质量检查' : (openCount === 0 ? '本轮未发现质量问题' : '当前筛选下没有问题'),
        hint: reports.length === 0
          ? '点击右上角「运行检查」，对真实任务、业务数据、PRD 与知识库做确定性检查。'
          : t('qt.clearHint'),
      }))
    : box(null, issueRows)
  const selectableIds = visible.filter((issue) => U.isOpenIssue(issue)).map((issue) => issue.issueId)
  const issueCard = h(Card, {
    title: t('qt.issue'), hint: visible.length + ' 条',
    actions: h('div', { className: 'pmc-row' },
      h(Button, {
        label: selected.length === selectableIds.length && selectableIds.length > 0 ? '取消全选' : '全选',
        size: 'sm', variant: 'ghost', disabled: selectableIds.length === 0,
        onClick: () => setSelected(selected.length === selectableIds.length ? [] : selectableIds),
      }),
      h('div', { style: { width: 150 } }, h(Select, { value: dimension, onChange: setDimension, options: dimensions.map((d) => ({ value: d, label: d })), placeholder: '全部维度' }))),
  }, issueBody)

  const reportRows = reports.slice().reverse().map((report) => h('div', { key: report.reportId, className: 'pmc-list-item' },
    h('div', { className: 'pmc-li-main' },
      h('div', { className: 'pmc-li-title' }, '报告 ' + report.reportId),
      h('div', { className: 'pmc-li-sub' }, PM.env.fmtTime(report.at) + ' · 检查对象：' + (report.scope || 'all'))),
    h(Tag, { text: String(report.issueCount || 0) + ' 个问题', tone: (report.issueCount || 0) > 0 ? 'warn' : 'ok' })))
  const reportBody = reportRows.length === 0 ? h(Empty, { title: '暂无报告' }) : box(null, reportRows)
  const reportCard = h(Card, { title: '检查报告' }, reportBody)

  return h('div', null, head, metricsBlock, h('div', { className: 'pmc-split' }, issueCard, reportCard))
}

PM.pages.decisions = function Decisions(props) {
  const { t, snapshot, run } = props
  const decisions = PM.list(snapshot && snapshot.decisions)
  const knowledge = PM.list(snapshot && snapshot.knowledge)
  const projects = PM.list(snapshot && snapshot.projects)
  const [tab, setTab] = React.useState('pending')
  const [open, setOpen] = React.useState(false)
  const [confirmBy, setConfirmBy] = React.useState('用户')
  const emptyForm = { title: '', type: '业务规则', projectId: '', background: '', discussion: '', conclusion: '', basis: '', scope: '', impact: '', modules: '' }
  const [form, setForm] = React.useState(emptyForm)

  const statusOf = (decision) => decision.status || 'pending'
  const filtered = decisions.filter((x) => (tab === 'all' ? true : statusOf(x) === tab))

  const propose = async () => {
    if (form.title.trim() === '' || form.conclusion.trim() === '') { props.toast('决策名称与结论必填', 'danger'); return }
    try {
      await run('decision.propose', {
        projectId: form.projectId || (projects[0] ? projects[0].projectId : undefined),
        title: form.title, type: form.type,
        background: form.background, discussion: form.discussion,
        conclusion: form.conclusion, basis: form.basis, scope: form.scope, impact: form.impact,
        modules: form.modules ? form.modules.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
      }, { label: '正在提交决策', success: '决策已提交为「待确认」' })
      setOpen(false)
      setForm(emptyForm)
    } catch { /* toast */ }
  }

  const head = h('div', { className: 'pmc-page-head' },
    h('div', null, h('h2', null, t('dc.title')), h('p', null, t('dc.subtitle'))),
    h('div', { style: { flex: 1 } }),
    h('div', { style: { width: 140 } }, h(Input, { value: confirmBy, onChange: setConfirmBy, placeholder: '确认人' })),
    h(Button, { label: t('dc.propose'), icon: 'plus', variant: 'primary', onClick: () => setOpen((v) => !v) }))

  const formCard = open
    ? h(Card, { title: t('dc.propose'),
        actions: h(Button, { label: t('common.cancel'), size: 'sm', variant: 'ghost', onClick: () => setOpen(false) }) },
        box('pmc-col', [
          h('div', { key: 'row', className: 'pmc-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' } }, [
            h(Field, { key: 'title', label: '决策名称' }, h(Input, { value: form.title, onChange: (v) => setForm({ ...form, title: v }) })),
            h(Field, { key: 'type', label: '决策类型' }, h(Select, { value: form.type, onChange: (v) => setForm({ ...form, type: v }), options: ['业务规则', '产品范围', '架构选型', '数据口径', '流程变更', '其它'].map((x) => ({ value: x, label: x })) })),
            h(Field, { key: 'project', label: '所属项目' }, h(Select, { value: form.projectId, onChange: (v) => setForm({ ...form, projectId: v }), options: projects.map((p) => ({ value: p.projectId, label: p.title })), placeholder: '默认项目' })),
          ]),
          h(Field, { key: 'bg', label: '决策背景' }, h(Textarea, { value: form.background, onChange: (v) => setForm({ ...form, background: v }), rows: 2 })),
          h(Field, { key: 'dis', label: '讨论过程摘要' }, h(Textarea, { value: form.discussion, onChange: (v) => setForm({ ...form, discussion: v }), rows: 2 })),
          h(Field, { key: 'con', label: '最终决策结论' }, h(Textarea, { value: form.conclusion, onChange: (v) => setForm({ ...form, conclusion: v }), rows: 2 })),
          h(Field, { key: 'basis', label: '决策依据' }, h(Textarea, { value: form.basis, onChange: (v) => setForm({ ...form, basis: v }), rows: 2 })),
          h('div', { key: 'scope', className: 'pmc-grid', style: { gridTemplateColumns: '1fr 1fr' } }, [
            h(Field, { key: 'scope', label: '适用范围' }, h(Input, { value: form.scope, onChange: (v) => setForm({ ...form, scope: v }) })),
            h(Field, { key: 'mods', label: '影响模块（逗号分隔）' }, h(Input, { value: form.modules, onChange: (v) => setForm({ ...form, modules: v }) })),
          ]),
          h(Button, { key: 'save', label: t('common.save'), icon: 'check', variant: 'primary', onClick: () => void propose() }),
        ]))
    : null

  const tabs = h(Tabs, { items: [
    { key: 'pending', label: t('dc.status.pending') + ' (' + decisions.filter((x) => statusOf(x) === 'pending').length + ')' },
    { key: 'confirmed', label: t('dc.status.confirmed') + ' (' + decisions.filter((x) => statusOf(x) === 'confirmed').length + ')' },
    { key: 'changed', label: t('dc.status.changed') + ' (' + decisions.filter((x) => statusOf(x) === 'changed').length + ')' },
    { key: 'deprecated', label: t('dc.status.deprecated') + ' (' + decisions.filter((x) => statusOf(x) === 'deprecated').length + ')' },
    { key: 'all', label: t('common.all') },
  ], active: tab, onChange: setTab })

  const decisionRows = filtered.map((decision) => {
    const status = statusOf(decision)
    const tone = status === 'confirmed' ? 'ok' : status === 'pending' ? 'warn' : status === 'deprecated' ? 'mute' : 'violet'
    const actions = [
      status === 'pending'
        ? h(Button, { key: 'confirm', label: t('dc.confirm'), size: 'sm', icon: 'check', variant: 'primary', onClick: () => void run('decision.confirm', { decisionId: decision.decisionId, confirmedBy: confirmBy || '用户' }, { success: '决策已确认；写入正式知识库需再点一次' }) })
        : null,
      status === 'confirmed'
        ? h(Button, { key: 'ingest', label: t('dc.ingest'), size: 'sm', icon: 'knowledge', onClick: () => void run('decision.ingest', { decisionId: decision.decisionId }, { success: '已按 SCHEMA 写入 kb/wiki/decisions' }) })
        : null,
      h(Button, { key: 'change', label: t('dc.change'), size: 'sm', icon: 'refresh', onClick: () => {
        const conclusion = globalThis.prompt('新的决策结论（将记为已变更，保留历史）', decision.conclusion || '')
        if (conclusion === null || conclusion.trim() === '') return
        void run('decision.change', { decisionId: decision.decisionId, conclusion: conclusion.trim(), reason: '用户发起变更' }, { success: '决策已变更为新结论并保留历史' })
      } }),
      status !== 'deprecated'
        ? h(Button, { key: 'dep', label: t('dc.deprecate'), size: 'sm', variant: 'danger', onClick: () => void run('decision.deprecate', { decisionId: decision.decisionId, reason: '用户废弃' }, { success: '决策已废弃（保留页面）' }) })
        : null,
    ]
    return h('div', { key: decision.decisionId, className: 'pmc-list-item', style: { flexDirection: 'column', alignItems: 'stretch' } },
      h('div', { className: 'pmc-row', style: { justifyContent: 'space-between' } },
        h('div', { className: 'pmc-li-title' }, decision.title),
        h('div', { className: 'pmc-row' },
          h(Tag, { text: decision.type || '决策', tone: 'blue' }),
          h(Tag, { text: tabLabel(t, status), tone }))),
      h('div', { className: 'pmc-li-sub' }, (decision.decisionId || '') + ' · ' + (decision.conclusion || '')),
      h('div', { className: 'pmc-row', style: { marginTop: 4 } }, actions))
  })
  const decisionBody = decisionRows.length === 0
    ? h(Empty, { title: '没有该状态的决策', hint: '决策由主 Agent 提出并经用户确认，不会自动产生。' })
    : box(null, decisionRows)
  const decisionCard = h(Card, { title: '决策记录', hint: filtered.length + ' 条' }, decisionBody)

  const knowledgeGroups = ['正式', '待确认', '历史'].map((status) => {
    const group = knowledge.filter((x) => (x.status || '待确认') === status)
    const tone = status === '正式' ? 'ok' : status === '待确认' ? 'warn' : 'mute'
    const lines = group.slice(0, 5).map((entry) => h('div', { key: entry.entryId, className: 'pmc-li-sub' },
      '· ' + entry.title + (entry.path ? ' — ' + PM.env.baseName(entry.path) : '')))
    return h('div', { key: status },
      h('div', { className: 'pmc-row', style: { justifyContent: 'space-between' } },
        h('span', { className: 'pmc-strong', style: { fontSize: 12 } }, status + '知识'),
        h(Tag, { text: String(group.length), tone })),
      lines)
  })
  const knowledgeCard = h(Card, { title: '知识沉淀', hint: knowledge.length + ' 条' },
    box('pmc-col', knowledgeGroups.concat([
      h(Button, { key: 'go', label: '前往知识中心', size: 'sm', icon: 'knowledge', onClick: () => props.navigate('knowledge') }),
    ]), { gap: 6 }))

  return h('div', null, head, formCard, tabs, h('div', { className: 'pmc-split' }, decisionCard, knowledgeCard))
}
