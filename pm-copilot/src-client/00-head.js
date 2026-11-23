/**
 * PM Copilot — Client half, part 00: loader head, shared helpers, namespace.
 *
 * This source file is NOT loaded directly: `scripts/build-client.mjs` concatenates
 * `src-client/*.js` in filename order into the single `client.js` artifact that
 * DSH serves to the page. Every part contributes to the shared `PM` namespace
 * inside one lazy factory, so parts never re-declare top-level identifiers.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-pm-copilot',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const PM = {}
    /** Locale namespace owned by this plugin. */
    const NS = 'pm-copilot'

    /** Compose class names, dropping falsy entries. */
    const cx = (...parts) => parts.filter(Boolean).join(' ')
    /** Zero-pad a number to two digits. */
    const pad2 = (n) => String(n).padStart(2, '0')
    /** Format an epoch millisecond value as `YYYY-MM-DD HH:mm` in local time. */
    const fmtTime = (ms) => {
      if (!ms) return '—'
      const d = new Date(ms)
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }
    /** Format an epoch millisecond value as `YYYY-MM-DD`. */
    const fmtDate = (ms) => (ms ? fmtTime(ms).slice(0, 10) : '—')
    /** Shorten a string to `n` characters with an ellipsis. */
    const clip = (text, n) => {
      const s = String(text === undefined || text === null ? '' : text)
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }
    /** Basename of a path, for compact labels. */
    const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
    /** Today's local date, `YYYY-MM-DD`. */
    const today = () => fmtDate(Date.now())
    /** Empty value coercion for renderers. */
    const list = (v) => (Array.isArray(v) ? v : [])

    PM.env = { NS, React, h, cx, fmtTime, fmtDate, clip, baseName, today, list }

    /**
     * Pages and hooks call this as `PM.list`; the helper above lives in `PM.env`
     * too, so both spellings resolve to the same function. Missing this alias made
     * every first render throw `PM.list is not a function`, and the runtime then
     * retired the panel entry — the center column went blank instead of showing an
     * error.
     */
    PM.list = list
