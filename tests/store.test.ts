import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createEmptyStore,
  loadStore,
  saveStore,
  setActiveTemplate,
  type TemplateStore,
} from "../src/store.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryStorePath(): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-manager-"))
  temporaryDirectories.push(directory)
  return join(directory, "mcp-templates.json")
}

describe("template store", () => {
  test("loads an empty default store when file does not exist", async () => {
    const store = await loadStore(await temporaryStorePath())

    expect(store).toEqual(createEmptyStore())
  })

  test("round trips a valid store", async () => {
    const path = await temporaryStorePath()
    const store: TemplateStore = {
      version: 1,
      defaultTemplate: "work",
      templates: {
        work: { mcp: { docs: true, browser: false } },
      },
    }

    await saveStore(path, store)

    expect(await loadStore(path)).toEqual(store)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(store)
  })

  test("rejects malformed JSON without changing the file", async () => {
    const path = await temporaryStorePath()
    const contents = "{not-json"
    await writeFile(path, contents)

    await expect(loadStore(path)).rejects.toThrow("Invalid MCP template store")
    expect(await readFile(path, "utf8")).toBe(contents)
  })

  test("rejects invalid replacement without overwriting existing file", async () => {
    const path = await temporaryStorePath()
    const store = createEmptyStore()
    await saveStore(path, store)

    await expect(saveStore(path, { version: 1 } as never)).rejects.toThrow("Invalid MCP template store")
    expect(await loadStore(path)).toEqual(store)
  })

  test("round trips activeTemplate", async () => {
    const path = await temporaryStorePath()
    const store: TemplateStore = {
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: { docs: true } }, work: { mcp: { docs: false } } },
    }
    await saveStore(path, store)

    await setActiveTemplate(path, "/project-a", "work")
    const updated = await loadStore(path)
    expect(updated.activeTemplates?.["/project-a"]).toBe("work")
    expect(updated.activeTemplate).toBeUndefined()

    await setActiveTemplate(path, "/project-a", undefined)
    const cleared = await loadStore(path)
    expect(cleared.activeTemplates).toBeUndefined()
  })

  test("keeps per-directory entries independent", async () => {
    const path = await temporaryStorePath()
    const store: TemplateStore = {
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: {} }, work: { mcp: {} }, minimal: { mcp: {} } },
    }
    await saveStore(path, store)

    await setActiveTemplate(path, "/a", "work")
    await setActiveTemplate(path, "/b", "minimal")
    const loaded = await loadStore(path)
    expect(loaded.activeTemplates).toEqual({ "/a": "work", "/b": "minimal" })

    await setActiveTemplate(path, "/a", undefined)
    const after = await loadStore(path)
    expect(after.activeTemplates).toEqual({ "/b": "minimal" })
  })

  test("rejects setActiveTemplate for missing template", async () => {
    const path = await temporaryStorePath()
    await saveStore(path, createEmptyStore())

    await expect(setActiveTemplate(path, "/a", "nope")).rejects.toThrow("Template not found")
  })

  test("rejects store with activeTemplate referencing missing template", async () => {
    const path = await temporaryStorePath()
    const broken = { version: 1, defaultTemplate: "default", activeTemplate: "ghost", templates: { default: { mcp: {} } } }
    await writeFile(path, JSON.stringify(broken))

    await expect(loadStore(path)).rejects.toThrow("Invalid MCP template store")
  })

  test("rejects store with activeTemplates value referencing missing template", async () => {
    const path = await temporaryStorePath()
    const broken = { version: 1, defaultTemplate: "default", activeTemplates: { "/a": "ghost" }, templates: { default: { mcp: {} } } }
    await writeFile(path, JSON.stringify(broken))

    await expect(loadStore(path)).rejects.toThrow("Invalid MCP template store")
  })
})
