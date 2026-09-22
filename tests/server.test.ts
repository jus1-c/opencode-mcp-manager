import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { loadStore } from "../src/store.js"
import { createServerPlugin } from "../src/server.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryStorePath(): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-manager-server-"))
  temporaryDirectories.push(directory)
  return join(directory, "mcp-templates.json")
}

describe("server plugin", () => {
  test("applies default template and persists new configured servers", async () => {
    const storePath = await temporaryStorePath()
    const hooks = await createServerPlugin(storePath)({} as never)
    const config: Config = {
      mcp: {
        docs: { type: "remote", url: "https://docs.test" },
        browser: { type: "local", command: ["browser"] },
      },
    }

    await hooks.config?.(config)

    expect(config.mcp?.docs).toMatchObject({ enabled: true })
    expect(config.mcp?.browser).toMatchObject({ enabled: true })
    expect((await loadStore(storePath)).templates.default?.mcp).toEqual({ docs: true, browser: true })
  })

  test("does not mutate config or file when store is invalid", async () => {
    const storePath = await temporaryStorePath()
    const contents = "{not-json"
    await writeFile(storePath, contents)
    const hooks = await createServerPlugin(storePath)({} as never)
    const config: Config = {
      mcp: {
        docs: { type: "remote", url: "https://docs.test" },
      },
    }

    await expect(hooks.config?.(config)).rejects.toThrow("Invalid MCP template store")
    expect(config.mcp?.docs).toEqual({ type: "remote", url: "https://docs.test" })
    expect(await readFile(storePath, "utf8")).toBe(contents)
  })
})
