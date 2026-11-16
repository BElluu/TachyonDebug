// Scenarios page: list on the left, details + step timeline on the right, plus the editor.
import { $, el, state, bus, api, store, icon, prettyJson, debounce } from './core.js'
import { modal, confirmDialog, toast } from './modal.js'
import { highlightJson } from './timeline.js'
import { exportScenario, pickJsonFile, parseImport } from './io.js'
import { handleImport } from './collections.js'
import { openNewSession } from './sessions.js'
import { editScenario } from './scenario-editor.js'

let selected = store.get('scenarioSelected', null)
let filter = ''
const live = new Map()                       // id -> { running, steps: [{status, ms, detail, response}], note }
const last = store.get('scenarioResults', {}) // id -> { ok, at, ms, steps: n, failedAt }

export const describeStep = (s) => {
  if (s.title) return s.title
  if (s.sleep) return `Wait ${s.sleep} ms`
  if (s.command) return `${s.as ?? '?'}: ${s.command}`
  if (s.waitFor) return `${s.as ?? '?'} waits for ${s.waitFor}`
  if (s.expectNo) return `${s.as ?? '?'} must not receive ${s.expectNo}`
  if (s.drain) return `Forget received events (${s.as ?? 'everyone'})`
  return 'Step'
}
const kindOf = (s) => (s.sleep ? 'sleep' : s.command ? 'request' : s.waitFor ? 'wait' : s.expectNo ? 'none' : s.drain ? 'drain' : 'other')
const compact = (v) => { const t = JSON.stringify(v); return t.length > 110 ? t.slice(0, 107) + '…' : t }
const current = () => state.scenarios.find((s) => s.id === selected)

// "Based on: ..." is shown separately from the description
const splitDescription = (d) => { const m = d.match(/^(.*?)\s*Based on:\s*(.*?)\.?\s*$/s); return m ? { text: m[1].trim(), origin: m[2] } : { text: d, origin: null } }

// ---- list ---------------------------------------------------------------------------------
function renderList() {
  const box = $('#scnList')
  box.replaceChildren()
  const q = filter.toLowerCase()
  const groups = new Map()
  for (const sc of state.scenarios) {
    if (q && !`${sc.name} ${sc.category} ${sc.description}`.toLowerCase().includes(q)) continue
    if (!groups.has(sc.category)) groups.set(sc.category, [])
    groups.get(sc.category).push(sc)
  }
  if (!groups.size) box.append(el('div', { class: 'empty' }, state.scenarios.length ? 'No match' : 'No scenarios yet'))
  const order = ['Party', 'Matchmaking', 'Friends', 'Messaging', 'User', 'System', 'Custom']
  const cats = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 100 * (order.indexOf(a) < 0)) - (order.indexOf(b) + 100 * (order.indexOf(b) < 0)) || a.localeCompare(b))
  for (const cat of cats) {
    box.append(el('div', { class: 'grp' }, cat))
    for (const sc of groups.get(cat)) {
      const r = live.get(sc.id)?.running ? 'running' : last[sc.id] ? (last[sc.id].ok ? 'pass' : 'fail') : 'none'
      box.append(el('div', { class: `scn-row ${sc.id === selected ? 'sel' : ''}`, onclick: () => select(sc.id) },
        el('span', { class: `scn-state ${r}`, title: { running: 'running', pass: 'passed last time', fail: 'failed last time', none: 'not run yet' }[r] }, r === 'pass' ? icon('check') : r === 'fail' ? icon('x') : r === 'running' ? el('span', { class: 'spinner' }) : icon('minus')),
        el('span', { class: 'scn-main' }, el('span', { class: 'scn-name' }, sc.name),
          el('span', { class: 'scn-sub' }, `${sc.sessions.length} player${sc.sessions.length === 1 ? '' : 's'} · ${sc.steps.length} steps`)),
        sc.source === 'user' ? el('span', { class: 'tagpill' }, 'yours') : null))
    }
  }
}

function select(id) {
  selected = id
  store.set('scenarioSelected', id)
  renderList()
  renderDetail()
}

