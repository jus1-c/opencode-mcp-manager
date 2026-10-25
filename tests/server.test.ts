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
  const sessionHooks: ((event: unknown) => void)[] = []
  const transforms: ((editor: unknown) => void)[] = []
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
        transforms.push(callback)
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
        // Reload re-runs the registered transforms, as the real service does.
        for (const callback of transforms) {
          callback({
            list: () => [...configs.entries()],
            get: (name: string) => configs.get(name),
            update: (name: string, update: (config: ServerConfig) => void) => {
              const config = configs.get(name)
              if (config) update(config)
            },
          })
        }
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        for (const [name, handler] of Object.entries(handlers)) rpcHandlers.set(name, handler)
      },
    },
    session: {
      hook: async (_name: string, callback: (event: unknown) => void) => {
        sessionHooks.push(callback)
        return {}
      },
    },
  }

  return {
    ctx,
    storage,
    configs,
    sessionHooks,
    rpc: (name: string) => {
      const handler = rpcHandlers.get(name)
      if (!handler) throw new Error(`RPC handler not registered: ${name}`)
      return handler
    },
    reload: () => ctx.mcp.reload(),
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

  test("persists newly discovered servers into the store as disabled", async () => {
    const fake = await setup()
    const stored = fake.storage.get(STORAGE_KEY) as TemplateStore
    expect(stored.templates.default?.mcp).toEqual({ docs: false, browser: false })
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

    const result = (await fake.rpc("apply")({ name: "work" })) as {
      store: TemplateStore
    }

    expect(result.store.activeTemplates).toEqual({ "/project-a": "work" })
    expect(fake.reloads()).toBe(1)
    expect((fake.storage.get(STORAGE_KEY) as TemplateStore).activeTemplates).toEqual({ "/project-a": "work" })
  })

  test("apply writes the server's location, not one supplied by the caller", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: {
        default: { mcp: { docs: true } },
        work: { mcp: { docs: false } },
      },
    })

    // A caller cannot redirect the write: the input has no directory field.
    await fake.rpc("apply")({ name: "work", directory: "/elsewhere" })

    const stored = fake.storage.get(STORAGE_KEY) as TemplateStore
    expect(stored.activeTemplates).toEqual({ "/project-a": "work" })
    expect(fake.configs.get("docs")?.disabled).toBe(true)
  })

  test("reload during apply sees the new template, not the stale snapshot", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: {
        default: { mcp: { docs: true, browser: true } },
        work: { mcp: { docs: false, browser: true } },
      },
    })
    // both enabled under the default template
    expect(fake.configs.get("docs")?.disabled).toBe(false)

    await fake.rpc("apply")({ name: "work" })

    // the transform ran again on reload and must have seen "work"
    expect(fake.configs.get("docs")?.disabled).toBe(true)
    expect(fake.configs.get("browser")?.disabled).toBe(false)
  })

  test("apply RPC rejects unknown templates", async () => {
    const fake = await setup()
    await expect(fake.rpc("apply")({ name: "ghost" })).rejects.toThrow("Template not found")
  })

  test("save RPC stores the template and trims the name", async () => {
    const fake = await setup()
    await fake.rpc("save")({ name: "  work  ", template: { mcp: { docs: false } } })

    const stored = fake.storage.get(STORAGE_KEY) as TemplateStore
    expect(stored.templates.work?.mcp).toEqual({ docs: false })
  })

  test("save reloads only when the template governs this location", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      activeTemplates: { "/project-a": "work" },
      templates: {
        default: { mcp: { docs: true, browser: true } },
        work: { mcp: { docs: true, browser: true } },
      },
    })
    const before = fake.reloads()

    // Editing an unrelated template only persists.
    await fake.rpc("save")({ name: "other", template: { mcp: { docs: false } } })
    expect(fake.reloads()).toBe(before)

    // Editing the active template applies immediately.
    await fake.rpc("save")({ name: "work", template: { mcp: { docs: false, browser: true } } })
    expect(fake.reloads()).toBe(before + 1)
    expect(fake.configs.get("docs")?.disabled).toBe(true)
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

    await fake.rpc("clearActive")({})
    expect((fake.storage.get(STORAGE_KEY) as TemplateStore).activeTemplates).toBeUndefined()
  })

  test("list RPC returns the current store", async () => {
    const fake = await setup()
    const store = (await fake.rpc("list")({})) as TemplateStore
    expect(store.templates.default?.mcp).toEqual({ docs: false, browser: false })
  })

  test("session override hides MCP tools from that session only", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: { docs: true, browser: true } } },
    })

    await fake.rpc("setSessionOverride")({ sessionID: "ses_a", overrides: { docs: false } })

    const hook = fake.sessionHooks[0]!
    const toolsA = { docs_search: {}, browser_open: {}, read: {} }
    hook({ sessionID: "ses_a", tools: toolsA })
    expect(Object.keys(toolsA).sort()).toEqual(["browser_open", "read"])

    const toolsB = { docs_search: {}, browser_open: {}, read: {} }
    hook({ sessionID: "ses_b", tools: toolsB })
    expect(Object.keys(toolsB).sort()).toEqual(["browser_open", "docs_search", "read"])
  })

  test("session override does not reload MCP connections", async () => {
    const fake = await setup()
    const before = fake.reloads()

    await fake.rpc("setSessionOverride")({ sessionID: "ses_a", overrides: { docs: false } })

    expect(fake.reloads()).toBe(before)
  })

  test("getSessionOverride and clearSessionOverride round trip", async () => {
    const fake = await setup()
    await fake.rpc("setSessionOverride")({ sessionID: "ses_a", overrides: { docs: false, browser: true } })

    const read = (await fake.rpc("getSessionOverride")({ sessionID: "ses_a" })) as {
      overrides: Record<string, boolean>
    }
    expect(read.overrides).toEqual({ docs: false, browser: true })

    await fake.rpc("clearSessionOverride")({ sessionID: "ses_a" })
    const cleared = (await fake.rpc("getSessionOverride")({ sessionID: "ses_a" })) as {
      overrides: Record<string, boolean>
    }
    expect(cleared.overrides).toEqual({})
  })

  test("a server appearing mid-session joins templates disabled and keeps overrides", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: { docs: true, browser: false } } },
    })
    await fake.rpc("setSessionOverride")({ sessionID: "ses_a", overrides: { docs: false } })

    // A config change adds a server while the session is open.
    fake.configs.set("fresh", { disabled: false })
    await fake.reload()

    const stored = fake.storage.get(STORAGE_KEY) as TemplateStore
    expect(stored.templates.default?.mcp.fresh).toBe(false)
    expect(fake.configs.get("fresh")?.disabled).toBe(true)
    expect(stored.sessionOverrides?.ses_a).toEqual({ docs: false })
  })

  test("session hook filters tools of a server that appeared mid-session", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: { docs: true, browser: true } } },
    })
    fake.configs.set("fresh", { disabled: false })
    await fake.reload()

    const hook = fake.sessionHooks[0]!
    const tools = { fresh_tool: {}, docs_search: {} }
    hook({ sessionID: "ses_a", tools })
    // fresh is off by default, so its tool must be filtered even though the
    // template listed it only after the reload.
    expect(Object.keys(tools)).toEqual(["docs_search"])
  })

  test("a removed server is pruned from templates", async () => {
    const fake = await setup({
      version: 1,
      defaultTemplate: "default",
      templates: { default: { mcp: { docs: true, browser: true } } },
    })
    fake.configs.delete("browser")
    await fake.reload()

    const stored = fake.storage.get(STORAGE_KEY) as TemplateStore
    expect(stored.templates.default?.mcp).toEqual({ docs: true })
  })
})
