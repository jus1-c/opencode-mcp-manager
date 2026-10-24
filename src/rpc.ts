import { Rpc } from "@opencode/plugin/rpc"

const templateSchema = {
  type: "object",
  properties: {
    mcp: { type: "object", additionalProperties: { type: "boolean" } },
  },
  required: ["mcp"],
  additionalProperties: false,
} as const

const storeSchema = {
  type: "object",
  properties: {
    version: { type: "number" },
    defaultTemplate: { type: "string" },
    activeTemplates: { type: "object", additionalProperties: { type: "string" } },
    templates: { type: "object", additionalProperties: templateSchema },
  },
  required: ["version", "defaultTemplate", "templates"],
  additionalProperties: false,
} as const

const directorySchema = {
  type: "object",
  properties: { directory: { type: "string" } },
  required: ["directory"],
  additionalProperties: false,
} as const

export const McpManagerRpc = Rpc.define({
  id: "opencode-mcp-manager",
  methods: {
    list: {
      input: { type: "object", additionalProperties: false },
      output: storeSchema,
    },
    apply: {
      input: {
        type: "object",
        properties: { name: { type: "string" }, directory: { type: "string" } },
        required: ["name", "directory"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { store: storeSchema }, required: ["store"], additionalProperties: false },
      errors: {
        not_found: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    save: {
      input: {
        type: "object",
        properties: {
          name: { type: "string" },
          template: templateSchema,
        },
        required: ["name", "template"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { store: storeSchema }, required: ["store"], additionalProperties: false },
    },
    setDefault: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { store: storeSchema }, required: ["store"], additionalProperties: false },
      errors: {
        not_found: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    remove: {
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { store: storeSchema }, required: ["store"], additionalProperties: false },
      errors: {
        not_found: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    clearActive: {
      input: directorySchema,
      output: { type: "object", properties: { store: storeSchema }, required: ["store"], additionalProperties: false },
    },
  },
  events: {
    templatesChanged: {
      schema: { type: "object", additionalProperties: false },
    },
  },
})

export type McpManagerRpc = typeof McpManagerRpc
