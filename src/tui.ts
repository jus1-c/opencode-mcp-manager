import { Plugin } from "@opencode/plugin/tui"
import { McpManagerRpc } from "./rpc.js"
import type { Template, TemplateStore } from "./store.js"
import { isRuntimeEnabled, type RuntimeStatusMap } from "./template.js"

type TuiContext = {
  location: { directory: string } | undefined
  client: { rpc(definition: unknown): McpClient }
  data: {
    location: {
      default(): { directory: string }
      mcp: { server: { list(location?: { directory: string }): McpServer[] | undefined } }
    }
  }
  keymap: {
    layer(factory: () => { mode?: string; commands: Command[] }): void
  }
  ui: {
    dialog: {
      select<Value>(options: SelectOptions<Value>): Promise<Value | undefined>
      prompt(options: { title: string; placeholder?: string }): Promise<string | undefined>
      confirm(options: { title: string; message: string; label?: { confirm?: string; cancel?: string } }): Promise<boolean | undefined>
      alert(options: { title: string; message: string }): Promise<void>
    }
    toast: { show(options: { title?: string; message: string; variant?: string }): void }
    router: { current(): { type: string; sessionID?: string } }
  }
}

type McpServer = { name: string; status: { status: string; error?: string } }

type McpClient = {
  list(input?: unknown): Promise<TemplateStore>
  apply(input: { name: string; directory: string }): Promise<{ store: TemplateStore }>
  save(input: { name: string; template: Template }): Promise<{ store: TemplateStore }>
  setDefault(input: { name: string }): Promise<{ store: TemplateStore }>
  remove(input: { name: string }): Promise<{ store: TemplateStore }>
  clearActive(input: { directory: string }): Promise<{ store: TemplateStore }>
  getSessionOverride(input: { sessionID: string }): Promise<{ overrides: Record<string, boolean> }>
  setSessionOverride(input: {
    sessionID: string
    overrides: Record<string, boolean>
  }): Promise<{ store: TemplateStore }>
  clearSessionOverride(input: { sessionID: string }): Promise<{ store: TemplateStore }>
}

type Command = {
  id: string
  title: string
  description?: string
  group?: string
  palette?: true
  slash?: { name: string; aliases?: string[] }
  run: () => void | Promise<void>
}

type SelectOptions<Value> = {
  title: string
  placeholder?: string
  options: { title: string; value: Value; description?: string; category?: string }[]
  current?: Value
}

export function runtimeTemplateFromStatuses(
  serverNames: readonly string[],
  statuses: RuntimeStatusMap,
): Template {
  return {
    mcp: Object.fromEntries(serverNames.map((name) => [name, isRuntimeEnabled(statuses[name])])),
  }
}

function currentDirectory(ctx: TuiContext): string {
  return ctx.location?.directory ?? ctx.data.location.default().directory
}

function serverStatuses(ctx: TuiContext): { names: string[]; statuses: RuntimeStatusMap } {
  const directory = currentDirectory(ctx)
  const servers = ctx.data.location.mcp.server.list({ directory }) ?? []
  const statuses: RuntimeStatusMap = {}
  for (const server of servers) statuses[server.name] = server.status
  return { names: servers.map((server) => server.name), statuses }
}

export function createTuiPlugin() {
  return Plugin.define({
    id: "opencode-mcp-manager.tui",
    setup(ctx) {
      const context = ctx as unknown as TuiContext
      const rpc = context.client.rpc(McpManagerRpc)

      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "mcp-manager.open",
            title: "MCP Manager",
            description: "Manage MCP server templates",
            group: "Plugin",
            palette: true,
            slash: { name: "mcp-man" },
            run: () => openManager(context, rpc),
          },
        ],
      }))
    },
  })
}

async function openManager(ctx: TuiContext, rpc: McpClient): Promise<void> {
  try {
    const store = await rpc.list({})
    const action = await ctx.ui.dialog.select({
      title: "MCP Manager",
      placeholder: "Choose an action",
      options: [
        { title: "Apply template", value: "apply" },
        { title: "Session MCP override", value: "session", description: "Pick MCP servers for this session only" },
        { title: "Save current state", value: "save" },
        { title: "Set default template", value: "default" },
        { title: "Delete template", value: "delete" },
      ],
    })
    if (!action) return

    if (action === "apply") await applyTemplate(ctx, rpc, store)
    else if (action === "session") await sessionOverride(ctx, rpc, store)
    else if (action === "save") await saveCurrentState(ctx, rpc)
    else if (action === "default") await changeDefault(ctx, rpc, store)
    else await removeTemplate(ctx, rpc, store)
  } catch (error) {
    showError(ctx, error)
  }
}

async function applyTemplate(ctx: TuiContext, rpc: McpClient, store: TemplateStore): Promise<void> {
  const name = await ctx.ui.dialog.select({
    title: "Apply template",
    placeholder: "Choose a template",
    options: Object.keys(store.templates).map((template) => ({
      title: template + (template === store.defaultTemplate ? " (default)" : ""),
      value: template,
    })),
  })
  if (!name) return

  await rpc.apply({ name, directory: currentDirectory(ctx) })
  ctx.ui.toast.show({ variant: "success", title: "MCP template applied", message: name })
}

