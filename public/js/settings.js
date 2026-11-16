// Settings page and the first-run wizard.
import { $, el, state, bus, api, debounce } from './core.js'
import { modal, toast } from './modal.js'
import { openNewSession } from './sessions.js'

// Fields shared by the settings page and the wizard. `values()` returns the current inputs.
function locationsForm(initial) {
  const t = el('input', { value: initial.teiserverDir, spellcheck: false, placeholder: '/home/you/code/teiserver' })
  const p = el('input', { value: initial.tachyonDir, spellcheck: false, placeholder: '/home/you/code/tachyon' })
  const tMsg = el('div', { class: 'check' })
  const pMsg = el('div', { class: 'check' })
  const found = el('div', { class: 'suggest' })
  const listeners = new Set()
  let last = { teiserver: { ok: false }, tachyon: { ok: false } }

  const run = debounce(async () => {
    try {
      const r = await api.request({ op: 'settingsCheck', teiserverDir: t.value, tachyonDir: p.value })
      last = r.checks
      show(tMsg, r.checks.teiserver)
      show(pMsg, r.checks.tachyon, r.commands != null ? ` · ${r.commands} commands` : '')
      listeners.forEach((fn) => fn(last))
    } catch { /* helper restarting */ }
  }, 200)
  const show = (box, c, extra = '') => { box.className = `check ${c.ok ? 'ok' : 'bad'}`; box.textContent = `${c.ok ? '✓' : '✗'} ${c.message}${extra}` }
  t.oninput = run
  p.oninput = run

  const detectBtn = el('button', { onclick: detect }, 'Auto-detect')
  async function detect(auto = false) {
    detectBtn.disabled = true
    const r = await api.request({ op: 'detectPaths' }).catch(() => null)
    detectBtn.disabled = false
    if (!r) return
    const { teiserver, tachyon } = r.found
    if (teiserver[0] && (!last.teiserver.ok || !auto)) t.value = teiserver[0]
    if (tachyon[0] && (!last.tachyon.ok || !auto)) p.value = tachyon[0]
    found.replaceChildren(
      ...[...teiserver.slice(1).map((d) => ['teiserver', d]), ...tachyon.slice(1).map((d) => ['tachyon', d])].map(([k, d]) =>
        el('button', { class: 'tagbtn', onclick: () => { (k === 'teiserver' ? t : p).value = d; run() } }, `${k}: ${d}`)))
    if (!auto && !teiserver.length && !tachyon.length) toast('Nothing found next to this app, in ~/code or in ~. Type the paths by hand.', 'info')
    run()
  }

  const root = el('div', { class: 'form' },
    el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Where do the two repositories live on this machine?'), el('span', { class: 'spacer' }), detectBtn),
    el('label', {}, 'Teiserver checkout (used to start the local server and generate tokens)'), t, tMsg,
    el('label', {}, 'Tachyon protocol checkout (its schema/ folder defines the commands)'), p, pMsg, found)
  run()
  return {
    root, detect: () => detect(true),
    values: () => ({ teiserverDir: t.value.trim(), tachyonDir: p.value.trim() }),
    checks: () => last,
    onCheck: (fn) => listeners.add(fn)
  }
}

function serversForm(s) {
  const local = el('input', { value: s.localUrl, spellcheck: false })
  const dev = el('input', { value: s.devUrl, spellcheck: false })
  const client = el('input', { value: s.clientId, spellcheck: false })
  const auto = el('input', { type: 'checkbox', checked: s.autostart })
  return {
    root: el('div', { class: 'form' },
      el('label', {}, 'Local Tachyon WebSocket'), local,
      el('label', {}, 'Dev server base URL'), dev,
      el('label', {}, 'OAuth client id (for the dev login)'), client,
      el('label', { class: 'inline' }, auto, ' Start the local Teiserver automatically when a local player connects')),
    values: () => ({ localUrl: local.value.trim(), devUrl: dev.value.trim().replace(/\/$/, ''), clientId: client.value.trim(), autostart: auto.checked })
  }
}

// ---- settings page -----------------------------------------------------------------
export function initSettings() {
  const draw = () => {
    const page = $('#view-settings .page')
    page.replaceChildren()
    const loc = locationsForm(state.settings)
    const srv = serversForm(state.settings)
    const save = async () => {
      const c = loc.checks()
      if (!c.tachyon.ok) return toast('The Tachyon folder is not valid yet', 'error')
      api.call({ op: 'settingsSave', settings: { ...state.settings, ...loc.values(), ...srv.values(), setupDone: true } })
      toast('Settings saved', 'ok', 2500)
    }
    page.append(
      el('div', { class: 'panel chamfer' }, el('h2', {}, 'Locations'), loc.root),
      el('div', { class: 'panel chamfer' }, el('h2', {}, 'Servers'), srv.root),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: save }, 'Save settings'),
        el('button', { onclick: () => openWizard() }, 'Run the setup wizard again')))
  }
  bus.on('init', draw)
  bus.on('showSettings', draw)
}

// ---- wizard ------------------------------------------------------------------------------
let wizardOpen = false
export const isWizardOpen = () => wizardOpen

