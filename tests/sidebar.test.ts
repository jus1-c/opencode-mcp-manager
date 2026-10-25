import { describe, expect, test } from "bun:test"
import { activeTemplateFor, describeTemplateLine, isCustomized } from "../src/sidebar.js"
import type { TemplateStore } from "../src/store.js"

function store(overrides?: Partial<TemplateStore>): TemplateStore {
  return {
    version: 1,
    defaultTemplate: "default",
    templates: {
      default: { mcp: { docs: true, browser: false } },
      work: { mcp: { docs: false, browser: true } },
    },
    ...overrides,
  }
}

describe("sidebar template line", () => {
  test("renders the plain template name", () => {
    expect(describeTemplateLine({ template: "work", custom: false })).toBe("MCP  work")
  })

  test("marks a customised template", () => {
    expect(describeTemplateLine({ template: "work", custom: true })).toBe("MCP  work (custom)")
  })

  test("shows the template being applied", () => {
    expect(describeTemplateLine({ template: "work", custom: false, applying: "work" })).toBe(
      "MCP  applying work …",
    )
  })

  test("renders a placeholder before the first read", () => {
    expect(describeTemplateLine(undefined)).toBe("MCP  …")
  })

  test("picks the active template for a directory, else the default", () => {
    const value = store({ activeTemplates: { "/project-a": "work" } })
    expect(activeTemplateFor(value, "/project-a")).toBe("work")
    expect(activeTemplateFor(value, "/other")).toBe("default")
  })

  test("is not custom when runtime matches the template", () => {
    expect(
      isCustomized(store(), "default", "/project-a", undefined, [
        { name: "docs", status: { status: "connected" } },
        { name: "browser", status: { status: "disabled" } },
      ]),
    ).toBe(false)
  })

  test("is custom when the runtime diverges from the template", () => {
    expect(
      isCustomized(store(), "default", "/project-a", undefined, [
        { name: "docs", status: { status: "disabled" } },
      ]),
    ).toBe(true)
  })

  test("is custom when the session pins a server", () => {
    expect(isCustomized(store(), "default", "/project-a", "ses_1", [])).toBe(false)
    expect(
      isCustomized(store({ sessionOverrides: { ses_1: { docs: false } } }), "default", "/project-a", "ses_1", []),
    ).toBe(true)
  })

  test("ignores servers the template does not mention", () => {
    expect(
      isCustomized(store(), "default", "/project-a", undefined, [
        { name: "fresh", status: { status: "disabled" } },
      ]),
    ).toBe(false)
  })

  test("does not report custom while a server is still pending", () => {
    expect(
      isCustomized(store(), "work", "/project-a", undefined, [
        { name: "docs", status: { status: "pending" } },
        { name: "browser", status: { status: "pending" } },
      ]),
    ).toBe(false)
  })
})
