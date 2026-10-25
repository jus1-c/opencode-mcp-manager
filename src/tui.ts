import { Plugin } from "@opencode/plugin/tui"
import { McpManagerRpc } from "./rpc.js"
import { registerSidebar, type SidebarHandle } from "./sidebar.js"
import type { Template, TemplateStore } from "./store.js"
import { isRuntimeEnabled, type RuntimeStatusMap } from "./template.js"

export type TuiContext = {
  location: { directory: string } | undefined
  theme: { text: { muted: string } }
  client: { rpc(definition: unknown): McpClient }
  data: {
    on<Type extends string>(type: Type, handler: (event: { data: Record<string, string> }) => void): () => void
    location: {
      default(): { directory: string }
      mcp: { server: { list(location?: { directory: string }): ServerStatus[] | undefined } }
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
    toast: { show(options: { title?: string; message: string; variant?: string; duration?: number }): void }
    router: { current(): { type: string; sessionID?: string } }
    slot(claim: {
      append: "sidebar.content"
      render: (input: { sessionID: string }) => unknown
    }): () => void
  }
}

/** Second RPC argument: routes the call to this location's plugin instance. */
type RpcOptions = { location?: { directory: string } }

export type McpClient = {
  list(input?: unknown, options?: RpcOptions): Promise<TemplateStore>
  apply(input: { name: string }, options?: RpcOptions): Promise<{ store: TemplateStore }>
  save(input: { name: string; template: Template }, options?: RpcOptions): Promise<{ store: TemplateStore }>
  setDefault(input: { name: string }, options?: RpcOptions): Promise<{ store: TemplateStore }>
  remove(input: { name: string }, options?: RpcOptions): Promise<{ store: TemplateStore }>
  clearActive(input?: unknown, options?: RpcOptions): Promise<{ store: TemplateStore }>
  getSessionOverride(input: { sessionID: string }, options?: RpcOptions): Promise<{ overrides: Record<string, boolean> }>
  setSessionOverride(
    input: {
      sessionID: string
      overrides: Record<string, boolean>
    },
    options?: RpcOptions,
  ): Promise<{ store: TemplateStore }>
  clearSessionOverride(input: { sessionID: string }, options?: RpcOptions): Promise<{ store: TemplateStore }>
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

type ServerStatus = { name: string; status: { status: string; error?: string } }

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
      const sidebar = registerSidebar(context, rpc)

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
            run: () => openManager(context, rpc, sidebar),
          },
        ],
      }))

      // Auto-capture manual toggles: /mcps or the sidebar disconnect/connect a
      // server while a session is open, so pin that server for the session
      // instead of asking the user to open the override menu afterwards.
      context.data.on("mcp.status.changed", (event) => {
        const server = event.data.server
        if (!server) return
        // The runtime settles one server at a time; refresh the line so it stops
        // reading as "custom" while servers are still connecting.
        void sidebar.refresh()
        void captureManualToggle(context, rpc, server, sidebar)
      })
    },
  })
}

async function captureManualToggle(
  ctx: TuiContext,
  rpc: McpClient,
  server: string,
  sidebar: SidebarHandle,
): Promise<void> {
  try {
    // Applying a template settles every server, which emits status changes that
    // are not user toggles. Pinning them would corrupt the session override.
    if (sidebar.isApplying()) return
    const route = ctx.ui.router.current()
    if (route.type !== "session" || !route.sessionID) return
    const sessionID = route.sessionID
    const directory = currentDirectory(ctx)
    const options = { location: { directory } }

    const servers = ctx.data.location.mcp.server.list({ directory }) ?? []
    const status = servers.find((entry) => entry.name === server)?.status.status
    if (!status || status === "pending") return
    // A reload settles every server at once. While any server is still pending
    // the list is churning, so a difference here is not a user toggle.
    if (servers.some((entry) => entry.status.status === "pending")) return

    const { overrides } = await rpc.getSessionOverride({ sessionID }, options)
    if (server in overrides) return

    const store = await rpc.list({}, options)
    const templateEnabled = resolveFromStore(store, server, directory)
    const actualEnabled = status !== "disabled"
    if (templateEnabled === actualEnabled) return

    // Re-read right before writing: a reload that started after the checks above
    // would otherwise be pinned as if the user had toggled it.
    const latest = ctx.data.location.mcp.server.list({ directory }) ?? []
    if (latest.some((entry) => entry.status.status === "pending")) return

    await rpc.setSessionOverride({ sessionID, overrides: { ...overrides, [server]: actualEnabled } }, options)
    void sidebar.refresh()
    ctx.ui.toast.show({
      variant: "info",
      title: "MCP pinned to this session",
      message: `${server}: ${actualEnabled ? "on" : "off"} (override > template)`,
      duration: 2500,
    })
  } catch {
    // Auto-capture is best-effort; never surface a toast for a background event.
  }
}

