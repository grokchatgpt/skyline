/**
 * Token Window Manager
 * 
 * Simplified coordinator for cache-friendly restore and newchat commands.
 * Removes old operations and gaming - focuses on window boundaries.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const JITInstructionManager = require('./jitinstruction');
const { countTokens } = require(path.join(process.cwd(), 'services/message-utils/count-tokens'));

class TokenWindowManager {
  
  constructor(config = {}) {
    // Load configuration
    this.config = config;
    
    if (!this.config || Object.keys(this.config).length === 0) {
      try {
        this.config = require(path.join(process.cwd(), 'data/config/token-window.json'));
      } catch (err) {
        console.error(`FATAL: Failed to load token-window.json config: ${err.message}`);
        process.exit(1);
      }
    }
    
    this.MAX_WINDOW_SIZE = this.config.maxWindowSize || 128000;
    
    if (!this.MAX_WINDOW_SIZE) {
      console.log(`\nFATAL: TWP cannot use 0 MAX WINDOW SIZE\n`);
      process.exit(1);
    }
    
    // Enhanced conversation state tracking
    this.conversationStates = new Map(); // conversationId -> enhanced state object
    
    // TWP system prompt will be loaded live on each request from twp.txt
    this.twpSystemPrompt = null;
    
    // Initialize JIT Instruction Manager
    this.jitManager = new JITInstructionManager(this.config, this.MAX_WINDOW_SIZE, this.twpSystemPrompt);
    
    this._logTrace(`Initialized with MAX_WINDOW_SIZE=${this.MAX_WINDOW_SIZE}`);

    // Load oversized message handling config
    this.oversizedConfig = this.config.oversizedMessageHandling || {
      enabled: false,
      thresholdPercent: 25,
      truncateToTokens: 100,
      tempDirectory: "data/temp",
      instructionTemplate: "[TRUNCATED - {originalTokens} tokens saved to {filepath}. Use grep to search for patterns, or 'tail -50 {filepath}' to see final output (sed, awk, wc, head and many other tools can be used instead of read_file to avoid subsequent truncation)]"
    };
    
    this.OVERSIZED_THRESHOLD = Math.floor(this.MAX_WINDOW_SIZE * (this.oversizedConfig.thresholdPercent / 100));
    
    this._logTrace(`Oversized message handling: ${this.oversizedConfig.enabled ? 'enabled' : 'disabled'}, threshold: ${this.OVERSIZED_THRESHOLD} tokens`);

  }

  /**
   * Process a client request with apiRequest data
   * Main entry point from the plugin
   * 
   * @param {string} conversationId - Conversation ID
   * @param {object} apiRequest - The API request containing messages array
   * @returns {object} - Transformed data for the plugin
   */
  processClientRequest(conversationId, apiRequest) {
    return this.processClientRequestWithBotId(conversationId, apiRequest, null);
  }

  /**
   * Process a client request with apiRequest data and bot ID for shared chat role enhancement
   * 
   * @param {string} conversationId - Conversation ID
   * @param {object} apiRequest - The API request containing messages array
   * @param {string} botId - Bot ID for shared chat role enhancement (optional)
   * @returns {object} - Transformed data for the plugin
   */
  processClientRequestWithBotId(conversationId, apiRequest, botId = null) {
    this._logTrace(`Processing client request for conversation ${conversationId}${botId ? ` (bot: ${botId})` : ''}`);
    
    if (!conversationId) {
      const error = new Error('FATAL: conversationId is required for processClientRequest');
      console.error(error.stack);
      process.exit(1);
    }
    
    if (!apiRequest || !apiRequest.messages || !Array.isArray(apiRequest.messages)) {
      const error = new Error('FATAL: apiRequest with messages array is required');
      console.error(error.stack);
      process.exit(1);
    }
    
    // Load system prompt based on conversation originator early in the process
    this._loadLiveSystemPrompt(conversationId);
    
    // Get or create conversation state
    let state = this.conversationStates.get(conversationId);
    if (!state) {
      state = this._createNewConversationState(conversationId);
      this.conversationStates.set(conversationId, state);
      this._logTrace(`Created new conversation state for ${conversationId}`);
    }
    
    // Save current breakpoint before any operations
    const oldBreakpoint = state.cacheBreakpoint;
    
    // Check for MCP tool results in user messages and swap with LastUserMessage
    this._detectAndSwapMCPToolResult(conversationId, apiRequest.messages);
    
    // Check for restore command in the latest assistant message (both inline and MCP)
    const latestAssistantMessage = [...apiRequest.messages].reverse().find(m => m.role === 'assistant');
    let restoreCommand = null;
    let originalMCPArgs = null;
    
    if (latestAssistantMessage) {
      // Extract text content from array format
      let contentText = '';
      if (Array.isArray(latestAssistantMessage.content)) {
        contentText = latestAssistantMessage.content
          .filter(item => item.role === 'assistant')
          .map(item => item.content)
          .join('');
      } else {
        contentText = latestAssistantMessage.content;
      }
      
      // DETECT but DON'T VALIDATE restore command yet (validation needs current register count)
      const commandResult = this._detectMCPRestoreCommandWithoutValidation(contentText);
      if (commandResult) {
        restoreCommand = commandResult.command;
        originalMCPArgs = commandResult.originalArgs;
        
        if (restoreCommand) {
          if (restoreCommand.type === 'mcp_command') {
            this._logTrace(`Processing MCP restore command`);
          } else if (restoreCommand.type === 'cache_programming') {
            this._logTrace(`Processing cache programming restore command`);
          } else if (restoreCommand.type === 'ultra_simple_recache') {
            this._logTrace(`Processing ultra-simple recache command`);
          } else if (restoreCommand.type === 'recache') {
            this._logTrace(`Processing recache command`);
          } else if (restoreCommand.type === 'mcp_command_error') {
            this._logTrace(`Processing MCP command error`);
          } else {
            this._logTrace(`Processing unknown restore command type: ${restoreCommand.type}`);
          }
          
          // Strip the command from the message content
          const strippedText = this._stripRestoreCommand(contentText);
          
          // Update the content array with stripped text
          if (Array.isArray(latestAssistantMessage.content)) {
            latestAssistantMessage.content = latestAssistantMessage.content.map(item => {
              if (item.type === 'text') {
                return { ...item, text: strippedText };
              }
              return item;
            });
          } else {
            latestAssistantMessage.content = strippedText;
          }
        }
      }
    }
    
    // Create/update registers from messages FIRST
    this._updateRegistersFromMessages(conversationId, apiRequest.messages);
    
    // NOW validate restore command against CURRENT register count
    if (restoreCommand && originalMCPArgs && restoreCommand.type !== 'mcp_command_error') {
      const validationResult = this._validateMCPRecacheArgs(originalMCPArgs, restoreCommand);
      if (validationResult.error) {
        console.log(`[TokenWindowManager] MCP command validation failed: ${validationResult.error}`);
        this._handleMCPError(conversationId, validationResult.error, originalMCPArgs);
        
        // Convert to error command
        restoreCommand = {
          type: 'mcp_command_error',
          error: validationResult.error,
          originalArgs: originalMCPArgs
        };
      }
    }
    
    // Apply restore command AFTER validation against current registers
    if (restoreCommand) {
      this._applyRestoreToState(conversationId, restoreCommand, latestAssistantMessage, apiRequest.messages);
    }
    
    // Update cache breakpoint and calculate cache stats
    this._updateCacheBreakpoint(conversationId, oldBreakpoint, restoreCommand);
    
    // Generate token window display with bot ID for shared chat role enhancement
    return this.getTokenWindowForTransformWithBotId(conversationId, botId);
  }

  /**
   * Process a single Skynet message
   * Main entry point from the plugin
   * 
   * @param {Message} message - Message to process
   * @returns {object} - Object with windowedMessages and systemPrompt
   */
  processMessage(message) {
    this._logTrace(`Processing message ${message.id}`);
    
    if (!message.id) {
      const error = new Error('FATAL: message.id is required for processMessage');
      console.error(error.stack);
      process.exit(1);
    }

    if (!message.content || !Array.isArray(message.content)) {
      const error = new Error(`FATAL: message.content must be an array for token window processing (message ${message.id})`);
      console.error(error.stack);
      process.exit(1);
    }
    
    // Get conversation ID
    let conversationId = message.conversationId;
    
    if (conversationId) {
      this._logTrace(`Using conversation ID from message: ${conversationId}`);
    } else {
      // Fall back to CMS lookup for backward compatibility
      const conversationManager = require(path.join(process.cwd(), 'services/conversation-manager'));
      conversationId = conversationManager.getMessageConversationId(message.id);
      
      if (!conversationId) {
        const error = new Error(`FATAL: Could not find conversation for message ${message.id}`);
        console.error(error.stack);
        process.exit(1);
      }
      
      this._logTrace(`Retrieved conversation ID from CMS: ${conversationId}`);
    }
    
    // Process with the client request method, passing bot ID and content
    return this.processClientRequestWithBotId(
      conversationId,
      { messages: message.content },
      message.destination
    );
  }

  /**
   * Create new enhanced conversation state
   * @param {string} conversationId - Conversation ID
   * @returns {object} - New conversation state
   * @private
   */
  _createNewConversationState(conversationId) {
    return {
      conversationId: conversationId,
      
      // Virtual timeline - what the bot sees as "current reality"
      activeTimeline: [],
      
      // Enhanced registers with virtual/real mapping
      registers: [],
      
      // Restore operation metadata
      restoreHistory: [],
      
      // Current window state
      windowState: {
        startTurn: 1,
        endTurn: null,
        totalMessages: 0
      },
      
      // Message ID tracking
      messageIdCounter: 0,
      realMessageIds: new Map(), // virtualId -> realMessageId
      
      // JIT instruction tracking
      jitInstructionActive: false,
      
      // Cache breakpoint tracking for accurate cache stats
      cacheBreakpoint: 0, // Position of cache breakpoint in message stream
      lastCacheStats: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      
      // Error tracking for window optimization commands
      errors: [], // Array of validation errors
      lastErrorTime: null, // Timestamp of most recent error
      
      // MCP Error Streak Tracking
      errorStreak: 0, // Count of consecutive failed MCP attempts
      lastUserMessageStack: [], // Array of saved LastUserMessage for each error turn
      jitInstructionTurns: [], // Track which turns had JIT instructions
      lastUserMessage: null, // Current preserved LastUserMessage
      
      // Current MCP error for JIT prepending
      currentMCPError: null // Error message to prepend to JIT instructions
    };
  }

  /**
   * Parse recache command from message content
   * Supports simplified `recache_message_array(foundation, {append})` syntax
   * RELAXED: Finds command on any line in the content
   * @param {string} content - Message content
   * @returns {object|null} - Parsed command or null
   * @private
   */
  _parseRestoreCommand(content) {
    if (!content || typeof content !== 'string') {
      return null;
    }
    
    const lines = content.split('\n');
    
    // Look for recache commands on any line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Check for ultra-simple recache syntax: recache_message_array(whatever,he,puts)
      const recacheMatch = line.match(/recache_message_array\s*\(\s*([^)]*)\s*\)/i);
      if (recacheMatch) {
        const parsed = this._parseUltraSimpleRecache(recacheMatch[1].trim());
        if (parsed) {
          this._logTrace(`Found recache command on line ${i + 1}: "${line}"`);
          return parsed;
        } else {
          // Command found but failed validation - log error
          this._logCommandError(this._extractConversationId(), 'PARSE_ERROR', {
            command: line,
            reason: 'Failed recache syntax parsing'
          });
        }
      }
    }
    
    return null;
  }

  /**
   * Parse ultra-simple recache command parameters - whatever the fuck he puts
   * Handles flexible syntax: recache_message_array(whatever,he,puts,9-12,garbage,25)
   * @param {string} paramsString - Everything between parentheses
   * @returns {object|null} - Parsed command or null if invalid
   * @private
   */
  _parseUltraSimpleRecache(paramsString) {
    const conversationId = this._extractConversationId();
    
    console.log(`[TokenWindowManager] ULTRA-SIMPLE RECACHE parsing: "${paramsString}"`);
    
    if (!paramsString || paramsString.trim() === '') {
      console.error(`[TokenWindowManager] RECACHE REJECTED: Empty parameters`);
      return null;
    }
    
    // Split on commas and extract all valid positions with source tracking
    const tokens = paramsString.split(',').map(t => t.trim());
    const positionData = [];
    
    console.log(`[TokenWindowManager] Processing ${tokens.length} tokens: [${tokens.join(', ')}]`);
    
    for (const token of tokens) {
      if (!token) continue; // Skip empty tokens
      
      // Try range first: "9-12"
      const rangeMatch = token.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        for (let i = start; i <= end; i++) {
          positionData.push({ position: i, fromRange: true, rangeToken: token });
        }
        console.log(`[TokenWindowManager] Added range ${start}-${end}: [${Array.from({length: end - start + 1}, (_, i) => start + i).join(', ')}]`);
        continue;
      }
      
      // Try single number: "25"
      const numberMatch = token.match(/(\d+)/);
      if (numberMatch) {
        const num = parseInt(numberMatch[1]);
        positionData.push({ position: num, fromRange: false, individualToken: token });
        console.log(`[TokenWindowManager] Added single number: ${num}`);
        continue;
      }
      
      // Ignore everything else (garbage, "wtf", etc.)
      console.log(`[TokenWindowManager] IGNORED garbage token: "${token}"`);
    }
    
    // Remove duplicates by position and sort, keeping source info
    const uniquePositionMap = new Map();
    for (const data of positionData) {
      if (!uniquePositionMap.has(data.position)) {
        uniquePositionMap.set(data.position, data);
      }
    }
    
    const uniquePositionData = Array.from(uniquePositionMap.values()).sort((a, b) => a.position - b.position);
    const uniquePositions = uniquePositionData.map(data => data.position);
    
    if (uniquePositions.length === 0) {
      console.error(`[TokenWindowManager] RECACHE REJECTED: No valid positions found`);
      return null;
    }
    
    console.log(`[TokenWindowManager] ULTRA-SIMPLE RECACHE complete: ${uniquePositions.length} positions [${uniquePositions.join(', ')}]`);
    
    // Log the command to TWP log file
    this._logCommandUsage(conversationId, 'RECACHE_COMMAND', {
      originalCommand: `recache_message_array(${paramsString})`,
      parsedPositions: uniquePositions.join(','),
      positionCount: uniquePositions.length
    });
    
    return {
      type: 'ultra_simple_recache',
      positions: uniquePositions,
      positionData: uniquePositionData
    };
  }


  /**
   * Parse cache programming command parameters with ULTRA-LAX validation
   * Just extract positions and force proper user/assistant alternating roles
   * @param {string} cacheReadArg - The cache_read argument (e.g., "U1-A8" or "")
   * @param {string} cacheMessagesWriteArg - The cache_messages_write argument (e.g., "U23,A24,U31")
   * @param {string} cacheSystem2WriteArg - The cache_system2_write argument (e.g., "A12" or "")
   * @returns {object|null} - Parsed command or null if invalid
   * @private
   */
  _parseCacheProgrammingCommand(cacheReadArg, cacheMessagesWriteArg, cacheSystem2WriteArg) {
    const conversationId = this._extractConversationId();
    
    console.log(`[TokenWindowManager] ULTRA-LAX parsing: cache_read="${cacheReadArg}", cache_messages_write="${cacheMessagesWriteArg}", cache_system2_write="${cacheSystem2WriteArg}"`);
    
    // Parse cache_read: "U1-AN" format or empty
    let parsedCacheRead = null;
    const cacheReadTrimmed = cacheReadArg.trim();
    
    if (cacheReadTrimmed === '') {
      // Empty cache_read - valid
      parsedCacheRead = { type: 'empty' };
      console.log(`[TokenWindowManager] Cache read: EMPTY`);
    } else {
      // Extract end position from U1-AN format, be forgiving
      const readMatch = cacheReadTrimmed.match(/U1-A(\d+)/);
      if (readMatch) {
        const endPosition = parseInt(readMatch[1]);
        parsedCacheRead = { type: 'range', start: 1, end: endPosition };
        console.log(`[TokenWindowManager] Cache read: U1-A${endPosition}`);
      } else {
        // Fallback: assume empty if can't parse
        parsedCacheRead = { type: 'empty' };
        console.log(`[TokenWindowManager] Cache read: FALLBACK TO EMPTY (couldn't parse "${cacheReadTrimmed}")`);
      }
    }
    
    // Parse cache_messages_write: ULTRA-LAX - extract positions and force roles
    let parsedMessagesWrite = [];
    const messagesWriteTrimmed = cacheMessagesWriteArg.trim();
    
    if (messagesWriteTrimmed === '') {
      // Empty is valid
      parsedMessagesWrite = [];
      console.log(`[TokenWindowManager] Messages write: EMPTY`);
    } else {
      // Extract ALL number positions, ignore U/A prefixes completely
      const messageTokens = messagesWriteTrimmed.split(',').map(t => t.trim());
      const extractedPositions = [];
      
      for (const token of messageTokens) {
        // Extract any number from the token (ignore U/A prefix)
        const numberMatch = token.match(/(\d+)/);
        if (numberMatch) {
          extractedPositions.push(parseInt(numberMatch[1]));
        }
      }
      
      console.log(`[TokenWindowManager] Extracted positions: [${extractedPositions.join(', ')}]`);
      
      // Force alternating user/assistant roles starting with user
      for (let i = 0; i < extractedPositions.length; i++) {
        const forcedRole = i % 2 === 0 ? 'user' : 'assistant';
        parsedMessagesWrite.push({
          role: forcedRole,
          position: extractedPositions[i]
        });
      }
      
      // If we have messages but don't end with user, auto-add next user message
      if (parsedMessagesWrite.length > 0) {
        const lastEntry = parsedMessagesWrite[parsedMessagesWrite.length - 1];
        if (lastEntry.role === 'assistant') {
          // Auto-add the next message as user
          const nextPosition = lastEntry.position + 1;
          parsedMessagesWrite.push({
            role: 'user',
            position: nextPosition
          });
          console.log(`[TokenWindowManager] AUTO-ADDED user message at position ${nextPosition} to end with user`);
        }
      }
      
      console.log(`[TokenWindowManager] Forced roles: ${parsedMessagesWrite.map(entry => `${entry.role === 'user' ? 'U' : 'A'}${entry.position}`).join(', ')}`);
    }
    
    // Parse cache_system2_write: extract position if any
    let parsedSystem2 = null;
    const system2Trimmed = cacheSystem2WriteArg.trim();
    
    if (system2Trimmed === '') {
      parsedSystem2 = { type: 'clear' };
      console.log(`[TokenWindowManager] System2: CLEAR`);
    } else {
      // Extract any number, ignore U/A prefix
      const system2Match = system2Trimmed.match(/(\d+)/);
      if (system2Match) {
        const position = parseInt(system2Match[1]);
        parsedSystem2 = { type: 'promote', role: 'user', position }; // Role doesn't matter for system2
        console.log(`[TokenWindowManager] System2: PROMOTE position ${position}`);
      } else {
        parsedSystem2 = { type: 'clear' };
        console.log(`[TokenWindowManager] System2: FALLBACK TO CLEAR (couldn't parse "${system2Trimmed}")`);
      }
    }
    
    // NO OVERLAP VALIDATION - fuck it, things are already fucked
    
    console.log(`[TokenWindowManager] ULTRA-LAX parsing complete: cache_read=${parsedCacheRead.type}, messages_write=${parsedMessagesWrite.length} entries, system2=${parsedSystem2.type}`);
    
    return {
      type: 'cache_programming',
      cacheRead: parsedCacheRead,
      cacheMessagesWrite: parsedMessagesWrite,
      cacheSystem2Write: parsedSystem2
    };
  }

  /**
   * Detect and swap MCP tool results with preserved LastUserMessage
   * @param {string} conversationId - Conversation ID
   * @param {array} messages - Messages array to check
   * @private
   */
  _detectAndSwapMCPToolResult(conversationId, messages) {
    const state = this.conversationStates.get(conversationId);
    if (!state) return;
    
    // Find user messages with tool result pattern
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === 'user' && this._isMCPToolResult(message.content)) {
        console.log(`[TokenWindowManager] Detected MCP tool result in user message ${i}`);
        
        // Check if we have a preserved LastUserMessage to swap
        if (state.lastUserMessage) {
          console.log(`[TokenWindowManager] Swapping tool result with preserved LastUserMessage`);
          message.content = state.lastUserMessage.content;
          
          // Clear the preserved message after use
          state.lastUserMessage = null;
          
          // Reset error streak on successful swap
          if (state.errorStreak > 0) {
            this._resetErrorStreak(conversationId);
          }
        } else {
          console.log(`[TokenWindowManager] No LastUserMessage to swap with tool result`);
        }
      }
    }
  }
  
  /**
   * Check if content is an MCP tool result that should be cleaned by TWP
   * Supports both XML (API) and JSON-RPC (internal) result formats
   * @param {string} content - Content to check
   * @returns {boolean} - True if content is a recache_message_array result that should be cleaned
   * @private
   */
  _isMCPToolResult(content) {
    if (!content || typeof content !== 'string') return false;
    
    // XML format tool result (API flows)
    if (content.match(/^\[use_mcp_tool.*?recache_message_array.*?\] Result:/)) {
      return true;
    }
    
    // JSON-RPC format tool result (internal flows)
    if (content.match(/^\[.*?tokenwindow-local__recache_message_array.*?\] Result:/)) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Detect MCP restore command in assistant message content WITHOUT validation
   * Supports both XML (API flows) and JSON-RPC (internal flows) formats
   * Validation is deferred until after registers are updated
   * @param {string} content - Assistant message content
   * @returns {object|null} - Object with command and originalArgs, or null
   * @private
   */
  _detectMCPRestoreCommandWithoutValidation(content) {
    if (!content || typeof content !== 'string') return null;
    
    // TRY XML FORMAT FIRST (API flows)
    const xmlMatch = content.match(/<use_mcp_tool>\s*<server_name>tokenwindow-local<\/server_name>\s*<tool_name>recache_message_array<\/tool_name>\s*<arguments>\s*({[^}]*})\s*<\/arguments>\s*<\/use_mcp_tool>/i);
    
    if (xmlMatch) {
      console.log(`[TokenWindowManager] Found XML MCP restore command: ${xmlMatch[0]}`);
      
      try {
        const args = JSON.parse(xmlMatch[1]);
        
        // Log the exact tool use attempt
        this._logMCPToolUse(this._extractConversationId(), 'recache_message_array', args);
        
        return this._parseAndValidateMCPArgs(args, 'XML');
        
      } catch (parseError) {
        console.log(`[TokenWindowManager] Failed to parse XML MCP arguments: ${parseError.message}`);
        this._handleMCPError(this._extractConversationId(), 'Invalid JSON in XML MCP arguments');
        return null;
      }
    }
    
    // TRY JSON-RPC FORMAT (internal flows)
    const jsonRpcMatch = content.match(/\{"jsonrpc":\s*"2\.0",\s*"method":\s*"tools\/call",\s*"params":\s*\{\s*"name":\s*"tokenwindow-local__recache_message_array",\s*"arguments":\s*({[^}]*})\s*\},\s*"id":\s*\d+\}/i);
    
    if (jsonRpcMatch) {
      console.log(`[TokenWindowManager] Found JSON-RPC MCP restore command: ${jsonRpcMatch[0]}`);
      
      try {
        const args = JSON.parse(jsonRpcMatch[1]);
        
        // Log the exact tool use attempt  
        this._logMCPToolUse(this._extractConversationId(), 'recache_message_array', args);
        
        return this._parseAndValidateMCPArgs(args, 'JSON-RPC');
        
      } catch (parseError) {
        console.log(`[TokenWindowManager] Failed to parse JSON-RPC MCP arguments: ${parseError.message}`);
        this._handleMCPError(this._extractConversationId(), 'Invalid JSON in JSON-RPC MCP arguments');
        return null;
      }
    }
    
    return null;
  }
  
  /**
   * Parse and validate MCP arguments for both XML and JSON-RPC formats
   * @param {object} args - Parsed arguments
   * @param {string} format - Format type ('XML' or 'JSON-RPC')
   * @returns {object|null} - Parsed command and original args, or null
   * @private
   */
  _parseAndValidateMCPArgs(args, format) {
    // Parse new single-parameter format to get enhanced position data (NO VALIDATION YET)
    if (args.messages) {
      const parsed = this._parseUltraSimpleRecache(args.messages);
      if (!parsed) {
        console.log(`[TokenWindowManager] Failed to parse ultra-simple recache command from ${format}`);
        return null;
      }
      
      return {
        command: parsed,
        originalArgs: args,
        format: format
      };
    } else {
      console.log(`[TokenWindowManager] Missing 'messages' parameter in ${format} format`);
      return null;
    }
  }

  /**
   * Detect MCP restore command in assistant message content (LEGACY - kept for compatibility)
   * @param {string} content - Assistant message content
   * @returns {object|null} - Parsed MCP command or null
   * @private
   */
  _detectMCPRestoreCommand(content) {
    if (!content || typeof content !== 'string') return null;
    
    // Look for MCP tool call pattern with recache_message_array
    const mcpMatch = content.match(/<use_mcp_tool>\s*<server_name>tokenwindow-local<\/server_name>\s*<tool_name>recache_message_array<\/tool_name>\s*<arguments>\s*({[^}]*})\s*<\/arguments>\s*<\/use_mcp_tool>/i);
    
    if (mcpMatch) {
      console.log(`[TokenWindowManager] Found MCP restore command: ${mcpMatch[0]}`);
      
      try {
        const args = JSON.parse(mcpMatch[1]);
        
        // Log the exact tool use attempt
        this._logMCPToolUse(this._extractConversationId(), 'recache_message_array', args);
        
        // Parse new single-parameter format first to get enhanced position data
        if (args.messages) {
          const parsed = this._parseUltraSimpleRecache(args.messages);
          if (!parsed) {
            console.log(`[TokenWindowManager] Failed to parse ultra-simple recache command`);
            return null;
          }
          
          // Validate arguments with enhanced position data
          const validationResult = this._validateMCPRecacheArgs(args, parsed);
          if (validationResult.error) {
            console.log(`[TokenWindowManager] MCP command validation failed: ${validationResult.error}`);
            this._handleMCPError(this._extractConversationId(), validationResult.error, args);
            
            // Return MCP command object with error flag so it gets processed as failed command
            return {
              type: 'mcp_command_error',
              error: validationResult.error,
              originalArgs: args
            };
          }
          
          return parsed;
        } else {
          console.log(`[TokenWindowManager] Missing 'messages' parameter`);
          return null;
        }
        
      } catch (parseError) {
        console.log(`[TokenWindowManager] Failed to parse MCP arguments: ${parseError.message}`);
        this._handleMCPError(this._extractConversationId(), 'Invalid JSON in MCP arguments');
        return null;
      }
    }
    
    return null;
  }
  
  /**
   * Validate MCP recache arguments with enhanced placeholder detection
   * Now allows placeholders in ranges but errors on individual placeholder selections
   * @param {object} args - Parsed arguments
   * @param {object} parsedCommand - Parsed command with position data
   * @returns {object} - Validation result
   * @private
   */
  _validateMCPRecacheArgs(args, parsedCommand = null) {
    const conversationId = this._extractConversationId();
    const state = this.conversationStates.get(conversationId);
    
    // Check for empty arguments
    if (!args.messages) {
      return { 
        error: "EMPTY ARGUMENTS: You must provide 'messages' with actual message numbers. Count your current message registers first - do not use placeholder text from examples."
      };
    }
    
    // Use enhanced position data if available, otherwise fall back to simple extraction
    let positions, positionData;
    if (parsedCommand && parsedCommand.positionData) {
      positionData = parsedCommand.positionData;
      positions = positionData.map(data => data.position);
    } else {
      positions = this._extractPositionsFromString(args.messages);
      // Create basic position data for fallback
      positionData = positions.map(pos => ({ position: pos, fromRange: false }));
    }
    
    if (positions.length === 0) {
      return {
        error: "NO VALID POSITIONS: Could not extract any valid message numbers. Use format like '1-4,25' or '1,3,5'."
      };
    }
    
    // Check if any positions are out of range
    if (state && state.registers) {
      const currentRegisterCount = state.registers.length;
      const invalidPositions = positions.filter(pos => pos < 1 || pos > currentRegisterCount);
      
      if (invalidPositions.length > 0) {
        const validRange = currentRegisterCount > 0 ? `1-${currentRegisterCount}` : 'none';
        
        // Build register enumeration to show bot what actually exists
        let registerList = '';
        if (state.registers && state.registers.length > 0) {
          const registerSummary = state.registers.slice(0, 10).map((reg, i) => {
            const contentPreview = (reg.content || '').substring(0, 30).replace(/\n/g, ' ');
            return `[${i + 1}] ${reg.role}: ${contentPreview}${reg.content && reg.content.length > 30 ? '...' : ''}`;
          }).join(', ');
          
          if (state.registers.length > 10) {
            registerList = `\n\nYour current registers: ${registerSummary}, ...(${state.registers.length - 10} more)`;
          } else {
            registerList = `\n\nYour current registers: ${registerSummary}`;
          }
        }
        
        return { 
          error: `INVALID MESSAGE NUMBERS: ${invalidPositions.join(', ')} do not exist. Your current window has ${currentRegisterCount} messages (valid range: ${validRange}). COUNT your actual message registers - do not copy numbers from examples.${registerList}`
        };
      }
      
      // ENHANCED PLACEHOLDER DETECTION: Only check individually selected positions
      const individualPlaceholderPositions = [];
      const individualPlaceholderContents = [];
      const realPositions = [];
      const rangePlaceholderPositions = [];
      
      for (const data of positionData) {
        const position = data.position;
        const index = position - 1; // Convert to 0-based index
        
        if (index >= 0 && index < state.registers.length && state.registers[index]) {
          const register = state.registers[index];
          
          if (this._isPlaceholderContent(register.content)) {
            if (data.fromRange) {
              rangePlaceholderPositions.push(position);
            } else {
              // Only error on individually selected placeholders
              individualPlaceholderPositions.push(position);
              individualPlaceholderContents.push(`'${register.content}'`);
            }
          } else {
            realPositions.push(position);
          }
        }
      }
      
      // Log placeholder analysis for debugging
      if (rangePlaceholderPositions.length > 0) {
        console.log(`[TokenWindowManager] Found ${rangePlaceholderPositions.length} placeholders in ranges (allowed): [${rangePlaceholderPositions.join(', ')}]`);
      }
      
      if (individualPlaceholderPositions.length > 0) {
        console.log(`[TokenWindowManager] Found ${individualPlaceholderPositions.length} individually selected placeholders (error): [${individualPlaceholderPositions.join(', ')}]`);
        
        // Build specific error with exact positions and suggest alternatives
        let errorMessage = `PLACEHOLDER ERROR: You individually selected positions ${individualPlaceholderPositions.join(', ')} which contain system placeholders (${individualPlaceholderContents.join(', ')}), not real conversation content. Placeholders in ranges are fine, but individual placeholder selections indicate confusion.`;
        
        if (realPositions.length > 0) {
          errorMessage += ` You selected some real content at positions ${realPositions.join(', ')} - those are good. Avoid individually selecting placeholder positions.`;
        } else {
          // Find some real content to suggest
          const suggestedPositions = [];
          for (let i = 0; i < Math.min(state.registers.length, 10); i++) {
            const register = state.registers[i];
            if (register && !this._isPlaceholderContent(register.content)) {
              suggestedPositions.push(i + 1);
            }
          }
          
          if (suggestedPositions.length > 0) {
            errorMessage += ` Try selecting real content positions instead: ${suggestedPositions.join(', ')}.`;
          }
        }
        
        return { 
          error: errorMessage
        };
      }
    }
    
    return { valid: true };
  }

  
  /**
   * Extract position numbers from a string
   * @param {string} str - String to extract from
   * @returns {array} - Array of position numbers
   * @private
   */
  _extractPositionsFromString(str) {
    if (!str) return [];
    
    const positions = [];
    const tokens = str.split(',').map(t => t.trim());
    
    for (const token of tokens) {
      // Try range first: "9-12"
      const rangeMatch = token.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        for (let i = start; i <= end; i++) {
          positions.push(i);
        }
        continue;
      }
      
      // Try single number: "25"
      const numberMatch = token.match(/(\d+)/);
      if (numberMatch) {
        positions.push(parseInt(numberMatch[1]));
      }
    }
    
    return positions;
  }
  
  /**
   * Handle MCP command errors
   * @param {string} conversationId - Conversation ID
   * @param {string} errorMessage - Error message
   * @private
   */
  _handleMCPError(conversationId, errorMessage) {
    const state = this.conversationStates.get(conversationId);
    if (!state) return;
    
    // Set current MCP error for JIT prepending
    state.currentMCPError = errorMessage;
    this._logTrace(`Set currentMCPError: ${errorMessage}`);
    
    // Increment error streak
    state.errorStreak++;
    
    // Save current LastUserMessage to stack if exists
    if (state.lastUserMessage) {
      state.lastUserMessageStack.push({ ...state.lastUserMessage });
    }
    
    console.log(`[TokenWindowManager] MCP Error streak: ${state.errorStreak}, saved ${state.lastUserMessageStack.length} LastUserMessages`);
    
    // Log error for debugging
    this._logCommandError(conversationId, 'MCP_VALIDATION_ERROR', {
      errorMessage: errorMessage,
      errorStreak: state.errorStreak,
      reason: 'MCP command validation failed'
    });
  }
  
  /**
   * Reset error streak after successful operation
   * @param {string} conversationId - Conversation ID
   * @private
   */
  _resetErrorStreak(conversationId) {
    const state = this.conversationStates.get(conversationId);
    if (!state) return;
    
    console.log(`[TokenWindowManager] Resetting error streak: ${state.errorStreak} errors cleared`);
    
    // Clear error tracking
    state.errorStreak = 0;
    state.lastUserMessageStack = [];
    state.jitInstructionTurns = [];
    
    // Log successful recovery
    this._logCommandUsage(conversationId, 'ERROR_STREAK_RESET', {
      message: 'Successfully recovered from error streak'
    });
  }


  /**
   * Strip restore command and blank all command-related terms from message content
   * Implements "neuralyzer" approach to keep bots unaware of the meta-game
   * Supports both XML (API) and JSON-RPC (internal) formats
   * @param {string} content - Message content
   * @returns {string} - Content with command stripped and blanked
   * @private
   */
  _stripRestoreCommand(content) {
    if (!content || typeof content !== 'string') {
      return content;
    }
    
    let cleanedContent = content;
    
    // ULTRA-RELAXED: Remove recache commands from anywhere in content
    cleanedContent = cleanedContent.replace(/recache_message_array\s*\([^)]*\)/gi, '');
    
    // MCP NEURALYZER: Remove XML tool calls (API flows)
    cleanedContent = cleanedContent.replace(/<use_mcp_tool>[\s\S]*?<\/use_mcp_tool>/gi, '');
    
    // JSON-RPC NEURALYZER: Remove JSON-RPC tool calls (internal flows)
    cleanedContent = cleanedContent.replace(/\{"jsonrpc":\s*"2\.0",\s*"method":\s*"tools\/call",\s*"params":\s*\{\s*"name":\s*"tokenwindow-local__recache_message_array",[\s\S]*?\},\s*"id":\s*\d+\}/gi, '');
    
    // NEURALYZER: Aggressively remove all traces of command-related terms
    // Remove 'restore', 'newchat', 'cache_read', 'cache_write' (case insensitive, word boundaries)
    cleanedContent = cleanedContent.replace(/\brestore\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bnewchat\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bnew\s+chat\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bcache_read\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bcache_write\b/gi, '');
    
    // Remove other cache programming syntax patterns
    cleanedContent = cleanedContent.replace(/restore\s*\([^)]*\)/gi, '');
    
    // Clean up extra whitespace and punctuation left by removals
    cleanedContent = cleanedContent.replace(/\s{2,}/g, ' '); // Multiple spaces → single space
    cleanedContent = cleanedContent.replace(/\s+([.,!?])/g, '$1'); // Space before punctuation
    cleanedContent = cleanedContent.replace(/([.,!?])\s*([.,!?])/g, '$1$2'); // Double punctuation
    cleanedContent = cleanedContent.replace(/^\s*[.,!?]\s*/gm, ''); // Lines starting with punctuation
    cleanedContent = cleanedContent.replace(/^\s+/gm, ''); // Leading whitespace on lines
    cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n'); // Multiple blank lines → double
    
    console.log(`[TokenWindowManager] DUAL-FORMAT NEURALYZER: Stripped both XML and JSON-RPC MCP commands from content`);
    
    return cleanedContent.trim();
  }

  /**
 * Apply restore command directly to conversation state
 * Only supports ultra-simple recache format
 * @param {string} conversationId - Conversation ID
 * @param {object} restoreCommand - Restore command object
 * @param {object} latestAssistantMessage - Latest assistant message with stripped command
 * @param {array} currentMessages - Current messages from apiRequest
 * @private
 */
