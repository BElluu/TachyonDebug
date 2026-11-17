// Scenarios page: list on the left, details + step timeline on the right, plus the editor.
import { $, el, state, bus, api, store, icon, prettyJson, debounce, initColResize } from './core.js'
import { modal, confirmDialog, toast } from './modal.js'
import { highlightJson } from './timeline.js'
import { exportScenario, pickJsonFile, parseImport } from './io.js'
import { handleImport } from './collections.js'
import { openNewSession } from './sessions.js'
import { editScenario } from './scenario-editor.js'
import { parseIssueUrl } from './issue.js'

let selected = store.get('scenarioSelected', null)
let filter = ''
let schemaMode = store.get('scenarioSchema', 'warn')   // off | warn | fail
let batch = null                                      // { running, done, total, results }
const live = new Map()                       // id -> { running, steps: [{status, ms, detail, response}], note }
const last = store.get('scenarioResults', {}) // id -> { ok, at, ms, steps: n, failedAt }

export const describeStep = (s) => {
  if (s.title) return s.title
  if (s.sleep) return `Wait ${s.sleep} ms`
  if (s.command) return `${s.as ?? '?'}: ${s.command}`
  if (s.waitFor) return `${s.as ?? '?'} waits for ${s.waitFor}`
  if (s.expectNo) return `${s.as ?? '?'} must not receive ${s.expectNo}`
  if (s.drain) return `Forget received events (${s.as ?? 'everyone'})`
  if (s.raw !== undefined) return `${s.as ?? '?'} sends a raw frame`
  if (s.disconnect) return `${s.as ?? '?'} loses the connection (${s.disconnect})`
  if (s.reconnect) return `${s.as ?? '?'} reconnects`
  return 'Step'
}
const kindOf = (s) => (s.sleep ? 'sleep' : s.command ? 'request' : s.waitFor ? 'wait' : s.expectNo ? 'none' : s.drain ? 'drain' : s.raw !== undefined ? 'raw' : s.disconnect ? 'drop' : s.reconnect ? 'reconnect' : 'other')
const compact = (v) => { const t = JSON.stringify(v); return t.length > 110 ? t.slice(0, 107) + '…' : t }
// Who plays which role. A scenario is written for roles (player1, player2); each role is played by one of your sessions.
// Unless you picked someone, a role is played by the session of the same name when there is one.
const roleStore = store.get('scenarioRoles', {})
function assignment(sc) {
  const saved = roleStore[sc.id] ?? {}
  return Object.fromEntries(sc.sessions.map((r) => {
    const v = saved[r]
    return [r, v === undefined ? (state.sessions.has(r) ? r : null) : v && state.sessions.has(v) ? v : null]
  }))
}
const isAssigned = (sc) => { const v = Object.values(assignment(sc)); return v.length > 0 && v.every(Boolean) && new Set(v).size === v.length }
const setRole = (sc, role, name) => { (roleStore[sc.id] ??= {})[role] = name; store.set('scenarioRoles', roleStore) }
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
  const order = ['Party', 'Matchmaking', 'Friends', 'Messaging', 'User', 'System', 'Robustness', 'Connection', 'Custom']
  const cats = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 100 * (order.indexOf(a) < 0)) - (order.indexOf(b) + 100 * (order.indexOf(b) < 0)) || a.localeCompare(b))
  for (const cat of cats) {
    box.append(el('div', { class: 'grp grp-row' }, el('span', {}, cat),
      el('button', { class: 'icon', title: `run all ${cat} scenarios`, disabled: !!batch?.running, onclick: () => runMany(groups.get(cat)) }, icon('play'))))
    for (const sc of groups.get(cat)) {
      const r = live.get(sc.id)?.running ? 'running' : last[sc.id] ? (last[sc.id].ok ? 'pass' : 'fail') : 'none'
      box.append(el('div', { class: `scn-row ${sc.id === selected ? 'sel' : ''}`, title: `${sc.name}\n${sc.sessions.length} player${sc.sessions.length === 1 ? '' : 's'} · ${sc.steps.length} steps${sc.description ? '\n\n' + sc.description.replace(/\s*Based on:.*$/s, '') : ''}`, onclick: () => select(sc.id) },
        el('span', { class: `scn-state ${r}`, title: { running: 'running', pass: 'passed last time', fail: 'failed last time', none: 'not run yet' }[r] }, r === 'pass' ? icon('check') : r === 'fail' ? icon('x') : r === 'running' ? el('span', { class: 'spinner' }) : icon('minus')),
        el('span', { class: 'scn-main' }, el('span', { class: 'scn-name' }, sc.name),
          el('span', { class: 'scn-sub' }, `${sc.sessions.length} player${sc.sessions.length === 1 ? '' : 's'} · ${sc.steps.length} steps`)),
        !isAssigned(sc) ? el('span', { class: 'tagpill dim', title: 'pick who plays each role' }, 'no players') : null,
        sc.source === 'user' ? el('span', { class: 'tagpill', title: 'only on this machine (data/scenarios/, not in git)' }, 'local') : null))
    }
  }
}

