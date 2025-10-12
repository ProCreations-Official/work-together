import { spawn } from 'child_process';
import { BaseAgent } from './base-agent.js';
import { findExecutable } from '../utils/subscription-auth.js';

const COLOR = '#FF6A00';
const MAX_STATUS_UPDATES = 10;
const MAX_CONVERSATION_ENTRIES = 6;

function truncate(text, limit = 800) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

export class QwenAgent extends BaseAgent {
  constructor({ messageBus, config }) {
    super({
      id: 'qwen',
      name: 'Qwen Code',
      color: COLOR,
      messageBus,
      config,
      roleProfile: {
        primary: 'Full-stack integration & code reading support',
        secondary: 'Knowledge base lookups and orchestration',
        reviewPreferred: true,
        reviewPriority: 9,
      },
    });
    this.qwenPath = null;
    this.statusUpdates = [];
    this.conversationHistory = [];
    this.apiKey = null;
    this.model = config.settings?.qwenModel || 'qwen3-coder-plus';
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

    this.qwenPath = await findExecutable('qwen');
    if (!this.qwenPath) {
      details.issues.push('Qwen CLI not found in PATH. Install with `npm install -g @qwen-code/qwen-code`.');
    } else {
      details.notes.push(`Using Qwen CLI at ${this.qwenPath}`);
    }

    this.apiKey =
      this.config.getApiKey?.(this.id) ||
      process.env.QWEN_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      process.env.OPENAI_API_KEY ||
      null;

    if (this.apiKey) {
      details.notes.push('Qwen API key detected (DASHSCOPE/API compatible).');
    } else {
      details.notes.push('No explicit API key detected; relying on cached Qwen CLI authentication.');
    }

    if (!this.model) {
      this.model = 'qwen3-coder-plus';
    }
    details.notes.push(`Preferred Qwen model: ${this.model}`);

    details.available = details.issues.length === 0;
    this.available = details.available;
    return details;
  }

  async initialize() {
    if (!this.available) return;
    this.statusUpdates = [];
    this.conversationHistory = [];
    this.emitStatus({ actionType: 'init', description: 'Qwen CLI session ready' });
  }

  buildEnv() {
    const env = { ...process.env };
    if (this.config.settings?.qwenUseApiKey !== false && this.apiKey) {
      env.QWEN_API_KEY = this.apiKey;
      env.DASHSCOPE_API_KEY = this.apiKey;
      env.OPENAI_API_KEY = this.apiKey;
    }
    return env;
  }

  recordConversation(stage, prompt, response) {
    if (!response) return;
    this.conversationHistory.push({
      stage,
      prompt: truncate(prompt, 400),
      response: truncate(response, 1200),
    });
    if (this.conversationHistory.length > MAX_CONVERSATION_ENTRIES) {
      this.conversationHistory = this.conversationHistory.slice(-MAX_CONVERSATION_ENTRIES);
    }
  }

  buildConversationContext() {
    const sections = [];
    const rosterContext = this.buildRosterContext(true);
    if (rosterContext) sections.push(rosterContext);
    if (this.conversationHistory.length) {
      const history = this.conversationHistory
        .map((entry) => `[${entry.stage.toUpperCase()} RESULT]\n${entry.response}`)
        .join('\n\n');
      sections.push(`Recent Qwen contributions:\n${history}`);
    }
    const teamContext = this.buildTeamMessagesContext();
    if (teamContext) sections.push(teamContext);
    return sections.join('\n\n');
  }

