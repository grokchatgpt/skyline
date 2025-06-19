/**
 * Token Registry
 *
 * Responsible for assigning and managing register IDs for
 * both message (mN) and thought (tN) registers.
 * Using in-memory storage for prototype implementation.
 */

const path = require("path")

class TokenRegistry {
	constructor() {
		console.log("[TokenRegistry] Initializing with in-memory storage")

		// In-memory storage for registers
		this.messageRegisters = new Map() // conversationId -> Array of message registers
		this.thoughtRegisters = new Map() // conversationId -> Map of thought registers
		this.thoughtHistory = new Map() // conversationId -> Map of thoughtId -> Array of history versions

		// Track used message register IDs to prevent reuse within a conversation
		this.usedMessageIds = new Map() // conversationId -> Set of used message register IDs

		console.log("[TokenRegistry] Initialized")
	}

	/**
	 * Get or create a conversation's register storage
	 * @private
	 */
	_getConversationStorage(conversationId) {
		// Initialize storage for this conversation if it doesn't exist
		if (!this.messageRegisters.has(conversationId)) {
			this.messageRegisters.set(conversationId, [])
		}

		if (!this.thoughtRegisters.has(conversationId)) {
			this.thoughtRegisters.set(conversationId, new Map())
		}

		if (!this.thoughtHistory.has(conversationId)) {
			this.thoughtHistory.set(conversationId, new Map())
		}

		if (!this.usedMessageIds.has(conversationId)) {
			this.usedMessageIds.set(conversationId, new Set())
		}

		return {
			messageArray: this.messageRegisters.get(conversationId),
			thoughtMap: this.thoughtRegisters.get(conversationId),
			historyMap: this.thoughtHistory.get(conversationId),
			usedMessageIds: this.usedMessageIds.get(conversationId),
		}
	}

	/**
	 * Create message registers from an array of messages
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {Array} messages - Array of messages from client request
	 * @returns {Array} - Array of created/updated message registers
	 */
	createMessageRegisters(conversationId, messages) {
		console.log(`[TokenRegistry] Creating message registers for ${messages.length} messages`)

		if (!conversationId || !messages || !Array.isArray(messages)) {
			console.error("[TokenRegistry] Invalid parameters for createMessageRegisters")
			return []
		}

		const { messageArray } = this._getConversationStorage(conversationId)
		const newRegisters = []

		// Process messages in chronological order to maintain proper conversation flow
		// This ensures we preserve the exact user → assistant → user alternating pattern
		const messagesToRegister = []

		// Skip system message (index 0), process conversation messages chronologically
		for (let i = 1; i < messages.length; i++) {
			const message = messages[i]

			// Only add if not already registered (check against existing messageArray)
			const isAlreadyRegistered = messageArray.some((reg) => {
				// Compare by content and role to detect duplicates
				return reg.content === message.content && reg.role === message.role
			})

			if (!isAlreadyRegistered) {
				messagesToRegister.push(message)
				console.log(`[TokenRegistry] Adding ${message.role} message to register queue`)
			} else {
				console.log(`[TokenRegistry] Skipping duplicate ${message.role} message`)
			}
		}

		// Get used message IDs for this conversation
		const { usedMessageIds } = this._getConversationStorage(conversationId)

		// Find the highest existing message ID to ensure IDs are never reused
		let maxMessageId = 0

		// Check both current message registers and the history of used IDs
		for (const register of messageArray) {
			if (register.id.startsWith("m")) {
				const idNum = parseInt(register.id.substring(1), 10)
				if (!isNaN(idNum) && idNum > maxMessageId) {
					maxMessageId = idNum
					console.log(`[TokenRegistry] Found message ID: ${register.id} (${idNum}) in current message array`)
				}
			}
		}

		// Also check usedMessageIds to prevent reusing IDs that were removed
		for (const id of usedMessageIds) {
			if (id.startsWith("m")) {
				const idNum = parseInt(id.substring(1), 10)
				if (!isNaN(idNum) && idNum > maxMessageId) {
					maxMessageId = idNum
					console.log(`[TokenRegistry] Found message ID: ${id} (${idNum}) in usedMessageIds set`)
				}
			}
		}

		console.log(`[TokenRegistry] Highest message ID for conversation ${conversationId} is ${maxMessageId}`)

		// Following the TWP flow described in docs/twp.md:
		// In first round: m1 = user message
		// In second round: m2 = assistant message, m3 = user message
		// In third round: m4 = assistant message, m5 = user message
		// And so on...
		for (const message of messagesToRegister) {
			let registerId
			let sequenceNumber

			if (message.role === "user") {
				// User messages get odd numbers (m1, m3, m5...)
				sequenceNumber = maxMessageId % 2 === 0 ? maxMessageId + 1 : maxMessageId + 2
				while (usedMessageIds.has(`m${sequenceNumber}`)) {
					sequenceNumber += 2 // Skip to next odd number
				}
				registerId = `m${sequenceNumber}`
				maxMessageId = Math.max(maxMessageId, sequenceNumber)
			} else if (message.role === "assistant") {
				// Assistant messages get even numbers (m2, m4, m6...)
				sequenceNumber = maxMessageId % 2 === 1 ? maxMessageId + 1 : maxMessageId + 2
				while (usedMessageIds.has(`m${sequenceNumber}`)) {
					sequenceNumber += 2 // Skip to next even number
				}
				registerId = `m${sequenceNumber}`
				maxMessageId = Math.max(maxMessageId, sequenceNumber)
			} else {
				throw new Error(`FATAL: TWP Unknown message role: ${message.role}`)
				process.exit(1)
			}

			const register = {
				id: registerId,
				conversationId: conversationId,
				content: message.content, // Clean content without visible prefix
				role: message.role,
				sequence_number: sequenceNumber,
				inWindow: true, // Flag to track if register is in the current window
			}

			console.log(`[TokenRegistry] Creating register ${registerId} with role ${message.role}`)

			// Store in our array
			messageArray.push(register)
			newRegisters.push(register)

			// Track this ID as used to prevent future reuse
			usedMessageIds.add(registerId)
		}

		return newRegisters
	}

