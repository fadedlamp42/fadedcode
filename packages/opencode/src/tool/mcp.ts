import { Effect, Schema } from "effect"
import { MCP } from "@/mcp"
import { McpExposure } from "@/mcp/exposure"
import { McpSearch } from "@/mcp/search"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { ConfigMCP } from "@/config/mcp"
import * as Tool from "./tool"
import DESCRIPTION from "./mcp.txt"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["search", "show", "hide", "list"]).annotate({
    description: "search the catalogue, show/hide exposure for this session, or list current exposure",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "search only: what you are looking for, in plain words",
  }),
  targets: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: 'show/hide only: entries like "betterstack" or "system-mcp:linear_"',
  }),
})
type Params = Schema.Schema.Type<typeof Parameters>

export const McpTool = Tool.define(
  "mcp",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const sessions = yield* Session.Service

    const currentExposure = (sessionID: string) =>
      Effect.gen(function* () {
        const session = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
        return { ...(session.mcpExposure ?? {}) }
      })

    const doSearch = (params: Params, sessionID: string) =>
      Effect.gen(function* () {
        if (!params.query) return failure("search needs a `query`.")
        const exposure = yield* currentExposure(sessionID)
        const catalog = yield* mcp.catalog(exposure)
        const hits = McpSearch.search(params.query, catalog, 5)
        if (hits.length === 0) {
          return {
            title: `no matches: ${params.query}`,
            metadata: meta("search", 0),
            output:
              "Nothing in the catalogue matched. The full catalogue is in this tool's description; try different words or a server name.",
          }
        }
        const lines = hits.map((hit) => {
          const matched = hit.matchedTools.map((tool) => tool.name).join(", ")
          return [
            `- show("${hit.target}") [${hit.status}, ${hit.toolCount} tools, ~${hit.estimatedTokens} tokens]`,
            `  ${firstLine(hit.summary)}`,
            matched ? `  matching tools: ${matched}` : undefined,
          ]
            .filter(Boolean)
            .join("\n")
        })
        return {
          title: `search: ${params.query}`,
          metadata: meta("search", hits.length),
          output: lines.join("\n"),
        }
      })

    const doShow = (params: Params, sessionID: string) =>
      Effect.gen(function* () {
        if (!params.targets?.length) return failure('show needs `targets`, e.g. ["betterstack", "system-mcp:linear_"].')
        const catalog = yield* mcp.catalog()
        const known = new Map(catalog.map((entry) => [entry.name, entry]))
        const exposure = yield* currentExposure(sessionID)
        const applied: string[] = []
        const problems: string[] = []

        for (const target of params.targets) {
          const { server } = McpExposure.parseTarget(target)
          const entry = known.get(server)
          if (!entry) {
            problems.push(`unknown server "${server}"${suggest(server, [...known.keys()])}`)
            continue
          }
          applied.push(target)
          if (entry.status !== "connected") {
            problems.push(`"${server}" is ${entry.status}; its tools appear once it connects`)
          }
        }

        if (applied.length > 0) {
          yield* sessions.setMcpExposure({
            sessionID: SessionID.make(sessionID),
            mcpExposure: McpExposure.applyShow(exposure, applied),
          })
        }
        return {
          title: applied.length ? `shown: ${applied.join(", ")}` : "nothing shown",
          metadata: meta("show", applied.length, { applied, problems }),
          output: [
            applied.length
              ? `Exposed for this session: ${applied.join(", ")}. Tools arrive on your next step.`
              : undefined,
            ...problems,
          ]
            .filter(Boolean)
            .join("\n"),
        }
      })

    const doHide = (params: Params, sessionID: string) =>
      Effect.gen(function* () {
        if (!params.targets?.length) return failure('hide needs `targets`, e.g. ["betterstack"].')
        const exposure = yield* currentExposure(sessionID)
        const applied = [...params.targets]

        yield* sessions.setMcpExposure({
          sessionID: SessionID.make(sessionID),
          mcpExposure: McpExposure.applyHide(exposure, applied),
        })
        return {
          title: `hidden: ${applied.join(", ")}`,
          metadata: meta("hide", applied.length, { applied }),
          output: `Hidden for this session: ${applied.join(", ")}. Their tools disappear on your next step.`,
        }
      })

    const doList = (sessionID: string) =>
      Effect.gen(function* () {
        const exposure = yield* currentExposure(sessionID)
        const catalog = yield* mcp.catalog(exposure)
        const exposed = catalog.filter((entry) => entry.exposure !== undefined && entry.exposure !== "none")
        if (exposed.length === 0) {
          return {
            title: "no MCP tools exposed",
            metadata: meta("list", 0),
            output: "This session exposes no MCP tools. Use search/show to expose what the task needs.",
          }
        }
        const lines = exposed.map((entry) => {
          // count the exposed subset, not the whole server: a facet show exposes 49 of 139 tools
          const exposedTools = entry.tools.filter((tool) => McpExposure.exposesTool(entry.exposure, tool.name))
          const exposedTokens = Math.round(
            (entry.estimatedTokens * exposedTools.length) / Math.max(entry.toolCount, 1),
          )
          const detail = entry.exposure === "all" ? "all tools" : `prefixes: ${(entry.exposure as string[]).join(", ")}`
          return `- ${entry.name} [${entry.status}, ${exposedTools.length} tools exposed, ~${exposedTokens} tokens]: ${detail}`
        })
        return {
          title: `${exposed.length} servers exposed`,
          metadata: meta("list", exposed.length),
          output: lines.join("\n"),
        }
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "search") return yield* doSearch(params, ctx.sessionID)
          if (params.action === "show") return yield* doShow(params, ctx.sessionID)
          if (params.action === "hide") return yield* doHide(params, ctx.sessionID)
          return yield* doList(ctx.sessionID)
        }).pipe(Effect.orDie),
    }
  }),
)

interface Meta {
  action: string
  count: number
  detail?: Record<string, unknown>
  [key: string]: unknown
}

function meta(action: string, count: number, detail?: Record<string, unknown>): Meta {
  return { action, count, ...(detail ? { detail } : {}) }
}

function failure(message: string) {
  return { title: "invalid mcp call", metadata: meta("invalid", 0), output: message }
}

function suggest(name: string, known: string[]): string {
  const near = known.filter((candidate) => candidate.includes(name) || name.includes(candidate)).slice(0, 3)
  return near.length ? ` (did you mean: ${near.join(", ")}?)` : ""
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n")
  return newline === -1 ? text : text.slice(0, newline)
}
