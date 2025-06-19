import * as fs from "fs"
import * as path from "path"
import * as os from "os"

export class ConversationLogger {
	private logFile: string
	private taskId: string

	constructor(taskId: string) {
		this.taskId = taskId
		this.logFile = path.join(os.tmpdir(), `skyline-conversation-debug-${taskId}.log`)
		this.log("=== CONVERSATION DEBUG LOG STARTED ===")
	}

	private log(message: string) {
		const timestamp = new Date().toISOString()
		const logEntry = `[${timestamp}] ${message}\n`

		// Log to console
		console.log(`[CONV-DEBUG] ${message}`)

		// Log to file (async, don't block)
		try {
			fs.appendFileSync(this.logFile, logEntry)
		} catch (error) {
			console.error("Failed to write to conversation log file:", error)
		}
	}

	logApiConversationHistory(location: string, history: any[]) {
		this.log(`${location} - apiConversationHistory length: ${history.length}`)
		history.forEach((msg, index) => {
			this.log(`  [${index}] role: ${msg.role}, content length: ${JSON.stringify(msg.content).length}`)
		})
	}

	logAssistantMessageAdd(assistantMessage: string, didToolUse: boolean, messageContent: string) {
		this.log(`ASSISTANT MESSAGE ADD - assistantMessage.length: ${assistantMessage.length}, didToolUse: ${didToolUse}`)
		this.log(`ASSISTANT MESSAGE ADD - messageContent: "${messageContent.substring(0, 100)}..."`)
	}

	logContextManagerInput(messages: any[], deletedRange: any) {
		this.log(`CONTEXT MANAGER INPUT - messages.length: ${messages.length}, deletedRange: ${JSON.stringify(deletedRange)}`)
		messages.forEach((msg, index) => {
			this.log(`  INPUT[${index}] role: ${msg.role}, content length: ${JSON.stringify(msg.content).length}`)
		})
	}

	logContextManagerOutput(result: any[]) {
		this.log(`CONTEXT MANAGER OUTPUT - result.length: ${result.length}`)
		result.forEach((msg, index) => {
			this.log(`  OUTPUT[${index}] role: ${msg.role}, content length: ${JSON.stringify(msg.content).length}`)
		})
	}

	log3MessageSystemDetails(messages: any[], latestUserIndex: number, latestAssistantIndex: number) {
		this.log(`3-MESSAGE SYSTEM - total messages: ${messages.length}`)
		this.log(`3-MESSAGE SYSTEM - latestUserIndex: ${latestUserIndex}, latestAssistantIndex: ${latestAssistantIndex}`)
		if (latestUserIndex >= 0 && latestUserIndex < messages.length) {
			this.log(`3-MESSAGE SYSTEM - latest user role: ${messages[latestUserIndex].role}`)
		}
		if (latestAssistantIndex >= 0 && latestAssistantIndex < messages.length) {
			this.log(`3-MESSAGE SYSTEM - latest assistant role: ${messages[latestAssistantIndex].role}`)
		}
	}

	logAssistantMessageContent(assistantMessageContent: any[]) {
		this.log(`ASSISTANT MESSAGE CONTENT - blocks: ${assistantMessageContent.length}`)
		assistantMessageContent.forEach((block, index) => {
			this.log(`  BLOCK[${index}] type: ${block.type}, partial: ${block.partial}`)
		})
	}

	getLogFilePath(): string {
		return this.logFile
	}
}
