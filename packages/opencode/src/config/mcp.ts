import { Cause, Exit, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import * as Log from "@opencode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { ConfigVariable } from "./variable"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"

const log = Log.create({ service: "config.mcp" })

/**
 * Hand-written, human-curated description of what a server is for. Search ranking leans on this
 * text rather than on tool descriptions a remote server could change (tool-poisoning concern), and
 * the always-present catalogue prints it so opaque names like `plain` stay discoverable.
 *
 * The structured form exists for grab-bag servers: `facets` maps a raw tool-name prefix (use `|`
 * for alternatives, e.g. `"adb_|input_"`) to a one-line description. A facet is both a search
 * target and an exposure unit (`show("system-mcp:linear_")`).
 */
export const AdvertisementFacets = Schema.Struct({
  summary: Schema.String.annotate({ description: "One-line semantic description of what the server is for" }),
  facets: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Tool-name prefix (alternatives separated by |) to one-line description",
  }),
}).annotate({ identifier: "McpAdvertisementFacets" })

export const Advertisement = Schema.Union([Schema.String, AdvertisementFacets]).annotate({
  identifier: "McpAdvertisement",
})
export type Advertisement = Schema.Schema.Type<typeof Advertisement>

/**
 * Session-start exposure, resolved from `!` markers in MCP_SERVERS switchboard files. `true`
 * exposes the whole server; a string array exposes only tools matching those facet prefixes.
 * Absent means catalogued-but-hidden, which is the default for everything.
 */
export const Pinned = Schema.Union([Schema.Boolean, Schema.mutable(Schema.Array(Schema.String))]).annotate({
  identifier: "McpPinned",
})
export type Pinned = Schema.Schema.Type<typeof Pinned>

/**
 * Per-session MCP exposure overrides, keyed by server name. "all" exposes every tool, "none"
 * hides the server (even when pinned), and a string array exposes tools whose raw name equals or
 * starts with one of the entries (facet prefixes and exact tool names share prefix semantics).
 */
export const ExposureEntry = Schema.Union([
  Schema.Literal("all"),
  Schema.Literal("none"),
  Schema.mutable(Schema.Array(Schema.String)),
]).annotate({ identifier: "McpExposureEntry" })
export type ExposureEntry = Schema.Schema.Type<typeof ExposureEntry>

export const Exposure = Schema.Record(Schema.String, ExposureEntry).annotate({ identifier: "McpExposure" })
export type Exposure = { [server: string]: ExposureEntry }

export const Local = Schema.Struct({
  type: Schema.Literal("local").annotate({ description: "Type of MCP server connection" }),
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "Command and arguments to run the MCP server",
  }),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Environment variables to set when running the MCP server",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  advertisement: Schema.optional(Advertisement).annotate({
    description: "Human-curated description used by the MCP catalogue and exposure search",
  }),
  pinned: Schema.optional(Pinned).annotate({
    description: "Expose this server (or the named facet prefixes) at session start",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
}).annotate({ identifier: "McpLocalConfig" })
export type Local = Schema.Schema.Type<typeof Local>

