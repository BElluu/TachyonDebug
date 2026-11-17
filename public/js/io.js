// Export / import of requests, collections and scenarios as plain JSON files.
import { uid } from './core.js'

const APP = 'TachyonDebug'
const VERSION = 1

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'export'

export function download(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export const wrap = (type, body) => ({ app: APP, version: VERSION, type, ...body })

// strip internal ids so an exported file is stable and diff-friendly
const cleanRequest = (r) => ({ name: r.name, commandId: r.commandId, ...(r.as ? { as: r.as } : {}), ...(r.data !== undefined ? { data: r.data } : {}) })

export const exportRequest = (req, collName) => download(`${slug(req.name)}.request.json`, wrap('requests', { from: collName, requests: [cleanRequest(req)] }))
export const exportCollections = (cols, name) =>
  download(`${slug(name)}.collection.json`, wrap('collections', { collections: cols.map((c) => ({ name: c.name, requests: c.requests.map(cleanRequest) })) }))
export const exportScenario = (sc) =>
  download(`${slug(sc.name)}.scenario.json`, wrap('scenarios', { scenarios: [{ name: sc.name, category: sc.category, description: sc.description, ...(sc.issue ? { issue: sc.issue } : {}), sessions: sc.sessions, steps: sc.steps }] }))

export function pickJsonFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try { resolve({ name: file.name, data: JSON.parse(await file.text()) }) } catch (e) { resolve({ name: file.name, error: `not valid JSON (${e.message})` }) }
    }
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

export async function readDroppedFile(file) {
  try { return { name: file.name, data: JSON.parse(await file.text()) } } catch (e) { return { name: file.name, error: `not valid JSON (${e.message})` } }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function normRequest(r) {
  if (!isObj(r) || typeof r.commandId !== 'string' || !r.commandId.trim()) throw new Error('a request is missing its commandId')
  return { id: uid(), name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.commandId, as: typeof r.as === 'string' ? r.as : null, commandId: r.commandId.trim(), data: r.data }
}

function normScenario(s) {
  if (!isObj(s) || typeof s.name !== 'string' || !Array.isArray(s.steps)) throw new Error('a scenario needs a name and a list of steps')
  return { name: s.name, category: s.category || 'Custom', description: s.description ?? '', ...(typeof s.issue === 'string' && s.issue ? { issue: s.issue } : {}), sessions: Array.isArray(s.sessions) ? s.sessions : [], steps: s.steps }
}

// Turns any supported file into { collections, scenarios } (fresh ids), or throws a readable error.
export function parseImport(data) {
  const out = { collections: [], scenarios: [] }
  const addCollection = (c) => {
    if (!isObj(c) || !Array.isArray(c.requests)) throw new Error('a collection needs a list of requests')
    out.collections.push({ name: String(c.name ?? 'Imported'), requests: c.requests.map(normRequest) })
  }
  if (Array.isArray(data)) {
    out.collections.push({ name: 'Imported', requests: data.map(normRequest) })
  } else if (isObj(data)) {
    if (data.app && data.app !== APP) throw new Error(`this file was made by "${data.app}", not ${APP}`)
    if (Array.isArray(data.collections)) data.collections.forEach(addCollection)
    if (Array.isArray(data.requests)) out.collections.push({ name: String(data.from ?? 'Imported'), requests: data.requests.map(normRequest) })
    if (Array.isArray(data.scenarios)) out.scenarios.push(...data.scenarios.map(normScenario))
    if (data.scenario) out.scenarios.push(normScenario(data.scenario))
    if (!out.collections.length && !out.scenarios.length && Array.isArray(data.steps)) out.scenarios.push(normScenario(data))
  }
  if (!out.collections.length && !out.scenarios.length) throw new Error('nothing to import: expected collections, requests or scenarios')
  return out
}
