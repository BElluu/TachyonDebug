// Session bar ("players") and the new-session dialog.
import { $, el, state, bus, api, store, colorFor } from './core.js'
import { modal, toast } from './modal.js'
import { connectionMenu } from './robustness.js'

const STATE_LABEL = { open: 'connected', connecting: 'connecting…', closed: 'offline' }

export function initSessions() {
  const render = () => renderBar()
  bus.on('session', render)
  bus.on('sessionRemoved', render)
  bus.on('init', render)
  bus.on('openUrl', ({ url }) => {
    const w = window.open(url, '_blank')
    if (!w) {
      modal({ title: 'Log in on the dev server', body: [el('p', {}, 'Your browser blocked the popup. Open the login page manually:'), el('p', {}, el('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open login page'))] })
    }
  })
  $('#addSession').onclick = () => openNewSession()
}

function renderBar() {
  const bar = $('#sessionlist')
  bar.replaceChildren()
  if (!state.sessions.size) bar.append(el('span', { class: 'muted' }, 'No players yet. Add one to start sending requests →'))
  for (const s of state.sessions.values()) {
    const chip = el('button', { class: `chip ${s.state}`, title: `${s.name} · ${STATE_LABEL[s.state]}`, onclick: (e) => openMenu(s, e.currentTarget) },
      el('span', { class: 'avatar', style: `--c:${colorFor(s.name)}` }, s.name.slice(0, 1).toUpperCase()),
      el('span', { class: 'chip-text' },
        el('span', { class: 'chip-name' }, s.name, el('span', { class: `env-tag ${s.env}` }, s.env ?? 'custom')),
        el('span', { class: 'chip-sub' }, s.user ? `id ${s.user.id}` : STATE_LABEL[s.state])),
      el('span', { class: `dot ${s.state}` }))
    bar.append(chip)
  }
}

let menu
function openMenu(s, anchor) {
  menu?.remove()
  const r = anchor.getBoundingClientRect()
  const act = (fn) => () => { menu.remove(); fn() }
  menu = el('div', { class: 'menu chamfer', style: `left:${r.left}px;top:${r.bottom + 6}px` },
    s.state === 'open'
      ? el('button', { onclick: act(() => api.call({ op: 'disconnect', name: s.name })) }, 'Disconnect')
      : s.state === 'closed' ? el('button', { onclick: act(() => api.call({ op: 'connect', name: s.name })) }, 'Connect') : null,
    s.tokenUser ? el('div', { class: 'menu-note' }, `Teiserver user: ${s.tokenUser}`) : null,
    s.user ? el('button', { onclick: act(() => navigator.clipboard?.writeText(String(s.user.id))) }, `Copy user id (${s.user.id})`) : null,
    ...connectionMenu(s, act),
    el('button', { class: 'danger-text', onclick: act(() => api.call({ op: 'removeSession', name: s.name })) }, 'Remove'))
  document.body.append(menu)
  const away = (e) => { if (!menu?.contains(e.target)) { menu?.remove(); document.removeEventListener('mousedown', away) } }
  setTimeout(() => document.addEventListener('mousedown', away), 0)
}

