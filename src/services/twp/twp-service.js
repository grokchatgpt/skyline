/**
 * Token Window Programming (TWP) Service - Singleton
 * 
 * Provides a single shared instance of TokenWindowManager that maintains
 * persistent conversation state and cache stats across the entire application.
 * 
 * This follows the same singleton pattern as CMS Integration to ensure
 * both the TokenWindowTransformPlugin and API token counting functions
 * access the same TWP instance with shared state.
 */

const path = require('path');
const logger = require(path.join(process.cwd(), 'services/logging'));

class TWPService {
  constructor() {
    this.tokenWindowManager = null;
    this.initialized = false;
  }

  /**
   * Initialize the TWP service with configuration
   * 
   * @param {Object} config - TWP configuration
   * @returns {Promise<boolean>} - Success status
   */
  async initialize(config = {}) {
    if (this.initialized) {
      logger.warn('[TWPService] Service already initialized, skipping');
      return true;
    }

    try {
      logger.info('[TWPService] Initializing Token Window Programming service');

      // Load configuration from file if not provided
      let twpConfig = config;
      if (!config || Object.keys(config).length === 0) {
        try {
          twpConfig = require(path.join(process.cwd(), 'data/config/token-window.json'));
          logger.info('[TWPService] Loaded configuration from token-window.json');
        } catch (err) {
          logger.error('[TWPService] Failed to load token-window.json');
          throw err;
        }
      }

      // Create the shared TokenWindowManager instance
      const TokenWindowManager = require(path.join(process.cwd(), 'services/twp/token-window-manager'));
      this.tokenWindowManager = new TokenWindowManager(twpConfig);
      
      this.initialized = true;
      logger.info('[TWPService] Token Window Programming service initialized successfully');
      
      return true;
    } catch (error) {
      logger.error(`[TWPService] FATAL: Error initializing TWP service: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get the shared TokenWindowManager instance
   * 
   * @returns {Object|null} - The TokenWindowManager instance or null if not initialized
   */
  getInstance() {
    if (!this.initialized || !this.tokenWindowManager) {
      logger.error('[TWPService] TWP service not initialized - call initialize() first');
      return null;
    }
    
    return this.tokenWindowManager;
  }

  /**
   * Check if the service is initialized
   * 
   * @returns {boolean} - Whether the service is initialized
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Shutdown the TWP service
   */
  async shutdown() {
    if (this.tokenWindowManager && typeof this.tokenWindowManager.shutdown === 'function') {
      await this.tokenWindowManager.shutdown();
    }
    
    this.initialized = false;
    this.tokenWindowManager = null;
    logger.info('[TWPService] TWP service shutdown complete');
  }
}

// Export singleton instance (following CMS pattern)
module.exports = new TWPService();
