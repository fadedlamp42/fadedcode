import { describe, expect, test } from "bun:test"
import { McpExposure } from "@/mcp/exposure"

describe("McpExposure.pins", () => {
  test("collects pinned servers and ignores the rest", () => {
    const result = McpExposure.pins({
      plain: { pinned: undefined },
      betterstack: { pinned: true },
      "system-mcp": { pinned: ["linear_"] },
      glean: {},
    })
    expect(result).toEqual({ betterstack: "all", "system-mcp": ["linear_"] })
  })
})

describe("McpExposure.effective", () => {
  test("session overrides replace pin entries wholesale", () => {
    const pins = { betterstack: "all" as const, "system-mcp": ["linear_"] }
    expect(McpExposure.effective(pins, { betterstack: "none" })).toEqual({
      betterstack: "none",
      "system-mcp": ["linear_"],
    })
  })

  test("no session map means pins alone", () => {
    expect(McpExposure.effective({ a: "all" })).toEqual({ a: "all" })
  })
})

describe("McpExposure.exposesTool", () => {
  test("undefined and none expose nothing", () => {
    expect(McpExposure.exposesTool(undefined, "anything")).toBe(false)
    expect(McpExposure.exposesTool("none", "anything")).toBe(false)
  })

  test("all exposes everything", () => {
    expect(McpExposure.exposesTool("all", "linear_create_issue")).toBe(true)
  })

  test("prefix entries match raw tool names, with | alternatives", () => {
    expect(McpExposure.exposesTool(["linear_"], "linear_create_issue")).toBe(true)
    expect(McpExposure.exposesTool(["linear_"], "adb_tap")).toBe(false)
    expect(McpExposure.exposesTool(["adb_|input_"], "input_click")).toBe(true)
    expect(McpExposure.exposesTool(["adb_|input_"], "linear_search")).toBe(false)
  })

  test("exact tool names work via prefix semantics", () => {
    expect(McpExposure.exposesTool(["linear_create_issue"], "linear_create_issue")).toBe(true)
    expect(McpExposure.exposesTool(["linear_create_issue"], "linear_create")).toBe(false)
  })
})

describe("McpExposure.widen", () => {
  test("all absorbs everything", () => {
    expect(McpExposure.widen(["a_"], "all")).toBe("all")
    expect(McpExposure.widen("all", ["a_"])).toBe("all")
  })

  test("arrays union and none is replaced", () => {
    expect(McpExposure.widen(["a_"], ["b_"])).toEqual(["a_", "b_"])
    expect(McpExposure.widen("none", ["b_"])).toEqual(["b_"])
    expect(McpExposure.widen(undefined, ["b_"])).toEqual(["b_"])
  })
})

describe("McpExposure.resolveAdvertisement", () => {
  test("string advertisement wins", () => {
    const result = McpExposure.resolveAdvertisement({
      name: "plain",
      advertisement: "customer support platform",
      instructions: "server-written text",
      toolNames: ["get_ticket"],
    })
    expect(result).toEqual({ summary: "customer support platform", facets: {}, source: "advertisement" })
  })

  test("structured advertisement carries facets", () => {
    const result = McpExposure.resolveAdvertisement({
      name: "system-mcp",
      advertisement: { summary: "grab bag", facets: { linear_: "linear issue tracking" } },
      toolNames: [],
    })
    expect(result.facets).toEqual({ linear_: "linear issue tracking" })
    expect(result.source).toBe("advertisement")
  })

  test("falls back to the whole instructions block, then to derived verbs", () => {
    const fromInstructions = McpExposure.resolveAdvertisement({
      name: "x",
      instructions: "line one.\nline two.",
      toolNames: [],
    })
    expect(fromInstructions.summary).toBe("line one.\nline two.")
    expect(fromInstructions.source).toBe("instructions")

    const derived = McpExposure.resolveAdvertisement({
      name: "x",
      toolNames: ["list_databases", "run_select_query"],
    })
    expect(derived.source).toBe("derived")
    expect(derived.summary).toContain("list")
    expect(derived.summary).toContain("run")
  })
})
