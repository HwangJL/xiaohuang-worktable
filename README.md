# 小黄驾驶舱（xiaohuang-worktable）

DeepSeek Harness（DSH）桌面版上的**产品经理工作台**：一个名为「小黄」的产品经理 Agent preset，加上一个把这些产品工作沉淀成结构化数据的「驾驶舱」插件（PM Copilot）。

工作方式：分析、业务解构、方案设计、PRD 编写仍由主 Agent + 专业 Skill 执行；驾驶舱负责**登记任务、记录阶段与执行、索引知识库、存版本化 PRD、跑质量检查、沉淀决策**——所有展示数据都来自真实文件，宿主能力缺失时明确标注，不伪造。

---

## 1. 仓库包含什么

| 目录 | 包名 | 作用 |
|---|---|---|
| [`pm-copilot/`](./pm-copilot) | `@local/dsh-pm-copilot@1.0.0` | 驾驶舱 bundle：十个页面的左侧栏面板 + `pm_copilot` Agent 工具 + 三条 HTTP 路由 |
| [`xiaohuang-preset/`](./xiaohuang-preset) | `@local/dsh-xiaohuang-preset@1.0.0` | Agent preset `xiaohuang`：产品经理人设与工作守则 |
| [`kb-starter/`](./kb-starter) | — | 知识库起步模板：`SCHEMA.md` + 七类页面模板，复制进工作区即可用 |

两个包都是「bundle 包」（`package.json` 里的 `dsh.bundle.patch` 指向各自的 `cordis.patch.yml`），用 DSH 插件管理器按目录安装，不走 npm registry——包名带 `@local/` 作用域，`private: true`。

---

## 2. 前置条件

- DSH 桌面版 **≥ `0.2.2-rc.3`**（本仓库在 `0.2.2-rc.5` / Windows 上开发并验证）。
- 需要 `sidebar.panellist`、Client Session 投影、`ctx.skills`、`webServer`、`tools`、`sessionController` 等能力；更早的版本无法工作。

---

## 3. 安装

### 3.1 装 Agent preset（`xiaohuang`）

1. DSH → **Plugins** → **Add plugin** → 选择本仓库的 `xiaohuang-preset` 目录。
2. 确认出现 `@local/dsh-xiaohuang-preset 1.0.0`，状态启用。
3. 新建会话时，模式列表里应出现「小黄」（`order: 2`）。

若插件管理器返回 `restart-required`，重启 DSH 后再次确认。

### 3.2 装驾驶舱插件（`pm-copilot`）

1. DSH → **Plugins** → **Add plugin** → 选择本仓库的 `pm-copilot` 目录。
2. 确认出现 `@local/dsh-pm-copilot 1.0.0`，状态启用。
3. 打开任意会话，左侧栏出现「驾驶舱」入口。

也可以在该目录里跑脚本（只做前置校验并交给插件管理器，不手写 profile 文件）：

```powershell
pwsh -File .\install.ps1            # 安装
pwsh -File .\install.ps1 -DryRun    # 只做前置检查
pwsh -File .\uninstall.ps1          # 卸载，保留全部工作数据
pwsh -File .\uninstall.ps1 -Purge   # 卸载并（二次确认后）删除 .pm-copilot
```

### 3.3 初始化知识库（可选）

把模板复制到你的工作区：

```powershell
Copy-Item .\kb-starter .\<你的工作区>\kb -Recurse
```

驾驶舱的「项目知识」页面按 `kb/SCHEMA.md` 的规则检索与写入；没有这些文件时，知识统计如实显示为空。

### 3.4 权限模型

驾驶舱入口常驻，**写操作按会话身份放行**：

| 当前会话的 Agent preset | 入口 | 打开后 |
|---|---|---|
| `xiaohuang` | 出现 | 完整驾驶舱，读写皆可 |
| 其他 preset | 出现 | 可浏览真实数据；顶部提示"当前会话不是「小黄」模式"，写操作被 Host 以 `identity-unverified` 拒绝 |

身份判定在 Host 侧读 DSH 的 Session projection `agentPreset`（`lib/identity.js`），不看用户名、机器信息或登录状态。

---

## 4. 数据落在哪里

```
<工作区>/
├─ .pm-copilot/
│  ├─ state.json      项目 / 任务 / 执行 / 交付物 / 决策 / PRD / 质量 / 技能用量索引
│  ├─ audit.jsonl     只追加的操作审计
│  ├─ prd/<project>/  PRD 各版本 Markdown（只新建，不覆盖旧版本）
│  ├─ quality/        质量检查报告
│  └─ roots.json      可选：额外知识根目录声明
└─ kb/               知识库（按 kb/SCHEMA.md 新建页面，不覆盖正式页）
```

插件只存索引与关联关系，不复制知识库正文；卸载不会删除 `.pm-copilot/` 或 `kb/`。

---

## 5. 开发与验证

```powershell
cd pm-copilot
node scripts/build-client.mjs      # 由 src-client/*.js 合成 client.js 产物
node scripts/verify.mjs            # 41 组契约与行为检查
node tests/host.test.mjs           # Host 半边集成测试（15 项）
node tests/client-gate.test.mjs    # 客户端注册层测试（7 项）
node tests/render.test.mjs         # 客户端渲染冒烟（首屏 + 十个页面）
```

当前状态（Windows，Node 24，DSH `0.2.2-rc.5`）：

| 检查 | 结果 |
|---|---|
| `scripts/verify.mjs` | 41 组全通过 |
| `tests/host.test.mjs` | 15 / 15 |
| `tests/client-gate.test.mjs` | 7 / 7 |
| `tests/render.test.mjs` | 2 / 2 |
| `client.js` 与 `src-client/*.js` 重建后字节一致 | 是（177,092 bytes） |

`client.js` 是生成产物，不要手改。

---

## 6. 已知限制（如实说明）

1. **Skill 没有版本字段**：DSH 的 Skill 注册表只提供 `name/description/whenToUse/invocation/source/provider/path`，界面显示来源与提供方，不虚构版本号。
2. **没有"编程式调用 Skill 并立即执行"的 API**：驾驶舱把"请使用某 Skill"的指令真实发给主 Agent，由主 Agent 自己用 `skill` 工具加载。
3. **HTTP 路由不提供认证**：插件对每个请求调用 `connection.requestRejection(req)`；没有 `connection` 服务的纯本地部署才放行。
4. **第三方插件不能注册自己的 Remote namespace**：Host↔Client 通信只走同源 exact HTTP 路由。
5. **视觉细节未在真实浏览器逐像素确认**：`tests/render.test.mjs` 在 Node 里用迷你 React 逐页渲染（首屏与十个页面都能出内容、不抛错），颜色、间距与窄窗口表现以真实打开为准。
6. **只在 Windows + DSH 桌面版验证过**；其他平台未实测。

---

## 7. 许可

MIT，见 [LICENSE](./LICENSE)。
