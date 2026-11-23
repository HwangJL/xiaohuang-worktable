/**
 * PM Copilot — Client half, part 30: locale dictionaries, the cockpit shell and
 * the plugin's `apply`.
 *
 * The sidebar row and the main panel are registered for every composition: a
 * registration that came and went with the Agent preset used to leave the
 * center column blank whenever the restored layout still pointed at the panel.
 * What the preset decides now is only the READ-ONLY notice the cockpit shows —
 * the Host half keeps refusing writes from any Session whose identity is not
 * `xiaohuang`, so authority never moves to the browser.
 */

const ZH = {
  'panel.label': '驾驶舱',
  'nav.overview': '工作总览',
  'nav.tasks': '任务中心',
  'nav.analysis': '任务分析',
  'nav.skills': '专业 Skill',
  'nav.knowledge': '项目知识',
  'nav.business': '业务分析',
  'nav.solution': '方案设计',
  'nav.prd': 'PRD 文档',
  'nav.quality': '质量检查',
  'nav.decisions': '决策沉淀',
  'top.welcome': '欢迎回来，小黄',
  'top.mode': '当前工作模式：产品经理 AI 员工',
  'top.project': '项目',
  'top.status': '工作状态',
  'top.date': '日期',
  'top.quick': '快速创建任务',
  'top.identityOk': '会话身份已校验',
  'top.identityHold': '身份待确认',
  'top.identityReading': '身份校验中…',
  'top.notXiaohuang': '当前会话不是「小黄」模式：驾驶舱可以浏览，但所有写操作会被 Host 拒绝。要执行动作，请切换到「小黄」模式的会话。',
  'top.idle': '暂无进行中的任务',
  'common.loading': '正在读取真实工作数据…',
  'common.retry': '重试',
  'common.close': '关闭',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.new': '新建',
  'common.search': '搜索',
  'common.refresh': '刷新',
  'common.detail': '详情',
  'common.all': '全部',
  'common.none': '—',
  'common.emptyTitle': '暂无数据',
  'common.emptyHint': '这里的内容全部来自真实任务、执行记录与知识库；当前为空。',
  'common.unverified': '宿主能力未接通',
  'status.todo': '待开始',
  'status.analysis': '分析中',
  'status.design': '设计中',
  'status.executing': '执行中',
  'status.confirming': '待确认',
  'status.quality': '质量检查中',
  'status.done': '已完成',
  'status.paused': '已暂停',
  'status.terminated': '已终止',
  'priority.P0': 'P0',
  'priority.P1': 'P1',
  'priority.P2': 'P2',
  'priority.P3': 'P3',
  'tone.todo': 'mute',
  'tone.analysis': 'blue',
  'tone.design': 'blue',
  'tone.executing': 'blue',
  'tone.confirming': 'warn',
  'tone.quality': 'violet',
  'tone.done': 'ok',
  'tone.paused': 'mute',
  'tone.terminated': 'danger',
  'ov.metric.todo': '待处理任务',
  'ov.metric.executing': '正在执行任务',
  'ov.metric.confirming': '待确认事项',
  'ov.metric.done': '已完成任务',
  'ov.metric.knowledge': '待沉淀知识',
  'ov.metric.quality': '质量检查问题',
  'ov.current': '当前工作',
  'ov.current.empty': '当前没有正在推进的任务',
  'ov.recent': '最近任务',
  'ov.todo': '待办事项',
  'ov.quick': '快捷操作',
  'ov.metricHint.todo': '真实任务集合中尚未开始的任务数',
  'ov.metricHint.executing': '状态为执行中 / 分析中 / 设计中的任务数',
  'ov.metricHint.confirming': '等待业务或产品确认的事项数',
  'ov.metricHint.done': '已完成任务数',
  'ov.metricHint.knowledge': '状态为待确认的知识与决策数',
  'ov.metricHint.quality': '未解决的质量检查问题数',
  'ov.current.stage': '当前工作阶段',
  'ov.current.progress': '已完成进度',
  'ov.current.step': '当前执行步骤',
  'ov.current.skills': '已调用 Skill',
  'ov.current.blocker': '当前阻塞事项',
  'ov.current.next': '下一步计划',
  'ov.todo.business': '等待业务确认',
  'ov.todo.decision': '等待产品决策',
  'ov.todo.material': '等待补充资料',
  'ov.todo.knowledge': '等待知识审核',
  'ov.todo.fix': '待修正问题',
  'quick.requirement': '新建需求分析',
  'quick.business': '业务流程分析',
  'quick.rule': '业务规则分析',
  'quick.solution': '产品方案设计',
  'quick.prd': 'PRD 编写',
  'quick.quality': '需求质量检查',
  'quick.knowledge': '项目知识检索',
  'task.title': '任务中心',
  'task.subtitle': '统一管理所有产品工作任务，数据来自真实任务集合',
  'task.new': '新建任务',
  'task.searchPlaceholder': '按名称、描述或 ID 搜索',
  'task.col.id': '任务 ID',
  'task.col.title': '任务名称',
  'task.col.project': '所属项目',
  'task.col.type': '类型',
  'task.col.stage': '当前阶段',
  'task.col.priority': '优先级',
  'task.col.status': '状态',
  'task.col.updated': '更新时间',
  'task.col.skills': '关联 Skill',
  'task.detail.basic': '基本信息',
  'task.detail.trace': '执行轨迹',
  'task.detail.subtasks': '子任务',
  'task.detail.deps': '依赖关系',
  'task.detail.deliverables': '交付物',
  'task.run': '继续执行',
  'task.analyze': '分析并拆解',
  'task.pause': '暂停',
  'task.resume': '恢复',
  'task.terminate': '终止',
  'task.delete': '删除',
  'task.edit': '编辑',
  'task.export': '查看交付物',
  'task.type.requirement': '需求',
  'task.type.business': '业务分析',
  'task.type.design': '方案设计',
  'task.type.prd': 'PRD',
  'task.type.quality': '质量检查',
  'task.type.other': '其它',
  'an.title': '任务分析与拆解',
  'an.subtitle': '分析结果由主 Agent 真实产出，并通过 pm_copilot 工具写回驾驶舱',
  'an.understanding': '需求理解',
  'an.stage': '工作阶段识别',
  'an.completeness': '信息完整性判断',
  'an.breakdown': '任务拆解',
  'an.plan': '执行计划',
  'an.runAnalysis': '让主 Agent 分析这个任务',
  'an.raw': '用户原始诉求',
  'an.core': '核心业务问题',
  'an.goal': '真正想实现的目标',
  'an.value': '预期业务价值',
  'an.scenes': '适用场景',
  'an.roles': '涉及业务角色',
  'an.known': '已明确的信息',
  'an.retrieved': '已检索到的信息',
  'an.assumptions': '当前分析假设',
  'an.toConfirm': '待确认的信息',
  'an.risks': '关键风险',
  'an.noAnalysis': '尚未生成分析',
  'an.noAnalysisHint': '点击右侧按钮让主 Agent 真实分析该任务；分析结果会写回这里。',
  'sk.title': '专业 Skill 管理',
  'sk.subtitle': '清单来自当前 DSH 模式真实注册的 Skill，本页不维护任何虚假清单',
  'sk.search': '搜索 Skill 名称或描述',
  'sk.count': '可用 Skill',
  'sk.invocations': '真实调用次数',
  'sk.lastAt': '最近调用',
  'sk.source': '来源',
  'sk.provider': '提供方',
  'sk.view': '查看内容',
  'sk.invoke': '组合执行',
  'sk.emptyTitle': '当前模式没有可用 Skill',
  'sk.emptyHint': 'Skill 由 DSH 的 Skill 注册表提供；若当前组合未挂载任何 provider，这里会保持为空。',
  'sk.versionNote': 'DSH 的 Skill 没有版本字段，因此这里显示来源与提供方而不是虚构的版本号。',
  'kn.title': '项目知识中心',
  'kn.subtitle': '检索 kb/raw/wiki 与项目文档的真实文件，索引只保存关联关系',
  'kn.query': '关键词',
  'kn.type': '知识类型',
  'kn.status': '状态',
  'kn.search': '检索',
  'kn.result': '检索结果',
  'kn.stats': '知识库规模',
  'kn.wiki': 'wiki 页面',
  'kn.raw': 'raw 资料',
  'kn.templates': '模板',
  'kn.open': '打开原文',
  'kn.ingest': '沉淀一条知识',
  'kn.pending': '待确认知识',
  'kn.confirmed': '正式知识',
  'kn.history': '历史知识',
  'kn.missing': '知识库尚未建立 wiki 层',
  'kn.missingHint': '当前 kb/ 只有 SCHEMA 与模板；沉淀操作会按 SCHEMA 真实创建 wiki/ 页面、index.md 与 log.md。',
  'ba.title': '业务分析工作台',
  'ba.subtitle': '六个视图全部来自主 Agent 写入的 business 分析结果',
  'ba.roles': '业务角色',
  'ba.objects': '业务对象',
  'ba.process': '业务流程',
  'ba.rules': '业务规则',
  'ba.boundary': '系统边界',
  'ba.risks': '风险与问题',
  'ba.none': '该任务还没有业务分析结果',
  'ba.noneHint': '在主 Agent 完成任务拆解后，业务分析结果会写回这里。',
  'so.title': '产品方案设计中心',
  'so.subtitle': '产品定位、架构、功能树、数据与接口设计，以及方案版本',
  'so.tree': '功能架构',
  'so.module': '模块详情',
  'so.systems': '系统职责与交互',
  'so.versions': '版本记录',
  'prd.title': 'PRD 文档中心',
  'prd.subtitle': 'PRD 由 PRD Skill 产出，保存时写入新版本文件，原版本不被覆盖',
  'prd.new': '新建 PRD',
  'prd.preview': '预览',
  'prd.edit': '编辑',
  'prd.export': '导出',
  'prd.confirm': '确认当前版本',
  'prd.versions': '版本',
  'prd.section': '章节',
  'prd.status': '需求状态',
  'qt.title': '质量检查中心',
  'qt.subtitle': '检查项全部由真实文档与记录计算得出，不生成任何编造的问题',
  'qt.run': '运行检查',
  'qt.fix': '让主 Agent 修正',
  'qt.resolve': '标记已解决',
  'qt.dimension': '检查维度',
  'qt.severity': '问题等级',
  'qt.issue': '问题描述',
  'qt.suggestion': '修正建议',
  'qt.target': '涉及文档',
  'qt.clear': '未发现质量问题',
  'qt.clearHint': '当前真实数据通过了全部检查。',
  'dc.title': '产品决策与知识沉淀',
  'dc.subtitle': '待确认、已确认、已变更、已废弃；只有确认后才能进入正式知识库',
  'dc.propose': '提交决策',
  'dc.confirm': '确认',
  'dc.change': '变更',
  'dc.deprecate': '废弃',
  'dc.ingest': '写入正式知识库',
  'dc.status.pending': '待确认',
  'dc.status.confirmed': '已确认',
  'dc.status.changed': '已变更',
  'dc.status.deprecated': '已废弃',
  'sys.noWorkspace': '当前会话没有工作目录，无法定位项目资料。',
  'sys.degraded': '以下宿主能力未接通，相关入口会明确标注而不会伪造结果：',
  'sys.identityHidden': '当前会话不是小黄模式：驾驶舱入口已按注册规则隐藏。',
}

