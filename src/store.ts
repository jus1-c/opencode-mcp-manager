export const STORE_VERSION = 1 as const
export const DEFAULT_TEMPLATE_NAME = "default"
export const STORAGE_KEY = "templates"

export type Template = {
  mcp: Record<string, boolean>
}

export type TemplateStore = {
  version: typeof STORE_VERSION
  defaultTemplate: string
  /** Directory -> template name. Applying a template only affects that project. */
  activeTemplates?: Record<string, string>
  /**
   * Session -> per-server override. Wins over the directory template.
   * Only affects which MCP tools the model sees in that session; MCP
   * connections themselves stay location-scoped.
   */
  sessionOverrides?: Record<string, Record<string, boolean>>
  templates: Record<string, Template>
}

export class TemplateStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "TemplateStoreError"
  }
}

export function createEmptyStore(): TemplateStore {
  return {
    version: STORE_VERSION,
    defaultTemplate: DEFAULT_TEMPLATE_NAME,
    templates: {
      [DEFAULT_TEMPLATE_NAME]: { mcp: {} },
    },
  }
}

export function validateStore(value: unknown): TemplateStore {
  if (!isRecord(value) || value.version !== STORE_VERSION || typeof value.defaultTemplate !== "string") {
    throw invalidStore()
  }

  if (!isRecord(value.templates) || !value.defaultTemplate || !isRecord(value.templates[value.defaultTemplate])) {
    throw invalidStore()
  }

  const templates: Record<string, Template> = {}
  for (const [name, rawTemplate] of Object.entries(value.templates)) {
    if (!name || !isRecord(rawTemplate) || !isRecord(rawTemplate.mcp)) {
      throw invalidStore()
    }

    const mcp: Record<string, boolean> = {}
    for (const [serverName, enabled] of Object.entries(rawTemplate.mcp)) {
      if (!serverName || typeof enabled !== "boolean") {
        throw invalidStore()
      }
      mcp[serverName] = enabled
    }
    templates[name] = { mcp }
  }

  const activeTemplatesRaw = value.activeTemplates
  let activeTemplates: Record<string, string> | undefined
  if (activeTemplatesRaw !== undefined) {
    if (!isRecord(activeTemplatesRaw)) {
      throw invalidStore()
    }
    activeTemplates = {}
    for (const [dir, tplName] of Object.entries(activeTemplatesRaw)) {
      if (!dir || typeof tplName !== "string" || !isRecord(value.templates[tplName])) {
        throw invalidStore()
      }
      activeTemplates[dir] = tplName
    }
  }

  const sessionOverridesRaw = value.sessionOverrides
  let sessionOverrides: Record<string, Record<string, boolean>> | undefined
  if (sessionOverridesRaw !== undefined) {
    if (!isRecord(sessionOverridesRaw)) {
      throw invalidStore()
    }
    sessionOverrides = {}
    for (const [sessionID, rawOverride] of Object.entries(sessionOverridesRaw)) {
      if (!sessionID || !isRecord(rawOverride)) {
        throw invalidStore()
      }
      const override: Record<string, boolean> = {}
      for (const [serverName, enabled] of Object.entries(rawOverride)) {
        if (!serverName || typeof enabled !== "boolean") {
          throw invalidStore()
        }
        override[serverName] = enabled
      }
      sessionOverrides[sessionID] = override
    }
  }

  return {
    version: STORE_VERSION,
    defaultTemplate: value.defaultTemplate,
    ...(activeTemplates !== undefined ? { activeTemplates } : {}),
    ...(sessionOverrides !== undefined ? { sessionOverrides } : {}),
    templates,
  }
}

/** Parse an unknown storage value, falling back to an empty store. */
export function parseStore(value: unknown): TemplateStore {
  if (value === undefined || value === null) return createEmptyStore()
  return validateStore(value)
}

export function activeTemplateName(store: TemplateStore, directory: string | undefined): string {
  const active = directory ? store.activeTemplates?.[directory] : undefined
  return active && store.templates[active] ? active : store.defaultTemplate
}

/**
 * Resolve the enabled state for one MCP server.
 * Priority: session override -> active directory template -> default template.
 * A server no template mentions stays off: a newly configured MCP must be
 * enabled explicitly through /mcps or /mcp-man.
 */
export function resolveServerEnabled(
  store: TemplateStore,
  serverName: string,
  directory: string | undefined,
  sessionID: string | undefined,
): boolean {
  const override = sessionID ? store.sessionOverrides?.[sessionID]?.[serverName] : undefined
  if (override !== undefined) return override

  const template = store.templates[activeTemplateName(store, directory)]
  return template?.mcp[serverName] ?? false
}

/** Server names the session's override touches, for UI display. */
export function sessionOverrideNames(store: TemplateStore, sessionID: string): string[] {
  return Object.keys(store.sessionOverrides?.[sessionID] ?? {}).sort()
}

export function setSessionOverrideIn(
  store: TemplateStore,
  sessionID: string,
  overrides: Record<string, boolean> | undefined,
): TemplateStore {
  if (!sessionID) throw new Error("Session ID is required")
  const sessionOverrides = { ...(store.sessionOverrides ?? {}) }
  if (overrides && Object.keys(overrides).length > 0) {
    sessionOverrides[sessionID] = { ...overrides }
  } else {
    delete sessionOverrides[sessionID]
  }
  return {
    ...store,
    ...(Object.keys(sessionOverrides).length > 0 ? { sessionOverrides } : { sessionOverrides: undefined }),
  } as TemplateStore
}

export function setActiveTemplateIn(
  store: TemplateStore,
  directory: string,
  name: string | undefined,
): TemplateStore {
  if (name !== undefined && !store.templates[name]) {
    throw new Error(`Template not found: ${name}`)
  }
  const activeTemplates = { ...(store.activeTemplates ?? {}) }
  if (name !== undefined) {
    activeTemplates[directory] = name
  } else {
    delete activeTemplates[directory]
  }
  return {
    ...store,
    ...(Object.keys(activeTemplates).length > 0 ? { activeTemplates } : { activeTemplates: undefined }),
  } as TemplateStore
}

export function removeTemplateFrom(store: TemplateStore, name: string): TemplateStore {
  if (name === store.defaultTemplate) throw new Error("Cannot delete default template")
  if (!store.templates[name]) throw new Error(`Template not found: ${name}`)

  const { [name]: _deleted, ...templates } = store.templates
  const filtered = store.activeTemplates
    ? Object.fromEntries(Object.entries(store.activeTemplates).filter(([, tpl]) => tpl !== name))
    : undefined
  return {
    ...store,
    templates,
    ...(filtered && Object.keys(filtered).length > 0 ? { activeTemplates: filtered } : { activeTemplates: undefined }),
  } as TemplateStore
}

function invalidStore(cause?: unknown): TemplateStoreError {
  return new TemplateStoreError("Invalid MCP template store", cause === undefined ? undefined : { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
