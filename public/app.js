const $ = (id) => document.getElementById(id)
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const k of kids.flat()) if (k != null) n.append(k)
  return n
}
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } }
}

const state = {
  config: {}, catalog: [], sessions: new Map(), toolbox: [], envs: {}, local: { status: 'unknown', managed: false }, scenarios: [], entries: [],
  requestsById: new Map(), // messageId -> commandId, to label responses
  selected: null, hidden: new Set(store.get('hidden', [])), history: store.get('history', []),
  scenarioProgress: new Map()
}

// ---- websocket to the local server -----------------------------------------
let ws, nextReq = 1
function connectUi() {
  ws = new WebSocket(`ws://${location.host}/ui`)
  ws.onopen = () => setConn(true)
  ws.onclose = () => { setConn(false); setTimeout(connectUi, 1000) }
  ws.onmessage = (e) => handle(JSON.parse(e.data))
}
function setConn(ok) {
  const p = $('conn')
  p.textContent = ok ? 'server: connected' : 'server: reconnecting…'
  p.classList.toggle('ok', ok)
}
const call = (payload) => ws.send(JSON.stringify({ reqId: nextReq++, ...payload }))

function handle(m) {
  switch (m.op) {
    case 'init':
      state.config = m.config
      state.envs = m.envs
      state.toolbox = m.toolbox
      state.local = m.local
      $('lLog').textContent = (m.local.logs ?? []).join('')
      renderEnvSelect()
      state.catalog = m.catalog.commands.filter((c) => c.kinds.request && ['user', 'autohost'].includes(c.kinds.request.source))
      m.sessions.forEach((s) => state.sessions.set(s.name, s))
      state.scenarios = m.scenarios
      $('cfg').textContent = `schemas: ${m.config.tachyonDir}${m.catalog.error ? ' ⚠ ' + m.catalog.error : ` (${m.catalog.commands.length} commands)`}`
      renderAll()
      renderLocal()
      break
    case 'toolbox':
      state.toolbox = m.items
      renderToolbox()
      break
    case 'local':
      state.local = { ...state.local, status: m.status, managed: m.managed }
      renderLocal()
      break
    case 'localLog': {
      const pre = $('lLog')
      pre.textContent = (pre.textContent + m.text).slice(-20000)
      pre.scrollTop = pre.scrollHeight
      break
    }
    case 'authUrl':
      window.open(m.url, '_blank')
      $('sMsg').textContent = 'finish the login in the opened tab…'
      break
    case 'oauthDone':
      if (m.error) $('sMsg').textContent = `login failed: ${m.error}`
      else {
        $('sToken').value = m.accessToken
        state.oauth = { refreshToken: m.refreshToken, expiresAt: m.expiresAt }
        $('sMsg').textContent = 'logged in, now name the session and connect'
      }
      break
    case 'session':
      state.sessions.set(m.session.name, m.session)
      renderSessions(); renderFilters(); renderSessionSelect(); renderToolbox()
      break
    case 'sessionRemoved':
      state.sessions.delete(m.name)
      renderSessions(); renderFilters(); renderSessionSelect()
      break
    case 'msg':
      addEntry(m)
      break
    case 'scenarioLog':
      scenarioLog(m)
      break
    case 'token':
      $('sToken').value = m.token
      $('sMsg').textContent = 'token generated'
      break
    case 'error':
      if (m.where === 'local') $('lMsg').textContent = m.message
      else { $('cErr').textContent = m.message; $('sMsg').textContent = m.message }
      break
  }
}

