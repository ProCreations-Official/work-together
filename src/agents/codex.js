import chalk from 'chalk';
import { BaseAgent } from './base-agent.js';
import { detectCodexSubscriptionAuth, findExecutable } from '../utils/subscription-auth.js';

const COLOR = '#00B67A';

export class CodexAgent extends BaseAgent {
  constructor({ messageBus, config }) {
    super({
      id: 'codex',
      name: 'OpenAI Codex',
      color: COLOR,
      messageBus,
      config,
      roleProfile: {
        primary: 'Backend logic, complex implementation, and automation',
        secondary: 'Architecture decisions & performance tuning',
        reviewPreferred: false,
        reviewPriority: 4,
      },
    });
    this.module = null;
    this.client = null;
    this.thread = null;
    this.statusColor = chalk.hex(COLOR);
    this.authMode = 'unknown';
    this.codexSubscription = null;
    this.originalCodexPreferredAuth = process.env.CODEX_PREFERRED_AUTH_METHOD || null;
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

    try {
      this.module = await import('@openai/codex-sdk');
    } catch (err) {
      details.issues.push('SDK not installed. Run "npm install @openai/codex-sdk".');
    }

    const codexBinary = await findExecutable('codex');
    if (!codexBinary) {
      details.issues.push('Codex CLI not found. Install with "npm install -g @openai/codex".');
    }

    this.apiKey = this.config.getApiKey?.(this.id) || process.env.OPENAI_API_KEY || null;
    const subscriptionAuth = await detectCodexSubscriptionAuth();

    if (subscriptionAuth.error) {
      details.issues.push(`Codex auth check failed: ${subscriptionAuth.error.message}`);
    }

    if (this.apiKey) {
      this.authMode = 'apiKey';
    } else if (subscriptionAuth.hasTokens) {
      this.authMode = 'subscription';
      this.codexSubscription = subscriptionAuth;
      details.notes.push('Using ChatGPT Plus/Pro subscription credentials from the Codex CLI login.');
      if (subscriptionAuth.preferredAuthMethod && subscriptionAuth.preferredAuthMethod !== 'chatgpt') {
        details.notes.push(`Codex preferred_auth_method currently "${subscriptionAuth.preferredAuthMethod}".`);
      }
    } else {
      this.authMode = 'unknown';
      details.issues.push('Missing OPENAI_API_KEY or Codex subscription login (run "codex login").');
    }

    details.available = details.issues.length === 0;
    this.available = details.available;
    return details;
  }

  async initialize({ userPrompt }) {
    if (!this.available || !this.module) return;
    const { Codex } = this.module;
    if (!Codex) throw new Error('Codex export not found');
    const workspaceDir = process.cwd();
    const threadOptions = {
      sandboxMode: 'danger-full-access',
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true,
    };
    if (this.authMode === 'apiKey' && this.apiKey) {
      this.emitStatus({ actionType: 'init', description: 'Starting Codex thread with API key (full auto mode)' });
      this.client = new Codex({ apiKey: this.apiKey });
    } else if (this.authMode === 'subscription') {
      this.emitStatus({ actionType: 'init', description: 'Starting Codex thread via subscription login (full auto mode)' });
      if (this.codexSubscription?.preferredAuthMethod) {
        process.env.CODEX_PREFERRED_AUTH_METHOD = this.codexSubscription.preferredAuthMethod;
      } else if (!process.env.CODEX_PREFERRED_AUTH_METHOD) {
        process.env.CODEX_PREFERRED_AUTH_METHOD = 'chatgpt';
      }
      this.client = new Codex();
    } else {
      throw new Error('Codex agent has no authentication method configured.');
    }

    this.thread = await this.client.startThread({
      ...threadOptions,
      metadata: { userPrompt },
    });
    this.emitStatus({ actionType: 'init', description: 'Codex ready in full auto mode' });
  }

