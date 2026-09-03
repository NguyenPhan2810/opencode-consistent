# opencode-consistent

OpenCode rebuilds the system prompt on every turn. `Today's date`, cwd, git, AGENTS.md, MCP instructions, and the skill list all go back in from live disk. Prefix caches hash from token 0, so one changed byte after the tools block misses the whole session.

This plugin snapshots that system prefix on the first real turn of a session and puts the same bytes back on every later turn. The snapshot is written under `~/.local/state/opencode/consistent/` so a quit/reopen of the same `sessionID` still sends the old envelope. Time can land at session start. It does not move while you work, and it does not move when you reopen the same session.

Measured on a homelab vLLM pair: a 186k OpenCode resume after 60 minutes idle came back with 1,792 cached tokens (the built-in tool schemas) and prefilling the rest. Sibling sessions on the same key were at 99.9%. The GPU still had the old prefix. OpenCode had sent a different one.

Upstream knows. [#32622](https://github.com/anomalyco/opencode/issues/32622) (date in the cached prefix, closed not-planned), [#29672](https://github.com/anomalyco/opencode/issues/29672), [PR #29949](https://github.com/anomalyco/opencode/pull/29949) (move env to the tail, not default as of 1.18.27). `OPENCODE_EXPERIMENTAL_CACHE_STABILIZATION` did not ship in 1.18.x runtime flags.

## Install

Put it **last** in the plugin list so other plugins mutate first, then this freezes the result:

```json
{
  "plugin": [
    "opencode-consistent"
  ]
}
```

Restart OpenCode. Plugins load at process start.

## What it freezes

The joined system string OpenCode sends to the model (env + instructions + MCP instructions + skills). Per `sessionID`, in memory, for that process.

Title-generation uses the same sessionID with no `<env>` block. Those calls are ignored so they cannot poison the snapshot.

## What it does not freeze

The MCP **tool list**. If a server appears or disappears mid-session, tool schemas after the built-in set can still break the hash. Env/date/AGENTS.md will not.

Quit/reopen of the **same session** reloads the snapshot from disk. The first send after reopen should hash-match the last send before quit (system envelope). A **new** session still snapshots live env/date once.

MCP **tool list** is not in this hook. If a server is down at the first send after reopen, tool schemas after the built-in set can still miss. Env/date/AGENTS.md will not.

`/compact` still rewrites history. The system prefix stays; the conversation after it is a new hash.

## Debug

```bash
OPENCODE_CONSISTENT_LOG=1 opencode
```

Writes `~/.local/state/opencode/opencode-consistent.log` with `snapshot` / `restore` and a 12-char sha of the frozen bytes. Same sha on restore means it held.

## License

MIT
