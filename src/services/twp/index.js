/**
 * Token Window Programming (TWP) System
 * 
 * Main entry point for the TWP system that coordinates all components.
 */

const TokenWindowManager = require('./token-window-manager');
const TokenRegistry = require('./token-registry');
const OperationsHandler = require('./operations-handler');
const WindowStateManager = require('./window-state-manager');
const TokenWindowRenderer = require('./token-window-renderer');
const TWPEfficiencyScorer = require('./twp-efficiency-scorer');
const TransformPlugin = require('./transform-plugin');

// Export all components
module.exports = {
  TokenWindowManager,
  TokenRegistry,
  OperationsHandler,
  WindowStateManager,
  TokenWindowRenderer,
  TWPEfficiencyScorer,
  TransformPlugin,
  
  // Factory method to create a fully configured TokenWindowManager instance
  createManager: function() {
    return new TokenWindowManager();
  }
};
