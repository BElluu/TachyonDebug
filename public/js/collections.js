// Sidebar: Postman-like collections tree + request history.
import { $, el, state, bus, api, store, uid, groupOf, colorFor, icon, initColResize } from './core.js'
import { modal, confirmDialog, promptDialog, toast } from './modal.js'
import { exportRequest, exportCollections, pickJsonFile, readDroppedFile, parseImport } from './io.js'
import { openRequest, openDraft, runSaved } from './workbench.js'

let filter = ''
let view = store.get('sidebarView', 'collections')
const collapsed = new Set(store.get('collapsed', []))

export function persistCollections() {
  api.call({ op: 'collectionsSet', collections: state.collections })
  bus.emit('collections')
}

export function findRequest(id) {
  for (const coll of state.collections) {
    const req = coll.requests.find((r) => r.id === id)
    if (req) return { req, coll }
  }
  return null
}

// Ask for a name and a collection, then store (or update) the request. Resolves to the saved request or null.
export function saveDialog({ name = '', commandId, data, as = null, existingId = null, collId = null }) {
  return new Promise((resolve) => {
    if (existingId) {
      const f = findRequest(existingId)
      if (f) {
        Object.assign(f.req, { commandId, data, as })
        persistCollections()
        return resolve(f.req)
      }
    }
    const nameInput = el('input', { value: name || commandId, spellcheck: false })
    const sel = el('select', {}, ...state.collections.map((c) => el('option', { value: c.id }, c.name)), el('option', { value: '__new' }, '+ New collection…'))
    sel.value = collId && state.collections.some((c) => c.id === collId) ? collId : state.collections[0]?.id ?? '__new'
    const newName = el('input', { placeholder: 'collection name', class: sel.value === '__new' ? '' : 'hidden', spellcheck: false })
    sel.onchange = () => newName.classList.toggle('hidden', sel.value !== '__new')
    const bind = el('input', { type: 'checkbox', checked: !!as })
    const save = () => {
      const n = nameInput.value.trim()
      if (!n) return nameInput.focus()
      let coll = state.collections.find((c) => c.id === sel.value)
      if (!coll) {
        coll = { id: uid(), name: newName.value.trim() || 'My requests', requests: [] }
        state.collections.push(coll)
      }
      const req = { id: uid(), name: n, as: bind.checked ? as : null, commandId, data }
      coll.requests.push(req)
      collapsed.delete(coll.id)
      persistCollections()
      m.close(); resolve(req)
    }
    const m = modal({
      title: 'Save request', onClose: () => resolve(null),
      body: [el('label', {}, 'Name'), nameInput, el('label', {}, 'Collection'), sel, newName,
        as ? el('label', { class: 'inline' }, bind, ` always send as ${as}`) : null],
      actions: [el('button', { onclick: () => m.close() }, 'Cancel'), el('button', { class: 'primary', onclick: save }, 'Save')]
    })
    setTimeout(() => { nameInput.focus(); nameInput.select() }, 30)
  })
}

export function initCollections() {
  for (const e of ['init', 'collections', 'history']) bus.on(e, render)
  $('#sbSearch').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render() }
  $('#newColl').onclick = async () => {
    const name = await promptDialog('New collection', 'Name', '')
    if (!name) return
    state.collections.push({ id: uid(), name, requests: [] })
    persistCollections()
  }
  initColResize($('#sbResize'), { varName: '--wb-side', key: 'sidebarWidth', def: 290 })
  $('#fromProto').append(icon('refresh'))
  $('#fromProto').onclick = () => syncFromProtocol({ force: true })
  bus.on('init', () => syncFromProtocol())
  $('#newReq').onclick = () => openDraft({})
  $('#impBtn').onclick = async () => handleImport(await pickJsonFile())
  $('#expAll').onclick = () => state.collections.length ? exportCollections(state.collections, 'all-collections') : toast('Nothing to export yet', 'info')
  // dropping a .json file on the sidebar imports it
  const side = $('.sidebar')
  side.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); side.classList.add('filedrop') } })
  side.addEventListener('dragleave', (e) => { if (e.target === side) side.classList.remove('filedrop') })
  side.addEventListener('drop', async (e) => {
    side.classList.remove('filedrop')
    const f = e.dataTransfer?.files?.[0]
    if (f) { e.preventDefault(); handleImport(await readDroppedFile(f)) }
  })
  for (const b of document.querySelectorAll('#sbTabs button')) {
    b.onclick = () => { view = b.dataset.view; store.set('sidebarView', view); render() }
  }
}