const EN = {
  'panel.label': 'Cockpit',
  'nav.overview': 'Overview',
  'nav.tasks': 'Tasks',
  'nav.analysis': 'Analysis',
  'nav.skills': 'Skills',
  'nav.knowledge': 'Knowledge',
  'nav.business': 'Business analysis',
  'nav.solution': 'Solution design',
  'nav.prd': 'PRD documents',
  'nav.quality': 'Quality checks',
  'nav.decisions': 'Decisions',
  'top.welcome': 'Welcome back, Xiao Huang',
  'top.mode': 'Mode: product manager AI employee',
  'top.project': 'Project',
  'top.status': 'Status',
  'top.date': 'Date',
  'top.quick': 'Quick task',
  'top.identityOk': 'Session identity verified',
  'top.identityHold': 'Identity unconfirmed',
  'top.identityReading': 'Verifying identity…',
  'top.notXiaohuang': 'This Session is not in 小黄 mode: the cockpit stays readable, but the Host refuses every write. Switch to a 小黄 Session to act.',
  'top.idle': 'No task in progress',
  'common.loading': 'Reading real work data…',
  'common.retry': 'Retry',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.new': 'New',
  'common.search': 'Search',
  'common.refresh': 'Refresh',
  'common.detail': 'Details',
  'common.all': 'All',
  'common.none': '—',
  'common.emptyTitle': 'No data yet',
  'common.emptyHint': 'Everything here comes from real tasks, execution records, and the knowledge base; it is currently empty.',
  'common.unverified': 'Host capability unavailable',
  'status.todo': 'Not started',
  'status.analysis': 'Analyzing',
  'status.design': 'Designing',
  'status.executing': 'Executing',
  'status.confirming': 'Awaiting confirmation',
  'status.quality': 'In quality check',
  'status.done': 'Done',
  'status.paused': 'Paused',
  'status.terminated': 'Terminated',
  'priority.P0': 'P0',
  'priority.P1': 'P1',
  'priority.P2': 'P2',
  'priority.P3': 'P3',
  'ov.metric.todo': 'Open tasks',
  'ov.metric.executing': 'Running tasks',
  'ov.metric.confirming': 'Awaiting confirmation',
  'ov.metric.done': 'Completed tasks',
  'ov.metric.knowledge': 'Knowledge to settle',
  'ov.metric.quality': 'Quality issues',
  'ov.current': 'Current work',
  'ov.current.empty': 'No task is being pushed forward right now',
  'ov.recent': 'Recent tasks',
  'ov.todo': 'To-do',
  'ov.quick': 'Quick actions',
  'task.title': 'Task center',
  'task.new': 'New task',
  'sk.title': 'Skill management',
  'kn.title': 'Project knowledge',
  'ba.title': 'Business analysis workbench',
  'so.title': 'Solution design',
  'prd.title': 'PRD documents',
  'qt.title': 'Quality checks',
  'dc.title': 'Decisions and knowledge',
}

