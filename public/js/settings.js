// Settings page and the first-run wizard.
import { $, el, state, bus, api, debounce } from './core.js'
import { modal, toast } from './modal.js'
import { openNewSession } from './sessions.js'

// Fields shared by the settings page and the wizard. `values()` returns the current inputs.
const GIT_RE = /^(https?:\/\/|file:\/\/|ssh:\/\/|git:\/\/|git@[\w.-]+:)/
const DEFAULT_REPO = 'https://github.com/beyond-all-reason/tachyon.git'

function locationsForm(initial) {
  const t = el('input', { value: initial.teiserverDir, spellcheck: false, placeholder: '/home/you/code/teiserver' })
  // Tachyon: either a local checkout, or a git repository (cloned into data/repos/, only schema/ is read)
  const isGit = GIT_RE.test(initial.tachyonDir ?? '')
  const [gitUrl, gitRef] = isGit ? initial.tachyonDir.split('#') : [DEFAULT_REPO, '']
  let mode = isGit ? 'git' : 'local'
  const p = el('input', { value: isGit ? '' : initial.tachyonDir, spellcheck: false, placeholder: '/home/you/code/tachyon' })
  const gUrl = el('input', { value: gitUrl, spellcheck: false, placeholder: DEFAULT_REPO })
  const gRef = el('input', { value: gitRef ?? '', spellcheck: false, placeholder: 'default branch (e.g. main) or a tag' })
  const tValue = () => (mode === 'git' ? `${gUrl.value.trim()}${gRef.value.trim() ? '#' + gRef.value.trim() : ''}` : p.value.trim())
  const devOnlyBox = el('input', { type: 'checkbox', checked: !!initial.devOnly })
  const tMsg = el('div', { class: 'check' })
  const pMsg = el('div', { class: 'check' })
  const found = el('div', { class: 'suggest' })
  const listeners = new Set()
  let last = { teiserver: { ok: false }, tachyon: { ok: false } }

  const localBox = el('div', { class: 'form' }, p)
  const gitBox = el('div', { class: 'form' }, el('label', {}, 'Repository URL'), gUrl, el('label', {}, 'Branch / tag (optional)'), gRef)
  const seg = el('div', { class: 'seg' })
  const drawMode = () => {
    seg.replaceChildren(
      el('button', { class: mode === 'local' ? 'active' : '', onclick: () => { mode = 'local'; drawMode(); run() } }, 'Local folder'),
      el('button', { class: mode === 'git' ? 'active' : '', onclick: () => { mode = 'git'; drawMode(); run() } }, 'Git repository'))
    localBox.classList.toggle('hidden', mode !== 'local')
    gitBox.classList.toggle('hidden', mode !== 'git')
    found.classList.toggle('hidden', mode !== 'local')
  }

  // dev-only: no local Teiserver at all, so its folder is neither asked for nor checked
  const teiBox = el('div', { class: 'form' }, el('label', {}, 'Teiserver checkout (local only: used to start the local server and generate tokens)'), t, tMsg)
  const applyDevOnly = () => { teiBox.classList.toggle('hidden', devOnlyBox.checked); detectBtn.classList.toggle('hidden', devOnlyBox.checked && mode === 'git') }
  devOnlyBox.onchange = () => { applyDevOnly(); listeners.forEach((fn) => fn(last)); onDevOnly.forEach((fn) => fn(devOnlyBox.checked)) }
  const onDevOnly = new Set()

  const run = debounce(async () => {
    try {
      const r = await api.request({ op: 'settingsCheck', teiserverDir: t.value, tachyonDir: tValue() })
      last = r.checks
      show(tMsg, r.checks.teiserver)
      show(pMsg, r.checks.tachyon, r.commands != null ? ` · ${r.commands} commands` : '')
      fetchBtn.classList.toggle('hidden', mode !== 'git')
      fetchBtn.textContent = r.checks.tachyon.ok ? 'Update from git' : 'Fetch'
      listeners.forEach((fn) => fn(last))
    } catch { /* helper restarting */ }
  }, 200)
  const show = (box, c, extra = '') => { box.className = `check ${c.ok ? 'ok' : 'bad'}`; box.textContent = `${c.ok ? '✓' : '✗'} ${c.message}${extra}` }
  for (const i of [t, p, gUrl, gRef]) i.oninput = run

  const fetchBtn = el('button', { class: 'hidden', onclick: async () => {
    fetchBtn.disabled = true
    pMsg.className = 'check info'; pMsg.textContent = 'Fetching…'
    const r = await api.request({ op: 'tachyonFetch', tachyonDir: tValue() }, 130000).catch((e) => ({ error: e.message }))
    fetchBtn.disabled = false
    if (r.error) { pMsg.className = 'check bad'; pMsg.textContent = `✗ ${r.error}`; return }
    run()
  } }, 'Fetch')
  const detectBtn = el('button', { onclick: detect }, 'Auto-detect')
  async function detect(auto = false) {
    detectBtn.disabled = true
    const r = await api.request({ op: 'detectPaths' }).catch(() => null)
    detectBtn.disabled = false
    if (!r) return
    const { teiserver, tachyon } = r.found
    if (teiserver[0] && (!last.teiserver.ok || !auto)) t.value = teiserver[0]
    if (tachyon[0] && mode === 'local' && (!last.tachyon.ok || !auto)) p.value = tachyon[0]
    found.replaceChildren(
      ...[...teiserver.slice(1).map((d) => ['teiserver', d]), ...tachyon.slice(1).map((d) => ['tachyon', d])].map(([k, d]) =>
        el('button', { class: 'tagbtn', onclick: () => { (k === 'teiserver' ? t : p).value = d; run() } }, `${k}: ${d}`)))
    if (!auto && !teiserver.length && !tachyon.length) toast('Nothing found next to this app, in ~/code or in ~. Type the paths by hand.', 'info')
    run()
  }

  const root = el('div', { class: 'form' },
    el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Where do the repositories live?'), el('span', { class: 'spacer' }), detectBtn),
    el('label', { class: 'inline' }, devOnlyBox, ' I will only use the dev server (no local Teiserver)'),
    teiBox,
    el('label', {}, 'Tachyon protocol (its schema/ folder defines the commands)'), seg, localBox, gitBox,
    el('div', { class: 'row tight' }, pMsg, fetchBtn),
    el('p', { class: 'muted small-note' }, 'Git repository: it is cloned once into data/repos/ and only schema/ is read. “Update from git” pulls the latest.'), found)
  drawMode()
  applyDevOnly()
  run()
  return {
    root, detect: () => detect(true),
    devOnly: () => devOnlyBox.checked,
    onDevOnly: (fn) => onDevOnly.add(fn),
    values: () => ({ teiserverDir: t.value.trim(), tachyonDir: tValue(), devOnly: devOnlyBox.checked }),
    checks: () => last,
    onCheck: (fn) => listeners.add(fn)
  }
}

