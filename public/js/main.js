import { $, state, bus, connectHelper, store } from './core.js'
import { toast } from './modal.js'
import { initSessions } from './sessions.js'
import { initCollections } from './collections.js'
import { initWorkbench } from './workbench.js'
import { initTimeline } from './timeline.js'
import { initScenarios } from './scenarios.js'
import { initSettings, openWizard, isWizardOpen } from './settings.js'
import { initFooter } from './footer.js'
import { initPlayerState } from './playerstate.js'

// ---- top navigation -----------------------------------------------------------------
function showView(name) {
  store.set('view', name)
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('active', b.dataset.view === name)
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== `view-${name}`)
  if (name === 'settings') bus.emit('showSettings')
}
for (const b of document.querySelectorAll('#nav button')) b.onclick = () => showView(b.dataset.view)

// ---- messages from the helper process -------------------------------------------------
function handle(m) {
  switch (m.op) {
    case 'init':
      Object.assign(state, {
        settings: m.settings, checks: m.checks, envs: m.envs, collections: m.collections,
        local: m.local, devStatus: m.devStatus, scenarios: m.scenarios,
        // only commands a client may send
        catalog: m.catalog.commands.filter((c) => c.kinds.request && ['user', 'autohost'].includes(c.kinds.request.source)),
        events: m.catalog.commands.filter((c) => c.kinds.event).map((c) => c.id),
        sessions: new Map(m.sessions.map((s) => [s.name, s])), ready: true
      })
      bus.emit('init')
      if (!m.settings.setupDone && !isWizardOpen()) openWizard()
      break
    case 'session': state.sessions.set(m.session.name, m.session); bus.emit('session'); break
    case 'sessionRemoved': state.sessions.delete(m.name); bus.emit('sessionRemoved'); break
    case 'collections': state.collections = m.collections; bus.emit('collections'); break
    case 'scenarios': state.scenarios = m.list; bus.emit('scenarios', m); break
    case 'local': state.local = { ...state.local, status: m.status, managed: m.managed }; bus.emit('local'); break
    case 'devStatus': state.devStatus = m.status; bus.emit('devStatus'); break
    case 'msg':
      if (m.dir === 'out' && m.msg.messageId) state.requestsById.set(m.msg.messageId, m.msg.commandId)
      state.entries.push(m)
      if (state.entries.length > 3000) state.entries.shift()
      bus.emit('msgAdded', m)
      break
    case 'toast': toast(m.text, m.level); break
    default: bus.emit(m.op, m)
  }
}

initSessions(); initCollections(); initWorkbench(); initTimeline(); initScenarios(); initPlayerState(); initSettings(); initFooter()
showView(store.get('view', 'workbench'))
connectHelper(handle)
