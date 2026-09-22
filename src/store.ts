import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname as pathDirname } from "node:path"

export const STORE_VERSION = 1 as const
export const DEFAULT_TEMPLATE_NAME = "default"
export const DEFAULT_STORE_PATH = fileURLToPath(new URL("../mcp-templates.json", import.meta.url))

export type Template = {
  mcp: Record<string, boolean>
}

export type TemplateStore = {
  version: typeof STORE_VERSION
  defaultTemplate: string
  templates: Record<string, Template>
}

export class TemplateStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "TemplateStoreError"
  }
}

export function createEmptyStore(): TemplateStore {
  return {
    version: STORE_VERSION,
    defaultTemplate: DEFAULT_TEMPLATE_NAME,
    templates: {
      [DEFAULT_TEMPLATE_NAME]: { mcp: {} },
    },
  }
}

export function validateStore(value: unknown): TemplateStore {
  if (!isRecord(value) || value.version !== STORE_VERSION || typeof value.defaultTemplate !== "string") {
    throw invalidStore()
  }

  if (!isRecord(value.templates) || !value.defaultTemplate || !isRecord(value.templates[value.defaultTemplate])) {
    throw invalidStore()
  }

  const templates: Record<string, Template> = {}
  for (const [name, rawTemplate] of Object.entries(value.templates)) {
    if (!name || !isRecord(rawTemplate) || !isRecord(rawTemplate.mcp)) {
      throw invalidStore()
    }

    const mcp: Record<string, boolean> = {}
    for (const [serverName, enabled] of Object.entries(rawTemplate.mcp)) {
      if (!serverName || typeof enabled !== "boolean") {
        throw invalidStore()
      }
      mcp[serverName] = enabled
    }
    templates[name] = { mcp }
  }

  return {
    version: STORE_VERSION,
    defaultTemplate: value.defaultTemplate,
    templates,
  }
}

export async function loadStore(path: string): Promise<TemplateStore> {
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return createEmptyStore()
    throw error
  }

  try {
    return validateStore(JSON.parse(contents) as unknown)
  } catch (error) {
    if (error instanceof TemplateStoreError) throw error
    throw invalidStore(error)
  }
}

export async function saveStore(path: string, store: unknown): Promise<void> {
  const validStore = validateStore(store)
  const directory = pathDirname(path)
  await mkdir(directory, { recursive: true })

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validStore, null, 2)}\n`, "utf8")
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function invalidStore(cause?: unknown): TemplateStoreError {
  return new TemplateStoreError("Invalid MCP template store", cause === undefined ? undefined : { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
