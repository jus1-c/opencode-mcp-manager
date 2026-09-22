import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { loadStore, saveStore, setActiveTemplate, type TemplateStore } from "../src/store.js"
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
  const projectDir = "/test-project"

  test("applies default template and persists new configured servers", async () => {
    const storePath = await temporaryStorePath()
    const hooks = await createServerPlugin(storePath)({ directory: projectDir } as never)
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
    const hooks = await createServerPlugin(storePath)({ directory: projectDir } as never)
    const config: Config = {
      mcp: {
        docs: { type: "remote", url: "https://docs.test" },
      },
    }

    await expect(hooks.config?.(config)).rejects.toThrow("Invalid MCP template store")
    expect(config.mcp?.docs).toEqual({ type: "remote", url: "https://docs.test" })
    expect(await readFile(storePath, "utf8")).toBe(contents)
  })

  test("applies activeTemplates[directory] over defaultTemplate", async () => {
    const storePath = await temporaryStorePath()
    const store: TemplateStore = {
      version: 1,
      defaultTemplate: "default",
      templates: {
        default: { mcp: { docs: true, browser: true } },
        minimal: { mcp: { docs: false, browser: true } },
      },
    }
    await saveStore(storePath, store)
    await setActiveTemplate(storePath, projectDir, "minimal")
    const hooks = await createServerPlugin(storePath)({ directory: projectDir } as never)
    const config: Config = {
      mcp: {
        docs: { type: "remote", url: "https://docs.test" },
        browser: { type: "local", command: ["browser"] },
      },
    }

    await hooks.config?.(config)

    expect(config.mcp?.docs).toMatchObject({ enabled: false })
    expect(config.mcp?.browser).toMatchObject({ enabled: true })
  })

  test("different directories get different active templates", async () => {
    const storePath = await temporaryStorePath()
    const store: TemplateStore = {
      version: 1,
      defaultTemplate: "default",
      templates: {
        default: { mcp: { docs: true, browser: true } },
        minimal: { mcp: { docs: false, browser: true } },
      },
    }
    await saveStore(storePath, store)
    await setActiveTemplate(storePath, "/project-a", "minimal")

    const makeConfig = (): Config => ({
      mcp: { docs: { type: "remote", url: "" }, browser: { type: "local", command: [] } },
    })

    const hooksA = await createServerPlugin(storePath)({ directory: "/project-a" } as never)
    const configA = makeConfig()
    await hooksA.config?.(configA)
    expect(configA.mcp?.docs).toMatchObject({ enabled: false })

    const hooksB = await createServerPlugin(storePath)({ directory: "/project-b" } as never)
    const configB = makeConfig()
    await hooksB.config?.(configB)
    expect(configB.mcp?.docs).toMatchObject({ enabled: true })
  })
})