function serversForm(s) {
  const local = el('input', { value: s.localUrl, spellcheck: false })
  const dev = el('input', { value: s.devUrl, spellcheck: false })
  const client = el('input', { value: s.clientId, spellcheck: false })
  const auto = el('input', { type: 'checkbox', checked: s.autostart })
  const localBox = el('div', { class: 'form' }, el('label', {}, 'Local Tachyon WebSocket'), local)
  const autoLbl = el('label', { class: 'inline' }, auto, ' Start the local Teiserver automatically when a local player connects')
  const setDevOnly = (on) => { localBox.classList.toggle('hidden', on); autoLbl.classList.toggle('hidden', on) }
  setDevOnly(!!s.devOnly)
  return {
    setDevOnly,
    root: el('div', { class: 'form' },
      localBox,
      el('label', {}, 'Teiserver base URL'), dev,
      el('label', {}, 'OAuth client id (for the dev login)'), client,
      autoLbl),
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
    loc.onDevOnly(srv.setDevOnly)
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
  const body = el('div', { class: 'wizard-body' })
  const dots = el('div', { class: 'wiz-steps' })
  const nav = el('div', { class: 'dialog-actions' })
  const m = modal({
    wide: true, dismissable: false, className: 'wizard', onClose: () => { wizardOpen = false },
    body: [el('div', { class: 'wiz-brand' }, el('span', { class: 'star' }, '★'), ' TACHYON', el('span', { class: 'thin' }, 'DEBUG'), el('span', { class: 'wiz-sub' }, 'First-time setup')), dots, body, nav]
  })
  // You go through the wizard or you switch it off (✕ / Esc): there is no "skip". Switching it off marks setup as done
  // so it does not pop up again; everything stays reachable in Settings.
  const leave = () => { if (!state.settings.setupDone) api.call({ op: 'settingsSave', settings: { ...state.settings, setupDone: true } }); document.removeEventListener('keydown', onKey); m.close() }
  const onKey = (e) => { if (e.key === 'Escape') leave() }
  document.addEventListener('keydown', onKey)
  m.root.querySelector('.dialog').append(el('button', { class: 'wiz-close', title: 'Close the wizard (Esc)', onclick: leave }, '✕'))
  const titles = ['Welcome', 'Locations', 'Servers', 'First players', 'Ready']

  const save = (setupDone) => api.call({ op: 'settingsSave', settings: { ...state.settings, ...(loc ? loc.values() : {}), ...(srv ? srv.values() : {}), setupDone } })

  async function quickPlayers() {
    toast('Reading users from the local database…', 'info', 2500)
    const r = await api.request({ op: 'localUsers' }, 90000).catch((e) => ({ op: 'error', message: e.message }))
    if (r.op === 'error') return toast(`Could not read users: ${r.message}`, 'error', 8000)
    const real = r.users.filter((u) => u.name !== 'root')
    if (real.length < 2) return toast('Fewer than two users exist locally. Run mix teiserver.fakedata first.', 'error', 8000)
    api.call({ op: 'addLocalSessions', players: [{ user: real[0].name, alias: 'player1' }, { user: real[1].name, alias: 'player2' }] })
    toast(`Adding player1 (${real[0].name}) and player2 (${real[1].name})…`, 'ok', 5000)
  }

  // live list of the players added so far (updates while a dev login or token generation is in progress)
  function playersBox() {
    const box = el('div', { class: 'wiz-players' })
    const draw = () => {
      if (!box.isConnected && box.dataset.drawn) return
      box.dataset.drawn = '1'
      const list = [...state.sessions.values()]
      box.replaceChildren(
        el('div', { class: 'label' }, `Players (${list.length})`),
        ...(list.length ? list.map((s) => el('div', { class: 'wiz-player' },
          el('span', { class: `dot ${s.state === 'open' ? 'open' : s.state}` }),
          el('b', {}, s.name), el('span', { class: `env-tag ${s.env}` }, s.env ?? 'custom'),
          el('span', { class: 'muted mono' }, s.state === 'open' ? (s.user ? `${s.user.name ?? ''} #${s.user.id}` : 'connected') : s.state === 'connecting' ? (s.env === 'dev' ? 'waiting for the login in your browser…' : 'connecting…') : 'offline')))
          : [el('div', { class: 'muted' }, 'None yet. Players you add show up here.')]))
    }
    for (const e of ['session', 'sessionRemoved']) bus.on(e, () => { if (wizardOpen) draw() })
    setTimeout(draw, 0)
    return box
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
      const nextBtn = next('Next', () => go(2), false)
      const refresh = (c) => { nextBtn.disabled = !(c.tachyon.ok && (c.teiserver.ok || loc.devOnly())) }
      loc.onCheck(refresh)
      body.append(el('h1', {}, 'Where is everything?'), loc.root)
      loc.detect()
      nav.append(back, el('span', { class: 'spacer' }), nextBtn)
    } else if (step === 2) {
      srv = serversForm({ ...state.settings, ...loc.values() })
      body.append(el('h1', {}, 'Servers'),
        el('p', { class: 'muted' }, 'The defaults are right for a normal setup.'),
        srv.root,
        el('p', { class: 'status-line' }, el('span', { class: `dot ${state.devStatus === 'reachable' ? 'up' : 'down'}` }), `dev server: ${state.devStatus}`))
      nav.append(back, el('span', { class: 'spacer' }), next('Next', () => { save(false); go(3) }))
    } else if (step === 3) {
      body.append(el('h1', {}, 'Your first players'),
        el('p', { class: 'lead' }, 'A player is a connection logged in as one Teiserver user. Parties and matchmaking need at least two.'),
        el('div', { class: 'row' },
          loc.devOnly() ? null : el('button', { class: 'primary', onclick: quickPlayers }, 'Add two players from my local users'),
          el('button', { onclick: () => openNewSession() }, 'Choose players…')),
        playersBox(),
        el('p', { class: 'muted' }, loc.devOnly() ? 'Players log in on the dev server through your browser. You can also add players any time from the workbench.' : ['Players use real users of your local Teiserver (', el('code', {}, 'mix teiserver.fakedata'), ' creates some). You can also add players any time from the workbench.']))
      nav.append(back, el('span', { class: 'spacer' }), next('Next', () => go(4)))
    } else {
      body.append(el('h1', {}, 'You are ready'),
        el('p', { class: 'lead' }, 'Open a request from the Party collection, pick a player and press Send. Ctrl+Enter sends, Ctrl+S saves, / jumps to the command box.'),
        el('p', { class: 'muted' }, 'Everything here can be changed later in Settings.'))
      nav.append(back, el('span', { class: 'spacer' }), next('Open the workbench', () => { save(true); document.removeEventListener('keydown', onKey); m.close(); bus.emit('wizardDone') }))
    }
  }
  go(0)
}
