import { spawn } from 'child_process';
import chalk from 'chalk';
import { BaseAgent } from './base-agent.js';
import { findExecutable } from '../utils/subscription-auth.js';

const COLOR = '#4285F4';
const MAX_STATUS_UPDATES = 10;
const MAX_CONVERSATION_ENTRIES = 6;

function truncate(text, limit = 800) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

export class GeminiAgent extends BaseAgent {
  constructor({ messageBus, config }) {
    super({
      id: 'gemini',
      name: 'Gemini CLI',
      color: COLOR,
      messageBus,
      config,
      roleProfile: {
        primary: 'Documentation, QA testing, and holistic review',
        secondary: 'User experience polish & knowledge synthesis',
        reviewPreferred: true,
        reviewPriority: 8,
      },
    });
    this.geminiPath = null;
    this.statusUpdates = [];
    this.conversationHistory = [];
    this.apiKey = null;
    this.modelCandidates = Array.from(new Set([
      config.settings?.geminiModel,
      'gemini-2.5-flash-latest',
      'gemini-2.5-pro',
      'gemini-pro',
      'gemini-1.5-flash-latest'
    ].filter(Boolean)));
    this.model = this.modelCandidates[0] || 'gemini-1.5-flash-latest';
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

    this.geminiPath = await findExecutable('gemini');
    if (!this.geminiPath) {
      details.issues.push('Gemini CLI not found on PATH. Install via `pip install google-genai` and ensure `gemini` is available.');
    } else {
      details.notes.push(`Using Gemini CLI at ${this.geminiPath}`);
    }

    this.apiKey = this.config.getApiKey?.(this.id) || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
    if (!this.apiKey) {
      details.notes.push('No GOOGLE_API_KEY detected. Run `gemini login` or set an API key before executing tasks.');
    } else {
      details.notes.push('Using GOOGLE_API_KEY from configuration.');
    }

    if (!this.model) {
      this.model = 'gemini-1.5-flash-latest';
    }
    details.notes.push(`Preferred model: ${this.model}`);

    details.available = details.issues.length === 0;
    this.available = details.available;
    return details;
  }

  async initialize() {
    if (!this.available) return;
    this.statusUpdates = [];
    this.conversationHistory = [];
    this.emitStatus({ actionType: 'init', description: 'Gemini CLI session ready' });
  }

  buildStatusPrompt() {
    if (!this.statusUpdates.length) return '';
    const lines = this.statusUpdates.map((update) => {
      const time = new Date(update.timestamp).toLocaleTimeString();
      return `[${time}] ${update.agentName}: ${update.description}`;
    });
    return `Teammate updates to consider:\n${lines.join('\n')}`;
  }

  buildConversationContext() {
    const sections = [];
    const rosterContext = this.buildRosterContext();
    if (rosterContext) {
      sections.push(rosterContext);
    }
    if (this.conversationHistory.length) {
      const segments = this.conversationHistory.map((entry) => {
        return `[${entry.stage.toUpperCase()} RESULT]\n${entry.response}`;
      });
      sections.push(`Recent Gemini context:\n${segments.join('\n\n')}`);
    }
    const teamContext = this.buildTeamMessagesContext();
    if (teamContext) {
      sections.push(teamContext);
    }
    return sections.join('\n\n');
  }

  recordConversation(stage, prompt, response) {
    if (!response) return;
    this.conversationHistory.push({
      stage,
      prompt: truncate(prompt, 400),
      response: truncate(response, 1200),
    });
    while (this.conversationHistory.length > MAX_CONVERSATION_ENTRIES) {
      this.conversationHistory.shift();
    }
  }

  buildEnv() {
    const env = { ...process.env };
    const useVertex = Boolean(this.config.settings?.geminiUseVertex) || env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
    const useApiKey = Boolean(this.config.settings?.geminiUseApiKey);
    const resolvedKey = this.apiKey || env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null;

    if (useVertex) {
      if (resolvedKey) {
        env.GOOGLE_API_KEY = resolvedKey;
      }
      delete env.GEMINI_API_KEY;
      env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
      return env;
    }

    if (useApiKey && resolvedKey) {
      env.GEMINI_API_KEY = resolvedKey;
      delete env.GOOGLE_API_KEY;
      delete env.GOOGLE_GENAI_USE_VERTEXAI;
      return env;
    }

    // fallback to cached CLI credentials if no key configured
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    delete env.GOOGLE_GENAI_USE_VERTEXAI;
    return env;
  }

