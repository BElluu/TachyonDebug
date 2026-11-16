// Workbench: request tabs, the request builder and the response pane.
import { $, el, state, bus, api, store, uid, groupOf, colorFor, prettyJson, debounce } from './core.js'
import { toast } from './modal.js'
import { findRequest, saveDialog } from './collections.js'
import { highlightJson } from './timeline.js'

let tabs = store.get('tabs', []).map((t) => ({ ...t, msgId: null, response: null }))
let activeId = store.get('activeTab', null)
let bottom = 'response'

const active = () => tabs.find((t) => t.id === activeId)
const persist = () => {
  store.set('tabs', tabs.map(({ id, reqId, collId, name, as, commandId, body, dirty }) => ({ id, reqId, collId, name, as, commandId, body, dirty })))
  store.set('activeTab', activeId)
}
const catalogEntry = (id) => state.catalog.find((c) => c.id === id)
const templateFor = (id) => {
  const t = catalogEntry(id)?.kinds.request.template
  return t === undefined ? '' : prettyJson(t)
}

// ---- public api -----------------------------------------------------------------
function newTab(props) {
  const t = { id: uid(), reqId: null, collId: null, name: '', as: null, commandId: '', body: '', dirty: false, msgId: null, response: null, ...props }
  tabs.push(t)
  activate(t.id)
  return t
}

export function openRequest(reqId) {
  const existing = tabs.find((t) => t.reqId === reqId)
  if (existing) return activate(existing.id)
  const f = findRequest(reqId)
  if (!f) return null
  const { req, coll } = f
  return newTab({ reqId, collId: coll.id, name: req.name, as: req.as, commandId: req.commandId, body: req.data === undefined ? '' : prettyJson(req.data) })
}

export function openDraft({ as = null, commandId = '', data, collId = null, name = '' }) {
  const body = data !== undefined ? prettyJson(data) : commandId ? templateFor(commandId) : ''
  return newTab({ as, commandId, body, collId, name })
}

export function runSaved(req) {
  openRequest(req.id)
  send()
}

// ---- tabs ---------------------------------------------------------------------------
function activate(id) {
  activeId = id
  persist()
  renderTabs()
  loadBuilder()
  renderResponse()
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id)
  tabs.splice(i, 1)
  if (activeId === id) activeId = (tabs[i] ?? tabs[i - 1])?.id ?? null
  persist()
  renderTabs()
  loadBuilder()
  renderResponse()
}

function renderTabs() {
  const bar = $('#tabs')
  bar.replaceChildren(
    ...tabs.map((t) => el('div', { class: `tab ${t.id === activeId ? 'active' : ''}`, onclick: () => activate(t.id), title: t.commandId },
      t.commandId ? el('span', { class: 'cmd-badge', style: `--c:${colorFor(groupOf(t.commandId))}` }, groupOf(t.commandId)) : null,
      el('span', { class: 'tab-name' }, t.name || t.commandId || 'New request'),
      t.dirty ? el('span', { class: 'dirty', title: 'unsaved changes' }, '●') : null,
      el('button', { class: 'icon', title: 'close', onclick: (e) => { e.stopPropagation(); closeTab(t.id) } }, '✕'))),
    el('button', { class: 'tab-add', title: 'new request', onclick: () => openDraft({}) }, '+'))
}

// ---- builder --------------------------------------------------------------------------
function renderSessionSelect() {
  const sel = $('#bSession')
  const t = active()
  const prev = t?.as || sel.value || store.get('lastSession', '')
  sel.replaceChildren(...[...state.sessions.values()].map((s) => el('option', { value: s.name }, `${s.name}${s.state === 'open' ? '' : ' (offline)'}`)))
  if (!state.sessions.size) sel.append(el('option', { value: '' }, 'no players'))
  if (prev && state.sessions.has(prev)) sel.value = prev
}

function loadBuilder() {
  const t = active()
  $('#builder').classList.toggle('hidden', !t)
  $('#emptyState').classList.toggle('hidden', !!t)
  if (!t) return
  renderSessionSelect()
  $('#bCmd').value = t.commandId
  $('#bBody').value = t.body
  updateInfo()
  validateBody()
}

