// Dialog to create and edit your own scenarios (visual step editor + raw JSON).
import { el, state, api, icon, prettyJson } from './core.js'
import { modal, toast } from './modal.js'
import { parseIssueUrl } from './issue.js'

const KINDS = [
  ['request', 'Send a request'],
  ['wait', 'Wait for an event'],
  ['none', 'Expect NO event'],
  ['drain', 'Forget received events'],
  ['sleep', 'Wait (sleep)'],
  ['raw', 'Send a raw frame (bad input test)'],
  ['disconnect', 'Drop the connection'],
  ['reconnect', 'Reconnect']
]
const kindOf = (s) => (s.sleep != null ? 'sleep' : s.command != null ? 'request' : s.waitFor != null ? 'wait' : s.expectNo != null ? 'none' : s.raw !== undefined ? 'raw' : s.disconnect ? 'disconnect' : s.reconnect ? 'reconnect' : 'drain')

function blank(kind, as) {
  switch (kind) {
    case 'request': return { as, command: '', expect: { status: 'success' } }
    case 'wait': return { as, waitFor: '' }
    case 'none': return { as, expectNo: '', within: 500 }
    case 'sleep': return { sleep: 500 }
    case 'raw': return { as, raw: '{not json', waitReply: true }
    case 'disconnect': return { as, disconnect: 'terminate' }
    case 'reconnect': return { as, reconnect: true }
    default: return { drain: 'all' }
  }
}