  isModelNotFoundError(error) {
    if (!error) return false;
    const message = typeof error === 'string' ? error : error.message || '';
    return /NOT_FOUND/i.test(message) || /model/i.test(message) && /not found/i.test(message);
  }

  async runGeminiPrompt(prompt, stage, timeoutMs = 0) {
    const tried = [];
    for (let i = 0; i < this.modelCandidates.length; i += 1) {
      const candidate = this.modelCandidates[i];
      this.model = candidate;
      try {
        const result = await this.invokeGeminiPrompt(prompt, stage, timeoutMs);
        if (i > 0) {
          this.logger?.info?.({ model: candidate }, 'Gemini CLI fallback model succeeded');
        }
        return result;
      } catch (err) {
        if (this.isModelNotFoundError(err) && i < this.modelCandidates.length - 1) {
          tried.push(candidate);
          this.logger?.warn?.({ candidate, err: err.message }, 'Gemini model unavailable, attempting fallback');
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Gemini CLI models unavailable. Tried: ${tried.concat(this.modelCandidates.slice(-1)).join(', ')}`);
  }

  async invokeGeminiPrompt(prompt, stage, timeoutMs = 0) {
    const statusContext = this.buildStatusPrompt();
    const conversationContext = this.buildConversationContext();
    const parts = [statusContext, conversationContext].filter(Boolean);
    const combinedPrompt = parts.length ? `${parts.join('\n\n')}\n\n${prompt}` : prompt;

    const executable = this.geminiPath || 'gemini';
    const args = [];
    if (this.model) {
      args.push('--model', this.model);
    }
    args.push('--output-format', 'text');
    args.push('-p', combinedPrompt);

    this.logger?.debug?.({ executable, args, timeout: timeoutMs }, 'Executing Gemini CLI');

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        env: this.buildEnv(),
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timeoutId = null;
      let timedOut = false;

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
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

      const clearTimer = () => {
        if (timeoutId) clearTimeout(timeoutId);
      };

      child.on('error', (error) => {
        clearTimer();
        this.logger?.error?.({ error: error.message }, 'Gemini CLI spawn error');
        this.emitStatus({ actionType: 'error', description: `Gemini spawn error: ${error.message.slice(0, 80)}` });
        reject(new Error(`Gemini CLI spawn error: ${error.message}`));
      });

      child.on('close', (code, signal) => {
        clearTimer();

        if (timedOut) {
          const msg = `Gemini CLI timed out after ${timeoutMs}ms`;
          this.logger?.error?.({ timeout: timeoutMs, code, signal }, msg);
          this.emitStatus({ actionType: 'error', description: msg.slice(0, 80) });
          reject(new Error(msg));
          return;
        }

        const text = stdout.trim();
        const errText = stderr.trim();

        this.logger?.debug?.({ code, signal, stdoutLength: text.length, stderrLength: errText.length }, 'Gemini CLI finished');

        if (code !== 0) {
          const message = errText || text || `Gemini CLI exited with code ${code}`;
          const guidance = /GOOGLE_API_KEY|GEMINI_API_KEY|credentials/i.test(message)
            ? `${message.trim()} — run "gemini login" or set GOOGLE_API_KEY before retrying.`
            : message;
          this.logger?.error?.({ code, signal, stderr: errText, stdout: text, model: this.model }, 'Gemini CLI failed');
          if (!this.isModelNotFoundError(guidance)) {
            this.emitStatus({ actionType: 'error', description: `Gemini error: ${guidance.slice(0, 80)}` });
          }
          reject(new Error(guidance));
          return;
        }

        const cleanedText = this.processTeamMessages(text || '');
        this.recordConversation(stage, prompt, cleanedText);
        resolve(cleanedText);
      });
    });
  }

  buildTeammatePlanSummary(agentPlans) {
    if (!Array.isArray(agentPlans) || !agentPlans.length) return 'No teammate plans available yet.';
    return agentPlans
      .filter((entry) => entry.agentId !== this.id)
      .map((entry) => `- ${entry.agentName || entry.agentId}: ${entry.plan}`)
      .join('\n') || 'No teammate plans available yet.';
  }

  buildTeammateAssignments(teamAssignments) {
    if (!teamAssignments) return 'No teammate assignments yet.';
    return Object.entries(teamAssignments)
      .filter(([agentId]) => agentId !== this.id)
      .map(([agentId, text]) => `- ${this.formatAgentLabel(agentId)}: ${text}`)
      .join('\n') || 'No teammate assignments yet.';
  }

  async generatePlan({ userPrompt }) {
    this.emitStatus({ actionType: 'plan', description: 'Drafting plan' });
    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const prompt = `You are Gemini CLI, collaborating with other coding agents.

${rosterSection}

TASK: ${userPrompt}

Produce a concise strategy:
1. Brief analysis (2-3 sentences)
2. Three key steps you would take
3. Recommendation of which agent should report to the user at milestones (Gemini, Claude Code, or Codex)

Keep it under 150 words.

Optional teammate coordination lines:
${coordinationHint}`;
    const response = await this.runGeminiPrompt(prompt, 'plan');
    this.emitStatus({ actionType: 'plan', description: 'Plan ready' });
    return response;
  }

  async negotiateResponsibilities({ consolidatedPlan, agentPlans }) {
    this.emitStatus({ actionType: 'plan', description: 'Negotiating tasks' });
    const teammatePlans = this.buildTeammatePlanSummary(agentPlans);
    const prompt = `You are Gemini CLI in a multi-agent coding collaboration.

Combined multi-agent plan:
${consolidatedPlan}

Teammate proposals so far:
${teammatePlans}

State clearly what YOU (Gemini CLI) will handle next. List 2-4 bullet points beginning with "-". Focus on your strengths (creative ideation, code review, documentation). Do not duplicate teammate tasks.`;
    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const promptWithHint = `${prompt}

${rosterSection}
Optional teammate coordination lines:
${coordinationHint}`;
    const response = await this.runGeminiPrompt(promptWithHint, 'negotiation');
    this.emitStatus({ actionType: 'plan', description: 'Task split proposed' });
    return response;
  }

  async executeTasks({ assignments, teamAssignments, timeoutMs }) {
    this.emitStatus({ actionType: 'exec', description: 'Executing tasks' });
    const teammateAssignments = this.buildTeammateAssignments(teamAssignments);
    const prompt = `You are Gemini CLI executing your assigned responsibilities.

Your assignments:
${assignments}

Teammate focus areas:
${teammateAssignments}

Now execute ONLY your tasks. You may draft code snippets, documentation, or analysis. After major milestones, emit USER_MSG lines (under 80 chars).`;
    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const promptWithHint = `${prompt}

${rosterSection}
Optional teammate coordination:
${coordinationHint}`;
    const response = await this.runGeminiPrompt(promptWithHint, 'exec', timeoutMs || 0);

    const userMsgPattern = /USER_MSG:\s*(.+)/g;
    let match;
    let userMsgFound = false;
    while ((match = userMsgPattern.exec(response)) !== null) {
      this.sendUserMessage(match[1].trim());
      userMsgFound = true;
    }

    this.emitStatus({ actionType: 'exec', description: 'Tasks complete' });
    if (!userMsgFound) {
      this.sendTeamMessage('Gemini QA pass complete. No further issues detected.', { scope: 'group' });
    }
    return response;
  }

  async receiveStatusUpdate(update) {
    if (update.agentId === this.id) return;
    this.statusUpdates.push({
      agentId: update.agentId,
      agentName: update.agentName,
      description: update.description,
      timestamp: update.timestamp || new Date().toISOString(),
    });
    if (this.statusUpdates.length > MAX_STATUS_UPDATES) {
      this.statusUpdates = this.statusUpdates.slice(-MAX_STATUS_UPDATES);
    }
  }

  async receivePlanningUpdate(update) {
    if (!update) return;
    this.statusUpdates.push({
      agentId: update.agentId || 'coordinator',
      agentName: update.agentId || 'Coordinator',
      description:
        update.plan || update.allocation || update.transcript || JSON.stringify(update.assignments || update),
      timestamp: update.timestamp || new Date().toISOString(),
    });
    if (this.statusUpdates.length > MAX_STATUS_UPDATES) {
      this.statusUpdates = this.statusUpdates.slice(-MAX_STATUS_UPDATES);
    }
  }

  async shutdown() {
    this.conversationHistory = [];
    this.statusUpdates = [];
  }
}