// ---- sessions ----------------------------------------------------------------
function renderSessions() {
  const box = $('sessions')
  box.replaceChildren()
  if (!state.sessions.size) box.append(el('div', { className: 'muted', textContent: 'No sessions yet. Add one below.' }))
  for (const s of state.sessions.values()) {
    const open = s.state === 'open'
    box.append(
      el('div', { className: 'session' },
        el('span', { className: `dot ${s.state}`, title: s.state }),
        el('div', { className: 'grow' },
          el('div', { className: 'nm' }, s.name, ' ', el('span', { className: 'env', textContent: s.env ?? 'custom' })),
          el('div', { className: 'who', textContent: s.user ? `${s.user.name ?? '?'} · id ${s.user.id}` : s.state })),
        el('button', {
          textContent: open ? 'disconnect' : 'connect',
          onclick: () => open ? call({ op: 'disconnect', name: s.name }) : call({ op: 'connect', name: s.name, url: s.url, token: s.token, env: s.env, refreshToken: s.refreshToken, expiresAt: s.expiresAt })
        }),
        el('button', { textContent: '✕', title: 'forget session', onclick: () => call({ op: 'removeSession', name: s.name }) }))
    )
  }
}

function renderSessionSelect() {
  const sel = $('cSession')
  const prev = sel.value
  sel.replaceChildren(...[...state.sessions.keys()].map((n) => el('option', { value: n, textContent: n })))
  if (prev && state.sessions.has(prev)) sel.value = prev
}

function renderEnvSelect() {
  const sel = $('sEnv')
  sel.replaceChildren(...Object.entries(state.envs).map(([k, e]) => el('option', { value: k, textContent: `${e.label} (${e.url})` })))
  sel.value = store.get('env', 'local')
  syncEnvForm()
}
function syncEnvForm() {
  const e = state.envs[$('sEnv').value]
  if (!e) return
  $('sUrl').value = e.url
  $('sGen').hidden = !e.managed
  $('sLogin').hidden = !e.oauth
  store.set('env', $('sEnv').value)
}
$('sEnv').onchange = syncEnvForm

function renderLocal() {
  const { status: st, managed } = state.local
  $('lDot').className = `dot ${st}`
  $('lStatus').textContent = st === 'up' ? (managed ? 'up · started by TachyonDebug' : 'up · started outside TachyonDebug') : st
  $('lStart').disabled = !['down', 'unknown'].includes(st)
  $('lStart').title = st === 'up' ? 'already running' : 'start Postgres + mix phx.server'
  $('lStop').disabled = st !== 'up'
  $('lStop').title = managed ? 'stop the server' : 'stop the external server (asks first)'
  if (st !== 'down') $('lMsg').textContent = ''
}
$('lStart').onclick = () => { $('lMsg').textContent = ''; call({ op: 'localStart' }) }
$('lStop').onclick = () => {
  $('lMsg').textContent = ''
  if (!state.local.managed && !confirm('This Teiserver was not started by TachyonDebug.\nSend SIGTERM to the process listening on its port?')) return
  call({ op: 'localStop', force: !state.local.managed })
}

$('sGen').onclick = () => {
  const user = $('sName').value.trim()
  if (!user) return ($('sMsg').textContent = 'enter the name (username/email of the teiserver user) first')
  $('sMsg').textContent = 'running mix teiserver.gen_token… (can take a few seconds)'
  call({ op: 'genToken', user })
}
$('sLogin').onclick = () => {
  $('sMsg').textContent = 'contacting the server…'
  call({ op: 'oauthLogin', loginId: String(Date.now()) })
}
$('sConnect').onclick = () => {
  const name = $('sName').value.trim()
  if (!name) return ($('sMsg').textContent = 'name required')
  call({ op: 'connect', name, env: $('sEnv').value, token: $('sToken').value.trim(), url: $('sUrl').value.trim(), ...(state.oauth ?? {}) })
  state.oauth = null
  $('sMsg').textContent = ''
}