	/**
	 * Get all message registers for a conversation
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {boolean} onlyInWindow - Whether to only return registers in the window (default: false)
	 * @returns {Array} - Array of message register objects
	 */
	getMessageRegisters(conversationId, onlyInWindow = false) {
		if (!conversationId) {
			return []
		}

		const { messageArray } = this._getConversationStorage(conversationId)
		const registers = [...messageArray] // Make a copy

		if (onlyInWindow) {
			return registers.filter((register) => register.inWindow !== false)
		}

		return registers
	}

	/**
	 * Get all message registers that are in the current window
	 *
	 * @param {string} conversationId - Conversation ID
	 * @returns {Array} - Array of message register objects in window
	 */
	getMessageRegistersInWindow(conversationId) {
		return this.getMessageRegisters(conversationId, true)
	}

	/**
	 * Get message register by ID
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} registerId - Register ID (mN)
	 * @param {boolean} ignoreWindow - Whether to ignore inWindow flag (default: false)
	 * @returns {object|null} - Message register or null if not found
	 */
	getMessageRegister(conversationId, registerId, ignoreWindow = false) {
		if (!conversationId || !registerId) {
			return null
		}

		const { messageArray } = this._getConversationStorage(conversationId)
		const register = messageArray.find((reg) => reg.id === registerId)

		if (register && (ignoreWindow || register.inWindow !== false)) {
			return register
		}

		return null
	}

	/**
	 * Get message register by ID regardless of window status
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} registerId - Register ID (mN)
	 * @returns {object|null} - Message register or null if not found
	 */
	getMessageRegisterAnyWindow(conversationId, registerId) {
		return this.getMessageRegister(conversationId, registerId, true)
	}

