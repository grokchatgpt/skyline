/**
 * JIT Instruction Manager
 * 
 * Handles Just-In-Time instruction injection and cleaning for memory management
 */

const fs = require('fs');
const path = require('path');
const { countTokens } = require(path.join(process.cwd(), 'services/message-utils/count-tokens'));

class JITInstructionManager {
  constructor(config, maxWindowSize, systemPrompt) {
    this.config = config;
    this.maxWindowSize = maxWindowSize;
    this.systemPrompt = systemPrompt;
    
    // JIT instruction content will be loaded dynamically based on message source
    this.jitInstructionContent = null;
    this.lastLoadedFile = null;
  }

  /**
   * Load JIT instruction content based on message source (internal vs external)
   * @param {array} messages - Messages array to check source
   * @returns {string} - Loaded JIT instruction content
   */
  _loadJITInstructionContent(messages = []) {
    if (!this.config.JITinstruction) {
      return null;
    }

    // Determine file based on message source (same logic as TWP system prompt)
    let promptFile = 'data/config/prompts/tokens_internal.md'; // Default for internal flows
    
    // Check if any message has source === 'api'
    const hasApiSource = messages.some(msg => msg.source === 'api');
    
    if (hasApiSource) {
      promptFile = this.config.JITinstruction.promptFile || 'data/config/prompts/tokens.md'; // External flows
      console.log(`[JITInstructionManager] API source detected, using external tokens file`);
    } else {
      console.log(`[JITInstructionManager] Non-API source detected, using internal tokens file`);
    }

    // Only reload if file changed
    if (promptFile === this.lastLoadedFile && this.jitInstructionContent) {
      return this.jitInstructionContent;
    }

    try {
      this.jitInstructionContent = fs.readFileSync(
        path.join(process.cwd(), promptFile),
        'utf8'
      );
      this.lastLoadedFile = promptFile;
      console.log(`[JITInstructionManager] Loaded JIT instruction from ${promptFile}`);
      return this.jitInstructionContent;
    } catch (err) {
      console.error(`FATAL [JITInstructionManager] Could not load JIT instruction: ${err.message}`);
      process.exit(1);
    }
  }