// ---- log ---------------------------------------------------------------------
const colorFor = (name) => {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 60% 45%)`
}
const hhmmss = (ts) => new Date(ts).toISOString().slice(11, 23)

function addEntry(m) {
  const msg = m.msg
  if (m.dir === 'out' && msg.messageId) state.requestsById.set(msg.messageId, msg.commandId)
  state.entries.push(m)
  if (state.entries.length > 3000) state.entries.shift()
  renderLog(true)
}

function visible(m) {
  if (state.hidden.has(m.session)) return false
  if (m.dir === 'sys' && !$('fSys').checked) return false
  const q = $('fText').value.trim().toLowerCase()
  return !q || JSON.stringify(m.msg).toLowerCase().includes(q)
}

function entryNode(m) {
  const msg = m.msg
  if (m.dir === 'sys') {
    return el('div', { className: `entry sys${msg.error ? ' error' : ''}` },
      el('span', { className: 'time', textContent: hhmmss(m.ts) + ' ' }),
      el('span', { className: 'who', textContent: m.session, style: `color:${colorFor(m.session)}` }),
      ` ${msg.text}`)
  }
  const cmd = msg.commandId ?? state.requestsById.get(msg.messageId) ?? '(raw)'
  const status = msg.type === 'response' ? msg.status : null
  const reason = msg.reason ? `${msg.reason}${msg.details ? ' · ' + msg.details : ''}` : ''
  const body = el('pre', { textContent: JSON.stringify(msg, null, 2) })
  const actions = el('div', { className: 'actions' },
    el('button', { textContent: 'copy', onclick: () => navigator.clipboard?.writeText(JSON.stringify(msg, null, 2)) }),
    m.dir === 'out' && msg.type === 'request'
      ? el('button', { textContent: 'resend', onclick: () => call({ op: 'send', name: m.session, commandId: msg.commandId, data: msg.data }) })
      : null,
    m.dir === 'out' && msg.type === 'request'
      ? el('button', { textContent: '☆ save', onclick: () => saveToToolbox({ as: m.session, commandId: msg.commandId, data: msg.data }) })
      : null,
    m.dir === 'out' && msg.type === 'request'
      ? el('button', { textContent: 'edit', onclick: () => loadIntoComposer(m.session, msg.commandId, msg.data) })
      : null)
  return el('details', { className: `entry ${m.dir}` },
    el('summary', {},
      el('span', { className: 'time', textContent: hhmmss(m.ts) }),
      el('span', { className: 'who', textContent: m.session, style: `color:${colorFor(m.session)}` }),
      el('span', { className: 'arrow', textContent: m.dir === 'in' ? '←' : '→' }),
      el('span', { className: 'cmd', textContent: cmd }),
      el('span', { className: 'badge', textContent: msg.type ?? '?' }),
      status ? el('span', { className: `badge ${status}`, textContent: status }) : null,
      reason ? el('span', { className: 'badge failed', textContent: reason }) : null,
      msg.data !== undefined ? el('span', { className: 'brief', textContent: JSON.stringify(msg.data) }) : null),
    body, actions)
}

function renderLog(stick = false) {
  const log = $('log')
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
  const entries = state.entries.filter(visible)
  log.replaceChildren()
  if ($('fSideBySide').checked) {
    const names = [...state.sessions.keys()].filter((n) => !state.hidden.has(n))
    log.className = 'cols'
    log.style.gridTemplateColumns = `repeat(${Math.max(names.length, 1)}, minmax(0, 1fr))`
    for (const n of names) {
      log.append(el('div', { className: 'col' }, el('h3', { textContent: n, style: `color:${colorFor(n)}` }),
        entries.filter((e) => e.session === n).map(entryNode)))
    }
  } else {
    log.className = ''
    log.style.gridTemplateColumns = ''
    log.append(...entries.map(entryNode))
  }
  if (stick && atBottom) log.scrollTop = log.scrollHeight
}

function renderFilters() {
  const box = $('fSessions')
  box.replaceChildren(...[...state.sessions.keys()].map((n) =>
    el('label', {},
      el('input', {
        type: 'checkbox', checked: !state.hidden.has(n),
        onchange: (e) => {
          e.target.checked ? state.hidden.delete(n) : state.hidden.add(n)
          store.set('hidden', [...state.hidden])
          renderLog()
        }
      }),
      el('span', { textContent: n, style: `color:${colorFor(n)}` }))))
}
$('fText').oninput = () => renderLog()
$('fSys').onchange = () => renderLog()
$('fSideBySide').onchange = () => renderLog()
$('fClear').onclick = () => { state.entries = []; renderLog() }

// ---- composer ----------------------------------------------------------------
function renderCommandList() {
  const q = $('cSearch').value.trim().toLowerCase()
  const list = $('cList')
  list.replaceChildren()
  let lastGroup = null
  for (const c of state.catalog.filter((c) => c.id.includes(q))) {
    if (c.group !== lastGroup) { list.append(el('div', { className: 'grp', textContent: c.group })); lastGroup = c.group }
    list.append(el('div', {
      className: `item${state.selected === c.id ? ' sel' : ''}`,
      onclick: () => selectCommand(c.id)
    }, c.name, el('span', { className: 'tag', textContent: c.kinds.request.source === 'autohost' ? 'autohost' : '' })))
  }
}

function selectCommand(id, data) {
  const c = state.catalog.find((c) => c.id === id)
  state.selected = id
  $('cSearch').value = id
  $('cData').value = JSON.stringify(data !== undefined ? data : c?.kinds.request.template ?? {}, null, 2)
  const reasons = c?.kinds.response?.reasons
  const info = [`scopes: ${c?.kinds.request.scopes.join(', ') || '-'}`]
  if (reasons) info.push(`failure reasons: ${reasons.join(', ')}`)
  if (!c?.kinds.request.schema) info.push('no request data')
  $('cInfo').textContent = info.join(' · ')
  $('cErr').textContent = ''
  renderCommandList()
}

function loadIntoComposer(session, commandId, data) {
  $('cSession').value = session
  selectCommand(commandId, data)
}

function composerPayload() {
  const name = $('cSession').value
  if (!name) throw new Error('add a session first')
  if (!state.selected) throw new Error('pick a command')
  const text = $('cData').value.trim()
  const c = state.catalog.find((c) => c.id === state.selected)
  const data = text ? JSON.parse(text) : undefined
  return { name, commandId: state.selected, data: c?.kinds.request.schema || data !== undefined ? data : undefined }
}

function doSend() {
  try {
    const p = composerPayload()
    call({ op: 'send', ...p })
    state.history = [{ name: p.name, commandId: p.commandId, data: p.data }, ...state.history.filter((h) => JSON.stringify(h) !== JSON.stringify(p))].slice(0, 30)
    store.set('history', state.history)
    renderHistory()
    $('cErr').textContent = ''
  } catch (e) {
    $('cErr').textContent = e.message
  }
}

$('cSend').onclick = doSend
$('cSave').onclick = () => {
  try {
    const p = composerPayload()
    saveToToolbox({ as: $('cBind').checked ? p.name : null, commandId: p.commandId, data: p.data })
  } catch (e) { $('cErr').textContent = e.message }
}
$('cRaw').onclick = () => {
  try { call({ op: 'raw', name: $('cSession').value, text: $('cData').value }) } catch (e) { $('cErr').textContent = e.message }
}
$('cSearch').oninput = () => { state.selected = null; renderCommandList() }
$('cSearch').onkeydown = (e) => {
  if (e.key === 'Enter') {
    const first = state.catalog.find((c) => c.id.includes($('cSearch').value.trim().toLowerCase()))
    if (first) selectCommand(first.id)
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend() }
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('cSearch').focus(); $('cSearch').select() }
})

function renderHistory() {
  $('hist').replaceChildren(...state.history.map((h) =>
    el('div', {
      className: 'h', title: JSON.stringify(h.data),
      onclick: () => loadIntoComposer(state.sessions.has(h.name) ? h.name : $('cSession').value, h.commandId, h.data)
    }, `${h.name}: ${h.commandId} ${h.data ? JSON.stringify(h.data) : ''}`)))
}

// ---- toolbox -----------------------------------------------------------------
function saveToToolbox({ as, commandId, data }) {
  const name = prompt('Name for this request\n(use "folder/name" to group it)', commandId)
  if (!name) return
  call({ op: 'toolboxSave', item: { name: name.trim(), as, commandId, data } })
}

function runToolboxItem(item) {
  const name = item.as && state.sessions.has(item.as) ? item.as : $('cSession').value
  if (!name) return ($('cErr').textContent = 'add a session first')
  $('cErr').textContent = ''
  call({ op: 'send', name, commandId: item.commandId, data: item.data })
}

function renderToolbox() {
  const box = $('toolbox')
  box.replaceChildren()
  if (!state.toolbox.length) {
    box.append(el('div', { className: 'muted', textContent: 'Empty. Compose a request and press ☆ save.' }))
    return
  }
  const folders = new Map()
  for (const t of state.toolbox) {
    const i = t.name.indexOf('/')
    const folder = i > 0 ? t.name.slice(0, i) : ''
    if (!folders.has(folder)) folders.set(folder, [])
    folders.get(folder).push({ ...t, label: i > 0 ? t.name.slice(i + 1) : t.name })
  }
  for (const [folder, items] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
    if (folder) box.append(el('div', { className: 'grp', textContent: folder }))
    for (const t of items) {
      const gone = t.as && !state.sessions.has(t.as)
      box.append(el('div', { className: 'tool' },
        el('button', { className: 'run', textContent: '▶', title: `send${t.as ? ' as ' + t.as : ' as the selected session'}`, onclick: () => runToolboxItem(t) }),
        el('div', { className: 'grow', title: JSON.stringify(t.data ?? null) , onclick: () => loadIntoComposer(t.as && state.sessions.has(t.as) ? t.as : $('cSession').value, t.commandId, t.data) },
          el('div', { className: 'nm', textContent: t.label }),
          el('div', { className: 'cmdline', textContent: `${t.commandId}${t.as ? ' · ' + t.as : ''}${gone ? ' (offline)' : ''}` })),
        el('button', { className: 'ghost', textContent: '✕', title: 'remove', onclick: () => call({ op: 'toolboxDelete', id: t.id }) })))
    }
  }
}

// ---- scenarios ---------------------------------------------------------------
function renderScenarios() {
  const box = $('scenarios')
  box.replaceChildren()
  if (!state.scenarios.length) box.append(el('div', { className: 'muted', textContent: 'No scenarios in ./scenarios' }))
  for (const sc of state.scenarios) {
    const prog = state.scenarioProgress.get(sc.file) ?? {}
    box.append(el('div', { className: 'scenario' },
      el('div', { className: 't', textContent: sc.name }),
      el('div', { className: 'muted', textContent: sc.description }),
      el('button', { textContent: prog.running ? 'running…' : 'run', disabled: !!prog.running, onclick: () => runScenario(sc) }),
      el('ol', {}, sc.steps.map((s, i) =>
        el('li', { className: prog.steps?.[i]?.status ?? '', title: prog.steps?.[i]?.detail ?? '' },
          `${s.as ?? ''} ${s.command ?? (s.waitFor ? 'wait ' + s.waitFor : s.sleep ? 'sleep ' + s.sleep : '')}${prog.steps?.[i]?.detail ? ' — ' + prog.steps[i].detail : ''}`))),
      prog.final ? el('div', { className: 'muted', textContent: prog.final }) : null))
  }
}
function runScenario(sc) {
  state.scenarioProgress.set(sc.file, { running: true, steps: [] })
  renderScenarios()
  call({ op: 'runScenario', file: sc.file })
}
function scenarioLog(m) {
  const p = state.scenarioProgress.get(m.scenario) ?? { steps: [] }
  if (m.step !== undefined) p.steps[m.step] = { status: m.status, detail: m.detail }
  if (['done', 'aborted'].includes(m.status)) { p.running = false; p.final = m.status === 'done' ? '✓ done' : '✗ aborted' }
  state.scenarioProgress.set(m.scenario, p)
  renderScenarios()
}

function renderAll() {
  renderSessions(); renderSessionSelect(); renderFilters(); renderCommandList(); renderHistory(); renderScenarios(); renderToolbox(); renderLog()
}

connectUi()
