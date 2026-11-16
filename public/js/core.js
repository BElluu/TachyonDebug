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
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()))
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }
export const prettyJson = (v) => JSON.stringify(v, null, 2)
