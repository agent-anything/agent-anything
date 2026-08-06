export class McpPrimitiveError extends Error {
  constructor(
    readonly code:
      | "mcp_source_unavailable"
      | "mcp_source_stale"
      | "mcp_source_refresh_failed"
      | "mcp_source_refresh_cancelled"
      | "mcp_source_refresh_stale"
      | "mcp_inventory_ambiguous"
      | "mcp_inventory_limit_exceeded"
      | "mcp_primitive_not_found"
      | "mcp_primitive_cache_expired"
      | "mcp_tool_input_invalid"
      | "mcp_prompt_arguments_invalid"
      | "mcp_subscription_invalid"
      | "mcp_subscription_lost"
      | "mcp_operation_cancelled"
      | "mcp_operation_timeout"
      | "mcp_operation_failed",
    message: string,
  ) {
    super(message);
    this.name = "McpPrimitiveError";
  }
}
