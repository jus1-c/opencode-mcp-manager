import { Plugin } from "@opencode/plugin"
import { McpManagerRpc } from "./rpc.js"
import {
  STORAGE_KEY,
  activeTemplateName,
  parseStore,
  removeTemplateFrom,
  resolveServerEnabled,
  setActiveTemplateIn,
  setSessionOverrideIn,
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
  session: {
    hook(name: "context", callback: (event: SessionContextEvent) => void): Promise<unknown>
  }
}

type SessionContextEvent = {
  readonly sessionID: string
  readonly agent: unknown
  tools: Record<string, { description: string; input: unknown }>
}

type McpEditor = {
  list(): readonly [string, { disabled?: boolean }][]
  get(name: string): { disabled?: boolean } | undefined
  update(name: string, update: (config: { disabled?: boolean }) => void): void
}

async function readStore(ctx: ServerContext): Promise<TemplateStore> {
  return parseStore(await ctx.storage.get(STORAGE_KEY))
}

/**
 * Persist and reload. The in-memory snapshot must be updated before reload,
 * because reload runs the mcp transform synchronously and that transform reads
 * the snapshot to decide which servers to disable.
 */
async function writeStore(
  ctx: ServerContext,
  store: TemplateStore,
  setSnapshot: (next: TemplateStore) => void,
): Promise<TemplateStore> {
  setSnapshot(store)
  await ctx.storage.set(STORAGE_KEY, store)
  await ctx.mcp.reload()
  return store
}

/** MCP tools are registered as `<server>_<tool>`; the namespace is the sanitized server name. */
function toolServerNamespace(toolName: string, servers: readonly string[]): string | undefined {
  const match = servers
    .map((server) => ({ server, namespace: server.replace(/[^a-zA-Z0-9_-]/g, "_") }))
    .filter((entry) => toolName.startsWith(`${entry.namespace}_`))
    .sort((a, b) => b.namespace.length - a.namespace.length)[0]
  return match?.server
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

      // Per-session MCP tool filtering. Connections stay location-scoped, so an
      // override can only hide a server's tools from this session's model.
      await serverCtx.session.hook("context", (event) => {
        const store = snapshot
        const servers = Object.keys(store.templates[activeTemplateName(store, serverCtx.location.directory)]?.mcp ?? {})
        if (!servers.length) return
        for (const toolName of Object.keys(event.tools)) {
          const server = toolServerNamespace(toolName, servers)
          if (!server) continue
          if (!resolveServerEnabled(store, server, serverCtx.location.directory, event.sessionID)) {
            delete event.tools[toolName]
          }
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
          snapshot = await writeStore(serverCtx, setActiveTemplateIn(current, input.directory, input.name), (next) => { snapshot = next })
          return { store: snapshot }
        },
        save: async (input: { name: string; template: Template }) => {
          const current = await readStore(serverCtx)
          const name = input.name.trim()
          if (!name) throw new Error("Template name is required")
          snapshot = await writeStore(
            serverCtx,
            {
              ...current,
              templates: { ...current.templates, [name]: { mcp: { ...input.template.mcp } } },
            },
            (next) => {
              snapshot = next
            },
          )
          return { store: snapshot }
        },
        setDefault: async (input: { name: string }) => {
          const current = await readStore(serverCtx)
          if (!current.templates[input.name]) throw new Error(`Template not found: ${input.name}`)
          snapshot = await writeStore(serverCtx, { ...current, defaultTemplate: input.name }, (next) => { snapshot = next })
          return { store: snapshot }
        },
        remove: async (input: { name: string }) => {
          const current = await readStore(serverCtx)
          if (!current.templates[input.name]) throw new Error(`Template not found: ${input.name}`)
          snapshot = await writeStore(serverCtx, removeTemplateFrom(current, input.name), (next) => { snapshot = next })
          return { store: snapshot }
        },
        clearActive: async (input: { directory: string }) => {
          const current = await readStore(serverCtx)
          snapshot = await writeStore(serverCtx, setActiveTemplateIn(current, input.directory, undefined), (next) => { snapshot = next })
          return { store: snapshot }
        },
        getSessionOverride: async (input: { sessionID: string }) => {
          const current = await readStore(serverCtx)
          snapshot = current
          return { overrides: current.sessionOverrides?.[input.sessionID] ?? {} }
        },
        setSessionOverride: async (input: { sessionID: string; overrides: Record<string, boolean> }) => {
          const current = await readStore(serverCtx)
          // No mcp.reload(): an override only changes which tools the session sees.
          snapshot = setSessionOverrideIn(current, input.sessionID, input.overrides)
          await serverCtx.storage.set(STORAGE_KEY, snapshot)
          return { store: snapshot }
        },
        clearSessionOverride: async (input: { sessionID: string }) => {
          const current = await readStore(serverCtx)
          snapshot = setSessionOverrideIn(current, input.sessionID, undefined)
          await serverCtx.storage.set(STORAGE_KEY, snapshot)
          return { store: snapshot }
        },
      })
    },
  })
}

export default createServerPlugin()
