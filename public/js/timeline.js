// Timeline: every message of every session, with filters.
import { $, el, state, bus, api, store, colorFor, hhmmss, prettyJson } from './core.js'
import { openDraft } from './workbench.js'
import { saveDialog } from './collections.js'

const MAX = 1500
let hidden = new Set(store.get('hiddenSessions', []))

// JSON -> highlighted DOM, built from tokens (never via innerHTML).
export function highlightJson(text) {
  const frag = document.createDocumentFragment()
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(text.slice(last, m.index))
    const cls = m[1] ? (m[2] ? 'j-key' : 'j-str') : m[3] ? 'j-lit' : 'j-num'
    frag.append(el('span', { class: cls }, m[1] ? m[1] : m[0]))
    if (m[2]) frag.append(m[2])
    last = m.index + m[0].length
  }
  frag.append(text.slice(last))
  return frag
}

// ---- schema verdicts -------------------------------------------------------------------
export function issuesNode(issues, title) {
  return el('div', { class: 'issue-box' },
    title ? el('div', { class: 'issue-title' }, title) : null,
    ...issues.map((i) => el('div', { class: 'issue' }, el('code', {}, i.path), ' ', i.message)))
}
export const schemaBadge = (schema) => (!schema ? null
  : schema.ok ? el('span', { class: 'badge schema-ok', title: 'matches the protocol schema' }, '✓ schema')
  : el('span', { class: 'badge schema-bad', title: schema.issues.map((i) => `${i.path} ${i.message}`).join('\n') }, `⚠ schema (${schema.issues.length})`))

const visible = (m) => {
  if ($('#fBad')?.checked && m.schema?.ok !== false) return false
  if (hidden.has(m.session)) return false
  if (m.dir === 'sys' && !$('#fSys').checked) return false
  const q = $('#fText').value.trim().toLowerCase()
  return !q || JSON.stringify(m.msg).toLowerCase().includes(q)
}

export function entryNode(m) {
  const msg = m.msg
  const who = el('span', { class: 'who', style: `color:${colorFor(m.session)}` }, m.session)
  if (m.dir === 'sys') {
    return el('div', { class: `entry sys${msg.error ? ' error' : ''}` }, el('span', { class: 'time' }, hhmmss(m.ts)), ' ', who, ' ', msg.text)
  }
  const cmd = msg.commandId ?? state.requestsById.get(msg.messageId) ?? '(raw)'
  const status = msg.type === 'response' ? msg.status : null
  const reason = msg.reason ? `${msg.reason}${msg.details ? ' · ' + msg.details : ''}` : ''
  const body = el('pre', { class: 'json' }, m.raw ? msg.raw : highlightJson(prettyJson(msg)))
  const isReq = m.dir === 'out' && msg.type === 'request'
  return el('details', { class: `entry ${m.dir}` },
    el('summary', {},
      el('span', { class: 'time' }, hhmmss(m.ts)), who,
      el('span', { class: 'arrow' }, m.dir === 'in' ? '◀' : '▶'),
      el('span', { class: 'cmd' }, cmd),
      el('span', { class: 'badge' }, msg.type ?? (m.raw ? 'raw' : '?')),
      status ? el('span', { class: `badge ${status}` }, status) : null,
      reason ? el('span', { class: 'badge failed' }, reason) : null,
      schemaBadge(m.schema),
      msg.data !== undefined ? el('span', { class: 'brief' }, JSON.stringify(msg.data)) : null,
      m.raw ? el('span', { class: 'brief' }, msg.raw) : null),
    m.schema?.ok === false ? issuesNode(m.schema.issues, 'Does not match the protocol schema') : null,
    body,
    el('div', { class: 'actions' },
      el('button', { onclick: () => navigator.clipboard?.writeText(prettyJson(msg)) }, 'Copy'),
      isReq ? el('button', { onclick: () => api.call({ op: 'send', name: m.session, commandId: msg.commandId, data: msg.data }) }, 'Resend') : null,
      isReq ? el('button', { onclick: () => openDraft({ as: m.session, commandId: msg.commandId, data: msg.data }) }, 'Open in tab') : null,
      isReq ? el('button', { onclick: () => saveDialog({ commandId: msg.commandId, data: msg.data, as: m.session }) }, '★ Save') : null))
}

export function renderTimeline() {
  const log = $('#log')
  const entries = state.entries.filter(visible)
  const columns = $('#fCols').checked
  log.replaceChildren()
  log.classList.toggle('cols', columns)
  if (columns) {
    const names = [...state.sessions.keys()].filter((n) => !hidden.has(n))
    log.style.gridTemplateColumns = `repeat(${Math.max(names.length, 1)}, minmax(0, 1fr))`
    for (const n of names) log.append(el('div', { class: 'col' }, el('h4', { style: `color:${colorFor(n)}` }, n), entries.filter((e) => e.session === n).map(entryNode)))
  } else {
    log.style.gridTemplateColumns = ''
    log.append(...entries.map(entryNode))
  }
  $('#tlCount').textContent = String(state.entries.length)
}

let unseen = 0
const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 60

function jumpToLatest() {
  const log = $('#log')
  log.scrollTop = log.scrollHeight
  unseen = 0
  $('#jump').classList.add('hidden')
}

// New entries only follow the bottom when the user is already there; if they scrolled up to read,
// the view stays put and a "new messages" button shows up instead.
function append(m) {
  const log = $('#log')
  const stick = nearBottom(log) || log.clientHeight === 0
  const before = log.scrollTop
  if ($('#fCols').checked) renderTimeline()
  else if (visible(m)) {
    log.append(entryNode(m))
    while (log.childElementCount > MAX) log.firstChild.remove()
  }
  $('#tlCount').textContent = String(state.entries.length)
  if (stick) return jumpToLatest()
  log.scrollTop = before
  if (visible(m)) { unseen++; $('#jump').textContent = `↓ ${unseen} new message${unseen > 1 ? 's' : ''}`; $('#jump').classList.remove('hidden') }
}

function renderSessionFilters() {
  $('#fSessions').replaceChildren(...[...state.sessions.keys()].map((n) =>
    el('label', { class: 'inline' },
      el('input', { type: 'checkbox', checked: !hidden.has(n), onchange: (e) => {
        e.target.checked ? hidden.delete(n) : hidden.add(n)
        store.set('hiddenSessions', [...hidden])
        renderTimeline()
      } }),
      el('span', { style: `color:${colorFor(n)}` }, n))))
}

export function initTimeline() {
  bus.on('msgAdded', append)
  for (const e of ['session', 'sessionRemoved', 'init']) bus.on(e, renderSessionFilters)
  bus.on('init', renderTimeline)
  $('#fText').oninput = renderTimeline
  $('#fSys').onchange = renderTimeline
  $('#fBad').onchange = renderTimeline
  $('#fCols').onchange = renderTimeline
  $('#fClear').onclick = () => { state.entries = []; renderTimeline(); jumpToLatest() }
  $('#jump').onclick = jumpToLatest
  $('#log').addEventListener('scroll', () => { if (nearBottom($('#log'))) { unseen = 0; $('#jump').classList.add('hidden') } })
}
