/**
 * TWP Efficiency Scorer
 *
 * Analyzes TWP usage patterns and assigns efficiency scores based on
 * mode-specific criteria and configuration thresholds.
 */

const fs = require("fs")
const path = require("path")

class TWPEfficiencyScorer {
	constructor() {
		// Load configuration
		try {
			this.config = require(path.join(process.cwd(), "data/config/bot-config.json"))
			console.log("[TWPEfficiencyScorer] Loaded configuration")
		} catch (err) {
			console.error(`[TWPEfficiencyScorer] Failed to load config: ${err.message}`)
			// Fallback config
			this.config = {
				twp_scoring: {
					speedrun: {
						max_thinking_tokens: 50,
						max_thinking_before_tool: 20,
						max_twp_explanation_tokens: 30,
						max_window_growth_rate: 0.1,
					},
					survival: {
						max_thinking_tokens: 100,
						max_thinking_before_tool: 40,
						max_twp_explanation_tokens: 50,
						max_window_growth_rate: 0.05,
					},
					optimization: {
						max_thinking_tokens: 150,
						max_thinking_before_tool: 60,
						max_twp_explanation_tokens: 75,
						max_window_growth_rate: 0.08,
					},
				},
			}
		}
	}

	/**
	 * Calculate efficiency scores for a conversation turn
	 *
	 * @param {object} windowState - Current window state
	 * @param {string} lastAssistantMessage - Last assistant message content
	 * @param {string} mode - Current TWP mode (speedrun/survival/optimization)
	 * @returns {object} - Efficiency scores and details
	 */
	calculateEfficiencyScores(windowState, lastAssistantMessage, mode = null) {
		console.log(`[TWPEfficiencyScorer] Calculating scores for mode: ${mode || "none"}`)

		// Get mode-specific config
		const modeConfig = mode ? this.config.twp_scoring[mode] : null

		// Parse the assistant message content
		const messageAnalysis = this._analyzeMessage(lastAssistantMessage)

		// Calculate output score
		const outputScore = this._calculateOutputScore(messageAnalysis, modeConfig, mode)

		// Calculate operations score
		const operationsScore = this._calculateOperationsScore(windowState, messageAnalysis, modeConfig, mode)

		// Calculate window metrics
		const windowMetrics = this._calculateWindowMetrics(windowState)

		return {
			mode: mode || "none",
			outputScore: outputScore.score,
			outputDetails: outputScore.details,
			operationsScore: operationsScore.score,
			operationsDetails: operationsScore.details,
			windowMetrics: windowMetrics,
			overallEfficient: outputScore.score === "EFFICIENT" || operationsScore.score === "EFFICIENT",
		}
	}

	/**
	 * Analyze assistant message content for scoring patterns
	 *
	 * @param {string} content - Message content
	 * @returns {object} - Analysis results
	 * @private
	 */
	_analyzeMessage(content) {
		if (!content || typeof content !== "string") {
			return {
				thinkingTokens: 0,
				thinkingBeforeToolTokens: 0,
				twpExplanationTokens: 0,
				twpOperations: [],
				hasEmptyTwpBlock: false,
				totalTokens: 0,
			}
		}

		// Extract thinking content
		const thinkingMatches = content.match(/<thinking>([\s\S]*?)<\/thinking>/g)
		let thinkingTokens = 0
		let thinkingBeforeToolTokens = 0

		if (thinkingMatches) {
			for (const match of thinkingMatches) {
				const thinkingContent = match.replace(/<\/?thinking>/g, "")
				const tokens = this._estimateTokens(thinkingContent)
				thinkingTokens += tokens

				// Check if this thinking block appears before a tool use
				const afterThinking = content.split(match)[1]
				if (afterThinking && afterThinking.match(/^\s*<[a-z_]+>/)) {
					thinkingBeforeToolTokens += tokens
				}
			}
		}

		// Extract TWP operations
		const twpOperations = this._extractTwpOperations(content)

		// Check for empty TWP blocks
		const hasEmptyTwpBlock = this._hasEmptyTwpBlock(content)

		// Estimate TWP explanation tokens (content between operations and outside thinking)
		const twpExplanationTokens = this._estimateTwpExplanationTokens(content)

		// Estimate total tokens
		const totalTokens = this._estimateTokens(content)

		return {
			thinkingTokens,
			thinkingBeforeToolTokens,
			twpExplanationTokens,
			twpOperations,
			hasEmptyTwpBlock,
			totalTokens,
		}
	}