export function openWizard() {
  if (wizardOpen) return
  wizardOpen = true
  let step = 0
  let loc, srv
  let skipLocal = false
  const body = el('div', { class: 'wizard-body' })
  const dots = el('div', { class: 'wiz-steps' })
  const nav = el('div', { class: 'dialog-actions' })
  const m = modal({
    wide: true, dismissable: false, className: 'wizard', onClose: () => { wizardOpen = false },
    body: [el('div', { class: 'wiz-brand' }, el('span', { class: 'star' }, '★'), ' TACHYON', el('span', { class: 'thin' }, 'DEBUG'), el('span', { class: 'wiz-sub' }, 'First-time setup')), dots, body, nav]
  })
  const titles = ['Welcome', 'Locations', 'Servers', 'First players', 'Ready']

  const save = (setupDone) => api.call({ op: 'settingsSave', settings: { ...state.settings, ...(loc ? loc.values() : {}), ...(srv ? srv.values() : {}), setupDone } })

  async function quickPlayers() {
    toast('Reading users from the local database…', 'info', 2500)
    const r = await api.request({ op: 'localUsers' }, 90000).catch((e) => ({ op: 'error', message: e.message }))
    if (r.op === 'error') return toast(`Could not read users: ${r.message}`, 'error', 8000)
    const real = r.users.filter((u) => u.name !== 'root')
    if (real.length < 2) return toast('Fewer than two users exist locally. Run mix teiserver.fakedata first.', 'error', 8000)
    api.call({ op: 'addLocalSessions', players: [{ user: real[0].name, alias: 'alice' }, { user: real[1].name, alias: 'bob' }] })
    toast(`Adding alice (${real[0].name}) and bob (${real[1].name})…`, 'ok', 5000)
  }

  function go(n) {
    step = n
    dots.replaceChildren(...titles.map((t, i) => el('span', { class: `wiz-dot ${i === step ? 'active' : i < step ? 'done' : ''}` }, el('b', {}, String(i + 1)), t)))
    body.replaceChildren()
    nav.replaceChildren()
    const back = el('button', { onclick: () => go(step - 1) }, 'Back')
    const next = (label, fn, enabled = true) => el('button', { class: 'primary', disabled: !enabled, onclick: fn }, label)

    if (step === 0) {
      body.append(
        el('h1', {}, 'Poke a Teiserver with several players at once'),
        el('p', { class: 'lead' }, 'TachyonDebug lets you connect as many Tachyon players as you like, to your local Teiserver or the dev server, and fire requests at them, then watch every message that comes back.'),
        el('ul', { class: 'bullets' },
          el('li', {}, 'Collections of saved requests, like in Postman'),
          el('li', {}, 'One-click players: tokens, server start and connection are handled for you'),
          el('li', {}, 'Scripted scenarios that drive several players and check the results')))
      nav.append(el('span', { class: 'spacer' }), next('Get started', () => go(1)))
    } else if (step === 1) {
      loc = locationsForm(state.settings)
      const skip = el('input', { type: 'checkbox', checked: skipLocal })
      const nextBtn = next('Next', () => go(2), false)
      const refresh = (c) => { skipLocal = skip.checked; nextBtn.disabled = !(c.tachyon.ok && (c.teiserver.ok || skipLocal)) }
      loc.onCheck(refresh)
      skip.onchange = () => refresh(loc.checks())
      body.append(el('h1', {}, 'Where is everything?'), loc.root,
        el('label', { class: 'inline' }, skip, ' I will only use the dev server (no local Teiserver)'))
      loc.detect()
      nav.append(back, el('span', { class: 'spacer' }), nextBtn)
    } else if (step === 2) {
      srv = serversForm({ ...state.settings, autostart: state.settings.autostart })
      body.append(el('h1', {}, 'Servers'),
        el('p', { class: 'muted' }, 'The defaults are right for a normal setup.'),
        srv.root,
        el('p', { class: 'status-line' }, el('span', { class: `dot ${state.devStatus === 'reachable' ? 'up' : 'down'}` }), `dev server: ${state.devStatus}`))
      nav.append(back, el('span', { class: 'spacer' }), next('Next', () => { save(false); go(3) }))
    } else if (step === 3) {
      body.append(el('h1', {}, 'Your first players'),
        el('p', { class: 'lead' }, 'A player is a connection logged in as one Teiserver user. Parties and matchmaking need at least two.'),
        el('div', { class: 'row' },
          skipLocal ? null : el('button', { class: 'primary', onclick: quickPlayers }, 'Add two players from my local users'),
          el('button', { onclick: () => openNewSession() }, 'Choose players…')),
        el('p', { class: 'muted' }, 'Players use real users of your local Teiserver (', el('code', {}, 'mix teiserver.fakedata'), ' creates some). You can skip this and add players any time from the workbench.'))
      nav.append(back, el('span', { class: 'spacer' }), next('Next', () => go(4)))
    } else {
      body.append(el('h1', {}, 'You are ready'),
        el('p', { class: 'lead' }, 'Open a request from the Party collection, pick a player and press Send. Ctrl+Enter sends, Ctrl+S saves, / jumps to the command box.'),
        el('p', { class: 'muted' }, 'Everything here can be changed later in Settings.'))
      nav.append(back, el('span', { class: 'spacer' }), next('Open the workbench', () => { save(true); m.close(); bus.emit('wizardDone') }))
    }
  }
  go(0)
}
