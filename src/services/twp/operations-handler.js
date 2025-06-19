/**
 * Operations Handler
 *
 * Handles extraction and execution of token window operations (new, set, get, del)
 * from message content.
 */

const fs = require("fs")
const path = require("path")
const { v4: uuidv4 } = require("uuid")

class OperationsHandler {
	constructor(tokenRegistry, windowStateManager) {
		if (!tokenRegistry) {
			const error = new Error("FATAL: tokenRegistry is required for OperationsHandler constructor")
			console.error(error.stack)
			process.exit(1)
		}

		if (!windowStateManager) {
			const error = new Error("FATAL: windowStateManager is required for OperationsHandler constructor")
			console.error(error.stack)
			process.exit(1)
		}

		this.tokenRegistry = tokenRegistry
		this.windowStateManager = windowStateManager

		// In-memory operation storage
		this.operations = new Map() // conversationId -> Array of operations

		console.log("[OperationsHandler] Initialized with in-memory storage")
	}

	/**
	 * Extract and execute token window operations from message content
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} messageId - Message ID
	 * @param {string} content - Message content to extract operations from
	 * @returns {object[]} - Array of operation results
	 */
	processMessageOperations(conversationId, messageId, content) {
		console.log(`[OperationsHandler] Processing operations for message ${messageId}`)

		if (!conversationId) {
			const error = new Error("FATAL: conversationId is required for processMessageOperations")
			console.error(error.stack)
			process.exit(1)
		}

		if (!messageId) {
			const error = new Error("FATAL: messageId is required for processMessageOperations")
			console.error(error.stack)
			process.exit(1)
		}

		if (!content) {
			return [] // No operations to process
		}

		// Extract operations from content using new operation syntax
		const operations = this._extractOperations(content)

		// Execute each operation
		const results = []
		for (const operation of operations) {
			const result = this._executeOperation(operation, conversationId, messageId)
			results.push(result)
		}

		return results
	}

