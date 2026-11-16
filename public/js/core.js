// Shared helpers, state, event bus and the websocket link to the local helper process.
export const $ = (sel, root = document) => root.querySelector(sel)

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') n.className = v
    else if (k === 'style' && typeof v === 'string') n.style.cssText = v
    else if (k === 'dataset') Object.assign(n.dataset, v)
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'list') n.setAttribute('list', v) // read-only property on <input>
    else if (k in n) n[k] = v
    else n.setAttribute(k, v)
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid)
  return n
}

export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode etc. */ } }
}

export const state = {
  settings: {}, checks: {}, envs: {}, catalog: [], collections: [],
  sessions: new Map(), local: { status: 'unknown', managed: false, logs: [] }, devStatus: 'unknown',
  scenarios: [], entries: [], requestsById: new Map(), helperUp: false, ready: false
}

// tiny pub/sub: views subscribe to server ops and to their own UI events
const listeners = new Map()
export const bus = {
  on(evt, fn) { (listeners.get(evt) ?? listeners.set(evt, new Set()).get(evt)).add(fn) },
  emit(evt, data) { listeners.get(evt)?.forEach((fn) => fn(data)) }
}

// ---- helper link ------------------------------------------------------------------
let ws
let nextReq = 1
const pending = new Map()

export const api = {
  call(payload) { if (ws?.readyState === 1) ws.send(JSON.stringify(payload)) },
  request(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const reqId = nextReq++
      const t = setTimeout(() => { pending.delete(reqId); reject(new Error('timeout')) }, timeoutMs)
      pending.set(reqId, (m) => { clearTimeout(t); resolve(m) })
      this.call({ reqId, ...payload })
    })
  }
}

export function connectHelper(onMessage) {
  ws = new WebSocket(`ws://${location.host}/ui`)
  ws.onopen = () => { state.helperUp = true; bus.emit('helper', true) }
  ws.onclose = () => { state.helperUp = false; bus.emit('helper', false); setTimeout(() => connectHelper(onMessage), 1000) }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.reqId && pending.has(m.reqId)) { pending.get(m.reqId)(m); pending.delete(m.reqId) }
    onMessage(m)
  }
}

// ---- misc ---------------------------------------------------------------------------
export function colorFor(name) {
  let h = 0
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360
  return `hsl(${h} 70% 62%)`
}
export const hhmmss = (ts) => new Date(ts).toISOString().slice(11, 23)
export const groupOf = (commandId) => String(commandId ?? '').split('/')[0] || '?'
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }
export const prettyJson = (v) => JSON.stringify(v, null, 2)

// ---- icons (feather-style, inline SVG so they do not depend on installed fonts) -------------
const ICONS = {
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  up: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  down: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>'
}
export function icon(name) {
  const span = document.createElement('span')
  span.className = 'ico'
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`
  return span
}
