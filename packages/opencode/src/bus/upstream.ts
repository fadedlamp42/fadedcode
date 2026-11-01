import { GlobalBus, type GlobalEvent } from "@/bus/global"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "bus.upstream" })

// how many upstream event ids we remember for duplicate suppression. the two
// buses carry disjoint events in practice (each process only publishes what it
// itself executed), so this guards the theoretical double-delivery case after
// a reconnect replays an event we already forwarded.
const SEEN_ID_CAPACITY = 1024

// events the upstream stream synthesizes for its own transport; they describe
// the upstream connection, not any session, so forwarding them would lie to
// every consumer that believes it is hearing about its own server.
const TRANSPORT_EVENT_TYPES = new Set(["server.connected", "server.heartbeat"])

/**
 * bridges another opencode server's global event stream onto this process's
 * GlobalBus.
 *
 * why this exists: a plain `opencode` TUI hosts its whole server inside a Bun
 * worker, while a long-lived `opencode serve` (the pm2 app on :8397) is a
 * separate process. the two share one sqlite but each has its own in-memory
 * GlobalBus, so a turn injected through the serve (an agent bus message, a
 * bot-driven round) writes rows this process can read but never hears about,
 * and an attached TUI renders a transcript that is silently missing turns.
 * tapping the serve's `/global/event` SSE stream and re-emitting each event
 * here lets every existing consumer (the TUI render path, toasts, session
 * list) converge without any of them changing: the payloads already carry the
 * directory/project stamps the downstream filters key on.
 *
 * the tap is deliberately dumb: no Effect machinery, one reconnect loop with
 * capped backoff, forward everything except the upstream's own transport
 * heartbeats. it never throws; a dead upstream degrades to exactly the
 * pre-tap behavior.
 */
export function startUpstreamEventTap(upstreamUrl: string): void {
  const endpoint = new URL("/global/event", upstreamUrl).toString()
  const seenIds: string[] = []
  const seenIdSet = new Set<string>()

  const remember = (id: string): boolean => {
    if (seenIdSet.has(id)) return false
    seenIdSet.add(id)
    seenIds.push(id)
    if (seenIds.length > SEEN_ID_CAPACITY) {
      const evicted = seenIds.shift()
      if (evicted) seenIdSet.delete(evicted)
    }
    return true
  }

  const forward = (raw: string): void => {
    const event = parseGlobalEvent(raw)
    if (!event) return
    const payloadType = event.payload?.type
    if (typeof payloadType === "string" && TRANSPORT_EVENT_TYPES.has(payloadType)) return
    const payloadId = event.payload?.id
    if (typeof payloadId === "string" && !remember(payloadId)) return
    GlobalBus.emit("event", event)
  }

  const run = async (): Promise<void> => {
    let backoffMs = 500
    while (true) {
      try {
        const response = await fetch(endpoint, { headers: { accept: "text/event-stream" } })
        if (!response.ok || !response.body) throw new Error(`upstream responded ${response.status}`)
        log.info("upstream event tap connected", { endpoint })
        backoffMs = 500
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // SSE frames are separated by a blank line; each frame's data lines
          // carry one JSON-encoded GlobalEvent.
          let frameEnd = buffer.indexOf("\n\n")
          while (frameEnd !== -1) {
            const frame = buffer.slice(0, frameEnd)
            buffer = buffer.slice(frameEnd + 2)
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            if (data) forward(data)
            frameEnd = buffer.indexOf("\n\n")
          }
        }
        log.info("upstream event stream ended, reconnecting", { endpoint })
      } catch (error) {
        log.warn("upstream event tap disconnected", {
          endpoint,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
      backoffMs = Math.min(backoffMs * 2, 15_000)
    }
  }

  void run()
}

function parseGlobalEvent(raw: string): GlobalEvent | undefined {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && "payload" in parsed) return parsed as GlobalEvent
    return undefined
  } catch {
    return undefined
  }
}