// ---- running several ------------------------------------------------------------------------
function runMany(all) {
  if (!all.length || batch?.running) return
  // scenarios nobody is assigned to are left out
  const list = all.filter(isAssigned)
  const skipped = all.length - list.length
  if (!list.length) return toast(`None of these ${all.length} scenarios has players assigned yet. Open one and pick who plays each role.`, 'error', 7000)
  if (skipped) toast(`Skipping ${skipped} scenario${skipped > 1 ? 's' : ''} without assigned players`, 'info', 5000)
  const repeat = Math.max(1, Number($('#scnRepeat')?.value) || 1)
  for (const sc of list) live.set(sc.id, { running: false, steps: [] })
  batch = { running: true, done: 0, total: list.length * repeat, results: [], skipped }
  renderBatch(); renderList()
  api.call({ op: 'runScenarios', ids: list.map((x) => x.id), roles: Object.fromEntries(list.map((x) => [x.id, assignment(x)])), schema: schemaMode, repeat, stopOnFail: !!$('#scnStop')?.checked })
}

function renderBatch() {
  const box = $('#scnBatch')
  if (!box) return
  box.replaceChildren()
  if (!batch) return
  if (batch.running) {
    box.append(el('div', { class: 'summary running' }, el('span', { class: 'spinner' }), ` Running ${batch.done} / ${batch.total}…`))
    return
  }
  const failed = batch.results.filter((r) => !r.ok)
  box.append(el('div', { class: `summary ${failed.length ? 'fail' : 'pass'}` }, icon(failed.length ? 'x' : 'check'),
    ` ${batch.results.length - failed.length} passed, ${failed.length} failed · ${((batch.ms ?? 0) / 1000).toFixed(1)} s${batch.skipped ? ` · ${batch.skipped} skipped (no players)` : ''}`),
  ...failed.map((r) => el('div', { class: 'batch-fail', onclick: () => select(r.id) }, el('b', {}, r.name), el('span', { class: 'muted' }, r.detail ?? ''))),
  failed.length ? el('button', { class: 'small', onclick: () => runMany(state.scenarios.filter((x) => failed.some((f) => f.id === x.id))) }, 'Re-run failed') : null,
  el('button', { class: 'small ghost', onclick: () => { batch = null; renderBatch() } }, 'Dismiss'))
}

function onBatch(m) {
  if (m.status === 'start') batch = { running: true, done: 0, total: m.total, results: [], skipped: batch?.skipped }
  else if (m.status === 'progress' && batch) { batch.done = m.done; batch.total = m.total; batch.results.push(m.last) }
  else if (m.status === 'done') {
    batch = { ...(batch ?? {}), running: false, results: m.results, ms: m.ms }
    toast(`${m.passed} passed, ${m.failed} failed`, m.failed ? 'error' : 'ok', 6000)
  }
  renderBatch(); renderList(); renderDetail()
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
  const assign = assignment(sc)
  const assigned = isAssigned(sc)
  const missing = Object.values(assign).filter((n) => n && state.sessions.get(n)?.state !== 'open')

  box.append(
    el('div', { class: 'scn-head' },
      el('div', { class: 'scn-titles' },
        el('div', { class: 'row tight' }, el('span', { class: 'cat-pill' }, sc.category), sc.source === 'user' ? el('span', { class: 'tagpill', title: 'only on this machine (data/scenarios/, not in git)' }, 'local only') : el('span', { class: 'tagpill dim', title: `scenarios/${sc.file}: a plain file in the project, commit it to share it` }, 'in repo'),
          issueLink(sc.issue)),
        el('h1', {}, sc.name),
        el('p', { class: 'lead sm' }, text),
        origin && !sc.issue ? el('p', { class: 'muted origin' }, 'Derived from ', el('code', {}, origin)) : null),
      el('div', { class: 'scn-actions' },
        el('button', { class: 'primary big', disabled: !!run?.running || sc.broken || !assigned || missing.length > 0, title: !assigned ? 'pick a player for every role first' : missing.length ? 'connect the players first' : '', onclick: () => start(sc) },
          run?.running ? [el('span', { class: 'spinner' }), ' Running…'] : [icon('play'), ' Run']),
        el('div', { class: 'row tight' },
          el('button', { class: 'small', onclick: () => editScenario(sc) }, icon('edit'), ' Edit'),
          el('button', { class: 'small', title: 'make an editable copy', onclick: () => editScenario({ ...structuredClone(sc), id: null, name: `${sc.name} (copy)` }) }, icon('copy'), ' Duplicate'),
          el('button', { class: 'small', onclick: () => exportScenario(sc) }, icon('download'), ' Export'),
          el('button', { class: 'small danger-text', title: 'delete the file', onclick: async () => {
            const where = sc.source === 'user' ? `data/scenarios/${sc.file}` : `scenarios/${sc.file}`
            if (await confirmDialog(`Delete the scenario “${sc.name}”?\nThis removes the file ${where}.`, { ok: 'Delete', danger: true })) api.call({ op: 'scenarioDelete', id: sc.id })
          } }, icon('trash'))))),
    el('div', { class: 'players-row' }, el('span', { class: 'label' }, 'Players'),
      ...sc.sessions.map((role) => {
        const cur = assign[role]
        const sel = el('select', { class: `role-select ${cur ? '' : 'unset'}`, title: `who plays “${role}”`, onchange: (e) => { setRole(sc, role, e.target.value); renderList(); renderDetail() } },
          el('option', { value: '' }, 'choose a player…'),
          ...[...state.sessions.values()].map((x) => el('option', { value: x.name, selected: x.name === cur }, `${x.name}${x.env ? ` (${x.env})` : ''}${x.state === 'open' ? '' : ' · offline'}`)))
        return el('span', { class: 'role' }, el('span', { class: 'role-name' }, role), el('span', { class: 'muted' }, '→'), sel,
          cur ? el('span', { class: `dot ${state.sessions.get(cur)?.state === 'open' ? 'up' : 'down'}` }) : null)
      }),
      !state.sessions.size || missing.length ? el('button', { class: 'small', onclick: () => openNewSession() }, 'Add players…') : null,
      !assigned && state.sessions.size ? el('span', { class: 'muted' }, 'Pick a different player for every role.') : null,
      missing.length ? el('span', { class: 'muted' }, `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not connected`) : null),
    ...[summary(sc, run, prev)].filter(Boolean),
    el('ol', { class: 'timeline' }, sc.steps.map((s, i) => stepNode(s, i, run?.steps?.[i]))))
}

