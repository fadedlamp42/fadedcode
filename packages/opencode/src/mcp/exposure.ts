import type { ConfigMCP } from "@/config/mcp"

/**
 * Pure exposure arithmetic for per-session MCP tool visibility.
 *
 * Every session starts with zero MCP tools exposed. The only standing exceptions are switchboard
 * pins (`!name` / `!name:prefix` lines in MCP_SERVERS), and a session layers its own show/hide
 * overrides on top of those. These helpers keep that arithmetic out of the MCP service so it can
 * be tested without connecting anything.
 */

/** collect session-start exposure from the resolved config's `pinned` fields. */
export function pins(servers: Record<string, { pinned?: ConfigMCP.Pinned } | undefined>): ConfigMCP.Exposure {
  const result: ConfigMCP.Exposure = {}
  for (const [name, server] of Object.entries(servers)) {
    if (!server?.pinned) continue
    result[name] = server.pinned === true ? "all" : [...server.pinned]
  }
  return result
}

/**
 * Layer session overrides on top of pins. A session entry replaces the pin entry for that server
 * wholesale: showing a facet on a fully-pinned server narrows it, and "none" hides a pinned one.
 */
export function effective(pinned: ConfigMCP.Exposure, session?: ConfigMCP.Exposure): ConfigMCP.Exposure {
  return { ...pinned, ...(session ?? {}) }
}

/**
 * Does this exposure entry let a tool through? Facet prefixes and exact tool names share prefix
 * semantics on the RAW (unsanitised) tool name; a prefix pattern may carry `|` alternatives.
 */
export function exposesTool(entry: ConfigMCP.ExposureEntry | undefined, toolName: string): boolean {
  if (entry === undefined) return false
  if (entry === "none") return false
  if (entry === "all") return true
  return entry.some((item) => matchesPrefix(item, toolName))
}

export function matchesPrefix(pattern: string, toolName: string): boolean {
  return pattern.split("|").some((alternative) => alternative.length > 0 && toolName.startsWith(alternative))
}

/**
 * Merge a `show` into an existing session entry: "all" absorbs everything, arrays union.
 * ("none" never reaches here; hide writes it directly.)
 */
export function widen(
  existing: ConfigMCP.ExposureEntry | undefined,
  incoming: "all" | string[],
): ConfigMCP.ExposureEntry {
  if (incoming === "all") return "all"
  if (existing === "all") return "all"
  if (existing === undefined || existing === "none") return [...incoming]
  return [...new Set([...existing, ...incoming])]
}

/** a show/hide target: `server` or `server:prefix` (facet prefixes and exact tool names alike). */
export function parseTarget(target: string): { server: string; prefix?: string } {
  const colon = target.indexOf(":")
  if (colon === -1) return { server: target }
  return { server: target.slice(0, colon), prefix: target.slice(colon + 1) }
}

/** apply `show` targets to a session exposure map, returning a new map. */
export function applyShow(exposure: ConfigMCP.Exposure, targets: string[]): ConfigMCP.Exposure {
  const result = { ...exposure }
  for (const target of targets) {
    const { server, prefix } = parseTarget(target)
    result[server] = widen(result[server], prefix ? [prefix] : "all")
  }
  return result
}

/**
 * apply `hide` targets: a bare server becomes "none"; `server:prefix` removes just that prefix
 * from an array entry, and hides the server outright when nothing remains (or when the entry
 * was not an array to begin with).
 */
export function applyHide(exposure: ConfigMCP.Exposure, targets: string[]): ConfigMCP.Exposure {
  const result = { ...exposure }
  for (const target of targets) {
    const { server, prefix } = parseTarget(target)
    const existing = result[server]
    if (prefix && Array.isArray(existing)) {
      const narrowed = existing.filter((item) => item !== prefix)
      result[server] = narrowed.length > 0 ? narrowed : "none"
      continue
    }
    result[server] = "none"
  }
  return result
}

export interface ResolvedAdvertisement {
  summary: string
  facets: Record<string, string>
  /** where the text came from, so callers can warn on the fallback paths. */
  source: "advertisement" | "instructions" | "derived"
}

/**
 * Resolve the catalogue text for one server: the hand-written advertisement first, the server's
 * own `initialize.instructions` second (whole block, per peter 2026-10-29), and a derived
 * name-plus-tool-verbs line as the last resort.
 */
export function resolveAdvertisement(input: {
  name: string
  advertisement?: ConfigMCP.Advertisement
  instructions?: string
  toolNames: string[]
}): ResolvedAdvertisement {
  if (typeof input.advertisement === "string") {
    return { summary: input.advertisement, facets: {}, source: "advertisement" }
  }
  if (input.advertisement) {
    return { summary: input.advertisement.summary, facets: input.advertisement.facets ?? {}, source: "advertisement" }
  }
  if (input.instructions && input.instructions.trim().length > 0) {
    return { summary: input.instructions.trim(), facets: {}, source: "instructions" }
  }
  return { summary: derivedSummary(input.name, input.toolNames), facets: {}, source: "derived" }
}

/** last-resort summary: the server name plus the leading verbs of its tool names. */
function derivedSummary(name: string, toolNames: string[]): string {
  const verbs = [...new Set(toolNames.map((tool) => tool.split("_")[0]).filter(Boolean))].slice(0, 8)
  if (verbs.length === 0) return `${name} (no advertisement, no tools listed)`
  return `${name}: tools include ${verbs.join(", ")}`
}

export * as McpExposure from "./exposure"
