# dsh-neeko

Bidirectional bridge between [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) and the **Neeko** desktop shell.

`dsh-neeko` is the communication layer described in [`docs/dsh-neeko-integration.md`](docs/dsh-neeko-integration.md). It is a **neutral protocol bridge** with two mutually exclusive runtime surfaces:

- **DSH** is the AI backend (agents, sessions, commands, tools, sandbox) and never knows Neeko exists.
- **Neeko** is the desktop interaction shell (file editing, Git, terminal, Agent Chat UI) and treats DSH as one optional backend.
- **dsh-neeko** translates both directions, owns the WebSocket + health server, and holds session state.
- **dsh-neeko TUI** (`--tui`) renders the same agent to a local terminal instead of a WebSocket client.

## What it provides

| Feature | Status |
|---|---|
| WebSocket server on `127.0.0.1:3081` (non-3080, dynamic fallback to `+1..+9`) | ✅ |
| Health probe `GET /neeko-health` (+ `GET /` service descriptor) | ✅ |
| Handshake protocol with mode detection (`dsh-agent` / `on-demand`) | ✅ |
| DSH event → protocol translation (`text.delta`, `thinking.delta`, `tool.start`, `tool.end`) | ✅ |
| Neeko message → DSH API (`session.prompt`, `session.steer`, `session.cancel`) | ✅ |
| Approval requests (`approval.request` / `approval.respond`) | ✅ |
| User questions (`question.request` / `question.respond`) | ✅ |
| `session.init` with reconstructed history (incl. `failure` rows) | ✅ |
| CLI mode auto-launch of Neeko | ✅ |
| Daemon mode (pure wait, no spawn) | ✅ |
| Interactive terminal UI (`--tui`): transcript, tool cards, syntax highlighting, themes | ✅ |
| TUI slash commands, model picker, reasoning-effort selector | ✅ |
| TUI status bar (cwd, branch, tokens, cache hit, context %, timing) | ✅ |
| Fullscreen alt-screen mode with clickable cards | ✅ |

## Architecture

```
+-----------------------------------------------------------------+
|                      dsh-neeko (bridge)                          |
|                                                                  |
|  WS server: 127.0.0.1:3081  (health at /neeko-health)           |
|                                                                  |
|  +------------------------------------------------------------+  |
|  |  Neeko connection modes                                     |  |
|  |   mode=dsh-agent  -> activate session immediately           |  |
|  |   mode=on-demand, active=true -> activate on click          |  |
|  |   mode=on-demand, active=false -> idle, no event subscription |  |
|  +------------------------------------------------------------+  |
+-----------------------------------------------------------------+
       |                                      |
       |  DSH API (agents/sessions)           |  WS protocol
       v                                      v
    DSH process                           Neeko process
```

`cordis.patch.yml` mounts three rows — the startup provider (always), the bridge, and the TUI runner. The last two are mutually exclusive via `disabled: !!js` conditions, so exactly one runs per invocation: `--tui` selects the TUI, anything else the bridge. Both read their configuration from `ctx.neekoStartup`.

### Launch paths

- **Path A — DSH starts Neeko:** `dsh --profile neeko` → the bridge starts, spawns
  `open -a Neeko --args --dsh-ws=ws://127.0.0.1:3081/ws --mode=dsh-agent`, and Neeko
  opens straight into the Agent Chat.
- **Path B — Neeko starts DSH:** the user clicks *DeepSeek* in Neeko; Neeko probes
  `GET http://127.0.0.1:3081/neeko-health`, and if DSH is down spawns
  `dsh --profile neeko daemon`, waits for the health probe, then connects with
  `mode=on-demand, active=true`.

## Install

```shell
npm i -g @deepseek-ai/dsh
dsh plugin --profile neeko add dsh-neeko

# Bridge mode: bridge + auto-launch Neeko
dsh --profile neeko

# Daemon mode: pure wait, never spawns Neeko
dsh --profile neeko daemon

# TUI mode: interactive terminal UI instead of the bridge
dsh --profile neeko --tui
```

For local development, link this checkout instead:

```shell
just install     # = dsh plugin --profile neeko add "."
```

## Usage

