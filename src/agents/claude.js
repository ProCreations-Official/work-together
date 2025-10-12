import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { BaseAgent } from './base-agent.js';
import {
  detectClaudeSubscriptionAuth,
  findExecutable,
  verifyClaudeCliLogin,
} from '../utils/subscription-auth.js';
const COLOR = '#8A2BE2';
const MAX_STATUS_UPDATES = 10;
const MAX_CONVERSATION_ENTRIES = 6;

function truncate(text, limit = 600) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

export class ClaudeAgent extends BaseAgent {
  constructor({ messageBus, config }) {
    super({
      id: 'claude',
      name: 'Claude Code',
      color: COLOR,
      messageBus,
      config,
      roleProfile: {
        primary: 'Front-end UX implementation and user-facing communication',
        secondary: 'Team coordination & documentation',
        reviewPreferred: false,
        reviewPriority: 2,
      },
    });
    this.claudePath = null;
    this.authMode = 'unknown';
    this.sessionId = null;
    this.statusUpdates = [];
    this.apiKey = null;
    this.conversationHistory = [];
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

    this.claudePath = await findExecutable('claude');
    if (!this.claudePath) {
      details.notes.push('Claude CLI not found via PATH lookup; will attempt default alias.');
    }

    this.apiKey = this.config.getApiKey?.(this.id) || process.env.ANTHROPIC_API_KEY || null;
    const subscriptionAuth = await detectClaudeSubscriptionAuth();

    if (subscriptionAuth.error) {
      details.issues.push(`Claude auth check failed: ${subscriptionAuth.error.message}`);
    }

    let loginStatus = null;
    if (!this.apiKey) {
      loginStatus = await verifyClaudeCliLogin(this.claudePath);
      if (loginStatus?.path) {
        this.claudePath = loginStatus.path;
      }
    }

    if (this.apiKey) {
      this.authMode = 'apiKey';
      details.notes.push('Using ANTHROPIC_API_KEY for authentication.');
    } else if (loginStatus?.ok) {
      this.authMode = 'subscription-cli';
      details.notes.push('Claude CLI login detected (subscription credentials).');
    } else if (subscriptionAuth.hasAuthToken) {
      this.authMode = 'subscription-cli';
      details.notes.push('Claude CLI subscription tokens detected from previous login.');
    } else if (this.claudePath) {
      this.authMode = 'subscription-cli';
      const reason = loginStatus?.message || 'Login verification failed; prompts may request you to run "claude login".';
      details.notes.push(`Using Claude CLI at ${this.claudePath}. ${reason}`.trim());
    } else {
      this.authMode = 'unknown';
      const reason = loginStatus?.message || 'Run "claude login" in your terminal.';
      details.issues.push(`Unable to verify Claude CLI login. ${reason}`.trim());
    }

    details.available = details.issues.length === 0;
    this.available = details.available;
    return details;
  }

  async initialize() {
    if (!this.available) return;
    this.statusUpdates = [];
    this.conversationHistory = [];
    this.emitStatus({ actionType: 'init', description: 'Claude CLI session ready' });
  }

  async generatePlan({ userPrompt }) {
    this.emitStatus({ actionType: 'plan', description: 'Drafting plan' });
    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const prompt = `You are Claude Code, working alongside OpenAI Codex in a collaborative multi-agent system.

${rosterSection}

TASK: ${userPrompt}

IMPORTANT - THIS IS THE PLANNING PHASE ONLY:
- DO NOT write any code or create any files yet
- DO NOT execute any commands
- ONLY provide your strategic plan and analysis
- You will see Codex's plan, then negotiate responsibilities, then execute

Your response should include:
1. Brief analysis of the task (2-3 sentences)
2. Your proposed 3-step approach
3. Which agent (Claude Code or Codex) should send user messages at key milestones

Keep it concise (under 150 words). Remember: This is PLANNING, not execution.

Optional teammate coordination:
${coordinationHint}`;
    const response = await this.runPrompt(prompt, 'plan');
    this.emitStatus({ actionType: 'plan', description: 'Plan ready' });
    return response;
  }

  async negotiateResponsibilities({ consolidatedPlan, agentPlans }) {
    this.emitStatus({ actionType: 'plan', description: 'Negotiating tasks' });
    const teammatePlans = (agentPlans || [])
      .filter((entry) => entry.agentId && entry.agentId !== this.id)
      .map((entry) => `- ${entry.agentName || entry.agentId}: ${entry.plan}`)
      .join('\n') || 'No teammate plans available.';
    const selfPlan = (agentPlans || []).find((entry) => entry.agentId === this.id)?.plan || 'No previous plan captured.';
    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const prompt = `You are Claude Code in a multi-agent collaboration with OpenAI Codex.

${rosterSection}

YOUR PREVIOUS PLAN:
${selfPlan}

TEAMMATE PLANS:
${teammatePlans}

COMBINED PLAN FROM ALL AGENTS:
${consolidatedPlan}

IMPORTANT - THIS IS TASK NEGOTIATION, NOT EXECUTION:
- DO NOT write code or create files yet
- Review what Codex proposed
- State which specific tasks YOU (Claude Code) will handle
- Avoid duplicating Codex's proposed tasks
- Leverage your strengths: CLI tools, file operations, bash commands

Your response (under 120 words):
"I (Claude Code) will handle:
- [specific task 1]
- [specific task 2]
- etc."

Optional teammate coordination:
${coordinationHint}

Remember: This is negotiation, execution comes next.`;
    const response = await this.runPrompt(prompt, 'plan');
    this.emitStatus({ actionType: 'plan', description: 'Task split proposed' });
    return response;
  }