	/**
	 * Calculate output efficiency score
	 *
	 * @param {object} messageAnalysis - Message analysis
	 * @param {object} modeConfig - Mode-specific config
	 * @param {string} mode - Current mode
	 * @returns {object} - Score and details
	 * @private
	 */
	_calculateOutputScore(messageAnalysis, modeConfig, mode) {
		const details = []
		let score = "ADEQUATE"

		if (!modeConfig) {
			return { score, details: ["No mode set - default to ADEQUATE"] }
		}

		// Check for INEFFICIENT patterns
		if (messageAnalysis.thinkingTokens > modeConfig.max_thinking_tokens) {
			score = "INEFFICIENT"
			details.push(`Long thinking: ${messageAnalysis.thinkingTokens} > ${modeConfig.max_thinking_tokens} tokens`)
		}

		if (messageAnalysis.thinkingBeforeToolTokens > modeConfig.max_thinking_before_tool) {
			score = "INEFFICIENT"
			details.push(
				`Excessive pre-tool thinking: ${messageAnalysis.thinkingBeforeToolTokens} > ${modeConfig.max_thinking_before_tool} tokens`,
			)
		}

		if (messageAnalysis.twpExplanationTokens > modeConfig.max_twp_explanation_tokens) {
			score = "INEFFICIENT"
			details.push(
				`Long TWP explanations: ${messageAnalysis.twpExplanationTokens} > ${modeConfig.max_twp_explanation_tokens} tokens`,
			)
		}

		// Check for EFFICIENT patterns (only if not already inefficient)
		if (score === "ADEQUATE") {
			if (messageAnalysis.thinkingTokens < modeConfig.max_thinking_tokens * 0.5) {
				score = "EFFICIENT"
				details.push(`Concise thinking: ${messageAnalysis.thinkingTokens} tokens`)
			}

			if (messageAnalysis.thinkingBeforeToolTokens < modeConfig.max_thinking_before_tool * 0.5) {
				if (score !== "EFFICIENT") score = "EFFICIENT"
				details.push(`Minimal pre-tool thinking: ${messageAnalysis.thinkingBeforeToolTokens} tokens`)
			}
		}

		if (details.length === 0) {
			details.push(`Output within acceptable range: ${messageAnalysis.totalTokens} tokens`)
		}

		return { score, details }
	}

	/**
	 * Calculate operations efficiency score
	 *
	 * @param {object} windowState - Window state
	 * @param {object} messageAnalysis - Message analysis
	 * @param {object} modeConfig - Mode-specific config
	 * @param {string} mode - Current mode
	 * @returns {object} - Score and details
	 * @private
	 */
	_calculateOperationsScore(windowState, messageAnalysis, modeConfig, mode) {
		const details = []
		let score = "ADEQUATE"

		// Check for INEFFICIENT patterns
		if (messageAnalysis.hasEmptyTwpBlock) {
			score = "INEFFICIENT"
			details.push("Empty TWP block wastes 8 tokens")
		}

		// Check for duplicate operations
		const duplicateOps = this._findDuplicateOperations(messageAnalysis.twpOperations)
		if (duplicateOps.length > 0) {
			score = "INEFFICIENT"
			details.push(`Duplicate operations: ${duplicateOps.join(", ")}`)
		}

		// Check for sequential IDs not using ranges
		const missedRanges = this._findMissedRangeOpportunities(messageAnalysis.twpOperations)
		if (missedRanges.length > 0) {
			score = "INEFFICIENT"
			details.push(`Should use ranges: ${missedRanges.join(", ")}`)
		}

		// Check for EFFICIENT patterns (only if not already inefficient)
		if (score === "ADEQUATE") {
			// Check window growth rate
			const windowGrowthRate = this._calculateWindowGrowthRate(windowState)
			if (modeConfig && windowGrowthRate < modeConfig.max_window_growth_rate) {
				score = "EFFICIENT"
				details.push(`Good window management: ${(windowGrowthRate * 100).toFixed(1)}% growth`)
			}

			// Check for proper range usage
			const hasRangeUsage = this._hasProperRangeUsage(messageAnalysis.twpOperations)
			if (hasRangeUsage) {
				if (score !== "EFFICIENT") score = "EFFICIENT"
				details.push("Efficient range usage detected")
			}
		}

		if (details.length === 0) {
			details.push("Operations within acceptable parameters")
		}

		return { score, details }
	}

