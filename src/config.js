/**
 * Configuration Management Module
 *
 * Handles loading, parsing, and saving TOML configuration files for Work-Together.
 * Configuration is stored in ~/.work-together/config.toml by default.
 *
 * @module config
 */

import fs from 'fs-extra';
import path from 'path';
import pino from 'pino';

/** @constant {string} Name of the configuration file */
const CONFIG_FILENAME = 'config.toml';

/**
 * Default configuration values
 * @constant {Object}
 */
const DEFAULT_CONFIG = {
  apiKeys: {
    claude: null,
    codex: null,
    gemini: null,
    qwen: null,
    opencode: null,
  },
  settings: {
    autoSelectAgents: false,        // Skip agent selection prompt
    defaultAgents: ['claude', 'codex'], // Default agents to use
    autoOpenSettingsOnStart: false, // Auto-open config file on startup
    geminiModel: 'gemini-2.5-flash-latest',
    geminiUseVertex: false,
    geminiUseApiKey: false,
    qwenModel: 'qwen3-coder-plus',
    qwenUseApiKey: false,
    enableWebSearchAgent: true,     // Enable web search functionality
    webSearchModel: 'codex',
    collaborationMode: 'collaborative', // 'collaborative' or 'variant'
    variantSelectionMode: 'manual', // 'manual' or 'auto'
  },
  preferences: {
    colorScheme: 'default',
    updateFrequencyMs: 1000,        // UI update frequency
    actionTimeoutMs: 0,             // Action timeout (0 = no limit)
    webSearchTimeoutMs: 0,          // Web search timeout (0 = no limit)
  },
};

/**
 * TOML configuration file header with usage instructions
 * @constant {string}
 */
const CONFIG_HEADER = `# ╭─────────────────────────────────────────────────────────────╮
# │  Work-Together CLI Configuration                           │
# │  Multi-Agent Collaboration Settings                        │
# ╰─────────────────────────────────────────────────────────────╯
#
# Configuration Guide:
# -------------------
# autoSelectAgents: Set to true to skip agent selection prompt
# defaultAgents: List of agents to use when autoSelectAgents is true
# collaborationMode: "collaborative" (agents work together) or "variant" (separate solutions)
# variantSelectionMode: "manual" (you choose) or "auto" (review agent chooses)
#
# Quick Tips:
# - Use Ctrl+V in the CLI to toggle collaboration mode
# - Use /settings command to open this file
# - Restart the CLI after making changes
#
`;

/**
 * Resolves the configuration directory and file path
 * @returns {{dir: string, configPath: string}} Directory and file path
 * @throws {Error} If home directory cannot be resolved
 */
function resolveConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('Unable to resolve home directory for configuration.');
  }
  const dir = path.join(home, '.work-together');
  const configPath = path.join(dir, CONFIG_FILENAME);
  return { dir, configPath };
}

/**
 * Checks if a value is a quoted string
 * @param {string} value - Value to check
 * @returns {boolean} True if quoted
 */
function isQuotedString(value) {
  return value.startsWith('"') && value.endsWith('"');
}

/**
 * Removes quotes and unescapes a string value
 * @param {string} value - Quoted string
 * @returns {string} Unquoted string
 */
function unquote(value) {
  return value.slice(1, -1).replace(/\\"/g, '"');
}

/**
 * Parses a primitive TOML value (string, number, boolean)
 * @param {string} raw - Raw value string
 * @returns {string|number|boolean} Parsed value
 */
function parsePrimitive(raw) {
  if (isQuotedString(raw)) {
    return unquote(raw);
  }
  if (raw === 'true' || raw === 'false') {
    return raw === 'true';
  }
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/**
 * Parses a TOML array
 * @param {string} raw - Raw array string
 * @returns {Array} Parsed array
 */
function parseArray(raw) {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((item) => parsePrimitive(item.trim()))
    .filter((item) => item !== '');
}

/**
 * Parses a TOML configuration file
 * @param {string} raw - Raw TOML file content
 * @returns {Object} Parsed configuration object
 */
function parseConfigFile(raw) {
  const result = {};
  let currentSection = null;
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1).trim();
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      return;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    const valueRaw = trimmed.slice(separatorIndex + 1).trim();
    const target = currentSection ? (result[currentSection] ||= {}) : result;
    if (valueRaw.startsWith('[') && valueRaw.endsWith(']')) {
      target[key] = parseArray(valueRaw);
    } else {
      target[key] = parsePrimitive(valueRaw);
    }
  });
  return result;
}

/**
 * Stringifies a value for TOML format
 * @param {*} value - Value to stringify
 * @returns {string} TOML-formatted value
 */
function stringifyValue(value) {
  if (Array.isArray(value)) {
    const inner = value.map((item) => stringifyValue(item)).join(', ');
    return `[${inner}]`;
  }
  if (typeof value === 'string') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return String(value);
}

/**
 * Stringifies a configuration section for TOML
 * @param {string} name - Section name
 * @param {Object} entries - Section entries
 * @returns {string} TOML-formatted section
 */
