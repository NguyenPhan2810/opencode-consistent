import assert from "node:assert/strict"
import {
  wantedServers,
  connectedNames,
  isSettled,
  hasConnected,
  waitUntil,
  waitMsFrom,
  DEFAULT_WAIT_MS,
} from "./wait.js"

assert.deepEqual(
  wantedServers({
    tmux: { type: "local", command: ["tmux-mcp"] },
    off: { type: "remote", url: "http://x", enabled: false },
    context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
  }),
  ["context7", "tmux"],
)
assert.deepEqual(wantedServers(undefined), [])
assert.deepEqual(wantedServers({ skip: "not-an-object" }), [])

assert.deepEqual(
  connectedNames({
    tmux: { status: "connected" },
    off: { status: "disabled" },
    dead: { status: "failed", error: "boom" },
    auth: { status: "needs_auth" },
  }),
  ["tmux"],
)

assert.equal(isSettled({ a: { status: "disabled" } }, ["a"]), false)
assert.equal(isSettled({ a: { status: "connected" } }, ["a"]), true)
assert.equal(isSettled({ a: { status: "failed", error: "x" } }, ["a"]), true)
assert.equal(isSettled({ a: { status: "needs_auth" } }, ["a"]), true)
assert.equal(isSettled({}, ["a"]), false)
assert.equal(isSettled({}, []), true)

assert.equal(hasConnected({ a: { status: "connected" }, b: { status: "connected" } }, ["a"]), true)
assert.equal(hasConnected({ a: { status: "connected" } }, ["a", "b"]), false)
assert.equal(hasConnected({}, []), true)

assert.equal(waitMsFrom(20_000), 20_000)
assert.equal(waitMsFrom("0"), 0)
assert.equal(waitMsFrom(undefined), DEFAULT_WAIT_MS)

const polls = [{ a: { status: "disabled" } }, { a: { status: "connected" } }]
let i = 0
const hit = await waitUntil({
  poll: async () => polls[Math.min(i++, polls.length - 1)],
  ok: (status) => isSettled(status, ["a"]),
  timeoutMs: 1000,
  intervalMs: 1,
  sleep: async () => {},
})
assert.equal(hit.ok, true)
assert.equal(hit.timedOut, false)
assert.equal(i, 2)

const miss = await waitUntil({
  poll: async () => ({ a: { status: "disabled" } }),
  ok: (status) => isSettled(status, ["a"]),
  timeoutMs: 0,
  intervalMs: 1,
  sleep: async () => {
    throw new Error("should not sleep when timeout is 0")
  },
})
assert.equal(miss.ok, false)
assert.equal(miss.timedOut, true)

console.log("ok wait")