	/**
	 * Get the next available thought ID for a conversation
	 * Ensures IDs are never reused, even for inactive thoughts
	 *
	 * @param {string} conversationId - Conversation ID
	 * @returns {string} - Next available thought ID (t1, t2, etc.)
	 */
	getNextThoughtId(conversationId) {
		console.log(`[TokenRegistry] Getting next thought ID for conversation ${conversationId}`)

		if (!conversationId) {
			throw new Error("FATAL: conversationId is required for getNextThoughtId")
		}

		const { thoughtMap, historyMap } = this._getConversationStorage(conversationId)

		// Find the highest existing thought ID number across both active and historical thoughts
		let maxId = 0

		// Check active thoughts
		thoughtMap.forEach((thought, id) => {
			if (id.startsWith("t")) {
				const idNum = parseInt(id.substring(1), 10)
				if (!isNaN(idNum) && idNum > maxId) {
					maxId = idNum
				}
			}
		})

		// Also check the history to ensure we never reuse IDs even from deleted/inactive thoughts
		historyMap.forEach((historyEntries, id) => {
			if (id.startsWith("t")) {
				const idNum = parseInt(id.substring(1), 10)
				if (!isNaN(idNum) && idNum > maxId) {
					maxId = idNum
				}
			}
		})

		const nextId = `t${maxId + 1}`
		console.log(`[TokenRegistry] Next thought ID is ${nextId}`)

		return nextId
	}

	/**
	 * Create a new thought register
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} id - Thought ID (t1, t2, etc.)
	 * @param {string} content - Content for the thought
	 * @param {string[]} referenceIds - Array of reference IDs (optional)
	 * @returns {object} - Created thought register
	 */
	createThoughtRegister(conversationId, id, content, referenceIds = []) {
		if (!conversationId || !id || !content) {
			throw new Error("FATAL: conversationId, id, and content are required")
		}

		const { thoughtMap } = this._getConversationStorage(conversationId)

		const thoughtRegister = {
			id,
			conversationId,
			content,
			referenceIds: Array.isArray(referenceIds) ? referenceIds : [],
			created_at: new Date(),
			updated_at: new Date(),
			is_active: true,
			inWindow: true, // Flag to track if register is in the current window
			version: 1,
		}

		thoughtMap.set(id, thoughtRegister)
		return thoughtRegister
	}

	/**
	 * Get a thought register by ID
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} thoughtId - Thought ID (t1, t2, etc.)
	 * @param {boolean} ignoreWindow - Whether to ignore inWindow flag (default: false)
	 * @returns {object|null} - Thought register or null if not found
	 */
	getThoughtRegister(conversationId, thoughtId, ignoreWindow = false) {
		if (!conversationId || !thoughtId) {
			return null
		}

		const { thoughtMap } = this._getConversationStorage(conversationId)
		const register = thoughtMap.get(thoughtId)

		if (register && (ignoreWindow || register.inWindow !== false)) {
			return register
		}

		return null
	}

	/**
	 * Get thought register by ID regardless of window status
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} thoughtId - Thought ID (t1, t2, etc.)
	 * @returns {object|null} - Thought register or null if not found
	 */
	getThoughtRegisterAnyWindow(conversationId, thoughtId) {
		return this.getThoughtRegister(conversationId, thoughtId, true)
	}

	/**
	 * Get all thought registers for a conversation
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {boolean} onlyInWindow - Whether to only return registers in the window (default: false)
	 * @param {boolean} onlyActive - Whether to only return active registers (default: true)
	 * @returns {Array} - Array of thought register objects
	 */
	getThoughtRegisters(conversationId, onlyInWindow = false, onlyActive = true) {
		if (!conversationId) {
			return []
		}

		const { thoughtMap } = this._getConversationStorage(conversationId)
		let registers = Array.from(thoughtMap.values())

		if (onlyActive) {
			registers = registers.filter((thought) => thought.is_active)
		}

		if (onlyInWindow) {
			registers = registers.filter((thought) => thought.inWindow !== false)
		}

		return registers
	}

	/**
	 * Get all active thought registers that are in the current window
	 *
	 * @param {string} conversationId - Conversation ID
	 * @returns {Array} - Array of thought register objects in window
	 */
	getActiveThoughtRegistersInWindow(conversationId) {
		return this.getThoughtRegisters(conversationId, true, true)
	}

	/**
	 * Get all active thought registers regardless of window status
	 *
	 * @param {string} conversationId - Conversation ID
	 * @returns {Array} - Array of thought register objects
	 */
	getActiveThoughtRegisters(conversationId) {
		return this.getThoughtRegisters(conversationId, false, true)
	}

