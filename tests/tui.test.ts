import { describe, expect, test } from "bun:test"
import { createTuiPlugin, runtimeTemplateFromStatuses } from "../src/tui.js"
import type { TemplateStore } from "../src/store.js"

type SelectOptions = {
  title: string
  options: { title: string; value: unknown }[]
}

function createFakeContext(store: TemplateStore) {
  const selections: unknown[] = []
  const prompts: string[] = []
  const toasts: { title?: string; message: string; variant?: string }[] = []
  const commands: { id: string; slash?: { name: string }; run: () => unknown }[] = []
  const calls: string[] = []

  const rpc = {
    list: async () => store,
    apply: async (input: { name: string; directory: string }) => {
      calls.push(`apply:${input.name}:${input.directory}`)
      return { store }
    },
    save: async (input: { name: string; template: unknown }) => {
      calls.push(`save:${input.name}`)
      return { store }
    },
    setDefault: async (input: { name: string }) => {
      calls.push(`setDefault:${input.name}`)
      return { store }
    },
    remove: async (input: { name: string }) => {
      calls.push(`remove:${input.name}`)
      return { store }
    },
    clearActive: async () => ({ store }),
  }

  const ctx = {
    location: { directory: "/project-a" },
    client: { rpc: () => rpc },
    data: {
      location: {
        default: () => ({ directory: "/project-a" }),
        mcp: {
          server: {
            list: () => [
              { name: "docs", status: { status: "connected" } },
              { name: "browser", status: { status: "disabled" } },
            ],
          },
        },
      },
    },
    keymap: {
      layer(factory: () => { commands: typeof commands }) {
        commands.push(...factory().commands)
      },
    },
    ui: {
      dialog: {
        select: async (options: SelectOptions) => {
          const next = selections.shift()
          if (next === undefined) return undefined
          return next
        },
        prompt: async () => prompts.shift(),
        confirm: async () => true,
        alert: async () => undefined,
      },
      toast: {
        show: (options: { title?: string; message: string; variant?: string }) => {
          toasts.push(options)
        },
      },
    },
  }

  return {
    ctx,
    selections,
    prompts,
    toasts,
    calls,
    commands,
    run: async (command: (typeof commands)[number]) => command.run(),
  }
}

function sampleStore(): TemplateStore {
  return {
    version: 1,
    defaultTemplate: "default",
    templates: {
      default: { mcp: { docs: true, browser: false } },
      work: { mcp: { docs: false, browser: true } },
      extra: { mcp: {} },
    },
  }
}

async function setup(store = sampleStore()) {
  const fake = createFakeContext(store)
  await createTuiPlugin().setup(fake.ctx as never)
  return fake
}

describe("TUI plugin", () => {
  test("builds current template from configured servers only", () => {
    expect(
      runtimeTemplateFromStatuses(["docs", "browser"], {
        docs: { status: "connected" },
        browser: { status: "disabled" },
        dynamic: { status: "connected" },
      }),
    ).toEqual({ mcp: { docs: true, browser: false } })
  })

  test("registers the mcp-man slash command", async () => {
    const fake = await setup()
    expect(fake.commands[0]).toMatchObject({ id: "mcp-manager.open", slash: { name: "mcp-man" } })
  })

  test("apply flow calls the RPC with the current directory", async () => {
    const fake = await setup()
    fake.selections.push("apply", "work")

    await fake.run(fake.commands[0]!)

    expect(fake.calls).toEqual(["apply:work:/project-a"])
    expect(fake.toasts.at(-1)).toMatchObject({ variant: "success", message: "work" })
  })

  test("save flow captures the current runtime state", async () => {
    const fake = await setup()
    fake.selections.push("save")
    fake.prompts.push("snapshot")

    await fake.run(fake.commands[0]!)

    expect(fake.calls).toEqual(["save:snapshot"])
  })

  test("default flow calls setDefault", async () => {
    const fake = await setup()
    fake.selections.push("default", "work")

    await fake.run(fake.commands[0]!)

    expect(fake.calls).toEqual(["setDefault:work"])
  })

  test("delete flow calls remove", async () => {
    const fake = await setup()
    fake.selections.push("delete", "work")

    await fake.run(fake.commands[0]!)

    expect(fake.calls).toEqual(["remove:work"])
  })

  test("delete flow reports when no non-default templates exist", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: {} } },
    })
    fake.selections.push("delete")

    await fake.run(fake.commands[0]!)

    expect(fake.calls).toEqual([])
    expect(fake.toasts.at(-1)).toMatchObject({ variant: "info" })
  })

  test("cancelling the menu does nothing", async () => {
    const fake = await setup()
    await fake.run(fake.commands[0]!)
    expect(fake.calls).toEqual([])
  })
})
