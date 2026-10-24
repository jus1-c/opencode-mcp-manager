import { describe, expect, test } from "bun:test"
import {
  activeTemplateName,
  createEmptyStore,
  parseStore,
  removeTemplateFrom,
  setActiveTemplateIn,
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
})
