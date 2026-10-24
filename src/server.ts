import { Plugin } from "@opencode/plugin"
import { McpManagerRpc } from "./rpc.js"
import {
  STORAGE_KEY,
  activeTemplateName,
  parseStore,
  removeTemplateFrom,
  setActiveTemplateIn,
  type Template,
  type TemplateStore,
} from "./store.js"
import { applyTemplateToConfig, reconcileStore } from "./template.js"

type ServerContext = {
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  mcp: {
    transform(callback: (editor: McpEditor) => void): Promise<unknown>
    reload(): Promise<void>
  }
  location: { directory: string }
  rpc: { register(definition: unknown, handlers: unknown): Promise<unknown> }
}

type McpEditor = {
  list(): readonly [string, { disabled?: boolean }][]
  get(name: string): { disabled?: boolean } | undefined
  update(name: string, update: (config: { disabled?: boolean }) => void): void
}

async function readStore(ctx: ServerContext): Promise<TemplateStore> {
  return parseStore(await ctx.storage.get(STORAGE_KEY))
}

async function writeStore(ctx: ServerContext, store: TemplateStore): Promise<TemplateStore> {
  await ctx.storage.set(STORAGE_KEY, store)
  await ctx.mcp.reload()
  return store
}

export function createServerPlugin() {
  return Plugin.define({
    id: "opencode-mcp-manager",
    async setup(ctx) {
      const serverCtx = ctx as unknown as ServerContext
      let snapshot = await readStore(serverCtx)

      await serverCtx.mcp.transform((editor) => {
        const names = editor.list().map(([name]) => name)
        const reconciled = reconcileStore(snapshot, names)
        if (reconciled.changed) {
          snapshot = reconciled.store
          void serverCtx.storage.set(STORAGE_KEY, snapshot)
        }
        const template = reconciled.store.templates[activeTemplateName(reconciled.store, serverCtx.location.directory)]
        if (!template) return
        for (const [name] of editor.list()) {
          const desired = template.mcp[name]
          if (desired === undefined) continue
          editor.update(name, (draft) => {
            draft.disabled = !desired
          })
        }
      })

      await serverCtx.rpc.register(McpManagerRpc, {
        list: async () => {
          snapshot = await readStore(serverCtx)
          return snapshot
        },
        apply: async (input: { name: string; directory: string }) => {
          const current = await readStore(serverCtx)
          if (!current.templates[input.name]) throw new Error(`Template not found: ${input.name}`)
          snapshot = await writeStore(serverCtx, setActiveTemplateIn(current, input.directory, input.name))
          return { store: snapshot }
        },
        save: async (input: { name: string; template: Template }) => {
          const current = await readStore(serverCtx)
          const name = input.name.trim()
          if (!name) throw new Error("Template name is required")
          snapshot = await writeStore(serverCtx, {
            ...current,
            templates: { ...current.templates, [name]: { mcp: { ...input.template.mcp } } },
          })
          return { store: snapshot }
        },
        setDefault: async (input: { name: string }) => {
          const current = await readStore(serverCtx)
          if (!current.templates[input.name]) throw new Error(`Template not found: ${input.name}`)
          snapshot = await writeStore(serverCtx, { ...current, defaultTemplate: input.name })
          return { store: snapshot }
        },
        remove: async (input: { name: string }) => {
          const current = await readStore(serverCtx)
          if (!current.templates[input.name]) throw new Error(`Template not found: ${input.name}`)
          snapshot = await writeStore(serverCtx, removeTemplateFrom(current, input.name))
          return { store: snapshot }
        },
        clearActive: async (input: { directory: string }) => {
          const current = await readStore(serverCtx)
          snapshot = await writeStore(serverCtx, setActiveTemplateIn(current, input.directory, undefined))
          return { store: snapshot }
        },
      })
    },
  })
}

export default createServerPlugin()
