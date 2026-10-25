import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OpencodeConsistentPlugin, loggingEnabled } from "./index.js"
import { peekRecord, resetSnapshots, forgetSession } from "./freeze.js"

process.env.OPENCODE_CONSISTENT_LOG = "0"
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-consistent-plugin-"))
process.env.OPENCODE_CONSISTENT_DIR = dir

const envA = ["You are opencode.\n<env>\n  Today's date: Wed Sep 03 2026\n</env>\nMCP=one"]
const envB = ["You are opencode.\n<env>\n  Today's date: Thu Sep 04 2026\n</env>\nMCP=two"]

function mockClient(getStatus) {
  return {
    mcp: {
      status: async () => ({ data: getStatus() }),
    },
  }
}

resetSnapshots()
let status = {
  tmux: { status: "disabled" },
  context7: { status: "disabled" },
}
const client = mockClient(() => status)
const plugin = await OpencodeConsistentPlugin(
  { client },
  { mcpWaitMs: 200, mcpWaitIntervalMs: 5 },
)
await plugin.config({
  mcp: {
    tmux: { type: "local", command: ["tmux-mcp"] },
    context7: { type: "remote", url: "https://example" },
    off: { type: "remote", url: "https://off", enabled: false },
  },
})

setTimeout(() => {
  status = {
    tmux: { status: "connected" },
    context7: { status: "connected" },
    off: { status: "disabled" },
  }
}, 20)

await plugin["chat.message"]({ sessionID: "ses_live" })
const first = { system: envA.slice() }
await plugin["experimental.chat.system.transform"]({ sessionID: "ses_live" }, first)
assert.deepEqual(peekRecord("ses_live").mcp.connected, ["context7", "tmux"])

status = {
  tmux: { status: "disabled" },
  context7: { status: "disabled" },
}
setTimeout(() => {
  status = {
    tmux: { status: "connected" },
    context7: { status: "connected" },
  }
}, 20)
await plugin["chat.message"]({ sessionID: "ses_live" })
const later = { system: envB.slice() }
await plugin["experimental.chat.system.transform"]({ sessionID: "ses_live" }, later)
assert.ok(later.system[0].includes("Wed Sep 03 2026"))
assert.ok(later.system[0].includes("MCP=two"), "MCP prose / rest of the prompt stays live")
assert.equal(later.system[0].includes("Thu Sep 04 2026"), false)

forgetSession("ses_live")
fs.writeFileSync(
  path.join(dir, "ses_old.json"),
  JSON.stringify({ system: envA, savedAt: 1 }),
)
resetSnapshots()
status = {
  tmux: { status: "connected" },
  context7: { status: "failed", error: "boom" },
}
const upgrade = await OpencodeConsistentPlugin({ client }, { mcpWaitMs: 0, mcpWaitIntervalMs: 1 })
await upgrade.config({
  mcp: {
    tmux: { type: "local", command: ["tmux-mcp"] },
    context7: { type: "remote", url: "https://example" },
  },
})
await upgrade["chat.message"]({ sessionID: "ses_old" })
const oldOut = { system: envB.slice() }
await upgrade["experimental.chat.system.transform"]({ sessionID: "ses_old" }, oldOut)
assert.ok(oldOut.system[0].includes("Wed Sep 03 2026"))
assert.ok(oldOut.system[0].includes("MCP=two"))
assert.deepEqual(peekRecord("ses_old").mcp.connected, ["tmux"])

const title = { system: ["Name this chat"] }
assert.equal(
  (await (async () => {
    await plugin["experimental.chat.system.transform"]({ sessionID: "ses_old" }, title)
    return title.system[0]
  })()),
  "Name this chat",
)

fs.rmSync(dir, { recursive: true, force: true })

const prevLog = process.env.OPENCODE_CONSISTENT_LOG
delete process.env.OPENCODE_CONSISTENT_LOG
assert.equal(loggingEnabled(), true)
process.env.OPENCODE_CONSISTENT_LOG = "0"
assert.equal(loggingEnabled(), false)
process.env.OPENCODE_CONSISTENT_LOG = prevLog

console.log("ok plugin")
