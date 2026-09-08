import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Layer } from "effect"
import { buildMcpServer, type FinchMcpEnv } from "./server.ts"

export interface McpToolCall {
  readonly isError: boolean | undefined
  readonly text: string
}

const firstText = (content: readonly unknown[]): string => {
  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item
    ) {
      return String((item as { readonly text: unknown }).text)
    }
  }
  throw new Error("MCP tool result contained no text content")
}

// In-process MCP harness: a real Client and the real Server over a linked
// in-memory transport pair — full JSON-RPC round trip, no sockets. Keeps
// the SDK an implementation detail of @finch/mcp so tests import only this.
export const connectInProcess = async (layer: Layer.Layer<FinchMcpEnv, never, never>) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildMcpServer(layer)
  const client = new Client({ name: "finch-mcp-test", version: "0.0.0" }, { capabilities: {} })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    listTools: () => client.listTools(),
    callTool: async (name: string, args: Record<string, unknown>): Promise<McpToolCall> => {
      // Compatibility result schema types content/isError loosely: narrow at runtime.
      const raw = (await client.callTool({ name, arguments: args })) as {
        readonly isError?: unknown
        readonly content?: unknown
      }
      const content = Array.isArray(raw.content) ? (raw.content as readonly unknown[]) : []
      return {
        isError: typeof raw.isError === "boolean" ? raw.isError : undefined,
        text: firstText(content),
      }
    },
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
