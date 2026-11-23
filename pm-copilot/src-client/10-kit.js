/**
 * PM Copilot — Client half, part 10: the plugin's own UI kit.
 *
 * Enterprise SaaS look: cards, metric tiles, status tags, progress bars,
 * tables, drawers, forms, a process-flow renderer and a function tree.
 * Surfaces/borders/text use DSH theme tokens (light and dark both work); the
 * plugin owns its accent palette because it draws data visualisations.
 */

/** Plugin-owned accent palette, declared once as CSS custom properties. */
const PMK_STYLE = `
.pmc-root {
  --pmc-blue: #2468d6;
  --pmc-blue-strong: #1b53ad;
  --pmc-blue-soft: #e8f0fd;
  --pmc-blue-line: #c7d9f7;
  --pmc-navy: #0f2545;
  --pmc-slate: #55708f;
  --pmc-gray-50: #f6f8fb;
  --pmc-gray-100: #eef2f7;
  --pmc-gray-200: #dfe6ef;
  --pmc-green: #17795c;
  --pmc-green-soft: #e4f5ef;
  --pmc-amber: #a35c05;
  --pmc-amber-soft: #fdf0dd;
  --pmc-red: #b32f43;
  --pmc-red-soft: #fde9ec;
  --pmc-violet: #6743b8;
  --pmc-violet-soft: #eee9fb;
  --pmc-radius: 10px;
  --pmc-radius-sm: 6px;
  color: var(--dsw-alias-label-primary, #17233a);
  font-size: var(--dsh-content-font-size, 14px);
}
.pmc-root, .pmc-root * { box-sizing: border-box; }
.pmc-root { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; background: var(--dsw-alias-bg-base, #ffffff); }
.pmc-scroll { overflow: auto; min-height: 0; }
.pmc-topbar {
  display: flex; align-items: center; gap: 14px; padding: 14px 20px; flex-wrap: wrap;
  background: linear-gradient(90deg, var(--pmc-navy) 0%, #14375f 55%, #1b4a7a 100%);
  color: #f3f7ff; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(15,37,69,.12));
}
.pmc-topbar .pmc-welcome { font-size: 15px; font-weight: 650; letter-spacing: .2px; }
.pmc-topbar .pmc-sub { font-size: 12px; opacity: .82; }
.pmc-topbar .pmc-spacer { flex: 1; }
.pmc-topbar .pmc-chip { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.pmc-topbar .pmc-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pmc-topbar .pmc-btn[data-variant="primary"] { background: #f4f8ff; border-color: #f4f8ff; color: var(--pmc-navy); }
.pmc-topbar .pmc-btn[data-variant="primary"]:hover { background: #ffffff; border-color: #ffffff; color: var(--pmc-blue-strong); }
.pmc-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
  background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.22); font-size: 12px; white-space: nowrap;
}
.pmc-chip-ok { background: rgba(52,211,153,.18); border-color: rgba(52,211,153,.4); }
.pmc-chip-hold { background: rgba(251,146,60,.18); border-color: rgba(251,146,60,.45); }
.pmc-body { display: flex; flex: 1; min-height: 0; }
.pmc-nav {
  width: 196px; flex: 0 0 196px; border-right: 1px solid var(--dsw-alias-border-l1, rgba(15,37,69,.1));
  background: var(--dsw-alias-bg-layer-1, #f7f9fc); padding: 12px 10px; overflow: auto;
}
.pmc-nav-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #8a9bb0); padding: 8px 8px 6px; }
.pmc-nav button {
  display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; border: 0; background: transparent;
  padding: 8px 9px; border-radius: var(--pmc-radius-sm); color: var(--dsw-alias-label-secondary, #3a4a61);
  font-size: 13px; cursor: pointer; margin-bottom: 2px; font-family: inherit;
}
.pmc-nav button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(36,104,214,.08)); }
.pmc-nav button[data-active="true"] { background: var(--pmc-blue-soft); color: var(--pmc-blue-strong); font-weight: 600; }
.pmc-nav .pmc-nav-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .55; }
.pmc-nav-badge {
  margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--pmc-blue-soft); color: var(--pmc-blue-strong); font-size: 10.5px; font-weight: 700;
}
.pmc-nav button[data-active="true"] .pmc-nav-badge { background: var(--pmc-blue); color: #fff; }
.pmc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pmc-page { padding: 18px 22px 28px; }
.pmc-page-head { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.pmc-page-head h2 { margin: 0; font-size: 18px; font-weight: 650; color: var(--dsw-alias-label-primary, #17233a); }
.pmc-page-head p { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-tertiary, #8a9bb0); }
.pmc-card {
  background: var(--dsw-alias-bg-layer-1, #ffffff); border: 1px solid var(--dsw-alias-border-l1, #e6ebf2);
  border-radius: var(--pmc-radius); padding: 14px 16px; min-width: 0;
}
.pmc-card-title { display: flex; align-items: center; gap: 8px; justify-content: space-between; margin-bottom: 10px; }
.pmc-card-title strong { font-size: 13.5px; font-weight: 620; }
.pmc-card-title .pmc-hint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8a9bb0); }
.pmc-grid { display: grid; gap: 12px; }
.pmc-metrics { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.pmc-metric { position: relative; overflow: hidden; }
.pmc-metric .pmc-mv { font-size: 26px; font-weight: 700; letter-spacing: -.6px; line-height: 1.1; }
.pmc-metric .pmc-ml { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a9bb0); margin-top: 4px; }
.pmc-metric .pmc-mh { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a9bb0); margin-top: 2px; }
.pmc-metric::after { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--pmc-blue); opacity: .85; }
.pmc-metric[data-tone="warn"]::after { background: var(--pmc-amber); }
.pmc-metric[data-tone="danger"]::after { background: var(--pmc-red); }
.pmc-metric[data-tone="ok"]::after { background: var(--pmc-green); }
.pmc-btn {
  display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2, #d4dde8);
  background: var(--dsw-alias-bg-layer-2, #ffffff); color: var(--dsw-alias-label-secondary, #33445d);
  padding: 6px 12px; border-radius: var(--pmc-radius-sm); font-size: 12.5px; cursor: pointer; font-family: inherit;
  white-space: nowrap;
}
.pmc-btn:hover { border-color: var(--pmc-blue-line); color: var(--pmc-blue-strong); }
.pmc-btn:disabled { opacity: .5; cursor: not-allowed; }
.pmc-btn[data-variant="primary"] { background: var(--pmc-blue); border-color: var(--pmc-blue); color: #fff; font-weight: 600; }
.pmc-btn[data-variant="primary"]:hover { background: var(--pmc-blue-strong); border-color: var(--pmc-blue-strong); color: #fff; }
.pmc-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--pmc-slate); }
.pmc-btn[data-variant="danger"] { color: var(--pmc-red); border-color: #eec2c9; }
.pmc-btn[data-size="sm"] { padding: 3px 9px; font-size: 11.5px; }
.pmc-tag { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; border: 1px solid transparent; white-space: nowrap; }
.pmc-tag[data-tone="blue"] { background: var(--pmc-blue-soft); color: var(--pmc-blue-strong); border-color: var(--pmc-blue-line); }
.pmc-tag[data-tone="ok"] { background: var(--pmc-green-soft); color: var(--pmc-green); border-color: #bfe6d9; }
.pmc-tag[data-tone="warn"] { background: var(--pmc-amber-soft); color: var(--pmc-amber); border-color: #f2d7ae; }
.pmc-tag[data-tone="danger"] { background: var(--pmc-red-soft); color: var(--pmc-red); border-color: #f1c2c9; }
.pmc-tag[data-tone="violet"] { background: var(--pmc-violet-soft); color: var(--pmc-violet); border-color: #d8cbf4; }
.pmc-tag[data-tone="mute"] { background: var(--pmc-gray-100); color: var(--pmc-slate); border-color: var(--pmc-gray-200); }
.pmc-bar { height: 6px; border-radius: 999px; background: var(--pmc-gray-100); overflow: hidden; }
.pmc-bar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--pmc-blue), #4f8fe8); border-radius: 999px; }
.pmc-bar[data-tone="ok"] > i { background: linear-gradient(90deg, var(--pmc-green), #3cb992); }
.pmc-bar[data-tone="warn"] > i { background: linear-gradient(90deg, var(--pmc-amber), #e2a04a); }
.pmc-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
.pmc-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8a9bb0); font-size: 11.5px; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e8edf4); white-space: nowrap; }
.pmc-table td { padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #f0f3f8); vertical-align: middle; }
.pmc-table tr[data-clickable="true"]:hover td { background: var(--dsw-alias-interactive-bg-hover, rgba(36,104,214,.05)); cursor: pointer; }
.pmc-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pmc-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pmc-kv { display: grid; grid-template-columns: 96px 1fr; gap: 6px 10px; font-size: 12.5px; }
.pmc-kv dt { color: var(--dsw-alias-label-tertiary, #8a9bb0); }
.pmc-kv dd { margin: 0; color: var(--dsw-alias-label-primary, #22304a); }
.pmc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 26px 12px; color: var(--dsw-alias-label-tertiary, #94a4b8); font-size: 12.5px; text-align: center; }
.pmc-empty strong { color: var(--dsw-alias-label-secondary, #5b6b81); font-size: 13px; font-weight: 600; }
.pmc-input, .pmc-select, .pmc-textarea {
  width: 100%; border: 1px solid var(--dsw-alias-border-l2, #d5dee9); border-radius: var(--pmc-radius-sm);
  padding: 6px 9px; font-size: 12.5px; font-family: inherit; color: var(--dsw-alias-label-primary, #22304a);
  background: var(--dsw-alias-bg-layer-2, #fff); outline: none;
}
.pmc-input:focus, .pmc-select:focus, .pmc-textarea:focus { border-color: var(--pmc-blue); box-shadow: 0 0 0 3px rgba(36,104,214,.12); }
.pmc-input:disabled, .pmc-select:disabled, .pmc-textarea:disabled {
  background: var(--pmc-gray-50); color: var(--dsw-alias-label-tertiary, #8a9bb0); cursor: not-allowed;
}
.pmc-textarea { resize: vertical; min-height: 72px; line-height: 1.5; }
.pmc-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.pmc-field > span { color: var(--dsw-alias-label-tertiary, #8a9bb0); }
.pmc-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e8edf4); margin-bottom: 12px; flex-wrap: wrap; }
.pmc-tabs button { border: 0; background: transparent; padding: 7px 11px; font-size: 12.5px; color: var(--dsw-alias-label-tertiary, #8a9bb0); cursor: pointer; border-bottom: 2px solid transparent; font-family: inherit; }
.pmc-tabs button[data-active="true"] { color: var(--pmc-blue-strong); border-bottom-color: var(--pmc-blue); font-weight: 600; }
.pmc-drawer { position: absolute; inset: 0; display: flex; justify-content: flex-end; background: rgba(15,37,69,.28); z-index: 20; }
.pmc-drawer-panel { width: min(620px, 92%); background: var(--dsw-alias-bg-layer-1, #fff); border-left: 1px solid var(--dsw-alias-border-l1, #e6ebf2); display: flex; flex-direction: column; min-height: 0; box-shadow: -12px 0 32px rgba(15,37,69,.16); }
.pmc-drawer-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef2f7); }
.pmc-drawer-head strong { font-size: 14px; flex: 1; min-width: 0; }
.pmc-drawer-body { padding: 14px 16px; overflow: auto; flex: 1; min-height: 0; }
.pmc-flow { width: 100%; overflow: auto; background: var(--pmc-gray-50); border: 1px solid var(--dsw-alias-border-l1, #e9eef5); border-radius: var(--pmc-radius-sm); }
.pmc-tree { font-size: 12.5px; }
.pmc-tree ul { list-style: none; margin: 0; padding-left: 16px; border-left: 1px dashed var(--dsw-alias-border-l2, #d9e1ec); }
.pmc-tree > ul { padding-left: 0; border-left: 0; }
.pmc-tree li { position: relative; padding: 3px 0 3px 4px; }
.pmc-tree .pmc-tree-node { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: var(--pmc-radius-sm); border: 1px solid var(--dsw-alias-border-l1, #e5ebf3); background: var(--dsw-alias-bg-layer-2, #fff); cursor: pointer; }
.pmc-tree .pmc-tree-node[data-active="true"] { border-color: var(--pmc-blue); background: var(--pmc-blue-soft); color: var(--pmc-blue-strong); }
.pmc-list-item { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1, #eef2f7); font-size: 12.5px; align-items: flex-start; }
.pmc-list-item:last-child { border-bottom: 0; }
.pmc-list-item .pmc-li-main { flex: 1; min-width: 0; }
.pmc-list-item .pmc-li-title { font-weight: 600; color: var(--dsw-alias-label-primary, #22304a); }
.pmc-list-item .pmc-li-sub { color: var(--dsw-alias-label-tertiary, #8a9bb0); font-size: 11.5px; margin-top: 2px; }
.pmc-quick { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.pmc-quick button {
  text-align: left; border: 1px solid var(--dsw-alias-border-l1, #e6ebf2); background: var(--dsw-alias-bg-layer-2, #fff);
  border-radius: var(--pmc-radius-sm); padding: 9px 11px; cursor: pointer; font-family: inherit; color: var(--dsw-alias-label-secondary, #33445d);
  font-size: 12.5px; display: flex; flex-direction: column; gap: 2px;
}
.pmc-quick button:hover { border-color: var(--pmc-blue-line); background: var(--pmc-blue-soft); }
.pmc-quick button b { font-size: 12.5px; color: var(--dsw-alias-label-primary, #22304a); font-weight: 620; }
.pmc-quick button span { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a9bb0); }
.pmc-toast { position: absolute; right: 16px; bottom: 16px; z-index: 30; display: flex; flex-direction: column; gap: 8px; max-width: 420px; }
.pmc-toast > div { background: var(--pmc-navy); color: #f2f6ff; border-radius: var(--pmc-radius-sm); padding: 9px 12px; font-size: 12.5px; box-shadow: 0 8px 22px rgba(15,37,69,.28); }
.pmc-toast > div[data-tone="danger"] { background: #8f2436; }
.pmc-toast > div[data-tone="ok"] { background: #14624b; }
.pmc-toast > div[data-tone="busy"] { background: var(--pmc-blue-strong); }
.pmc-banner { display: flex; gap: 8px; align-items: center; border-radius: var(--pmc-radius-sm); padding: 8px 12px; font-size: 12px; border: 1px solid; }
.pmc-banner[data-tone="warn"] { background: var(--pmc-amber-soft); color: var(--pmc-amber); border-color: #f2d7ae; }
.pmc-banner[data-tone="info"] { background: var(--pmc-blue-soft); color: var(--pmc-blue-strong); border-color: var(--pmc-blue-line); }
.pmc-banner[data-tone="danger"] { background: var(--pmc-red-soft); color: var(--pmc-red); border-color: #f1c2c9; }
.pmc-split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 12px; align-items: start; }
.pmc-table-wrap { width: 100%; overflow-x: auto; }
.pmc-flow-wrap { background: var(--dsw-alias-bg-layer-2, #f7f9fc); border: 1px solid var(--dsw-alias-border-l1, #e5ebf3); border-radius: var(--pmc-radius-sm); padding: 8px; }
.pmc-preview {
  white-space: pre-wrap; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; line-height: 1.6;
  background: var(--dsw-alias-bg-layer-2, #f4f7fb); color: var(--dsw-alias-label-primary, #22304a);
  border: 1px solid var(--dsw-alias-border-l1, #e5ebf3); padding: 12px; border-radius: 6px;
  max-height: 520px; overflow: auto;
}
@media (max-width: 1180px) {
  .pmc-nav { width: 172px; flex-basis: 172px; }
  .pmc-page { padding: 14px 14px 22px; }
  .pmc-topbar { gap: 8px; padding: 10px 14px; }
  .pmc-topbar .pmc-chip { max-width: 168px; }
}
@media (max-width: 980px) {
  .pmc-split { grid-template-columns: minmax(0, 1fr); }
  .pmc-nav { width: 150px; flex-basis: 150px; }
  .pmc-nav button span { font-size: 12px; }
}
.pmc-mono { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.pmc-dim { color: var(--dsw-alias-label-tertiary, #8a9bb0); }
.pmc-strong { font-weight: 620; }
.pmc-link { color: var(--pmc-blue-strong); cursor: pointer; text-decoration: none; }
.pmc-link:hover { text-decoration: underline; }
`