// ---- detail --------------------------------------------------------------------------------
function renderDetail() {
  const box = $('#scnDetail')
  box.replaceChildren()
  const sc = current()
  if (!sc) return void box.append(el('div', { class: 'empty-state' }, el('h2', {}, 'Pick a scenario'), el('p', { class: 'muted' }, 'A scenario drives several players through a flow and checks what the server answers.')))

  const run = live.get(sc.id)
  const prev = last[sc.id]
  const { text, origin } = splitDescription(sc.description)
  const missing = sc.sessions.filter((n) => state.sessions.get(n)?.state !== 'open')

  box.append(
    el('div', { class: 'scn-head' },
      el('div', { class: 'scn-titles' },
        el('div', { class: 'row tight' }, el('span', { class: 'cat-pill' }, sc.category), sc.source === 'user' ? el('span', { class: 'tagpill' }, 'yours') : el('span', { class: 'tagpill dim' }, 'built-in')),
        el('h1', {}, sc.name),
        el('p', { class: 'lead sm' }, text),
        origin ? el('p', { class: 'muted origin' }, 'Derived from ', el('code', {}, origin)) : null),
      el('div', { class: 'scn-actions' },
        el('button', { class: 'primary big', disabled: !!run?.running || sc.broken || missing.length > 0, title: missing.length ? 'connect the missing players first' : '', onclick: () => start(sc) },
          run?.running ? [el('span', { class: 'spinner' }), ' Running…'] : [icon('play'), ' Run']),
        el('div', { class: 'row tight' },
          sc.source === 'user'
            ? el('button', { class: 'small', onclick: () => editScenario(sc) }, icon('edit'), ' Edit')
            : el('button', { class: 'small', title: 'make an editable copy', onclick: () => editScenario({ ...structuredClone(sc), id: null, name: `${sc.name} (copy)`, category: 'Custom', source: 'user' }) }, icon('copy'), ' Duplicate'),
          el('button', { class: 'small', onclick: () => exportScenario(sc) }, icon('download'), ' Export'),
          sc.source === 'user' ? el('button', { class: 'small danger-text', onclick: async () => {
            if (await confirmDialog(`Delete the scenario “${sc.name}”?`, { ok: 'Delete', danger: true })) api.call({ op: 'scenarioDelete', id: sc.id })
          } }, icon('trash')) : null))),
    el('div', { class: 'players-row' }, el('span', { class: 'label' }, 'PLAYERS'),
      ...sc.sessions.map((n) => el('span', { class: `player-pill ${state.sessions.get(n)?.state === 'open' ? 'ok' : 'miss'}` }, el('span', { class: `dot ${state.sessions.get(n)?.state === 'open' ? 'up' : 'down'}` }), n)),
      missing.length ? el('button', { class: 'small', onclick: () => openNewSession() }, 'Add players…') : null,
      missing.length ? el('span', { class: 'muted' }, `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not connected`) : null),
    ...[summary(sc, run, prev)].filter(Boolean),
    el('ol', { class: 'timeline' }, sc.steps.map((s, i) => stepNode(s, i, run?.steps?.[i]))))
}

function summary(sc, run, prev) {
  if (run?.running) return el('div', { class: 'summary running' }, el('span', { class: 'spinner' }), ` Running… step ${(run.steps.findLastIndex?.((x) => x) ?? run.steps.length - 1) + 1} of ${sc.steps.length}`)
  if (run?.final) {
    const ok = run.final === 'done'
    const failedAt = run.steps.findIndex((s) => s?.status === 'failed')
    const total = run.steps.reduce((t, s) => t + (s?.ms ?? 0), 0)
    return el('div', { class: `summary ${ok ? 'pass' : 'fail'}` }, icon(ok ? 'check' : 'x'),
      ok ? ` Passed · ${sc.steps.length} steps in ${(total / 1000).toFixed(1)} s` : ` Failed ${failedAt >= 0 ? `at step ${failedAt + 1}` : 'before it started'}${run.note ? ': ' + run.note : ''}`)
  }
  if (prev) return el('div', { class: `summary muted-sum ${prev.ok ? 'pass' : 'fail'}` }, `Last run ${new Date(prev.at).toLocaleString()}: ${prev.ok ? 'passed' : `failed at step ${prev.failedAt + 1}`}`)
  return null
}

