import fs from 'fs-extra';
import path from 'path';
import pino from 'pino';

const CONFIG_FILENAME = 'config.toml';

const DEFAULT_CONFIG = {
  apiKeys: {
    claude: null,
    codex: null,
    gemini: null,
    qwen: null,
    opencode: null,
  },
  settings: {
    autoSelectAgents: false,
    defaultAgents: ['claude', 'codex'],
    autoOpenSettingsOnStart: false,
    geminiModel: 'gemini-2.5-flash-latest',
    geminiUseVertex: false,
    geminiUseApiKey: false,
    qwenModel: 'qwen3-coder-plus',
    qwenUseApiKey: false,
    enableWebSearchAgent: true,
    webSearchModel: 'codex',
    collaborationMode: 'collaborative',
    variantSelectionMode: 'manual',
  },
  preferences: {
    colorScheme: 'default',
    updateFrequencyMs: 1000,
    actionTimeoutMs: 0,
    webSearchTimeoutMs: 0,
  },
};

const CONFIG_HEADER = `# Work-Together CLI Configuration
# Set autoSelectAgents = true to skip the agent picker and always load the agents listed in defaultAgents.
# Set enableWebSearchAgent = false to disable the built-in research assistant.
# Set collaborationMode = "variant" to have each agent propose an end-to-end solution before selecting one.
# When collaborationMode = "variant", set variantSelectionMode to "manual" (you choose) or "auto" (the review agent chooses).
# You can toggle collaborationMode in the CLI at any time with Ctrl+V; the selection is saved here.
# Restart the CLI after changing any settings.
`;

function resolveConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error('Unable to resolve home directory for config.');
  const dir = path.join(home, '.work-together');
  const configPath = path.join(dir, CONFIG_FILENAME);
  return { dir, configPath };
}

function isQuotedString(value) {
  return value.startsWith('"') && value.endsWith('"');
}

function unquote(value) {
  return value.slice(1, -1).replace(/\\"/g, '"');
}

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

function parseArray(raw) {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((item) => parsePrimitive(item.trim()))
    .filter((item) => item !== '');
}

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

function stringifySection(name, entries) {
  const lines = [`[${name}]`];
  Object.entries(entries).forEach(([key, value]) => {
    lines.push(`${key} = ${stringifyValue(value)}`);
  });
  return `${lines.join('\n')}\n`;
}

function stringifyConfig(config) {
  const sections = [];
  sections.push(stringifySection('apiKeys', config.apiKeys));
  sections.push(stringifySection('settings', config.settings));
  sections.push(stringifySection('preferences', config.preferences));
  return `${CONFIG_HEADER}${sections.join('')}\n`;
}

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
    // Backwards compatibility for top-level defaultAgents array.
    if (Array.isArray(parsed.defaultAgents)) {
      config.settings.defaultAgents = parsed.defaultAgents.map(String);
    }
  }

  // Normalize arrays and values
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

function serialiseConfig(config) {
  return stringifyConfig(config);
}

export async function initializeConfig() {
  const { dir, configPath } = resolveConfigPath();
  await fs.ensureDir(dir);

  let runtimeConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (await fs.pathExists(configPath)) {
    const raw = await fs.readFile(configPath, 'utf8');
    try {
      const parsed = parseConfigFile(raw);
      runtimeConfig = mergeConfig(parsed);
    } catch (err) {
      runtimeConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  } else {
    await fs.writeFile(configPath, serialiseConfig(DEFAULT_CONFIG), 'utf8');
    runtimeConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  const logger = pino({
    name: 'work-together',
    level: process.env.WORK_TOGETHER_LOG_LEVEL || 'info',
  });

  const state = {
    ...runtimeConfig,
    dir,
    path: configPath,
    logger,
  };

  state.defaultAgents = state.settings.defaultAgents;

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

  return {
    ...state,
    getApiKey(agentId) {
      return state.apiKeys?.[agentId] || null;
    },
    async save(partial) {
      setState(partial);
      await fs.writeFile(configPath, serialiseConfig(state), 'utf8');
    },
  };
}