	/**
	 * Extract token window operations from message content
	 *
	 * @param {string} content - Message content to extract operations from
	 * @returns {object[]} - Array of operation objects
	 */
	_extractOperations(content) {
		console.log("[OperationsHandler] Extracting operations from content")

		if (!content || typeof content !== "string") {
			return []
		}

		const operations = []

		// Extract text between TWPSTART and TWPSTOP
		// Require TWPSTART and TWPSTOP to be on their own lines
		const twpRegex = /^TWPSTART\s*$([\s\S]*?)^TWPSTOP\s*$/gm
		let twpMatch
		let twpContent = ""

		// Combine all TWP blocks into one string for processing
		while ((twpMatch = twpRegex.exec(content)) !== null) {
			if (twpMatch[1]) {
				twpContent += twpMatch[1] + "\n"
			}
		}

		if (!twpContent) {
			console.log("[OperationsHandler] No TWP blocks found")
			return []
		}

		// Regex for each operation type in new TWP syntax
		const newRegex = /new\("([^"]+)"\)/g
		const setRegex = /set\(([^,)]+)\s*,\s*"([^"]+)"\)/g
		const getRegex = /get\(([^)]+)(?:\s*,\s*"([^"]+)")?\)/g
		const delRegex = /del\(([^)]+)\)/g

		// Extract new operations
		let match
		while ((match = newRegex.exec(twpContent)) !== null) {
			if (match[1]) {
				// new("tokens")
				operations.push({
					type: "new",
					parameters: {
						content: match[1],
					},
				})
			}
		}

		// Extract set operations
		while ((match = setRegex.exec(twpContent)) !== null) {
			if (match[1] && match[2]) {
				// set(ID, "new thought tokens")
				operations.push({
					type: "set",
					parameters: {
						registerId: match[1].trim(),
						content: match[2],
					},
				})
			}
		}

		// Extract get operations
		while ((match = getRegex.exec(twpContent)) !== null) {
			if (match[1] && match[2]) {
				// get(ID[,ID...], "tokens")
				operations.push({
					type: "get",
					parameters: {
						registerIds: match[1].split(",").map((id) => id.trim()),
						content: match[2],
					},
				})
			} else if (match[1]) {
				// get(ID[,ID...])
				operations.push({
					type: "get",
					parameters: {
						registerIds: match[1].split(",").map((id) => id.trim()),
					},
				})
			}
		}

		// Extract del operations
		while ((match = delRegex.exec(twpContent)) !== null) {
			if (match[1]) {
				// del(ID[,ID...])
				operations.push({
					type: "del",
					parameters: {
						registerIds: match[1].split(",").map((id) => id.trim()),
					},
				})
			}
		}

		console.log(`[OperationsHandler] Extracted ${operations.length} operations from TWP blocks`)

		return operations
	}

	/**
	 * Execute a token window operation
	 *
	 * @param {object} operation - Operation to execute
	 * @param {string} conversationId - Conversation ID
	 * @param {string} messageId - Message ID
	 * @returns {object} - Result of the operation
	 */
	_executeOperation(operation, conversationId, messageId) {
		console.log(`[OperationsHandler] Executing ${operation.type} operation`)

		// Record the operation in memory
		const operationId = `op_${uuidv4()}`
		this._recordTokenOperation({
			id: operationId,
			conversationId,
			messageId,
			operationType: operation.type,
			parameters: operation.parameters,
			resultId: null, // Will be updated for operations
		})

		// Execute based on operation type
		let result

		switch (operation.type) {
			case "new":
				result = this._executeNewOperation(conversationId, operation.parameters, messageId)

				// Update operation record with result ID
				if (result.success && result.registerId) {
					this._updateOperationResult(operationId, result.registerId)
				}
				break

			case "get":
				result = this._executeGetOperation(conversationId, operation.parameters, messageId)
				break

			case "set":
				result = this._executeSetOperation(conversationId, operation.parameters, messageId)
				break

			case "del":
				result = this._executeDelOperation(conversationId, operation.parameters, messageId)
				break

			default:
				console.error(`[OperationsHandler] Unknown operation type: ${operation.type}`)
				result = { success: false, error: `Unknown operation type: ${operation.type}` }
		}

		return result
	}

	/**
	 * Execute a new operation to create a thought register
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {object} parameters - Parameters for the new operation
	 * @param {string} messageId - Message ID containing the operation
	 * @returns {object} - Result with registerId of the created thought
	 */
	_executeNewOperation(conversationId, parameters, messageId) {
		console.log(`[OperationsHandler] Executing new() operation for conversation ${conversationId}`)

		if (!conversationId) {
			const error = new Error("FATAL: conversationId is required for store operation")
			console.error(error.stack)
			process.exit(1)
		}

		if (!parameters.content) {
			const error = new Error("FATAL: content is required for store operation")
			console.error(error.stack)
			process.exit(1)
		}

		// If registerIds provided, expand any ranges
		if (parameters.registerIds && Array.isArray(parameters.registerIds)) {
			parameters.registerIds = this.tokenRegistry.expandRegisterRanges(parameters.registerIds)
		}

		// Always get a new thought ID for each store operation
		// Ensuring IDs are never reused and thought register IDs remain immutable (contents are mutable with edit)
		const thoughtId = this.tokenRegistry.getNextThoughtId(conversationId)

		console.log(`[OperationsHandler] Creating thought register ${thoughtId} for conversation ${conversationId}`)

		// Create thought register in registry
		const thoughtRegister = this.tokenRegistry.createThoughtRegister(
			conversationId,
			thoughtId,
			parameters.content,
			parameters.registerIds,
		)

		// Update window state - always derive from TokenRegistry for consistency
		const windowState = this.windowStateManager.getWindowState(conversationId)

		// Get latest from registry instead of just pushing
		windowState.thoughtRegisters = this.tokenRegistry.getActiveThoughtRegisters(conversationId)
		windowState.messageRegisters = this.tokenRegistry.getMessageRegisters(conversationId)

		this.windowStateManager.updateWindowState(conversationId, windowState)

		// Always return the new thought ID, never reuse existing IDs
		return { success: true, registerId: thoughtId }
	}

	/**
	 * Execute a get operation to retrieve thought registers
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {object} parameters - Parameters for the get operation
	 * @param {string} messageId - Message ID containing the operation
	 * @returns {object} - Result with loaded registers
	 */
	_executeGetOperation(conversationId, parameters, messageId) {
		console.log(`[OperationsHandler] Executing get() operation for conversation ${conversationId}`)

		if (!conversationId) {
			const error = new Error("FATAL: conversationId is required for get operation")
			console.error(error.stack)
			process.exit(1)
		}

		let results = []
		const restoredRegisters = []

		if (parameters.registerIds && Array.isArray(parameters.registerIds) && parameters.registerIds.length > 0) {
			// Process register ranges first
			const expandedRegisterIds = this.tokenRegistry.expandRegisterRanges(parameters.registerIds)

			// Split into message (mN) and thought (tN) registers
			const messageRegisterIds = expandedRegisterIds.filter((id) => id.startsWith("m"))
			const thoughtRegisterIds = expandedRegisterIds.filter((id) => id.startsWith("t"))

			// Load message registers - use AnyWindow to get even registers outside the window
			if (messageRegisterIds.length > 0) {
				for (const id of messageRegisterIds) {
					// Get the register regardless of window status
					const register = this.tokenRegistry.getMessageRegisterAnyWindow(conversationId, id)
					if (register) {
						// Set the register's inWindow flag to true to bring it back into the window
						this.tokenRegistry.setMessageInWindow(conversationId, id, true)
						restoredRegisters.push(id)
						results.push(register)
					}
				}
			}

			// Load thought registers - use AnyWindow to get even registers outside the window
			if (thoughtRegisterIds.length > 0) {
				for (const id of thoughtRegisterIds) {
					// Get the register regardless of window status
					const register = this.tokenRegistry.getThoughtRegisterAnyWindow(conversationId, id)
					if (register) {
						// Set the register's inWindow flag to true to bring it back into the window
						this.tokenRegistry.setThoughtInWindow(conversationId, id, true)
						restoredRegisters.push(id)
						results.push(register)
					}
				}
			}
		} else if (parameters.content) {
			// Content search would need full text search - not implemented in memory
			// Just return some placeholder results for now
			console.log(`[OperationsHandler] Content search not fully implemented in memory: ${parameters.content}`)
			results = []
		} else if (parameters.historyId) {
			// Load history for a specific thought
			results = this.tokenRegistry.getThoughtHistory(conversationId, parameters.historyId)
		}

		// Update window state - always derive from TokenRegistry for consistency
		const windowState = this.windowStateManager.getWindowState(conversationId)

		// Set loaded registers from operation results
		windowState.loadedRegisters = results

		// Ensure message and thought registers are also up-to-date from registry
		// Use the InWindow variants to only show registers in the window
		windowState.messageRegisters = this.tokenRegistry.getMessageRegistersInWindow(conversationId)
		windowState.thoughtRegisters = this.tokenRegistry.getActiveThoughtRegistersInWindow(conversationId)

		this.windowStateManager.updateWindowState(conversationId, windowState)

		return {
			success: true,
			type: "get",
			registers: results,
			restoredRegisters: restoredRegisters,
		}
	}

	/**
	 * Execute a set operation to modify a thought register
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {object} parameters - Parameters for the set operation
	 * @param {string} messageId - Message ID containing the operation
	 * @returns {object} - Result indicating success
	 */
	_executeSetOperation(conversationId, parameters, messageId) {
		console.log(`[OperationsHandler] Executing set() operation for conversation ${conversationId}`)

		if (!conversationId) {
			const error = new Error("FATAL: conversationId is required for edit operation")
			console.error(error.stack)
			process.exit(1)
		}

		if (!parameters.registerId) {
			const error = new Error("FATAL: registerId is required for edit operation")
			console.error(error.stack)
			process.exit(1)
		}

		// Check if we're setting a thought register
		if (parameters.content) {
			// Content edit - move current to history first
			console.log(`[OperationsHandler] Editing thought register ${parameters.registerId}`)

			// Get current thought register
			const current = this.tokenRegistry.getThoughtRegister(conversationId, parameters.registerId)

			if (current) {
				// Move to history
				this.tokenRegistry.createThoughtHistory(conversationId, current)

				// Update with new content
				current.content = parameters.content
				current.version = (current.version || 1) + 1
				current.updated_at = new Date()
				this.tokenRegistry.updateThoughtRegister(conversationId, current)
			} else {
				console.log(`[OperationsHandler] Thought register ${parameters.registerId} not found for edit`)
			}
		} else {
			console.log(`[OperationsHandler] Error: set() operation requires content for register ${parameters.registerId}`)
		}

		// Update window state - always derive from TokenRegistry for consistency
		const windowState = this.windowStateManager.getWindowState(conversationId)

		// Always get the latest state from the registry to ensure consistency - only get registers in window
		windowState.messageRegisters = this.tokenRegistry.getMessageRegistersInWindow(conversationId)
		windowState.thoughtRegisters = this.tokenRegistry.getActiveThoughtRegistersInWindow(conversationId)

		this.windowStateManager.updateWindowState(conversationId, windowState)

		return {
			success: true,
			type: "set",
			registerId: parameters.registerId,
		}
	}

	/**
	 * Record a token operation in memory
	 *
	 * @param {object} operation - Operation to record
	 */
	_recordTokenOperation(operation) {
		console.log(`[OperationsHandler] Recording ${operation.operationType} operation`)

		if (!this.operations.has(operation.conversationId)) {
			this.operations.set(operation.conversationId, [])
		}

		const ops = this.operations.get(operation.conversationId)
		ops.push(operation)

		// Only keep the most recent operation in the window state to save tokens
		const windowState = this.windowStateManager.getWindowState(operation.conversationId)

		// Just store the latest operation instead of the entire history
		windowState.previousOperations = [operation]

		this.windowStateManager.updateWindowState(operation.conversationId, windowState)
	}

	/**
	 * Update the result ID for a token operation
	 *
	 * @param {string} operationId - Operation ID
	 * @param {string} resultId - Result ID
	 */
	_updateOperationResult(operationId, resultId) {
		console.log(`[OperationsHandler] Updating operation ${operationId} with result ${resultId}`)

		// Find operation in memory and update
		for (const [convId, ops] of this.operations.entries()) {
			const opIndex = ops.findIndex((op) => op.id === operationId)
			if (opIndex !== -1) {
				ops[opIndex].resultId = resultId
				break
			}
		}
	}

	/**
	 * Execute a del operation to remove registers from the window
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {object} parameters - Parameters for the del operation
	 * @param {string} messageId - Message ID containing the operation
	 * @returns {object} - Result indicating success
	 */
	_executeDelOperation(conversationId, parameters, messageId) {
		console.log(`[OperationsHandler] Executing del() operation for conversation ${conversationId}`)

		if (!conversationId) {
			const error = new Error("FATAL: conversationId is required for del operation")
			console.error(error.stack)
			process.exit(1)
		}

		if (!parameters.registerIds || !Array.isArray(parameters.registerIds) || parameters.registerIds.length === 0) {
			const error = new Error("FATAL: registerIds are required for del operation")
			console.error(error.stack)
			process.exit(1)
		}

		// Process register ranges first
		const expandedRegisterIds = this.tokenRegistry.expandRegisterRanges(parameters.registerIds)
		const removedRegisters = []

		// Process each register ID - set inWindow=false
		for (const registerId of expandedRegisterIds) {
			console.log(`[OperationsHandler] Removing register ${registerId} from window`)

			if (registerId.startsWith("t")) {
				// For thought registers, set inWindow=false
				if (this.tokenRegistry.removeThoughtFromWindow(conversationId, registerId)) {
					removedRegisters.push(registerId)
				}
			} else if (registerId.startsWith("m")) {
				// For message registers, set inWindow=false
				if (this.tokenRegistry.removeMessageFromWindow(conversationId, registerId)) {
					removedRegisters.push(registerId)
				}
			}
		}

		// Update window state - always derive from TokenRegistry for consistency
		const windowState = this.windowStateManager.getWindowState(conversationId)

		// Always get the latest state from the registry to ensure consistency - only get registers in window
		windowState.messageRegisters = this.tokenRegistry.getMessageRegistersInWindow(conversationId)
		windowState.thoughtRegisters = this.tokenRegistry.getActiveThoughtRegistersInWindow(conversationId)

		this.windowStateManager.updateWindowState(conversationId, windowState)

		return {
			success: true,
			type: "del",
			removedRegisters: removedRegisters,
		}
	}
}

module.exports = OperationsHandler