// ---- new session dialog ---------------------------------------------------------------
export function openNewSession({ onDone } = {}) {
  let envKey = state.settings.devOnly ? 'dev' : store.get('newSessionEnv', 'local')
  const panel = el('div')
  const cards = el('div', { class: 'env-cards' })
  const m = modal({ title: 'Add players', wide: true, body: [cards, panel] })

  const envCard = (key, title, sub, status) =>
    el('button', { class: `env-card chamfer ${envKey === key ? 'active' : ''}`, onclick: () => { envKey = key; store.set('newSessionEnv', key); draw() } },
      el('span', { class: 'env-card-title' }, title), el('span', { class: 'env-card-sub' }, sub), status)

  function draw() {
    const ls = state.local.status
    cards.replaceChildren(
      ...(state.settings.devOnly ? [] : [envCard('local', 'Local', 'Your own Teiserver', el('span', { class: 'status-line' }, el('span', { class: `dot ${ls}` }), ls === 'up' ? 'running' : ls === 'starting' ? 'starting…' : 'not running, will start automatically'))]),
      envCard('dev', 'Dev', 'lobby-server-dev.beyondallreason.dev', el('span', { class: 'status-line' }, el('span', { class: `dot ${state.devStatus === 'reachable' ? 'up' : 'down'}` }), state.devStatus === 'reachable' ? 'reachable' : state.devStatus)))
    panel.replaceChildren(envKey === 'local' ? localForm() : devForm(), advanced())
  }

  function localForm() {
    const chosen = [] // { user, alias }
    const wrap = el('div', { class: 'form' })
    const list = el('div', { class: 'user-list' }, el('div', { class: 'empty' }, el('span', { class: 'spinner' }), ' reading users from the local database…'))
    const picked = el('div', { class: 'picked' })
    const search = el('input', { placeholder: 'Search users…', spellcheck: false })
    const manual = el('input', { placeholder: 'or type a username / email that is not listed', spellcheck: false })
    const goBtn = el('button', { class: 'primary' }, 'Create & connect')
    let users = []

    // sessions are called player1, player2, … (scenarios are written for those names)
    const freeAlias = () => {
      const used = new Set([...state.sessions.keys(), ...chosen.map((c) => c.alias)])
      let n = 1
      while (used.has(`player${n}`)) n++
      return `player${n}`
    }
    const toggle = (user) => {
      const i = chosen.findIndex((c) => c.user === user)
      if (i >= 0) chosen.splice(i, 1)
      else chosen.push({ user, alias: freeAlias() })
      drawPicked(); drawList()
    }
    function drawPicked() {
      picked.replaceChildren(...chosen.map((c) => el('div', { class: 'picked-row' },
        el('input', { value: c.alias, title: 'session name (what scenarios call this player)', spellcheck: false, oninput: (e) => { c.alias = e.target.value.trim() } }),
        el('span', { class: 'muted' }, '←'), el('code', {}, c.user),
        el('button', { class: 'icon', title: 'remove', onclick: () => toggle(c.user) }, '✕'))))
      goBtn.textContent = chosen.length ? `Create & connect (${chosen.length})` : 'Create & connect'
      goBtn.disabled = !chosen.length
    }
    function drawList() {
      const q = search.value.trim().toLowerCase()
      const rows = users.filter((u) => !q || u.name.toLowerCase().includes(q))
      const row = (u) => el('div', { class: `user-row ${chosen.some((c) => c.user === u.name) ? 'on' : ''}`, onclick: () => toggle(u.name) },
        el('span', {}, u.name), el('span', { class: 'muted mono' }, `#${u.id}`))
      list.replaceChildren(...(rows.length ? rows.map(row) : [el('div', { class: 'empty' }, users.length ? 'No match' : 'No users found')]))
    }
    search.oninput = drawList
    manual.addEventListener('keydown', (e) => { if (e.key === 'Enter' && manual.value.trim()) { toggle(manual.value.trim()); manual.value = '' } })

    api.request({ op: 'localUsers' }, 90000).then((r) => {
      if (r.op === 'error') throw new Error(r.message)
      users = r.users
      drawList()
    }).catch((err) => {
      list.replaceChildren(el('div', { class: 'empty err' }, `Could not read the user list: ${err.message}. You can still type a username below.`))
    })

    goBtn.onclick = () => {
      const players = chosen.filter((c) => c.alias).map((c) => ({ user: c.user, alias: c.alias }))
      if (!players.length) return
      api.call({ op: 'addLocalSessions', players })
      m.close(); onDone?.(players)
      toast(`Adding ${players.length} player${players.length > 1 ? 's' : ''}: token → connect`, 'info', 3500)
    }
    drawPicked()
    wrap.append(
      el('label', {}, 'Users that exist on your local Teiserver (click to select)'), search, list,
      el('label', {}, 'Players to add: session name ← Teiserver user'), picked, manual,
      el('p', { class: 'muted' }, 'Tokens are generated for you, and Teiserver is started if it is not running. The session name is only a label; scenarios and saved requests use player1, player2, player3…'),
      el('div', { class: 'row end' }, goBtn))
    return wrap
  }

  function devForm() {
    let n = 1
    while (state.sessions.has(`player${n}`)) n++
    const input = el('input', { value: `player${n}`, spellcheck: false })
    const go = () => {
      const name = input.value.trim()
      if (!name) return input.focus()
      api.call({ op: 'loginDev', name })
      m.close(); onDone?.([name])
      toast('Finish the login in the browser tab that just opened', 'info', 6000)
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
    return el('div', { class: 'form' },
      el('label', {}, 'Session name (just a label for you)'), input,
      el('p', { class: 'muted' }, 'Opens the dev server login in your browser. When you are back, the session connects by itself and keeps a refresh token, so you log in only once.'),
      el('div', { class: 'row end' }, el('button', { class: 'primary', onclick: go }, 'Log in & connect')))
  }

  function advanced() {
    const name = el('input', { placeholder: 'name', spellcheck: false })
    const token = el('input', { placeholder: 'access token', spellcheck: false })
    const go = () => {
      if (!name.value.trim() || !token.value.trim()) return
      api.call({ op: 'connectManual', name: name.value.trim(), env: envKey, token: token.value.trim() })
      m.close()
    }
    return el('details', { class: 'advanced' }, el('summary', {}, 'I already have a token'),
      el('div', { class: 'form' }, name, token, el('div', { class: 'row end' }, el('button', { onclick: go }, 'Connect with token'))))
  }

  draw()
  return m
}