export function editScenario(sc) {
  const isNew = !sc
  const model = structuredClone(sc ? { name: sc.name, category: sc.category, description: sc.description, issue: sc.issue ?? '', sessions: sc.sessions ?? [], steps: sc.steps } : { name: '', category: 'Custom', description: '', issue: '', sessions: [], steps: [] })
  const editingId = sc?.id ?? null
  let target = sc?.source === 'user' ? 'local' : 'project' // where the file goes
  let mode = 'steps'
  const bad = new Set() // keys of fields holding invalid JSON

  const stepsBox = el('div', { class: 'ed-steps' })
  const jsonBox = el('textarea', { class: 'ed-json hidden', spellcheck: false })
  const tabs = el('div', { class: 'seg left' })

  const datalist = (id, values) => el('datalist', { id }, values.map((v) => el('option', { value: v })))
  const players = () => [...new Set([...state.sessions.keys(), 'player1', 'player2', 'player3', ...model.steps.map((s) => s.as).filter(Boolean)])]

  const field = (label, input, cls = '') => el('div', { class: `ed-field ${cls}` }, el('label', {}, label), input)
  const text = (obj, key, { list, placeholder, number } = {}) =>
    el('input', { value: obj[key] ?? '', list, placeholder, spellcheck: false, type: number ? 'number' : 'text',
      oninput: (e) => { const v = e.target.value; if (v === '') delete obj[key]; else obj[key] = number ? Number(v) : v } })
  const json = (obj, key, id, placeholder) => {
    const ta = el('textarea', { class: 'ed-code', spellcheck: false, placeholder, rows: obj[key] === undefined ? 2 : 3, value: obj[key] === undefined ? '' : prettyJson(obj[key]),
      oninput: (e) => {
        const t = e.target.value.trim()
        if (!t) { delete obj[key]; bad.delete(id); ta.classList.remove('invalid'); return }
        try { obj[key] = JSON.parse(t); bad.delete(id); ta.classList.remove('invalid') } catch { bad.add(id); ta.classList.add('invalid') }
      } })
    return ta
  }

  function drawStep(s, i) {
    const k = kindOf(s)
    const id = (f) => `${i}.${f}.${Math.random()}`
    const body = []
    if (k === 'request') {
      body.push(el('div', { class: 'ed-row' }, field('Player', text(s, 'as', { list: 'dl-players' }), 'sm'), field('Command', text(s, 'command', { list: 'dl-requests', placeholder: 'party/invite' }))),
        field('Data (JSON, ${player2.id} works)', json(s, 'data', id('d'), '{ "userId": "${player2.id}" }')),
        field('Expect (JSON subset of the response)', json(s, 'expect', id('e'), '{ "status": "success" }')),
        field('Capture (variable: path)', json(s, 'capture', id('c'), '{ "party": "data.party" }')))
    } else if (k === 'wait') {
      body.push(el('div', { class: 'ed-row' }, field('Player', text(s, 'as', { list: 'dl-players' }), 'sm'), field('Event', text(s, 'waitFor', { list: 'dl-events', placeholder: 'party/invited' })), field('Timeout ms', text(s, 'timeout', { number: true, placeholder: '5000' }), 'xs')),
        field('Expect (JSON subset of the event)', json(s, 'expect', id('e'), '{ "data": { "reason": "intentional" } }')),
        field('Capture (variable: path)', json(s, 'capture', id('c'), '{ "party": "data.party" }')))
    } else if (k === 'none') {
      body.push(el('div', { class: 'ed-row' }, field('Player', text(s, 'as', { list: 'dl-players' }), 'sm'), field('Event that must NOT arrive', text(s, 'expectNo', { list: 'dl-events' })), field('Watch for ms', text(s, 'within', { number: true, placeholder: '500' }), 'xs')))
    } else if (k === 'raw') {
      body.push(el('div', { class: 'ed-row' }, field('Player', text(s, 'as', { list: 'dl-players' }), 'sm'), field('Raw frame text, sent exactly as typed (or a JSON object)', el('textarea', { class: 'ed-code', rows: 3, spellcheck: false,
        value: typeof s.raw === 'string' ? s.raw : JSON.stringify(s.raw), oninput: (e) => { s.raw = e.target.value } }))),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: !!s.waitReply, onchange: (e) => { if (e.target.checked) s.waitReply = true; else delete s.waitReply } }), ' wait for any reply from the server'),
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: !!s.expectClose, onchange: (e) => { if (e.target.checked) s.expectClose = true; else delete s.expectClose } }), ' the server must close the connection'))
    } else if (k === 'disconnect') {
      body.push(el('div', { class: 'ed-row' }, field('Player', text(s, 'as', { list: 'dl-players' }), 'sm'),
        field('How', el('select', { onchange: (e) => { s.disconnect = e.target.value } }, el('option', { value: 'terminate', selected: s.disconnect !== 'close' }, 'abrupt (no close frame, like a crash)'), el('option', { value: 'close', selected: s.disconnect === 'close' }, 'clean close frame')))))
    } else if (k === 'reconnect') {
      body.push(el('div', { class: 'ed-row' }, field('Player', text(s, 'as', { list: 'dl-players' }), 'sm'), el('p', { class: 'muted' }, 'Connects again with the stored token and waits until the connection is open.')))
    } else if (k === 'drain') {
      body.push(field('Whose events to forget (empty = everyone)', el('input', { value: s.drain === 'all' || s.drain === true ? '' : (s.as ?? s.drain ?? ''), list: 'dl-players', placeholder: 'everyone',
        oninput: (e) => { delete s.as; const v = e.target.value.trim(); if (v) s.as = v; s.drain = v || 'all' } })))
    } else {
      body.push(field('Milliseconds', text(s, 'sleep', { number: true })))
    }
    if (k === 'request' || k === 'wait') {
      body.push(el('label', { class: 'inline' }, ' schema check: ', el('select', { onchange: (e) => { if (e.target.value) s.schema = e.target.value; else delete s.schema } }, ['', 'off', 'warn', 'fail'].map((v) => el('option', { value: v, selected: (s.schema ?? '') === v }, v || 'use the run setting')))))
      body.push(el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: !!s.optional, onchange: (e) => { if (e.target.checked) s.optional = true; else delete s.optional } }), ' optional: a failure here does not stop the run (cleanup/reset steps)'))
    }
    return el('div', { class: `ed-step k-${k}` },
      el('div', { class: 'ed-step-head' },
        el('span', { class: 'node' }, String(i + 1)),
        el('select', { onchange: (e) => { const keep = { as: s.as, title: s.title }; model.steps[i] = { ...blank(e.target.value, s.as ?? 'player1'), ...(keep.title ? { title: keep.title } : {}) }; draw() } },
          KINDS.map(([v, l]) => el('option', { value: v, selected: v === k }, l))),
        el('input', { class: 'ed-title', value: s.title ?? '', placeholder: 'Title shown in the timeline (optional)', spellcheck: false, oninput: (e) => { if (e.target.value) s.title = e.target.value; else delete s.title } }),
        el('button', { class: 'icon', title: 'move up', disabled: i === 0, onclick: () => move(i, -1) }, icon('up')),
        el('button', { class: 'icon', title: 'move down', disabled: i === model.steps.length - 1, onclick: () => move(i, 1) }, icon('down')),
        el('button', { class: 'icon', title: 'remove step', onclick: () => { model.steps.splice(i, 1); draw() } }, icon('trash'))),
      el('div', { class: 'ed-step-body' }, body))
  }

  function move(i, d) { const j = i + d; [model.steps[i], model.steps[j]] = [model.steps[j], model.steps[i]]; draw() }

  function draw() {
    stepsBox.replaceChildren(
      el('div', {}, datalist('dl-players', players()), datalist('dl-requests', state.catalog.map((c) => c.id)), datalist('dl-events', state.events ?? [])),
      ...(model.steps.length ? model.steps.map(drawStep) : [el('div', { class: 'empty' }, 'No steps yet. Add the first one below.')]),
      el('div', { class: 'ed-add' },
        ...KINDS.map(([v, l]) => el('button', { class: 'small', onclick: () => { model.steps.push(blank(v, model.steps.findLast?.((x) => x.as)?.as ?? 'player1')); draw(); stepsBox.lastElementChild.previousElementSibling?.scrollIntoView?.({ block: 'nearest' }) } }, icon('plus'), ' ', l)),
        el('button', { class: 'small', title: 'turn requests you sent recently into steps', onclick: fromRecent }, icon('download'), ' From recent requests')))
  }

  function fromRecent() {
    const outs = state.entries.filter((e) => e.dir === 'out' && e.msg?.type === 'request').slice(-40).reverse()
    if (!outs.length) return toast('Send some requests first: they show up here, with their outcome as the expectation.', 'info', 6000)
    const responses = new Map(state.entries.filter((e) => e.dir === 'in' && e.msg?.type === 'response').map((e) => [e.msg.messageId, e.msg]))
    const picked = new Set()
    const list = el('div', { class: 'recent-list' }, outs.map((e) => {
      const r = responses.get(e.msg.messageId)
      const cb = el('input', { type: 'checkbox', onchange: (ev) => (ev.target.checked ? picked.add(e) : picked.delete(e)) })
      return el('label', { class: 'recent-row' }, cb, el('span', { class: 'who' }, e.session), el('code', {}, e.msg.commandId),
        e.msg.data !== undefined ? el('span', { class: 'muted mono' }, JSON.stringify(e.msg.data).slice(0, 60)) : null,
        r ? el('span', { class: `badge ${r.status}` }, r.status + (r.reason ? ` · ${r.reason}` : '')) : el('span', { class: 'badge' }, 'no response'))
    }))
    const m = modal({ title: 'Add steps from recent requests', wide: true, body: [el('p', { class: 'muted' }, 'Newest first. The outcome you saw becomes the expectation.'), list],
      actions: [el('button', { onclick: () => m.close() }, 'Cancel'), el('button', { class: 'primary', onclick: () => {
        for (const e of outs.filter((x) => picked.has(x)).reverse()) {
          const r = responses.get(e.msg.messageId)
          model.steps.push({ as: e.session, command: e.msg.commandId, ...(e.msg.data !== undefined ? { data: e.msg.data } : {}), ...(r ? { expect: { status: r.status, ...(r.reason ? { reason: r.reason } : {}) } } : {}) })
        }
        m.close(); draw()
      } }, 'Add selected')] })
  }

  // ---- header fields + tabs ----
  const name = el('input', { value: model.name, placeholder: 'e.g. Party kick works', spellcheck: false, oninput: (e) => (model.name = e.target.value) })
  const cat = el('input', { value: model.category, list: 'dl-cats', spellcheck: false, oninput: (e) => (model.category = e.target.value) })
  const desc = el('textarea', { rows: 2, placeholder: 'What does this scenario check?', oninput: (e) => (model.description = e.target.value), value: model.description })
  const issuePreview = el('span', { class: 'muted' })
  const showIssue = () => { const r = parseIssueUrl(model.issue); issuePreview.textContent = !model.issue ? '' : r ? `Shown as “${r.label}”` : 'Not a valid http(s) link'; issuePreview.className = !model.issue || r ? 'muted' : 'warn' }
  const issue = el('input', { value: model.issue ?? '', placeholder: 'https://github.com/org/repo/issues/123  (why this scenario exists; optional)', spellcheck: false, oninput: (e) => { model.issue = e.target.value.trim(); showIssue() } })
  showIssue()
  const sess = el('input', { value: (model.sessions ?? []).join(', '), placeholder: 'player1, player2 (empty = taken from the steps)', spellcheck: false, oninput: (e) => (model.sessions = e.target.value.split(/[,\s]+/).filter(Boolean)) })

  function setMode(next) {
    if (next === mode) return
    if (next === 'json') {
      jsonBox.value = prettyJson({ name: model.name, category: model.category, description: model.description, ...(model.issue ? { issue: model.issue } : {}), sessions: model.sessions, steps: model.steps })
    } else {
      try { Object.assign(model, JSON.parse(jsonBox.value)); name.value = model.name ?? ''; cat.value = model.category ?? ''; desc.value = model.description ?? ''; issue.value = model.issue ?? ''; showIssue(); sess.value = (model.sessions ?? []).join(', '); bad.clear() } catch (e) { return toast(`The JSON is not valid: ${e.message}`, 'error') }
    }
    mode = next
    jsonBox.classList.toggle('hidden', mode !== 'json')
    stepsBox.classList.toggle('hidden', mode !== 'steps')
    drawTabs()
    if (mode === 'steps') draw()
  }
  const drawTabs = () => tabs.replaceChildren(...[['steps', 'Steps'], ['json', 'JSON']].map(([v, l]) => el('button', { class: v === mode ? 'active' : '', onclick: () => setMode(v) }, l)))

  function save() {
    if (mode === 'json') { setMode('steps'); if (mode !== 'steps') return }
    if (!model.name?.trim()) return toast('Give the scenario a name', 'error')
    if (!model.steps.length) return toast('Add at least one step', 'error')
    if (bad.size) return toast('Some JSON field is invalid (outlined in red)', 'error')
    const open = model.steps.findIndex((s) => (s.command === '' || s.waitFor === '' || s.expectNo === ''))
    if (open >= 0) return toast(`Step ${open + 1} has no command/event`, 'error')
    if (model.issue && !parseIssueUrl(model.issue)) return toast('The task link must be a full http(s) URL', 'error')
    api.call({ op: 'scenarioSave', id: editingId, target, scenario: { ...model, name: model.name.trim(), category: model.category?.trim() || 'Custom' } })
    m.close()
    toast(`Saved “${model.name.trim()}”`, 'ok', 2500)
  }

  const m = modal({
    title: isNew ? 'New scenario' : editingId ? 'Edit scenario' : 'Scenario copy', wide: true, className: 'editor-dialog', dismissable: false,
    body: [
      el('datalist', { id: 'dl-cats' }, ['Party', 'Matchmaking', 'Friends', 'Messaging', 'User', 'Custom'].map((v) => el('option', { value: v }))),
      el('div', { class: 'ed-row' }, field('Name', name), field('Category', cat, 'sm')),
      field('Description', desc), el('div', { class: 'ed-field' }, el('label', {}, 'Task / issue link'), issue, issuePreview), field('Players', sess),
      el('div', { class: 'ed-field' }, el('label', {}, 'Save to'),
        el('select', { onchange: (e) => { target = e.target.value } },
          el('option', { value: 'project', selected: target === 'project' }, 'This project: scenarios/ (a plain file you can commit and share)'),
          el('option', { value: 'local', selected: target === 'local' }, 'Only this machine: data/scenarios/ (not in git)'))),
      el('div', { class: 'ed-tabs' }, tabs, el('span', { class: 'muted' }, 'Steps run top to bottom; the first failure stops the run.')),
      stepsBox, jsonBox],
    actions: [el('button', { onclick: () => m.close() }, 'Cancel'), el('button', { class: 'primary', onclick: save }, 'Save scenario')]
  })
  drawTabs(); draw()
  setTimeout(() => name.focus(), 30)
}
