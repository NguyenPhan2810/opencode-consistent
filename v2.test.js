import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "./index.js"
import { loadSnapshot, forgetSnapshot, systemText } from "./v2.js"

process.env.OPENCODE_CONSISTENT_LOG = "0"
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-consistent-v2-"))
process.env.OPENCODE_CONSISTENT_DIR = dir

// Real GET /api/mcp shape: { data: [{ name, status: { status } }] }
function fakeCtx({ statuses = {}, options = {} } = {}) {
  const hooks = {}
  const asArray = () => Object.entries(statuses).map(([name, status]) => ({ name, status }))
  return {
    options,
    mcp: { list: async () => ({ data: asArray() }) },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback
        return { dispose: async () => delete hooks[name] }
      },
    },
    hooks,
  }
}

const envA = { type: "text", text: "You are opencode.\n<env>\n  Today's date: Wed Sep 03 2026\n</env>" }
const agentsA = { type: "text", text: "AGENTS.md: build the thing" }
const skillsA = { type: "text", text: "<available_skills>alpha</available_skills>" }
const envB = { type: "text", text: "You are opencode.\n<env>\n  Today's date: Thu Sep 04 2026\n</env>" }
const skillsB = { type: "text", text: "<available_skills>alpha beta</available_skills>" }

const toolsA = {
  read: { description: "read a file", input: { type: "object" } },
  bash: { description: "run a command", input: { type: "object" } },
}

// --- 1. first call snapshots, later calls restore the frozen head ----------
const ctx = fakeCtx({ statuses: { tmux: { status: "connected" } } })
const cleanup = await plugin.setup(ctx)
assert.equal(typeof ctx.hooks.context, "function", "setup registers a session context hook")

const first = { sessionID: "ses_v2", system: [envA, agentsA, skillsA], messages: [], tools: { ...toolsA } }
const t0 = Date.now()
await ctx.hooks.context(first)
assert.ok(Date.now() - t0 < 1000, "connected MCP servers must not stall the first turn")
const snap = loadSnapshot("ses_v2")
assert.ok(snap, "snapshot persisted")
assert.equal(snap.date, "Wed Sep 03 2026")
assert.equal(snap.system.length, 3)
assert.deepEqual(snap.tools, ["bash", "read"])
// the conversation a compaction request would need comes from here
const withTurns = {
  sessionID: "ses_v2",
  system: [envB, agentsA, skillsB],
  messages: [
    { role: "user", content: [{ type: "text", text: "make a RingBuffer" }] },
    { role: "assistant", content: [{ type: "text", text: "here it is " + "detail ".repeat(400) }] },
  ],
  tools: { ...toolsA },
}
await ctx.hooks.context(withTurns)
const snapTurns = loadSnapshot("ses_v2")
assert.ok(Array.isArray(snapTurns.compactionMessages), "the conversation is kept for a compaction rewrite")
assert.equal(snapTurns.compactionMessages.length, 2, "both turns stored")
assert.equal(snapTurns.compactionChars > 0, true, "its size is recorded")

// second call: new date, new skill, an MCP tool that connected late
const second = {
  sessionID: "ses_v2",
  system: [envB, agentsA, skillsB],
  messages: [],
  tools: { ...toolsA, late_tool: { description: "connected late", input: { type: "object" } } },
}
await ctx.hooks.context(second)
const restoredText = systemText(second.system)
assert.ok(restoredText.includes("Wed Sep 03 2026"), "date restored to the snapshot")
assert.equal(restoredText.includes("Thu Sep 04 2026"), false, "new date never reaches the model")
assert.ok(restoredText.includes("<available_skills>alpha</available_skills>"), "skills block frozen")
assert.ok(restoredText.includes("build the thing"), "agents block frozen")
assert.equal("late_tool" in second.tools, false, "tool that arrived after the snapshot is dropped")
assert.ok("read" in second.tools && "bash" in second.tools, "snapshot tools survive")

// --- 1b. a tool that DISAPPEARS is put back, so the block cannot move ------
const third = {
  sessionID: "ses_v2",
  system: [envB, agentsA, skillsB],
  messages: [],
  tools: { read: toolsA.read }, // bash went away (an MCP server or preset dropped it)
}
await ctx.hooks.context(third)
assert.ok("bash" in third.tools, "a tool that went away is restored from the snapshot")
assert.deepEqual(third.tools.bash, toolsA.bash, "restored definition is byte-identical")
assert.equal(Object.keys(third.tools).sort().join(","), "bash,read", "the tool block is exactly the snapshot's")

