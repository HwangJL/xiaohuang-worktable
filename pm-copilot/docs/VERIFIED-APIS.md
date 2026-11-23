# 已核实的 DSH API（本插件依赖的全部机制与证据）

本文件记录 **PM Copilot 实际依赖的每一个 DSH 机制**，以及该结论的出处。开发环境为 DSH 桌面版 `0.2.2-rc.5`，安装根
`D:\APP\deepseek harness\resources\app.asar\dsh\node_modules\@deepseek-ai\`。凡标注「未核实」的，插件不依赖它。

> 为什么要这份文件：需求里明确要求「禁止凭空假设 DSH API、Manifest 字段、Patch 语法或者插件生命周期」。这里把每条依赖的
> 真实出处列出来，便于后续升级时逐条复核。

---

## 1. Bundle 与 Manifest

| 结论 | 证据 |
|---|---|
| bundle = `package.json` 中声明 `dsh.bundle.patch` 的包；patch 用 Loader 语法插入插件行 | `dsh-agent-preset/skills/dsh-doc/references/host-plugin.md:3`、`:7-27` |
| `exports["."]` 是 Host 半边入口；`exports["./client"]` 是浏览器半边；`dsh.client` 触发客户端扫描 | `references/ui-plugin.md:3-11`；真实范例 task-board `package.json:9-43` |
| patch 只插**一行**，Host 与 Client 由同一行驱动 | 同上；task-board `cordis.patch.yml` 全文 |
| 结构化 `exports` 的 `./client` 可以是字符串；Host 用 `dirname(pkgJson)+该相对路径` 求客户端产物路径 | `dsh-client-modules/lib/index.js:199-210`、`:783-803` |
| 客户端 factory 的 `id` 必须等于包名 | `references/ui-plugin.md:9`；本插件 `src-client/00-head.js:9` |
| `dsh.client.inject` 只影响加载/预取，不决定 apply 顺序 | `dsh-client-ui-workspace/src/client/index.ts:127-136` |

## 2. 左侧栏入口（硬性需求的实现依据）

| 结论 | 证据 |
|---|---|
| `sidebar.panellist` 是 `sidebar` 声明的 root-scoped list 槽 | `dsh-client-ui-sidebar/src/client/contract/slots.ts:43-49`、`src/client/index.ts:88-101` |
| 注册项字段只有 `id` / `order` / `label`（`label` 可为返回字符串的函数） | `README.md:42`；`src/client/index.ts:56-62` |
| 侧栏行**完全由槽的实时注册表派生**：`entriesOfSlot('sidebar.panellist')` → 排序 → snapshot store，并订阅槽变更 | `dsh-client-ui-sidebar/src/client/index.ts:56-71`；`SidebarRoot.tsx:416-433` |
| 因此**注册/注销会让左侧行实时出现/消失** | 同上；`dsh-client-ui-workspace/README.md:225`（`ctx.slots.inject` 的声明生命周期语义） |
| 图标组件只收到 `{size, active}`，外壳拥有行盒子/标签/高亮/折叠 | `contract/slots.ts:103-108`；`PanelIcon.tsx:10-12` |
| 同一 id 的中央页面注册到 layout 的 keyed `main` 槽 | `dsh-client-ui-layout/src/client/index.ts:71-75`；task-board `native-panel.tsx:116-136` |
| `ctx.layout.selectPanel(id)` 对未注册 key 抛错且保持当前选择；`null` 回到 Conversation | `dsh-client-ui-layout/src/client/service.ts:72-78` |
| **不存在**按会话条件隐藏行的原生开关（`visible`/`when`） | `contract/slots.ts:103-118`；`panel-pins.ts:25-33`（只有全局内存 unpin） |

**结论**：需求里“必须在注册层实现条件显示”是可实现的——但实现方式只能是**按条件注册/注销**，而不是给行加可见性参数。

## 3. 会话身份

| 结论 | 证据 |
|---|---|
| 会话的 preset 是 **Session projection `agentPreset`**（回答「这是哪个模式」的唯一可靠信号） | `dsh-agent-preset-registry/src/session.ts:37-46`；`src/types.ts:50-55` |
| 它在列表行里以 `SessionSummary.projectionValues` 出现（可短暂缺失） | `dsh-api-session-controller/src/client/sessions/service.ts:27-58`（`projectionValues`） |
| 主视图当前会话 = 该会话的 `retainedBy.mainView > 0` | `dsh-client-ui-layout/src/client/DocumentTitle.tsx:17-23`；`dsh-client-ui-session/src/client/index.ts:460-475` |
| 没有 `session/selected` 事件；切换只能从 `sessions.list` 派生 | 同上（`subscribe` 到 list store） |
| `ISessions.refreshProjections(sessionId)` 可在不打开会话的前提下读投影 | `src/client/contract/sessions.ts:101-106` |
| Host 侧可用 `sessions.get(id).header.agentPreset`、`agentPresets.presetForSession(session)` | `dsh-api-session-controller/src/agent.ts:241`、`presetForSession` |
| 投影缓存落盘 `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`，行内含 `agentPreset.val` | 本机实测（见 `docs/VERIFIED-APIS.md` 附录实测记录） |

## 4. Host ↔ Client 通信

| 结论 | 证据 |
|---|---|
| 第三方 bundle 的可行通道：`ctx.webServer.register({kind:'exact', path, handler})` 注册同源路由 | `dsh-host-webserver/src/index.ts:52-58`、`:445-452`；task-board `src/index.ts:756` |
| `WebRoute` 没有 `method` 字段，handler 自己看 `req.method`；也没有内置认证 | `dsh-host-webserver/README.md:132` |
| `/api` prefix 已被 `client-connection` 独占，但 **exact** 路由可压过 prefix | `dsh-client-connection/src/index.ts:141-160`；本插件用 `/api/pm-copilot/*` exact |
| 浏览器端同源 `fetch` 自动带 HttpOnly Cookie；路由 owner 自己做栅栏 | `dsh-client-connection/README.md:41-43`、`rpc.ts:104-127`（`requestRejection`/`admit`） |
| 第三方**不能**注册 Remote namespace（Client 装配是构建期固定） | `dsh-api-remotes/README.md:77-79`；`dsh-api-gateway` 只接受 generated contribution |
| 前端禁止 `require` Harness Client 包 | `references/practices.md:35` |

## 5. 主 Agent 调用

| 结论 | 证据 |
|---|---|
| `ctx.sessionController.prompt({requestId, sessionId, mode:'queue', content})` 是把用户消息送进某会话并唤醒其 Agent 的现成语义（冷会话可用） | `dsh-api-session-controller/src/index.ts:467-491`；`README.md:38` |
| `session/prompt` 的 wire 参数形状（`mode: 'queue'`、`content: [{type:'text',text}]`） | task-board `host-runner.ts:805-813` |
| 直接 `Session.append('user/message')` **不会**唤醒 Agent | `dsh-session/README.md:44-52`；`dsh-agent/src/runtime-types.ts:245-271` |
| `agent.followup()/steer()` 唤醒，`inject()` 不唤醒 | `dsh-agent/src/runtime-types.ts:245-271`；`references/practices.md:29` |

## 6. Skill

| 结论 | 证据 |
|---|---|
| `ctx.skills.list({cwd})` / `.snapshot()` / `.get(name,{cwd})` 是读真实 Skill 目录的接口 | `dsh-skill/src/index.ts:470-517` |
| `SkillSummary` 字段：`name/description/whenToUse/invocation/source/provider/path/resourceBase`，**无 version** | `dsh-skill/src/index.ts:57-74` |
| 模型侧 Skill 由 `skill` 工具加载；用户显式 `/name` 会在 pre-step 注入 | `dsh-tool-skill/src/index.ts:84-89`、`:181-208` |
| 没有“Host 编程式调用 skill 并立即生效”的 API；替代是让 Agent 自己加载 | `dsh-tool-skill/src/index.ts:140-165`；`renderSkillContent` 在 `dsh-skill/src/index.ts:170-183` |

## 7. 事件与轨迹

| 结论 | 证据 |
|---|---|
| Host 事件：`ctx.on('session/event', (session, event) => …)`、`agent/created`、`tools/result` | `dsh-session/src/index.ts:56-87`；`dsh-agent/src/runtime-types.ts:291` |
| 耐久事件类型：`turn/start`、`turn/end`（`reason.kind`）、`step/*`、`user/message`、`assistant/message`、`tool/call`、`tool/result` | `dsh-session/src/known-event-types.ts:22-86`；`src/types.ts:294-393` |
| 不能自造新事件类型（未知事件会让 Session 无法重开） | `references/practices.md:21` |

## 8. 持久化

| 结论 | 证据 |
|---|---|
| 挂载了 `ctx.storage` + `ctx.storageDomain`（JSON 后端，落 `$DSH_HOME/storages`） | `dsh-base/cordis.patch.yml:175-190` |
| `ctx.storageDomain.open(spec)` + `domain.table(kv).put/get/update` | `dsh-storage-domain/README.md:52-56`；`src/domain.ts:43-108` |
| `domain/changed` 只在本进程可见 | `dsh-storage-domain/README.md:146` |
| 本插件**选择**把索引写成工作区内的 `state.json`（原子写 + 审计），理由见 `SPEC.md`：数据必须与项目一起可见、可版本化、卸载不丢；不把项目知识塞进 DSH 内部 storages | 设计选择，非 DSH 强制 |

## 9. 主题与本地化

| 结论 | 证据 |
|---|---|
| `ctx.locale.register(ns, {zh,en,…})` / `bind(ns)` / `subscribe` | `dsh-client-locale/src/client/index.ts:390-478` |
| 主题 token 由 `ui-theme` 定义，`--dsw-alias-*` 是本插件唯一取色来源 | `dsh-client-ui-theme/src/styles/design-platform.css:250-352` |
| 深浅色由 `body[data-ds-dark-theme]` 切换，token 会随之改变 | 同上 `:328-352` |
| locale 目录（`locale/en.json`、`locale/zh.json`）只供插件管理器读 `meta.title/description/detail`，不是运行时字典 | `references/host-plugin.md:31-43` |

## 10. 未核实 / 明确不依赖

- **未核实**：`cordis_inspect_*` 工具（本会话没有该工具），所以运行时注册状态改由「插件管理器 `list_plugins` 的 `fiberPhase`」与自建测试观察。
- **未核实**：`WebRoute.auth` 字段——本版本接口只有 `kind/path/handler`（`dsh-host-webserver/src/index.ts:52-58`），task-board 里的 `auth:'anonymous'` 属于另一条构建线，本插件不依赖。
- **不依赖**：`localStorage` 持久化任务（task-board 的做法）；本插件的权威数据在 Host 的 `state.json`。
- **不依赖**：`subagent`/`workflow` 编排；插件只调用当前会话的主 Agent。
