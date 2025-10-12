import { spawn } from 'child_process';
import { BaseAgent } from './base-agent.js';
import { findExecutable } from '../utils/subscription-auth.js';

const COLOR = '#FF8800';
const DEFAULT_TIMEOUT_MS = 60000;
const SUPPORTED_MODELS = new Set(['codex', 'claude', 'gemini', 'qwen']);

function normaliseModel(value) {
  if (!value) return 'codex';
  return String(value).toLowerCase();
}

export class WebSearchAgent extends BaseAgent {
  constructor({ messageBus, config }) {
    super({
      id: 'web-search',
      name: 'Web Search',
      color: COLOR,
      messageBus,
      config,
      roleProfile: {
        primary: 'On-demand research and knowledge gathering',
        secondary: 'Summaries of search findings for teammates',
        reviewPreferred: false,
        reviewPriority: -100,
      },
    });
    this.model = normaliseModel(config.settings?.webSearchModel || 'codex');
    this.enabled = config.settings?.enableWebSearchAgent !== false;
    this.executable = null;
    this.requestUnsubscribe = null;
    this.instructionsBroadcasted = false;
    const preferredTimeout = Number(config.preferences?.webSearchTimeoutMs || config.preferences?.actionTimeoutMs);
    this.timeoutMs =
      Number.isFinite(preferredTimeout) && preferredTimeout > 0 ? preferredTimeout : DEFAULT_TIMEOUT_MS;
    this.geminiModel = config.settings?.geminiModel || null;
    this.qwenModel = config.settings?.qwenModel || null;
  }

  resolveExecutableForModel(model) {
    switch (model) {
      case 'codex':
        return 'codex';
      case 'claude':
        return 'claude';
      case 'gemini':
        return 'gemini';
      case 'qwen':
        return 'qwen';
      default:
        return null;
    }
  }

  async checkAvailability() {
    const details = {
      id: this.id,
      name: this.name,
      color: COLOR,
      available: false,
      issues: [],
      notes: [],
    };

    if (!this.enabled) {
      details.issues.push('Disabled via enableWebSearchAgent = false.');
      this.available = false;
      return details;
    }

    if (!SUPPORTED_MODELS.has(this.model)) {
      details.issues.push(
        `Unsupported webSearchModel "${this.model}". Supported models: ${Array.from(SUPPORTED_MODELS).join(', ')}.`
      );
      this.available = false;
      return details;
    }

    const executableName = this.resolveExecutableForModel(this.model);
    this.executable = await findExecutable(executableName);
    if (!this.executable) {
      details.issues.push(
        `${executableName} CLI not found. Install the CLI and ensure it is available on PATH.`
      );
    } else {
      details.notes.push(`Using ${executableName} CLI at ${this.executable}`);
    }

    if (this.model === 'codex') {
      details.notes.push('Will invoke `codex --web-search` for research tasks.');
    } else {
      details.notes.push(`Will prompt ${this.model} CLI for research-style responses.`);
    }

    details.available = details.issues.length === 0;
    this.available = details.available;
    return details;
  }

  async initialize() {
    if (!this.available) return;
    if (this.requestUnsubscribe) {
      this.requestUnsubscribe();
    }
    this.requestUnsubscribe = this.messageBus.onRequest((request) => {
      if (!request || request.type !== 'web-search') return;
      if (request.targetAgentId && request.targetAgentId !== this.id) return;
      if (!request.query) return;
      this.handleSearchRequest(request).catch((err) => {
        this.logger?.debug?.({ err }, 'WebSearchAgent request handler error');
      });
    });
    this.emitStatus({
      actionType: 'init',
      description: `Web search agent ready (${this.model})`,
    });
  }

  async generatePlan() {
    return 'Standing by for WEB_SEARCH directives; will share research summaries on demand.';
  }

  async negotiateResponsibilities() {
    return 'No fixed allocation. Responds to WEB_SEARCH directives from teammates.';
  }

  async executeTasks() {
    return 'Execution driven by incoming WEB_SEARCH requests; no direct assignments.';
  }

