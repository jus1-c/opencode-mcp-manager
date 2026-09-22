import type { Template, TemplateStore } from "./store.js"

export type ConfigWithMcp = {
  mcp?: Record<string, object | undefined>
}

export type RuntimeStatus = {
  status: string
  error?: string
}

export type RuntimeStatusMap = Record<string, RuntimeStatus>

export type RuntimeClient = {
  mcp: {
    connect(input: { name: string }): Promise<unknown>
    disconnect(input: { name: string }): Promise<unknown>
  }
}

export type RuntimeApplyResult = {
  name: string
  desiredEnabled: boolean
  operation: "connect" | "disconnect"
  ok: boolean
  error?: string
}

type RuntimeAction = Omit<RuntimeApplyResult, "ok" | "error">

export function reconcileStore(
  store: TemplateStore,
  serverNames: readonly string[],
): { store: TemplateStore; changed: boolean } {
  const names = [...new Set(serverNames)]
  let changed = false
  const templates: Record<string, Template> = {}

  for (const [templateName, template] of Object.entries(store.templates)) {
    const mcp: Record<string, boolean> = {}
    for (const serverName of names) {
      mcp[serverName] = template.mcp[serverName] ?? true
      if (!(serverName in template.mcp)) changed = true
    }

    if (Object.keys(template.mcp).length !== names.length) changed = true
    templates[templateName] = { mcp }
  }

  return {
    store: changed ? { ...store, templates } : store,
    changed,
  }
}

export function applyTemplateToConfig(config: ConfigWithMcp, template: Template): void {
  if (!config.mcp) return

  for (const [name, enabled] of Object.entries(template.mcp)) {
    const current = config.mcp[name]
    if (!current) continue
    config.mcp[name] = { ...current, enabled }
  }
}

export function isRuntimeEnabled(status: RuntimeStatus | undefined): boolean {
  return status?.status !== "disabled"
}

export async function applyTemplateToRuntime(
  client: RuntimeClient,
  statuses: RuntimeStatusMap,
  template: Template,
): Promise<RuntimeApplyResult[]> {
  const actions: RuntimeAction[] = Object.entries(template.mcp).flatMap(([name, desiredEnabled]) => {
    const currentEnabled = isRuntimeEnabled(statuses[name])
    if (desiredEnabled === currentEnabled) return []

    const operation: RuntimeAction["operation"] = desiredEnabled ? "connect" : "disconnect"
    return [{ name, desiredEnabled, operation }]
  })

  const results = await Promise.allSettled(
    actions.map(async (action) => {
      if (action.operation === "connect") {
        await client.mcp.connect({ name: action.name })
      } else {
        await client.mcp.disconnect({ name: action.name })
      }
      return action
    }),
  )

  return results.map((result, index) => {
    const action = actions[index]
    if (!action) throw new Error("MCP runtime action result mismatch")
    if (result.status === "fulfilled") {
      return { ...action, ok: true }
    }
    return { ...action, ok: false, error: errorMessage(result.reason) }
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
