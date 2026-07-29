import { Cause, Exit, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import * as Log from "@opencode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { ConfigVariable } from "./variable"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"

const log = Log.create({ service: "config.mcp" })

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
  // or a single server, so that grouped servers can be toggled as one unit
  const enabled = new Set<string>()
  for (const token of switchedOn) {
    for (const name of catalog.stems.get(token) ?? [token]) enabled.add(name)
  }

  return Object.fromEntries(
    Object.entries(catalog.servers).map(([name, server]) => [name, { ...server, enabled: enabled.has(name) }]),
  ) satisfies Record<string, Info>
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
 */
async function readSwitchboard(directory: string) {
  const tokens = new Set<string>()
  const relative = Path.relative("/", directory)
  if (!relative || relative.startsWith("..")) return tokens

  const parts = relative.split(Path.sep)
  for (let depth = 0; depth <= parts.length; depth++) {
    const filePath = Path.join("/", ...parts.slice(0, depth), SWITCHBOARD_FILE)
    const content = await Fs.readFile(filePath, "utf-8").catch(() => undefined)
    if (content === undefined) continue

    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      tokens.add(trimmed)
    }
  }

  return tokens
}

export * as ConfigMCP from "./mcp"