// One collection per protocol group, one request (with a template body) per command.
// Runs by itself whenever the protocol is loaded and adds commands it has not offered before, so requests you
// deleted stay deleted. The refresh button (force) also brings those back.
function syncFromProtocol({ force = false } = {}) {
  if (!state.catalog.length) return force ? toast('No protocol loaded. Check Settings → Locations.', 'error') : undefined
  const seen = new Set(store.get('offeredCommands', []))
  const have = new Set(state.collections.flatMap((c) => c.requests.map((r) => r.commandId)))
  const nice = (n) => { const w = n.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); return w[0].toUpperCase() + w.slice(1) }
  let added = 0
  for (const c of state.catalog) {
    if (have.has(c.id) || (!force && seen.has(c.id))) continue
    const title = c.group[0].toUpperCase() + c.group.slice(1)
    let coll = state.collections.find((x) => x.name.toLowerCase() === c.group)
    if (!coll) state.collections.push((coll = { id: uid(), name: title, requests: [] }))
    coll.requests.push({ id: uid(), name: nice(c.name), as: null, commandId: c.id, data: c.kinds.request.template })
    added++
  }
  store.set('offeredCommands', state.catalog.map((c) => c.id))
  if (added) persistCollections()
  if (force) toast(added ? `Added ${added} request${added > 1 ? 's' : ''} from the protocol` : `All ${state.catalog.length} protocol commands are already in your collections`, added ? 'ok' : 'info')
}

function badge(commandId) {
  const g = groupOf(commandId)
  return el('span', { class: 'cmd-badge', style: `--c:${colorFor(g)}` }, g)
}

function render() {
  for (const b of document.querySelectorAll('#sbTabs button')) b.classList.toggle('active', b.dataset.view === view)
  $('#sbTools').classList.toggle('hidden', view !== 'collections')
  $('#sbIo').classList.toggle('hidden', view !== 'collections')
  const box = $('#tree')
  box.replaceChildren()
  if (view === 'history') return renderHistory(box)

  if (!state.collections.length) box.append(el('div', { class: 'empty' }, 'No collections yet. Press “+ Collection”, or save a request from the builder.'))
  for (const coll of state.collections) {
    const reqs = coll.requests.filter((r) => !filter || `${r.name} ${r.commandId}`.toLowerCase().includes(filter))
    if (filter && !reqs.length) continue
    const open = filter || !collapsed.has(coll.id)
    const head = el('div', { class: 'coll-head', dataset: { id: coll.id },
      onclick: () => { collapsed.has(coll.id) ? collapsed.delete(coll.id) : collapsed.add(coll.id); store.set('collapsed', [...collapsed]); render() },
      ondragover: (e) => { e.preventDefault(); head.classList.add('drop') },
      ondragleave: () => head.classList.remove('drop'),
      ondrop: (e) => { e.preventDefault(); moveRequest(e.dataTransfer.getData('text/plain'), coll.id) } },
      el('span', { class: `chev ${open ? 'open' : ''}` }, '▸'),
      el('span', { class: 'coll-name' }, coll.name),
      el('span', { class: 'count' }, String(coll.requests.length)),
      el('span', { class: 'row-actions' },
        el('button', { class: 'icon', title: 'new request here', onclick: (e) => { e.stopPropagation(); openDraft({ collId: coll.id }) } }, icon('plus')),
        el('button', { class: 'icon', title: 'export this collection', onclick: (e) => { e.stopPropagation(); exportCollections([coll], coll.name) } }, icon('download')),
        el('button', { class: 'icon', title: 'rename', onclick: async (e) => {
          e.stopPropagation()
          const n = await promptDialog('Rename collection', 'Name', coll.name)
          if (n) { coll.name = n; persistCollections() }
        } }, icon('edit')),
        el('button', { class: 'icon', title: 'delete collection', onclick: async (e) => {
          e.stopPropagation()
          if (await confirmDialog(`Delete collection “${coll.name}” and its ${coll.requests.length} request(s)?`, { ok: 'Delete', danger: true })) {
            state.collections = state.collections.filter((c) => c.id !== coll.id)
            persistCollections()
          }
        } }, icon('trash'))))
    box.append(head)
    if (open) for (const r of reqs) box.append(requestRow(r, coll))
  }
}

