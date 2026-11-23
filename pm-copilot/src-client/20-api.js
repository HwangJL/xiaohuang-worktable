/**
 * PM Copilot — Client half, part 20: Host API client and the cockpit data hook.
 *
 * Every request is same-origin and document-relative, matching the way the page
 * is served with `<base href="./">`. The Host half owns all authority: this
 * module never fabricates a record and never performs an operation locally.
 */

/** Document-relative base of the plugin's routes (the Host registers them root-absolute). */
const API_BASE = 'api/pm-copilot'

/** A transport failure with a Chinese user-facing message and a stable code. */
function apiError(code, message, detail) {
  const error = new Error(message)
  error.code = code
  error.detail = detail
  return error
}

/** Map one response status onto a message a product manager can act on. */
function failureForStatus(status) {
  if (status === 401) return apiError('unauthorized', '身份校验未通过：请确认当前会话仍是小黄模式后再试。')
  if (status === 403) return apiError('forbidden', '该请求被拒绝：当前公话身份或来源不被允许。')
  if (status === 404) return apiError('not-mounted', 'Host 半边未挂载：插件可能刚被停用，请重启 DSH 或检查 Plugins 里是否启用。')
  return null
}

/** Read one JSON response without handing a non-JSON body to JSON.parse. */
async function readJson(response) {
  const known = failureForStatus(response.status)
  if (known !== null) throw known
  const text = await response.text()
  if (text.trim() === '') throw apiError('empty-response', 'Host 返回了空响应。')
  let parsed
  try { parsed = JSON.parse(text) } catch { throw apiError('bad-response', 'Host 返回的不是 JSON：' + PM.env.clip(text, 80)) }
  if (parsed !== null && typeof parsed === 'object' && parsed.ok === false) {
    throw apiError(parsed.code || 'rejected', parsed.message || 'Host 拒绝了该请求', parsed)
  }
  return parsed
}

/** Transport surface used by the cockpit and by page-local actions. */
const api = {
  /**
   * Read the whole cockpit snapshot.
   * @param sessionId - main-view Session id, or undefined when none is open.
   * @param workspacePath - Session working directory (the data root lives beside it).
   * @returns the snapshot value.
   */
  async read(sessionId, workspacePath) {
    const query = new URLSearchParams()
    if (sessionId) query.set('sessionId', sessionId)
    if (workspacePath) query.set('workspacePath', workspacePath)
    const response = await fetch(API_BASE + '/state?' + query.toString(), { headers: { accept: 'application/json' }, cache: 'no-store' })
    const body = await readJson(response)
    return body.value
  },
  /**
   * Run one Host action and return its value.
   * @param action - the action name understood by `lib/actions.js`.
   * @param payload - action arguments.
   * @param sessionId - acting Session id.
   * @param workspacePath - Session working directory.
   * @returns the action value.
   */
  async act(action, payload, sessionId, workspacePath) {
    const response = await fetch(API_BASE + '/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ action, payload: payload || {}, sessionId, workspacePath }),
    })
    const body = await readJson(response)
    return body.value
  },
  /**
   * Read one file inside the workspace (knowledge page, PRD version, deliverable).
   * @param path - absolute path under the workspace.
   * @param workspacePath - Session working directory.
   * @returns `{ path, text, truncated }`.
   */
  async file(path, workspacePath) {
    const query = new URLSearchParams({ path, workspacePath: workspacePath || '' })
    const response = await fetch(API_BASE + '/file?' + query.toString(), { cache: 'no-store' })
    if (!response.ok) {
      throw failureForStatus(response.status)
        || apiError('file-unreadable', '无法读取该文件（HTTP ' + response.status + '）')
    }
    const text = await response.text()
    return { path, text, truncated: response.headers.get('x-content-truncated') === 'true' }
  },
}

PM.api = api

/**
 * Cockpit data hook: one snapshot plus a mutating runner.
 *
 * Reading is a plain fetch; after a successful mutation the whole snapshot is
 * re-read, so the UI can only ever show Host-authoritative state.
 *
 * @param sessionId - main-view Session id.
 * @param workspacePath - Session working directory.
 * @returns `{ snapshot, loading, busy, error, refresh, run, toasts, dismiss }`.
 */
function useCockpit(sessionId, workspacePath) {
  const [snapshot, setSnapshot] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [toasts, setToasts] = React.useState([])
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  const pushToast = React.useCallback((text, tone) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((prev) => prev.concat([{ id, text, tone }]))
    globalThis.setTimeout(() => {
      if (!alive.current) return
      setToasts((prev) => prev.filter((x) => x.id !== id))
    }, tone === 'danger' ? 7000 : 3800)
  }, [])

  const refresh = React.useCallback(async () => {
    if (!workspacePath) {
      setSnapshot(null)
      setLoading(false)
      setError({ code: 'no-workspace', message: '当前会话没有工作目录，驾驶舱无处存放数据。' })
      return
    }
    try {
      const value = await api.read(sessionId, workspacePath)
      if (!alive.current) return
      setSnapshot(value)
      setError(null)
    } catch (err) {
      if (!alive.current) return
      setError({ code: err.code || 'read-failed', message: err.message || '读取驾驶舱数据失败' })
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [sessionId, workspacePath])

  React.useEffect(() => {
    alive.current = true
    setLoading(true)
    void refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  // A queued prompt is not a result: while any execution is still `sent`, the
  // Agent may be working, so the cockpit follows it with a quiet re-read. The
  // poll stops as soon as nothing is in flight, and it never writes anything —
  // the Host stays the only authority.
  const inFlight = snapshot !== null && snapshot !== undefined
    && PM.list(snapshot.executions).some((execution) => execution.status === 'sent' || execution.status === 'running')
  React.useEffect(() => {
    if (!inFlight || !workspacePath) return undefined
    const timer = globalThis.setInterval(() => { void refresh() }, 4000)
    return () => globalThis.clearInterval(timer)
  }, [inFlight, workspacePath, refresh])

  const run = React.useCallback(async (action, payload, options) => {
    const label = (options && options.label) || action
    setBusy(label)
    try {
      const value = await api.act(action, payload, sessionId, workspacePath)
      await refresh()
      if (options && options.success) pushToast(options.success, 'ok')
      return value
    } catch (err) {
      const detail = err && err.detail && err.detail.message ? err.detail.message : (err.message || '操作失败')
      pushToast(detail, 'danger')
      throw err
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [sessionId, workspacePath, refresh, pushToast])

  return { snapshot, loading, busy, error, refresh, run, toasts, pushToast, dismiss: (id) => setToasts((p) => p.filter((x) => x.id !== id)) }
}

PM.useCockpit = useCockpit