async function sessionOverride(ctx: TuiContext, rpc: McpClient, store: TemplateStore): Promise<void> {
  const route = ctx.ui.router.current()
  if (route.type !== "session" || !route.sessionID) {
    ctx.ui.toast.show({
      variant: "warning",
      title: "MCP Manager",
      message: "Open a session first — the override applies to one session",
    })
    return
  }
  const sessionID = route.sessionID
  const directory = currentDirectory(ctx)
  const template = store.templates[store.activeTemplates?.[directory] ?? store.defaultTemplate]
  const servers = Object.keys(template?.mcp ?? {})
  if (!servers.length) {
    ctx.ui.toast.show({ variant: "info", title: "MCP Manager", message: "No MCP servers configured" })
    return
  }

  const { overrides: current } = await rpc.getSessionOverride({ sessionID })
  const choice = await ctx.ui.dialog.select({
    title: "Session MCP override",
    placeholder: "Choose an action",
    options: [
      {
        title: current && Object.keys(current).length ? "Edit override" : "Create override",
        value: "edit" as const,
        description: Object.keys(current).length
          ? `${Object.keys(current).length} server(s) pinned`
          : "Pin MCP servers for this session only",
      },
      ...(Object.keys(current).length
        ? [{ title: "Clear override (fall back to template)", value: "clear" as const }]
        : []),
    ],
  })
  if (!choice) return

  if (choice === "clear") {
    await rpc.clearSessionOverride({ sessionID })
    ctx.ui.toast.show({ variant: "success", title: "Session override cleared", message: "Falls back to template" })
    return
  }

  const next: Record<string, boolean> = { ...current }
  let editing = true
  while (editing) {
    const server = await ctx.ui.dialog.select({
      title: "Session MCP override",
      placeholder: "Toggle a server",
      options: servers.map((name) => ({
        title: name,
        value: name,
        description: describeState(name, next, store, directory),
      })),
    })
    if (!server) break

    const resolved = next[server] ?? resolveFromStore(store, server, directory)
    next[server] = !resolved
    await rpc.setSessionOverride({ sessionID, overrides: next })
  }

  ctx.ui.toast.show({
    variant: "success",
    title: "Session override saved",
    message: `${Object.keys(next).length} server(s) pinned to this session`,
  })
}

function resolveFromStore(store: TemplateStore, server: string, directory: string): boolean {
  const name = store.activeTemplates?.[directory] ?? store.defaultTemplate
  return store.templates[name]?.mcp[server] ?? true
}

function describeState(
  server: string,
  override: Record<string, boolean>,
  store: TemplateStore,
  directory: string,
): string {
  const pinned = override[server]
  if (pinned !== undefined) return pinned ? "session: on (pinned)" : "session: off (pinned)"
  return resolveFromStore(store, server, directory) ? "template: on" : "template: off"
}

async function saveCurrentState(ctx: TuiContext, rpc: McpClient): Promise<void> {
  const name = await ctx.ui.dialog.prompt({ title: "Save current MCP state", placeholder: "work" })
  if (!name) return

  const { names, statuses } = serverStatuses(ctx)
  await rpc.save({ name, template: runtimeTemplateFromStatuses(names, statuses) })
  ctx.ui.toast.show({ variant: "success", title: "MCP template saved", message: name.trim() })
}

async function changeDefault(ctx: TuiContext, rpc: McpClient, store: TemplateStore): Promise<void> {
  const name = await ctx.ui.dialog.select({
    title: "Set default template",
    current: store.defaultTemplate,
    options: Object.keys(store.templates).map((template) => ({ title: template, value: template })),
  })
  if (!name) return

  await rpc.setDefault({ name })
  ctx.ui.toast.show({ variant: "success", title: "Default template changed", message: name })
}

async function removeTemplate(ctx: TuiContext, rpc: McpClient, store: TemplateStore): Promise<void> {
  const names = Object.keys(store.templates).filter((name) => name !== store.defaultTemplate)
  if (!names.length) {
    ctx.ui.toast.show({ variant: "info", title: "MCP Manager", message: "No non-default templates to delete" })
    return
  }

  const name = await ctx.ui.dialog.select({
    title: "Delete template",
    options: names.map((template) => ({ title: template, value: template })),
  })
  if (!name) return

  const confirmed = await ctx.ui.dialog.confirm({ title: "Delete template", message: `Delete ${name}?` })
  if (!confirmed) return

  await rpc.remove({ name })
  ctx.ui.toast.show({ variant: "success", title: "MCP template deleted", message: name })
}

function showError(ctx: TuiContext, error: unknown): void {
  ctx.ui.toast.show({ variant: "error", title: "MCP Manager", message: errorMessage(error) })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}

export default createTuiPlugin()
