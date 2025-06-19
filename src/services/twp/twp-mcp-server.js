#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js")
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js")
const { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } = require("@modelcontextprotocol/sdk/types.js")

/**
 * Create an MCP server for TWP (Token Window Protocol) operations.
 */
const server = new Server(
	{
		name: "twp-server",
		version: "1.0.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
)

/**
 * Handler that lists available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: [
			{
				name: "recache_message_array",
				description: "Recache message array with specified positions",
				inputSchema: {
					type: "object",
					properties: {
						messages: {
							type: "string",
							description: "Comma-separated message positions or ranges (e.g., '1-4,25,30')",
						},
					},
					required: ["messages"],
				},
			},
		],
	}
})

/**
 * Handler for TWP tool calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	switch (request.params.name) {
		case "recache_message_array": {
			const messages = String(request.params.arguments?.messages || "")

			if (!messages) {
				throw new McpError(ErrorCode.InvalidParams, "Messages parameter is required")
			}

			// This is a fake server that just returns success
			const result = {
				success: true,
				message: "Token window recache processed - check message flow for results",
				positions: messages,
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
			}
		}

		default:
			throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`)
	}
})

/**
 * Start the server using stdio transport.
 */
async function main() {
	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error("TWP MCP Server running on stdio")
}

main().catch((error) => {
	console.error("TWP Server error:", error)
	process.exit(1)
})
