# opencode-consistent

**Stop paying for prefill.** OpenCode rebuilds the system prompt every turn — date,
AGENTS.md, skills, MCP prose, tool schemas. The moment any of it shifts, the engine's prefix
cache misses and it recomputes the *entire* prompt: minutes of prefill on a large session, and
it happens on `/compact` too. This plugin freezes the head, so the cache keeps hitting.

Measured on a DeepSeek-V4.1 cluster: a **643,411-token `/compact` resumed 641,024
tokens from cache** and computed 2,387 — instead of prefilling from zero. A tool appearing or
disappearing mid-session no longer costs the whole conversation either.

It is not an engine patch: the client is the only place that can stop moving the head.

## OpenCode V2 (2.x) — the entry that matters now

V2 removed `experimental.chat.system.transform` and **stops loading a plugin whose
configured path is a file** (`configured plugin path must be a directory`). The old
`file://…/index.js` entry therefore loaded nothing at all, silently, from 2.x on.

This package now carries a V2 entrypoint (`v2.js`) and must be loaded by
**directory**:

```json
{
  "plugins": ["file:///home/nguyen/dev/opencode-consistent"]
}
```

It registers `ctx.session.hook("context")` and rewrites `event.system` (the
assembled SystemPart[] for the outgoing call) so the head of the prompt is
byte-identical to the session's first turn. Snapshot is one JSON per session under
`~/.local/state/opencode/consistent/`, so a resumed session — even across an
OpenCode service restart — keeps the head it was stored under.

Options (plugin object form or env):

| Option | Default | Meaning |
|---|---|---|
| `freeze` | `all` | `all` = env + AGENTS + skills + MCP prose frozen; `date` = old behaviour, only `Today's date` pinned |
| `freezeTools` | `true` | hold the tool block still in **both** directions: a tool that appears *after* the snapshot is dropped, and one that disappears is put back from the snapshot's stored definitions. The tool block sits ahead of the conversation, so either change moves the head; a call to a tool that has gone away now fails at the tool instead of costing a full re-prefill. Snapshots made before 0.6.0 have ids only, so a removal is a no-op for them until the next session. |
| `mcpWaitMs` | `5000` | wait for MCP servers to settle before the first snapshot (only the first turn) |

### Compaction

A compaction request does **not** pass through the `context` hook, so without this plugin its system
block goes out live rather than frozen and the request rewrites the head — the engine then resumes
only a head-sized tail (`cache.read` 0–20,480 on 400 k–800 k prompts) and prefills the rest.

The plugin registers `session.hook("compaction", …)` and freezes the head there exactly as it does for
`context`: system parts restored from the session snapshot, and the tool block held in **both**
directions. The compaction request then shares the session's prefix, so only the instruction and the
messages since the last turn are computed and the summary is decoded.

Measured on a real manual compaction (2026-11-08, `ses_e44304e3`): `input` 3,234, `cache.read`
137,216 — identical to the preceding normal turn (`input` 2,039, `cache.read` 137,216) — against
579,597 → 0 before the fix. The plugin log line is `compaction session=… head restored=… mismatch=…
tools_added=… tools_dropped=… tools_readded=…`.

The conversation itself is only re-rendered upstream when it does **not** fit the model window; when
that happens the request carries a transcript, not the messages. `rewriteCompaction` (default `false`)
then substitutes the real messages captured from the previous turns; on an ordinary compaction it is a
no-op, and the log's `rendered=0` shows that.

| Option | Default | Meaning |
|---|---|---|
| `compactionMaxMb` | `16` | Cap on the conversation kept per session for the rewrite; past it, no capture and no rewrite. |
| `rewriteCompaction` | `false` | Only acts when a rendered transcript appears (conversation over the window); a no-op otherwise. |

Env fallbacks: `OPENCODE_CONSISTENT_FREEZE`, `OPENCODE_CONSISTENT_MCP_WAIT_MS`.

Trade-off, stated plainly: with `freeze=all`, editing `AGENTS.md` or installing a
skill mid-session does not reach that session; the next session gets it. That is
the price of a stable prefix, and it is the same choice upstream made in #48777
(they freeze env/instructions/MCP per session).