/** Inline SVG icon set drawn with currentColor. */
const ICON_PATHS = {
  overview: 'M3 3h7v7H3zM14 3h7v4h-7zM14 9h7v12h-7zM3 12h7v9H3z',
  tasks: 'M4 4h13v3H4zM4 10h13v2H4zM4 15h9v2H4z',
  analysis: 'M4 17h3V9H4zM10 17h3V5h-3zM16 17h3v-6h-3z',
  skills: 'M10 3l2.2 4.6 5 .7-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.3l5-.7z',
  knowledge: 'M4 4h12v13H4zM4 7h12M7 11h6M7 14h4',
  business: 'M3 6h5v4H3zM12 3h5v4h-5zM12 14h5v4h-5zM8 8l4 6M8 8l4-3M8 8v8h4',
  solution: 'M10 3l7 4v6l-7 4-7-4V7zM3 7l7 4 7-4M10 11v6',
  prd: 'M5 3h7l4 4v11H5zM12 3v4h4M7 11h6M7 14h4',
  quality: 'M10 3l7 3v5c0 4-3 6-7 7-4-1-7-3-7-7V6zM7 10l2 2 4-4',
  decisions: 'M4 4h12v6H4zM4 13h12v4H4zM7 7h4M7 15h4',
  agents: 'M10 3a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM4 17c0-3 3-4.5 6-4.5S16 14 16 17',
  plus: 'M10 4v12M4 10h12',
  search: 'M9 4a5 5 0 100 10A5 5 0 000 4zM13 13l4 4',
  close: 'M5 5l10 10M15 5L5 15',
  play: 'M6 4l9 6-9 6z',
  pause: 'M7 4v12M13 4v12',
  refresh: 'M16 10a6 6 0 10-2 4.6M16 4v5h-5',
  check: 'M4 10l4 4 8-8',
  external: 'M8 4h8v8M16 4L7 13M3 7v10h10',
  chevron: 'M7 5l6 5-6 5',
  edit: 'M12 4l4 4-8 8H4v-4z',
  send: 'M3 10l14-6-4 14-3-6z',
  rules: 'M4 5h12M4 10h12M4 15h7M15 13l2 2-2 2',
  archive: 'M3 5h14v3H3zM4 8v8h12V8M8 11h4',
}