export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted.",
  }),
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth client secret (if required by the authorization server)",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "OAuth scopes to request during authorization" }),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    description:
      "Port for the local OAuth callback server (default: 19876). Shorthand for redirectUri when only the port needs changing. Ignored if redirectUri is set.",
  }),
  redirectUri: Schema.optional(Schema.String).annotate({
    description: "OAuth redirect URI (default: http://127.0.0.1:19876/mcp/oauth/callback).",
  }),
}).annotate({ identifier: "McpOAuthConfig" })
export type OAuth = Schema.Schema.Type<typeof OAuth>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Headers to send with the request",
  }),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description: "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
  }),
  advertisement: Schema.optional(Advertisement).annotate({
    description: "Human-curated description used by the MCP catalogue and exposure search",
  }),
  pinned: Schema.optional(Pinned).annotate({
    description: "Expose this server (or the named facet prefixes) at session start",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
}).annotate({ identifier: "McpRemoteConfig" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>

/**
 * Name of the plaintext file that decides which catalog entries are switched on. One is read from
 * every ancestor directory of the working directory and their contents are unioned, so a personal
 * default set can live high up while individual projects opt into extras further down.
 */
const SWITCHBOARD_FILE = "MCP_SERVERS"

const decodeInfo = Schema.decodeUnknownExit(Info)

/**
 * Resolve an MCP server catalog from a directory of profile files.
 *
 * A profile directory holds one JSON file per logical server group, written in either the flat
 * (`{ "<name>": { ... } }`) or wrapped (`{ "mcpServers": { "<name>": { ... } } }`) shape that other
 * MCP clients use, so the same files stay usable outside opencode. Every server found is only a
 * *candidate*: enablement is decided entirely by the `MCP_SERVERS` switchboard files, which means
 * adding a server to the catalog never changes what actually starts up.
 *
 * Returns a map ready to merge into `Config.Info["mcp"]`, with `enabled` already resolved.
 */
export async function loadProfiles(input: { profilesPath: string; directory: string }) {
  const catalog = await readProfileDirectory(input.profilesPath)
  const switchedOn = await readSwitchboard(input.directory)

  // a switchboard line names either a profile file stem (turning on every server that file declares)
  // or a single server, so that grouped servers can be toggled as one unit. listing a server makes
  // it catalogued (connected + searchable) but exposes nothing: sessions start with zero MCP tools.
  // a `!` pin is the one exception, resolved here into the entry's `pinned` field.
  const enabled = new Set<string>()
  const pins = new Map<string, Pinned>()
  for (const [token, pin] of switchedOn) {
    for (const name of catalog.stems.get(token) ?? [token]) {
      enabled.add(name)
      if (pin !== false) pins.set(name, mergePins(pins.get(name), pin))
    }
  }

  return Object.fromEntries(
    Object.entries(catalog.servers).map(([name, server]) => [
      name,
      { ...server, enabled: enabled.has(name), ...(pins.has(name) ? { pinned: pins.get(name) } : {}) },
    ]),
  ) satisfies Record<string, Info>
}

/** two pins for the same server combine: a whole-server pin absorbs facet pins, facet lists union. */
function mergePins(existing: Pinned | undefined, incoming: Pinned): Pinned {
  if (existing === true || incoming === true) return true
  if (!existing) return incoming
  if (!incoming) return existing
  return [...new Set([...existing, ...incoming])]
}

/**
 * Read and decode every profile file, returning both the merged server map and the stem -> server
 * names index the switchboard needs. Both come from a single pass so the directory is never walked
 * twice for the same content.
 */
async function readProfileDirectory(profilesPath: string) {
  const servers: Record<string, Info> = {}
  const stems = new Map<string, string[]>()

  const entries = await Fs.readdir(profilesPath).catch((err) => {
    log.error("failed to read MCP profiles directory", { profilesPath, err })
    return [] as string[]
  })

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue
    const filePath = Path.join(profilesPath, entry)

    const declared = await readProfileFile(filePath)
    if (!declared) continue

    stems.set(entry.slice(0, -".json".length), Object.keys(declared))
    for (const [name, server] of Object.entries(declared)) {
      servers[name] = server
    }
  }

  return { servers, stems }
}

async function readProfileFile(filePath: string) {
  const raw = await Fs.readFile(filePath, "utf-8").catch((err) => {
    log.error("failed to read MCP profile", { filePath, err })
    return undefined
  })
  if (raw === undefined) return undefined

  // resolve {env:VAR} and {file:...} references before parsing so profile files stay portable
  // across machines instead of hardcoding absolute paths or secrets
  const parsed = await ConfigVariable.substitute({ type: "path", path: filePath, text: raw })
    .then((text) => JSON.parse(text) as unknown)
    .catch((err) => {
      log.error("failed to parse MCP profile", { filePath, err })
      return undefined
    })
  if (!isRecord(parsed)) return undefined

  const declared = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const result: Record<string, Info> = {}
  for (const [name, server] of Object.entries(declared)) {
    const decoded = decodeInfo(normalizeProfileServer(server), { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(decoded)) {
      result[name] = decoded.value
      continue
    }
    log.error("ignoring invalid MCP profile server", { filePath, name, error: Cause.pretty(decoded.cause) })
  }
  return result
}

/**
 * Translate the wider MCP config dialect that other clients write into opencode's own shape:
 * `stdio`/`http`/`sse` transport names, `env` instead of `environment`, and a `command` string with
 * a separate `args` array instead of one argv array. Transport is inferred when absent.
 */
function normalizeProfileServer(server: unknown) {
  if (!isRecord(server)) return server
  const result = { ...server }

  if ("env" in result && !("environment" in result)) {
    result.environment = result.env
    delete result.env
  }

  if (typeof result.command === "string") {
    result.command = Array.isArray(result.args) ? [result.command, ...result.args] : [result.command]
    delete result.args
  }

  const transport: Record<string, string> = { stdio: "local", http: "remote", sse: "remote" }
  if (typeof result.type === "string") result.type = transport[result.type] ?? result.type
  if (!result.type) result.type = "url" in result ? "remote" : "local"

  return result
}

/**
 * Collect switchboard entries from every ancestor of `directory`, root first. Blank lines and
 * `#` comments are ignored, which is what makes a switchboard file usable as a checklist of
 * available servers with most of them commented out.
 *
 * Line grammar: `name` catalogues the server, `!name` additionally pins it (exposed at session
 * start), `!name:prefix` pins just the tools matching that facet prefix. When the same token
 * appears in more than one ancestor file, the deepest file's pin state wins outright, so a
 * project can un-pin something a parent directory pins. Within one file, facet pins union.
 */
async function readSwitchboard(directory: string) {
  const tokens = new Map<string, false | Pinned>()
  const relative = Path.relative("/", directory)
  if (!relative || relative.startsWith("..")) return tokens

  const parts = relative.split(Path.sep)
  for (let depth = 0; depth <= parts.length; depth++) {
    const filePath = Path.join("/", ...parts.slice(0, depth), SWITCHBOARD_FILE)
    const content = await Fs.readFile(filePath, "utf-8").catch(() => undefined)
    if (content === undefined) continue

    const fileTokens = new Map<string, false | Pinned>()
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const parsed = parseSwitchboardLine(trimmed)
      const existing = fileTokens.get(parsed.token)
      fileTokens.set(
        parsed.token,
        existing === undefined || existing === false
          ? parsed.pin
          : mergePins(existing, parsed.pin === false ? [] : parsed.pin),
      )
    }
    // deeper file wins per token: overwrite rather than merge across files
    for (const [token, pin] of fileTokens) tokens.set(token, pin)
  }

  return tokens
}

function parseSwitchboardLine(line: string): { token: string; pin: false | Pinned } {
  if (!line.startsWith("!")) return { token: line, pin: false }
  const body = line.slice(1)
  const colon = body.indexOf(":")
  if (colon === -1) return { token: body, pin: true }
  return { token: body.slice(0, colon), pin: [body.slice(colon + 1)] }
}

export * as ConfigMCP from "./mcp"
