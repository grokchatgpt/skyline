/**
 * Token Window Renderer
 * 
 * Generates flat message arrays for cache-compatible format.
 */

const fs = require('fs');
const path = require('path');
const TWPEfficiencyScorer = require('./twp-efficiency-scorer');

class TokenWindowRenderer {
  constructor(windowStateManager) {
    if (!windowStateManager) {
      const error = new Error('FATAL: windowStateManager is required for TokenWindowRenderer constructor');
      console.error(error.stack);
      process.exit(1);
    }
    this.windowStateManager = windowStateManager;
    this.efficiencyScorer = new TWPEfficiencyScorer();
    console.log('[TokenWindowRenderer] Initialized with efficiency scorer');
  }

  /**
   * Render token window for a conversation
   * 
   * @param {string} conversationId - Conversation ID
   * @param {object} currentMessage - Current message (optional)
   * @returns {Array} - Flat message array with clean content
   */
  renderTokenWindow(conversationId, currentMessage) {
    console.log(`[TokenWindowRenderer] Rendering token window for conversation ${conversationId}`);
    
    if (!conversationId) {
      const error = new Error('FATAL: conversationId is required for renderTokenWindow');
      console.error(error.stack);
      process.exit(1);
    }
    
    // Get window state
    const windowState = this.windowStateManager.getWindowState(conversationId);
    
    // Build flat message array with clean content (no metadata)
    const messages = [];
    
    // Message registers (FIFO order - oldest to newest)
    if (windowState.messageRegisters && windowState.messageRegisters.length > 0) {
      const sortedRegisters = windowState.messageRegisters
        .sort((a, b) => {
          // Extract number from mN and sort numerically (m1, m2, m3...)
          return parseInt(a.id.substring(1)) - parseInt(b.id.substring(1));
        });
      
      sortedRegisters.forEach(reg => {
        const content = this._truncateIfNeeded(reg.content);
        messages.push({
          role: reg.role || 'unknown',
          content: content // Clean content without visible prefix for bot consumption
        });
      });
    }
    
    // Return flat array (not wrapped in object)
    return messages;
  }

  /**
   * Truncate content if it exceeds maximum length
   * 
   * @param {string} content - Content to truncate
   * @param {number} maxLength - Maximum length
   * @returns {string} - Truncated content
   */
  _truncateIfNeeded(content, maxLength = 128000) {
    if (!content) return '';
    
    // Convert objects to strings
    if (typeof content === 'object') {
      try {
        content = JSON.stringify(content);
      } catch (err) {
        content = String(content);
      }
    }
    
    if (typeof content !== 'string') {
      content = String(content);
    }
    
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + "...";
  }
}

module.exports = TokenWindowRenderer;