/** One stroked icon; `size` in pixels. */
function Icon({ name, size = 16 }) {
  const path = ICON_PATHS[name] || ICON_PATHS.overview
  return h('svg', {
    viewBox: '0 0 20 20', width: size, height: size, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': true, style: { flex: '0 0 auto' },
  }, h('path', { d: path }))
}

/** Style carrier: renders the kit CSS once per mounted cockpit. */
function KitStyle() {
  return h('style', { 'data-pm-copilot-style': '1' }, PMK_STYLE)
}

/** A bordered panel with an optional title, hint and action row. */
function Card({ title, hint, actions, children, bodyClass, style }) {
  return h('section', { className: cx('pmc-card', bodyClass), style },
    (title !== undefined || actions !== undefined) ? h('div', { className: 'pmc-card-title' },
      h('div', { className: 'pmc-row', style: { gap: 6 } }, title ? h('strong', null, title) : null, hint ? h('span', { className: 'pmc-hint' }, hint) : null),
      actions ? h('div', { className: 'pmc-row' }, actions) : null) : null,
    children)
}

/** A dashboard metric tile. `tone` selects the left rail colour. */
function Metric({ label, value, hint, tone }) {
  return h('div', { className: 'pmc-card pmc-metric', 'data-tone': tone || 'blue' },
    h('div', { className: 'pmc-mv' }, value),
    h('div', { className: 'pmc-ml' }, label),
    hint ? h('div', { className: 'pmc-mh' }, hint) : null)
}

