import { describe, expect, test } from "bun:test"
import {
  activeTemplateName,
  createEmptyStore,
  parseStore,
  removeTemplateFrom,
  resolveServerEnabled,
  sessionOverrideNames,
  setActiveTemplateIn,
  setSessionOverrideIn,
  validateStore,
  type TemplateStore,
} from "../src/store.js"

function sampleStore(): TemplateStore {
  return {
    version: 1,
    defaultTemplate: "default",
    templates: {
      default: { mcp: { docs: true } },
      work: { mcp: { docs: false } },
      minimal: { mcp: {} },
    },
  }
}

describe("template store", () => {
  test("parseStore falls back to empty store for missing value", () => {
    expect(parseStore(undefined)).toEqual(createEmptyStore())
    expect(parseStore(null)).toEqual(createEmptyStore())
  })

  test("validates a valid store", () => {
    expect(validateStore(sampleStore())).toEqual(sampleStore())
  })

  test("rejects malformed store", () => {
    expect(() => validateStore({ version: 1 })).toThrow("Invalid MCP template store")
    expect(() => validateStore({ ...sampleStore(), defaultTemplate: "missing" })).toThrow("Invalid MCP template store")
  })

  test("rejects activeTemplates referencing a missing template", () => {
    expect(() =>
      validateStore({ ...sampleStore(), activeTemplates: { "/a": "ghost" } }),
    ).toThrow("Invalid MCP template store")
  })

  test("resolves active template per directory with default fallback", () => {
    const store = setActiveTemplateIn(sampleStore(), "/a", "work")
    expect(activeTemplateName(store, "/a")).toBe("work")
    expect(activeTemplateName(store, "/b")).toBe("default")
    expect(activeTemplateName(store, undefined)).toBe("default")
  })

  test("keeps per-directory entries independent", () => {
    const a = setActiveTemplateIn(sampleStore(), "/a", "work")
    const both = setActiveTemplateIn(a, "/b", "minimal")
    expect(both.activeTemplates).toEqual({ "/a": "work", "/b": "minimal" })

    const cleared = setActiveTemplateIn(both, "/a", undefined)
    expect(cleared.activeTemplates).toEqual({ "/b": "minimal" })
  })

  test("rejects setActiveTemplateIn for missing template", () => {
    expect(() => setActiveTemplateIn(sampleStore(), "/a", "nope")).toThrow("Template not found")
  })

  test("removeTemplateFrom drops references and refuses the default", () => {
    const store = setActiveTemplateIn(sampleStore(), "/a", "work")
    const removed = removeTemplateFrom(store, "work")
    expect(removed.templates.work).toBeUndefined()
    expect(removed.activeTemplates).toBeUndefined()

    expect(() => removeTemplateFrom(sampleStore(), "default")).toThrow("Cannot delete default template")
  })

  test("resolveServerEnabled follows override then template then default", () => {
    const base = sampleStore()
    const withActive = setActiveTemplateIn(base, "/a", "work")

    // no override, active template wins
    expect(resolveServerEnabled(withActive, "docs", "/a", undefined)).toBe(false)
    expect(resolveServerEnabled(withActive, "docs", "/b", undefined)).toBe(true)

    // session override wins over template
    const withOverride = setSessionOverrideIn(withActive, "ses_1", { docs: true })
    expect(resolveServerEnabled(withOverride, "docs", "/a", "ses_1")).toBe(true)
    expect(resolveServerEnabled(withOverride, "docs", "/a", "ses_2")).toBe(false)
  })

  test("setSessionOverrideIn removes empty overrides", () => {
    const store = setSessionOverrideIn(sampleStore(), "ses_1", { docs: false })
    expect(store.sessionOverrides).toEqual({ ses_1: { docs: false } })
    expect(sessionOverrideNames(store, "ses_1")).toEqual(["docs"])

    const cleared = setSessionOverrideIn(store, "ses_1", {})
    expect(cleared.sessionOverrides).toBeUndefined()
  })

  test("validates sessionOverrides shape", () => {
    expect(() =>
      validateStore({ ...sampleStore(), sessionOverrides: { ses_1: { docs: "yes" } } }),
    ).toThrow("Invalid MCP template store")
  })
})
