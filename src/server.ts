import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin"
import { DEFAULT_STORE_PATH, loadStore, saveStore } from "./store.js"
import { applyTemplateToConfig, reconcileStore } from "./template.js"

export function createServerPlugin(storePath = DEFAULT_STORE_PATH): Plugin {
  return async () => ({
    config: async (config: Config) => {
      const serverNames = Object.keys(config.mcp ?? {})
      const store = await loadStore(storePath)
      const reconciled = reconcileStore(store, serverNames)

      if (reconciled.changed) {
        await saveStore(storePath, reconciled.store)
      }

      const templateName = reconciled.store.activeTemplate ?? reconciled.store.defaultTemplate
      const template = reconciled.store.templates[templateName]
      if (!template) throw new Error("Default MCP template is missing")
      applyTemplateToConfig(config, template)
    },
  })
}

const plugin: PluginModule = {
  id: "opencode-mcp-manager",
  server: createServerPlugin(),
}

export default plugin
