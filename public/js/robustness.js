// Tools for poking the server with bad input and flaky connections:
//  - raw frames (broken JSON, missing fields, unknown commands, duplicate ids, huge payloads, binary frames)
//  - abrupt disconnects, reconnects and credential probes
// The answers show up in the Timeline like everything else.
import { el, state, api, uid } from './core.js'
import { modal, toast } from './modal.js'

const mk = (extra = {}) => JSON.stringify({ type: 'request', messageId: uid(), commandId: 'system/serverStats', ...extra })
const PRESETS = [
  { id: 'badjson', label: 'Invalid JSON', text: () => '{"type": "request", "messageId": ', note: 'Expect: an error reply or a clean close, never a crash or a hang.' },
  { id: 'empty', label: 'Empty text frame', text: () => '', note: '' },
  { id: 'array', label: 'JSON that is not an object', text: () => '[1, 2, 3]', note: '' },
  { id: 'nocmd', label: 'Missing commandId', text: () => JSON.stringify({ type: 'request', messageId: uid() }), note: '' },
  { id: 'noid', label: 'Missing messageId', text: () => JSON.stringify({ type: 'request', commandId: 'system/serverStats' }), note: '' },
  { id: 'unknown', label: 'Unknown command', text: () => mk({ commandId: 'does/notExist' }), note: 'Expect: response failed / command_unimplemented.' },
  { id: 'type', label: 'Unknown message type', text: () => mk({ type: 'banana' }), note: '' },
  { id: 'asevent', label: 'Request sent as an event', text: () => mk({ type: 'event' }), note: '' },
  { id: 'baddata', label: 'Wrong data type (data is a string)', text: () => mk({ commandId: 'party/invite', data: 'oops' }), note: 'Expect: failed / invalid_request.' },
  { id: 'dup', label: 'Same messageId twice', text: () => mk({ messageId: 'duplicate-id-1' }), twice: true, note: 'Both frames are sent. See whether the server answers both, or complains.' },
  { id: 'nested', label: 'Deeply nested data (1000 levels)', text: () => mk({ commandId: 'party/invite', data: JSON.parse('['.repeat(1000) + ']'.repeat(1000)) }), note: '' },
  { id: 'big', label: 'Huge payload (1 MB)', text: () => mk({ commandId: 'messaging/send', data: { message: 'x'.repeat(1024 * 1024) } }), note: 'Expect: refused or closed, not a stalled server.' },
  { id: 'unicode', label: 'Odd unicode in data', text: () => mk({ commandId: 'user/info', data: { userId: '\u0000😀‮' } }), note: '' },
  { id: 'binary', label: 'Binary frame', text: () => mk(), binary: true, note: 'Tachyon is text-only: a binary frame should be rejected.' }
]

export function openRawDialog({ as } = {}) {
  const names = [...state.sessions.values()].filter((s) => s.state === 'open').map((s) => s.name)
  const who = el('select', {}, ...(names.length ? names : ['(no connected player)']).map((n) => el('option', { value: n }, n)))
  if (as && names.includes(as)) who.value = as
  const text = el('textarea', { spellcheck: false, rows: 8, class: 'ed-code', placeholder: 'the exact text of the frame' })
  const binary = el('input', { type: 'checkbox' })
  const note = el('div', { class: 'muted' })
  let twice = false
  const preset = el('select', { onchange: () => {
    const p = PRESETS.find((x) => x.id === preset.value)
    if (!p) return
    text.value = p.text(); binary.checked = !!p.binary; twice = !!p.twice; note.textContent = p.note
  } }, el('option', { value: '' }, 'Start from a preset…'), ...PRESETS.map((p) => el('option', { value: p.id }, p.label)))
  const send = () => {
    if (!names.length) return toast('Connect a player first', 'error')
    const go = () => api.call({ op: 'sendRaw', name: who.value, text: text.value, binary: binary.checked })
    go(); if (twice) go()
    toast('Frame sent. Watch the Timeline for the answer.', 'info', 2500)
  }
  const m = modal({
    title: 'Send a raw frame', wide: true,
    body: [
      el('p', { class: 'muted' }, 'The text is sent as it is: no envelope, no JSON check. Use it to see how the server copes with broken input.'),
      el('div', { class: 'ed-row' }, el('div', { class: 'ed-field sm' }, el('label', {}, 'Send as'), who), el('div', { class: 'ed-field' }, el('label', {}, 'Preset'), preset)),
      el('label', {}, 'Frame'), text, note,
      el('label', { class: 'inline' }, binary, ' send as a binary frame')],
    actions: [el('button', { onclick: () => m.close() }, 'Close'), el('button', { class: 'primary', onclick: send }, 'Send frame')]
  })
}

// extra entries for the player menu; `act` closes the menu then runs the action
export function connectionMenu(s, act) {
  const online = s.state === 'open'
  const probe = (mode) => async () => {
    const r = await api.request({ op: 'probeAuth', name: s.name, mode }, 15000).catch((e) => ({ ok: false, text: e.message }))
    toast(`Auth probe (${mode}): ${r.text}`, r.ok ? 'ok' : 'error', 7000)
  }
  return [
    el('div', { class: 'menu-note' }, 'TESTS'),
    online ? el('button', { onclick: act(() => api.call({ op: 'drop', name: s.name, mode: 'terminate' })) }, 'Kill connection (no close frame)') : null,
    online ? el('button', { onclick: act(() => api.call({ op: 'drop', name: s.name, mode: 'close' })) }, 'Close connection cleanly') : null,
    s.state !== 'connecting' ? el('button', { onclick: act(() => api.call({ op: 'reconnect', name: s.name })) }, 'Reconnect (same token)') : null,
    online ? el('button', { onclick: act(() => openRawDialog({ as: s.name })) }, 'Send raw frame…') : null,
    el('button', { onclick: act(probe('invalid')) }, 'Probe: connect with an invalid token'),
    el('button', { onclick: act(probe('missing')) }, 'Probe: connect without a token')
  ]
}
