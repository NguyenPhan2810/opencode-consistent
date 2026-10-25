import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  freezeSessionSystem,
  resetSnapshots,
  forgetSession,
  stateDir,
  peekRecord,
  setMcpConnected,
  loadRecord,
  extractDate,
  classifyPart,
  partDigests,
  digestSystem,
  changedPartKeys,
  recordSystemDigest,
} from "./freeze.js"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-consistent-"))
process.env.OPENCODE_CONSISTENT_DIR = dir

const envA = ["You are opencode.\n<env>\n  Today's date: Wed Sep 03 2026\n</env>\nPROBE_MARKER=AAA"]
const envB = ["You are opencode.\n<env>\n  Today's date: Thu Sep 04 2026\n</env>\nPROBE_MARKER=BBB"]

resetSnapshots()
assert.equal(freezeSessionSystem("s1", envA.slice()), "snapshot")
assert.equal(fs.existsSync(path.join(stateDir(), "s1.json")), true)
assert.equal(peekRecord("s1").date, "Wed Sep 03 2026")
assert.equal(peekRecord("s1").mcp, null)

const live = envB.slice()
assert.equal(freezeSessionSystem("s1", live), "restore")
assert.equal(extractDate(live), "Wed Sep 03 2026")
assert.ok(live[0].includes("BBB"), "AGENTS.md / rest of the prompt stays live")
assert.equal(live[0].includes("AAA"), false)

resetSnapshots()
const afterRestart = envB.slice()
assert.equal(freezeSessionSystem("s1", afterRestart), "restore", "disk date survives process restart")
assert.equal(extractDate(afterRestart), "Wed Sep 03 2026")
assert.ok(afterRestart[0].includes("BBB"))

setMcpConnected("s1", ["tmux", "context7"])
const rec = loadRecord("s1")
assert.equal(rec.date, "Wed Sep 03 2026")
assert.deepEqual(rec.mcp.connected, ["context7", "tmux"])
assert.equal("system" in JSON.parse(fs.readFileSync(path.join(stateDir(), "s1.json"), "utf8")), false)

resetSnapshots()
assert.deepEqual(peekRecord("s1").mcp.connected, ["context7", "tmux"])

forgetSession("s1")
assert.equal(fs.existsSync(path.join(stateDir(), "s1.json")), false)
resetSnapshots()
assert.equal(freezeSessionSystem("s1", envB.slice()), "snapshot")
assert.equal(peekRecord("s1").date, "Thu Sep 04 2026")

fs.writeFileSync(path.join(stateDir(), "legacy.json"), JSON.stringify({ system: envA, savedAt: 1 }))
resetSnapshots()
const legacy = envB.slice()
assert.equal(freezeSessionSystem("legacy", legacy), "restore")
assert.equal(extractDate(legacy), "Wed Sep 03 2026")
assert.ok(legacy[0].includes("BBB"), "legacy system[] only donates the date")
assert.equal(peekRecord("legacy").mcp, null)

const title = ["Name this chat"]
assert.equal(freezeSessionSystem("legacy", title), "skip")
assert.equal(title[0], "Name this chat")

assert.equal(classifyPart("<env>\n  Today's date: Wed Sep 03 2026\n</env>"), "env")
assert.equal(classifyPart("Read AGENTS.md before editing."), "agents")
assert.equal(classifyPart("<available_skills>\n- foo\n</available_skills>"), "skills")
assert.equal(classifyPart("MCP server homelab-tools is available."), "mcp")
assert.equal(classifyPart("plain identity"), "other")

const mixed = [
  "You are opencode.\n<env>\n  Today's date: Wed Sep 03 2026\n</env>",
  "# AGENTS.md\nrules",
  "<available_skills>x</available_skills>",
  "MCP server tmux connected.",
]
const d1 = partDigests(mixed)
const d2 = partDigests(mixed)
assert.deepEqual(d1, d2)
assert.notEqual(d1.env, "-")
assert.notEqual(d1.agents, "-")
assert.notEqual(d1.skills, "-")
assert.notEqual(d1.mcp, "-")
assert.equal(d1.other, "-")
const drifted = partDigests([mixed[0], "# AGENTS.md\nrules changed", mixed[2], mixed[3]])
assert.deepEqual(changedPartKeys(d1, drifted), ["agents"])
assert.equal(digestSystem(mixed).length, 12)

resetSnapshots()
assert.equal(freezeSessionSystem("s2", envA.slice()), "snapshot")
const shaA = digestSystem(envA)
recordSystemDigest("s2", shaA, partDigests(envA), "snapshot")
assert.equal(peekRecord("s2").sha, shaA)
const shaB = digestSystem(envB)
recordSystemDigest("s2", shaB, partDigests(envB), "restore")
assert.equal(peekRecord("s2").sha, shaA, "first-turn sha stays pinned")
assert.equal(peekRecord("s2").lastSha, shaB)

fs.rmSync(dir, { recursive: true, force: true })
console.log("ok freeze")
