# OpenCode MCP Manager

Local OpenCode plugin for saving and applying MCP server templates from the native TUI.

## Install

Build and install from this directory:

```bash
bun install
bun run build
opencode plugin "/mnt/d/Documents/Opencode/opencode-mcp-manager"
```

Restart OpenCode after installation. Run `/mcp-man` to open the manager.

## Features

- Apply saved MCP templates at startup through the server plugin config hook.
- Connect and disconnect MCP servers at runtime from the native TUI.
- Save current static MCP state under a named template.
- Change or delete non-default templates.
- Keep MCP connection configuration in OpenCode config; templates store only enabled state.

## Store

The plugin creates `mcp-templates.json` beside the installed plugin package:

```json
{
  "version": 1,
  "defaultTemplate": "default",
  "templates": {
    "default": {
      "mcp": {
        "context7": true,
        "browser": false
      }
    }
  }
}
```

New configured MCP servers enter every template as enabled. Removed configured servers are pruned. Invalid store files fail closed and remain unchanged.

Dynamic MCP servers added at runtime are not saved because templates do not contain connection configuration.

## Known limitation

The built-in `/mcps` dialog and the sidebar read OpenCode's TUI sync snapshot, which only refreshes at startup or after a built-in `/mcps` toggle. Applying a template here changes the real server state immediately (verify with `opencode mcp list`), but those views can stay stale until restart. The `/mcp-man` menu always fetches live status directly.

## Development

```bash
bun test
bun run check
bun run build
```