/** A status pill; `tone` maps to the documented palette. */
function Tag({ text, tone }) { return h('span', { className: 'pmc-tag', 'data-tone': tone || 'mute' }, text) }

/** A determinate progress bar. */
function Bar({ value, tone }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0))
  return h('div', { className: 'pmc-bar', 'data-tone': tone || 'blue', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('i', { style: { width: pct + '%' } }))
}

/** A button; `variant` primary|ghost|danger, `size` sm. `disabledReason` is shown as the tooltip. */
function Button({ label, icon, onClick, variant, size, disabled, title, disabledReason }) {
  const tooltip = title || (disabled ? disabledReason : undefined)
  return h('button', {
    type: 'button', className: 'pmc-btn', 'data-variant': variant, 'data-size': size,
    onClick: disabled ? undefined : onClick, disabled: Boolean(disabled), title: tooltip,
  }, icon ? h(Icon, { name: icon, size: 13 }) : null, label ? h('span', null, label) : null)
}

/** An empty state that says the truth: the real collection is empty. */
function Empty({ title, hint }) {
  return h('div', { className: 'pmc-empty' },
    h('strong', null, title || '暂无数据'),
    h('span', null, hint || '这里的内容来自真实任务与知识库记录；当前为空。'))
}

/** A labelled form field wrapper. */
function Field({ label, children }) {
  return h('label', { className: 'pmc-field' }, h('span', null, label), children)
}