  /**
   * Update window usage with FINAL token count and handle JIT instructions
   * @param {array} windowedMessages - Array of FINAL windowed messages
   * @param {object} conversationState - Conversation state object
   * @param {string} conversationId - Conversation ID for logging
   * @param {string} botType - Bot type for token counting  
   * @returns {array} - Modified windowed messages with accurate percentages
   */
  updateWindowUsageWithFinalCount(windowedMessages, conversationState, conversationId, botType = 'anthropicapi') {
    if (!conversationState) return windowedMessages;
    
    let modifiedMessages = [...windowedMessages];
    
    // Clean previous JIT instructions if state is active
    if (conversationState.jitInstructionActive) {
      modifiedMessages = this.cleanJITInstructions(modifiedMessages, conversationId);
      conversationState.jitInstructionActive = false;
    }
    
    // Find latest user message
    const latestUserIndex = modifiedMessages.map(m => m.role).lastIndexOf('user');
    if (latestUserIndex === -1) return modifiedMessages;
    
    const userMessage = modifiedMessages[latestUserIndex];
    
    // COUNT TOKENS ON CURRENT CONVERSATION WINDOW
    const systemPromptTokens = countTokens(this.systemPrompt, botType);
    const messagesTokens = modifiedMessages.reduce((sum, msg) => {
      // Extract actual text content matching CMS logic exactly
      if (typeof msg.content === 'string') {
        return sum + countTokens(msg.content, botType);
      } else if (Array.isArray(msg.content)) {
        let msgTokens = 0;
        for (const item of msg.content) {
          if (item && item.content) {
            msgTokens += countTokens(item.content, botType);
          }
        }
        return sum + msgTokens;
      } else {
        return sum; // Return 0 for unknown formats like CMS does
      }
    }, 0);
    const totalTokens = systemPromptTokens + messagesTokens;
    
    // Calculate ACCURATE percentage
    const percentage = Math.round((totalTokens / this.maxWindowSize) * 100);
    
    console.log(`[JITInstructionManager] TOKEN COUNT: system=${systemPromptTokens}, messages=${messagesTokens}, total=${totalTokens}/${this.maxWindowSize} (${percentage}%)`);
    
    // Load JIT instruction content based on message source
    this.jitInstructionContent = this._loadJITInstructionContent(modifiedMessages);
    
    // Check if JIT instruction should be triggered by threshold
    const shouldTriggerJIT = this.config.JITinstruction && 
        percentage >= this.config.JITinstruction.threshold && 
        this.jitInstructionContent;
    
    // Check if user message needs truncation
    const availableTokens = this.maxWindowSize - systemPromptTokens - (this.config.userMessageTruncation?.tokenBuffer || 1600);
    const otherMessagesTokens = messagesTokens - countTokens(userMessage.content, botType);
    const availableForUserMessage = availableTokens - otherMessagesTokens;
    const userMessageTokens = countTokens(userMessage.content, botType);
    const needsTruncation = userMessageTokens > availableForUserMessage;
    
    if (shouldTriggerJIT) {
      // NEW TWP MCP FLOW: Always replace user message with JIT, preserve original as LastUserMessage
      const jitTokens = countTokens(this.jitInstructionContent, botType);
      
      // Preserve the original user message as LastUserMessage metadata
      conversationState.lastUserMessage = {
        content: userMessage.content,
        preservedAt: new Date().toISOString(),
        reason: 'JIT_THRESHOLD_HIT',
        originalTokens: userMessageTokens
      };
      
      // Generate register mapping for Grok-proof message selection
      const registerMapping = this.generateRegisterMapping(conversationState, botType);
      
      // Replace user message entirely with JIT instructions + register mapping
      const enhancedJITContent = this.jitInstructionContent + registerMapping;
      modifiedMessages[latestUserIndex] = { 
        ...userMessage, 
        content: enhancedJITContent 
      };
      
      conversationState.jitInstructionActive = true;
      
      const enhancedJITTokens = countTokens(enhancedJITContent, botType);
      console.log(`[JITInstructionManager] TWP MCP FLOW: Preserved LastUserMessage (${userMessageTokens} tokens) and replaced with enhanced JIT + register mapping (${enhancedJITTokens} tokens)`);
      
      this.logJITOperation(conversationId, 'REPLACE_WITH_PRESERVATION', {
        originalContent: userMessage.content.substring(0, 100) + '...',
        newContent: this.jitInstructionContent.substring(0, 100) + '...',
        preservedTokens: userMessageTokens,
        jitTokens: jitTokens,
        reason: 'TWP MCP enhancement - preserve original for later restoration'
      });
      
      // Update window usage pattern if present
      const pattern = this.config.JITinstruction?.windowUsagePattern;
      if (pattern && pattern.detectionText && this.jitInstructionContent.includes(pattern.detectionText)) {
        const newContent = this.applyWindowUsageTransform(this.jitInstructionContent, percentage);
        modifiedMessages[latestUserIndex] = { ...modifiedMessages[latestUserIndex], content: newContent };
      }
    } else if (needsTruncation) {
      // User message needs truncation but no JIT needed
      const {messages: truncatedMessages} = this.truncateUserMessageIfNeeded(modifiedMessages, conversationId, botType);
      modifiedMessages = truncatedMessages;
      
      console.log(`[JITInstructionManager] USER MESSAGE TRUNCATED: no JIT needed`);
    } else {
      // No JIT needed and no truncation needed - update window usage if pattern exists
      const pattern = this.config.JITinstruction?.windowUsagePattern;
      if (pattern && pattern.detectionText && userMessage.content && userMessage.content.includes(pattern.detectionText)) {
        const newContent = this.applyWindowUsageTransform(userMessage.content, percentage);
        modifiedMessages[latestUserIndex] = { ...userMessage, content: newContent };
        
        console.log(`[JITInstructionManager] Window usage updated: ${totalTokens}/${this.maxWindowSize} tokens (${percentage}%)`);
      }
    }
    
    return modifiedMessages;
  }