async function openManager(ctx: TuiContext, rpc: McpClient, sidebar: SidebarHandle): Promise<void> {
  try {
    const directory = currentDirectory(ctx)
    const options = { location: { directory } }
    const store = await rpc.list({}, options)
    const action = await ctx.ui.dialog.select({
      title: "MCP Manager",
      placeholder: "Choose an action",
      options: [
        { title: "Apply template", value: "apply" },
        { title: "Edit template", value: "edit", description: "Toggle servers inside a saved template" },
        { title: "Session MCP override", value: "session", description: "Pick MCP servers for this session only" },
        { title: "Save current state", value: "save" },
        { title: "Set default template", value: "default" },
        { title: "Delete template", value: "delete" },
      ],
    })
    if (!action) return

    if (action === "apply") await applyTemplate(ctx, rpc, store, sidebar)
    else if (action === "edit") await editTemplate(ctx, rpc, store, sidebar)
    else if (action === "session") await sessionOverride(ctx, rpc, store, sidebar)
    else if (action === "save") await saveCurrentState(ctx, rpc, sidebar)
    else if (action === "default") await changeDefault(ctx, rpc, store, sidebar)
    else await removeTemplate(ctx, rpc, store, sidebar)
  } catch (error) {
    showError(ctx, error)
  }
}

async function applyTemplate(
  ctx: TuiContext,
  rpc: McpClient,
  store: TemplateStore,
  sidebar: SidebarHandle,
): Promise<void> {
  const name = await ctx.ui.dialog.select({
    title: "Apply template",
    placeholder: "Choose a template",
    options: Object.keys(store.templates).map((template) => ({
      title: template + (template === store.defaultTemplate ? " (default)" : ""),
      value: template,
    })),
  })
  if (!name) return

  const directory = currentDirectory(ctx)
  const options = { location: { directory } }
  sidebar.setApplying(name)
  ctx.ui.toast.show({ variant: "info", title: "MCP Manager", message: `Applying ${name}…` })

  const { store: next } = await rpc.apply({ name }, options)
  // Safety net: the server writes to its own location, so a mismatch here means
  // the call landed somewhere else and the template will not take effect.
  if (next.activeTemplates?.[directory] !== name) {
    sidebar.setApplying(undefined)
    ctx.ui.toast.show({
      variant: "error",
      title: "MCP Manager",
      message: `Server did not record ${name} for this project`,
    })
    return
  }

  const settled = await waitForSettled(ctx, next.templates[name], directory)
  sidebar.setApplying(undefined)
  if (settled.pending.length > 0) {
    ctx.ui.toast.show({
      variant: "warning",
      title: "MCP template applied",
      message: `${name}: ${settled.on} on, ${settled.off} off — still connecting: ${settled.pending.join(", ")}`,
    })
    return
  }
  ctx.ui.toast.show({
    variant: "success",
    title: "MCP template applied",
    message: `${name}: ${settled.on} on, ${settled.off} off`,
  })
}

/**
 * The runtime settles one server at a time and a slow server can hold the rest,
 * so poll until nothing is pending instead of assuming apply finished.
 */