/** Text input with change bubbling. `disabled` keeps a value visible but frozen. */
function Input({ value, onChange, placeholder, type, disabled }) {
  return h('input', { className: 'pmc-input', type: type || 'text', value: value ?? '', placeholder, disabled: disabled === true,
    onChange: (e) => onChange(e.target.value) })
}

/** Multiline text input. */
function Textarea({ value, onChange, placeholder, rows, disabled }) {
  return h('textarea', { className: 'pmc-textarea', rows: rows || 4, value: value ?? '', placeholder, disabled: disabled === true,
    onChange: (e) => onChange(e.target.value) })
}

/** A select over `[{value,label}]`. */
function Select({ value, onChange, options, placeholder }) {
  return h('select', { className: 'pmc-select', value: value ?? '', onChange: (e) => onChange(e.target.value) },
    placeholder ? h('option', { value: '' }, placeholder) : null,
    options.map((o) => h('option', { key: o.value, value: o.value }, o.label)))
}

/** Tab strip; `items` is `[{key,label}]`. */
function Tabs({ items, active, onChange }) {
  return h('div', { className: 'pmc-tabs' }, items.map((it) =>
    h('button', { key: it.key, type: 'button', 'data-active': it.key === active, onClick: () => onChange(it.key) }, it.label)))
}