  /**
   * Truncate latest user message if it would exceed token window limits
   * @param {array} windowedMessages - Array of windowed messages
   * @param {string} conversationId - Conversation ID for logging
   * @param {string} botType - Bot type for token counting
   * @returns {object} - {messages: array, wasTruncated: boolean}
   */
  truncateUserMessageIfNeeded(windowedMessages, conversationId, botType = 'anthropicapi') {
    const truncationConfig = this.config.userMessageTruncation;
    if (!truncationConfig || !truncationConfig.enabled) {
      return { messages: windowedMessages, wasTruncated: false };
    }

    const modifiedMessages = [...windowedMessages];
    
    // Find latest user message
    const latestUserIndex = modifiedMessages.map(m => m.role).lastIndexOf('user');
    if (latestUserIndex === -1) return { messages: modifiedMessages, wasTruncated: false };
    
    const userMessage = modifiedMessages[latestUserIndex];
    if (!userMessage.content || typeof userMessage.content !== 'string') {
      return { messages: modifiedMessages, wasTruncated: false };
    }

    // Calculate available token budget
    const systemPromptTokens = countTokens(this.systemPrompt, botType);
    const tokenBuffer = truncationConfig.tokenBuffer || 1600;
    const availableForMessages = this.maxWindowSize - systemPromptTokens - tokenBuffer;
    
    // Calculate tokens for all messages except the latest user message
    let otherMessagesTokens = 0;
    for (let i = 0; i < modifiedMessages.length; i++) {
      if (i !== latestUserIndex) {
        const msg = modifiedMessages[i];
        if (typeof msg.content === 'string') {
          otherMessagesTokens += countTokens(msg.content, botType);
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item && item.content) {
              otherMessagesTokens += countTokens(item.content, botType);
            }
          }
        }
      }
    }
    
    // Calculate available tokens for the latest user message
    const availableForUserMessage = availableForMessages - otherMessagesTokens;
    const currentUserMessageTokens = countTokens(userMessage.content, botType);
    
    console.log(`[JITInstructionManager] Token budget check: userMsg=${currentUserMessageTokens}, available=${availableForUserMessage}, others=${otherMessagesTokens}`);
    
    // Check if truncation is needed
    if (currentUserMessageTokens <= availableForUserMessage) {
      return { messages: modifiedMessages, wasTruncated: false }; // No truncation needed
    }
    
    // Perform truncation
    const originalContent = userMessage.content;
    const truncationIndicator = truncationConfig.truncationIndicator || "...[message truncated to fit token window]";
    const preserveFromStart = truncationConfig.preserveFromStart !== false; // Default to true
    
    let truncatedContent;
    if (preserveFromStart) {
      // Truncate from the end, preserving the beginning
      // Binary search to find the right length that fits
      let low = 0;
      let high = originalContent.length;
      let bestLength = 0;
      
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const testContent = originalContent.substring(0, mid) + truncationIndicator;
        const testTokens = countTokens(testContent, botType);
        
        if (testTokens <= availableForUserMessage) {
          bestLength = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      
      truncatedContent = originalContent.substring(0, bestLength) + truncationIndicator;
    } else {
      // Truncate from the beginning, preserving the end
      let low = 0;
      let high = originalContent.length;
      let bestStart = originalContent.length;
      
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const testContent = truncationIndicator + originalContent.substring(mid);
        const testTokens = countTokens(testContent, botType);
        
        if (testTokens <= availableForUserMessage) {
          bestStart = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      
      truncatedContent = truncationIndicator + originalContent.substring(bestStart);
    }
    
    // Update the message
    modifiedMessages[latestUserIndex] = { ...userMessage, content: truncatedContent };
    
    // Log the truncation operation
    this.logTruncationOperation(conversationId, {
      originalLength: originalContent.length,
      truncatedLength: truncatedContent.length,
      originalTokens: currentUserMessageTokens,
      truncatedTokens: countTokens(truncatedContent, botType),
      availableTokens: availableForUserMessage,
      tokensSaved: currentUserMessageTokens - countTokens(truncatedContent, botType),
      preserveFromStart: preserveFromStart
    });
    
    console.log(`[JITInstructionManager] User message truncated: ${currentUserMessageTokens} → ${countTokens(truncatedContent, botType)} tokens`);
    
    return { messages: modifiedMessages, wasTruncated: true };
  }

  /**
   * Generate register mapping for Grok-proof message selection
   * @param {object} conversationState - Conversation state with registers
   * @param {string} botType - Bot type for token counting
   * @returns {string} - Formatted register mapping
   */
  generateRegisterMapping(conversationState, botType = 'anthropicapi') {
    if (!conversationState || !conversationState.registers || conversationState.registers.length === 0) {
      return '\n\n## CURRENT MESSAGE REGISTER MAP\n(No registers available)\n';
    }
    
    let mapping = '\n\n## CURRENT MESSAGE REGISTER MAP\n';
    
    conversationState.registers.forEach((register, index) => {
      const tokens = countTokens(register.content, botType);
      // Take first 25 words, same as TWP log format but with word limit instead of character limit
      const words = register.content.split(/\s+/).slice(0, 25).join(' ');
      const preview = words.length < register.content.length ? words + '...' : words;
      
      mapping += `[${index + 1}] ${register.role} (${tokens} tokens): ${preview}\n`;
    });
    
    mapping += '\nUse these exact numbers in your recache_message_array tool. Each number corresponds to the message content shown above.\n';
    
    return mapping;
  }

  /**
   * Apply window usage transformation using configurable patterns
   * @param {string} content - Message content to transform
   * @param {number} percentage - Percentage to insert
   * @returns {string} - Transformed content
   */
  applyWindowUsageTransform(content, percentage) {
    const pattern = this.config.JITinstruction?.windowUsagePattern;
    if (!pattern || !pattern.searchRegex || !pattern.replaceTemplate) {
      console.error(`FATAL [JITInstructionManager] Missing windowUsagePattern configuration`);
      process.exit(1);
    }
    
    try {
      const searchRegex = new RegExp(pattern.searchRegex, 'g');
      const replaceText = pattern.replaceTemplate.replace('{percentage}', percentage);
      return content.replace(searchRegex, replaceText);
    } catch (err) {
      console.error(`FATAL [JITInstructionManager] Invalid regex pattern in config: ${err.message}`);
      process.exit(1);
    }
  }

  /**
   * Inject JIT instruction into latest user message
   * @param {array} windowedMessages - Array of windowed messages
   * @param {object} conversationState - Conversation state object
   * @param {string} conversationId - Conversation ID
   * @param {number} latestUserIndex - Index of latest user message
   * @returns {array} - Modified windowed messages
   */
  injectJITInstruction(windowedMessages, conversationState, conversationId, latestUserIndex) {
    if (!conversationState || !this.jitInstructionContent) return windowedMessages;
    
    const modifiedMessages = [...windowedMessages];
    const userMessage = modifiedMessages[latestUserIndex];
    
    // Prepend JIT instruction to user message content
    const newContent = this.jitInstructionContent + userMessage.content;
    modifiedMessages[latestUserIndex] = { ...userMessage, content: newContent };
    
    // Set state to active for next turn cleaning
    conversationState.jitInstructionActive = true;
    
    // Log JIT instruction addition
    this.logJITOperation(conversationId, 'INJECT', {
      originalContent: userMessage.content.substring(0, 100) + '...',
      newContent: newContent.substring(0, 100) + '...'
    });
    
    console.log(`[JITInstructionManager] JIT instruction injected for conversation ${conversationId}`);
    
    return modifiedMessages;
  }

  /**
   * Clean JIT instructions from messages
   * @param {array} windowedMessages - Array of windowed messages
   * @param {string} conversationId - Conversation ID
   * @returns {array} - Cleaned windowed messages
   */
  cleanJITInstructions(windowedMessages, conversationId) {
    if (!this.config.JITinstruction || !this.jitInstructionContent) return windowedMessages;
    
    let modifiedMessages = [...windowedMessages];
    let cleaned = false;
    
    // Clean exact JIT instruction content from user messages
    for (let i = 0; i < modifiedMessages.length; i++) {
      const message = modifiedMessages[i];
      if (message.role === 'user' && message.content && message.content.includes(this.jitInstructionContent)) {
        const originalContent = message.content;
        const cleanedContent = message.content.replace(this.jitInstructionContent, '');
        modifiedMessages[i] = { ...message, content: cleanedContent };
        
        this.logJITOperation(conversationId, 'CLEAN_USER', {
          messageIndex: i,
          originalContent: originalContent.substring(0, 100) + '...',
          cleanedContent: cleanedContent.substring(0, 100) + '...'
        });
        
        cleaned = true;
      }
    }
    
    // Clean assistant messages using config replacement pairs
    const latestAssistantIndex = modifiedMessages.map(m => m.role).lastIndexOf('assistant');
    if (latestAssistantIndex !== -1 && this.config.JITinstruction.assistantCleaning) {
      const assistantMessage = modifiedMessages[latestAssistantIndex];
      let cleanedContent = assistantMessage.content;
      const originalContent = cleanedContent;
      
      for (const replacement of this.config.JITinstruction.assistantCleaning) {
        const flags = replacement.caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(replacement.search, flags);
        cleanedContent = cleanedContent.replace(regex, replacement.replace);
      }
      
      if (cleanedContent !== originalContent) {
        modifiedMessages[latestAssistantIndex] = { ...assistantMessage, content: cleanedContent };
        
        this.logJITOperation(conversationId, 'CLEAN_ASSISTANT', {
          messageIndex: latestAssistantIndex,
          originalContent: originalContent.substring(0, 100) + '...',
          cleanedContent: cleanedContent.substring(0, 100) + '...'
        });
        
        cleaned = true;
      }
    }
    
    if (cleaned) {
      console.log(`[JITInstructionManager] JIT instructions cleaned for conversation ${conversationId}`);
    }
    
    return modifiedMessages;
  }

  /**
   * Log JIT instruction operations
   * @param {string} conversationId - Conversation ID
   * @param {string} operation - Operation type (INJECT, CLEAN_USER, CLEAN_ASSISTANT)
   * @param {object} details - Operation details
   */
  logJITOperation(conversationId, operation, details) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      let logEntry = `[${timestamp}] JIT ${operation} for ${conversationId}\n`;
      
      if (details.messageIndex !== undefined) {
        logEntry += `  Message Index: ${details.messageIndex}\n`;
      }
      
      if (details.originalContent) {
        logEntry += `  Original: ${details.originalContent}\n`;
      }
      
      if (details.newContent) {
        logEntry += `  New: ${details.newContent}\n`;
      }
      
      if (details.cleanedContent) {
        logEntry += `  Cleaned: ${details.cleanedContent}\n`;
      }
      
      logEntry += '\n';
      
      // Append to log file synchronously
      fs.appendFileSync(logFile, logEntry);
    } catch (err) {
      console.error(`[JITInstructionManager] Error logging JIT operation: ${err.message}`);
    }
  }

  /**
   * Find previous assistant message before the given user message index
   * @param {array} windowedMessages - Array of windowed messages
   * @param {number} userIndex - Index of user message
   * @returns {number} - Index of previous assistant message, or -1 if not found
   */
  findPreviousAssistantMessage(windowedMessages, userIndex) {
    for (let i = userIndex - 1; i >= 0; i--) {
      if (windowedMessages[i].role === 'assistant') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Truncate previous assistant message to free up tokens for JIT instruction
   * @param {array} windowedMessages - Array of windowed messages
   * @param {number} assistantIndex - Index of assistant message to truncate
   * @param {number} tokensToFree - Number of tokens to free up
   * @param {string} botType - Bot type for token counting
   * @returns {array} - Modified windowed messages with truncated assistant message
   */
  truncatePreviousAssistantMessage(windowedMessages, assistantIndex, tokensToFree, botType) {
    const modifiedMessages = [...windowedMessages];
    const assistantMessage = modifiedMessages[assistantIndex];
    
    if (!assistantMessage.content || typeof assistantMessage.content !== 'string') {
      return modifiedMessages;
    }
    
    const originalContent = assistantMessage.content;
    const originalTokens = countTokens(originalContent, botType);
    const targetTokens = Math.max(100, originalTokens - tokensToFree); // Keep at least 100 tokens
    
    // Binary search to find the right truncation point
    let low = 0;
    let high = originalContent.length;
    let bestLength = 0;
    const truncationIndicator = "\n\n[Response truncated to preserve JIT instruction...]";
    
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const testContent = originalContent.substring(0, mid) + truncationIndicator;
      const testTokens = countTokens(testContent, botType);
      
      if (testTokens <= targetTokens) {
        bestLength = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    
    const truncatedContent = originalContent.substring(0, bestLength) + truncationIndicator;
    const finalTokens = countTokens(truncatedContent, botType);
    const tokensSaved = originalTokens - finalTokens;
    
    modifiedMessages[assistantIndex] = { ...assistantMessage, content: truncatedContent };
    
    console.log(`[JITInstructionManager] Truncated assistant message: ${originalTokens} → ${finalTokens} tokens (saved ${tokensSaved})`);
    
    return modifiedMessages;
  }

  /**
   * Log user message truncation operations
   * @param {string} conversationId - Conversation ID
   * @param {object} details - Truncation details
   */
  logTruncationOperation(conversationId, details) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      let logEntry = `[${timestamp}] USER_MESSAGE_TRUNCATED for ${conversationId}\n`;
      
      if (details.originalLength !== undefined) {
        logEntry += `  Original Length: ${details.originalLength} chars\n`;
      }
      
      if (details.truncatedLength !== undefined) {
        logEntry += `  Truncated Length: ${details.truncatedLength} chars\n`;
      }
      
      if (details.originalTokens !== undefined) {
        logEntry += `  Original Tokens: ${details.originalTokens}\n`;
      }
      
      if (details.truncatedTokens !== undefined) {
        logEntry += `  Truncated Tokens: ${details.truncatedTokens}\n`;
      }
      
      if (details.availableTokens !== undefined) {
        logEntry += `  Available Token Budget: ${details.availableTokens}\n`;
      }
      
      if (details.tokensSaved !== undefined) {
        logEntry += `  Tokens Saved: ${details.tokensSaved}\n`;
      }
      
      if (details.preserveFromStart !== undefined) {
        logEntry += `  Preserve From Start: ${details.preserveFromStart}\n`;
      }
      
      logEntry += '\n';
      
      // Append to log file synchronously
      fs.appendFileSync(logFile, logEntry);
      
      console.log(`[JITInstructionManager] Logged truncation operation for ${conversationId}`);
    } catch (err) {
      console.error(`[JITInstructionManager] Error logging truncation operation: ${err.message}`);
    }
  }
}

module.exports = JITInstructionManager;