	/**
	 * Update a thought register
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {object} thoughtRegister - Updated thought register
	 * @returns {object} - Updated thought register
	 */
	updateThoughtRegister(conversationId, thoughtRegister) {
		if (!conversationId || !thoughtRegister || !thoughtRegister.id) {
			throw new Error("FATAL: conversationId and thoughtRegister with id are required")
		}

		const { thoughtMap } = this._getConversationStorage(conversationId)

		// Update the register
		thoughtRegister.updated_at = new Date()
		thoughtMap.set(thoughtRegister.id, thoughtRegister)

		return thoughtRegister
	}

	/**
	 * Create a history entry for a thought register before updating it
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {object} thoughtRegister - Thought register to archive
	 * @returns {object} - Created history entry
	 */
	createThoughtHistory(conversationId, thoughtRegister) {
		if (!conversationId || !thoughtRegister || !thoughtRegister.id) {
			throw new Error("FATAL: conversationId and thoughtRegister with id are required")
		}

		const { historyMap } = this._getConversationStorage(conversationId)

		// Create history entry
		const historyEntry = {
			...thoughtRegister,
			created_at: new Date(),
		}

		// Initialize history array if it doesn't exist
		if (!historyMap.has(thoughtRegister.id)) {
			historyMap.set(thoughtRegister.id, [])
		}

		// Add to history
		const history = historyMap.get(thoughtRegister.id)
		history.unshift(historyEntry) // Add to beginning (newest first)

		return historyEntry
	}

	/**
	 * Get thought history for a thought register
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} thoughtId - Thought ID
	 * @returns {Array} - Array of history entries
	 */
	getThoughtHistory(conversationId, thoughtId) {
		if (!conversationId || !thoughtId) {
			return []
		}

		const { historyMap } = this._getConversationStorage(conversationId)
		return historyMap.has(thoughtId) ? [...historyMap.get(thoughtId)] : []
	}

	/**
	 * Set the inWindow flag for a thought register
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} thoughtId - Thought ID
	 * @param {boolean} inWindow - Whether the register should be in the window (default: true)
	 * @returns {boolean} - Success
	 */
	setThoughtInWindow(conversationId, thoughtId, inWindow = true) {
		if (!conversationId || !thoughtId) {
			return false
		}

		const { thoughtMap } = this._getConversationStorage(conversationId)
		const thought = thoughtMap.get(thoughtId)

		if (thought) {
			thought.inWindow = inWindow
			thought.updated_at = new Date()
			thoughtMap.set(thoughtId, thought)

			console.log(`[TokenRegistry] Set thought register ${thoughtId} inWindow=${inWindow}`)
			return true
		}

		console.log(`[TokenRegistry] Thought register ${thoughtId} not found for inWindow update`)
		return false
	}

	/**
	 * Remove a thought register from the window
	 * Sets inWindow flag to false without changing is_active
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} thoughtId - Thought ID
	 * @returns {boolean} - Success
	 */
	removeThoughtFromWindow(conversationId, thoughtId) {
		return this.setThoughtInWindow(conversationId, thoughtId, false)
	}

	/**
	 * Deactivate a thought register
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} thoughtId - Thought ID
	 * @returns {boolean} - Success
	 */
	deactivateThoughtRegister(conversationId, thoughtId) {
		if (!conversationId || !thoughtId) {
			return false
		}

		const { thoughtMap } = this._getConversationStorage(conversationId)
		const thought = thoughtMap.get(thoughtId)

		if (thought) {
			thought.is_active = false
			thought.updated_at = new Date()
			thoughtMap.set(thoughtId, thought)

			console.log(`[TokenRegistry] Deactivated thought register ${thoughtId}`)
			return true
		}

		console.log(`[TokenRegistry] Thought register ${thoughtId} not found for deactivation`)
		return false
	}

	/**
	 * Set the inWindow flag for a message register
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} registerId - Register ID (mN)
	 * @param {boolean} inWindow - Whether the register should be in the window (default: true)
	 * @returns {boolean} - Success
	 */
	setMessageInWindow(conversationId, registerId, inWindow = true) {
		if (!conversationId || !registerId || !registerId.startsWith("m")) {
			return false
		}

		const { messageArray } = this._getConversationStorage(conversationId)

		// Find the register to update
		const registerIndex = messageArray.findIndex((reg) => reg.id === registerId)

		if (registerIndex !== -1) {
			// Update the inWindow flag
			messageArray[registerIndex].inWindow = inWindow

			console.log(`[TokenRegistry] Set message register ${registerId} inWindow=${inWindow}`)
			return true
		}

		console.log(`[TokenRegistry] Message register ${registerId} not found for inWindow update`)
		return false
	}