function updateInfo() {
  const t = active()
  const info = $('#bInfo')
  info.replaceChildren()
  if (!t?.commandId) return
  const c = catalogEntry(t.commandId)
  if (!c) return void info.append(el('span', { class: 'warn' }, 'Not in the protocol schema — it will still be sent as typed.'))
  const r = c.kinds.request
  info.append(el('span', { class: 'muted' }, `scopes: ${r.scopes.join(', ') || '—'}`))
  if (c.kinds.response?.reasons) {
    info.append(el('span', { class: 'muted' }, ' · can fail with: '), ...c.kinds.response.reasons.map((x) => el('span', { class: 'reason' }, x)))
  }
}

function validateBody() {
  const v = $('#bValid')
  const text = $('#bBody').value.trim()
  if (!text) { v.textContent = 'no body'; v.className = 'valid muted'; return true }
  try { JSON.parse(text); v.textContent = '✓ valid JSON'; v.className = 'valid ok'; return true } catch (e) {
    v.textContent = `✗ ${e.message}`; v.className = 'valid bad'; return false
  }
}

function touch() {
  const t = active()
  if (!t) return
  t.dirty = true
  persist()
  renderTabs()
}

function setCommand(id, { fromList = false } = {}) {
  const t = active()
  if (!t) return
  const prevTemplate = templateFor(t.commandId)
  t.commandId = id
  $('#bCmd').value = id
  if (fromList && (!t.body.trim() || t.body.trim() === prevTemplate.trim())) {
    t.body = templateFor(id)
    $('#bBody').value = t.body
  }
  touch(); updateInfo(); validateBody()
}

// command picker (a combobox that also accepts free text)
function initCombo() {
  const input = $('#bCmd')
  const list = $('#bList')
  let sel = -1
  let shown = []
  const draw = () => {
    const q = input.value.trim().toLowerCase()
    shown = state.catalog.filter((c) => c.id.includes(q)).slice(0, 80)
    list.replaceChildren()
    let last = null
    shown.forEach((c, i) => {
      if (c.group !== last) { list.append(el('div', { class: 'grp' }, c.group)); last = c.group }
      list.append(el('div', { class: `item ${i === sel ? 'sel' : ''}`, onmousedown: (e) => { e.preventDefault(); pick(c.id) } },
        el('span', {}, c.name), c.kinds.request.source === 'autohost' ? el('span', { class: 'tag' }, 'autohost') : null))
    })
    list.classList.toggle('hidden', !shown.length)
  }
  const pick = (id) => { list.classList.add('hidden'); setCommand(id, { fromList: true }); $('#bBody').focus() }
  input.addEventListener('focus', () => { sel = -1; draw() })
  input.addEventListener('blur', () => list.classList.add('hidden'))
  input.addEventListener('input', () => { sel = -1; draw(); const t = active(); if (t) { t.commandId = input.value.trim(); touch(); updateInfo() } })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault() }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault() }
    else if (e.key === 'Enter') { const c = shown[sel >= 0 ? sel : 0]; if (c && !e.ctrlKey) { pick(c.id); e.preventDefault() } }
    else if (e.key === 'Escape') list.classList.add('hidden')
  })
}

// ---- sending ------------------------------------------------------------------------------
function send() {
  const t = active()
  if (!t) return
  const name = $('#bSession').value
  if (!name) return toast('Add a player first (+ Add player, top of the workbench)', 'error')
  if (!t.commandId) return toast('Pick a command first', 'error')
  if (state.sessions.get(name)?.state !== 'open') return toast(`${name} is offline. Connect it first (click its chip at the top).`, 'error')
  if (!validateBody()) return toast('The body is not valid JSON', 'error')
  const text = $('#bBody').value.trim()
  const data = text ? JSON.parse(text) : undefined
  t.as = t.as && state.sessions.has(t.as) ? t.as : null
  store.set('lastSession', name)
  t.msgId = uid()
  t.sentAt = performance.now()
  t.response = null
  api.call({ op: 'send', name, commandId: t.commandId, data, messageId: t.msgId })

  const hist = [{ as: name, commandId: t.commandId, data, ts: Date.now() }, ...store.get('history', []).filter((h) => JSON.stringify([h.as, h.commandId, h.data]) !== JSON.stringify([name, t.commandId, data]))].slice(0, 40)
  store.set('history', hist)
  bus.emit('history')
  setBottom('response')
  renderResponse()
}