/** Key/value definition list. */
function KV({ items }) {
  return h('dl', { className: 'pmc-kv' }, items.map((it) => [
    h('dt', { key: it.k + '-k' }, it.k),
    h('dd', { key: it.k + '-v' }, it.v === undefined || it.v === null || it.v === '' ? '—' : it.v),
  ]))
}

/** A table; `columns` is `[{key,label,render?}]`, `rows` carries `rowKey`. */
function Table({ columns, rows, onRowClick }) {
  if (rows.length === 0) return h(Empty, { title: '没有记录', hint: '当前条件下没有任何真实记录。' })
  const header = h('thead', null, h('tr', null,
    columns.map((column) => h('th', { key: column.key }, column.label))))
  const bodyRows = rows.map((row) => {
    const cells = columns.map((column) => h('td', { key: column.key },
      column.render ? column.render(row) : (row[column.key] ?? '—')))
    const props = {
      key: row.rowKey,
      'data-clickable': onRowClick ? 'true' : 'false',
    }
    if (onRowClick) props.onClick = () => onRowClick(row)
    return h('tr', props, cells)
  })
  return h('div', { className: 'pmc-table-wrap' }, h('table', { className: 'pmc-table' }, header, h('tbody', null, bodyRows)))
}

/** A dismissible-looking notice banner. */
function Banner({ tone, text }) { return h('div', { className: 'pmc-banner', 'data-tone': tone || 'info' }, h('span', null, text)) }

/** Right-side drawer. */
function Drawer({ title, onClose, children, footer }) {
  return h('div', { className: 'pmc-drawer', onClick: onClose },
    h('div', { className: 'pmc-drawer-panel', onClick: (e) => e.stopPropagation() },
      h('div', { className: 'pmc-drawer-head' },
        h('strong', null, title),
        h(Button, { label: '', icon: 'close', variant: 'ghost', onClick: onClose, title: '关闭' })),
      h('div', { className: 'pmc-drawer-body' }, children),
      footer ? h('div', { className: 'pmc-drawer-head', style: { borderTop: '1px solid var(--dsw-alias-border-l1, #eef2f7)', borderBottom: 0, justifyContent: 'flex-end' } }, footer) : null))
}