async function waitForSettled(
  ctx: TuiContext,
  template: Template | undefined,
  directory: string,
  timeoutMs = 45_000,
): Promise<{ on: number; off: number; pending: string[] }> {
  const deadline = Date.now() + timeoutMs
  const desired = template?.mcp ?? {}
  const count = (servers: readonly ServerStatus[]) => {
    const pending = servers.filter((server) => server.status.status === "pending").map((server) => server.name)
    const wanted = servers.filter((server) => desired[server.name] !== undefined)
    const on = wanted.filter((server) => server.status.status !== "disabled").length
    return { on, off: wanted.length - on, pending }
  }

  for (;;) {
    const result = count(ctx.data.location.mcp.server.list({ directory }) ?? [])
    if (result.pending.length === 0 || Date.now() >= deadline) return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function sessionOverride(
  ctx: TuiContext,
  rpc: McpClient,
  store: TemplateStore,
  sidebar: SidebarHandle,
): Promise<void> {
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
  const options = { location: { directory } }
  const template = store.templates[store.activeTemplates?.[directory] ?? store.defaultTemplate]
  // Union with the configured servers so a server that appeared mid-session is
  // pinnable here too.
  const servers = [...new Set([...Object.keys(template?.mcp ?? {}), ...serverStatuses(ctx).names])].sort()
  if (!servers.length) {
    ctx.ui.toast.show({ variant: "info", title: "MCP Manager", message: "No MCP servers configured" })
    return
  }

  const { overrides: current } = await rpc.getSessionOverride({ sessionID }, options)
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
    await rpc.clearSessionOverride({ sessionID }, options)
    void sidebar.refresh()
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
    await rpc.setSessionOverride({ sessionID, overrides: next }, options)
    void sidebar.refresh()
  }

  ctx.ui.toast.show({
    variant: "success",
    title: "Session override saved",
    message: `${Object.keys(next).length} server(s) pinned to this session`,
  })
}

/**
 * Edit a saved template in place. Toggling a server in the template that
 * governs this project takes effect immediately; other templates only persist.
 */
async function editTemplate(
  ctx: TuiContext,
  rpc: McpClient,
  store: TemplateStore,
  sidebar: SidebarHandle,
): Promise<void> {
  const directory = currentDirectory(ctx)
  const options = { location: { directory } }
  const active = store.activeTemplates?.[directory] ?? store.defaultTemplate

  const name = await ctx.ui.dialog.select({
    title: "Edit template",
    placeholder: "Choose a template",
    options: Object.keys(store.templates).map((template) => ({
      title: template + (template === active ? " (active here)" : ""),
      value: template,
    })),
  })
  if (!name) return

  const template = store.templates[name]
  if (!template) return

  // Include servers the template does not list yet, so a newly configured MCP
  // can be enabled here instead of only through "Save current state".
  const { names } = serverStatuses(ctx)
  const servers = [...new Set([...Object.keys(template.mcp), ...names])].sort()
  if (!servers.length) {
    ctx.ui.toast.show({ variant: "info", title: "MCP Manager", message: "No MCP servers configured" })
    return
  }

  const next: Record<string, boolean> = { ...template.mcp }
  for (const server of servers) next[server] = next[server] ?? false

  let changed = false
  for (;;) {
    const server = await ctx.ui.dialog.select({
      title: `Edit template: ${name}`,
      placeholder: "Toggle a server",
      options: servers.map((entry) => ({
        title: entry,
        value: entry,
        description: next[entry] ? "on" : "off",
      })),
    })
    if (!server) break

    next[server] = !next[server]
    changed = true
    await rpc.save({ name, template: { mcp: next } }, options)
    void sidebar.refresh()
    ctx.ui.toast.show({
      variant: "info",
      title: `Template ${name}`,
      message: `${server}: ${next[server] ? "on" : "off"} (saved)`,
      duration: 1500,
    })
  }

  if (!changed) return
  ctx.ui.toast.show({
    variant: "success",
    title: "Template saved",
    message: name === active ? `${name} — applied to this project` : name,
  })
}

function resolveFromStore(store: TemplateStore, server: string, directory: string): boolean {
  const name = store.activeTemplates?.[directory] ?? store.defaultTemplate
  return store.templates[name]?.mcp[server] ?? false
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

async function saveCurrentState(ctx: TuiContext, rpc: McpClient, sidebar: SidebarHandle): Promise<void> {
  const name = await ctx.ui.dialog.prompt({ title: "Save current MCP state", placeholder: "work" })
  if (!name) return

  const { names, statuses } = serverStatuses(ctx)
  const options = { location: { directory: currentDirectory(ctx) } }
  await rpc.save({ name, template: runtimeTemplateFromStatuses(names, statuses) }, options)
  void sidebar.refresh()
  ctx.ui.toast.show({ variant: "success", title: "MCP template saved", message: name.trim() })
}

async function changeDefault(
  ctx: TuiContext,
  rpc: McpClient,
  store: TemplateStore,
  sidebar: SidebarHandle,
): Promise<void> {
  const name = await ctx.ui.dialog.select({
    title: "Set default template",
    current: store.defaultTemplate,
    options: Object.keys(store.templates).map((template) => ({ title: template, value: template })),
  })
  if (!name) return

  await rpc.setDefault({ name }, { location: { directory: currentDirectory(ctx) } })
  void sidebar.refresh()
  ctx.ui.toast.show({ variant: "success", title: "Default template changed", message: name })
}

async function removeTemplate(
  ctx: TuiContext,
  rpc: McpClient,
  store: TemplateStore,
  sidebar: SidebarHandle,
): Promise<void> {
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

  await rpc.remove({ name }, { location: { directory: currentDirectory(ctx) } })
  void sidebar.refresh()
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
