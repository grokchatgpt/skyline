/**
 * Window State Manager
 * 
 * Manages the token window state for conversations in memory.
 * No database dependencies.
 */

const fs = require('fs');
const path = require('path');

class WindowStateManager {
  constructor() {
    // Load configuration
    try {
      this.config = require(path.join(process.cwd(), 'data/config/token-window.json'));
    } catch (err) {
      console.error(`FATAL: Failed to load context-window-manager.json config: ${err.message}`);
      process.exit(1);
    }
    
    this.MAX_WINDOW_SIZE = 128000;
    
    // In-memory cache of active token windows
    this.activeWindows = new Map(); // conversationId → windowState
    
    console.log(`[WindowStateManager] Initialized with MAX_WINDOW_SIZE=${this.MAX_WINDOW_SIZE}`);
  }

  /**
   * Get window state for a conversation
   * 
   * @param {string} conversationId - Conversation ID
   * @returns {object} - Window state
   */
  getWindowState(conversationId) {
    console.log(`[WindowStateManager] Getting window state for conversation ${conversationId}`);
    
    if (!conversationId) {
      const error = new Error('FATAL: conversationId is required for getWindowState');
      console.error(error.stack);
      process.exit(1);
    }
    
    // Check in-memory cache first
    if (this.activeWindows.has(conversationId)) {
      return this.activeWindows.get(conversationId);
    }
    
    // Create a new empty window state if it doesn't exist
    const emptyState = {
      messageRegisters: [],
      thoughtRegisters: [],
      previousOperations: [],
      operationResults: [],
      loadedRegisters: []
    };
    
    // Cache for future use
    this.activeWindows.set(conversationId, emptyState);
    
    return emptyState;
  }

  /**
   * Update window state for a conversation
   * 
   * @param {string} conversationId - Conversation ID
   * @param {object} newState - New window state
   */
  updateWindowState(conversationId, newState) {
    console.log(`[WindowStateManager] Updating window state for conversation ${conversationId}`);
    
    if (!conversationId) {
      const error = new Error('FATAL: conversationId is required for updateWindowState');
      console.error(error.stack);
      process.exit(1);
    }
    
    if (!newState) {
      const error = new Error('FATAL: newState is required for updateWindowState');
      console.error(error.stack);
      process.exit(1);
    }
    
    // Update in-memory cache
    this.activeWindows.set(conversationId, newState);
  }

  /**
   * Clear window state for a conversation
   * 
   * @param {string} conversationId - Conversation ID
   */
  clearWindowState(conversationId) {
    console.log(`[WindowStateManager] Clearing window state for conversation ${conversationId}`);
    
    if (!conversationId) {
      const error = new Error('FATAL: conversationId is required for clearWindowState');
      console.error(error.stack);
      process.exit(1);
    }
    
    // Remove from in-memory cache
    this.activeWindows.delete(conversationId);
  }
  
  /**
   * Reset window state for a conversation
   * Creates a fresh empty window state
   * 
   * @param {string} conversationId - Conversation ID
   */
  resetWindowState(conversationId) {
    const logger = require(path.join(process.cwd(), 'services/logging'));
    logger.info(`Resetting window state for conversation ${conversationId}`);
    
    if (!conversationId) {
      const error = new Error('FATAL: conversationId is required for resetWindowState');
      logger.error(error.message);
      process.exit(1);
    }
    
    // Create a new empty window state
    const emptyState = {
      messageRegisters: [],
      thoughtRegisters: [],
      previousOperations: [],
      operationResults: [],
      loadedRegisters: []
    };
    
    // Update in-memory cache
    this.activeWindows.set(conversationId, emptyState);
    
    logger.info(`Window state reset for conversation ${conversationId}`);
  }
}

module.exports = WindowStateManager;