_applyRestoreToState(conversationId, restoreCommand, latestAssistantMessage, currentMessages) {
  const state = this.conversationStates.get(conversationId);
  if (!state) {
    console.error(`[TokenWindowManager] No state found for conversation ${conversationId}`);
    this._logRestoreTransaction(conversationId, 'ERROR', {
      reason: 'No conversation state found'
    });
    return;
  }
  
  if (restoreCommand.type === 'ultra_simple_recache') {
    this._applyUltraSimpleRecache(conversationId, restoreCommand, latestAssistantMessage, currentMessages);
  } else if (restoreCommand.type === 'mcp_command_error') {
    // Return the validation error to user as MCP tool result
    this._returnMCPErrorToUser(conversationId, restoreCommand.error, currentMessages);
    return;
  } else {
    console.log(`[TokenWindowManager] Unsupported restore command type: ${restoreCommand.type}`);
    return;
  }
}

  
  /**
   * Apply ultra-simple recache restore command - whatever the fuck he puts
   * Takes a flat list of positions and builds new message array
   * @param {string} conversationId - Conversation ID
   * @param {object} restoreCommand - Ultra-simple recache command with positions array
   * @param {object} latestAssistantMessage - Latest assistant message with stripped command
   * @param {array} currentMessages - Current messages from apiRequest
   * @private
   */
  _applyUltraSimpleRecache(conversationId, restoreCommand, latestAssistantMessage, currentMessages) {
    const state = this.conversationStates.get(conversationId);
    const { positions } = restoreCommand;
    
    console.log(`[TokenWindowManager] APPLY ULTRA-SIMPLE RECACHE: ${positions.length} positions [${positions.join(', ')}]`);
    
    // Log PRE-RESTORE state
    const preRestoreRegisters = state.registers.length;
    console.log(`[TokenWindowManager] BEFORE ULTRA-SIMPLE RECACHE: ${state.registers.length} registers`);
    
    // Build new register array from position list (ultra-lax: skip invalid, allow overlaps)
    const newRegisters = [];
    
    for (const position of positions) {
      const index = position - 1; // Convert to 0-based index
      if (index >= 0 && index < state.registers.length && state.registers[index]) {
        newRegisters.push({
          id: newRegisters.length + 1,
          virtualId: newRegisters.length + 1,
          role: state.registers[index].role,
          content: state.registers[index].content,
          isUserMessage: state.registers[index].role === 'user',
          isBotMessage: state.registers[index].role === 'assistant',
          originalPosition: position
        });
        console.log(`[TokenWindowManager] Added message: ${state.registers[index].role} ${position}`);
      } else {
        console.log(`[TokenWindowManager] SKIPPED invalid position: ${position} (max: ${state.registers.length})`);
      }
    }
    
    // Build complete array with CORRECTED MCP FLOW ordering:
    // 1. Programmed messages from positions
    // 2. Cleaned assistant response (distilled knowledge)
    // 3. Preserved LastUserMessage (original user intent)
    const completeArray = [...newRegisters];
    
    // Add cleaned assistant response (preserves distilled knowledge from dropped messages)
    const cleanedAssistantContent = this._stripRestoreCommand(latestAssistantMessage.content);
    completeArray.push({
      id: completeArray.length + 1,
      virtualId: completeArray.length + 1,
      role: 'assistant',
      content: cleanedAssistantContent,
      isUserMessage: false,
      isBotMessage: true,
      distilled: true
    });
    
    // Add preserved LastUserMessage as final item (ensures odd count + user ending)
    if (state.lastUserMessage) {
      completeArray.push({
        id: completeArray.length + 1,
        virtualId: completeArray.length + 1,
        role: 'user',
        content: state.lastUserMessage.content,
        isUserMessage: true,
        isBotMessage: false,
        preserved: true
      });
      console.log(`[TokenWindowManager] Built complete array: ${newRegisters.length} selected + 1 assistant + 1 preserved user = ${completeArray.length} total`);
      
      // Clear the preserved message after use
      state.lastUserMessage = null;
    } else {
      console.warn(`[TokenWindowManager] No LastUserMessage to append - using current user message`);
      // Fallback to current user message if no preserved message
      const currentUserMessage = [...currentMessages].reverse().find(msg => msg.role === 'user');
      if (currentUserMessage) {
        completeArray.push({
          id: completeArray.length + 1,
          virtualId: completeArray.length + 1,
          role: 'user',
          content: currentUserMessage.content,
          isUserMessage: true,
          isBotMessage: false,
          fallback: true
        });
      }
    }
    
    // THEN force user/assistant ordering on the complete array
    const reorderedRegisters = this._forceUserAssistantOrdering(completeArray, conversationId);
    
    // Replace state registers with new ultra-simple cache
    state.registers = reorderedRegisters;
    state.messageIdCounter = state.registers.length;
    
    // Log POST-RESTORE state
    console.log(`[TokenWindowManager] AFTER ULTRA-SIMPLE RECACHE: ${state.registers.length} registers, ultra-simple cache complete`);
    
    // Clear current MCP error on successful operation
    if (state.currentMCPError) {
      this._logTrace(`Cleared currentMCPError after successful ultra-simple recache`);
      state.currentMCPError = null;
    }
    
    // Log successful ultra-simple recache transaction
    this._logRestoreTransaction(conversationId, 'ULTRA_SIMPLE_SUCCESS', {
      positions: positions.join(','),
      positionCount: positions.length,
      preRestoreRegisters: preRestoreRegisters,
      postRestoreRegisters: state.registers.length
    });
  }

  /**
   * Apply simplified recache restore command with foundation + append system
   * Emergency cache management with ultra-lax validation
   * @param {string} conversationId - Conversation ID
   * @param {object} restoreCommand - Recache command with foundation and append
   * @param {object} latestAssistantMessage - Latest assistant message with stripped command
   * @param {array} currentMessages - Current messages from apiRequest
   * @private
   */
  _applyRecacheRestore(conversationId, restoreCommand, latestAssistantMessage, currentMessages) {
    const state = this.conversationStates.get(conversationId);
    const { foundation, append } = restoreCommand;
    
    console.log(`[TokenWindowManager] APPLY EMERGENCY RECACHE: foundation=${foundation.type}, append=${append.length} entries`);
    
    // Log PRE-RESTORE state
    const preRestoreRegisters = state.registers.length;
    console.log(`[TokenWindowManager] BEFORE RECACHE: ${state.registers.length} registers`);
    
    // Build new register array with emergency ultra-lax validation
    const newRegisters = [];
    
    // 1. Add foundation range (if not empty)
    if (foundation.type === 'range') {
      // Validate foundation range exists (ultra-lax: clamp to available)
      const safeStart = Math.min(foundation.start, state.registers.length);
      const safeEnd = Math.min(foundation.end, state.registers.length);
      
      if (safeStart <= safeEnd && safeStart >= 1) {
        for (let i = safeStart - 1; i < safeEnd; i++) {
          if (state.registers[i]) {
            newRegisters.push({
              ...state.registers[i],
              id: newRegisters.length + 1,
              virtualId: newRegisters.length + 1
            });
          }
        }
        console.log(`[TokenWindowManager] Added foundation range: ${safeStart}-${safeEnd} (${safeEnd - safeStart + 1} messages)`);
      } else {
        console.log(`[TokenWindowManager] Foundation range ${foundation.start}-${foundation.end} clamped to empty (max: ${state.registers.length})`);
      }
    } else {
      console.log(`[TokenWindowManager] Empty foundation - starting fresh`);
    }
    
    // 2. Add append messages (ultra-lax: skip invalid, allow overlaps)
    for (const position of append) {
      const index = position - 1; // Convert to 0-based index
      if (index >= 0 && index < state.registers.length && state.registers[index]) {
        newRegisters.push({
          id: newRegisters.length + 1,
          virtualId: newRegisters.length + 1,
          role: state.registers[index].role,
          content: state.registers[index].content,
          isUserMessage: state.registers[index].role === 'user',
          isBotMessage: state.registers[index].role === 'assistant',
          originalPosition: position
        });
        console.log(`[TokenWindowManager] Added append message: ${state.registers[index].role} ${position}`);
      } else {
        console.log(`[TokenWindowManager] SKIPPED invalid append position: ${position} (max: ${state.registers.length})`);
      }
    }
    
    // 3. Build complete array with CORRECTED MCP FLOW ordering:
    // 1. Programmed messages (foundation + append)
    // 2. Cleaned assistant response (distilled knowledge)
    // 3. Preserved LastUserMessage (original user intent)
    const completeArray = [...newRegisters];
    
    // Add cleaned assistant response (preserves distilled knowledge from dropped messages)
    const cleanedAssistantContent = this._stripRestoreCommand(latestAssistantMessage.content);
    completeArray.push({
      id: completeArray.length + 1,
      virtualId: completeArray.length + 1,
      role: 'assistant',
      content: cleanedAssistantContent,
      isUserMessage: false,
      isBotMessage: true,
      distilled: true
    });
    
    // Add preserved LastUserMessage as final item (ensures odd count + user ending)
    if (state.lastUserMessage) {
      completeArray.push({
        id: completeArray.length + 1,
        virtualId: completeArray.length + 1,
        role: 'user',
        content: state.lastUserMessage.content,
        isUserMessage: true,
        isBotMessage: false,
        preserved: true
      });
      console.log(`[TokenWindowManager] Built complete array: ${newRegisters.length} foundation+append + 1 assistant + 1 preserved user = ${completeArray.length} total`);
      
      // Clear the preserved message after use
      state.lastUserMessage = null;
    } else {
      console.warn(`[TokenWindowManager] No LastUserMessage to append - using current user message`);
      // Fallback to current user message if no preserved message
      const currentUserMessage = [...currentMessages].reverse().find(msg => msg.role === 'user');
      if (currentUserMessage) {
        completeArray.push({
          id: completeArray.length + 1,
          virtualId: completeArray.length + 1,
          role: 'user',
          content: currentUserMessage.content,
          isUserMessage: true,
          isBotMessage: false,
          fallback: true
        });
      }
    }
    
    // 4. Force user/assistant ordering on the complete array
    const reorderedRegisters = this._forceUserAssistantOrdering(completeArray, conversationId);
    
    // Replace state registers with new emergency cache
    state.registers = reorderedRegisters;
    state.messageIdCounter = state.registers.length;
    
    // Log POST-RESTORE state
    console.log(`[TokenWindowManager] AFTER EMERGENCY RECACHE: ${state.registers.length} registers, emergency cache complete`);
    
    // Clear current MCP error on successful operation
    if (state.currentMCPError) {
      this._logTrace(`Cleared currentMCPError after successful emergency recache`);
      state.currentMCPError = null;
    }
    
    // Log successful recache transaction
    this._logRestoreTransaction(conversationId, 'RECACHE_SUCCESS', {
      foundationType: foundation.type,
      foundationRange: foundation.type === 'range' ? `${foundation.start}-${foundation.end}` : 'empty',
      appendEntries: append.length,
      preRestoreRegisters: preRestoreRegisters,
      postRestoreRegisters: state.registers.length
    });
  }

  /**
   * Force user/assistant alternating ordering with minimal fake "DISTILLED" messages
   * CRITICAL: Must result in odd count (start user, end user) for API safety
   * CRITICAL: NEVER create two placeholders in a row
   * @param {array} registers - Register array to reorder
   * @param {string} conversationId - Conversation ID for logging
   * @returns {array} - Reordered registers with strict alternating roles and NO consecutive placeholders
   * @private
   */
  _forceUserAssistantOrdering(registers, conversationId) {
    if (registers.length === 0) {
      console.log(`[TokenWindowManager] No registers to reorder`);
      return registers;
    }
    
    console.log(`[TokenWindowManager] NO-CONSECUTIVE-PLACEHOLDERS LOGIC: Processing ${registers.length} registers`);
    
    const result = [];
    
    // Process each real message and insert fake messages only when needed
    for (let i = 0; i < registers.length; i++) {
      const register = registers[i];
      const currentPosition = result.length;
      const expectedRole = currentPosition % 2 === 0 ? 'user' : 'assistant'; // Even=user, Odd=assistant
      const lastWasPlaceholder = result.length > 0 && result[result.length - 1].fake;
      
      if (register.role === expectedRole) {
        // Role matches expected position - add directly
        result.push({
          ...register,
          id: result.length + 1,
          virtualId: result.length + 1,
          isUserMessage: register.role === 'user',
          isBotMessage: register.role === 'assistant'
        });
        
        console.log(`[TokenWindowManager] Added ${register.role} at position ${currentPosition} (matches expected ${expectedRole})`);
        
      } else if (lastWasPlaceholder) {
        // NEVER create consecutive placeholders - just add the real message even if roles don't alternate perfectly
        result.push({
          ...register,
          id: result.length + 1,
          virtualId: result.length + 1,
          isUserMessage: register.role === 'user',
          isBotMessage: register.role === 'assistant'
        });
        
        console.log(`[TokenWindowManager] Added ${register.role} at position ${currentPosition} (ANTI-CONSECUTIVE: skipping placeholder after previous placeholder)`);
        
      } else {
        // Role doesn't match and last wasn't placeholder - insert one fake message
        const fakeRole = expectedRole;
        
        result.push({
          id: result.length + 1,
          virtualId: result.length + 1,
          role: fakeRole,
          content: this._generatePlaceholderContent(result.length + 1),
          isUserMessage: fakeRole === 'user',
          isBotMessage: fakeRole === 'assistant',
          fake: true,
          distilled: true
        });
        
        console.log(`[TokenWindowManager] Inserted fake ${fakeRole} at position ${currentPosition} (expected ${expectedRole})`);
        
        // Now add the real message at the next position
        result.push({
          ...register,
          id: result.length + 1,
          virtualId: result.length + 1,
          isUserMessage: register.role === 'user',
          isBotMessage: register.role === 'assistant'
        });
        
        console.log(`[TokenWindowManager] Added real ${register.role} at position ${currentPosition + 1}`);
      }
    }
    
    // Ensure odd count by adding fake user message if needed (but not if last was already fake)
    if (result.length % 2 === 0) {
      const lastWasPlaceholder = result.length > 0 && result[result.length - 1].fake;
      
      if (!lastWasPlaceholder) {
        result.push({
          id: result.length + 1,
          virtualId: result.length + 1,
          role: 'user',
          content: this._generatePlaceholderContent(result.length + 1),
          isUserMessage: true,
          isBotMessage: false,
          fake: true,
          distilled: true,
          finalizer: true
        });
        
        console.log(`[TokenWindowManager] Added final fake user to ensure odd count`);
      } else {
        console.log(`[TokenWindowManager] ANTI-CONSECUTIVE: Skipping final placeholder because last message was already placeholder`);
      }
    }
    
    // Verify NO consecutive placeholders
    for (let i = 1; i < result.length; i++) {
      if (result[i].fake && result[i-1].fake) {
        console.error(`[TokenWindowManager] FATAL: Found consecutive placeholders at positions ${i} and ${i+1}!`);
        console.error(`[TokenWindowManager] This violates the core rule - there should NEVER be two placeholders in a row`);
      }
    }
    
    // Verify final state
    const isOdd = result.length % 2 === 1;
    const startsUser = result.length > 0 && result[0].role === 'user';
    const endsUser = result.length > 0 && result[result.length - 1].role === 'user';
    
    if (!isOdd) {
      console.warn(`[TokenWindowManager] WARNING: Result length ${result.length} is not odd - API may not like this`);
    }
    if (!startsUser) {
      console.warn(`[TokenWindowManager] WARNING: Does not start with user - API may not like this`);
    }
    if (!endsUser) {
      console.warn(`[TokenWindowManager] WARNING: Does not end with user - API may not like this`);
    }
    
    const finalPattern = result.map((r, i) => `${i + 1}:${r.role}${r.fake ? '(FAKE)' : ''}`).join(', ');
    console.log(`[TokenWindowManager] NO-CONSECUTIVE-PLACEHOLDERS complete: ${result.length} registers [${finalPattern}]`);
    
    // Count real vs fake messages
    const realCount = result.filter(r => !r.fake).length;
    const fakeCount = result.filter(r => r.fake).length;
    console.log(`[TokenWindowManager] Content preserved: ${realCount} real messages, ${fakeCount} fake messages added (NEVER consecutive)`);
    
    return result;
  }


  /**
   * Check if message exceeds size threshold and offload to disk if needed
   * @param {object} register - Register to check
   * @param {string} conversationId - Conversation ID
   * @returns {object} - Modified register with truncated content if needed
   * @private
   */
  _handleOversizedMessage(register, conversationId) {
    const OVERSIZED_THRESHOLD = Math.floor(this.MAX_WINDOW_SIZE * 0.25); // 25% of window
    const TRUNCATE_TO_TOKENS = 100;
    if (!this.oversizedConfig.enabled) {
      return register; // Feature disabled
    }
  
    // Count tokens in the message content
    const messageTokens = countTokens(register.content, 'anthropicapi');
    
    if (messageTokens > this.OVERSIZED_THRESHOLD) {
      console.log(`[TokenWindowManager] Oversized message detected: ${messageTokens} tokens > ${this.OVERSIZED_THRESHOLD} threshold`);
      
      // Create temp directory if it doesn't exist
      const tempDir = path.join(process.cwd(), 'data/temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Generate unique filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `large_message_${conversationId}_${register.id}_${timestamp}.txt`;
      const filepath = path.join(tempDir, filename);
      
      // Save full content to disk
      fs.writeFileSync(filepath, register.content, 'utf8');
      
      // Truncate content to first N tokens and add read_file instruction
      const truncatedContent = this._truncateToTokens(register.content, TRUNCATE_TO_TOKENS);
      const newContent = `${truncatedContent}\n\n[TRUNCATED - Full content saved to disk. Use grep, tail, head, wc, sed, awk or any other tool to access: ${filepath}] without crushing your window. Do not use read_file on it because I will only truncate it again. As al ast resort read the large file in smaller chunks.`;
      
      // Log the offload operation
      this._logOversizedMessage(conversationId, register.id, messageTokens, filepath);
      
      return {
        ...register,
        content: newContent,
        originalTokens: messageTokens,
        offloadedTo: filepath,
        truncated: true
      };
    }
    
    return register;
  }

  /**
   * Truncate content to specified number of tokens
   * @param {string} content - Content to truncate
   * @param {number} maxTokens - Maximum tokens to keep
   * @returns {string} - Truncated content
   * @private
   */
  _truncateToTokens(content, maxTokens) {
    // Simple word-based approximation: ~4 chars per token
    const approxChars = maxTokens * 4;
    if (content.length <= approxChars) {
      return content;
    }
    
    // Truncate at word boundary near the token limit
    const truncated = content.substring(0, approxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > 0 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
  }

  /**
   * Log oversized message offload operation
   * @param {string} conversationId - Conversation ID
   * @param {number} messageId - Message ID
   * @param {number} originalTokens - Original token count
   * @param {string} filepath - File path where content was saved
   * @private
   */
  _logOversizedMessage(conversationId, messageId, originalTokens, filepath) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      const logEntry = `[${timestamp}] OVERSIZED_MESSAGE_OFFLOAD for ${conversationId}\n` +
                      `  Message ID: ${messageId}\n` +
                      `  Original Tokens: ${originalTokens}\n` +
                      `  Saved To: ${filepath}\n` +
                      `  Threshold: ${Math.floor(this.MAX_WINDOW_SIZE * 0.25)} tokens\n\n`;
      
      fs.appendFileSync(logFile, logEntry);
      console.log(`[TokenWindowManager] Offloaded oversized message: ${originalTokens} tokens -> ${filepath}`);
    } catch (err) {
      console.error(`[TokenWindowManager] Error logging oversized message: ${err.message}`);
    }
  }

  /**
   * Update registers from messages array (FIXED - accumulate instead of overwrite)
   * @param {string} conversationId - Conversation ID  
   * @param {array} messages - Messages array
   * @private
   */
  _updateRegistersFromMessages(conversationId, messages) {
    const state = this.conversationStates.get(conversationId);
    
    // Skip system messages - we only accumulate user/assistant messages
    const nonSystemMessages = messages.filter(msg => msg.role !== 'system');
    
    // CACHE FIX: Strip context window usage from messages BEFORE storing in registers
    const cleanedMessages = this._stripContextWindowUsage(nonSystemMessages);
    
    // ACCUMULATION LOGIC: Add ALL messages to existing window (no duplicate checking)
    for (const message of cleanedMessages) {
      const newId = state.registers.length + 1;
      let newRegister = {
        id: newId,
        virtualId: newId,
        role: message.role, // PRESERVE ORIGINAL ROLE - never use "temp"
        content: message.content,
        isUserMessage: message.role === 'user',
        isBotMessage: message.role === 'assistant'
      };

      // CHECK FOR OVERSIZED MESSAGE AND HANDLE
      newRegister = this._handleOversizedMessage(newRegister, conversationId);
    
      state.registers.push(newRegister);
      console.log(`[TokenWindowManager] Added new message as register ${newId} (${message.role}) - context window usage stripped`);
    }
    
    // NO FORCED ORDERING - only accumulate natural messages
    // Force ordering only happens during recache operations
    console.log(`[TokenWindowManager] Window now has ${state.registers.length} total registers for conversation ${conversationId}`);
  }

  /**
   * Strip Context Window Usage section from all messages to prevent cache breaks
   * @param {array} messages - Array of messages to process
   * @returns {array} - Messages with Context Window Usage sections removed
   * @private
   */
  _stripContextWindowUsage(messages) {
    return messages.map(message => {
      if (message.content && typeof message.content === 'string') {
        let cleanedContent = message.content;
        
        // AGGRESSIVE REMOVAL: Remove entire Context Window Usage section
        // Pattern 1: Remove the full section including header and usage line
        cleanedContent = cleanedContent.replace(/# Context Window Usage\s*\n[^\n]*\n*/g, '');
        
        // Pattern 2: Remove any remaining standalone usage lines
        cleanedContent = cleanedContent.replace(/\d+\s*\/\s*\d+K?\s*tokens\s*used\s*\(\d+%\)\s*\n*/g, '');
        
        // Pattern 3: Remove header if it exists alone
        cleanedContent = cleanedContent.replace(/# Context Window Usage\s*\n*/g, '');
        
        // Pattern 4: Nuclear option - remove any line containing "tokens used"
        cleanedContent = cleanedContent.replace(/.*tokens\s*used.*\n*/g, '');
        
        // Pattern 5: Remove any percentage usage patterns
        cleanedContent = cleanedContent.replace(/.*\(\d+%\).*\n*/g, '');
        
        // Clean up any extra blank lines left behind
        cleanedContent = cleanedContent.replace(/\n\n\n+/g, '\n\n');
        
        return { ...message, content: cleanedContent };
      }
      return message;
    });
  }

  /**
   * Apply window usage transformation using configurable patterns
   * @param {string} content - Message content to transform
   * @param {number} percentage - Percentage to insert
   * @returns {string} - Transformed content
   * @private
   */
  _applyWindowUsageTransform(content, percentage) {
    const pattern = this.config.JITinstruction?.windowUsagePattern;
    if (!pattern || !pattern.searchRegex || !pattern.replaceTemplate) {
      console.error(`FATAL [TokenWindowManager] Missing windowUsagePattern configuration`);
      process.exit(1);
    }
    
    try {
      const searchRegex = new RegExp(pattern.searchRegex, 'g');
      const replaceText = pattern.replaceTemplate.replace('{percentage}', percentage);
      return content.replace(searchRegex, replaceText);
    } catch (err) {
      console.error(`FATAL [TokenWindowManager] Invalid regex pattern in config: ${err.message}`);
      process.exit(1);
    }
  }

  /**
   * Update latest user message to show correct context window usage and handle JIT instructions
   * @param {array} windowedMessages - Array of windowed messages
   * @param {string} conversationId - Conversation ID for state management
   * @param {string} botType - Bot type for token counting  
   * @returns {array} - Modified windowed messages
   * @private
   */
  _updateWindowUsage(windowedMessages, conversationId, botType = 'anthropicapi') {
    const state = this.conversationStates.get(conversationId);
    if (!state) return windowedMessages;
    
    let modifiedMessages = [...windowedMessages];
    
    // Clean previous JIT instructions if state is active
    if (state.jitInstructionActive) {
      modifiedMessages = this._cleanJITInstructions(modifiedMessages, conversationId);
      state.jitInstructionActive = false;
    }
    
    // Find latest user message
    const latestUserIndex = modifiedMessages.map(m => m.role).lastIndexOf('user');
    if (latestUserIndex === -1) return modifiedMessages;
    
    const userMessage = modifiedMessages[latestUserIndex];
    
    // Check if content contains context window usage pattern
    if (!userMessage.content || typeof userMessage.content !== 'string') return modifiedMessages;
    
    // Use configurable detection text - crash if missing
    const pattern = this.config.JITinstruction?.windowUsagePattern;
    if (!pattern || !pattern.detectionText) {
      console.error(`FATAL [TokenWindowManager] Missing windowUsagePattern.detectionText configuration`);
      process.exit(1);
    }
    if (!userMessage.content.includes(pattern.detectionText)) return modifiedMessages;
    
    // Calculate total tokens including system prompt and all windowed messages
    const systemPromptTokens = countTokens(this.twpSystemPrompt, botType);
    const messagesTokens = modifiedMessages.reduce((sum, msg) => {
      // Extract actual text content matching JIT manager logic exactly
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
    
    // Calculate percentage
    const percentage = Math.round((totalTokens / this.MAX_WINDOW_SIZE) * 100);
    
    // Check if JIT instruction threshold is reached
    if (this.config.JITinstruction && 
        percentage >= this.config.JITinstruction.threshold && 
        this.jitManager.jitInstructionContent) {
      modifiedMessages = this._injectJITInstruction(modifiedMessages, conversationId, latestUserIndex);
      
      // Recalculate tokens with instruction included
      const newMessagesTokens = modifiedMessages.reduce((sum, msg) => {
        return sum + countTokens(msg.content, botType);
      }, 0);
      const newTotalTokens = systemPromptTokens + newMessagesTokens;
      const newPercentage = Math.round((newTotalTokens / this.MAX_WINDOW_SIZE) * 100);
      
      console.log(`[TokenWindowManager] JIT instruction injected: ${newTotalTokens}/${this.MAX_WINDOW_SIZE} tokens (${newPercentage}%) - Context Window Usage stripped for cache safety`);
    } else {
      console.log(`[TokenWindowManager] Context window calculated: ${totalTokens}/${this.MAX_WINDOW_SIZE} tokens (${percentage}%) - Context Window Usage stripped for cache safety`);
    }
    
    // CACHE FIX: Do NOT re-inject Context Window Usage - keep it stripped for perfect caching
    return modifiedMessages;
  }

  /**
   * Inject JIT instruction into latest user message with optional error prepending
   * @param {array} windowedMessages - Array of windowed messages
   * @param {string} conversationId - Conversation ID
   * @param {number} latestUserIndex - Index of latest user message
   * @returns {array} - Modified windowed messages
   * @private
   */
  _injectJITInstruction(windowedMessages, conversationId, latestUserIndex) {
    const state = this.conversationStates.get(conversationId);
    if (!state || !this.jitManager.jitInstructionContent) return windowedMessages;
    
    const modifiedMessages = [...windowedMessages];
    const userMessage = modifiedMessages[latestUserIndex];
    
    // Build JIT content with optional error prepending
    let jitContent = this.jitManager.jitInstructionContent;
    
    // Prepend current MCP error if exists
    if (state.currentMCPError) {
      const errorPrefix = `PREVIOUS MCP ERROR: ${state.currentMCPError}\n\n`;
      jitContent = errorPrefix + jitContent;
      this._logTrace(`Prepended MCP error to JIT instructions: ${state.currentMCPError.substring(0, 100)}`);
    }
    
    // Prepend complete JIT content to user message
    const newContent = jitContent + userMessage.content;
    modifiedMessages[latestUserIndex] = { ...userMessage, content: newContent };
    
    // Set state to active for next turn cleaning AND record JIT injection index
    state.jitInstructionActive = true;
    state.jitInjectionIndex = latestUserIndex; // Track where JIT was injected for position-based neuralyzer
    
    // Log JIT instruction addition
    this._logJITOperation(conversationId, 'INJECT', {
      originalContent: userMessage.content.substring(0, 100) + '...',
      newContent: newContent.substring(0, 100) + '...',
      errorPrepended: !!state.currentMCPError,
      injectionIndex: latestUserIndex
    });
    
    console.log(`[TokenWindowManager] JIT instruction injected at index ${latestUserIndex} for conversation ${conversationId}${state.currentMCPError ? ' (with error context)' : ''}`);
    
    return modifiedMessages;
  }

  /**
   * Clean JIT instructions and cache programming commands from messages
   * @param {array} windowedMessages - Array of windowed messages
   * @param {string} conversationId - Conversation ID
   * @returns {array} - Cleaned windowed messages
   * @private
   */
  _cleanJITInstructions(windowedMessages, conversationId) {
    const state = this.conversationStates.get(conversationId);
    let modifiedMessages = [...windowedMessages];
    let cleaned = false;
    
    // Clean exact JIT instruction content from user messages (applies to all user messages)
    if (this.config.JITinstruction && this.jitManager.jitInstructionContent) {
      for (let i = 0; i < modifiedMessages.length; i++) {
        const message = modifiedMessages[i];
        if (message.role === 'user' && message.content && message.content.includes(this.jitManager.jitInstructionContent)) {
          const originalContent = message.content;
          const cleanedContent = message.content.replace(this.jitManager.jitInstructionContent, '');
          modifiedMessages[i] = { ...message, content: cleanedContent };
          
          this._logJITOperation(conversationId, 'CLEAN_USER', {
            messageIndex: i,
            originalContent: originalContent.substring(0, 100) + '...',
            cleanedContent: cleanedContent.substring(0, 100) + '...'
          });
          
          cleaned = true;
        }
      }
    }
    
    // Apply neuralyzer ONLY from JIT injection index onward (to both user and assistant messages)
    const jitInjectionIndex = state?.jitInjectionIndex;
    if (jitInjectionIndex !== undefined) {
      console.log(`[TokenWindowManager] Applying neuralyzer from JIT injection index ${jitInjectionIndex} onward`);
      
      for (let i = jitInjectionIndex; i < modifiedMessages.length; i++) {
        const message = modifiedMessages[i];
        
        // Apply neuralyzer to ALL message roles from JIT injection point forward
        if (message.content && typeof message.content === 'string') {
          let cleanedContent = message.content;
          const originalContent = cleanedContent;
          
          // NEURALYZER: Remove cache programming syntax from ALL messages after JIT injection
          cleanedContent = this._applyCacheProgrammingNeuralyzer(cleanedContent);
          
          // Apply JIT instruction cleaning if configured (for assistant messages)
          if (message.role === 'assistant' && this.config.JITinstruction && this.config.JITinstruction.assistantCleaning) {
            for (const replacement of this.config.JITinstruction.assistantCleaning) {
              const flags = replacement.caseSensitive ? 'g' : 'gi';
              const regex = new RegExp(replacement.search, flags);
              cleanedContent = cleanedContent.replace(regex, replacement.replace);
            }
          }
          
          if (cleanedContent !== originalContent) {
            modifiedMessages[i] = { ...message, content: cleanedContent };
            
            this._logJITOperation(conversationId, `CLEAN_${message.role.toUpperCase()}`, {
              messageIndex: i,
              originalContent: originalContent.substring(0, 100) + '...',
              cleanedContent: cleanedContent.substring(0, 100) + '...',
              jitInjectionIndex: jitInjectionIndex
            });
            
            cleaned = true;
          }
        }
      }
    } else {
      console.log(`[TokenWindowManager] No JIT injection index found - skipping position-based neuralyzer`);
    }
    
    if (cleaned) {
      console.log(`[TokenWindowManager] JIT instructions and cache programming cleaned for conversation ${conversationId}`);
    }
    
    return modifiedMessages;
  }
  
  /**
   * Apply cache programming neuralyzer to remove all traces of commands from text
   * @param {string} content - Content to clean
   * @returns {string} - Cleaned content
   * @private
   */
  _applyCacheProgrammingNeuralyzer(content) {
    if (!content || typeof content !== 'string') {
      return content;
    }
    
    let cleanedContent = content;
    
    // Remove cache programming syntax patterns
    cleanedContent = cleanedContent.replace(/restore\s*\([^)]*\)/gi, '');
    
    // Remove individual command-related terms (case insensitive, word boundaries)
    cleanedContent = cleanedContent.replace(/\brestore\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bnewchat\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bnew\s+chat\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bcache_read\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bcache_write\b/gi, '');
    
    // ANTI-GROK NEURALYZER: Remove all msg/message references with numbers (until newline or period)
    cleanedContent = cleanedContent.replace(/\b(?:msg|message)[s]?[^.\n]*?[\d][^.\n]*?(?=[.\n]|$)/gi, '');
    
    // ANTI-GROK NEURALYZER: Remove numbers after "distilled" (until newline or period)  
    cleanedContent = cleanedContent.replace(/\bdistill[^.\n]*?[\d][^.\n]*?(?=[.\n]|$)/gi, 'distill');
    
    // NUCLEAR GROK NEURALYZER: Remove numbers between delimiters
    cleanedContent = cleanedContent.replace(/(?<=[.\n,])\s*\d+\s*(?=[ :,])/g, '');
    
    // THERMONUCLEAR GROK NEURALYZER: Remove standalone numbers
    cleanedContent = cleanedContent.replace(/\s+\d+\s+/g, ' '); // " 8 " -> " "
    cleanedContent = cleanedContent.replace(/\(\d+(-\d+)?\)/g, ''); // "(8)" or "(8-12)" -> ""
    cleanedContent = cleanedContent.replace(/\s+\d+\./g, ' .'); // " 8." -> " ."
    
    // ULTRA-THERMONUCLEAR GROK NEURALYZER: Remove numbers inside brackets and braces
    cleanedContent = cleanedContent.replace(/\[\d+(-\d+)?\]/g, ''); // "[1]" or "[1-5]" -> ""
    cleanedContent = cleanedContent.replace(/\{\d+(-\d+)?\}/g, ''); // "{1}" or "{2-8}" -> ""
    
    // MEGA-THERMONUCLEAR GROK NEURALYZER: Remove comma-separated number patterns
    cleanedContent = cleanedContent.replace(/\d+(?:,\s*\d+)+/g, ''); // "1,2,3" or "5, 8, 12" -> ""
    cleanedContent = cleanedContent.replace(/\[\d+(?:,\s*\d+)+\]/g, ''); // "[1,2,3]" -> ""
    cleanedContent = cleanedContent.replace(/\{\d+(?:,\s*\d+)+\}/g, ''); // "{1,2,3}" -> ""
    
    // GIGA-THERMONUCLEAR GROK NEURALYZER: Remove mixed bracket/brace patterns with commas
    cleanedContent = cleanedContent.replace(/\[[\d,\s-]+\]/g, ''); // "[1-3,5,7-9]" -> ""
    cleanedContent = cleanedContent.replace(/\{[\d,\s-]+\}/g, ''); // "{1-3,5,7-9}" -> ""
    
    // ULTIMATE-THERMONUCLEAR GROK NEURALYZER: Remove XML blocks and line-start patterns
    cleanedContent = cleanedContent.replace(/<recache_message_array>[\s\S]*?<\/recache_message_array>/gi, ''); // Remove entire XML blocks
    cleanedContent = cleanedContent.replace(/<message_indices>[\s\S]*?<\/message_indices>/gi, ''); // Remove message index XML
    cleanedContent = cleanedContent.replace(/^\s*-?\s*\d+:/gm, ''); // Remove "- 1:", "Message 1:" at line starts
    cleanedContent = cleanedContent.replace(/Messages?\s+\d+(-\d+)?:/gi, ''); // Remove "Message 3:", "Messages 3-8:"
    cleanedContent = cleanedContent.replace(/^\s*-?\s*Messages?\s+\d+/gmi, ''); // Remove "- Messages 9-10"
    cleanedContent = cleanedContent.replace(/^\s*-?\s*Message\s+\d+/gmi, ''); // Remove "- Message 1"
    cleanedContent = cleanedContent.replace(/\b\d+\s*-\s*\d+(?:\s*entries)?/gi, ''); // Remove "9-10 entries", "3-8"
    
    // Remove context window discussions
    cleanedContent = cleanedContent.replace(/context window[^.]*\./gi, '');
    
    // Remove foundation and append terms
    cleanedContent = cleanedContent.replace(/\bfoundation\b/gi, '');
    cleanedContent = cleanedContent.replace(/\bappend\b/gi, '');
    
    // Remove command patterns
    cleanedContent = cleanedContent.replace(/\/restore\s+\d+/gi, '');
    cleanedContent = cleanedContent.replace(/\/newchat\s+\d+/gi, '');
    
    // Clean up extra whitespace and punctuation left by removals
    cleanedContent = cleanedContent.replace(/\s{2,}/g, ' '); // Multiple spaces → single space
    cleanedContent = cleanedContent.replace(/\s+([.,!?])/g, '$1'); // Space before punctuation
    cleanedContent = cleanedContent.replace(/([.,!?])\s*([.,!?])/g, '$1$2'); // Double punctuation
    cleanedContent = cleanedContent.replace(/^\s*[.,!?]\s*/gm, ''); // Lines starting with punctuation
    cleanedContent = cleanedContent.replace(/\/\/\s*$/gm, ''); // Empty comment patterns
    
    return cleanedContent.trim();
  }

  /**
   * Log JIT instruction operations
   * @param {string} conversationId - Conversation ID
   * @param {string} operation - Operation type (INJECT, CLEAN_USER, CLEAN_ASSISTANT)
   * @param {object} details - Operation details
   * @private
   */
  _logJITOperation(conversationId, operation, details) {
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
      console.error(`[TokenWindowManager] Error logging JIT operation: ${err.message}`);
    }
  }

  /**
   * Log restore transaction to TWP log file
   * @param {string} conversationId - Conversation ID
   * @param {string} status - Transaction status (SUCCESS, REJECTED, ERROR)
   * @param {object} details - Transaction details
   * @private
   */
  _logRestoreTransaction(conversationId, status, details) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      let logEntry = `[${timestamp}] RESTORE ${status} for ${conversationId}\n`;
      
      if (details.originalRequest !== undefined) {
        logEntry += `  Original Request: /restore ${details.originalRequest}\n`;
      }
      
      if (details.correctedTo !== undefined && details.correctedTo !== details.originalRequest) {
        logEntry += `  Auto-corrected to: ${details.correctedTo}\n`;
      }
      
      if (details.requestedMessage !== undefined) {
        logEntry += `  Requested Message: ${details.requestedMessage}\n`;
      }
      
      if (details.maxMessages !== undefined) {
        logEntry += `  Max Available Messages: ${details.maxMessages}\n`;
      }
      
      if (details.preRestoreRegisters !== undefined) {
        logEntry += `  Pre-restore Registers: ${details.preRestoreRegisters}\n`;
      }
      
      if (details.postRestoreRegisters !== undefined) {
        logEntry += `  Post-restore Registers: ${details.postRestoreRegisters}\n`;
      }
      
      if (details.restoreIndex !== undefined) {
        logEntry += `  Restore Index: ${details.restoreIndex}\n`;
      }
      
      if (details.autoCorrected !== undefined) {
        logEntry += `  Auto-corrected: ${details.autoCorrected}\n`;
      }
      
      if (details.reason) {
        logEntry += `  Reason: ${details.reason}\n`;
      }
      
      logEntry += '\n';
      
      // Append to log file synchronously
      fs.appendFileSync(logFile, logEntry);
      
      console.log(`[TokenWindowManager] Logged restore transaction: ${status}`);
    } catch (err) {
      console.error(`[TokenWindowManager] Error logging restore transaction: ${err.message}`);
    }
  }

  /**
   * Log the current window state to TWP log file with token counts
   * @param {string} conversationId - Conversation ID
   * @param {array} windowedMessages - The windowed messages
   * @param {object} restorePoint - The restore point if any
   * @private
   */
  _logWindow(conversationId, windowedMessages, restorePoint) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      // Calculate tokens for each message and total
      const systemPromptTokens = countTokens(this.twpSystemPrompt, 'anthropicapi');
      let totalMessageTokens = 0;
      const messageTokens = windowedMessages.map(msg => {
        let tokens = 0;
        if (typeof msg.content === 'string') {
          tokens = countTokens(msg.content, 'anthropicapi');
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item && item.content) {
              tokens += countTokens(item.content, 'anthropicapi');
            }
          }
        }
        totalMessageTokens += tokens;
        return tokens;
      });
      
      const totalTokens = systemPromptTokens + totalMessageTokens;
      const percentage = Math.round((totalTokens / this.MAX_WINDOW_SIZE) * 100);
      
      let logEntry = `[${timestamp}] TWP Window for ${conversationId}\n`;
      
      if (restorePoint) {
        logEntry += `  Restore Point: Turn ${restorePoint.turnNumber} (Register ${restorePoint.registerNum})\n`;
      }
      
      logEntry += `  Window: ${totalTokens} tokens and ${percentage}% used of window (${windowedMessages.length} registers)\n`;
      
      windowedMessages.forEach((msg, index) => {
        const contentPreview = (msg.content || '').toString().substring(0, 50).replace(/\n/g, ' ');
        logEntry += `    [${index + 1}] ${msg.role} (${messageTokens[index]} tokens): ${contentPreview}${msg.content && msg.content.length > 50 ? '...' : ''}\n`;
      });
      
      logEntry += '\n';
      
      // Append to log file synchronously
      fs.appendFileSync(logFile, logEntry);
    } catch (err) {
      console.error(`[TokenWindowManager] Error logging window: ${err.message}`);
    }
  }

  /**
   * Load TWP system prompt live based on conversation originator
   * @param {string} conversationId - Conversation ID to check originator
   * @returns {string} - Loaded system prompt
   * @private
   */
  _loadLiveSystemPrompt(conversationId = null) {
    try {
      // Determine prompt file based on conversation originator
      let promptFile = 'twp_bak.txt'; // Default for non-API flows
      
      // Check conversation originator if conversationId provided
      if (conversationId) {
        try {
          const conversationManager = require(path.join(process.cwd(), 'services/conversation-manager'));
          const conversation = conversationManager.getConversation(conversationId);
          
          if (conversation && conversation.originator === 'api') {
            promptFile = 'twp.txt'; // API flows get client tools
            console.log(`[TokenWindowManager] API originator detected, using twp.txt`);
          } else {
            console.log(`[TokenWindowManager] Non-API originator detected, using twp_bak.txt`);
          }
        } catch (error) {
          console.log(`[TokenWindowManager] Could not check conversation originator: ${error.message}, defaulting to twp_bak.txt`);
          process.exit(1);
        }
      } else {
        console.log(`[TokenWindowManager] No conversationId provided, using default twp_bak.txt`);
        process.exit(1);
      }
      
      this.twpSystemPrompt = fs.readFileSync(
        path.join(process.cwd(), 'data/config/prompts', promptFile),
        'utf8'
      );
      
      if (this.jitManager) {
        this.jitManager.systemPrompt = this.twpSystemPrompt;
      }
      
      console.log(`[TokenWindowManager] Live loaded TWP system prompt from ${promptFile}`);
      return this.twpSystemPrompt;
    } catch (err) {
      console.error(`[TokenWindowManager] Could not load system prompt: ${err.message}`);
      process.exit(1);
    }
  }

  /**
   * Get the windowed messages and system prompt
   * @param {string} conversationId - Conversation ID
   * @returns {object} - Object with windowed messages and system prompt
   */
  getTokenWindowForTransform(conversationId) {
    console.log(`[TokenWindowManager] Getting token window for transform, conversation ${conversationId}`);
    
    if (!conversationId) {
      const error = new Error('FATAL: conversationId is required for getTokenWindowForTransform');
      console.error(error.stack);
      process.exit(1);
    }
    
    // Load system prompt live on every request
    this._loadLiveSystemPrompt(conversationId);
    
    const state = this.conversationStates.get(conversationId);
    if (!state) {
      console.log(`[TokenWindowManager] No state found for conversation ${conversationId}`);
      return {
        windowedMessages: [],
        systemPrompt: this.twpSystemPrompt
      };
    }
    
    // Convert registers to windowed messages (restore already applied in processClientRequest)
    const windowedMessages = state.registers.map(register => ({
      role: register.role,
      content: register.content
    }));
    
    // Apply context window usage transformation with CORRECT token counting using JIT manager
    const transformedMessages = this.jitManager.updateWindowUsageWithFinalCount(windowedMessages, state, conversationId, 'anthropicapi');
    
    // Log the window to TWP log file
    this._logWindow(conversationId, transformedMessages, null);
    
    console.log(`[TokenWindowManager] Returning ${transformedMessages.length} windowed messages for conversation ${conversationId}`);
    
    // Build system prompt with System2 content if available
    let completeSystemPrompt = this.twpSystemPrompt;
    
    if (state.system2Content) {
      // Create dual-block system prompt for cache control
      completeSystemPrompt = [
        {
          type: 'text',
          text: this.twpSystemPrompt,
          cache_control: { type: 'ephemeral' }
        },
        {
          type: 'text',
          text: state.system2Content,
          cache_control: { type: 'ephemeral' }
        }
      ];
      console.log(`[TokenWindowManager] Built dual-block system prompt with System2 content for conversation ${conversationId}`);
    }
    
    return {
      windowedMessages: transformedMessages,
      systemPrompt: completeSystemPrompt
    };
  }

  /**
   * Update cache breakpoint and calculate cache stats after window operations
   * @param {string} conversationId - Conversation ID
   * @param {number} oldBreakpoint - Previous breakpoint position
   * @param {object} restoreCommand - Restore command if executed
   * @private
   */
  _updateCacheBreakpoint(conversationId, oldBreakpoint, restoreCommand) {
    const state = this.conversationStates.get(conversationId);
    if (!state) return;
    
    // Calculate new breakpoint position (always at end of latest user message)
    const newBreakpoint = this._findLatestUserMessageIndex(state.registers);
    
    console.log(`[TokenWindowManager] Cache breakpoint: ${oldBreakpoint} -> ${newBreakpoint}`);
    
    // Calculate cache stats based on breakpoint movement
    let cacheStats;
    
    if (restoreCommand && restoreCommand.type === 'cache_programming') {
      // For cache programming operations, use special calculation
      cacheStats = this._calculateCacheProgrammingStats(conversationId, restoreCommand, oldBreakpoint, newBreakpoint);
    } else {
      // For normal operations, use incremental calculation
      cacheStats = this._calculateIncrementalCacheStats(conversationId, oldBreakpoint, newBreakpoint);
    }
    
    // Update state
    state.cacheBreakpoint = newBreakpoint;
    state.lastCacheStats = cacheStats;
    
    console.log(`[TokenWindowManager] Cache stats updated: cache_creation=${cacheStats.cache_creation_input_tokens}, cache_read=${cacheStats.cache_read_input_tokens}`);
  }

  /**
   * Find the index of the latest user message in registers
   * @param {array} registers - Register array
   * @returns {number} - Index of latest user message, or registers.length if no user messages
   * @private
   */
  _findLatestUserMessageIndex(registers) {
    for (let i = registers.length - 1; i >= 0; i--) {
      if (registers[i] && registers[i].role === 'user') {
        return i + 1; // Return 1-based index (breakpoint after this message)
      }
    }
    return registers.length; // If no user messages, breakpoint at end
  }

  /**
   * Calculate cache stats for normal incremental operations
   * @param {string} conversationId - Conversation ID
   * @param {number} oldBreakpoint - Previous breakpoint position
   * @param {number} newBreakpoint - New breakpoint position
   * @returns {object} - Cache stats object
   * @private
   */
  _calculateIncrementalCacheStats(conversationId, oldBreakpoint, newBreakpoint) {
    const state = this.conversationStates.get(conversationId);
    
    // If first request (no previous breakpoint)
    if (oldBreakpoint === 0) {
      const cacheCreationTokens = this._countTokensInRange(state.registers, 1, newBreakpoint);
      return {
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: 0
      };
    }
    
    // Normal incremental: new messages go to cache_creation, previous to cache_read
    const cacheReadTokens = this._countTokensInRange(state.registers, 1, oldBreakpoint);
    const cacheCreationTokens = this._countTokensInRange(state.registers, oldBreakpoint + 1, newBreakpoint);
    
    return {
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens
    };
  }

  /**
   * Calculate cache stats for cache programming operations
   * @param {string} conversationId - Conversation ID
   * @param {object} restoreCommand - Cache programming command
   * @param {number} oldBreakpoint - Previous breakpoint position
   * @param {number} newBreakpoint - New breakpoint position
   * @returns {object} - Cache stats object
   * @private
   */
  _calculateCacheProgrammingStats(conversationId, restoreCommand, oldBreakpoint, newBreakpoint) {
    const state = this.conversationStates.get(conversationId);
    const { cacheRead } = restoreCommand;
    
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    
    if (cacheRead.type === 'range') {
      // For cache programming with range, cache_read comes from the cacheRead parameter
      cacheReadTokens = this._countTokensInRange(state.registers, 1, cacheRead.end);
      
      // cache_creation is everything after the cache_read range
      cacheCreationTokens = this._countTokensInRange(state.registers, cacheRead.end + 1, newBreakpoint);
    } else {
      // Empty cache_read - everything goes to cache_creation
      cacheCreationTokens = this._countTokensInRange(state.registers, 1, newBreakpoint);
    }
    
    return {
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens
    };
  }

  /**
   * Count tokens in a range of registers
   * @param {array} registers - Register array
   * @param {number} startIndex - Start index (1-based, inclusive)
   * @param {number} endIndex - End index (1-based, inclusive)
   * @returns {number} - Total tokens in range
   * @private
   */
  _countTokensInRange(registers, startIndex, endIndex) {
    let totalTokens = 0;
    
    // Parameter validation
    if (!registers || !Array.isArray(registers)) {
      this._logTrace(`Invalid registers array passed to _countTokensInRange (returning 0 tokens)`, 'WARN');
      return 0;
    }
    
    // Range validation
    if (typeof startIndex !== 'number' || typeof endIndex !== 'number' || 
        startIndex < 1 || endIndex < startIndex) {
      this._logTrace(`Invalid range (${startIndex}-${endIndex}) passed to _countTokensInRange (returning 0 tokens)`, 'WARN');
      return 0;
    }
    
    // Count tokens for each register in range
    for (let i = startIndex - 1; i < endIndex && i < registers.length; i++) {
      if (registers[i]) {
        // Handle registers with empty or missing content gracefully
        if (registers[i].content === undefined || registers[i].content === null) {
          this._logTrace(`Register ${i+1} has null/undefined content (counting as 0 tokens)`);
          continue;
        }
        
        try {
          const tokens = countTokens(registers[i].content, 'anthropicapi');
          totalTokens += Number(tokens.toString());
        } catch (err) {
          // Silently handle errors (countTokens now returns 0 for errors)
          this._logTrace(`Error counting tokens for register ${i+1} (counting as 0 tokens)`);
        }
      }
    }
    
    return totalTokens;
  }

  /**
   * Log general operations to skynet_trace.txt instead of console
   * @param {string} message - Log message
   * @param {string} level - Log level (INFO, WARN, ERROR)
   * @private
   */
  _logTrace(message, level = 'INFO') {
    try {
      const timestamp = new Date().toISOString();
      const logFile = path.join(process.cwd(), 'data/skynet_trace.txt');
      
      const logEntry = `[${timestamp}] [${level}] [TokenWindowManager] ${message}\n`;
      
      // Append to log file
      fs.appendFileSync(logFile, logEntry);
    } catch (err) {
      // Fallback to console for critical logging errors
      console.error(`[TokenWindowManager] Error writing to skynet_trace.txt: ${err.message}`);
    }
  }

  /**
   * Log general TWP operations to file instead of console
   * @param {string} conversationId - Conversation ID
   * @param {string} operation - Operation type
   * @param {string} message - Log message
   * @param {object} details - Additional details (optional)
   * @private
   */
  _logTWP(conversationId, operation, message, details = {}) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      let logEntry = `[${timestamp}] ${operation} for ${conversationId}: ${message}\n`;
      
      // Add details if provided
      if (Object.keys(details).length > 0) {
        for (const [key, value] of Object.entries(details)) {
          logEntry += `  ${key}: ${value}\n`;
        }
      }
      
      logEntry += '\n';
      
      // Append to log file
      fs.appendFileSync(logFile, logEntry);
    } catch (err) {
      // Still use console.error for critical logging errors
      console.error(`[TokenWindowManager] Error logging TWP operation: ${err.message}`);
    }
  }

  /**
   * Log MCP tool use attempts to TWP log file
   * @param {string} conversationId - Conversation ID
   * @param {string} toolName - Name of the MCP tool
   * @param {object} args - Tool arguments
   * @private
   */
  _logMCPToolUse(conversationId, toolName, args) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      let logEntry = `[${timestamp}] MCP_TOOL_USE ${toolName} for ${conversationId}\n`;
      logEntry += `  Tool: ${toolName}\n`;
      logEntry += `  Arguments: ${JSON.stringify(args)}\n`;
      logEntry += '\n';
      
      // Append to log file
      fs.appendFileSync(logFile, logEntry);
    } catch (err) {
      // Still use console.error for critical logging errors
      console.error(`[TokenWindowManager] Error logging MCP tool use: ${err.message}`);
    }
  }

  /**
   * Log command usage to TWP log file for debugging
   * @param {string} conversationId - Conversation ID
   * @param {string} commandType - Type of command (e.g., 'RECACHE_COMMAND')
   * @param {object} details - Command details
   * @private
   */
  _logCommandUsage(conversationId, commandType, details) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      let logEntry = `[${timestamp}] COMMAND ${commandType} for ${conversationId}\n`;
      
      if (details.originalCommand) {
        logEntry += `  Original Command: ${details.originalCommand}\n`;
      }
      
      if (details.parsedPositions) {
        logEntry += `  Parsed Positions: ${details.parsedPositions}\n`;
      }
      
      if (details.positionCount !== undefined) {
        logEntry += `  Position Count: ${details.positionCount}\n`;
      }
      
      logEntry += '\n';
      
      // Append to log file
      fs.appendFileSync(logFile, logEntry);
      
      console.log(`[TokenWindowManager] Logged command usage: ${commandType}`);
    } catch (err) {
      console.error(`[TokenWindowManager] Error logging command usage: ${err.message}`);
    }
  }

  /**
   * Return MCP validation error to user as tool result
   * @param {string} conversationId - Conversation ID
   * @param {string} errorMessage - The detailed error message
   * @param {array} currentMessages - Current messages array
   * @private
   */
  _returnMCPErrorToUser(conversationId, errorMessage, currentMessages) {
    // Log error return to TWP logs
    this._logRestoreTransaction(conversationId, 'ERROR_RETURNED_TO_USER', {
      errorMessage: errorMessage,
      reason: 'MCP command validation failed - error returned to user'
    });
    
    // Modify the latest user message to show the error as MCP tool result
    const latestUserMessage = [...currentMessages].reverse().find(msg => msg.role === 'user');
    if (latestUserMessage) {
      // Format as MCP tool result
      latestUserMessage.content = `[use_mcp_tool] Result: ERROR: ${errorMessage}`;
      console.log(`[TokenWindowManager] Returned validation error to user: ${errorMessage}`);
    }
  }

  /**
   * Log command validation errors to TWP log file and conversation state
   * @param {string} conversationId - Conversation ID
   * @param {string} errorType - Type of validation error
   * @param {object} details - Error details
   * @private
   */
  _logCommandError(conversationId, errorType, details) {
    try {
      const timestamp = new Date().toISOString();
      const logDir = path.join(process.cwd(), 'data/logs');
      const logFile = path.join(logDir, 'twp.txt');
      
      // Ensure log directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      let logEntry = `[${timestamp}] COMMAND_ERROR ${errorType} for ${conversationId}\n`;
      
      // ADD DETAILED ERROR MESSAGE TO LOGS
      if (details.errorMessage) {
        logEntry += `  Error Message: ${details.errorMessage}\n`;
      }
      
      if (details.command) {
        logEntry += `  Command: ${details.command}\n`;
      }
      
      if (details.provided) {
        logEntry += `  Provided: ${details.provided}\n`;
      }
      
      if (details.expected) {
        logEntry += `  Expected: ${details.expected}\n`;
      }
      
      if (details.position !== undefined) {
        logEntry += `  Position: ${details.position}\n`;
      }
      
      if (details.reason) {
        logEntry += `  Reason: ${details.reason}\n`;
      }
      
      logEntry += '\n';
      
      // Append to log file
      fs.appendFileSync(logFile, logEntry);
      
      // Store in conversation state for JIT instruction recovery
      const state = this.conversationStates.get(conversationId);
      if (state) {
        state.errors.push({
          type: errorType,
          timestamp: timestamp,
          details: details
        });
        state.lastErrorTime = timestamp;
        
        // Keep only last 3 errors to avoid memory bloat
        if (state.errors.length > 3) {
          state.errors = state.errors.slice(-3);
        }
      }
      
      console.log(`[TokenWindowManager] Logged command error: ${errorType}`);
    } catch (err) {
      console.error(`[TokenWindowManager] Error logging command error: ${err.message}`);
    }
  }

  /**
   * Generate configurable placeholder content for fake messages
   * @param {number} position - Position number to include in placeholder
   * @returns {string} - Generated placeholder content
   * @private
   */
  _generatePlaceholderContent(position) {
    const placeholderConfig = this.config.placeholderMessages;
    
    // Check if placeholder messages are enabled
    if (!placeholderConfig || !placeholderConfig.enabled) {
      return 'DISTILLED'; // Fallback to old behavior
    }
    
    // Use configured template with position substitution
    const template = placeholderConfig.template || 'Message {position}';
    return template.replace('{position}', position);
  }

  /**
   * Check if content is a system placeholder
   * @param {string} content - Content to check
   * @returns {boolean} - True if content is a placeholder
   * @private
   */
  _isPlaceholderContent(content) {
    if (!content || typeof content !== 'string') {
      return false;
    }
    
    // Check fallback placeholder
    if (content === 'DISTILLED') {
      return true;
    }
    
    // Check configured template patterns
    const placeholderConfig = this.config.placeholderMessages;
    if (placeholderConfig && placeholderConfig.enabled) {
      const template = placeholderConfig.template || 'Message {position}';
      
      // Create regex pattern from template (escape special chars and replace {position} with \d+)
      const escapedTemplate = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regexPattern = escapedTemplate.replace('\\{position\\}', '\\d+');
      const regex = new RegExp(`^${regexPattern}$`);
      
      if (regex.test(content)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Extract conversation ID from current context (for error logging)
   * @returns {string} - Conversation ID or 'unknown'
   * @private
   */
  _extractConversationId() {
    // Try to find conversation ID from current state
    if (this.conversationStates.size === 1) {
      return this.conversationStates.keys().next().value;
    }
    
    // Fallback
    return 'unknown';
  }

  // REMOVED: _hasOverlaps function - no longer doing overlap validation

  /**
   * Get the windowed messages and system prompt with bot ID for shared chat role enhancement
   * @param {string} conversationId - Conversation ID
   * @param {string} botId - Bot ID for shared chat role enhancement (optional)
   * @returns {object} - Object with windowed messages and enhanced system prompt
   */
  getTokenWindowForTransformWithBotId(conversationId, botId = null) {
    console.log(`[TokenWindowManager] Getting token window for transform with botId, conversation ${conversationId}, bot ${botId}`);
    
    if (!conversationId) {
      const error = new Error('FATAL: conversationId is required for getTokenWindowForTransformWithBotId');
      console.error(error.stack);
      process.exit(1);
    }
    
    // Load system prompt live on every request
    this._loadLiveSystemPrompt(conversationId);
    
    const state = this.conversationStates.get(conversationId);
    if (!state) {
      console.log(`[TokenWindowManager] No state found for conversation ${conversationId}`);
      return {
        windowedMessages: [],
        systemPrompt: this.twpSystemPrompt
      };
    }
    
    // Convert registers to windowed messages (restore already applied in processClientRequest)
    const windowedMessages = state.registers.map(register => ({
      role: register.role,
      content: register.content
    }));
    
    // Apply context window usage transformation with CORRECT token counting using JIT manager
    const transformedMessages = this.jitManager.updateWindowUsageWithFinalCount(windowedMessages, state, conversationId, 'anthropicapi');
    
    // Log the window to TWP log file
    this._logWindow(conversationId, transformedMessages, null);
    
    console.log(`[TokenWindowManager] Returning ${transformedMessages.length} windowed messages for conversation ${conversationId}`);
    
    // Build system prompt with shared chat role integration and System2 content
    let enhancedSystemPrompt = this.twpSystemPrompt;
    
    // Check for shared chat role enhancement
    if (botId) {
      try {
        const conversationManager = require(path.join(process.cwd(), 'services/conversation-manager'));
        const conversation = conversationManager.getConversation(conversationId);
        
        if (conversation && conversation.type === 'shared_chat' && conversation.participants) {
          // Find the bot's role in the shared chat
          const botParticipant = conversation.participants.find(p => p.botId === botId);
          
          if (botParticipant && botParticipant.role) {
            console.log(`[TokenWindowManager] Enhancing system prompt for ${botId} with shared chat role: ${botParticipant.role}`);
            
            // Append the shared chat role to the existing #Role: line
            enhancedSystemPrompt = enhancedSystemPrompt.replace(
              /#Role: You are the best bot on SKYNET\./,
              `#Role: You are the best bot on SKYNET. ${botParticipant.role}`
            );
            
            console.log(`[TokenWindowManager] System prompt enhanced with shared chat role for conversation ${conversationId}`);
          }
        }
      } catch (error) {
        console.log(`[TokenWindowManager] Could not enhance system prompt with shared chat role: ${error.message}`);
        // Continue with base system prompt
      }
    }
    
    // Handle System2 content if available
    if (state.system2Content) {
      // Create dual-block system prompt for cache control
      return {
        windowedMessages: transformedMessages,
        systemPrompt: [
          {
            type: 'text',
            text: enhancedSystemPrompt,
            cache_control: { type: 'ephemeral' }
          },
          {
            type: 'text',
            text: state.system2Content,
            cache_control: { type: 'ephemeral' }
          }
        ]
      };
    }
    
    return {
      windowedMessages: transformedMessages,
      systemPrompt: enhancedSystemPrompt
    };
  }

  /**
   * Get cache stats for the current response (called by SkynetAPI)
   * @param {string} conversationId - Conversation ID
   * @returns {object} - Cache stats for this response
   */
  getCacheStatsForResponse(conversationId) {
    const state = this.conversationStates.get(conversationId);
    if (!state) {
      console.log(`[TokenWindowManager] No state found for conversation ${conversationId}, returning zero cache stats`);
      return {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      };
    }
    
    console.log(`[TokenWindowManager] Returning cache stats for ${conversationId}: cache_creation=${state.lastCacheStats.cache_creation_input_tokens}, cache_read=${state.lastCacheStats.cache_read_input_tokens}`);
    
    return {
      cache_creation_input_tokens: state.lastCacheStats.cache_creation_input_tokens,
      cache_read_input_tokens: state.lastCacheStats.cache_read_input_tokens
    };
  }

  /**
   * Get window state for debugging
   * @param {string} conversationId - Conversation ID
   * @returns {object} - Current window state
   */
  getWindowState(conversationId) {
    return this.conversationStates.get(conversationId) || null;
  }

  /**
   * Reset conversation state (for newchat)
   * @param {string} conversationId - Conversation ID
   */
  resetConversation(conversationId) {
    this.conversationStates.delete(conversationId);
    console.log(`[TokenWindowManager] Reset conversation state for ${conversationId}`);
  }

  // Legacy compatibility methods (keep existing interface)
  renderTokenWindow(conversationId, currentMessage) {
    return this.getTokenWindowForTransform(conversationId).tokenWindowContent;
  }

  updateWindowState(conversationId, newState) {
    // Legacy compatibility - ignore
  }

  loadWindowState(conversationId) {
    return this.getWindowState(conversationId);
  }

  saveWindowState(conversationId, windowState) {
    // Legacy compatibility - ignore
  }
}

module.exports = TokenWindowManager;
