# PM Copilot — implementation contract (authoritative)

This file is the contract between the Host half (`index.js` + `lib/*.js`) and the
Client half (`client.js`, generated from `src-client/*.js`). Every statement below
was verified against the installed DSH 0.2.2-rc.5 packages; the evidence paths are
recorded in `docs/VERIFIED-APIS.md`.

## Hard rule: sidebar visibility is a REGISTRATION-layer decision

`sidebar.panellist` is a root-scoped dynamic list owned by `@deepseek-ai/dsh-client-ui-sidebar`.
The sidebar derives its rows from `ctx.slots.entriesOfSlot('sidebar.panellist')` on every
slot change, so **registering or disposing the registration makes the row appear or
disappear in real time**. PM Copilot uses exactly that mechanism:

1. Compute the identity of the main-view Session from `ctx.sessions.list`:
   the Session whose `retainedBy.mainView > 0`.
2. Read its Agent preset from `projectionValues.agentPreset` (fallback:
   `projectionValues` absent → try `projectionsBySession[id].values.agentPreset`).
3. Register the `sidebar.panellist` entry + the matching `main` panel **only when**
   the preset is exactly `xiaohuang`.
4. When the main-view Session changes, when its preset changes, or when a
   reconnect replaces the projection, dispose and re-evaluate.
5. Any unknown/ambiguous/unavailable identity hides the plugin. Fail closed — never
   show the entry and then deny inside the page.

The Client half therefore never registers a "hidden" panel and the page has no
"you are not 小黄" screen: absence is the only state other Sessions can observe.

## Host routes (same-origin, exact)

All routes are registered with `ctx.webServer.register({kind:'exact', path})`.

| Route | Method | Purpose |
|---|---|---|
| `/api/pm-copilot/state` | GET | Full cockpit snapshot |
| `/api/pm-copilot/action` | POST | Every mutation and agent call |
| `/api/pm-copilot/file` | GET | Read one knowledge/deliverable file (text, bounded) |

`GET /api/pm-copilot/state?sessionId=...&workspacePath=...`

`POST /api/pm-copilot/action` body:
```json
{ "action": "task.create", "sessionId": "...", "workspacePath": "...", "payload": { } }
```
Response `{ "ok": true, "value": ... }` or `{ "ok": false, "code": "...", "message": "..." }`.

Trust fence on every request: `ctx.get('connection')?.requestRejection(req)` must
return `undefined` (401/403 otherwise). Every mutating action additionally verifies
that the named Session's Agent preset is `xiaohuang` (via the `session/projections`
gateway call when available). A request without `sessionId` is rejected for
mutations; reads degrade to the empty store when identity cannot be verified.

## Data root

`<workspacePath>/.pm-copilot/`:

| File | Content |
|---|---|
| `state.json` | The whole index: projects, tasks, executions, deliverables, decisions, knowledge entries written by the cockpit, PRDs, quality issues, skill usage |
| `audit.jsonl` | Append-only operation log (one JSON object per line) |
| `prd/<project>/<slug>.v<N>.md` | PRD versions (original version is immutable) |
| `quality/<stamp>.json` | Quality check reports |

The plugin never deletes project files, never rewrites the knowledge base in place,
and uninstalling the bundle leaves `.pm-copilot/` and `kb/` untouched.

## Knowledge base (read)

Read `<workspace>/kb/` according to `kb/SCHEMA.md`:

- `kb/wiki/**/*.md` → parsed frontmatter (`title,id,type,project,status,confirmed,scope,sources,tags,created,updated`)
  plus the `## 摘要` paragraph. `status` is `正式 | 待确认 | 历史`.
- `kb/raw/**` → raw sources, listed as read-only references.
- `kb/templates/*.md` → page templates.
- Additional roots from `.pm-copilot/roots.json` (`{"roots":["docs","prd"]}`).
- `kb/SCHEMA.md` → returns its `## ` section headings as the operation contract.

Search filters: keyword (title/id/summary/tags/body head), project, type, status.
Results carry `path`, `updatedAt`, `relevance`, `status`, `snippet`.

## Knowledge base (write)

`knowledge.ingest` writes a **new page only**: `kb/wiki/<type>/<ID>-<slug>.md`
(ID prefix by type per SCHEMA §5), appends one line to `kb/wiki/index.md`, and appends
one entry to `kb/wiki/log.md`. A page whose status is `正式` is never overwritten: a
new page with the next free ID is created and the conflict is reported.
Directories are created on demand (the current kb has only SCHEMA + templates).

## Agent calls (the real "brain")

`ctx.sessionController.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}] }, signal)`
queues one user message into the named Session and wakes its Agent. This is the only
path the cockpit uses to reach the main Agent; the message text is composed by the Host
half from the task / skill / fix instruction plus a compact context block, and every
prompt is recorded as a real execution record before it is sent.

The Client never invents an execution: it renders `executions[]` produced from those
records and from the recorded `session/event` stream (`tool/call` name `skill`,
`turn/end`, `assistant/message`).

## Skills

`ctx.skills.list({ cwd })` returns the real merged catalog: `{name, description,
whenToUse?, invocation, source, provider, path?}`. `ctx.skills.get(name,{cwd})` returns
the body. Skill version does not exist in DSH, so the UI shows `source` + `provider`
instead of a fabricated version, and says so.

`skillUsage` in `state.json` is incremented only from real `tool/call` events whose
tool name is `skill`; nothing is incremented by merely viewing a page.

## Agent-facing tool

One tool, `pm_copilot`, registered on `ctx.tools` (global layer), so the 小黄 Agent
can persist real work products into the cockpit:

`action` ∈ `state | task_create | task_update | analysis_save | decision_propose |
knowledge_ingest | quality_report | prd_save | deliverable_add`.

The tool writes through the very same Host service methods as the UI (one operation,
two callers), and returns the resulting record as its value.

## Presentation

- Left module navigation inside the panel + a right work area.
- Ten pages: overview, tasks, analysis, skills, knowledge, business analysis,
  solution, PRD, quality, decisions.
- Light theme by default, deep-blue / white / light-gray palette, blue interaction
  color; every color comes from `--dsw-alias-*` theme tokens plus a small
  plugin-owned palette for charts.
- Every control performs a real operation; disabled states appear only with a
  stated reason (e.g. "需要先创建任务").