  async generatePlan({ userPrompt }) {
    if (!this.thread) {
      return 'Codex not initialized.';
    }
    this.emitStatus({ actionType: 'plan', description: 'Drafting plan' });

    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const planningPrompt = `You are OpenAI Codex, working alongside Claude Code in a collaborative multi-agent system.

${rosterSection}

TASK: ${userPrompt}

IMPORTANT - THIS IS THE PLANNING PHASE ONLY:
- DO NOT write any code or create any files yet
- DO NOT execute any commands
- ONLY provide your strategic plan and analysis
- You will see Claude Code's plan, then negotiate responsibilities, then execute

Your response should include:
1. Brief analysis of the task (2-3 sentences)
2. Your proposed 3-step approach
3. Which agent (Claude Code or Codex) should send user messages at key milestones

Keep it concise (under 150 words). Remember: This is PLANNING, not execution.

Optional teammate coordination:
${coordinationHint}`;

    const { finalText, transcriptParts } = await this.runTurnStreamed(planningPrompt, 'plan');

    this.emitStatus({ actionType: 'plan', description: 'Plan ready' });
    const combined = transcriptParts.length ? transcriptParts.join('\n') : finalText;
    const cleaned = this.processTeamMessages(combined);
    return (cleaned || '').trim();
  }

  async negotiateResponsibilities({ consolidatedPlan, agentPlans }) {
    if (!this.thread) return 'Codex not initialized.';
    this.emitStatus({ actionType: 'plan', description: 'Negotiating tasks' });

    const teammatePlans = (agentPlans || [])
      .filter((entry) => entry.agentId && entry.agentId !== this.id)
      .map((entry) => `- ${entry.agentName || entry.agentId}: ${entry.plan}`)
      .join('\n') || 'No teammate plans available.';
    const selfPlan = (agentPlans || []).find((entry) => entry.agentId === this.id)?.plan || 'No previous plan captured.';

    if (this.client?.addMessage && this.thread?.id) {
      try {
        await this.client.addMessage({
          threadId: this.thread.id,
          role: 'system',
          content: `Planning recap for negotiation:\nYour prior plan:\n${selfPlan}\n\nTeammate proposals:\n${teammatePlans}`,
        });
      } catch (err) {
        this.logger?.debug?.({ err }, 'Codex negotiation context injection failed');
      }
    }

    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const negotiationPrompt = `You are OpenAI Codex in a multi-agent collaboration with Claude Code.

${rosterSection}

COMBINED PLAN FROM ALL AGENTS:
${consolidatedPlan}

IMPORTANT - THIS IS TASK NEGOTIATION, NOT EXECUTION:
- DO NOT write code or create files yet
- Review what Claude Code proposed
- State which specific tasks YOU (Codex) will handle
- Avoid duplicating Claude Code's proposed tasks
- Leverage your strengths: complex logic, algorithms, architecture

Your response (under 120 words):
"I (Codex) will handle:
- [specific task 1]
- [specific task 2]
- etc."

Optional teammate coordination:
${coordinationHint}

Remember: This is negotiation, execution comes next.`;

    const { finalText, transcriptParts } = await this.runTurnStreamed(negotiationPrompt, 'plan');

    this.emitStatus({ actionType: 'plan', description: 'Task split proposed' });
    const combined = transcriptParts.length ? transcriptParts.join('\n') : finalText;
    const cleaned = this.processTeamMessages(combined);
    return (cleaned || '').trim();
  }

  async executeTasks({ assignments, teamAssignments, timeoutMs }) {
    if (!this.thread) return 'Codex not initialized.';
    this.emitStatus({ actionType: 'exec', description: 'Executing tasks' });

    const teammateAssignments = Object.entries(teamAssignments || {})
      .filter(([agentId]) => agentId !== this.id)
      .map(([agentId, text]) => `- ${agentId}: ${text}`)
      .join('\n') || 'Teammates awaiting responsibilities update.';

    if (this.client?.addMessage && this.thread?.id) {
      try {
        await this.client.addMessage({
          threadId: this.thread.id,
          role: 'system',
          content: `Execution context:\nTeammate focus areas:\n${teammateAssignments}`,
        });
      } catch (err) {
        this.logger?.debug?.({ err }, 'Codex execution context injection failed');
      }
    }

    const coordinationHint = this.buildCoordinationHint();
    const rosterSummary = this.buildRosterSummary(true);
    const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
    const executionPrompt = `You are OpenAI Codex. You and Claude Code have divided the work. NOW IT'S TIME TO EXECUTE.

${rosterSection}

YOUR ASSIGNED TASKS:
${assignments}

TEAMMATE FOCUS AREAS:
${teammateAssignments}

IMPORTANT - NOW YOU CAN EXECUTE:
- Write code, create files, run commands as needed
- ONLY work on YOUR assigned tasks (Claude Code handles theirs)
- After each major milestone, send a user message:
  USER_MSG: [brief update under 80 chars]

Example user messages:
USER_MSG: Created project structure
USER_MSG: Implemented core logic
USER_MSG: Tests passing ✓

Optional teammate coordination:
${coordinationHint}

Begin execution now. Take as long as needed to complete YOUR tasks properly.`;

    const { finalText, transcriptParts } = await this.runTurnStreamed(
      executionPrompt,
      'exec',
      timeoutMs || 0 // No timeout
    );

    // Extract and send user messages from the combined response
    const combined = transcriptParts.length ? transcriptParts.join('\n') : finalText;
    const userMsgPattern = /USER_MSG:\s*(.+)/g;
    let match;
    while ((match = userMsgPattern.exec(combined)) !== null) {
      this.sendUserMessage(match[1].trim());
    }

    const cleaned = this.processTeamMessages(combined);
    this.emitStatus({ actionType: 'exec', description: 'Tasks complete' });
    return (cleaned || '').trim();
  }