PM.dict = { zh: ZH, en: EN }

/** Row order of the plugin's global panel entry (Plugins is 0, Schedule 10, task board 20). */
const PANEL_ID = 'pm-copilot'
const PANEL_ORDER = 15

/**
 * Extract the Agent preset recorded for one Session row.
 *
 * The reliable signal is the `agentPreset` Session projection. It rides the
 * list row's `projectionValues`; when that is absent we try the list snapshot's
 * projection store, and finally an in-memory cache filled by an async read.
 * Anything unknown stays undefined so the gate can fail closed.
 */
function presetOf(state, sessionId, cache) {
  if (!sessionId) return undefined
  const row = state && state.byId ? state.byId[sessionId] : undefined
  const direct = row && row.projectionValues ? row.projectionValues.agentPreset : undefined
  if (typeof direct === 'string' && direct !== '') return direct
  const perSession = state && state.projectionsBySession ? state.projectionsBySession[sessionId] : undefined
  const values = perSession && perSession.values ? perSession.values : undefined
  const nested = values && typeof values.agentPreset === 'string' ? values.agentPreset : undefined
  if (nested) return nested
  if (cache && cache.has(sessionId)) return cache.get(sessionId)
  return undefined
}

/** The Session the main view currently shows, from local reference-source counts. */
function mainSessionId(state) {
  if (!state || !state.byId) return undefined
  for (const id of Object.keys(state.byId)) {
    const row = state.byId[id]
    if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id
  }
  return undefined
}