```
dsh --profile neeko [options] [mode]

Options:
  --daemon         pure-wait mode: never spawn Neeko
  --host <host>    bind host (default 127.0.0.1)
  --port <n>       preferred bridge port (default 3081; falls back to +1..+9)
  --session <id>   resume an existing persisted session
  --spawn <cmd>    override the Neeko launch command (e.g. "open -a Neeko")
  --no-spawn       do not spawn Neeko even in CLI mode
  --tui            run the interactive terminal UI instead of the Neeko bridge
  --main-screen    TUI: keep the terminal scrollback (fullscreen is the default)

Environment:
  DSH_NEEKO_PORT=3081            port override when --port is absent
  DSH_NEEKO_AUTOSPAWN=0         disable auto-spawn in CLI mode
```

## Wire protocol

The protocol is exported from `dsh-neeko/protocol` (also usable by the Neeko side).
Every frame is a JSON envelope:

```ts
interface Envelope {
  rpcId: string
  direction: 'dsh->neeko' | 'neeko->dsh'
  timestamp: number
  message: ProtocolMessage
}
```

The first frame of a connection must be a handshake (the decoder also accepts a
bare unwrapped message, for symmetry with older clients):

```ts
{ type: 'handshake', payload: { version: '1.0.0', role: 'neeko',
  mode: 'dsh-agent' | 'on-demand', active: boolean, sessionId?: string } }
```

Messages (see `src/protocol.ts` for the full types):

- **DSH → Neeko:** `session.init`, `status.change`, `text.delta`, `thinking.delta`,
  `tool.start`, `tool.stream`, `tool.end`, `approval.request`, `question.request`, `error`
- **Neeko → DSH:** `session.prompt`, `session.steer`, `session.cancel`,
  `approval.respond`, `question.respond`

`HistoryItem` has four kinds — `user`, `assistant`, `tool`, `failure`. The `failure`
row carries a pre-worded line settled from the turn's `turn/end` reason, because a
request can fail before any assistant message exists (auth, rate limit, transport)
and a resumed turn would otherwise show the prompt and then silence.

> ⚠️ `messageId` on `session.init` history rows and `messageId` on `text.delta` are
> **disjoint namespaces on purpose** and must never be assumed to join. History rows
> identify a *settled* message (`assistant:{turn}:{step}:{message.id}`); delta frames
> multiplex a *live attempt* (`assistant:{turn}:{step}:{attemptId}`), so a failed
> attempt's text is never spliced into the successful retry.

### DSH event → protocol mapping

Two distinct sources feed Neeko — this split is the 0.2.x contract:

**Live deltas** (`agent/assistant-stream`, agent-scoped):

| Frame / chunk | Protocol message |
|---|---|
| `start` | *(records turn/step/attempt; emits nothing)* |
| `chunk` → `text-delta` | `text.delta` |
| `chunk` → `reasoning-delta` | `thinking.delta` |
| `chunk` → `tool-call-delta`, `block-*`, `usage`, `finish` | *(nothing)* |
| `end` | *(clears the attempt; emits nothing)* |

**Durable log** (`session.snapshotEvents()`):

| DSH event | Protocol message |
|---|---|
| `tool/call` | `tool.start` |
| `tool/result` | `tool.end` (with diff when the fs tool attaches one) |
| `assistant/message` | *(nothing — text already arrived as live deltas)* |
| `user/message` | *(history rows only)* |
| `turn/end` | *(history rows only — a `failure` row when the turn failed)* |
| `agent/status` | `status.change` |
| `approval/request` | `approval.request` |
| `user-questions/request` | `question.request` |

> **Supported DSH generation: `0.2.x` only.** 0.1.x carried assistant output as
> `assistant/chunk` rows inside the session log and exposed `userQuestions.registerProvider()`;
> both are gone in 0.2.x, where live streaming moved to `agent/assistant-stream` and question
> answering moved to the agent-scoped `user-questions/request` waterfall. One codebase cannot
> serve both, so `peerDependencies` pins `^0.2.0-rc.2` rather than claiming a wider range.

## Terminal UI (`--tui`)

`dsh --profile neeko --tui` runs the same agent against a local terminal instead
of a WebSocket client. It is published as its own entry point, `dsh-neeko/tui`.

```shell
dsh --profile neeko --tui                          # start a new session
dsh --profile neeko --tui --session <id>           # resume
dsh --profile neeko --tui --main-screen            # keep the terminal scrollback
DSH_NEEKO_THEME=light dsh --profile neeko --tui    # start on a given theme
```

On exit the TUI prints the conversation back to scrollback and a pasteable resume line:

```
To resume this session: dsh --profile neeko --tui --session <id>
```

### Screen modes