Every turn writes one line to `~/.local/state/opencode/opencode-consistent.log`
with the system digest and a per-part diff (`env`, `agents`, `skills`, `mcp`,
`other`), plus `tools_added` / `tools_dropped`. When a cache miss happens, that
line names the component that moved instead of leaving it to forensics.

## V1 (1.18.x)

OpenCode rebuilds the system prompt on every turn. In 1.18.27 the `<env>` block is cwd, worktree, git yes/no, platform, and `Today's date: ${new Date().toDateString()}`. Prefix caches hash from token 0, so when the calendar rolls the whole session misses.

AGENTS.md, MCP instructions, and the skill list are re-read from disk. If you did not edit them, a restart already sends the same bytes. This plugin does **not** freeze those, so a mid-session edit still reaches the model (and correctly misses the old prefix).

The other restart miss is MCP **tools**, which are not in the system string. They sit after the built-in tool schemas. If those servers are still connecting, vLLM hashes builtins only (1,792 tokens = 7×256 blocks) and prefills the rest.

This plugin:

1. **Pins `Today's date`** on the first real turn of a `sessionID` and rewrites just that field later, including after quit/reopen.
2. **Waits** in `chat.message` until the same MCP servers are `connected` (or have finished failing) so `SessionTools.resolve` includes the same tool block.

Upstream: [#32622](https://github.com/anomalyco/opencode/issues/32622) (date in the cached prefix, closed not-planned), [#29672](https://github.com/anomalyco/opencode/issues/29672), [PR #29949](https://github.com/anomalyco/opencode/pull/29949) (move env to the tail, not default as of 1.18.27).

## Install

Published on npm as `opencode-consistent`. V2 loads plugins by **directory**, so install it
into your OpenCode config directory and point at the package directory:

```bash
cd ~/.config/opencode && npm i opencode-consistent
```

```json
{
  "plugins": ["file:///home/<you>/.config/opencode/node_modules/opencode-consistent"]
}
```

A clone works the same way — point at its directory (`file:///home/<you>/dev/opencode-consistent`).

On V1, name the package instead and put it **last** in the list:

```json
{
  "plugin": ["opencode-consistent"]
}
```

Optional wait budget (milliseconds). Default `15000`. `0` polls once and does not block.

```json
{
  "plugin": [
    ["opencode-consistent", { "mcpWaitMs": 20000 }]
  ]
}
```

Same value via `OPENCODE_CONSISTENT_MCP_WAIT_MS`. Restart OpenCode. Plugins load at process start.

## What it freezes

`Today's date` per `sessionID`, on disk under `~/.local/state/opencode/consistent/`.

The list of MCP server names that were `connected` when that date was first pinned. Later turns wait until those names are `connected` again.

Title-generation has no date line. Those calls are ignored.

## What it does not freeze

AGENTS.md, cwd, skills, MCP instruction prose. Change them and the next turn is live — and a new prefix hash.

Tool JSON schemas. The plugin cannot inject a missing MCP tool. If a server is still down after `mcpWaitMs`, or it advertises different tools, the hash still misses after the built-in set.

`/compact` still rewrites history.

## Debug

Logging is **on by default**. Writes `~/.local/state/opencode/opencode-consistent.log` with `wait ok|timeout` and each `snapshot` / `restore`.

Each system-transform line has:

- `sha=` current full system digest (12 hex)
- `snap=` first-turn digest for this `sessionID` (pinned on disk)
- `prev=` previous turn
- `vs_snap=` / `vs_last=` which buckets moved (`env`, `agents`, `skills`, `mcp`, `other`)
- per-bucket digests: `env=` `agents=` `skills=` `mcp=` `other=` (`-` if that bucket was empty)

`sha` is allowed to move when AGENTS.md, skills, or MCP prose change; the date field stays pinned. `vs_snap=mcp` on an overnight resume means the MCP instruction block changed, not the calendar.

```bash
OPENCODE_CONSISTENT_LOG=0 opencode   # disable
```

Restart OpenCode after a plugin edit. Plugins load at process start.

## License

MIT
