import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAX_SESSIONS = 32
/** JS Date#toDateString: "Thu Sep 03 2026" */
export const DATE_LINE = /Today's date:\s+[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}/
const DATE_VALUE = /Today's date:\s+([A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4})/
export const PART_KEYS = ["env", "agents", "skills", "mcp", "other"]

/** @type {Map<string, object>} */
const snapshots = new Map()

export function digestHex(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12)
}

export function digestSystem(system) {
  if (!Array.isArray(system)) return "-"
  return digestHex(system.join("\n"))
}

/** @returns {"env"|"agents"|"skills"|"mcp"|"other"} */
export function classifyPart(text) {
  const t = String(text ?? "")
  if (/<env>|Today's date:/.test(t)) return "env"
  if (/<available_skills>|available_skills|skill name must match/i.test(t)) return "skills"
  if (/\bMCP\b|mcp server|model context protocol/i.test(t)) return "mcp"
  if (/AGENTS\.md|CLAUDE\.md/.test(t)) return "agents"
  return "other"
}

export function partDigests(system) {
  /** @type {Record<string, string[]>} */
  const buckets = { env: [], agents: [], skills: [], mcp: [], other: [] }
  if (Array.isArray(system)) {
    for (const part of system) buckets[classifyPart(part)].push(String(part ?? ""))
  }
  /** @type {Record<string, string>} */
  const out = {}
  for (const key of PART_KEYS) {
    out[key] = buckets[key].length ? digestHex(buckets[key].join("\n")) : "-"
  }
  return out
}

export function changedPartKeys(prev, next) {
  if (!prev || !next) return []
  return PART_KEYS.filter((key) => (prev[key] ?? "-") !== (next[key] ?? "-"))
}

export function extractDate(system) {
  const text = Array.isArray(system) ? system.join("\n") : typeof system === "string" ? system : ""
  const match = text.match(DATE_VALUE)
  return match ? match[1] : null
}

export function applyDate(system, date) {
  if (!date || !Array.isArray(system)) return false
  let hit = false
  for (let i = 0; i < system.length; i++) {
    if (DATE_LINE.test(system[i])) {
      system[i] = system[i].replace(DATE_LINE, `Today's date: ${date}`)
      hit = true
    }
  }
  return hit
}

export function isEnvBearing(system) {
  return extractDate(system) != null
}

export function stateDir() {
  return process.env.OPENCODE_CONSISTENT_DIR || path.join(os.homedir(), ".local", "state", "opencode", "consistent")
}

function fileFor(sessionID) {
  const safe = String(sessionID).replace(/[^A-Za-z0-9._-]/g, "_")
  return path.join(stateDir(), `${safe}.json`)
}

function cloneParts(parts) {
  if (!parts || typeof parts !== "object") return null
  /** @type {Record<string, string>} */
  const out = {}
  let any = false
  for (const key of PART_KEYS) {
    if (typeof parts[key] === "string") {
      out[key] = parts[key]
      any = true
    }
  }
  return any ? out : null
}

function cloneRecord(rec) {
  return {
    date: rec.date,
    mcp: rec.mcp && Array.isArray(rec.mcp.connected) ? { connected: rec.mcp.connected.slice() } : null,
    savedAt: rec.savedAt,
    sha: typeof rec.sha === "string" ? rec.sha : null,
    lastSha: typeof rec.lastSha === "string" ? rec.lastSha : null,
    parts: cloneParts(rec.parts),
    lastParts: cloneParts(rec.lastParts),
  }
}

export function loadRecord(sessionID) {
  if (!sessionID) return null
  try {
    const raw = fs.readFileSync(fileFor(sessionID), "utf8")
    const parsed = JSON.parse(raw)
    let date = typeof parsed.date === "string" ? parsed.date : null
    if (!date && Array.isArray(parsed.system)) date = extractDate(parsed.system)
    if (!date) return null
    const mcp =
      parsed.mcp && Array.isArray(parsed.mcp.connected) ? { connected: parsed.mcp.connected.map(String) } : null
    return {
      date,
      mcp,
      savedAt: parsed.savedAt,
      sha: typeof parsed.sha === "string" ? parsed.sha : null,
      lastSha: typeof parsed.lastSha === "string" ? parsed.lastSha : null,
      parts: cloneParts(parsed.parts),
      lastParts: cloneParts(parsed.lastParts),
    }
  } catch {
    return null
  }
}

export function saveRecord(sessionID, rec) {
  if (!sessionID || !rec?.date) return
  fs.mkdirSync(stateDir(), { recursive: true })
  const body = { date: rec.date, savedAt: rec.savedAt ?? Date.now() }
  if (rec.mcp && Array.isArray(rec.mcp.connected)) {
    body.mcp = { connected: rec.mcp.connected.slice() }
  }
  if (typeof rec.sha === "string") body.sha = rec.sha
  if (typeof rec.lastSha === "string") body.lastSha = rec.lastSha
  const parts = cloneParts(rec.parts)
  const lastParts = cloneParts(rec.lastParts)
  if (parts) body.parts = parts
  if (lastParts) body.lastParts = lastParts
  fs.writeFileSync(fileFor(sessionID), JSON.stringify(body))
}

export function forgetDisk(sessionID) {
  if (!sessionID) return
  try {
    fs.unlinkSync(fileFor(sessionID))
  } catch {
    /* missing is fine */
  }
}

function remember(sessionID, rec) {
  if (snapshots.has(sessionID)) snapshots.delete(sessionID)
  snapshots.set(sessionID, cloneRecord(rec))
  while (snapshots.size > MAX_SESSIONS) {
    const oldest = snapshots.keys().next().value
    snapshots.delete(oldest)
  }
}

export function peekRecord(sessionID) {
  if (!sessionID) return null
  const live = snapshots.get(sessionID)
  if (live) return cloneRecord(live)
  const disk = loadRecord(sessionID)
  return disk ? cloneRecord(disk) : null
}

/** @returns {"snapshot"|"restore"|"skip"} */
export function freezeSessionSystem(sessionID, system) {
  if (!sessionID || !Array.isArray(system)) return "skip"
  const date = extractDate(system)
  if (!date) return "skip"
  const prev = snapshots.get(sessionID) || loadRecord(sessionID)
  if (!prev) {
    const rec = { date, mcp: null, savedAt: Date.now() }
    remember(sessionID, rec)
    saveRecord(sessionID, rec)
    return "snapshot"
  }
  applyDate(system, prev.date)
  remember(sessionID, prev)
  return "restore"
}

export function setMcpConnected(sessionID, connected) {
  const rec = snapshots.get(sessionID) || loadRecord(sessionID)
  if (!rec) return
  rec.mcp = { connected: [...new Set((connected ?? []).map(String))].sort() }
  remember(sessionID, rec)
  saveRecord(sessionID, rec)
}

/** Record the post-freeze system digest. First turn pins `sha`/`parts`; later turns update `lastSha`/`lastParts`. */
export function recordSystemDigest(sessionID, sha, parts, kind) {
  const rec = snapshots.get(sessionID) || loadRecord(sessionID)
  if (!rec || typeof sha !== "string") return rec
  rec.lastSha = sha
  rec.lastParts = cloneParts(parts)
  if (kind === "snapshot" || !rec.sha) {
    rec.sha = sha
    rec.parts = cloneParts(parts)
  }
  remember(sessionID, rec)
  saveRecord(sessionID, rec)
  return cloneRecord(rec)
}

export function forgetSession(sessionID) {
  if (!sessionID) return
  snapshots.delete(sessionID)
  forgetDisk(sessionID)
}

export function resetSnapshots() {
  snapshots.clear()
}