Fullscreen (alt screen) is the **default**, matching pi's own default. It owns the
viewport, enables click-to-expand cards, and copies through **OSC 52** (works over
SSH, no `pbcopy`/`xclip`). It costs the terminal's own scrollback, so `--main-screen`
(or `DSH_NEEKO_MAIN_SCREEN=1`) is the explicit opt-out. `/fullscreen` toggles at
runtime either way.

### Slash commands

| Command | Effect |
|---|---|
| `/help` | list commands and key hints |
| `/clear` | clear the transcript view (a watermark — new rows still appear) |
| `/model [id]` | bare opens a fuzzy-filtered picker; with an id, applies directly |
| `/thinking [level]` | bare opens a selector; with a level, applies directly |
| `/theme [name]` | bare opens a picker; with a name, applies directly |
| `/fullscreen` | toggle fullscreen |
| `/exit` | quit the TUI |

DSH-plugin-registered commands and skills appear in the **same** `/` menu. Host
commands dispatch through the `commands` registry so their semantics stay owned by
the defining plugin; skills are namespaced `/skill:<name>`. A host command can never
shadow a built-in. The catalogue is re-read on every menu open so commands
registered after boot still appear.

### Keys

| Key | Effect |
|---|---|
| `ctrl+c` / `ctrl+d` | exit |
| `ctrl+o` | expand/collapse the whole transcript (a click flips one row) |
| `y` / `n` / `esc` | allow-once / reject / cancel an approval |
| `1`–`9` | pick a question option |
| `enter` | send; submit a free-text question answer |
| `esc` | close any open selector |
| `↑` / `↓` / `enter` | navigate and confirm a selector |
| `ctrl+s` | (model panel) set the highlighted model as the profile default |
| `tab` | slash / argument completion |

### Transcript

Four row kinds — `user`, `assistant`, `tool`, `failure` — merged from two sources
into one ordered list: live `agent/assistant-stream` frames and the durable
`session/event` log. Restored history renders before any live frame, so the attach
timeline cleanly separates "was already in the log" from "will arrive as a delta".

Rows are **folded by default**. Tool calls render as `emoji Title summary [status]`
cards with a full-width background band by status, across seven variants (`read`,
`search`, `bash`, `write`, `edit`, `code`, `others`); an unknown tool falls into
`others` and still names itself, so a new tool needs no code change. Fenced code
blocks are syntax-highlighted for 7 language families (TypeScript/JS, Rust, Python,
Shell, JSON, CSS, SQL) — deliberately hand-rolled and never-throwing, since a stream
can produce arbitrary fragments.

Reasoning stays on **one line** while streaming (a growing wall would push the answer
off screen), with a braille spinner while unfinished. Images are fetched
asynchronously through the verified attachment service, cached by id, and negotiated
by pi-tui's renderer (Kitty/iTerm2 with a text fallback).

### Status bar

Two lines, width-aware (pi's footer shape, with the context line split out so an
80-column terminal never truncates away the token ledger):

```
~/.neeko/worktrees/dsh-neeko (dsh-neeko)
↑2.4M ↓364k R395M CH99.9% $4.259 78.5%/1.0M      (magpie) group/auto-… • high
```

Left is cwd + git branch; right is `(provider) model • effort`; the middle carries
the timing segment then the token ledger (`↑in ↓out Rread Wwrite CHhit% $cost`,
zeros omitted). Cache-hit rate is computed from the **latest** message only — a
session average would hide a cache that just stopped working. Context occupancy
(`%/window`) is the only segment that carries a severity colour (warning > 70%,
error > 90%). Facts are folded once per state change, never once per render, so the
streaming hot path only re-layouts the timing segment.

### Themes

Two built-ins — `dark` and `light`, each with pi's full 56-token vocabulary — plus
unlimited user themes loaded from `~/.dsh-neeko/themes/` and pi's
`$PI_AGENT_DIR/themes` (default `~/.pi/agent/themes`). Theme files are plain JSON in
pi's format, so **a theme authored for pi is usable as-is**. A same-named local theme
shadows a pi one; a user theme can never shadow a built-in. Loading is fail-open: an
invalid file is skipped, and a *partial* theme is overlaid on the built-in of its
`appearance` so every token resolves. `DSH_NEEKO_THEME` sets the startup theme.

### Models and reasoning effort

