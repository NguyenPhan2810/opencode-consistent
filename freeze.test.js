import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  freezeSessionSystem,
  resetSnapshots,
  forgetSession,
  stateDir,
} from "./freeze.js"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-consistent-"))
process.env.OPENCODE_CONSISTENT_DIR = dir

const envA = ["You are opencode.\n<env>\n  Today's date: Wed Sep 03 2026\n</env>\nPROBE_MARKER=AAA"]
const envB = ["You are opencode.\n<env>\n  Today's date: Thu Sep 04 2026\n</env>\nPROBE_MARKER=BBB"]

resetSnapshots()
assert.equal(freezeSessionSystem("s1", envA.slice()), "snapshot")
assert.equal(fs.existsSync(path.join(stateDir(), "s1.json")), true)

const live = envB.slice()
assert.equal(freezeSessionSystem("s1", live), "restore")
assert.equal(live[0], envA[0])

resetSnapshots()
const afterRestart = envB.slice()
assert.equal(freezeSessionSystem("s1", afterRestart), "restore", "disk snapshot survives process restart")
assert.equal(afterRestart[0], envA[0])
assert.ok(afterRestart[0].includes("AAA"))
assert.equal(afterRestart[0].includes("BBB"), false)

forgetSession("s1")
assert.equal(fs.existsSync(path.join(stateDir(), "s1.json")), false)
resetSnapshots()
assert.equal(freezeSessionSystem("s1", envB.slice()), "snapshot")

fs.rmSync(dir, { recursive: true, force: true })
console.log("ok")
