console.error(
  "finch-mcp: the legacy stdio executable is disabled. The transitional MCP server is in-process test support only; the approved agent-only Streamable HTTP MCP with exec and docs is not implemented.",
)
process.exitCode = 1
