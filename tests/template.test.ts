import { describe, expect, test } from "bun:test"
import {
  applyTemplateToConfig,
  applyTemplateToRuntime,
  isRuntimeEnabled,
  reconcileStore,
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

  test("applies template flags to the inverse v2 disabled field", () => {
    const configs = {
      docs: { disabled: false },
      browser: { disabled: false },
    }

    applyTemplateToConfig(configs, { mcp: { docs: false, browser: true } })

    expect(configs.docs.disabled).toBe(true)
    expect(configs.browser.disabled).toBe(false)
  })

  test("skips servers missing from config", () => {
    const configs: Record<string, { disabled?: boolean }> = {}
    applyTemplateToConfig(configs, { mcp: { ghost: true } })
    expect(configs).toEqual({})
  })

  test("treats every non-disabled status as enabled", () => {
    expect(isRuntimeEnabled({ status: "connected" })).toBe(true)
    expect(isRuntimeEnabled({ status: "pending" })).toBe(true)
    expect(isRuntimeEnabled({ status: "failed", error: "offline" })).toBe(true)
    expect(isRuntimeEnabled({ status: "needs_auth", error: "auth" })).toBe(true)
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
        connect: async ({ server }: { server: string }) => {
          calls.push(`connect:${server}`)
        },
        disconnect: async ({ server }: { server: string }) => {
          calls.push(`disconnect:${server}`)
          if (server === "browser") throw new Error("disconnect failed")
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

  test("passes the location directory to the client", async () => {
    const inputs: unknown[] = []
    const client = {
      mcp: {
        connect: async (input: unknown) => {
          inputs.push(input)
        },
        disconnect: async () => undefined,
      },
    }

    await applyTemplateToRuntime(
      client,
      { docs: { status: "disabled" } },
      { mcp: { docs: true } },
      "/project-a",
    )

    expect(inputs).toEqual([{ server: "docs", location: { directory: "/project-a" } }])
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

  test("creates default store with no configured servers", () => {
    expect(reconcileStore(createEmptyStore(), []).store).toEqual(createEmptyStore())
  })
})