  async receiveStatusUpdate(update) {
    if (!this.client || !this.thread || update.agentId === this.id) return;
    if (typeof this.client.addMessage === 'function') {
      try {
        await this.client.addMessage({
          threadId: this.thread.id,
          role: 'system',
          content: `Status Update from ${update.agentName}: ${update.description}`,
        });
      } catch (err) {
        this.logger?.debug?.({ err }, 'Codex status injection failed');
      }
    }
  }

  async receiveTeamMessage(message) {
    super.receiveTeamMessage(message);
    if (!this.client || !this.thread) return;
    if (typeof this.client.addMessage === 'function') {
      try {
        await this.client.addMessage({
          threadId: this.thread.id,
          role: 'system',
          content: `Team message from ${message.fromName || message.from}: ${message.message}`,
        });
      } catch (err) {
        this.logger?.debug?.({ err }, 'Codex team message injection failed');
      }
    }
  }

  async receivePlanningUpdate(update) {
    if (!this.client || !this.thread) return;
    if (typeof this.client.addMessage === 'function') {
      try {
        await this.client.addMessage({
          threadId: this.thread.id,
          role: 'system',
          content: `Planning update (${update.stage}): ${update.agentId || 'coordinator'} - ${
            update.plan || update.allocation || ''
          }`,
        });
      } catch (err) {
        this.logger?.debug?.({ err }, 'Codex planning injection failed');
      }
    }
  }

  async shutdown() {
    if (!this.client || !this.thread) return;
    if (typeof this.client.archiveThread === 'function') {
      try {
        await this.client.archiveThread({ threadId: this.thread.id });
      } catch (err) {
        this.logger?.debug?.({ err }, 'Codex shutdown error');
      }
    }
    if (this.originalCodexPreferredAuth === null) {
      delete process.env.CODEX_PREFERRED_AUTH_METHOD;
    } else {
      process.env.CODEX_PREFERRED_AUTH_METHOD = this.originalCodexPreferredAuth;
    }
  }

  async runTurnStreamed(prompt, actionType, timeoutMs) {
    if (!this.thread?.runStreamed) {
      throw new Error('Codex thread streaming is unavailable.');
    }

    const { events } = await this.thread.runStreamed(prompt, { timeoutMs });
    const transcriptParts = [];
    let finalText = '';

    try {
      for await (const event of events) {
        if (event?.type === 'turn.failed') {
          throw new Error(event.error?.message || 'Codex turn failed.');
        }

        const text = this.extractTextFromEvent(event);
        if (text) {
          transcriptParts.push(text);
          this.emitStatus({ actionType, description: text.trim().slice(0, 80) });
          finalText = text;
        }
      }
    } catch (err) {
      this.emitStatus({
        actionType: 'error',
        description: `Codex ${actionType} failed: ${err.message || err}`,
      });
      throw err;
    }

    return { finalText, transcriptParts };
  }

  extractTextFromEvent(event) {
    if (!event) return '';
    if (typeof event === 'string') return event;

    if (event.delta?.output_text) return event.delta.output_text;
    if (event.output_text) return event.output_text;
    if (event.text) return event.text;

    const item = event.item;
    if (item?.type === 'agent_message') {
      if (typeof item.text === 'string') return item.text;
      if (Array.isArray(item.text)) return item.text.join('');
      if (Array.isArray(item.content)) {
        return item.content
          .map((entry) => (typeof entry === 'string' ? entry : entry?.text || ''))
          .join('');
      }
    }

    if (event.message?.type === 'agent_message') {
      const message = event.message;
      if (typeof message.text === 'string') return message.text;
      if (Array.isArray(message.content)) {
        return message.content.map((entry) => entry?.text || '').join('');
      }
    }

    return '';
  }
}