  async runQwenPrompt(prompt, stage, timeoutMs = 0) {
    const statusContext = this.buildStatusPrompt();
    const conversationContext = this.buildConversationContext();
    const coordinationHint = this.buildCoordinationHint();
    const fullPrompt = [statusContext, conversationContext, prompt, `Coordination:\n${coordinationHint}`]
      .filter(Boolean)
      .join('\n\n');

    const executable = this.qwenPath || 'qwen';
    const args = ['-p', fullPrompt];
    if (this.model) {
      args.unshift('--model', this.model);
    }

    this.logger?.debug?.({ executable, args, timeout: timeoutMs }, 'Executing Qwen CLI');

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
            if (!child.killed) child.kill('SIGKILL');
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
        this.logger?.error?.({ error: error.message }, 'Qwen CLI spawn error');
        this.emitStatus({ actionType: 'error', description: `Qwen spawn error: ${error.message.slice(0, 80)}` });
        reject(new Error(`Qwen CLI spawn error: ${error.message}`));
      });

      child.on('close', (code, signal) => {
        clearTimer();

        if (timedOut) {
          const msg = `Qwen CLI timed out after ${timeoutMs}ms`;
          this.logger?.error?.({ timeout: timeoutMs, code, signal }, msg);
          this.emitStatus({ actionType: 'error', description: msg.slice(0, 80) });
          reject(new Error(msg));
          return;
        }

        const text = stdout.trim();
        const errText = stderr.trim();

        this.logger?.debug?.({ code, signal, stdoutLength: text.length, stderrLength: errText.length }, 'Qwen CLI finished');

        if (code !== 0) {
          const message = errText || text || `Qwen CLI exited with code ${code}`;
          this.logger?.error?.({ code, signal, stderr: errText, stdout: text }, 'Qwen CLI failed');
          this.emitStatus({ actionType: 'error', description: `Qwen error: ${message.slice(0, 80)}` });
          reject(new Error(message));
          return;
        }

        const cleaned = this.processTeamMessages(text || '');
        this.recordConversation(stage, prompt, cleaned);
        resolve(cleaned);
      });
    });
  }

  async generatePlan({ userPrompt }) {
    this.emitStatus({ actionType: 'plan', description: 'Drafting plan' });
    const rosterSummary = this.buildRosterSummary(true);
    const prompt = `You are Qwen Code collaborating with the agent team.

Current mission: ${userPrompt}

Team roster:
${rosterSummary}

Primary role: ${this.roleProfile.primary}
Secondary role: ${this.roleProfile.secondary}

Deliver a concise plan explaining the integration or support you will provide, how you'll coordinate with teammates, and what artifacts you expect to produce. Limit to 140 words.`;
    const response = await this.runQwenPrompt(prompt, 'plan');
    this.emitStatus({ actionType: 'plan', description: 'Plan ready' });
    return response;
  }

  async negotiateResponsibilities({ consolidatedPlan, agentPlans }) {
    this.emitStatus({ actionType: 'plan', description: 'Negotiating tasks' });
    const teammatePlans = (agentPlans || [])
      .filter((entry) => entry.agentId && entry.agentId !== this.id)
      .map((entry) => `- ${entry.agentName || entry.agentId}: ${entry.plan}`)
      .join('\n') || 'No teammate plans available.';
    const prompt = `Combined team plan:
${consolidatedPlan}

Teammate proposals:
${teammatePlans}

Restate the integration/coordination tasks YOU (Qwen) will handle. Include monitoring responsibilities and how you'll keep teammates aligned. List 3-4 bullet points.`;
    const response = await this.runQwenPrompt(prompt, 'plan');
    this.emitStatus({ actionType: 'plan', description: 'Task split proposed' });
    return response;
  }

  async executeTasks({ assignments, teamAssignments, timeoutMs }) {
    this.emitStatus({ actionType: 'exec', description: 'Executing tasks' });
    const teammateSummary = Object.entries(teamAssignments || {})
      .filter(([agentId]) => agentId !== this.id)
      .map(([agentId, text]) => `- ${this.formatAgentLabel(agentId)}: ${text}`)
      .join('\n') || 'Teammates awaiting responsibilities update.';
    const prompt = `Assignments for Qwen:
${assignments}

Teammate focus summary:
${teammateSummary}

Carry out your responsibilities. Produce automation scripts, integration hints, or review notes as needed. Emit USER_MSG lines when major milestones are complete.`;
    const response = await this.runQwenPrompt(prompt, 'exec', timeoutMs || 0);

    const userMsgPattern = /USER_MSG:\s*(.+)/g;
    let match;
    let userMsgFound = false;
    while ((match = userMsgPattern.exec(response)) !== null) {
      this.sendUserMessage(match[1].trim());
      userMsgFound = true;
    }

    this.emitStatus({ actionType: 'exec', description: 'Tasks complete' });
    if (!userMsgFound) {
      this.sendTeamMessage('Qwen integration support complete. Ready for review hand-off.', { scope: 'group' });
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
