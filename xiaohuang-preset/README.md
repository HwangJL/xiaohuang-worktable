# xiaohuang-preset — Agent preset「小黄」

一个 DSH bundle 包，只做一件事：往 profile 里插入一个可选的 Agent preset（`id: xiaohuang`，显示名「小黄」，`order: 2`）。它不含任何运行时代码，全部内容就是 [`cordis.patch.yml`](./cordis.patch.yml) 里的 YAML。

## 里面有什么

| 部分 | 内容 |
|---|---|
| `preset-xiaohuang` | `@deepseek-ai/dsh-agent-preset` 声明：id / name / description / order |
| `persona` | 身份（`prefix`）+ 行为守则（`suffix`，产品经理岗位定位的完整正文） |
| 工具与能力 | `agent-instructions`、`time-context`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-schedule`、`skill-filesystem`、`tool-skill`、`tool-goal`、`planning`、`plan-mode`、`compaction`、`delegation`、`tool-subagent`、`tool-subagent-fork`、`workflow-ptc`、`tool-workflow`、`tool-ask-user`、`tool-todo`、`tool-web`、`present`、`tool-office`、`tool-plugin-manager` 等 |

人设与守则正文（829 行里的绝大部分）直接写在 YAML 的 block scalar 里，改文案就是在改这段 YAML——注意它是行敏感的，仓库的 `.gitattributes` 已强制 LF。

## 安装

DSH → **Plugins** → **Add plugin** → 选择本目录 → 确认 `@local/dsh-xiaohuang-preset 1.0.0` 启用；新建会话时模式列表出现「小黄」。返回 `restart-required` 时重启 DSH。

安装后该 preset 才会出现在模式选择里；驾驶舱插件的写操作也按这个 preset id（`xiaohuang`）放行。

## 说明

- 包名带 `@local/` 且 `private: true`：不走 npm registry，只能按目录安装。
- 本 bundle 只声明，不写入任何工作区文件；卸载即从模式列表消失。
