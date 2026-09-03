import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { freezeSessionSystem, forgetSession } from "./freeze.js"

function digest(system) {
  return createHash("sha256").update(system.join("\n")).digest("hex").slice(0, 12)
}

function logLine(kind, sessionID, system) {
  if (process.env.OPENCODE_CONSISTENT_LOG !== "1") return
  try {
    const dir = path.join(os.homedir(), ".local", "state", "opencode")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "opencode-consistent.log")
    const line = `${new Date().toISOString()} ${kind} session=${sessionID.slice(0, 12)} sha=${digest(system)} parts=${system.length} bytes=${system.join("\n").length}\n`
    fs.appendFileSync(file, line)
  } catch {
    /* logging must never break a turn */
  }
}

export const OpencodeConsistentPlugin = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    const sessionID = input?.sessionID
    const system = output?.system
    const kind = freezeSessionSystem(sessionID, system)
    if (kind !== "skip") logLine(kind, sessionID, system)
  },
  event: async ({ event }) => {
    const type = event?.type
    const id = event?.properties?.sessionID ?? event?.properties?.info?.id
    if (typeof id === "string" && type === "session.deleted") forgetSession(id)
  },
})

export default OpencodeConsistentPlugin
