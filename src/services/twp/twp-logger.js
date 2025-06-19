/**
 * TWP Logger
 * 
 * Dedicated logger for Token Window Programming operations.
 * Logs token window state before and after operations to data/logs/twp.txt
 * for post-mortem analysis.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Helper function to truncate content for log display
function truncateContent(content, maxLength = 100) {
  if (!content) return '[Empty]';
  
  if (typeof content !== 'string') {
    try {
      content = JSON.stringify(content);
    } catch (err) {
      content = String(content);
    }
  }
  
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

// Helper function to format operation parameters for log display
function formatOperationParams(params) {
  if (!params) return '';
  
  const parts = [];
  
  if (params.registerIds) parts.push(Array.isArray(params.registerIds) ? params.registerIds.join(',') : params.registerIds);
  if (params.registerId) parts.push(params.registerId);
  if (params.content) parts.push(`"${truncateContent(params.content, 100)}"`);
  
  return parts.join(', ');
}

class TWPLogger {
  constructor() {
    this.logFilePath = path.join(process.cwd(), 'data/logs/twp.txt');
    
    // Ensure the logs directory exists
    const logsDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    // Create or append to log file
    if (!fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, '--- TWP LOG STARTED ---\n\n');
    }
  }

  /**
   * Log window state before or after operations
   * 
   * @param {string} conversationId - Conversation ID
   * @param {string} requestId - Request ID
   * @param {object} windowState - Window state object
   * @param {string} phase - 'BEFORE' or 'AFTER'
   */
  logWindowState(conversationId, requestId, windowState, phase) {
    const timestamp = new Date().toISOString();
    const divider = '='.repeat(80);
    
    // Generate log entry
    let logEntry = `${divider}\n`;
    logEntry += `${timestamp} | ${phase} OPERATIONS | Conversation: ${conversationId} | Request: ${requestId}\n`;
    logEntry += `${divider}\n\n`;
    
    // Format token window view
    logEntry += `TOKEN WINDOW ${phase} OPERATIONS:\n\n`;
    
    // Format message registers in a more readable way
    const messageRegisters = windowState.messageRegisters || [];
    if (messageRegisters.length > 0) {
      logEntry += `MESSAGE REGISTERS (${messageRegisters.length}):\n`;
      for (const register of messageRegisters) {
        logEntry += `#${register.id} [${register.role}]: ${truncateContent(register.content)}\n`;
      }
      logEntry += '\n';
    } else {
      logEntry += `MESSAGE REGISTERS (0):\n[None]\n\n`;
    }
    
    // Format thought registers in a more readable way
    const thoughtRegisters = windowState.thoughtRegisters || [];
    if (thoughtRegisters.length > 0) {
      logEntry += `THOUGHT REGISTERS (${thoughtRegisters.length}):\n`;
      for (const register of thoughtRegisters) {
        logEntry += `#${register.id}: ${truncateContent(register.content)}\n`;
        if (register.referenceIds && register.referenceIds.length > 0) {
          logEntry += `  References: ${register.referenceIds.join(', ')}\n`;
        }
      }
      logEntry += '\n';
    } else {
      logEntry += `THOUGHT REGISTERS (0):\n[None]\n\n`;
    }
    
    // If this is the AFTER phase, log all operations and their results
    if (phase === 'AFTER') {
      // Log all operation results if they exist
      if (windowState.operationResults && windowState.operationResults.length > 0) {
        logEntry += `OPERATION RESULTS (${windowState.operationResults.length}):\n`;
        for (const result of windowState.operationResults) {
          if (result.type === 'new' && result.registerId) {
            logEntry += `new(...) => ${result.registerId}\n`;
          } else if (result.type === 'get' && result.registers) {
            logEntry += `get(...) => ${result.registers.length} registers\n`;
            for (const register of result.registers) {
              logEntry += `  #${register.id}: ${truncateContent(register.content)}\n`;
            }
          } else if (result.type === 'set' || result.type === 'del') {
            logEntry += `${result.type}(...) => success: ${result.success}\n`;
          }
        }
        logEntry += '\n';
      }
      
      // Log all operations processed in this request
      if (windowState.previousOperations && windowState.previousOperations.length > 0) {
        const allOps = windowState.previousOperations.map(op => 
          `${op.operationType}(${formatOperationParams(op.parameters)})${op.resultId ? ' => ' + op.resultId : ''}`
        ).join('\n  ');
        
        logEntry += `ALL OPERATIONS:\n  ${allOps}\n\n`;
      }
    }
    
    logEntry += `${divider}\n\n`;
    
    // Append to log file
    fs.appendFileSync(this.logFilePath, logEntry);
  }
}

// Export singleton instance
module.exports = new TWPLogger();
