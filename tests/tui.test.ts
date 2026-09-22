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
  statusOptions,
} from "../src/tui.js"
import { createEmptyStore, loadStore } from "../src/store.js"

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

  test("shows live status dialog after applying a template", async () => {
    const replaced: string[] = []
    const storePath = await temporaryStorePath()
    await saveCurrentTemplate(storePath, "work", ["docs"], { docs: { status: "disabled" } })
    const api = {
      keymap: { registerLayer: () => () => undefined },
      client: {
        mcp: {
          status: async () => ({ data: { docs: { status: "disabled" } } }),
          connect: async () => ({ data: true, error: undefined }),
          disconnect: async () => ({ data: true, error: undefined }),
        },
      },
      state: { config: { mcp: { docs: {} } } },
      ui: {
        dialog: {
          replace: (render: () => unknown) => replaced.push(String(render)),
          clear: () => undefined,
        },
        toast: () => undefined,
      },
    }

    await applyNamedTemplate(api as never, storePath, "work")

    expect(replaced.length).toBe(1)
  })

  test("lists live status sorted by name with errors in description", () => {
    const options = statusOptions({
      browser: { status: "failed", error: "offline" },
      codegraph: { status: "connected" },
    })

    expect(options).toEqual([
      { title: "browser", description: "failed: offline" },
      { title: "codegraph", description: "connected" },
    ])
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
})
