import { $, el, state, bus, api } from './core.js'

const progress = new Map()

function render() {
  const page = $('#view-scenarios .page')
  page.replaceChildren()
  if (!state.scenarios.length) page.append(el('div', { class: 'empty' }, 'No scenarios found in ./scenarios'))
  for (const sc of state.scenarios) {
    const p = progress.get(sc.file) ?? {}
    page.append(el('div', { class: 'panel chamfer scenario' },
      el('div', { class: 'row' }, el('h2', {}, sc.name), el('span', { class: 'spacer' }),
        p.final ? el('span', { class: `badge big ${p.final === 'done' ? 'success' : 'failed'}` }, p.final === 'done' ? 'passed' : 'failed') : null,
        el('button', { class: 'primary', disabled: !!p.running, onclick: () => run(sc) }, p.running ? 'Running…' : '▶ Run')),
      el('p', { class: 'muted' }, sc.description),
      sc.sessions?.length ? el('p', { class: 'muted' }, 'Players needed: ', sc.sessions.map((n) => el('span', { class: `reason ${state.sessions.get(n)?.state === 'open' ? 'okpill' : ''}` }, n))) : null,
      el('ol', { class: 'steps' }, sc.steps.map((s, i) => {
        const st = p.steps?.[i]
        return el('li', { class: st?.status ?? '' }, el('code', {}, `${s.as ?? ''} ${s.command ?? (s.waitFor ? 'waits for ' + s.waitFor : s.sleep ? 'sleep ' + s.sleep + 'ms' : '')}`),
          st?.detail ? el('div', { class: 'step-err' }, st.detail) : null)
      }))))
  }
}

function run(sc) {
  progress.set(sc.file, { running: true, steps: [] })
  render()
  api.call({ op: 'runScenario', file: sc.file })
}

export function initScenarios() {
  for (const e of ['init', 'session', 'sessionRemoved']) bus.on(e, render)
  bus.on('scenarioLog', (m) => {
    const p = progress.get(m.scenario) ?? { steps: [] }
    if (m.step !== undefined) p.steps[m.step] = { status: m.status, detail: m.detail }
    if (['done', 'aborted'].includes(m.status)) { p.running = false; p.final = m.status }
    progress.set(m.scenario, p)
    render()
  })
}
