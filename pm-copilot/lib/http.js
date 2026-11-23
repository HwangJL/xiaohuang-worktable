/**
 * HTTP surface of the PM Copilot Host half.
 *
 * Three exact routes under `/api/pm-copilot`, registered through the optional
 * `webServer` service:
 *
 * - `GET  /state`  — full cockpit snapshot (`sessionId` optional, `workspacePath` required);
 * - `POST /action` — every mutation and Agent call (JSON body, 4 MiB cap);
 * - `GET  /file`   — bounded text read of one workspace file.
 *
 * Every request first passes the deployment's own trust fence
 * (`connection.requestRejection(req)`); a deployment without a `connection`
 * service is trusted (the local desktop case) but still checks the method.
 * Any exception answers HTTP 200 with `{ ok:false, code:'internal' }` except
 * the protocol errors 400 (bad request), 403 (path escapes the workspace),
 * 404 (missing file) and 413 (body too large), so the browser never mistakes a
 * domain refusal for a transport failure.
 *
 * @module @local/dsh-pm-copilot/lib/http
 */

import { buildSnapshot, dispatchAction } from './actions.js'
import { fail, isPlainObject, nonEmptyText, readWorkspaceText, resolveWorkspace, tryGetService } from './store.js'

/** Route prefix shared by every endpoint. */
export const API_PREFIX = '/api/pm-copilot'

/** Maximum accepted request body (4 MiB). */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024

/** Maximum text bytes returned by `GET /file`. */
export const MAX_FILE_BYTES = 512 * 1024

/** JSON headers shared by every JSON answer. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {void}
 */
function writeJson(res, status, body, headers = {}) {
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      // The socket is already gone.
    }
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(payload)
}

/**
 * Parse the request URL into a URL object (never throws out of the handler).
 * @param {string|undefined} rawUrl - request URL.
 * @returns {URL}
 */
function requestUrl(rawUrl) {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost')
  } catch {
    return new URL('/', 'http://localhost')
  }
}

/**
 * Run the deployment trust fence.
 *
 * `connection.requestRejection(req)` answers `undefined` for an admitted
 * request and `401`/`403` otherwise. A deployment without `connection` keeps
 * the local-desktop behavior (trusted). A fence that THROWS is treated as a
 * rejection: fail closed.
 * @param {any} ctx - plugin context.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @returns {boolean} true when the request was answered and must not continue.
 */
function guardRequest(ctx, req, res) {
  const connection = tryGetService(ctx, 'connection')
  if (connection === undefined) return false
  try {
    if (typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === 401 || rejection === 403) {
      res.writeHead(rejection)
      res.end()
      return true
    }
    return false
  } catch (error) {
    console.warn('[pm-copilot] connection.requestRejection threw; refusing request', error)
    res.writeHead(403)
    res.end()
    return true
  }
}

/**
 * Bounded request-body reader.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} [maxBytes] - byte cap.
 * @returns {Promise<{ok: true, value: string}|{ok: false, code: string, message: string}>}
 */