	/**
	 * Calculate window metrics
	 *
	 * @param {object} windowState - Window state
	 * @returns {object} - Window metrics
	 * @private
	 */
	_calculateWindowMetrics(windowState) {
		const messageCount = windowState.messageRegisters ? windowState.messageRegisters.length : 0
		const thoughtCount = windowState.thoughtRegisters ? windowState.thoughtRegisters.length : 0

		// Rough window size estimate (this could be made more accurate)
		const estimatedWindowSize = (messageCount + thoughtCount) * 200 // rough estimate
		const windowPercentage = Math.min((estimatedWindowSize / 64000) * 100, 100)

		return {
			messageCount,
			thoughtCount,
			estimatedSize: estimatedWindowSize,
			percentageFull: windowPercentage,
		}
	}

	/**
	 * Extract TWP operations from message content
	 *
	 * @param {string} content - Message content
	 * @returns {Array} - Extracted operations
	 * @private
	 */
	_extractTwpOperations(content) {
		const operations = []

		// Look for TWPSTART/TWPSTOP blocks
		const twpMatches = content.match(/TWPSTART([\s\S]*?)TWPSTOP/g)

		if (twpMatches) {
			for (const match of twpMatches) {
				const opContent = match.replace(/TWPSTART|TWPSTOP/g, "").trim()

				// Extract get(), del(), set(), new() operations
				const getMatches = opContent.match(/get\([^)]+\)/g)
				const delMatches = opContent.match(/del\([^)]+\)/g)
				const setMatches = opContent.match(/set\([^)]+\)/g)
				const newMatches = opContent.match(/new\([^)]+\)/g)

				if (getMatches) operations.push(...getMatches.map((op) => ({ type: "get", operation: op })))
				if (delMatches) operations.push(...delMatches.map((op) => ({ type: "del", operation: op })))
				if (setMatches) operations.push(...setMatches.map((op) => ({ type: "set", operation: op })))
				if (newMatches) operations.push(...newMatches.map((op) => ({ type: "new", operation: op })))
			}
		}

		return operations
	}

	/**
	 * Check for empty TWP blocks
	 *
	 * @param {string} content - Message content
	 * @returns {boolean} - Whether empty TWP block exists
	 * @private
	 */
	_hasEmptyTwpBlock(content) {
		const emptyBlockMatch = content.match(/TWPSTART\s*TWPSTOP/)
		return !!emptyBlockMatch
	}

	/**
	 * Estimate TWP explanation tokens
	 *
	 * @param {string} content - Message content
	 * @returns {number} - Estimated tokens
	 * @private
	 */
	_estimateTwpExplanationTokens(content) {
		// Look for content that mentions TWP operations outside of thinking blocks
		let explanationContent = content

		// Remove thinking blocks
		explanationContent = explanationContent.replace(/<thinking>[\s\S]*?<\/thinking>/g, "")

		// Remove tool blocks
		explanationContent = explanationContent.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/g, "")

		// Look for TWP-related keywords
		const twpKeywords = ["twp", "del(", "get(", "operation", "token window", "register"]
		let twpRelatedContent = ""

		const sentences = explanationContent.split(/[.!?]+/)
		for (const sentence of sentences) {
			if (twpKeywords.some((keyword) => sentence.toLowerCase().includes(keyword))) {
				twpRelatedContent += sentence + ". "
			}
		}

		return this._estimateTokens(twpRelatedContent)
	}

	/**
	 * Find duplicate operations in the same operation set
	 *
	 * @param {Array} operations - Operations to check
	 * @returns {Array} - Duplicate operation types
	 * @private
	 */
	_findDuplicateOperations(operations) {
		const typeCounts = {}
		const duplicates = []

		for (const op of operations) {
			typeCounts[op.type] = (typeCounts[op.type] || 0) + 1
		}

		for (const [type, count] of Object.entries(typeCounts)) {
			if (count > 1) {
				duplicates.push(`${type}() x${count}`)
			}
		}

		return duplicates
	}

	/**
	 * Find missed range opportunities
	 *
	 * @param {Array} operations - Operations to check
	 * @returns {Array} - Missed range opportunities
	 * @private
	 */
	_findMissedRangeOpportunities(operations) {
		const missed = []

		for (const op of operations) {
			// Look for patterns like del(m1,m2,m3) that should be del(m1-m3)
			const idMatch = op.operation.match(/\(([^)]+)\)/)
			if (idMatch) {
				const ids = idMatch[1].split(",").map((id) => id.trim())
				if (ids.length >= 3) {
					// Check if they're sequential
					const sequential = this._areIdsSequential(ids)
					if (sequential) {
						missed.push(`${op.type}(${ids.join(",")}) should be ${op.type}(${ids[0]}-${ids[ids.length - 1]})`)
					}
				}
			}
		}

		return missed
	}

	/**
	 * Check if IDs are sequential (e.g., m1,m2,m3)
	 *
	 * @param {Array} ids - ID list to check
	 * @returns {boolean} - Whether IDs are sequential
	 * @private
	 */
	_areIdsSequential(ids) {
		if (ids.length < 2) return false

		const prefix = ids[0].replace(/\d+$/, "")
		const numbers = ids.map((id) => {
			const match = id.match(/(\d+)$/)
			return match ? parseInt(match[1]) : null
		})

		if (numbers.some((n) => n === null)) return false

		for (let i = 1; i < numbers.length; i++) {
			if (numbers[i] !== numbers[i - 1] + 1) return false
		}

		return true
	}

	/**
	 * Check for proper range usage
	 *
	 * @param {Array} operations - Operations to check
	 * @returns {boolean} - Whether proper range usage exists
	 * @private
	 */
	_hasProperRangeUsage(operations) {
		for (const op of operations) {
			if (op.operation.includes("-")) {
				return true // Found range syntax
			}
		}
		return false
	}

	/**
	 * Calculate window growth rate
	 *
	 * @param {object} windowState - Window state
	 * @returns {number} - Growth rate
	 * @private
	 */
	_calculateWindowGrowthRate(windowState) {
		// This is a placeholder - in a real implementation, you'd track
		// window size over time to calculate actual growth rate
		const currentSize = (windowState.messageRegisters?.length || 0) + (windowState.thoughtRegisters?.length || 0)

		// Rough estimate based on current size vs max capacity
		return Math.min(currentSize / 100, 1.0) // Assume 100 is reasonable capacity
	}

	/**
	 * Estimate token count for text
	 *
	 * @param {string} text - Text to estimate
	 * @returns {number} - Estimated token count
	 * @private
	 */
	_estimateTokens(text) {
		if (!text || typeof text !== "string") return 0
		// Rough estimation: ~4 characters per token
		return Math.ceil(text.length / 4)
	}
}

module.exports = TWPEfficiencyScorer
