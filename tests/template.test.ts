import { describe, expect, test } from "bun:test"
import {
  applyTemplateToConfig,
  applyTemplateToRuntime,
  isRuntimeEnabled,
  reconcileStore,
  type ConfigWithMcp,
  type RuntimeStatusMap,
} from "../src/template.js"
import { createEmptyStore } from "../src/store.js"

describe("MCP template behavior", () => {
  test("adds new configured servers enabled and prunes removed servers", () => {
    const store = {
      version: 1 as const,
      defaultTemplate: "default",
      templates: {
        default: { mcp: { old: false, kept: false } },
        work: { mcp: { old: true } },
      },
    }

    const result = reconcileStore(store, ["kept", "new"])

    expect(result.changed).toBe(true)
    expect(result.store.templates.default?.mcp).toEqual({ kept: false, new: true })
    expect(result.store.templates.work?.mcp).toEqual({ new: true, kept: true })
  })

  test("applies template enabled flags without losing MCP configuration", () => {
    const config: ConfigWithMcp = {
      mcp: {
        docs: { type: "remote", url: "https://docs.test", timeout: 10 },
        browser: { type: "local", command: ["browser"], enabled: true },
      },
    }

    applyTemplateToConfig(config, { mcp: { docs: false, browser: true } })

    expect(config.mcp).toEqual({
      docs: { type: "remote", url: "https://docs.test", timeout: 10, enabled: false },
      browser: { type: "local", command: ["browser"], enabled: true },
    })
  })

  test("treats every non-disabled status as enabled", () => {
    expect(isRuntimeEnabled({ status: "connected" })).toBe(true)
    expect(isRuntimeEnabled({ status: "failed", error: "offline" })).toBe(true)
    expect(isRuntimeEnabled({ status: "needs_auth" })).toBe(true)
    expect(isRuntimeEnabled({ status: "needs_client_registration", error: "register" })).toBe(true)
    expect(isRuntimeEnabled({ status: "disabled" })).toBe(false)
  })

  test("runs independent runtime changes even when one change fails", async () => {
    const calls: string[] = []
    const statuses: RuntimeStatusMap = {
      docs: { status: "disabled" },
      browser: { status: "connected" },
    }
    const client = {
      mcp: {
        connect: async ({ name }: { name: string }) => {
          calls.push(`connect:${name}`)
        },
        disconnect: async ({ name }: { name: string }) => {
          calls.push(`disconnect:${name}`)
          if (name === "browser") throw new Error("disconnect failed")
        },
      },
    }

    const results = await applyTemplateToRuntime(client, statuses, {
      mcp: { docs: true, browser: false },
    })

    expect(calls).toEqual(["connect:docs", "disconnect:browser"])
    expect(results).toEqual([
      { name: "docs", desiredEnabled: true, operation: "connect", ok: true },
      { name: "browser", desiredEnabled: false, operation: "disconnect", ok: false, error: "disconnect failed" },
    ])
  })

  test("skips runtime calls when statuses already match template", async () => {
    const client = {
      mcp: {
        connect: async () => {
          throw new Error("should not connect")
        },
        disconnect: async () => {
          throw new Error("should not disconnect")
        },
      },
    }

    const results = await applyTemplateToRuntime(client, {
      docs: { status: "connected" },
      browser: { status: "disabled" },
    }, { mcp: { docs: true, browser: false } })

    expect(results).toEqual([])
  })

  test("treats SDK error responses as failed operations", async () => {
    const client = {
      mcp: {
        connect: async ({ name }: { name: string }) => ({
          data: undefined,
          error: { code: "ConnectionRefused", path: `/mcp/${name}/connect` },
        }),
        disconnect: async () => {
          throw new Error("disconnect failed")
        },
      },
    }

    const results = await applyTemplateToRuntime(client, {
      docs: { status: "disabled" },
      browser: { status: "connected" },
    }, { mcp: { docs: true, browser: false } })

    expect(results).toEqual([
      { name: "docs", desiredEnabled: true, operation: "connect", ok: false, error: JSON.stringify({ code: "ConnectionRefused", path: "/mcp/docs/connect" }) },
      { name: "browser", desiredEnabled: false, operation: "disconnect", ok: false, error: "disconnect failed" },
    ])
  })

  test("creates default store with no configured servers", () => {
    expect(reconcileStore(createEmptyStore(), []).store).toEqual(createEmptyStore())
  })
})