/** ObservableSnapshot → React value, without relying on React 18's external-store hook. */
function useSnapshot(store) {
  const [value, setValue] = React.useState(() => store.getSnapshot())
  React.useEffect(() => {
    const sync = () => setValue(store.getSnapshot())
    sync()
    return store.subscribe(sync)
  }, [store])
  return value
}

/** Market-safe status helpers shared by pages. */
const STATUS_LABEL = (t, status) => t('status.' + status)
const STATUS_TONE = (t, status) => t('tone.' + status)

PM.util = { presetOf, mainSessionId, useSnapshot, STATUS_LABEL, STATUS_TONE, PANEL_ID }

/** The glyph the sidebar row renders; the shell owns the row itself. */
function PanelIcon({ size }) {
  return h('svg', {
    viewBox: '0 0 20 20', width: size, height: size, fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
  h('rect', { x: 2.5, y: 3, width: 15, height: 14, rx: 2 }),
  h('path', { d: 'M2.5 7.5h15' }),
  h('path', { d: 'M6 12.5h3.2M6 15h6' }),
  h('circle', { cx: 14.2, cy: 12.4, r: 2.1 }))
}

/**
 * Render boundary around one page. A page that throws would otherwise make the
 * shell retract the whole panel entry and leave the center column blank with no
 * explanation, so the failure is rendered as a card instead.
 */
class PageBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return h(PM.kit.Card, null,
        h(PM.kit.Banner, { tone: 'danger', text: '页面渲染失败：' + String((this.state.error && this.state.error.message) || this.state.error) }),
        h('div', { className: 'pmc-dim', style: { marginTop: 8, fontSize: 12 } },
          '该错误只影响这一个页面；切换到其他页面仍可继续使用，把上面的报错发给开发者即可定位。'))
    }
    return this.props.children
  }
}

