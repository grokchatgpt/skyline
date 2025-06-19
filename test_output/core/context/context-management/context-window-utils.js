"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_RESULT_LIMITS = void 0;
exports.getContextWindowInfo = getContextWindowInfo;
const openai_1 = require("@api/providers/openai");
/**
 * Tool result size limits to prevent context window overflow
 */
exports.TOOL_RESULT_LIMITS = {
    MAX_TOOL_RESULT_SIZE: 256 * 1024, // 256KB in bytes
    TRUNCATION_SUFFIX: "\n\n===TOOL RESULT OVER THE LIMIT AND CONTENT IS TRUNCATED===",
};
/**
 * Gets context window information for the given API handler
 *
 * @param api The API handler to get context window information for
 * @returns An object containing the raw context window size and the effective max allowed size
 */
function getContextWindowInfo(api) {
    let contextWindow = api.getModel().info.contextWindow || 128000;
    // FIXME: hack to get anyone using openai compatible with deepseek to have the proper context window instead of the default 128k. We need a way for the user to specify the context window for models they input through openai compatible
    // Handle special cases like DeepSeek
    if (api instanceof openai_1.OpenAiHandler && api.getModel().id.toLowerCase().includes("deepseek")) {
        contextWindow = 64000;
    }
    let maxAllowedSize;
    switch (contextWindow) {
        case 64000: // deepseek models
            maxAllowedSize = contextWindow - 27000;
            break;
        case 128000: // most models
            maxAllowedSize = contextWindow - 30000;
            break;
        case 200000: // claude models
            maxAllowedSize = contextWindow - 40000;
            break;
        default:
            maxAllowedSize = Math.max(contextWindow - 40000, contextWindow * 0.8); // for deepseek, 80% of 64k meant only ~10k buffer which was too small and resulted in users getting context window errors.
    }
    return { contextWindow, maxAllowedSize };
}
