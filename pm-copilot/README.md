# PM Copilot（产品经理驾驶舱）

面向 DSH「小黄」产品经理模式统一工作入口的 bundle 插件。

- **左侧栏入口在任何会话都注册**（当前版本起）：入口不再随 Agent preset 出现/消失。非「小黄」会话里驾驶舱仍可浏览，但顶部会提示"当前会话不是「小黄」模式"，所有写操作由 Host 拒绝（`identity-unverified`）。
- 驾驶舱是**管理与可视化界面**：需求理解、业务分析、PRD 编写仍由**主 Agent + 专业 Skill**执行，插件不替代它们。
- 所有展示数据来自真实任务记录、真实执行事件与真实知识库文件；宿主能力缺失时明确标注，不伪造。

---

## 1. 它解决什么

产品经理打开驾驶舱，能立刻知道：现在有哪些任务、正在推进什么需求、每个任务处于哪个产品阶段、AI 已经完成什么、哪里有问题、下一步做什么、调用了哪些 Skill、检索了哪些资料、生成了哪些交付物、哪些需要确认、哪些知识已沉淀。

十个模块：工作总览 / 任务中心 / 任务分析与拆解 / 专业 Skill / 项目知识 / 业务分析工作台 / 产品方案设计 / PRD 文档 / 质量检查 / 决策与知识沉淀。

---

## 2. 安装

前置：DSH 桌面版 ≥ `0.2.2-rc.3`（本插件在 `0.2.2-rc.5` 上开发与验证），已安装产品经理模式（Agent preset id `xiaohuang`，见仓库根的 [`xiaohuang-preset/`](../xiaohuang-preset)）。

### 方式 A：插件管理器（推荐）

1. 打开 DSH → **Plugins** → **Add plugin**。
2. 选择你的检出目录里的 `pm-copilot` 文件夹（含 `package.json` 的那一层）。
3. 确认列表里出现 `@local/dsh-pm-copilot 1.0.0`，状态为启用。

### 方式 B：脚本

```powershell
pwsh -File .\install.ps1            # 检查 + 通过插件管理器安装
pwsh -File .\install.ps1 -DryRun    # 只做前置检查，不改任何东西
```

脚本只做三件事：校验包结构 → 校验 profile → 调用插件管理器安装；它**不会**手写 profile 的 `package.json` / `cordis.patch.yml`（那是插件管理器独占的文件）。

### 方式 C：agent 会话里让 agent 装

在任意 DSH 会话里说"把（本仓库的）`pm-copilot` 目录作为 bundle 安装"，agent 会用插件管理器完成同样的步骤。

安装后左侧栏就会出现「驾驶舱」入口，任意会话都能打开。要真正执行动作（写回任务、分析、PRD 等），需要**新建一个「小黄」模式的会话**——写操作由 Host 按会话身份放行，其他 preset 一律返回 `identity-unverified`。

---

## 3. 使用

### 3.1 入口与身份

| 当前主视图会话的 Agent preset | 左侧栏入口 | 打开后 |
|---|---|---|
| `xiaohuang` | 出现 | 完整驾驶舱，读写皆可 |
| 其他任何 preset（`standard` 等） | 出现（常驻） | 可浏览；顶部提示"当前会话不是「小黄」模式"，写操作被 Host 拒绝 |
| 没有会话 / 读取中 | 出现（常驻） | 提示当前会话没有工作目录 |

判定与放行都在 Host 侧：`lib/identity.js` 读 DSH 的 Session projection `agentPreset`（`session_projcache` 的权威行或列表行的 `projectionValues`），不是用户名、机器信息或登录状态。

> 为什么改成常驻：早期版本让入口随 preset 注册/注销，一旦恢复的布局仍指向已被注销的面板，中心区就是一片空白（v1.0.0 实测出现过）。常驻入口 + 面板内提示消除了这一类"面板凭空消失"的现象。

### 3.2 第一次使用（5 分钟）

1. 打开驾驶舱 → **任务中心** → **新建任务**：填名称/描述/类型/优先级。
   - 空工作区首次写入会自动创建"当前工作区"项目，不需要先建项目。
2. **任务分析** → 选该任务 → **让主 Agent 分析这个任务**。
   - 这会真实调用 `sessionController.prompt`，把任务上下文发给当前会话的主 Agent。
   - 主 Agent 完成后用 `pm_copilot` 工具把结果写回驾驶舱（分析、子任务、执行计划）。
3. 回到**工作总览**：指标、当前工作、待办、最近任务都随着真实记录变化。
4. 依次用 **业务分析 → 方案设计 → PRD → 质量检查 → 决策沉淀** 推进。

### 3.3 各个按钮做什么