The model picker lists **every configured provider**, not just the active one, with
fuzzy filtering (`step5` matches `group/auto-step-5-preview`). `ctrl+s` writes the
highlighted model as the profile default. Switching models drops the previous
reasoning effort on purpose — carrying it over is what made a switch silently
ineffective. `/thinking` levels come from `llm.resolveModelInfo()` for the exact
route, never hard-coded, because `resolveCallConfig` rejects an unsupported effort
before any provider I/O. Clearing the effort deletes the key entirely, so DSH reads
it as "provider default".

### TUI environment variables

| Variable | Purpose |
|---|---|
| `DSH_NEEKO_THEME` | initial theme name (default `dark`) |
| `DSH_NEEKO_MAIN_SCREEN` | `1` → start on the main screen |
| `DSH_NEEKO_THEMES_DIR` | override the TUI's own theme directory |
| `PI_AGENT_DIR` | pi's agent dir; its `themes/` is scanned too |
| `COLORTERM` | `truecolor`/`24bit` → truecolor, else 256color |

## Project layout

```
dsh-neeko/
+-- package.json
+-- cordis.patch.yml         # bundle patch: startup + bridge rows + TUI row
+-- src/
|   +-- index.ts             # main plugin: bridge, session lifecycle, approval/questions
|   +-- ws-server.ts         # HTTP health endpoint + WebSocket server + handshake
|   +-- protocol.ts          # neutral wire protocol types + envelope helpers
|   +-- dsh-adapter.ts       # DSH events -> protocol translation + history
|   +-- neeko-adapter.ts     # protocol -> DSH API calls
|   +-- agent-handlers.ts    # agent-scoped approval/question waterfall wiring
|   +-- startup.ts           # `dsh --profile neeko` CLI parsing
|   +-- tui/                 # interactive terminal UI (30 modules)
|       +-- runner.ts        # Cordis entry: mounts the TUI, owns the live agent
|       +-- app.ts           # screen assembly, lifecycle, key arbitration
|       +-- transcript.ts    # merges live frames + durable log into rows
|       +-- transcript-view.ts  # row -> pi-tui component (pure)
|       +-- fold.ts          # global switch + per-row fold overrides
|       +-- tool-present.ts  # tool name -> variant, header, summary
|       +-- highlight.ts     # hand-rolled lexical syntax highlighter
|       +-- commands.ts      # slash-command table + pure classification
|       +-- model-panel.ts   # /model picker (fuzzy filter, ctrl+s default)
|       +-- thinking.ts      # /thinking selector
|       +-- theme.ts         # Theme class, user-theme loader, search paths
|       +-- theme-data.ts    # the two built-in palettes
|       +-- theme-tokens.ts  # pi's 56-token vocabulary
|       +-- status-bar.ts    # status-bar formatting (pure)
|       +-- timing.ts        # session timing arithmetic
|       +-- host-facts.ts    # git branch, dsh version, context pressure
|       +-- fullscreen.ts    # alt screen + scroll + click regions
+-- tests/                   # vitest suite (40 spec files)
+-- docs/dsh-neeko-integration.md
```

## Development

```shell
pnpm install      # install + build (prepare script)
pnpm run check    # type-check (src + tests)
pnpm test         # vitest
pnpm run build    # tsdown -> lib/
```

The suite covers protocol envelope round-trips, event translation and history
reconstruction, the Neeko→DSH adapter mapping, the WebSocket server (health,
handshake, invalid-frame rejection, dynamic port fallback), and spawn error
handling — plus the whole TUI surface: transcript merge and retry isolation, row
rendering and fold state, tool-card presentation, syntax highlighting, the model and
theme pickers, the status bar and timing arithmetic, host-command and skill wiring,
fullscreen behaviour, the exit flush barrier, and the repaint cost budget.

`tests/support/fake-terminal.ts` runs the real pi-tui renderer against a recording
terminal so tests never write ANSI into the reporter.

## Known limitations

- `tool.stream` is part of the protocol but DSH core currently logs no tool
  stdout/stderr stream event; it will be wired when such an event exists.
- Reconnect support: the bridge currently disposes the live agent when the
  Neeko connection closes (persisted sessions can be resumed afterwards).
- WS authentication token and multi-session switching are not implemented yet.
- The bridge accepts one active Neeko connection at a time; a new connection
  supersedes the previous one (close code 4000).
- The TUI renders its transcript in full (no virtual scrolling); repaint cost is
  held down by component caching and a coalesced flush window instead.
- `--tui` and `--daemon` coexist without validation: the patch row decides on
  `--tui` alone, so `--tui --daemon` runs the TUI and ignores `--daemon`.

## License

MIT
