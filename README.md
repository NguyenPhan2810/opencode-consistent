# opencode-consistent

OpenCode rebuilds the system prompt on every turn. `Today's date`, cwd, git, AGENTS.md, MCP instructions, and the skill list all go back in from live disk. MCP tools are appended after the built-in set from whatever servers happen to be connected *right now*. Prefix caches hash from token 0, so one changed byte after the tools block misses the whole session.

This plugin does two things per `sessionID`:

1. **Wait** in `chat.message` (before OpenCode resolves tools) until the same MCP servers are connected, or until they have finished failing.
2. **Freeze** the system prefix on the first real turn and put those bytes back on every later turn.

The snapshot is written under `~/.local/state/opencode/consistent/` so a quit/reopen of the same `sessionID` still sends the old envelope and still waits for the same MCP servers. Time can land at session start. It does not move while you work, and it does not move when you reopen the same session.

Measured on a homelab vLLM pair: a 186k OpenCode resume after 60 minutes idle came back with 1,792 cached tokens (the built-in tool schemas, 7×256-token blocks) and prefilling the rest. Sibling sessions on the same key were at 99.9%. The GPU still had the old prefix. OpenCode had sent a different one — MCP tools were missing because those servers were not connected yet.

Upstream knows. [#32622](https://github.com/anomalyco/opencode/issues/32622) (date in the cached prefix, closed not-planned), [#29672](https://github.com/anomalyco/opencode/issues/29672), [PR #29949](https://github.com/anomalyco/opencode/pull/29949) (move env to the tail, not default as of 1.18.27). `OPENCODE_EXPERIMENTAL_CACHE_STABILIZATION` did not ship in 1.18.x runtime flags.

OpenCode 1.18.27 has no plugin hook that can add or remove tools. `tool.definition` only rewrites description/parameters of tools that already exist, and it is not called for MCP tools. Waiting until OpenCode itself sees the same connected set is the lever that exists.

## Install

Put it **last** in the plugin list so other plugins mutate first, then this freezes the result:

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

The joined system string OpenCode sends to the model (env + instructions + MCP instructions + skills). Per `sessionID`, on disk.

The list of MCP server names that were `connected` when that snapshot was taken. Later turns, including after reopen, wait until those names are `connected` again so `SessionTools.resolve` includes the same MCP tool block.

Title-generation uses the same sessionID with no `<env>` block. Those calls are ignored so they cannot poison the snapshot.

## What it does not freeze

Tool JSON schemas. The plugin cannot inject a missing MCP tool or strip an extra one. If a server is still down after `mcpWaitMs`, or if a server changes the tools it advertises, the hash still misses after the built-in set.

`/compact` still rewrites history. The system prefix stays; the conversation after it is a new hash.

A **new** session still snapshots live env/date/MCP once, after the first-turn wait.

## Debug

```bash
OPENCODE_CONSISTENT_LOG=1 opencode
```

Writes `~/.local/state/opencode/opencode-consistent.log` with `wait ok|timeout`, then `snapshot` / `restore` and a 12-char sha of the frozen bytes. Same sha on restore means the system envelope held. `connected=` is the MCP set that wait observed.

## License

MIT