// --- 2. a fresh process (service restart) still restores from disk ---------
const ctx2 = fakeCtx({ statuses: { tmux: { status: "connected" } } })
await plugin.setup(ctx2)
const afterRestart = { sessionID: "ses_v2", system: [envB, agentsA, skillsB], messages: [], tools: { ...toolsA } }
await ctx2.hooks.context(afterRestart)
assert.ok(systemText(afterRestart.system).includes("Wed Sep 03 2026"), "disk snapshot survives a restart")

// --- 3. parts appended by the runtime stay (tail change, head intact) ------
const withExtra = { sessionID: "ses_v2", system: [envB, agentsA, skillsB, { type: "text", text: "NEW: mid-session note" }], messages: [], tools: { ...toolsA } }
await ctx2.hooks.context(withExtra)
assert.ok(systemText(withExtra.system).includes("Wed Sep 03 2026"), "head still frozen with an extra part")
assert.ok(systemText(withExtra.system).includes("NEW: mid-session note"), "appended part is kept, not swallowed")
assert.ok(systemText(withExtra.system).indexOf("Wed Sep 03 2026") < systemText(withExtra.system).indexOf("NEW: mid-session note"), "appended part sits after the frozen head")

// --- 4. mode=date leaves the rest live ------------------------------------
forgetSnapshot("ses_date")
const ctxDate = fakeCtx({ statuses: {}, options: { freeze: "date" } })
await plugin.setup(ctxDate)
const d1 = { sessionID: "ses_date", system: [envA, agentsA], messages: [], tools: {} }
await ctxDate.hooks.context(d1)
const d2 = { sessionID: "ses_date", system: [envB, agentsA], messages: [], tools: {} }
await ctxDate.hooks.context(d2)
const dateText = systemText(d2.system)
assert.ok(dateText.includes("Wed Sep 03 2026"), "date-only mode pins the date")
assert.equal(dateText.includes("Thu Sep 04 2026"), false)

// --- 5. MCP wait: connecting servers are waited for, then snapshotted ------
forgetSnapshot("ses_wait")
let status = { tmux: { status: "disabled" } }
const ctxWait = fakeCtx({ options: { mcpWaitMs: 400, mcpWaitIntervalMs: 5 } })
ctxWait.mcp.list = async () => {
  if (status.tmux.status === "disabled") status = { tmux: { status: "connected" } }
  return { data: status }
}
await plugin.setup(ctxWait)
await ctxWait.hooks.context({ sessionID: "ses_wait", system: [envA], messages: [], tools: {} })
assert.ok(loadSnapshot("ses_wait"), "waited, then snapshotted")

// --- 6. a compaction request is rebuilt from the real conversation ---------
const { makeCompactionHook } = await import("./v2.js")
let logged = ""
const compact = makeCompactionHook(ctx, { rewriteCompaction: true, log: (line) => (logged = line) })
const instruction = { role: "user", content: [{ type: "text", text: "summarize the conversation above" }] }
const compactionEvent = {
  sessionID: "ses_v2",
  system: [envB],
  messages: [
    { role: "user", content: [{ type: "text", text: "## User\nSummary of older exchanges (omitted)" }] },
    instruction,
  ],
  tools: {}, // OpenCode sends tools: [] — the whole reason the prefix is lost
}
await compact(compactionEvent)
assert.equal(compactionEvent.messages.length, 2, "the real conversation replaced the rendered transcript")
assert.ok(JSON.stringify(compactionEvent.messages).includes("detail detail"), "the stored content is what goes out")
assert.equal(JSON.stringify(compactionEvent.messages).includes("summarize the conversation above"), false, "no instruction is appended: the harness adds its own")
assert.equal(Object.keys(compactionEvent.tools).sort().join(","), "bash,read", "the tool block is restored")
assert.match(logged, /rewritten messages=2/, logged)

// --- 7. cleanup disposes the registration --------------------------------
await cleanup()
assert.equal(ctx.hooks.context, undefined, "cleanup disposes the hook")

fs.rmSync(dir, { recursive: true, force: true })
console.log("ok v2")