function requestRow(r, coll) {
  const gone = r.as && !state.sessions.has(r.as)
  return el('div', { class: 'req-row', draggable: true, title: `${r.name}\n${r.commandId}${r.as ? ' · as ' + r.as : ''}\n\n${JSON.stringify(r.data ?? null)}`,
    ondragstart: (e) => e.dataTransfer.setData('text/plain', r.id),
    onclick: () => openRequest(r.id) },
    badge(r.commandId),
    el('span', { class: 'req-main' },
      el('span', { class: 'req-name' }, r.name),
      el('span', { class: 'req-sub' }, `${r.commandId}${r.as ? ' · as ' + r.as : ''}${gone ? ' (offline)' : ''}`)),
    el('span', { class: 'row-actions' },
      el('button', { class: 'icon run', title: r.as ? `send as ${r.as}` : 'send as the active player', onclick: (e) => { e.stopPropagation(); runSaved(r) } }, icon('play')),
      el('button', { class: 'icon', title: 'export this request', onclick: (e) => { e.stopPropagation(); exportRequest(r, coll.name) } }, icon('download')),
      el('button', { class: 'icon', title: 'duplicate', onclick: (e) => {
        e.stopPropagation()
        coll.requests.splice(coll.requests.indexOf(r) + 1, 0, { ...structuredClone(r), id: uid(), name: `${r.name} copy` })
        persistCollections()
      } }, icon('copy')),
      el('button', { class: 'icon', title: 'rename', onclick: async (e) => {
        e.stopPropagation()
        const n = await promptDialog('Rename request', 'Name', r.name)
        if (n) { r.name = n; persistCollections() }
      } }, icon('edit')),
      el('button', { class: 'icon', title: 'delete', onclick: (e) => {
        e.stopPropagation()
        coll.requests = coll.requests.filter((x) => x.id !== r.id)
        persistCollections()
      } }, icon('trash'))))
}

function moveRequest(id, toCollId) {
  const f = findRequest(id)
  const to = state.collections.find((c) => c.id === toCollId)
  if (!f || !to || f.coll === to) return render()
  f.coll.requests = f.coll.requests.filter((r) => r.id !== id)
  to.requests.push(f.req)
  collapsed.delete(to.id)
  persistCollections()
}

function renderHistory(box) {
  const hist = store.get('history', [])
  if (!hist.length) box.append(el('div', { class: 'empty' }, 'Sent requests show up here.'))
  for (const h of hist.filter((h) => !filter || `${h.commandId} ${h.as}`.toLowerCase().includes(filter))) {
    box.append(el('div', { class: 'req-row', onclick: () => openDraft({ as: h.as, commandId: h.commandId, data: h.data }) },
      badge(h.commandId),
      el('span', { class: 'req-main' },
        el('span', { class: 'req-name' }, h.commandId),
        el('span', { class: 'req-sub' }, `${h.as} · ${h.data ? JSON.stringify(h.data) : 'no data'}`))))
  }
}

// ---- import ------------------------------------------------------------------------------
// Adds what a parsed file contains: collections (renamed on clashes) and scenarios (saved as your own).
export function importParsed(parsed) {
  const taken = new Set(state.collections.map((c) => c.name))
  let reqs = 0
  for (const c of parsed.collections) {
    let name = c.name
    for (let n = 2; taken.has(name); n++) name = `${c.name} (${n})`
    taken.add(name)
    state.collections.push({ id: uid(), name, requests: c.requests })
    reqs += c.requests.length
  }
  if (parsed.collections.length) persistCollections()
  for (const sc of parsed.scenarios) api.call({ op: 'scenarioSave', scenario: sc })
  const parts = []
  if (parsed.collections.length) parts.push(`${parsed.collections.length} collection${parsed.collections.length > 1 ? 's' : ''} (${reqs} request${reqs === 1 ? '' : 's'})`)
  if (parsed.scenarios.length) parts.push(`${parsed.scenarios.length} scenario${parsed.scenarios.length > 1 ? 's' : ''}`)
  toast(`Imported ${parts.join(' and ')}`, 'ok')
}

export function handleImport(file) {
  if (!file) return
  if (file.error) return toast(`${file.name}: ${file.error}`, 'error', 8000)
  try { importParsed(parseImport(file.data)) } catch (e) { toast(`${file.name}: ${e.message}`, 'error', 8000) }
}
