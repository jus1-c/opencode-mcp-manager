import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createEmptyStore,
  loadStore,
  saveStore,
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
})
