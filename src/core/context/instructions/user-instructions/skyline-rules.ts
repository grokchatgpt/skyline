import path from "path"
import { ensureRulesDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import { fileExistsAtPath, isDirectory, readDirectory } from "@utils/fs"
import { formatResponse } from "@core/prompts/responses"
import fs from "fs/promises"
import { skylineRulesToggles } from "@shared/skyline-rules"
import { getGlobalState, getWorkspaceState, updateGlobalState, updateWorkspaceState } from "@core/storage/state"
import * as vscode from "vscode"
import { synchronizeRuleToggles, getRuleFilesTotalContent } from "@core/context/instructions/user-instructions/rule-helpers"

export const getGlobalskylineRules = async (globalskylineRulesFilePath: string, toggles: skylineRulesToggles) => {
	if (await fileExistsAtPath(globalskylineRulesFilePath)) {
		if (await isDirectory(globalskylineRulesFilePath)) {
			try {
				const rulesFilePaths = await readDirectory(globalskylineRulesFilePath)
				const rulesFilesTotalContent = await getRuleFilesTotalContent(rulesFilePaths, globalskylineRulesFilePath, toggles)
				if (rulesFilesTotalContent) {
					const skylineRulesFileInstructions = formatResponse.skylineRulesGlobalDirectoryInstructions(
						globalskylineRulesFilePath,
						rulesFilesTotalContent,
					)
					return skylineRulesFileInstructions
				}
			} catch {
				console.error(`Failed to read .skylinerules directory at ${globalskylineRulesFilePath}`)
			}
		} else {
			console.error(`${globalskylineRulesFilePath} is not a directory`)
			return undefined
		}
	}

	return undefined
}

export const getLocalskylineRules = async (cwd: string, toggles: skylineRulesToggles) => {
	const skylineRulesFilePath = path.resolve(cwd, GlobalFileNames.skylineRules)

	let skylineRulesFileInstructions: string | undefined

	if (await fileExistsAtPath(skylineRulesFilePath)) {
		if (await isDirectory(skylineRulesFilePath)) {
			try {
				const rulesFilePaths = await readDirectory(skylineRulesFilePath, [[".skylinerules", "workflows"]])

				const rulesFilesTotalContent = await getRuleFilesTotalContent(rulesFilePaths, cwd, toggles)
				if (rulesFilesTotalContent) {
					skylineRulesFileInstructions = formatResponse.skylineRulesLocalDirectoryInstructions(
						cwd,
						rulesFilesTotalContent,
					)
				}
			} catch {
				console.error(`Failed to read .skylinerules directory at ${skylineRulesFilePath}`)
			}
		} else {
			try {
				if (skylineRulesFilePath in toggles && toggles[skylineRulesFilePath] !== false) {
					const ruleFileContent = (await fs.readFile(skylineRulesFilePath, "utf8")).trim()
					if (ruleFileContent) {
						skylineRulesFileInstructions = formatResponse.skylineRulesLocalFileInstructions(cwd, ruleFileContent)
					}
				}
			} catch {
				console.error(`Failed to read .skylinerules file at ${skylineRulesFilePath}`)
			}
		}
	}

	return skylineRulesFileInstructions
}

export async function refreshskylineRulesToggles(
	context: vscode.ExtensionContext,
	workingDirectory: string,
): Promise<{
	globalToggles: skylineRulesToggles
	localToggles: skylineRulesToggles
}> {
	// Global toggles
	const globalskylineRulesToggles = ((await getGlobalState(context, "globalskylineRulesToggles")) as skylineRulesToggles) || {}
	const globalskylineRulesFilePath = await ensureRulesDirectoryExists()
	const updatedGlobalToggles = await synchronizeRuleToggles(globalskylineRulesFilePath, globalskylineRulesToggles)
	await updateGlobalState(context, "globalskylineRulesToggles", updatedGlobalToggles)

	// Local toggles
	const localskylineRulesToggles = ((await getWorkspaceState(context, "localskylineRulesToggles")) as skylineRulesToggles) || {}
	const localskylineRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.skylineRules)
	const updatedLocalToggles = await synchronizeRuleToggles(localskylineRulesFilePath, localskylineRulesToggles, "", [
		[".skylinerules", "workflows"],
	])
	await updateWorkspaceState(context, "localskylineRulesToggles", updatedLocalToggles)

	return {
		globalToggles: updatedGlobalToggles,
		localToggles: updatedLocalToggles,
	}
}