/**
 * Render a directed flow as SVG.
 *
 * `nodes` is `[{id,label,kind,actor}]`; `edges` is `[{from,to,label}]`. Ids are
 * optional in Agent-written data, so a node without one gets a synthetic handle
 * instead of crashing the page, and an edge whose endpoints are unknown is
 * dropped rather than drawn to nowhere.
 *
 * Layout is a left-to-right layered placement computed from the longest inbound
 * path (a cycle cannot inflate the layer count), so a three-step process really
 * occupies three columns. A "back" edge — one that points at an earlier or equal
 * layer, i.e. a loop or a same-step hand-off — is drawn as a dashed return arc
 * below the nodes with its own label, never backwards through the boxes.
 */
function Flow({ nodes, edges, height }) {
  const rawNodes = PM.list(nodes)
  if (rawNodes.length === 0) return h(Empty, { title: '暂无流程', hint: '流程来自主 Agent 写入的业务分析结果。' })

  const ns = rawNodes.map((node, index) => ({ ...node, handle: node.id === undefined || node.id === null || node.id === '' ? 'n' + index : String(node.id) }))
  const handles = new Set(ns.map((node) => node.handle))
  const es = PM.list(edges)
    .filter((edge) => edge !== null && typeof edge === 'object' && handles.has(String(edge.from)) && handles.has(String(edge.to)))
    .map((edge) => ({ ...edge, fromKey: String(edge.from), toKey: String(edge.to) }))

  // Longest-path layering; the pass count is bounded by the node count so a
  // cycle settles instead of looping.
  const layer = new Map(ns.map((node) => [node.handle, 0]))
  for (let pass = 0; pass < ns.length; pass += 1) {
    let moved = false
    for (const edge of es) {
      const candidate = layer.get(edge.fromKey) + 1
      if (candidate > layer.get(edge.toKey) && candidate < ns.length) {
        layer.set(edge.toKey, candidate)
        moved = true
      }
    }
    if (!moved) break
  }
  const layerOf = (handle) => layer.get(handle) || 0
  const forward = es.filter((edge) => layerOf(edge.toKey) > layerOf(edge.fromKey))
  const back = es.filter((edge) => layerOf(edge.toKey) <= layerOf(edge.fromKey))

  const columns = []
  for (const node of ns) {
    const index = layerOf(node.handle)
    if (columns[index] === undefined) columns[index] = []
    columns[index].push(node)
  }
  const columnCount = Math.max(columns.length, 1)
  const colW = 196
  const rowH = 64
  const nodeW = 132
  const nodeH = 40
  const left = 20
  const top = 16
  const maxRows = Math.max(...columns.map((column) => (column === undefined ? 0 : column.length)), 1)
  const canvasW = left + columnCount * colW + 40
  const canvasH = Math.max(height || 0, top + maxRows * rowH + (back.length > 0 ? 58 : 10))

  const positions = new Map()
  columns.forEach((column, ci) => {
    if (column === undefined) return
    column.forEach((node, ri) => {
      positions.set(node.handle, { x: left + ci * colW, y: top + ri * rowH })
    })
  })

  /** Palette per semantic node kind, using theme state tokens. */
  const tone = (kind) => {
    if (kind === 'exception') return 'var(--dsw-alias-state-error-primary, #b32f43)'
    if (kind === 'decision') return 'var(--dsw-alias-state-warn-primary, #a35c05)'
    if (kind === 'start') return 'var(--dsw-alias-state-success-primary, #17795c)'
    if (kind === 'end') return 'var(--dsw-alias-label-tertiary, #55708f)'
    return 'var(--dsw-alias-state-business-primary, #2468d6)'
  }

  const label = (edge, x, y) => (edge.label === undefined || edge.label === ''
    ? null
    : h('text', { x, y, fontSize: 9, fill: 'var(--dsw-alias-label-tertiary, #7d8ea3)', textAnchor: 'middle' }, clip(String(edge.label), 14)))

  const forwardPaths = forward.map((edge, index) => {
    const from = positions.get(edge.fromKey)
    const to = positions.get(edge.toKey)
    if (from === undefined || to === undefined) return null
    const x1 = from.x + nodeW
    const y1 = from.y + nodeH / 2
    const x2 = to.x
    const y2 = to.y + nodeH / 2
    const midX = (x1 + x2) / 2
    return h('g', { key: 'f' + index },
      h('path', {
        d: 'M' + x1 + ' ' + y1 + 'C' + midX + ' ' + y1 + ' ' + midX + ' ' + y2 + ' ' + x2 + ' ' + y2,
        fill: 'none', stroke: 'var(--dsw-alias-label-tertiary, #8ba0b8)', strokeWidth: 1.2,
        markerEnd: 'url(#pmc-arrow)',
      }),
      label(edge, midX, Math.min(y1, y2) - 4))
  })

  // Return arcs: dashed, routed below the node band so they never cross boxes.
  const returnY = top + maxRows * rowH + 12
  const returnPaths = back.map((edge, index) => {
    const from = positions.get(edge.fromKey)
    const to = positions.get(edge.toKey)
    if (from === undefined || to === undefined) return null
    const x1 = from.x + nodeW / 2
    const x2 = to.x + nodeW / 2
    const y1 = from.y + nodeH
    const y2 = to.y + nodeH
    const dip = returnY + index * 12
    return h('g', { key: 'b' + index },
      h('path', {
        d: 'M' + x1 + ' ' + y1 + 'L' + x1 + ' ' + (dip - 6) + 'L' + x2 + ' ' + (dip - 6) + 'L' + x2 + ' ' + (y2 + 2),
        fill: 'none', stroke: 'var(--dsw-alias-label-tertiary, #8ba0b8)', strokeWidth: 1.1,
        strokeDasharray: '4 3', markerEnd: 'url(#pmc-arrow)',
      }),
      label(edge, (x1 + x2) / 2, dip - 10))
  })

  const boxes = ns.map((node) => {
    const position = positions.get(node.handle)
    if (position === undefined) return null
    const actor = node.actor ? ' · ' + node.actor : ''
    return h('g', { key: node.handle, transform: 'translate(' + position.x + ',' + position.y + ')' },
      h('rect', { width: nodeW, height: nodeH, rx: 7, fill: 'var(--dsw-alias-bg-layer-2, #ffffff)', stroke: tone(node.kind), strokeWidth: 1.4 }),
      h('rect', { width: 3, height: nodeH, rx: 1.5, fill: tone(node.kind) }),
      h('text', { x: 11, y: 17, fontSize: 11, fill: 'var(--dsw-alias-label-primary, #22304a)', fontWeight: 600 }, clip(String(node.label === undefined ? '' : node.label), 15)),
      h('text', { x: 11, y: 31, fontSize: 9, fill: 'var(--dsw-alias-label-tertiary, #7d8ea3)' }, clip(String(node.kind || 'step') + actor, 20)))
  })

  return h('div', { className: 'pmc-flow-wrap' },
    h('svg', { width: canvasW, height: canvasH, viewBox: '0 0 ' + canvasW + ' ' + canvasH, role: 'img', 'aria-label': '业务流程图' },
      h('defs', null,
        h('marker', { id: 'pmc-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
          h('path', { d: 'M0 0l10 5-10 5z', fill: 'var(--dsw-alias-label-tertiary, #8ba0b8)' }))),
      forwardPaths, returnPaths, boxes))
}

/** Function-architecture tree; `nodes` is `[{nodeId,name,children}]`. */
function TreeView({ nodes, activeId, onSelect }) {
  const renderNodes = (items) => h('ul', null, items.map((n) => h('li', { key: n.nodeId || n.name },
    h('span', { className: 'pmc-tree-node', 'data-active': activeId === (n.nodeId || n.name), onClick: () => onSelect && onSelect(n) }, h(Icon, { name: 'solution', size: 12 }), h('span', null, n.name)),
    PM.list(n.children).length > 0 ? renderNodes(n.children) : null)))
  if (PM.list(nodes).length === 0) return h(Empty, { title: '暂无功能架构', hint: '产品方案写入后会在这里生成可展开的功能树。' })
  return h('div', { className: 'pmc-tree' }, renderNodes(PM.list(nodes)))
}

PM.kit = { Icon, KitStyle, Card, Metric, Tag, Bar, Button, Empty, Field, Input, Textarea, Select, Tabs, KV, Table, Banner, Drawer, Flow, TreeView }