  setTeamRoster(roster) {
    super.setTeamRoster(roster);
    if (!this.instructionsBroadcasted && Array.isArray(roster) && roster.length > 1) {
      this.instructionsBroadcasted = true;
      this.sendGroupMessage(
        'Web search assistant online. Request research with `WEB_SEARCH: your query` or add context `WEB_SEARCH[focus: security]: ...`.'
      );
    }
  }

  buildEnvForModel() {
    const env = { ...process.env };
    if (this.model === 'codex') {
      const apiKey =
        this.config.getApiKey?.('codex') ||
        process.env.OPENAI_API_KEY ||
        null;
      if (apiKey) {
        env.OPENAI_API_KEY = apiKey;
      }
    } else if (this.model === 'claude') {
      const apiKey = this.config.getApiKey?.('claude') || process.env.ANTHROPIC_API_KEY || null;
      if (apiKey) {
        env.ANTHROPIC_API_KEY = apiKey;
      }
      env.CLAUDE_CODE_TELEMETRY_DISABLED = '1';
    } else if (this.model === 'gemini') {
      const apiKey =
        this.config.getApiKey?.('gemini') ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        null;
      const useVertex = Boolean(this.config.settings?.geminiUseVertex) || env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
      const useApiKey = Boolean(this.config.settings?.geminiUseApiKey);
      if (useVertex) {
        if (apiKey) {
          env.GOOGLE_API_KEY = apiKey;
        }
        env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
        delete env.GEMINI_API_KEY;
      } else if (useApiKey && apiKey) {
        env.GEMINI_API_KEY = apiKey;
        delete env.GOOGLE_API_KEY;
        delete env.GOOGLE_GENAI_USE_VERTEXAI;
      }
    } else if (this.model === 'qwen') {
      const apiKey =
        this.config.getApiKey?.('qwen') ||
        process.env.QWEN_API_KEY ||
        process.env.DASHSCOPE_API_KEY ||
        process.env.OPENAI_API_KEY ||
        null;
      if (apiKey) {
        env.QWEN_API_KEY = apiKey;
        env.DASHSCOPE_API_KEY = apiKey;
      }
    }
    return env;
  }

  async handleSearchRequest(request) {
    const query = String(request.query || '').trim();
    if (!query) return;
    const instructions = typeof request.instructions === 'string' ? request.instructions.trim() : null;
    const contextNote = instructions ? ` (${instructions})` : '';
    this.emitStatus({
      actionType: 'exec',
      description: `Searching for "${query.slice(0, 60)}"${contextNote}`,
    });

    try {
      const rawOutput = await this.performSearch({ query, instructions });
      const message = this.formatReport({ query, instructions, rawOutput });
      if (request.requestingAgentId) {
        this.sendDirectMessage(request.requestingAgentId, message);
      } else {
        this.sendGroupMessage(message);
      }
      this.emitStatus({
        actionType: 'exec',
        description: `Search ready for "${query.slice(0, 60)}"`,
      });
    } catch (err) {
      const description = `Search failed for "${query.slice(0, 60)}": ${err.message || err}`;
      this.emitStatus({
        actionType: 'error',
        description: description.slice(0, 100),
      });
      const failureMessage = description.length > 780 ? `${description.slice(0, 779)}…` : description;
      if (request.requestingAgentId) {
        this.sendDirectMessage(request.requestingAgentId, failureMessage);
      } else {
        this.sendGroupMessage(failureMessage);
      }
    }
  }

  async performSearch({ query, instructions }) {
    if (this.model === 'codex') {
      return this.runCodexSearch(query);
    }
    return this.runPromptSearch(query, instructions);
  }

  async runCodexSearch(query) {
    const executable = this.executable || 'codex';
    const args = ['--web-search', query];
    const env = this.buildEnvForModel();
    const output = await this.runCommand({
      executable,
      args,
      env,
      timeoutMs: this.timeoutMs,
    });
    if (!output.trim()) {
      throw new Error('Codex web search returned no content.');
    }
    return output;
  }

