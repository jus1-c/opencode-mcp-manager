# OpenCode MCP Manager

Local OpenCode plugin for saving and applying MCP server templates from the native TUI.

## Install

Install directly from GitHub:

```bash
opencode plugin "jus1-c/opencode-mcp-manager"
```

Or build from source:

```bash
git clone https://github.com/jus1-c/opencode-mcp-manager.git
cd opencode-mcp-manager
bun install
bun run build
opencode plugin .
```

Restart OpenCode after installation. Run `/mcp-man` to open the manager.

## Features

- Apply saved MCP templates at startup through the server plugin config hook, scoped per project directory.
- Connect and disconnect MCP servers at runtime from the native TUI.
- Save current static MCP state under a named template.
- Change or delete non-default templates.
- Keep MCP connection configuration in OpenCode config; templates store only enabled state.
- Persist the last-applied template per project; the config hook prefers that over `defaultTemplate` so the recreated instance restores the applied state without affecting other projects.
- Trigger `instance.dispose()` after a successful apply so the TUI sync snapshot refreshes and the sidebar / `/mcps` reflect the new state immediately.

## Store

The plugin creates `mcp-templates.json` beside the installed plugin package:

```json
{
  "version": 1,
  "defaultTemplate": "default",
  "activeTemplates": {
    "/home/user/project-a": "work",
    "/home/user/project-b": "minimal"
  },
  "templates": {
    "default": { "mcp": { "context7": true, "browser": false } },
    "work":    { "mcp": { "context7": false, "browser": true } },
    "minimal": { "mcp": { "context7": false, "browser": false } }
  }
}
```

`activeTemplates` maps each project directory to its chosen template. Applying a template only affects that project; other projects keep following `defaultTemplate`. Legacy `activeTemplate` (a single global string) is still read for migration but new writes always use the per-directory map.

New configured MCP servers enter every template as enabled. Removed configured servers are pruned. Invalid store files fail closed and remain unchanged.

Dynamic MCP servers added at runtime are not saved because templates do not contain connection configuration.

## Updates

Managed by `opencode-component-updater`. The adapter script checks the GitHub repository for new commits:

```bash
opencode-component-updater check
```

Set `OPENCODE_MCP_MANAGER_GITHUB` (default `jus1-c/opencode-mcp-manager`) or `OPENCODE_MCP_MANAGER_SOURCE` (local clone path) to override the source.

## Development

```bash
bun test
bun run check
bun run build
```