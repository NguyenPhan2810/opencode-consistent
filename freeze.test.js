import assert from "node:assert/strict"
import { freezeSessionSystem, resetSnapshots } from "./freeze.js"

resetSnapshots()

const env = ["You are opencode.\n<env>\n  Today's date: Wed Sep 03 2026\n</env>\nAGENTS.md here"]
const later = ["You are opencode.\n<env>\n  Today's date: Thu Sep 04 2026\n</env>\nAGENTS.md changed"]

assert.equal(freezeSessionSystem(undefined, env), "skip")
assert.equal(freezeSessionSystem("s1", []), "skip")
assert.equal(freezeSessionSystem("s1", ["Generate a title"]), "skip")
assert.equal(freezeSessionSystem("s1", env), "snapshot")
assert.equal(freezeSessionSystem("s1", later), "restore")
assert.equal(later[0], env[0])
assert.equal(later.length, 1)

const other = ["<env>\n  Today's date: Wed Sep 03 2026\n</env>\nother project"]
assert.equal(freezeSessionSystem("s2", other), "snapshot")
assert.notEqual(other[0], env[0])

console.log("ok")
