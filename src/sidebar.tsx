import { createEffect, createSignal } from "solid-js"
import type { McpClient, TuiContext } from "./tui.js"
import type { TemplateStore } from "./store.js"

export type SidebarState = {
  template: string
  custom: boolean
  applying?: string
}

export function describeTemplateLine(state: SidebarState | undefined): string {
  if (!state) return "MCP  …"
  if (state.applying) return `MCP  applying ${state.applying} …`
  return `MCP  ${state.template}${state.custom ? " (custom)" : ""}`
}

type ServerStatus = { name: string; status: { status: string } }

/**
 * A template is "custom" when the session pins servers, or when the runtime
 * disagrees with the template for a server that is currently loaded.
 */
export function isCustomized(
  store: TemplateStore,
  templateName: string,
  directory: string,
  sessionID: string | undefined,
  statuses: readonly ServerStatus[],
): boolean {
  if (sessionID && Object.keys(store.sessionOverrides?.[sessionID] ?? {}).length > 0) return true
  const template = store.templates[templateName]
  if (!template) return false
  for (const server of statuses) {
    const desired = template.mcp[server.name]
    if (desired === undefined) continue
    // A pending server has not settled yet; comparing it would report a
    // difference that the runtime is about to resolve.
    if (server.status.status === "pending") continue
    if (desired !== (server.status.status !== "disabled")) return true
  }
  return false
}

export function activeTemplateFor(store: TemplateStore, directory: string): string {
  const active = store.activeTemplates?.[directory]
  return active && store.templates[active] ? active : store.defaultTemplate
}

export type SidebarHandle = {
  /** Recompute the line from the store and the runtime statuses. */
  refresh(): Promise<void>
  /** Show `applying <name> …` until cleared. */
  setApplying(name: string | undefined): void
  /** True while a template apply is settling. */
  isApplying(): boolean
}

export function registerSidebar(context: TuiContext, rpc: McpClient): SidebarHandle {
  const [state, setState] = createSignal<SidebarState | undefined>(undefined)
  let applying: string | undefined
  let directory = ""

  const refresh = async (): Promise<void> => {
    try {
      const store = await rpc.list({}, { location: { directory } })
      const statuses = context.data.location.mcp.server.list({ directory }) ?? []
      const template = activeTemplateFor(store, directory)
      const custom = isCustomized(store, template, directory, context.ui.router.current().sessionID, statuses)
      setState({ template, custom, ...(applying === undefined ? {} : { applying }) })
    } catch {
      // The line is decoration; a failed read must not break the sidebar.
    }
  }

  context.ui.slot({
    append: "sidebar.footer",
    render: (input) => {
      // The slot input is reactive: a different session re-reads its template.
      createEffect(() => {
        void input.sessionID
        directory = context.location?.directory ?? context.data.location.default().directory
        void refresh()
      })
      return <text fg={context.theme.text.base}>{describeTemplateLine(state())}</text>
    },
  })

  return {
    refresh,
    isApplying: () => applying !== undefined,
    setApplying(name) {
      applying = name
      const current = state()
      if (current) {
        const { applying: _drop, ...rest } = current
        setState(name === undefined ? rest : { ...rest, applying: name })
      }
      if (name === undefined) void refresh()
    },
  }
}
