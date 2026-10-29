import { describe, expect, test } from "bun:test"
import { McpSearch } from "@/mcp/search"

function entry(partial: Partial<McpSearch.CatalogEntry> & { name: string }): McpSearch.CatalogEntry {
  return {
    status: "connected",
    summary: "",
    advertisementSource: "advertisement",
    facets: {},
    toolCount: partial.tools?.length ?? 0,
    estimatedTokens: 100,
    tools: [],
    ...partial,
  }
}

const catalog: McpSearch.CatalogEntry[] = [
  entry({
    name: "plain",
    status: "failed",
    summary: "customer support platform: tickets, conversations, agent workflows, help center content",
    tools: [],
  }),
  entry({
    name: "betterstack",
    summary: "uptime monitoring and incident management",
    tools: [
      { name: "list_dashboards", description: "List observability dashboards" },
      { name: "get_monitor", description: "Get an uptime monitor" },
      { name: "list_incidents", description: "List incidents" },
    ],
  }),
  entry({
    name: "hyperdx-vapi",
    summary: "observability traces and logs",
    tools: [{ name: "get_dashboard", description: "Fetch a dashboard by id" }],
  }),
  entry({
    name: "system-mcp",
    summary: "peter's local swiss-army server: linear, worktrees, phone, papers, tmux",
    facets: {
      linear_: "linear issue tracking: create, update, move, and comment on issues and projects",
      adb_: "android phone control over adb: taps, calls, screenshots",
    },
    tools: [
      { name: "linear_create_issue", description: "create a new linear issue" },
      { name: "linear_update_issue", description: "update or move an existing linear issue" },
      { name: "adb_tap", description: "tap the phone screen" },
      { name: "paper_search", description: "search scholarly indexes" },
    ],
  }),
  entry({
    name: "postgres-vapi-docker-assistant",
    summary: "read and write the local assistantDb postgres database",
    tools: [{ name: "run_select_query", description: "Run a SQL select query" }],
  }),
]

describe("McpSearch.search", () => {
  test("finds servers by tool descriptions when names do not match", () => {
    const hits = McpSearch.search("dashboard", catalog)
    const servers = hits.map((hit) => hit.server)
    expect(servers).toContain("betterstack")
    expect(servers).toContain("hyperdx-vapi")
  })

  test("ranks a disconnected server first on its advertisement alone", () => {
    const hits = McpSearch.search("customer support ticket", catalog)
    expect(hits[0].server).toBe("plain")
    expect(hits[0].status).toBe("failed")
  })

  test("returns the facet target for a facet-shaped query, not the whole server", () => {
    const hits = McpSearch.search("move a linear issue", catalog)
    expect(hits[0].target).toBe("system-mcp:linear_")
    expect(hits[0].matchedTools.map((tool) => tool.name)).toContain("linear_update_issue")
  })

  test("fuzzy server-name match still works", () => {
    const hits = McpSearch.search("postgres assistant", catalog)
    expect(hits[0].server).toBe("postgres-vapi-docker-assistant")
  })

  test("empty query returns nothing", () => {
    expect(McpSearch.search("", catalog)).toEqual([])
  })
})
