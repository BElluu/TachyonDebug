# TachyonDebug

A launcher-style workbench for poking a Teiserver **Tachyon** server with several players at once.

```bash
npm install
npm start          # http://localhost:2137  (first run opens a setup wizard)
npm test
```

## What you get

- **Setup wizard** on first run: finds your Teiserver and Tachyon-protocol checkouts, validates them,
  sets up the servers and your first players. Everything stays editable in **Settings**
  (`data/settings.json`).
- **Players** (top bar): one click creates sessions. *Local*: pick users that already exist in your
  local Teiserver (read from its dev database) and give each a session name such as `player1` (scenarios
  and saved requests use `player1`, `player2`, `player3`). The helper starts Teiserver if needed, generates a
  token for each user (`mix teiserver.gen_token`), and renews it by itself when it expires.
  *Dev* (`lobby-server-dev.beyondallreason.dev`): browser login (OAuth + PKCE), the refresh token is
  kept so you log in once. Pasting a token by hand is under *I already have a token*.
- **Collections** (sidebar), Postman style: folders of saved requests, drag to move, search, history.
  Each request opens in a tab; `Ctrl+Enter` sends, `Ctrl+S` saves, `/` jumps to the command box.
  `${player2.id}` in a body is replaced with the user id of the connected player `player2`.
- **Response pane** with status, failure reason and latency, and a **Timeline** with every message of
  every player (filters, per-player columns, resend, save as request).
- **Scenarios** (`scenarios/*.json`): scripted multi-player flows with assertions, see below.
- **Status bar**: local server state with Start/Stop (it can also stop a server you started yourself,
  after asking) and dev-server reachability. The log of a server started from here is under *Log*.

The command list and the JSON templates come from the protocol repo's `schema/` folder. That repo only
has to be *read*, so in Settings the Tachyon field accepts either a local folder or a **git URL**
(`https://…`, `git@host:org/repo.git`, optionally `#branch-or-tag`): it is shallow-cloned into
`data/repos/` and refreshed with *Update from git*. Teiserver itself must be a local checkout (it is run with `mix`).

The splitter under the JSON body editor resizes body vs. response/timeline (double-click resets it).

## Protocol checks

- **Schema validation.** Every message is checked against the protocol repo's JSON schemas: the body you
  type is validated live (a list of problems appears above the editor; **Fields** lists the command's
  fields from the schema, click one to add it; **Fill all** inserts every field), and every message in
  the Timeline and every response gets a `✓ schema` / `⚠ schema` badge with the exact issues.
  *schema issues only* in the Timeline filters down to the broken ones.
- **Player state** (tab next to Timeline): per player, the party, invites, matchmaking state and friends as the
  server last told them, plus the latest message of every command. Derived from events; *Refresh friends* asks the server.
- **Bad input and flaky connections**: the player menu has *Kill connection* (no close frame), *Close cleanly*,
  *Reconnect*, *Send raw frame…* (presets: broken JSON, missing fields, unknown command, duplicate messageId,
  1 MB payload, binary frame, …) and auth probes (connect with an invalid / missing token).

## Scenarios

The **Scenarios** tab lists scripted flows grouped by area (Party, Matchmaking, Friends, Messaging,
User, System). Pick one, check that its players are connected, press **Run**: every step lights up
with its result and timing, and failures show why. The built-in scenarios (`scenarios/*.json`)
are derived from the Teiserver Tachyon tests (`party_test`, `party_matchmaking_test`,
`matchmaking_test`, `friend_test`, `messaging_test`, `user_test`, `system_test`). They expect players
named `player1`, `player2` and (some) `player3`, and every one starts by resetting the players' state and
ends by cleaning up, so they can be run repeatedly.

**Run many.** *Run all* (or the play button on a category) runs scenarios one after another with a summary and
*Re-run failed*; `x n` repeats the selection n times to flush out races. *Protocol schema* chooses what a response
that breaks the schema does: ignore, warn, or fail the step (a step can override it with `"schema": "off|warn|fail"`).
The *Robustness* and *Connection* categories use the extra steps `raw`, `disconnect` and `reconnect` (see the header of `src/scenarios.js`).

**From the command line / CI**

```bash
npm run scenarios -- --list
npm run scenarios -- --category Party,Friends --schema fail --junit report.xml
npm run scenarios -- --repeat 20 --filter matchmaking --stop-on-fail --json
```

It uses the helper that is already running, or starts one. The players must exist (add them once in the UI) and are connected
automatically. Exit code: `0` all passed, `1` a failure, `2` setup problem.

**Your own scenarios**: *New scenario* opens a visual editor (steps, expectations, captures, an optional link to
the task or PR that motivated it, plus a raw JSON tab), *Edit* and *Duplicate* work on any scenario, and *From recent
requests* turns what you just sent in the workbench into steps, using the answers you saw as expectations.

**Scenarios are plain files**, so they can live in git:
- `scenarios/*.json` (default for new scenarios, shown as *in repo*): part of the project. Create or edit one in the UI,
  then `git add scenarios/ && git commit`, and anyone who pulls the repo has it. `npm test` checks that every file there
  uses real commands/events and resolvable variables, so a broken scenario is caught before it is merged.
- `data/scenarios/` (*local only*, git-ignored): private experiments. The editor's *Save to* switch moves a scenario between the two.

You can also just drop a `.json` file into `scenarios/` by hand, using the format below.

**Export / import**: scenarios, collections and single requests export as `.json` files (hover a
collection or request in the sidebar, or use *Export*); *Import* (or dropping a file on the sidebar)
adds them back, renaming on clashes.

```json
{ "name": "...", "category": "Party", "description": "...", "sessions": ["player1", "player2"],
  "steps": [
    { "as": "player1", "command": "party/invite", "data": { "userId": "${player2.id}" }, "expect": { "status": "success" } },
    { "as": "player2", "waitFor": "party/invited", "capture": { "party": "data.party" } },
    { "as": "player2", "expectNo": "party/removed", "within": 400 },
    { "as": "player2", "drain": true },
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

Defaults come from env vars and are then stored by the wizard: `PORT` (2137), `TEISERVER_DIR`,
`TACHYON_DIR`, `TACHYON_URL`, `TACHYON_DEV_URL`, `TACHYON_CLIENT_ID`, and `TACHYON_DEBUG_DATA`
(where `data/` lives). Tokens never reach the browser; they stay in the helper process and in
`data/sessions.json` (git-ignored).
