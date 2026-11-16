# TachyonDebug

A launcher-style workbench for poking a Teiserver **Tachyon** server with several players at once.

```bash
npm install
npm start          # http://localhost:4747  (first run opens a setup wizard)
npm test
```

## What you get

- **Setup wizard** on first run: finds your Teiserver and Tachyon-protocol checkouts, validates them,
  sets up the servers and your first players. Everything stays editable in **Settings**
  (`data/settings.json`).
- **Players** (top bar): one click creates sessions. *Local*: pick users that already exist in your
  local Teiserver (read from its dev database) and give each a session name such as `alice` (scenarios
  and saved requests use `alice`, `bob`, `carol`). The helper starts Teiserver if needed, generates a
  token for each user (`mix teiserver.gen_token`), and renews it by itself when it expires.
  *Dev* (`lobby-server-dev.beyondallreason.dev`): browser login (OAuth + PKCE), the refresh token is
  kept so you log in once. Pasting a token by hand is under *I already have a token*.
- **Collections** (sidebar), Postman style: folders of saved requests, drag to move, search, history.
  Each request opens in a tab; `Ctrl+Enter` sends, `Ctrl+S` saves, `/` jumps to the command box.
  `${bob.id}` in a body is replaced with the user id of the connected player `bob`.
- **Response pane** with status, failure reason and latency, and a **Timeline** with every message of
  every player (filters, per-player columns, resend, save as request).
- **Scenarios** (`scenarios/*.json`): scripted multi-player flows with assertions, see below.
- **Status bar**: local server state with Start/Stop (it can also stop a server you started yourself,
  after asking) and dev-server reachability. The log of a server started from here is under *Log*.

The command list and the JSON templates come from the protocol repo's `schema/` folder.

## Scenarios

The **Scenarios** tab lists scripted flows grouped by area (Party, Matchmaking, Friends, Messaging,
User, System). Pick one, check that its players are connected, press **Run**: every step lights up
with its result and timing, and failures show why. The 25 built-in scenarios (`scenarios/*.json`)
are derived from the Teiserver Tachyon tests (`party_test`, `party_matchmaking_test`,
`matchmaking_test`, `friend_test`, `messaging_test`, `user_test`, `system_test`). They expect players
named `alice`, `bob` and (some) `carol`, and every one starts by resetting the players' state and
ends by cleaning up, so they can be run repeatedly.

**Your own scenarios**: *New scenario* opens a visual editor (steps, expectations, captures, plus a raw
JSON tab), *Duplicate* copies a built-in one into something editable, and *From recent requests*
turns what you just sent in the workbench into steps, using the answers you saw as expectations.
They are stored in `data/scenarios/`.

**Export / import**: scenarios, collections and single requests export as `.json` files (hover a
collection or request in the sidebar, or use *Export*); *Import* (or dropping a file on the sidebar)
adds them back, renaming on clashes.

```json
{ "name": "...", "category": "Party", "description": "...", "sessions": ["alice", "bob"],
  "steps": [
    { "as": "alice", "command": "party/invite", "data": { "userId": "${bob.id}" }, "expect": { "status": "success" } },
    { "as": "bob", "waitFor": "party/invited", "capture": { "party": "data.party" } },
    { "as": "bob", "expectNo": "party/removed", "within": 400 },
    { "as": "bob", "drain": true },
    { "sleep": 200 }
  ] }
```

- Step kinds: `command` (send a request), `waitFor` (an event), `expectNo` (an event must NOT arrive
  within `within` ms), `drain` (forget events received so far), `sleep`.
- Any step: `title`, `note`, `optional` (a failure is shown but does not stop the run), `timeout` (ms).
- `${player.id}` / `${player.name}`: user learned from `user/self` on connect.
- `capture` stores a value from the response/event. Path segments are keys, indexes, or `field=value`
  to pick an array element. Use it as `${var.path}`.
- `expect` is a recursive subset match (arrays compare element by element).
- Events arriving before their `waitFor` step are buffered. 5 s timeout per step by default.

## Configuration

Defaults come from env vars and are then stored by the wizard: `PORT` (4747), `TEISERVER_DIR`,
`TACHYON_DIR`, `TACHYON_URL`, `TACHYON_DEV_URL`, `TACHYON_CLIENT_ID`, and `TACHYON_DEBUG_DATA`
(where `data/` lives). Tokens never reach the browser; they stay in the helper process and in
`data/sessions.json` (git-ignored).
