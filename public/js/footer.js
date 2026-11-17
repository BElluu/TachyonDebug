// Status strip: local server controls + dev reachability + helper link.
import { $, el, state, bus, api, store } from './core.js'
import { confirmDialog } from './modal.js'

function render() {
  // dev-only setups have no local server to show, control or read logs from
  const devOnly = !!state.settings.devOnly
  $('#lDot').closest('.srv').classList.toggle('hidden', devOnly)
  if (devOnly) $('#logDrawer').classList.add('hidden')
  const { status: st, managed } = state.local
  const label = { up: managed ? 'running · started by TachyonDebug' : 'running · started outside TachyonDebug', down: 'not running', starting: 'starting…', stopping: 'stopping…', unknown: 'checking…' }[st]
  $('#lDot').className = `dot ${st}`
  $('#lText').textContent = label
  $('#lStart').disabled = !['down', 'unknown'].includes(st)
  $('#lStop').disabled = st !== 'up'
  $('#lStart').title = st === 'up' ? 'already running' : 'start Postgres and mix phx.server'
  $('#dDot').className = `dot ${state.devStatus === 'reachable' ? 'up' : state.devStatus === 'unknown' ? 'unknown' : 'down'}`
  $('#dText').textContent = state.devStatus === 'reachable' ? 'reachable' : state.devStatus === 'unknown' ? 'checking…' : 'unreachable'
}

// drag the handle on top of the log drawer to resize it
function initDrawerResize() {
  const drawer = $('#logDrawer')
  const apply = (h) => { drawer.style.setProperty('--h', `${Math.round(Math.min(Math.max(h, 90), window.innerHeight * 0.85))}px`) }
  apply(store.get('drawerHeight', 240))
  $('#drawerHandle').addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const bottom = drawer.getBoundingClientRect().bottom
    const move = (ev) => apply(bottom - ev.clientY)
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      store.set('drawerHeight', parseInt(drawer.style.getPropertyValue('--h'), 10))
    }
    document.body.classList.add('resizing')
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  })
}

export function initFooter() {
  initDrawerResize()
  for (const e of ['init', 'local', 'devStatus']) bus.on(e, render)
  bus.on('helper', (up) => $('#helperDown').classList.toggle('hidden', up))
  bus.on('localLog', ({ text }) => {
    const pre = $('#lLog')
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40 || pre.clientHeight === 0
    const before = pre.scrollTop
    pre.append(text)
    if (pre.textContent.length > 60000) pre.textContent = pre.textContent.slice(-40000)
    pre.scrollTop = stick ? pre.scrollHeight : before
  })
  bus.on('init', () => { $('#lLog').textContent = (state.local.logs ?? []).join('') })
  $('#lStart').onclick = () => api.call({ op: 'localStart' })
  $('#lStop').onclick = async () => {
    if (!state.local.managed && !(await confirmDialog('This Teiserver was not started by TachyonDebug.\nSend SIGTERM to the process listening on its port?', { ok: 'Stop it', danger: true }))) return
    api.call({ op: 'localStop', force: !state.local.managed })
  }
  $('#lLogBtn').onclick = () => {
    $('#logDrawer').classList.toggle('hidden')
    const pre = $('#lLog')
    pre.scrollTop = pre.scrollHeight
  }
}
