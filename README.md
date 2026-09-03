# opencode-consistent

OpenCode rebuilds the system prompt on every turn. In 1.18.27 the `<env>` block is cwd, worktree, git yes/no, platform, and `Today's date: ${new Date().toDateString()}`. Prefix caches hash from token 0, so when the calendar rolls the whole session misses.

AGENTS.md, MCP instructions, and the skill list are re-read from disk. If you did not edit them, a restart already sends the same bytes. This plugin does **not** freeze those, so a mid-session edit still reaches the model (and correctly misses the old prefix).

The other restart miss is MCP **tools**, which are not in the system string. They sit after the built-in tool schemas. If those servers are still connecting, vLLM hashes builtins only (1,792 tokens = 7×256 blocks) and prefills the rest.

This plugin:

1. **Pins `Today's date`** on the first real turn of a `sessionID` and rewrites just that field later, including after quit/reopen.
2. **Waits** in `chat.message` until the same MCP servers are `connected` (or have finished failing) so `SessionTools.resolve` includes the same tool block.

Upstream: [#32622](https://github.com/anomalyco/opencode/issues/32622) (date in the cached prefix, closed not-planned), [#29672](https://github.com/anomalyco/opencode/issues/29672), [PR #29949](https://github.com/anomalyco/opencode/pull/29949) (move env to the tail, not default as of 1.18.27).

## Install

Put it **last** in the plugin list:

```json
{
  "plugin": [
    "opencode-consistent"
  ]
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

```bash
OPENCODE_CONSISTENT_LOG=1 opencode
```

Writes `~/.local/state/opencode/opencode-consistent.log` with `wait ok|timeout` and `snapshot` / `restore date=…`. Restore keeps the first-turn date; `sha=` of the full system string is allowed to move when AGENTS.md or skills change.

## License

MIT