  buildPrompt(query, instructions) {
    const today = new Date().toISOString().slice(0, 10);
    const focusLine = instructions ? `Focus: ${instructions}.` : 'Focus on shipping actionable findings for the calling agent.';
    return `You are a specialised research assistant with reliable browsing capability as of ${today}.
Task: run a web search that addresses the following query:
"${query}"

${focusLine}

Produce a tight report under:
1. Summary (<=120 words)
2. Key findings (bullet list with source name + URL + one insight)
3. Follow-up recommendations (optional)

If live data is unavailable, clearly state the limitation and provide the best available context.`;
  }

  async runPromptSearch(query, instructions) {
    const prompt = this.buildPrompt(query, instructions);
    const env = this.buildEnvForModel();
    const timeoutMs = this.timeoutMs;

    if (this.model === 'claude') {
      const executable = this.executable || 'claude';
      const args = ['-p', prompt, '--permission-mode', 'bypassPermissions'];
      return this.runCommand({ executable, args, env, timeoutMs });
    }

    if (this.model === 'gemini') {
      const executable = this.executable || 'gemini';
      const args = [];
      if (this.geminiModel) {
        args.push('--model', this.geminiModel);
      }
      args.push('--output-format', 'text', '-p', prompt);
      return this.runCommand({ executable, args, env, timeoutMs });
    }

    if (this.model === 'qwen') {
      const executable = this.executable || 'qwen';
      const args = ['-p', prompt];
      if (this.qwenModel) {
        args.unshift('--model', this.qwenModel);
      }
      return this.runCommand({ executable, args, env, timeoutMs });
    }

    throw new Error(`Unsupported web search model: ${this.model}`);
  }

  runCommand({ executable, args, env, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        env,
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer = null;

      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }, timeoutMs);
      }

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`${executable} spawn error: ${error.message}`));
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);

        if (timedOut) {
          reject(new Error(`${executable} timed out after ${timeoutMs}ms`));
          return;
        }

        if (code !== 0) {
          const message = stderr.trim() || stdout.trim() || `${executable} exited with code ${code}`;
          reject(new Error(message));
          return;
        }

        const text = stdout.trim();
        if (text) {
          resolve(text);
        } else if (stderr.trim()) {
          resolve(stderr.trim());
        } else {
          resolve('');
        }
      });
    });
  }

  tryParseJson(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          return JSON.parse(line);
        } catch (innerErr) {
          continue;
        }
      }
    }
    return null;
  }

  formatReport({ query, instructions, rawOutput }) {
    const parsed = this.tryParseJson(rawOutput);
    let body = '';
    if (parsed && Array.isArray(parsed)) {
      body = parsed
        .slice(0, 3)
        .map((entry, index) => {
          if (!entry) return null;
          const title = entry.title || entry.name || `Result ${index + 1}`;
          const url = entry.url || entry.link || '';
          const snippet = entry.snippet || entry.summary || '';
          const parts = [`${index + 1}. ${title}`];
          if (url) parts.push(url);
          if (snippet) parts.push(snippet);
          return parts.join(' – ');
        })
        .filter(Boolean)
        .join('\n');
    } else if (parsed && typeof parsed === 'object' && parsed !== null) {
      const summary = parsed.summary || parsed.overview || '';
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const items = results.slice(0, 3).map((item, index) => {
        if (!item) return null;
        const title = item.title || item.name || `Result ${index + 1}`;
        const url = item.url || item.link || '';
        const insight = item.snippet || item.summary || item.description || '';
        const pieces = [`${index + 1}. ${title}`];
        if (url) pieces.push(url);
        if (insight) pieces.push(insight);
        return pieces.join(' – ');
      }).filter(Boolean);
      body = [summary, items.length ? 'Top hits:\n' + items.join('\n') : '']
        .filter((segment) => segment && segment.trim())
        .join('\n\n');
    } else {
      const lines = (rawOutput || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      body = lines.slice(0, 10).join('\n');
    }

    const header = instructions
      ? `Search "${query}" (${instructions})`
      : `Search "${query}"`;
    const timestamp = new Date().toISOString();
    const message = `${header} →\n${body}\n[${timestamp}]`;
    return message.length > 780 ? `${message.slice(0, 779)}…` : message;
  }

  async shutdown() {
    if (this.requestUnsubscribe) {
      this.requestUnsubscribe();
      this.requestUnsubscribe = null;
    }
  }
}