/** The cockpit page: top bar, module navigation, and the selected module. */
function Cockpit({ ctx, t }) {
  const sessions = useSnapshot(ctx.sessions.list)
  const sessionId = mainSessionId(sessions)
  const row = sessionId && sessions.byId ? sessions.byId[sessionId] : undefined
  // The data root belongs to THIS Session's working directory. Falling back to
  // another Session's directory would mix two projects' records, so an unknown
  // directory is reported instead of guessed.
  const workspacePath = (row && row.cwd) || ''
  const cockpit = PM.useCockpit(sessionId, workspacePath)
  const [page, setPage] = React.useState('overview')
  const snapshot = cockpit.snapshot

  const nav = [
    ['overview', 'overview', null],
    ['tasks', 'tasks', 'todo'],
    ['analysis', 'analysis', null],
    ['business', 'business', null],
    ['solution', 'solution', null],
    ['prd', 'prd', null],
    ['quality', 'quality', 'qualityOpen'],
    ['decisions', 'decisions', 'confirming'],
    ['skills', 'skills', null],
    ['knowledge', 'knowledge', null],
  ]
  const navigate = (key) => { setPage(key) }

  const pageCtx = {
    t, snapshot, sessionId, workspacePath,
    run: cockpit.run, refresh: cockpit.refresh, navigate, page,
    toast: cockpit.pushToast,
  }

  let body
  if (!workspacePath) {
    body = h(PM.kit.Card, null,
      h(PM.kit.Banner, { tone: 'warn', text: t('sys.noWorkspace') }),
      h('div', { className: 'pmc-dim', style: { marginTop: 8, fontSize: 12 } },
        '驾驶舱数据落在会话的工作目录下；当前主导会话没有可读的工作目录，因此不显示任何可能串库的记录。'))
  } else if (cockpit.loading) body = h('div', { className: 'pmc-empty' }, h('strong', null, t('common.loading')))
  else if (cockpit.error) body = h(PM.kit.Card, null,
    h(PM.kit.Banner, { tone: 'danger', text: cockpit.error.message }),
    h('div', { style: { marginTop: 10 } }, h(PM.kit.Button, { label: t('common.retry'), icon: 'refresh', onClick: () => void cockpit.refresh() })))
  else body = h(PageBoundary, null, h(PM.pages[page] || PM.pages.overview, pageCtx))

  const metrics = (snapshot && snapshot.metrics) || {}
  const identity = (snapshot && snapshot.identity) || null
  const verified = identity !== null && identity.verified === true
  // A Session that is not 小黄 keeps the cockpit readable; the Host refuses
  // every write from it, so the panel says so instead of disappearing.
  const modeNotice = snapshot !== null && !verified
    ? h(PM.kit.Banner, { tone: 'warn', text: t('top.notXiaohuang') })
    : null
  const identityText = identity === null
    ? t('top.identityReading')
    : verified
      ? t('top.identityOk') + ' · ' + identity.preset
      : t('top.identityHold')
  const currentTask = snapshot && snapshot.dashboard ? snapshot.dashboard.currentWork : null
  const statusText = currentTask
    ? (U.statusLabel(currentTask.status) + ' · ' + currentTask.title)
    : t('top.idle')
  const projectName = (snapshot && snapshot.workspace && (snapshot.workspace.title || snapshot.workspace.path))
    || PM.env.baseName(workspacePath) || '—'

  return h('div', { className: 'pmc-root' },
    h(PM.kit.KitStyle),
    h('div', { className: 'pmc-topbar' },
      h('div', null,
        h('div', { className: 'pmc-welcome' }, t('top.welcome')),
        h('div', { className: 'pmc-sub' }, t('top.mode'))),
      h('div', { className: 'pmc-spacer' }),
      h('span', { className: 'pmc-chip', title: workspacePath }, t('top.project') + ': ' + projectName),
      h('span', { className: 'pmc-chip', title: statusText }, t('top.status') + ': ' + statusText),
      h('span', { className: 'pmc-chip' }, t('top.date') + ': ' + PM.env.today()),
      h(PM.kit.Button, { label: t('common.refresh'), icon: 'refresh', onClick: () => void cockpit.refresh() }),
      h(PM.kit.Button, {
        label: t('top.quick'), icon: 'plus', variant: 'primary',
        onClick: () => { PM.focus.create = true; setPage('tasks') },
      }),
      h('span', {
        className: 'pmc-chip ' + (verified ? 'pmc-chip-ok' : 'pmc-chip-hold'),
        title: 'Agent 模式：' + ((identity && identity.preset) || '未确认'),
      }, identityText)),
    h('div', { className: 'pmc-body' },
      h('nav', { className: 'pmc-nav', 'aria-label': t('panel.label') },
        h('div', { className: 'pmc-nav-title' }, t('panel.label')),
        nav.map(([key, icon, badgeKey]) => {
          const count = badgeKey === null ? 0 : Number(metrics[badgeKey] || 0)
          return h('button', {
            key, type: 'button', 'data-active': page === key, onClick: () => setPage(key),
            title: t('nav.' + key) + (count > 0 ? '（' + count + '）' : ''),
          }, h(PM.kit.Icon, { name: icon, size: 14 }), h('span', null, t('nav.' + key)),
          count > 0 ? h('span', { className: 'pmc-nav-badge' }, String(count)) : null)
        })),
      h('div', { className: 'pmc-main' },
        h('div', { className: 'pmc-scroll' }, h('div', { className: 'pmc-page' }, modeNotice, body))),
      h('div', { className: 'pmc-toast' },
        cockpit.busy ? h('div', { key: 'busy', 'data-tone': 'busy' }, cockpit.busy + '…') : null,
        cockpit.toasts.map((toast) => h('div', { key: toast.id, 'data-tone': toast.tone, onClick: () => cockpit.dismiss(toast.id) }, toast.text))))
  )
}

/**
 * Register the sidebar row and the main panel; returns one disposer.
 * Both seats are declared by shell plugins, so each registration waits for its
 * declaration through `ctx.slots.inject`.
 */
function registerCockpit(ctx, t) {
  const disposers = []
  disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => t('panel.label'),
    locale: NS,
  }, PanelIcon)))
  disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, () => h(Cockpit, { ctx, t }))))
  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* a collapsed declaration already removed it */ }
    }
  }
}

const inject = ['slots', 'sessions', 'locale', 'layout']

/**
 * Plugin entry: dictionaries, then the cockpit registration.
 *
 * The module value is returned by `99-tail.js`: a `return` here would end the
 * factory before parts 35–55 register their pages, leaving `PM.pages` undefined
 * and every first render throwing (`Cannot read properties of undefined`).
 */
function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'pm-copilot: dictionaries')
  ctx.effect(() => {
    const dispose = registerCockpit(ctx, t)
    return () => {
      try { dispose() } catch { /* the shell declaration is already gone */ }
    }
  }, 'pm-copilot: cockpit registration')
}