function stringifySection(name, entries) {
  const lines = [`[${name}]`];
  Object.entries(entries).forEach(([key, value]) => {
    lines.push(`${key} = ${stringifyValue(value)}`);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Stringifies the entire configuration to TOML format
 * @param {Object} config - Configuration object
 * @returns {string} TOML-formatted configuration
 */
function stringifyConfig(config) {
  const sections = [];
  sections.push(stringifySection('apiKeys', config.apiKeys));
  sections.push(stringifySection('settings', config.settings));
  sections.push(stringifySection('preferences', config.preferences));
  return `${CONFIG_HEADER}${sections.join('')}\n`;
}

/**
 * Merges parsed configuration with defaults and validates values
 * @param {Object} parsed - Parsed configuration
 * @returns {Object} Merged and validated configuration
 */
function mergeConfig(parsed) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (parsed && typeof parsed === 'object') {
    if (parsed.apiKeys && typeof parsed.apiKeys === 'object') {
      config.apiKeys = { ...config.apiKeys, ...parsed.apiKeys };
    }
    if (parsed.settings && typeof parsed.settings === 'object') {
      config.settings = { ...config.settings, ...parsed.settings };
    }
    if (parsed.preferences && typeof parsed.preferences === 'object') {
      config.preferences = { ...config.preferences, ...parsed.preferences };
    }
    // Backwards compatibility for top-level defaultAgents array
    if (Array.isArray(parsed.defaultAgents)) {
      config.settings.defaultAgents = parsed.defaultAgents.map(String);
    }
  }

  // Normalize and validate arrays and values
  if (!Array.isArray(config.settings.defaultAgents)) {
    config.settings.defaultAgents = [];
  }
  config.settings.defaultAgents = config.settings.defaultAgents.map(String);

  const mode = String(config.settings.collaborationMode || '').toLowerCase();
  config.settings.collaborationMode = mode === 'variant' ? 'variant' : 'collaborative';

  const selectionMode = String(config.settings.variantSelectionMode || '').toLowerCase();
  config.settings.variantSelectionMode = selectionMode === 'auto' ? 'auto' : 'manual';

  const timeout = Number(config.preferences.actionTimeoutMs);
  config.preferences.actionTimeoutMs = Number.isFinite(timeout) && timeout >= 0 ? timeout : 0;

  return config;
}

/**
 * Serializes configuration to TOML format (alias for stringifyConfig)
 * @param {Object} config - Configuration object
 * @returns {string} TOML-formatted configuration
 */
function serialiseConfig(config) {
  return stringifyConfig(config);
}

/**
 * Initializes the configuration system
 *
 * Loads configuration from ~/.work-together/config.toml if it exists,
 * otherwise creates a new config file with default values.
 *
 * @returns {Promise<Object>} Configuration object with utility methods
 * @returns {Object} return.apiKeys - API keys for different agents
 * @returns {Object} return.settings - Application settings
 * @returns {Object} return.preferences - User preferences
 * @returns {string} return.dir - Configuration directory path
 * @returns {string} return.path - Configuration file path
 * @returns {Object} return.logger - Pino logger instance
 * @returns {Function} return.getApiKey - Get API key for an agent
 * @returns {Function} return.save - Save configuration changes
 *
 * @example
 * const config = await initializeConfig();
 * const claudeKey = config.getApiKey('claude');
 * await config.save({ settings: { collaborationMode: 'variant' } });
 */
export async function initializeConfig() {
  const { dir, configPath } = resolveConfigPath();
  await fs.ensureDir(dir);

  let runtimeConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Load existing config or create new one
  if (await fs.pathExists(configPath)) {
    const raw = await fs.readFile(configPath, 'utf8');
    try {
      const parsed = parseConfigFile(raw);
      runtimeConfig = mergeConfig(parsed);
    } catch (err) {
      // If parsing fails, fall back to defaults
      runtimeConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  } else {
    // Create new config file with defaults
    await fs.writeFile(configPath, serialiseConfig(DEFAULT_CONFIG), 'utf8');
    runtimeConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  // Initialize logger
  const logger = pino({
    name: 'work-together',
    level: process.env.WORK_TOGETHER_LOG_LEVEL || 'info',
  });

  // Build state object
  const state = {
    ...runtimeConfig,
    dir,
    path: configPath,
    logger,
  };

  // Add backwards compatibility alias
  state.defaultAgents = state.settings.defaultAgents;

  /**
   * Updates state with partial configuration
   * @param {Object} partial - Partial configuration to merge
   */
  function setState(partial) {
    if (!partial) return;
    if (partial.apiKeys) {
      state.apiKeys = { ...state.apiKeys, ...partial.apiKeys };
    }
    if (partial.settings) {
      state.settings = { ...state.settings, ...partial.settings };
      state.defaultAgents = state.settings.defaultAgents;
    }
    if (partial.preferences) {
      state.preferences = { ...state.preferences, ...partial.preferences };
    }
  }

  // Return configuration object with utility methods
  return {
    ...state,
    /**
     * Gets API key for a specific agent
     * @param {string} agentId - Agent identifier
     * @returns {string|null} API key or null
     */
    getApiKey(agentId) {
      return state.apiKeys?.[agentId] || null;
    },
    /**
     * Saves configuration changes to disk
     * @param {Object} partial - Partial configuration to save
     * @returns {Promise<void>}
     */
    async save(partial) {
      setState(partial);
      await fs.writeFile(configPath, serialiseConfig(state), 'utf8');
    },
  };
}
