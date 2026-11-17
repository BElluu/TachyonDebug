// Pure reducer behind the Player state tab: one incoming message at a time.
export const blank = () => ({ party: null, invites: [], mm: { status: 'idle' }, friends: { list: [], incoming: [], outgoing: [], known: false }, last: new Map(), counts: { in: 0, out: 0, bad: 0 }, since: null })

export const idOf = (v) => (v && typeof v === 'object' ? v.userId ?? v.id : v)
const addOnce = (arr, id) => { if (id != null && !arr.includes(String(id))) arr.push(String(id)) }
const drop = (arr, id) => { const i = arr.indexOf(String(id)); if (i >= 0) arr.splice(i, 1) }

// one incoming message changes the picture
export function reduce(st, msg, ts = Date.now()) {
  const d = msg.data
  const ok = msg.type !== 'response' || msg.status === 'success'
  const id = msg.commandId
  if (!id) return
  st.last.set(id, { ts, msg })
  if (!ok) return
  switch (id) {
    case 'party/create': if (d?.party) st.party = d.party; break
    case 'party/updated': st.party = d; st.invites = st.invites.filter((i) => i.id !== d?.id); break
    case 'party/invited': if (d?.party && !st.invites.some((i) => i.id === d.party.id)) st.invites.push(d.party); break
    case 'party/removed':
      if (st.party?.id === d?.partyId) st.party = null
      st.invites = st.invites.filter((i) => i.id !== d?.partyId)
      break
    case 'party/leave': st.party = null; break
    case 'matchmaking/queuesJoined': st.mm = { status: 'queued', queues: d?.queues ?? [], playersQueued: null }; break
    case 'matchmaking/queueUpdate': if (st.mm.status === 'queued') st.mm.playersQueued = d?.playersQueued; break
    case 'matchmaking/found': st.mm = { status: 'found', queueId: d?.queueId, timeoutMs: d?.timeoutMs, readyCount: 0, at: ts }; break
    case 'matchmaking/foundUpdate': if (st.mm.status === 'found') st.mm.readyCount = d?.readyCount; break
    case 'matchmaking/lost': st.mm = { status: 'idle', note: 'match lost' }; break
    case 'matchmaking/cancelled': st.mm = { status: 'idle', note: `cancelled: ${d?.reason ?? '?'}` }; break
    case 'matchmaking/cancel': st.mm = { status: 'idle', note: 'cancelled by you' }; break
    case 'matchmaking/ready': if (st.mm.status === 'found') st.mm.ready = true; break
    case 'friend/list':
      st.friends = { known: true, list: (d?.friends ?? []).map((f) => String(f.userId)), incoming: (d?.incomingPendingRequests ?? []).map((f) => String(f.from)), outgoing: (d?.outgoingPendingRequests ?? []).map((f) => String(f.to)) }
      break
    case 'friend/requestReceived': addOnce(st.friends.incoming, d?.from); break
    case 'friend/requestAccepted': drop(st.friends.outgoing, d?.from); addOnce(st.friends.list, d?.from); break
    case 'friend/requestRejected': case 'friend/requestCancelled': drop(st.friends.outgoing, d?.from); drop(st.friends.incoming, d?.from); break
    case 'friend/removed': drop(st.friends.list, d?.from); break
    case 'friend/sendRequest': break
  }
}