async function readRequestBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  try {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk
      size += buffer.length
      if (size > maxBytes) {
        try {
          req.destroy()
        } catch {
          // Already destroyed.
        }
        return fail('body-too-large', `请求体超过上限 ${maxBytes} 字节`)
      }
      chunks.push(buffer)
    }
    return { ok: true, value: Buffer.concat(chunks).toString('utf8') }
  } catch (error) {
    return fail('body-invalid', `读取请求体失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Build the `GET /state` handler.
 * @param {any} ctx - plugin context.
 * @returns {(req: any, res: any) => Promise<void>}
 */
function stateHandler(ctx) {
  return async (req, res) => {
    if (guardRequest(ctx, req, res)) return
    if (req.method !== 'GET') {
      writeJson(res, 400, { ok: false, code: 'method-not-allowed', message: 'GET /api/pm-copilot/state 只接受 GET' })
      return
    }
    const url = requestUrl(req.url)
    const workspacePath = url.searchParams.get('workspacePath')
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    const result = await buildSnapshot(ctx, { workspacePath, sessionId })
    writeJson(res, 200, result)
  }
}

/**
 * Build the `POST /action` handler.
 * @param {any} ctx - plugin context.
 * @returns {(req: any, res: any) => Promise<void>}
 */
function actionHandler(ctx) {
  return async (req, res) => {
    if (guardRequest(ctx, req, res)) return
    if (req.method !== 'POST') {
      writeJson(res, 400, { ok: false, code: 'method-not-allowed', message: 'POST /api/pm-copilot/action 只接受 POST' })
      return
    }
    const body = await readRequestBody(req)
    if (!body.ok) {
      writeJson(res, body.code === 'body-too-large' ? 413 : 400, {
        ok: false,
        code: body.code,
        message: body.message,
      })
      return
    }
    let parsed
    try {
      parsed = JSON.parse(body.value)
    } catch (error) {
      writeJson(res, 400, {
        ok: false,
        code: 'body-invalid',
        message: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    if (!isPlainObject(parsed)) {
      writeJson(res, 400, { ok: false, code: 'body-invalid', message: '请求体必须是 JSON 对象' })
      return
    }
    const result = await dispatchAction(ctx, {
      action: parsed.action,
      sessionId: parsed.sessionId,
      workspacePath: parsed.workspacePath,
      payload: parsed.payload,
      source: 'http',
    })
    writeJson(res, 200, result)
  }
}

/**
 * Build the `GET /file` handler (bounded text with nosniff + no-store).
 * @param {any} ctx - plugin context (unused beyond the trust fence).
 * @returns {(req: any, res: any) => Promise<void>}
 */
function fileHandler(ctx) {
  return async (req, res) => {
    if (guardRequest(ctx, req, res)) return
    if (req.method !== 'GET') {
      writeJson(res, 400, { ok: false, code: 'method-not-allowed', message: 'GET /api/pm-copilot/file 只接受 GET' })
      return
    }
    const url = requestUrl(req.url)
    const workspacePath = url.searchParams.get('workspacePath')
    const filePath = url.searchParams.get('path')
    if (nonEmptyText(filePath) === undefined) {
      writeJson(res, 400, { ok: false, code: 'path-invalid', message: '缺少 path 参数' })
      return
    }
    const workspace = resolveWorkspace(workspacePath)
    if (!workspace.ok) {
      writeJson(res, 200, { ok: false, code: 'workspace-invalid', message: workspace.message })
      return
    }
    const read = await readWorkspaceText(workspace.value.path, filePath, MAX_FILE_BYTES)
    if (!read.ok) {
      if (read.code === 'path-outside-workspace') {
        writeJson(res, 403, { ok: false, code: read.code, message: read.message })
        return
      }
      if (read.code === 'file-not-found') {
        writeJson(res, 404, { ok: false, code: read.code, message: read.message })
        return
      }
      writeJson(res, 200, { ok: false, code: read.code, message: read.message })
      return
    }
    if (res.headersSent) return
    const headers = {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-file-size': String(read.value.size),
    }
    if (read.value.truncated) headers['x-content-truncated'] = 'true'
    res.writeHead(200, headers)
    res.end(read.value.text)
  }
}

/**
 * Register all three exact routes.
 *
 * @param {any} ctx - plugin context.
 * @param {(message: string) => void} [trace] - activation trace sink (tests omit it).
 * @returns {() => void} disposer (no-op when the deployment has no webServer).
 */
export function registerHttpRoutes(ctx, trace = () => {}) {
  const webServer = tryGetService(ctx, 'webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    trace('no webServer service on this context')
    console.warn('[pm-copilot] webServer service unavailable; /api/pm-copilot routes not registered')
    return () => {}
  }
  const disposers = []
  const routes = [
    { kind: 'exact', path: `${API_PREFIX}/state`, handler: stateHandler(ctx) },
    { kind: 'exact', path: `${API_PREFIX}/action`, handler: actionHandler(ctx) },
    { kind: 'exact', path: `${API_PREFIX}/file`, handler: fileHandler(ctx) },
  ]
  for (const route of routes) {
    try {
      // A handler that throws still answers 200+internal instead of letting the
      // server emit a 5xx the client would read as a transport failure.
      const handler = route.handler
      const safeHandler = async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          console.warn(`[pm-copilot] ${route.path} handler failed`, error)
          if (res.headersSent) {
            try {
              res.end()
            } catch {
              // Socket already gone.
            }
            return
          }
          writeJson(res, 200, {
            ok: false,
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      const dispose = webServer.register({ kind: route.kind, path: route.path, handler: safeHandler })
      if (typeof dispose === 'function') disposers.push(dispose)
      trace(`registered ${route.path}`)
    } catch (error) {
      trace(`registering ${route.path} failed: ${error instanceof Error ? error.message : String(error)}`)
      console.warn(`[pm-copilot] registering ${route.path} failed`, error)
    }
  }
  trace(`routes registered: ${disposers.length}`)
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Ignore unload races.
      }
    }
  }
}
