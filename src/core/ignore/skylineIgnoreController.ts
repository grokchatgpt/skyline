import path from "path"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import ignore, { Ignore } from "ignore"
import * as vscode from "vscode"

export const LOCK_TEXT_SYMBOL = "\u{1F512}"

/**
 * Controls LLM access to files by enforcing ignore patterns.
 * Designed to be instantiated once in skyline.ts and passed to file manipulation services.
 * Uses the 'ignore' library to support standard .gitignore syntax in .skylineignore files.
 */
export class skylineIgnoreController {
	private cwd: string
	private ignoreInstance: Ignore
	private disposables: vscode.Disposable[] = []
	skylineIgnoreContent: string | undefined

	constructor(cwd: string) {
		this.cwd = cwd
		this.ignoreInstance = ignore()
		this.skylineIgnoreContent = undefined
		// Set up file watcher for .skylineignore
		this.setupFileWatcher()
	}

	/**
	 * Initialize the controller by loading custom patterns
	 * Must be called after construction and before using the controller
	 */
	async initialize(): Promise<void> {
		await this.loadskylineIgnore()
	}

	/**
	 * Set up the file watcher for .skylineignore changes
	 */
	private setupFileWatcher(): void {
		const skylineignorePattern = new vscode.RelativePattern(this.cwd, ".skylineignore")
		const fileWatcher = vscode.workspace.createFileSystemWatcher(skylineignorePattern)

		// Watch for changes and updates
		this.disposables.push(
			fileWatcher.onDidChange(() => {
				this.loadskylineIgnore()
			}),
			fileWatcher.onDidCreate(() => {
				this.loadskylineIgnore()
			}),
			fileWatcher.onDidDelete(() => {
				this.loadskylineIgnore()
			}),
		)

		// Add fileWatcher itself to disposables
		this.disposables.push(fileWatcher)
	}

	/**
	 * Load custom patterns from .skylineignore if it exists.
	 * Supports "!include <filename>" to load additional ignore patterns from other files.
	 */
	private async loadskylineIgnore(): Promise<void> {
		try {
			// Reset ignore instance to prevent duplicate patterns
			this.ignoreInstance = ignore()
			const ignorePath = path.join(this.cwd, ".skylineignore")
			if (await fileExistsAtPath(ignorePath)) {
				const content = await fs.readFile(ignorePath, "utf8")
				this.skylineIgnoreContent = content
				await this.processIgnoreContent(content)
				this.ignoreInstance.add(".skylineignore")
			} else {
				this.skylineIgnoreContent = undefined
			}
		} catch (error) {
			// Should never happen: reading file failed even though it exists
			console.error("Unexpected error loading .skylineignore:", error)
		}
	}

	/**
	 * Process ignore content and apply all ignore patterns
	 */
	private async processIgnoreContent(content: string): Promise<void> {
		// Optimization: first check if there are any !include directives
		if (!content.includes("!include ")) {
			this.ignoreInstance.add(content)
			return
		}

		// Process !include directives
		const combinedContent = await this.processskylineIgnoreIncludes(content)
		this.ignoreInstance.add(combinedContent)
	}

	/**
	 * Process !include directives and combine all included file contents
	 */
	private async processskylineIgnoreIncludes(content: string): Promise<string> {
		let combinedContent = ""
		const lines = content.split(/\r?\n/)

		for (const line of lines) {
			const trimmedLine = line.trim()

			if (!trimmedLine.startsWith("!include ")) {
				combinedContent += "\n" + line
				continue
			}

			// Process !include directive
			const includedContent = await this.readIncludedFile(trimmedLine)
			if (includedContent) {
				combinedContent += "\n" + includedContent
			}
		}

		return combinedContent
	}

	/**
	 * Read content from an included file specified by !include directive
	 */
	private async readIncludedFile(includeLine: string): Promise<string | null> {
		const includePath = includeLine.substring("!include ".length).trim()
		const resolvedIncludePath = path.join(this.cwd, includePath)

		if (!(await fileExistsAtPath(resolvedIncludePath))) {
			console.debug(`[skylineIgnore] Included file not found: ${resolvedIncludePath}`)
			return null
		}

		return await fs.readFile(resolvedIncludePath, "utf8")
	}

	/**
	 * Check if a file should be accessible to the LLM
	 * @param filePath - Path to check (relative to cwd)
	 * @returns true if file is accessible, false if ignored
	 */
	validateAccess(filePath: string): boolean {
		// Always allow access if .skylineignore does not exist
		if (!this.skylineIgnoreContent) {
			return true
		}
		try {
			// Normalize path to be relative to cwd and use forward slashes
			const absolutePath = path.resolve(this.cwd, filePath)
			const relativePath = path.relative(this.cwd, absolutePath).toPosix()

			// Ignore expects paths to be path.relative()'d
			return !this.ignoreInstance.ignores(relativePath)
		} catch (error) {
			// console.error(`Error validating access for ${filePath}:`, error)
			// Ignore is designed to work with relative file paths, so will throw error for paths outside cwd. We are allowing access to all files outside cwd.
			return true
		}
	}

	/**
	 * Check if a terminal command should be allowed to execute based on file access patterns
	 * @param command - Terminal command to validate
	 * @returns path of file that is being accessed if it is being accessed, undefined if command is allowed
	 */
	validateCommand(command: string): string | undefined {
		// Always allow if no .skylineignore exists
		if (!this.skylineIgnoreContent) {
			return undefined
		}

		// Split command into parts and get the base command
		const parts = command.trim().split(/\s+/)
		const baseCommand = parts[0].toLowerCase()

		// Commands that read file contents
		const fileReadingCommands = [
			// Unix commands
			"cat",
			"less",
			"more",
			"head",
			"tail",
			"grep",
			"awk",
			"sed",
			// PowerShell commands and aliases
			"get-content",
			"gc",
			"type",
			"select-string",
			"sls",
		]

		if (fileReadingCommands.includes(baseCommand)) {
			// Check each argument that could be a file path
			for (let i = 1; i < parts.length; i++) {
				const arg = parts[i]
				// Skip command flags/options (both Unix and PowerShell style)
				if (arg.startsWith("-") || arg.startsWith("/")) {
					continue
				}
				// Ignore PowerShell parameter names
				if (arg.includes(":")) {
					continue
				}
				// Validate file access
				if (!this.validateAccess(arg)) {
					return arg
				}
			}
		}

		return undefined
	}

	/**
	 * Filter an array of paths, removing those that should be ignored
	 * @param paths - Array of paths to filter (relative to cwd)
	 * @returns Array of allowed paths
	 */
	filterPaths(paths: string[]): string[] {
		try {
			return paths
				.map((p) => ({
					path: p,
					allowed: this.validateAccess(p),
				}))
				.filter((x) => x.allowed)
				.map((x) => x.path)
		} catch (error) {
			console.error("Error filtering paths:", error)
			return [] // Fail closed for security
		}
	}

	/**
	 * Clean up resources when the controller is no longer needed
	 */
	dispose(): void {
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
	}
}
