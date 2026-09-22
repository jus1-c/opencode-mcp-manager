import type {
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import {
  DEFAULT_STORE_PATH,
  loadStore,
  saveStore,
  setActiveTemplate,
  type Template,
  type TemplateStore,
} from "./store.js"
import {
  applyTemplateToRuntime,
  isRuntimeEnabled,
  reconcileStore,
  type RuntimeStatusMap,
} from "./template.js"

export function runtimeTemplateFromStatuses(
  serverNames: readonly string[],
  statuses: RuntimeStatusMap,
): Template {
  return {
    mcp: Object.fromEntries(serverNames.map((name) => [name, isRuntimeEnabled(statuses[name])])),
  }
}

export async function saveCurrentTemplate(
  storePath: string,
  name: string,
  serverNames: readonly string[],
  statuses: RuntimeStatusMap,
): Promise<TemplateStore> {
  const templateName = name.trim()
  if (!templateName) throw new Error("Template name is required")

  const store = await loadStore(storePath)
  const nextStore: TemplateStore = {
    ...store,
    templates: {
      ...store.templates,
      [templateName]: runtimeTemplateFromStatuses(serverNames, statuses),
    },
  }
  await saveStore(storePath, nextStore)
  return nextStore
}

export async function setDefaultTemplate(storePath: string, name: string): Promise<TemplateStore> {
  const store = await loadStore(storePath)
  if (!store.templates[name]) throw new Error(`Template not found: ${name}`)

  const nextStore = { ...store, defaultTemplate: name }
  await saveStore(storePath, nextStore)
  return nextStore
}

export async function deleteTemplate(storePath: string, name: string): Promise<TemplateStore> {
  const store = await loadStore(storePath)
  if (name === store.defaultTemplate) throw new Error("Cannot delete default template")
  if (!store.templates[name]) throw new Error(`Template not found: ${name}`)

  const { [name]: _deleted, ...templates } = store.templates
  const { activeTemplate: _legacy, activeTemplates: _old, ...rest } = store
  const activeTemplates = _old
    ? Object.fromEntries(Object.entries(_old).filter(([, tpl]) => tpl !== name))
    : undefined
  const nextStore: TemplateStore = {
    ...rest,
    templates,
    ...(activeTemplates && Object.keys(activeTemplates).length > 0 ? { activeTemplates } : {}),
  }
  await saveStore(storePath, nextStore)
  return nextStore
}

export function createTuiPlugin(storePath = DEFAULT_STORE_PATH): TuiPlugin {
  return async (api) => {
    api.keymap.registerLayer({
      commands: [
        {
          name: "mcp-manager.open",
          title: "MCP Manager",
          description: "Manage MCP server templates",
          category: "Plugin",
          namespace: "palette",
          slashName: "mcp-man",
          run: () => {
            void openManager(api, storePath)
          },
        },
      ],
    })
  }
}

async function openManager(api: TuiPluginApi, storePath: string): Promise<void> {
  try {
    const store = await prepareStore(api, storePath)
    showMainMenu(api, storePath, store)
  } catch (error) {
    showError(api, error)
  }
}

async function prepareStore(api: TuiPluginApi, storePath: string): Promise<TemplateStore> {
  const store = await loadStore(storePath)
  const serverNames = configuredServerNames(api)
  const reconciled = reconcileStore(store, serverNames)
  if (reconciled.changed) await saveStore(storePath, reconciled.store)
  return reconciled.store
}

function showMainMenu(api: TuiPluginApi, storePath: string, store: TemplateStore): void {
  type MainOption =
    | { kind: "apply" }
    | { kind: "save" }
    | { kind: "default" }
    | { kind: "delete" }

  const options: TuiDialogSelectOption<MainOption>[] = [
    { title: "Apply template", value: { kind: "apply" } as const },
    { title: "Save current state", value: { kind: "save" } as const },
    { title: "Set default template", value: { kind: "default" } as const },
    { title: "Delete template", value: { kind: "delete" } as const },
  ]

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "MCP Manager",
      placeholder: "Choose an action",
      options,
      onSelect: (option) => {
        if (option.value.kind === "apply") {
          showApplyMenu(api, storePath, store)
        } else if (option.value.kind === "save") {
          showSavePrompt(api, storePath)
        } else if (option.value.kind === "default") {
          showDefaultMenu(api, storePath, store)
        } else {
          showDeleteMenu(api, storePath, store)
        }
      },
    }),
  )
}