function issueLink(url) {
  const r = parseIssueUrl(url)
  if (!r) return null
  return el('a', { class: 'issue-link', href: r.url, target: '_blank', rel: 'noopener noreferrer', title: `${r.kind === 'link' ? 'Open' : `Open ${r.kind}`}: ${r.url}` }, r.label, el('span', { class: 'ext' }, '↗'))
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
  if (s.raw !== undefined) meta.push(el('span', { class: 'chipcode' }, 'raw ', compact(s.raw)))
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
      r?.schemaIssues?.length ? el('div', { class: 'step-err schema' }, 'Does not match the protocol schema:', ...r.schemaIssues.map((i) => el('div', {}, el('code', {}, i.path), ' ', i.message))) : null,
      r?.response ? el('details', { class: 'resp', open: status === 'failed' }, el('summary', {}, status === 'failed' ? 'what the server answered' : 'response'), el('pre', { class: 'json' }, highlightJson(prettyJson(r.response)))) : null))
}

function start(sc) {
  live.set(sc.id, { running: true, steps: [] })
  renderList(); renderDetail()
  api.call({ op: 'runScenario', id: sc.id, schema: schemaMode, roles: { [sc.id]: assignment(sc) } })
}

function onLog(m) {
  const run = live.get(m.scenario) ?? { steps: [] }
  if (m.step !== undefined) run.steps[m.step] = { status: m.status, ms: m.ms, detail: m.detail, response: m.response, schemaIssues: m.schemaIssues }
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
      el('div', { class: 'row tight' },
        el('button', { class: 'small grow', disabled: false, title: 'run every scenario one after the other', onclick: () => runMany(state.scenarios.filter((x) => !x.broken)) }, icon('play'), ' Run all'),
        el('label', { class: 'inline tiny', title: 'repeat the whole selection n times (finds races)' }, 'x', el('input', { id: 'scnRepeat', type: 'number', min: 1, max: 100, value: 1, class: 'num' })),
        el('label', { class: 'inline tiny', title: 'stop at the first failing scenario' }, el('input', { id: 'scnStop', type: 'checkbox' }), 'stop on fail')),
      el('div', { class: 'row tight' },
        el('label', { class: 'tiny muted', for: 'scnSchema' }, 'Protocol schema'),
        el('select', { id: 'scnSchema', class: 'grow', title: 'what to do when a response or event does not match the protocol schema',
          onchange: (e) => { schemaMode = e.target.value; store.set('scenarioSchema', schemaMode) } },
        el('option', { value: 'off' }, 'ignore'), el('option', { value: 'warn' }, 'warn'), el('option', { value: 'fail' }, 'fail the step'))),
      el('div', { id: 'scnBatch', class: 'scn-batch' }),
      search, el('div', { id: 'scnList', class: 'scn-list' }),
      el('div', { id: 'scnResize', class: 'col-resizer', title: 'drag to resize (double-click resets)' })),
    el('div', { id: 'scnDetail', class: 'scn-detail' })))

  initColResize($('#scnResize'), { varName: '--scn-side', key: 'scenarioListWidth', def: 320, max: 800 })
  const redraw = debounce(() => { renderList(); renderDetail() }, 30)
  for (const e of ['init', 'session', 'sessionRemoved']) bus.on(e, redraw)
  bus.on('scenarios', (m) => {
    if (m.saved) { selected = m.saved; store.set('scenarioSelected', selected) }
    if (!current()) selected = state.scenarios[0]?.id ?? null
    renderList(); renderDetail()
  })
  bus.on('init', () => { if (!current()) selected = state.scenarios[0]?.id ?? null })
  $('#scnSchema').value = schemaMode
  bus.on('scenarioLog', onLog)
  bus.on('scenarioBatch', onBatch)
}
