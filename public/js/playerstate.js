// "State" tab: what the server thinks each player is doing (party, matchmaking, friends),
// rebuilt from the events and responses that player received. Lets you check a multi-player flow at a glance
// instead of reading raw logs. Everything here is derived, nothing is queried unless you press Refresh.
import { $, el, state, bus, api, colorFor, hhmmss, debounce, prettyJson } from './core.js'
import { highlightJson } from './timeline.js'
import { blank, idOf, reduce } from './derive.js'

const states = new Map()
const of = (name) => states.get(name) ?? states.set(name, blank()).get(name)

function onMsg(m) {
  if (m.dir === 'sys') {
    if (/^connected to/.test(m.msg.text)) of(m.session).since = m.ts
    return
  }
  const st = of(m.session)
  if (m.dir === 'in') { st.counts.in++; if (m.schema?.ok === false) st.counts.bad++; reduce(st, m.msg, m.ts) } else st.counts.out++
  render()
}

const whoIs = (id) => {
  for (const s of state.sessions.values()) if (String(s.user?.id) === String(id)) return s.name
  return null
}
const userChip = (id) => {
  const n = whoIs(id)
  return el('span', { class: 'ustate', style: n ? `--c:${colorFor(n)}` : '' }, n ? `${n} ` : '', el('span', { class: 'muted mono' }, n ? `#${id}` : `user ${id}`))
}
const row = (k, ...v) => el('div', { class: 'ps-row' }, el('span', { class: 'ps-k' }, k), el('span', { class: 'ps-v' }, ...v))
const list = (ids, empty) => (ids.length ? el('span', { class: 'ps-list' }, ids.map(userChip)) : el('span', { class: 'muted' }, empty))

function card(name, s) {
  const st = of(name)
  const online = s?.state === 'open'
  const mm = st.mm
  const mmText = mm.status === 'queued' ? el('span', {}, el('b', { class: 'ps-on' }, 'in queue '), mm.queues.map((q) => (typeof q === 'string' ? q : q.id ?? JSON.stringify(q))).join(', '), mm.playersQueued != null ? ` · ${mm.playersQueued} queued` : '')
    : mm.status === 'found' ? el('span', {}, el('b', { class: 'ps-hot' }, 'match found '), `${mm.queueId ?? ''} · ready ${mm.readyCount ?? 0}${mm.ready ? ' · you are ready' : ''}`)
    : el('span', { class: 'muted' }, `idle${mm.note ? ` (${mm.note})` : ''}`)
  const party = st.party
  const last = [...st.last.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 12)
  return el('div', { class: `ps-card ${online ? '' : 'off'}` },
    el('div', { class: 'ps-head' },
      el('span', { class: 'avatar', style: `--c:${colorFor(name)}` }, name.slice(0, 1).toUpperCase()),
      el('b', {}, name), el('span', { class: `dot ${s?.state ?? 'down'}` }),
      el('span', { class: 'muted mono' }, s?.user ? `#${s.user.id}${s.user.name ? ` ${s.user.name}` : ''}` : s ? s.state : 'gone'),
      el('span', { class: 'spacer' }),
      st.counts.bad ? el('span', { class: 'badge failed', title: 'messages that did not match the schema' }, `${st.counts.bad} schema`) : null,
      el('button', { class: 'small', disabled: !online, title: 'ask the server for the friend list', onclick: () => api.call({ op: 'send', name, commandId: 'friend/list' }) }, 'Refresh friends')),
    row('Party', party
      ? el('span', {}, el('code', {}, String(party.id).slice(0, 8)), ` ${party.members?.length ?? 0}/${party.maxMembers ?? '?'} members: `, list((party.members ?? []).map((x) => idOf(x)), ''),
        party.invited?.length ? el('span', {}, ' · invited: ', list(party.invited.map(idOf), '')) : null)
      : el('span', { class: 'muted' }, 'not in a party')),
    st.invites.length ? row('Invites', el('span', {}, st.invites.map((i) => el('code', { title: prettyJson(i) }, String(i.id).slice(0, 8))))) : null,
    row('Matchmaking', mmText),
    row('Friends', st.friends.known
      ? el('span', {}, list(st.friends.list, 'none'), st.friends.incoming.length ? el('span', {}, ' · incoming: ', list(st.friends.incoming, '')) : null, st.friends.outgoing.length ? el('span', {}, ' · sent: ', list(st.friends.outgoing, '')) : null)
      : el('span', { class: 'muted' }, 'unknown (press Refresh friends)')),
    row('Traffic', el('span', { class: 'muted mono' }, `${st.counts.in} in · ${st.counts.out} out${st.since ? ` · connected ${hhmmss(st.since)}` : ''}`)),
    last.length ? el('details', { class: 'ps-last' }, el('summary', {}, `Latest message per command (${st.last.size})`),
      last.map(([cmd, v]) => el('details', {}, el('summary', {}, el('span', { class: 'time' }, hhmmss(v.ts)), ' ', el('code', {}, cmd)), el('pre', { class: 'json' }, highlightJson(prettyJson(v.msg)))))) : null)
}

const render = debounce(() => {
  const box = $('#stateView')
  if (!box || box.classList.contains('hidden')) return
  const names = [...new Set([...state.sessions.keys()])]
  box.replaceChildren(
    ...(names.length ? names.map((n) => card(n, state.sessions.get(n))) : [el('div', { class: 'empty' }, 'No players yet.')]),
    el('div', { class: 'row' }, el('button', { class: 'small ghost', onclick: () => { states.clear(); render() } }, 'Reset derived state'),
      el('span', { class: 'muted' }, 'Built from the messages seen since this page was opened.')))
}, 60)

export function initPlayerState() {
  bus.on('msgAdded', onMsg)
  for (const e of ['session', 'sessionRemoved', 'init', 'showState']) bus.on(e, render)
  bus.on('sessionRemoved', () => { for (const n of [...states.keys()]) if (!state.sessions.has(n)) states.delete(n) })
}
export const renderState = render