  async executeTasks({ assignments, teamAssignments, timeoutMs }) {
    this.emitStatus({ actionType: 'exec', description: 'Executing tasks' });
    const teammateFocus = Object.entries(teamAssignments || {})
      .filter(([agentId]) => agentId !== this.id)
      .map(([agentId, text]) => `- ${this.formatAgentLabel(agentId)}: ${text}`)
      .join('\n') || 'Teammates awaiting responsibilities update.';
    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const prompt = `You are Claude Code. You and OpenAI Codex have divided the work. NOW IT'S TIME TO EXECUTE.

${rosterSection}

YOUR ASSIGNED TASKS:
${assignments}

TEAMMATE FOCUS AREAS:
${teammateFocus}

IMPORTANT - NOW YOU CAN EXECUTE:
- Write code, create files, run bash commands as needed
- ONLY work on YOUR assigned tasks (Codex handles theirs)
- After each major milestone, send a user message:
  USER_MSG: [brief update under 80 chars]

Example user messages:
USER_MSG: Created project structure
USER_MSG: Set up configuration files
USER_MSG: Ready for testing ✓

Optional teammate coordination:
${coordinationHint}

Begin execution now. Take as long as needed to complete YOUR tasks properly.`;
    const response = await this.runPrompt(prompt, 'exec', 0); // No timeout

    // Extract and send user messages
    const userMsgPattern = /USER_MSG:\s*(.+)/g;
    let match;
    while ((match = userMsgPattern.exec(response)) !== null) {
      this.sendUserMessage(match[1].trim());
    }

    this.emitStatus({ actionType: 'exec', description: 'Tasks complete' });
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
    this.sessionId = null;
  }

  recordConversation(stage, prompt, response) {
    if (!response) return;
    this.conversationHistory.push({
      stage,
      prompt: truncate(prompt, 200),
      response: truncate(response, 800),
    });
    while (this.conversationHistory.length > MAX_CONVERSATION_ENTRIES) {
      this.conversationHistory.shift();
    }
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
      sections.push(`Recent teammate-aware context for Claude:\n${segments.join('\n\n')}`);
    }
    const teamContext = this.buildTeamMessagesContext();
    if (teamContext) {
      sections.push(teamContext);
    }
    return sections.join('\n\n');
  }

  buildStatusPrompt() {
    if (!this.statusUpdates.length) return '';
    const lines = this.statusUpdates.map((update) => {
      const time = new Date(update.timestamp).toLocaleTimeString();
      return `[${time}] ${update.agentName}: ${update.description}`;
    });
    return `Teammate updates to consider:\n${lines.join('\n')}`;
  }

  buildEnv() {
    const env = { ...process.env, CLAUDE_CODE_TELEMETRY_DISABLED: '1' };
    if (this.authMode === 'apiKey' && this.apiKey) {
      env.ANTHROPIC_API_KEY = this.apiKey;
    }
    return env;
  }

  async runPrompt(prompt, actionType, timeoutMs = 0) {
    const executable = this.claudePath || 'claude';

    const statusPrompt = this.buildStatusPrompt();
    const conversationPrompt = this.buildConversationContext();
    const combinedContext = [statusPrompt, conversationPrompt].filter(Boolean).join('\n\n');
    const args = [
      '-p',
      prompt,
      '--permission-mode',
      'bypassPermissions',
    ];

    if (combinedContext) {
      args.push('--append-system-prompt', combinedContext);
    }

    // Log the command for debugging
    this.logger?.debug?.({ executable, args, timeout: timeoutMs }, 'Executing Claude CLI');

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        env: this.buildEnv(),
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin, pipe stdout/stderr
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timeoutId = null;
      let timedOut = false;

      // Set timeout (0 = no timeout)
      const timeout = timeoutMs || 0;
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }, timeout);
      }

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        this.logger?.error?.({ error: error.message }, 'Claude CLI spawn error');
        this.emitStatus({ actionType: 'error', description: `Claude spawn error: ${error.message.slice(0, 80)}` });
        reject(new Error(`Claude CLI spawn error: ${error.message}`));
      });

      child.on('close', (code, signal) => {
        if (timeoutId) clearTimeout(timeoutId);

        if (timedOut) {
          const msg = `Claude CLI timed out after ${timeout}ms`;
          this.logger?.error?.({ timeout, code, signal }, msg);
          this.emitStatus({ actionType: 'error', description: msg.slice(0, 80) });
          reject(new Error(msg));
          return;
        }

        const text = stdout.trim();
        const errText = stderr.trim();

        this.logger?.debug?.({ code, signal, stdoutLength: text.length, stderrLength: errText.length }, 'Claude CLI finished');

        if (code !== 0) {
          const message = errText || text || `Claude CLI exited with code ${code}`;
          this.logger?.error?.({ code, signal, stderr: errText, stdout: text }, 'Claude CLI failed');
          this.emitStatus({ actionType: 'error', description: `Claude error: ${message.slice(0, 80)}` });
          reject(new Error(message));
          return;
        }

        if (!text) {
          const msg = 'Claude CLI returned no output';
          this.logger?.warn?.({ stderr: errText }, msg);
          this.emitStatus({ actionType: 'error', description: msg });
          reject(new Error(msg));
          return;
        }

        const cleanedText = this.processTeamMessages(text);
        this.emitStatus({ actionType, description: cleanedText.slice(0, 80) });
        this.recordConversation(actionType, prompt, cleanedText);
        resolve(cleanedText);
      });
    });
  }
}
