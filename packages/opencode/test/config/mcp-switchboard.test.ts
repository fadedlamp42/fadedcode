import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ConfigMCP } from "@/config/mcp"

/**
 * loadProfiles reads the profile directory plus MCP_SERVERS switchboard files from every ancestor
 * of the working directory, so each test builds its own tree under a tmpdir. Switchboards above
 * the tmpdir (e.g. an MCP_SERVERS in /) would leak in, so server names are unique per test.
 */
async function fixture(input: { profiles: Record<string, object>; switchboards: Record<string, string>; cwd: string }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-switchboard-"))
  const profilesPath = path.join(root, "profiles")
  await fs.mkdir(profilesPath, { recursive: true })
  for (const [file, content] of Object.entries(input.profiles)) {
    await fs.writeFile(path.join(profilesPath, file), JSON.stringify(content))
  }
  for (const [dir, content] of Object.entries(input.switchboards)) {
    const target = path.join(root, dir)
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, "MCP_SERVERS"), content)
  }
  const directory = path.join(root, input.cwd)
  await fs.mkdir(directory, { recursive: true })
  return { profilesPath, directory }
}

const localServer = (extra: object = {}) => ({ type: "local", command: ["echo", "hi"], ...extra })

describe("ConfigMCP.loadProfiles", () => {
  test("plain switchboard lines catalogue servers without pinning", async () => {
    const { profilesPath, directory } = await fixture({
      profiles: { "aaa.json": { swbtest_a: localServer(), swbtest_b: localServer() } },
      switchboards: { ".": "swbtest_a\n# swbtest_b stays off\n" },
      cwd: ".",
    })
    const result = await ConfigMCP.loadProfiles({ profilesPath, directory })
    expect(result.swbtest_a.enabled).toBe(true)
    expect(result.swbtest_a.pinned).toBeUndefined()
    expect(result.swbtest_b.enabled).toBe(false)
  })

  test("! pins a server and !name:prefix pins a facet; facet pins in one file union", async () => {
    const { profilesPath, directory } = await fixture({
      profiles: { "aaa.json": { swbtest_c: localServer(), swbtest_d: localServer() } },
      switchboards: { ".": "!swbtest_c\n!swbtest_d:linear_\n!swbtest_d:adb_\n" },
      cwd: ".",
    })
    const result = await ConfigMCP.loadProfiles({ profilesPath, directory })
    expect(result.swbtest_c.enabled).toBe(true)
    expect(result.swbtest_c.pinned).toBe(true)
    expect(result.swbtest_d.pinned).toEqual(["linear_", "adb_"])
  })

  test("the deepest switchboard wins per token, so a project can un-pin a parent's pin", async () => {
    const { profilesPath, directory } = await fixture({
      profiles: { "aaa.json": { swbtest_e: localServer() } },
      switchboards: { ".": "!swbtest_e\n", project: "swbtest_e\n" },
      cwd: "project",
    })
    const result = await ConfigMCP.loadProfiles({ profilesPath, directory })
    expect(result.swbtest_e.enabled).toBe(true)
    expect(result.swbtest_e.pinned).toBeUndefined()
  })

  test("stem lines expand to every server in the file, pins included", async () => {
    const { profilesPath, directory } = await fixture({
      profiles: { "swbgroup.json": { swbtest_f: localServer(), swbtest_g: localServer() } },
      switchboards: { ".": "!swbgroup\n" },
      cwd: ".",
    })
    const result = await ConfigMCP.loadProfiles({ profilesPath, directory })
    expect(result.swbtest_f.pinned).toBe(true)
    expect(result.swbtest_g.pinned).toBe(true)
  })

  test("string and structured advertisements both decode", async () => {
    const { profilesPath, directory } = await fixture({
      profiles: {
        "aaa.json": {
          swbtest_h: localServer({ advertisement: "a one line advertisement" }),
          swbtest_i: localServer({
            advertisement: { summary: "grab bag", facets: { linear_: "issue tracking" } },
          }),
        },
      },
      switchboards: { ".": "swbtest_h\nswbtest_i\n" },
      cwd: ".",
    })
    const result = await ConfigMCP.loadProfiles({ profilesPath, directory })
    expect(result.swbtest_h.advertisement).toBe("a one line advertisement")
    expect(result.swbtest_i.advertisement).toEqual({ summary: "grab bag", facets: { linear_: "issue tracking" } })
  })
})
