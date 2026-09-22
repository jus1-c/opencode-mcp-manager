import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  applyNamedTemplate,
  createTuiPlugin,
  deleteTemplate,
  runtimeTemplateFromStatuses,
  saveCurrentTemplate,
  setDefaultTemplate,
} from "../src/tui.js"
import { createEmptyStore, loadStore, saveStore, setActiveTemplate, type TemplateStore } from "../src/store.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryStorePath(): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mcp-manager-tui-"))
  temporaryDirectories.push(directory)
  return join(directory, "mcp-templates.json")
}

describe("TUI template actions", () => {
  test("builds current template from configured servers only", () => {
    expect(
      runtimeTemplateFromStatuses(["docs", "browser"], {
        docs: { status: "connected" },
        browser: { status: "disabled" },
        dynamic: { status: "connected" },
      }),
    ).toEqual({ mcp: { docs: true, browser: false } })
  })

  test("saves current state under a named template", async () => {
    const path = await temporaryStorePath()

    await saveCurrentTemplate(path, "work", ["docs", "browser"], {
      docs: { status: "connected" },
      browser: { status: "needs_auth" },
    })

    const store = await loadStore(path)
    expect(store.defaultTemplate).toBe("default")
    expect(store.templates.work?.mcp).toEqual({ docs: true, browser: true })
  })

  test("changes default and refuses deleting it", async () => {
    const path = await temporaryStorePath()
    await saveCurrentTemplate(path, "work", ["docs"], { docs: { status: "connected" } })

    await setDefaultTemplate(path, "work")
    expect((await loadStore(path)).defaultTemplate).toBe("work")
    await expect(deleteTemplate(path, "work")).rejects.toThrow("Cannot delete default template")
  })

  test("registers native slash command", async () => {
    const layers: unknown[] = []
    const api = {
      keymap: {
        registerLayer(layer: unknown) {
          layers.push(layer)
          return () => undefined
        },
      },
    }

    await createTuiPlugin(await temporaryStorePath())(api as never, undefined, {} as never)

    const command = (layers[0] as { commands: Array<Record<string, unknown>> }).commands[0]
    expect(command).toMatchObject({
      name: "mcp-manager.open",
      slashName: "mcp-man",
    })
  })

  test("can delete a non-default template", async () => {
    const path = await temporaryStorePath()
    await saveCurrentTemplate(path, "work", ["docs"], { docs: { status: "connected" } })

    await deleteTemplate(path, "work")

    expect(await loadStore(path)).toEqual(createEmptyStore())
  })

  test("deleteTemplate clears all active entries referencing the deleted template", async () => {
    const path = await temporaryStorePath()
    const store: TemplateStore = {
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: {} }, work: { mcp: {} }, minimal: { mcp: {} } },
    }
    await saveStore(path, store)
    await setActiveTemplate(path, "/a", "work")
    await setActiveTemplate(path, "/b", "minimal")
    expect((await loadStore(path)).activeTemplates).toEqual({ "/a": "work", "/b": "minimal" })

    await deleteTemplate(path, "work")

    const updated = await loadStore(path)
    expect(updated.activeTemplates).toEqual({ "/b": "minimal" })
    expect(updated.templates.work).toBeUndefined()
  })

  test("applyNamedTemplate sets per-directory activeTemplate and calls instance.dispose", async () => {
    const path = await temporaryStorePath()
    const store: TemplateStore = {
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: {} }, work: { mcp: { docs: true } } },
    }
    await saveStore(path, store)
    const disposed: unknown[] = []
    const connected: string[] = []
    const api = {
      keymap: { registerLayer: () => () => undefined },
      client: {
        mcp: {
          status: async () => ({ data: { docs: { status: "disabled" } }, error: undefined }),
          connect: async (input: { name: string }) => { connected.push(input.name); return { data: true, error: undefined } },
          disconnect: async () => ({ data: true, error: undefined }),
        },
        instance: {
          dispose: async () => { disposed.push(true); return { data: true, error: undefined } },
        },
      },
      state: { config: { mcp: { docs: {} } }, path: { directory: "/test-project" } },
      ui: { dialog: { replace: () => undefined, clear: () => undefined }, toast: () => undefined },
    }

    await applyNamedTemplate(api as never, path, "work")

    const loaded = await loadStore(path)
    expect(loaded.activeTemplates?.["/test-project"]).toBe("work")
    expect(loaded.activeTemplate).toBeUndefined()
    expect(disposed.length).toBe(1)
    expect(connected).toEqual(["docs"])
  })

  test("applyNamedTemplate does not set activeTemplate when runtime apply fails", async () => {
    const path = await temporaryStorePath()
    const store: TemplateStore = {
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: {} }, work: { mcp: { docs: true } } },
    }
    await saveStore(path, store)
    const disposed: unknown[] = []
    const api = {
      keymap: { registerLayer: () => () => undefined },
      client: {
        mcp: {
          status: async () => ({ data: { docs: { status: "disabled" } }, error: undefined }),
          connect: async () => ({ data: undefined, error: { type: "connection_timeout" } }),
          disconnect: async () => ({ data: true, error: undefined }),
        },
        instance: {
          dispose: async () => { disposed.push(true); return { data: true, error: undefined } },
        },
      },
      state: { config: { mcp: { docs: {} } }, path: { directory: "/test-project" } },
      ui: { dialog: { replace: () => undefined, clear: () => undefined }, toast: () => undefined },
    }

    await applyNamedTemplate(api as never, path, "work")

    expect((await loadStore(path)).activeTemplates).toBeUndefined()
    expect(disposed.length).toBe(0)
  })
})
