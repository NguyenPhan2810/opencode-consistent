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

fs.rmSync(dir, { recursive: true, force: true })
console.log("ok freeze")
