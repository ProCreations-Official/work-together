import chalk from 'chalk';
import { BaseAgent } from './base-agent.js';

const COLOR = '#007AFF';

export class OpenCodeAgent extends BaseAgent {
  constructor({ messageBus, config }) {
    super({
      id: 'opencode',
      name: 'OpenCode',
      color: COLOR,
      messageBus,
      config,
      roleProfile: {
        primary: 'DevOps automation, integration scripts, and tooling',
        secondary: 'Build pipelines & environment setup',
        reviewPreferred: false,
        reviewPriority: 3,
      },
    });
    this.module = null;
    this.client = null;
    this.sessionId = null;
    this.statusColor = chalk.hex(COLOR);
  }

  async checkAvailability() {
    const details = {
      id: this.id,
      name: this.name,
      color: COLOR,
      available: false,
      issues: [],
    };

    try {
      this.module = await import('@opencode-ai/sdk');
    } catch (err) {
      details.issues.push('SDK not installed. Run "npm install @opencode-ai/sdk".');
    }

    this.apiKey = this.config.getApiKey?.(this.id) || process.env.OPENCODE_API_KEY || null;
    if (!this.apiKey) {
      details.issues.push('Missing OPENCODE_API_KEY.');
    }

    details.available = details.issues.length === 0;
    this.available = details.available;
    return details;
  }

  async initialize({ userPrompt }) {
    if (!this.available || !this.module) return;
    try {
      const { OpenCode } = this.module;
      if (!OpenCode) throw new Error('OpenCode export missing');
      this.emitStatus({ actionType: 'init', description: 'Starting OpenCode session' });
      this.client = new OpenCode({ apiKey: this.apiKey });
      const session = await this.client.startSession({ context: userPrompt });
      this.sessionId = session?.id || null;
      this.emitStatus({ actionType: 'init', description: 'OpenCode ready' });
    } catch (err) {
      this.emitStatus({ actionType: 'error', description: 'OpenCode init failed' });
      this.logger?.warn?.({ err }, 'OpenCode initialization failed');
      throw err;
    }
  }

  async generatePlan({ userPrompt }) {
    if (!this.client) {
      return 'OpenCode unavailable.';
    }
    this.emitStatus({ actionType: 'plan', description: 'Drafting plan' });
    try {
      const coordinationHint = this.buildCoordinationHint();
      const rosterSummary = this.buildRosterSummary(true);
      const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
      const prompt = `You are OpenCode, collaborating with other coding agents on automation and tooling support.

${rosterSection}
TASK: ${userPrompt}

Outline how you will deliver DevOps/integration support alongside the team. Mention specific scripts, commands, or tooling you can provide.

Optional teammate coordination:
${coordinationHint}`;
      const plan = await this.client.generatePlan({ prompt });
      const text = typeof plan === 'string' ? plan : plan?.text || JSON.stringify(plan);
      const cleaned = this.processTeamMessages(text);
      this.emitStatus({ actionType: 'plan', description: 'Plan ready' });
      return cleaned.trim();
    } catch (err) {
      this.emitStatus({ actionType: 'error', description: 'Plan failed' });
      this.logger?.warn?.({ err }, 'OpenCode planning error');
      return 'OpenCode failed to create plan.';
    }
  }

  async negotiateResponsibilities({ consolidatedPlan, agentPlans }) {
    if (!this.client) return 'OpenCode unavailable.';
    try {
      const coordinationHint = this.buildCoordinationHint();
      const rosterSummary = this.buildRosterSummary(true);
      const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
      const teammatePlans = (agentPlans || [])
        .filter((entry) => entry.agentId && entry.agentId !== this.id)
        .map((entry) => `- ${entry.agentName || entry.agentId}: ${entry.plan}`)
        .join('\n') || 'No teammate plans available.';
      const negotiationPrompt = `You are OpenCode contributing DevOps and integration support.

${rosterSection}
Combined plan:
${consolidatedPlan}

Teammate plans:
${teammatePlans}

List the automation, scripts, or integration tasks YOU will own.`
        + `\n\nOptional teammate coordination:\n${coordinationHint}`;
      const allocation = await this.client.proposeAllocation({ plan: negotiationPrompt });
      const text = typeof allocation === 'string' ? allocation : allocation?.text || JSON.stringify(allocation);
      this.emitStatus({ actionType: 'plan', description: 'Task split proposed' });
      const cleaned = this.processTeamMessages(text);
      return cleaned.trim();
    } catch (err) {
      this.emitStatus({ actionType: 'error', description: 'Allocation failed' });
      this.logger?.warn?.({ err }, 'OpenCode allocation failed');
      return 'OpenCode could not propose allocation.';
    }
  }

  async executeTasks({ assignments, teamAssignments, timeoutMs }) {
    if (!this.client) return 'OpenCode unavailable.';
    this.emitStatus({ actionType: 'exec', description: 'Executing tasks' });
    try {
      const teammateSummary = Object.entries(teamAssignments || {})
        .filter(([agentId]) => agentId !== this.id)
        .map(([agentId, text]) => `- ${this.formatAgentLabel(agentId)}: ${text}`)
        .join('\n') || 'Teammates awaiting responsibilities update.';
      const coordinationHint = this.buildCoordinationHint();
      const rosterSummary = this.buildRosterSummary(true);
      const rosterSection = rosterSummary ? `Current team roster:\n${rosterSummary}\n\n` : '';
      const executionPrompt = `${assignments}

${rosterSection}
Teammate focus areas:
${teammateSummary}

Optional teammate coordination:
${coordinationHint}`;
      const stream = await this.client.executeTasks({ sessionId: this.sessionId, assignments: executionPrompt, timeoutMs });
      let transcript = '';
      for await (const chunk of stream) {
        const piece = typeof chunk === 'string' ? chunk : chunk?.text || '';
        transcript += piece;
        if (piece.trim()) {
          this.emitStatus({ actionType: 'exec', description: piece.trim().slice(0, 80) });
        }
      }
      this.emitStatus({ actionType: 'exec', description: 'Tasks complete' });
      const cleaned = this.processTeamMessages(transcript);
      return cleaned.trim();
    } catch (err) {
      this.emitStatus({ actionType: 'error', description: 'Execution failed' });
      this.logger?.warn?.({ err }, 'OpenCode execute error');
      return 'OpenCode execution failed.';
    }
  }

  async receiveStatusUpdate(update) {
    if (!this.client || update.agentId === this.id) return;
    if (typeof this.client.pushStatus === 'function') {
      try {
        await this.client.pushStatus({ sessionId: this.sessionId, status: update });
      } catch (err) {
        this.logger?.debug?.({ err }, 'OpenCode status push failed');
      }
    }
  }

  async receivePlanningUpdate(update) {
    if (!this.client) return;
    if (typeof this.client.pushPlanningUpdate === 'function') {
      try {
        await this.client.pushPlanningUpdate({
          sessionId: this.sessionId,
          update,
        });
      } catch (err) {
        this.logger?.debug?.({ err }, 'OpenCode planning push failed');
      }
    }
  }

  async shutdown() {
    if (!this.client || typeof this.client.endSession !== 'function') return;
    try {
      await this.client.endSession({ sessionId: this.sessionId });
    } catch (err) {
      this.logger?.debug?.({ err }, 'OpenCode shutdown error');
    }
  }
}