function onIncoming(m) {
  if (m.dir !== 'in' || m.msg?.type !== 'response') return
  const t = tabs.find((x) => x.msgId === m.msg.messageId)
  if (!t) return
  t.response = { msg: m.msg, ms: Math.round(performance.now() - t.sentAt) }
  if (t.id === activeId) renderResponse()
}

function renderResponse() {
  const box = $('#response')
  box.replaceChildren()
  const t = active()
  if (!t || (!t.msgId && !t.response)) return void box.append(el('div', { class: 'empty' }, 'Send a request to see its response here.'))
  if (!t.response) {
    // errors such as "session not connected" arrive as toasts; otherwise we are simply waiting
    return void box.append(el('div', { class: 'empty' }, el('span', { class: 'spinner' }), ' waiting for the response…'))
  }
  const { msg, ms } = t.response
  box.append(
    el('div', { class: 'resp-head' },
      el('span', { class: `badge big ${msg.status}` }, msg.status ?? '—'),
      msg.reason ? el('span', { class: 'badge failed big' }, msg.reason) : null,
      msg.details ? el('span', { class: 'muted' }, msg.details) : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted' }, `${ms} ms`),
      el('button', { onclick: () => navigator.clipboard?.writeText(prettyJson(msg)) }, 'Copy')),
    el('pre', { class: 'json' }, highlightJson(prettyJson(msg))))
}

function setBottom(which) {
  bottom = which
  store.set('bottomPane', which)
  for (const b of document.querySelectorAll('#bottomTabs button')) b.classList.toggle('active', b.dataset.pane === which)
  $('#response').classList.toggle('hidden', which !== 'response')
  $('#timeline').classList.toggle('hidden', which !== 'timeline')
  if (which === 'timeline') { const log = $('#log'); log.scrollTop = log.scrollHeight }
}

// ---- init -----------------------------------------------------------------------------------
async function saveTab() {
  const t = active()
  if (!t) return
  if (!validateBody()) return toast('The body is not valid JSON', 'error')
  const text = $('#bBody').value.trim()
  const data = text ? JSON.parse(text) : undefined
  const asVal = t.reqId ? findRequest(t.reqId)?.req.as ?? null : null
  const req = await saveDialog({ name: t.name, commandId: t.commandId, data, as: asVal ?? $('#bSession').value, existingId: t.reqId, collId: t.collId })
  if (!req) return
  t.reqId = req.id
  t.name = req.name
  t.dirty = false
  persist(); renderTabs()
  toast(`Saved “${req.name}”`, 'ok', 2500)
}

export function initWorkbench() {
  initCombo()
  $('#bSend').onclick = send
  $('#bSave').onclick = saveTab
  $('#bBody').addEventListener('input', () => { const t = active(); if (t) { t.body = $('#bBody').value; touch(); validateBody() } })
  $('#bFormat').onclick = () => {
    try { $('#bBody').value = prettyJson(JSON.parse($('#bBody').value)); const t = active(); t.body = $('#bBody').value; touch(); validateBody() } catch (e) { toast(e.message, 'error') }
  }
  $('#bSession').onchange = () => { const t = active(); if (t) { t.as = null } store.set('lastSession', $('#bSession').value) }
  $('#emptyNew').onclick = () => openDraft({})
  for (const b of document.querySelectorAll('#bottomTabs button')) b.onclick = () => setBottom(b.dataset.pane)

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key === 'Enter') { e.preventDefault(); send() }
    if (mod && e.key.toLowerCase() === 's' && !$('#view-workbench').classList.contains('hidden')) { e.preventDefault(); saveTab() }
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#bCmd').focus(); $('#bCmd').select() }
  })

  bus.on('msgAdded', onIncoming)
  for (const e of ['session', 'sessionRemoved']) bus.on(e, () => { renderSessionSelect() })
  bus.on('init', () => {
    // drop tabs whose saved request vanished, refresh names from the collections
    tabs = tabs.filter((t) => !t.reqId || findRequest(t.reqId))
    if (!tabs.find((t) => t.id === activeId)) activeId = tabs[0]?.id ?? null
    renderTabs(); loadBuilder(); renderResponse(); setBottom(store.get('bottomPane', 'response'))
  })
  bus.on('collections', () => {
    for (const t of tabs) { const f = t.reqId && findRequest(t.reqId); if (f) t.name = f.req.name }
    renderTabs()
  })
}
