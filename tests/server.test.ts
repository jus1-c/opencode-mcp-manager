import { describe, expect, test } from "bun:test"
import { createServerPlugin } from "../src/server.js"
import { STORAGE_KEY, type TemplateStore } from "../src/store.js"

type ServerConfig = { disabled?: boolean }

function createFakeContext(initialStore?: TemplateStore) {
  const storage = new Map<string, unknown>()
  if (initialStore) storage.set(STORAGE_KEY, initialStore)

  const configs = new Map<string, ServerConfig>([
    ["docs", { disabled: false }],
    ["browser", { disabled: false }],
  ])
  const rpcHandlers = new Map<string, (input: unknown) => Promise<unknown>>()
  let reloads = 0

  const ctx = {
    location: { directory: "/project-a" },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
    mcp: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          list: () => [...configs.entries()],
          get: (name: string) => configs.get(name),
          update: (name: string, update: (config: ServerConfig) => void) => {
            const config = configs.get(name)
            if (config) update(config)
          },
        })
      },
      reload: async () => {
        reloads += 1
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        for (const [name, handler] of Object.entries(handlers)) rpcHandlers.set(name, handler)
      },
    },
  }

  return {
    ctx,
    storage,
    configs,
    rpc: (name: string) => {
      const handler = rpcHandlers.get(name)
      if (!handler) throw new Error(`RPC handler not registered: ${name}`)
      return handler
    },
    reloads: () => reloads,
  }
}

async function setup(initialStore?: TemplateStore) {
  const fake = createFakeContext(initialStore)
  const plugin = createServerPlugin()
  await plugin.setup(fake.ctx as never)
  return fake
}

describe("server plugin", () => {
  test("applies the default template to mcp configs via disabled flag", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: { docs: false, browser: true } } },
    })

    expect(fake.configs.get("docs")?.disabled).toBe(true)
    expect(fake.configs.get("browser")?.disabled).toBe(false)
  })

  test("persists newly discovered servers into the store", async () => {
    const fake = await setup()
    const stored = fake.storage.get(STORAGE_KEY) as TemplateStore
    expect(stored.templates.default?.mcp).toEqual({ docs: true, browser: true })
  })

  test("applies activeTemplates for the current location only", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      activeTemplates: { "/project-a": "minimal" },
      templates: {
        default: { mcp: { docs: true, browser: true } },
        minimal: { mcp: { docs: false, browser: true } },
      },
    })

    expect(fake.configs.get("docs")?.disabled).toBe(true)
    expect(fake.configs.get("browser")?.disabled).toBe(false)
  })

  test("apply RPC sets active template, reloads, and persists", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: {
        default: { mcp: { docs: true } },
        work: { mcp: { docs: false } },
      },
    })

    const result = (await fake.rpc("apply")({ name: "work", directory: "/project-a" })) as {
      store: TemplateStore
    }

    expect(result.store.activeTemplates).toEqual({ "/project-a": "work" })
    expect(fake.reloads()).toBe(1)
    expect((fake.storage.get(STORAGE_KEY) as TemplateStore).activeTemplates).toEqual({ "/project-a": "work" })
  })

  test("apply RPC rejects unknown templates", async () => {
    const fake = await setup()
    await expect(fake.rpc("apply")({ name: "ghost", directory: "/project-a" })).rejects.toThrow("Template not found")
  })

  test("save RPC stores the template and trims the name", async () => {
    const fake = await setup()
    await fake.rpc("save")({ name: "  work  ", template: { mcp: { docs: false } } })

    const stored = fake.storage.get(STORAGE_KEY) as TemplateStore
    expect(stored.templates.work?.mcp).toEqual({ docs: false })
  })

  test("setDefault and remove RPC update the store", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      activeTemplates: { "/project-a": "work" },
      templates: {
        default: { mcp: {} },
        work: { mcp: {} },
        extra: { mcp: {} },
      },
    })

    await fake.rpc("setDefault")({ name: "work" })
    expect((fake.storage.get(STORAGE_KEY) as TemplateStore).defaultTemplate).toBe("work")

    await fake.rpc("setDefault")({ name: "extra" })
    await fake.rpc("remove")({ name: "work" })
    const stored = fake.storage.get(STORAGE_KEY) as TemplateStore
    expect(stored.templates.work).toBeUndefined()
    expect(stored.activeTemplates).toBeUndefined()
  })

  test("clearActive RPC removes the directory entry", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      activeTemplates: { "/project-a": "work" },
      templates: { default: { mcp: {} }, work: { mcp: {} } },
    })

    await fake.rpc("clearActive")({ directory: "/project-a" })
    expect((fake.storage.get(STORAGE_KEY) as TemplateStore).activeTemplates).toBeUndefined()
  })

  test("list RPC returns the current store", async () => {
    const fake = await setup()
    const store = (await fake.rpc("list")({})) as TemplateStore
    expect(store.templates.default?.mcp).toEqual({ docs: true, browser: true })
  })
})