function stepNode(s, i, r) {
  const status = r?.status ?? 'pending'
  const meta = []
  if (s.command) meta.push(el('code', {}, `${s.as} → ${s.command}`))
  if (s.waitFor) meta.push(el('code', {}, `${s.as} ← ${s.waitFor}`))
  if (s.expectNo) meta.push(el('code', {}, `${s.as} ✗ ${s.expectNo}`))
  if (s.data !== undefined) meta.push(el('span', { class: 'chipcode' }, 'data ', compact(s.data)))
  if (s.expect !== undefined) meta.push(el('span', { class: 'chipcode expect' }, 'expects ', compact(s.expect)))
  if (s.capture) meta.push(el('span', { class: 'chipcode' }, 'captures ', Object.keys(s.capture).join(', ')))
  if (s.optional) meta.push(el('span', { class: 'tagpill dim' }, 'optional'))
  return el('li', { class: `step ${status} k-${kindOf(s)}` },
    el('span', { class: 'node' }, status === 'ok' ? icon('check') : status === 'failed' ? icon('x') : status === 'running' ? el('span', { class: 'spinner' }) : status === 'skipped' ? icon('minus') : String(i + 1)),
    el('div', { class: 'step-body' },
      el('div', { class: 'step-title' }, describeStep(s), r?.ms != null && status !== 'running' ? el('span', { class: 'ms' }, `${r.ms} ms`) : null),
      meta.length ? el('div', { class: 'step-meta' }, meta) : null,
      s.note ? el('div', { class: 'step-note' }, s.note) : null,
      r?.detail ? el('div', { class: `step-err ${status === 'skipped' ? 'soft' : ''}` }, status === 'skipped' ? `skipped: ${r.detail}` : r.detail) : null,
      r?.response ? el('details', { class: 'resp' }, el('summary', {}, 'response'), el('pre', { class: 'json' }, highlightJson(prettyJson(r.response)))) : null))
}

function start(sc) {
  live.set(sc.id, { running: true, steps: [] })
  renderList(); renderDetail()
  api.call({ op: 'runScenario', id: sc.id })
}

function onLog(m) {
  const run = live.get(m.scenario) ?? { steps: [] }
  if (m.step !== undefined) run.steps[m.step] = { status: m.status, ms: m.ms, detail: m.detail, response: m.response }
  if (['done', 'aborted'].includes(m.status)) {
    run.running = false
    run.final = m.status
    run.note = m.detail
    const failedAt = run.steps.findIndex((s) => s?.status === 'failed')
    last[m.scenario] = { ok: m.status === 'done', at: Date.now(), failedAt }
    store.set('scenarioResults', last)
  } else if (m.status === 'start') {
    run.running = true
  }
  live.set(m.scenario, run)
  if (m.step === undefined) renderList()
  if (m.scenario === selected) renderDetail()
}

// ---- init ----------------------------------------------------------------------------------
export function initScenarios() {
  const root = $('#view-scenarios')
  const search = el('input', { placeholder: 'Search scenarios…', spellcheck: false, oninput: (e) => { filter = e.target.value.trim(); renderList() } })
  root.append(el('div', { class: 'scn' },
    el('aside', { class: 'scn-side' },
      el('div', { class: 'row tight' },
        el('button', { class: 'primary small grow', onclick: () => editScenario(null) }, icon('plus'), ' New scenario'),
        el('button', { class: 'small', title: 'import scenarios from a .json file', onclick: async () => {
          const f = await pickJsonFile()
          if (!f) return
          if (f.error) return toast(`${f.name}: ${f.error}`, 'error', 8000)
          try { const p = parseImport(f.data); if (!p.scenarios.length) throw new Error('this file has no scenarios'); handleImport(f) } catch (e) { toast(`${f.name}: ${e.message}`, 'error', 8000) }
        } }, icon('upload'), ' Import')),
      search, el('div', { id: 'scnList', class: 'scn-list' })),
    el('div', { id: 'scnDetail', class: 'scn-detail' })))

  const redraw = debounce(() => { renderList(); renderDetail() }, 30)
  for (const e of ['init', 'session', 'sessionRemoved']) bus.on(e, redraw)
  bus.on('scenarios', (m) => {
    if (m.saved) { selected = m.saved; store.set('scenarioSelected', selected) }
    if (!current()) selected = state.scenarios[0]?.id ?? null
    renderList(); renderDetail()
  })
  bus.on('init', () => { if (!current()) selected = state.scenarios[0]?.id ?? null })
  bus.on('scenarioLog', onLog)
}