	/**
	 * Remove a message register from the window
	 * Sets inWindow flag to false (keeping the message in the registry)
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} registerId - Register ID (mN)
	 * @returns {boolean} - Success
	 */
	removeMessageFromWindow(conversationId, registerId) {
		return this.setMessageInWindow(conversationId, registerId, false)
	}

	/**
	 * Remove a message register while preserving its ID in the used set
	 *
	 * @param {string} conversationId - Conversation ID
	 * @param {string} registerId - Register ID to remove
	 * @returns {boolean} - Success
	 */
	removeMessageRegister(conversationId, registerId) {
		if (!conversationId || !registerId || !registerId.startsWith("m")) {
			return false
		}

		// Just set inWindow to false instead of removing from array
		return this.removeMessageFromWindow(conversationId, registerId)
	}

	/**
	 * Clear all message registers for a conversation
	 * This preserves the IDs in the used set to prevent reuse
	 *
	 * @param {string} conversationId - Conversation ID
	 * @returns {boolean} - Success
	 */
	clearMessageRegisters(conversationId) {
		if (!conversationId) {
			return false
		}

		const { messageArray } = this._getConversationStorage(conversationId)

		// Clear the array
		messageArray.length = 0

		// Note: We don't need to modify usedMessageIds here since we want to
		// keep tracking of all previously used IDs

		return true
	}

	/**
	 * Reset a conversation's token window
	 * Clears all message and thought registers from the window
	 * while preserving ID tracking to prevent reuse
	 *
	 * @param {string} conversationId - Conversation ID
	 * @returns {boolean} - Success
	 */
	resetConversation(conversationId) {
		const logger = require(path.join(process.cwd(), "services/logging"))
		logger.info(`Resetting token window for conversation ${conversationId}`)

		if (!conversationId) {
			return false
		}

		// Get storage for this conversation
		const { messageArray, thoughtMap } = this._getConversationStorage(conversationId)

		// Clear all message registers
		messageArray.length = 0

		// Set all thought registers to inactive and out of window
		for (const [id, thought] of thoughtMap) {
			thought.is_active = false
			thought.inWindow = false
			thoughtMap.set(id, thought)
		}

		// CRITICAL: Reset the ID tracking to ensure we start fresh with m1, m2, etc.
		if (this.usedMessageIds.has(conversationId)) {
			logger.info(`Resetting ID tracking for conversation ${conversationId}`)
			this.usedMessageIds.set(conversationId, new Set())
		}

		logger.info(`Token window reset complete for conversation ${conversationId}`)
		return true
	}

	expandRegisterRanges(registerIds) {
		console.log(`[TokenRegistry] Expanding register ranges: ${registerIds.join(", ")}`)

		if (!registerIds || !Array.isArray(registerIds)) {
			return []
		}

		const expandedIds = []

		for (const id of registerIds) {
			// Check if it's a range (e.g., "m1-m5", "t10-t20")
			const rangeMatch = id.match(/^([mt])(\d+)-\1(\d+)$/)

			if (rangeMatch) {
				// Extract range parts
				const [_, prefix, startStr, endStr] = rangeMatch
				const start = parseInt(startStr, 10)
				const end = parseInt(endStr, 10)

				// Validate range
				if (isNaN(start) || isNaN(end) || start > end) {
					console.error(`[TokenRegistry] Invalid range: ${id}, skipping`)
					continue
				}

				// Generate IDs in range
				for (let i = start; i <= end; i++) {
					expandedIds.push(`${prefix}${i}`)
				}
			} else {
				// Not a range, add as-is
				expandedIds.push(id)
			}
		}

		console.log(`[TokenRegistry] Expanded to: ${expandedIds.join(", ")}`)

		return expandedIds
	}
}

module.exports = TokenRegistry