| 按钮 | 真实行为 |
|---|---|
| 新建任务 / 更新阶段 / 暂停 / 终止 | 写 `<workspace>/.pm-copilot/state.json`（原子写 + 审计） |
| 让主 Agent 分析 / 执行 / 组合 Skill | `sessionController.prompt` 真实入队一条消息并唤醒主 Agent，先记执行记录再发送 |
| 项目知识检索 | 扫 `kb/wiki`、`kb/raw`、`kb/SCHEMA.md`、`roots.json` 声明的目录，按标题/标签/摘要/正文命中打分 |
| 沉淀一条知识 | 按 `kb/SCHEMA.md` 新建 `kb/wiki/<type>/<ID>-<slug>.md`，追加 `index.md` 与 `log.md`，**不覆盖任何正式页** |
| PRD 保存 | 写 `prd/<project>/<slug>.v<N>.md` 新文件；旧版本文件不修改 |
| PRD 确认当前版本 | 只确认**当前那一个版本**，记录确认人/确认时间/版本号；之后再保存新版本会自动回到「草稿」，需要重新确认 |
| 运行检查 | 对真实任务/业务数据/PRD/知识库做确定性检查，产出问题与报告 |
| 决策确认 / 变更 / 废弃 / 写入知识库 | 状态机推进，保留历史；只有显式"写入正式知识库"才落盘正式页 |

---

## 4. 数据放在哪里

```
<workspace>/
├─ .pm-copilot/
│  ├─ state.json          驾驶舱索引（项目/任务/执行/交付物/决策/PRD/质量/技能用量）
│  ├─ audit.jsonl         只追加的操作审计
│  ├─ prd/<project>/       PRD 各版本 Markdown（只新建，不覆盖）
│  ├─ quality/            检查报告
│  └─ roots.json          可选：额外知识根目录声明
└─ kb/                    知识库（遵循 kb/SCHEMA.md，插件只按规则新建页面）
```

**插件只保存索引与关联关系，不复制知识库正文。** 卸载不会删除 `.pm-copilot/` 或 `kb/`。

---

## 5. 卸载

```powershell
pwsh -File .\uninstall.ps1              # 移除插件，保留全部工作数据
pwsh -File .\uninstall.ps1 -Purge      # 移除插件并（二次确认后）删除 .pm-copilot
```

或在 DSH → Plugins 里移除/停用该 bundle。卸载后 `.pm-copilot/`、`kb/`、项目文档全部保留。

---

## 6. 已知限制（如实说明）

1. **Skill 没有"版本"字段**：DSH 的 Skill 注册表只提供 `name/description/whenToUse/invocation/source/provider/path`。界面因此显示**来源与提供方**而不是虚构版本号。
2. **没有"编程式调用 Skill 并让模型立即执行"的 API**：驾驶舱的做法是把"请使用某 Skill"的指令真实发给主 Agent，由主 Agent 自己用 `skill` 工具加载——这是当前版本唯一受支持的路径。
3. **HTTP 路由需要自己实现信任栅栏**：`webServer` 不提供认证。本插件对每个请求调用 `connection.requestRejection(req)`；无 `connection` 服务的部署（纯本地）才放行。
4. **第三方插件不能注册自己的 Remote namespace**：Host↔Client 通信只能走同源 exact HTTP 路由（本插件即如此）。
5. **入口常驻，写权限仍按会话身份判定**：非「小黄」会话能看到驾驶舱并浏览真实数据，但任何写操作都会被 Host 拒绝（`identity-unverified`）。客户端不再做注册层的显隐判断，避免"入口消失后中心区空白"。
6. **视觉细节未在本机浏览器中人工确认**：`tests/render.test.mjs` 已在 Node 里用迷你 React 逐页渲染（首屏与十个页面都能渲染出内容、不再抛错），颜色、间距与窄窗口表现仍以真实打开为准。
7. 需要重启 DSH 才稳定生效的情形：插件管理器返回 `restart-required` 时（本机安装返回 `applied`，无需重启）。

---

## 7. 开发

```powershell
node scripts/build-client.mjs      # 由 src-client/*.js 合成 client.js 产物
<Electron> scripts/check-parts.mjs # 逐段语法检查（用安装内的 acorn）
node tests/host.test.mjs           # Host 半边集成测试（15 项）
node tests/client-gate.test.mjs    # 客户端注册层测试（7 项）
node tests/render.test.mjs         # 客户端渲染冒烟（首屏 + 十个页面逐页渲染）
```

源码结构：

| 路径 | 作用 |
|---|---|
| `index.js` | Host 入口：路由、工具、按 Agent 作用域的提示段、事件记录器 |
| `lib/identity.js` | 三态身份判定（xiaohuang / other / 无法确认），写操作 fail closed |
| `lib/http.js` | 三条 exact 路由 + 信任栅栏 |
| `lib/actions.js` | 全部读写 action（UI 与 Agent 工具共用同一实现） |
| `lib/kb.js` | 知识库扫描/检索/按 SCHEMA 新建页面 |
| `lib/quality.js` | 确定性质量检查 |
| `lib/tools.js` | `pm_copilot` 工具 |
| `src-client/*.js` | 客户端（UI 组件库、数据 hook、身份门、十个页面） |
| `client.js` | 生成的客户端产物（不要手改） |

---

## 8. 兼容性

- DSH `0.2.2-rc.5`（DSH 桌面版，Windows）上实测：bundle 安装返回 `application: applied`，Loader 行 `pm-copilot` 为 `enabled: true` / `fiberPhase: active`。
- 声明的最低要求为 `>=0.2.2-rc.3`（与同 profile 里的 task-board 一致）。更早版本缺少 `sidebar.panellist`、Client Session 投影、`ctx.skills` 等依赖，将无法工作。
- 不修改 DSH 核心，不写入 `Agent.md`，不重建既有 Skill，不写员工守则副本。