function showApplyMenu(api: TuiPluginApi, storePath: string, store: TemplateStore): void {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Apply template",
      placeholder: "Choose a template",
      options: Object.keys(store.templates).map((name) => ({
        title: name + (name === store.defaultTemplate ? " (default)" : ""),
        value: name,
      })),
      onSelect: (option) => {
        api.ui.dialog.clear()
        void applyNamedTemplate(api, storePath, option.value)
      },
    }),
  )
}

function showSavePrompt(api: TuiPluginApi, storePath: string): void {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Save current MCP state",
      placeholder: "work",
      onConfirm: (name) => {
        api.ui.dialog.clear()
        void saveCurrentState(api, storePath, name)
      },
    }),
  )
}

function showDefaultMenu(api: TuiPluginApi, storePath: string, store: TemplateStore): void {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Set default template",
      current: store.defaultTemplate,
      options: Object.keys(store.templates).map((name) => ({
        title: name,
        value: name,
      })),
      onSelect: (option) => {
        api.ui.dialog.clear()
        void changeDefault(api, storePath, option.value)
      },
    }),
  )
}

function showDeleteMenu(api: TuiPluginApi, storePath: string, store: TemplateStore): void {
  const names = Object.keys(store.templates).filter((name) => name !== store.defaultTemplate)
  if (!names.length) {
    api.ui.dialog.clear()
    api.ui.toast({ variant: "info", title: "MCP Manager", message: "No non-default templates to delete" })
    return
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Delete template",
      options: names.map((name) => ({ title: name, value: name })),
      onSelect: (option) => {
        api.ui.dialog.replace(() =>
          api.ui.DialogConfirm({
            title: "Delete template",
            message: `Delete ${option.value}?`,
            onConfirm: () => {
              api.ui.dialog.clear()
              void removeTemplate(api, storePath, option.value)
            },
          }),
        )
      },
    }),
  )
}

export async function applyNamedTemplate(api: TuiPluginApi, storePath: string, name: string): Promise<void> {
  try {
    const store = await loadStore(storePath)
    const template = store.templates[name]
    if (!template) throw new Error(`Template not found: ${name}`)

    const results = await applyTemplateToRuntime(api.client, await fetchStatuses(api), template)
    const failures = results.filter((result) => !result.ok)
    if (failures.length) {
      api.ui.toast({
        variant: "error",
        title: "MCP template partially applied",
        message: failures.map((failure) => `${failure.name}: ${failure.error}`).join("; "),
      })
      return
    }

    await setActiveTemplate(storePath, api.state.path.directory, name)
    const disposed = await api.client.instance.dispose()
    if (disposed.error) {
      api.ui.toast({
        variant: "warning",
        title: "MCP template applied",
        message: `${name} — restart TUI to refresh`,
      })
      return
    }
    api.ui.toast({ variant: "success", title: "MCP template applied", message: name })
  } catch (error) {
    showError(api, error)
  }
}

async function saveCurrentState(api: TuiPluginApi, storePath: string, name: string): Promise<void> {
  try {
    await saveCurrentTemplate(storePath, name, configuredServerNames(api), await fetchStatuses(api))
    api.ui.toast({ variant: "success", title: "MCP template saved", message: name.trim() })
  } catch (error) {
    showError(api, error)
  }
}

async function changeDefault(api: TuiPluginApi, storePath: string, name: string): Promise<void> {
  try {
    await setDefaultTemplate(storePath, name)
    api.ui.toast({ variant: "success", title: "Default template changed", message: name })
  } catch (error) {
    showError(api, error)
  }
}

async function removeTemplate(api: TuiPluginApi, storePath: string, name: string): Promise<void> {
  try {
    await deleteTemplate(storePath, name)
    api.ui.toast({ variant: "success", title: "MCP template deleted", message: name })
  } catch (error) {
    showError(api, error)
  }
}

async function fetchStatuses(api: TuiPluginApi): Promise<RuntimeStatusMap> {
  const response = await api.client.mcp.status()
  if (response.error) throw new Error(errorMessage(response.error))
  return (response.data ?? {}) as RuntimeStatusMap
}

function configuredServerNames(api: TuiPluginApi): string[] {
  return Object.keys(api.state.config.mcp ?? {})
}

function showError(api: TuiPluginApi, error: unknown): void {
  api.ui.toast({ variant: "error", title: "MCP Manager", message: errorMessage(error) })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}

const plugin: TuiPluginModule = {
  id: "opencode-mcp-manager",
  tui: createTuiPlugin(),
}

export default plugin
