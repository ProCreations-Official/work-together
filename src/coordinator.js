import { randomUUID } from 'crypto';
import { createMessageBus } from './message-bus.js';
import { AgentRegistry } from './agents/registry.js';
import { SessionLogger } from './session-logger.js';

export class Coordinator {
  constructor({ config, baseDir }) {
    this.config = config;
    this.baseDir = baseDir;
    this.logger = config.logger;
    this.messageBus = createMessageBus();
    this.agentRegistry = new AgentRegistry({ messageBus: this.messageBus, config });
    this.statusLogger = new SessionLogger();
    this.session = null;
    this.statusSubscribers = new Set();
    this.planningSubscribers = new Set();

    this.messageBus.onStatus((update) => this.handleStatusUpdate(update));
    this.messageBus.onPlanning((update) => this.handlePlanningUpdate(update));
    this.messageBus.onError((error) => this.handleError(error));
    this.messageBus.onTeamMessage((message) => this.handleTeamMessage(message));
  }

  async discoverAgents() {
    const results = await this.agentRegistry.discover();
    this.sessionDiscoveries = results;
    return results;
  }

  async initializeSession({ agentSelections, userPrompt }) {
    if (!agentSelections?.length) {
      throw new Error('At least one agent must be selected.');
    }

    const sessionId = randomUUID();
    const { activeAgents, failures } = await this.agentRegistry.initializeSelected({
      agentIds: agentSelections,
      userPrompt,
    });

    if (activeAgents.length === 0) {
      const failureReasons = failures
        .map((failure) => `${failure.agentId}: ${failure.error?.message || String(failure.error)}`)
        .join('; ');
      throw new Error(
        `Selected agents failed to initialise. Check SDK setup and API keys. Details: ${failureReasons}`
      );
    }

    this.session = {
      id: sessionId,
      userPrompt,
      createdAt: new Date().toISOString(),
      agents: activeAgents.map((agent) => ({ id: agent.id, name: agent.name })),
      failures,
      plan: null,
      assignments: null,
      transcripts: null,
    };

    this.assignRoles(activeAgents);
    const reviewLabel = this.formatAgentLabel(this.session.reviewAgentId);
    await this.statusLogger.start(sessionId);
    this.agentRegistry.applyTeamRoster(this.session.agents);
    this.messageBus.emitStatus({
      timestamp: new Date().toISOString(),
      agentId: 'coordinator',
      agentName: 'Coordinator',
      actionType: 'init',
      description: `Session ${sessionId} ready with ${activeAgents.length} agents`,
      affectedFiles: [],
    });
    if (reviewLabel) {
      this.messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'coordinator',
        agentName: 'Coordinator',
        actionType: 'plan',
        description: `Designated review agent: ${reviewLabel}`,
        affectedFiles: [],
      });
    }
    this.logger?.info({ sessionId, agents: this.session.agents.map((a) => a.id) }, 'Coordinator session initialised');

    return this.session;
  }

  getSession() {
    return this.session;
  }

  subscribeToStatus(listener) {
    this.statusSubscribers.add(listener);
    return () => this.statusSubscribers.delete(listener);
  }

  subscribeToPlanning(listener) {
    this.planningSubscribers.add(listener);
    return () => this.planningSubscribers.delete(listener);
  }

  handleStatusUpdate(update) {
    const enriched = {
      timestamp: update.timestamp || new Date().toISOString(),
      ...update,
    };

    this.statusLogger.record(enriched).catch((err) => {
      this.logger?.warn({ err }, 'Failed to append status update to log');
    });
    if (this.session) {
      this.agentRegistry.broadcastStatus(enriched).catch((err) => {
        this.logger?.debug({ err }, 'Broadcast status failed');
      });
    }

    this.statusSubscribers.forEach((listener) => listener(enriched));
  }

  handlePlanningUpdate(update) {
    const enriched = {
      timestamp: new Date().toISOString(),
      ...update,
    };
    this.statusLogger.record({ ...enriched, logType: 'planning' }).catch((err) => {
      this.logger?.warn({ err }, 'Failed to append planning update to log');
    });
    if (this.session) {
      this.agentRegistry.broadcastPlanning(enriched).catch((err) => {
        this.logger?.debug({ err }, 'Broadcast planning failed');
      });
    }
    this.planningSubscribers.forEach((listener) => listener(enriched));
  }

  handleError(error) {
    this.statusLogger.record({
      timestamp: new Date().toISOString(),
      agentId: error.agentId || 'coordinator',
      actionType: 'error',
      description: error.message || String(error),
    }).catch((err) => {
      this.logger?.error({ err }, 'Failed to append error to log');
    });
    this.logger?.error({ err: error }, 'Coordinator received error event');
  }

  async handleTeamMessage(message) {
    const enriched = {
      timestamp: message.timestamp || new Date().toISOString(),
      ...message,
    };

    let recipients = [];
    if (this.session) {
      try {
        recipients = await this.agentRegistry.dispatchTeamMessage(enriched);
      } catch (err) {
        this.logger?.warn({ err }, 'Failed to dispatch team message');
      }
    }

    const fromAgent = this.agentRegistry.getAgentById(enriched.from);
    const recipientNames = recipients.map((agent) => agent.name || agent.id);
    const scope = enriched.scope || 'auto';
    const descriptionPrefix = recipientNames.length > 1 || scope === 'group'
      ? `Group message`
      : recipientNames.length === 1
        ? `Message to ${recipientNames[0]}`
        : `Message`;
    const statusDescription = `${descriptionPrefix}: ${enriched.message}`.slice(0, 100);

    this.statusLogger.record({ ...enriched, recipients: recipientNames, logType: 'team-message' }).catch((err) => {
      this.logger?.warn({ err }, 'Failed to log team message');
    });

    this.messageBus.emitStatus({
      timestamp: enriched.timestamp,
      agentId: enriched.from,
      agentName: fromAgent?.name || enriched.from,
      actionType: 'team-message',
      description: statusDescription,
    });
  }

  async runPlanningPhase() {
    if (!this.session) throw new Error('Session not initialised');

    this.logger?.info('=== PLANNING PHASE START ===');

    this.logger?.info('Step 1: Requesting plans from agents...');
    const plans = await this.agentRegistry.runGeneratePlans({ userPrompt: this.session.userPrompt });
    this.logger?.info({ plans: plans.map(p => ({ agentId: p.agentId, planLength: p.plan?.length || 0 })) }, 'Got plans from agents');

    plans.forEach(({ agentId, plan }) => {
      this.logger?.info({ agentId, planLength: plan?.length || 0 }, 'Emitting initial-plan');
      this.messageBus.emitPlanning({ stage: 'initial-plan', agentId, plan });
    });

    this.logger?.info('Step 2: Synthesizing combined plan...');
    const consolidatedPlan = this.synthesizePlans(plans);
    this.logger?.info({ summaryLength: consolidatedPlan.summary?.length || 0 }, 'Emitting coordinator-summary');
    this.messageBus.emitPlanning({ stage: 'coordinator-summary', plan: consolidatedPlan.summary });

    this.logger?.info('Step 3: Starting negotiation phase...');
    this.logger?.info({ consolidatedPlanLength: consolidatedPlan.summary?.length }, 'Calling runNegotiation');
    this.statusLogger.record({ logType: 'debug', message: 'COORDINATOR: About to call runNegotiation' }).catch(() => {});
    const allocations = await this.agentRegistry.runNegotiation({
      consolidatedPlan: consolidatedPlan.summary,
      agentPlans: plans,
    });
    this.statusLogger.record({ logType: 'debug', message: `COORDINATOR: runNegotiation returned ${allocations.length} allocations` }).catch(() => {});
    this.logger?.info({ allocations: allocations.map(a => ({ agentId: a.agentId, allocationLength: a.allocation?.length || 0 })) }, 'Got allocations from negotiation');

    allocations.forEach(({ agentId, allocation }) => {
      this.logger?.info({ agentId, allocationLength: allocation?.length || 0 }, 'Emitting allocation');
      this.messageBus.emitPlanning({ stage: 'allocation', agentId, allocation });
    });

    this.logger?.info('Step 4: Building final assignments...');
    const assignments = this.buildAssignments(allocations, consolidatedPlan);
    this.logger?.info({ assignments: Object.keys(assignments) }, 'Built assignments');

    this.session.plan = {
      initial: plans,
      consolidated: consolidatedPlan,
      allocations,
    };
    this.session.assignments = assignments;

    this.logger?.info({ assignmentCount: Object.keys(assignments).length }, 'Emitting final-division');
    this.messageBus.emitPlanning({ stage: 'final-division', assignments });
    this.logger?.info('=== PLANNING PHASE COMPLETE ===');
    return this.session.plan;
  }

  synthesizePlans(plans) {
    const summaryLines = plans.map(({ agentId, plan }) => {
      const agent = this.agentRegistry.getAgentById(agentId);
      const safePlan = plan && typeof plan === 'string' && plan.trim().length > 0 ? plan : 'No plan submitted.';
      return `- ${agent?.name || agentId}: ${safePlan}`;
    });
    if (this.session?.agents?.length) {
      summaryLines.push('\nRole assignments:');
      this.session.agents.forEach((entry) => {
        const reviewTag = entry.isReviewAgent ? ' [Review]' : '';
        const roleTag = entry.rolePrimary ? ` – ${entry.rolePrimary}` : '';
        summaryLines.push(`- ${entry.name} (${entry.id})${roleTag}${reviewTag}`);
      });
    }
    return {
      summary: ['Combined collaboration plan:', ...summaryLines].join('\n'),
    };
  }

  buildAssignments(allocations) {
    const assignments = {};
    allocations.forEach(({ agentId, allocation }) => {
      const base = allocation && typeof allocation === 'string' && allocation.trim().length > 0
        ? allocation.trim()
        : 'No allocation provided.';
      assignments[agentId] = base;
    });
    const roles = this.session.roles || {};
    const reviewAgentId = this.session.reviewAgentId;
    const reviewLabel = reviewAgentId ? this.formatAgentLabel(reviewAgentId) : null;
    Object.keys(assignments).forEach((agentId) => {
      const role = roles[agentId] || {};
      let text = assignments[agentId];
      const focusLines = [];
      if (!text || /No allocation provided/i.test(text)) {
        focusLines.push('Primary objectives:');
        if (role.rolePrimary) {
          focusLines.push(`- Deliver on ${role.rolePrimary} aligned with the user request.`);
        } else {
          focusLines.push('- Deliver meaningful progress aligned with the user request.');
        }
        if (role.roleSecondary) {
          focusLines.push(`- Secondary: ${role.roleSecondary}.`);
        }
        text = focusLines.join('\n');
      }

      if (role.rolePrimary && !text.includes('Role Focus')) {
        text += `\n\nRole Focus: ${role.rolePrimary}.`;
      }
      if (role.roleSecondary && !text.includes('Secondary Focus')) {
        text += `\nSecondary Focus: ${role.roleSecondary}.`;
      }
      if (role.isReviewAgent) {
        text += `\n\nReview Responsibilities: After the other agents announce completion, review the full deliverable. Read all modified files, run necessary checks, and send TEAM_MSG[GROUP] summarizing findings. If issues remain, send targeted TEAM_MSG[TO <agent>] with remediation requests before user hand-off.`;
      } else if (reviewAgentId && reviewAgentId !== agentId) {
        text += `\n\nCompletion Protocol: When your deliverables are done, send TEAM_MSG[TO ${reviewAgentId}] to notify the review agent (${reviewLabel}). Provide a brief summary of what you completed and any areas needing special attention.`;
      }

      assignments[agentId] = text;
    });
    return assignments;
  }

  async runExecutionPhase() {
    if (!this.session) throw new Error('Session not initialised');
    if (!this.session.assignments) throw new Error('Assignments not ready');

    const transcripts = await this.agentRegistry.executeAssignments(this.session.assignments, { timeoutMs: 0 });
    this.session.transcripts = transcripts;
    transcripts.forEach(({ agentId, transcript }) => {
      this.messageBus.emitPlanning({ stage: 'execution-transcript', agentId, transcript });
    });
    return transcripts;
  }

  async shutdown(sessionSummary) {
    await this.agentRegistry.shutdown();
    if (sessionSummary) {
      await this.statusLogger.finish(sessionSummary);
    }
    this.messageBus.removeAll();
  }

  assignRoles(activeAgents) {
    if (!this.session) return;
    const agentsWithRoles = [];
    let reviewAgentId = null;
    let bestPriority = -Infinity;

    activeAgents.forEach((agent) => {
      const profile = agent.roleProfile || {};
      const entry = {
        id: agent.id,
        name: agent.name,
        rolePrimary: profile.primary || 'Generalist contributor',
        roleSecondary: profile.secondary || '',
        reviewPreferred: Boolean(profile.reviewPreferred),
        reviewPriority: typeof profile.reviewPriority === 'number' ? profile.reviewPriority : 0,
      };
      agentsWithRoles.push(entry);
      const priority = entry.reviewPreferred ? (entry.reviewPriority ?? 1) + 10 : entry.reviewPriority ?? 0;
      if (priority > bestPriority) {
        reviewAgentId = entry.id;
        bestPriority = priority;
      }
    });

    if (!reviewAgentId && agentsWithRoles.length) {
      reviewAgentId = agentsWithRoles[agentsWithRoles.length - 1].id;
    }

    this.session.reviewAgentId = reviewAgentId;
    this.session.roles = {};
    this.session.agents = agentsWithRoles.map((entry) => {
      const enriched = {
        ...entry,
        isReviewAgent: entry.id === reviewAgentId,
      };
      this.session.roles[entry.id] = enriched;
      return enriched;
    });
  }

  formatAgentLabel(agentId) {
    if (!agentId) return '';
    const entry = this.session?.roles?.[agentId];
    if (!entry) return agentId;
    const roleTag = entry.rolePrimary ? ` – ${entry.rolePrimary}` : '';
    const reviewTag = entry.isReviewAgent ? ' [Review]' : '';
    return `${entry.name} (${entry.id})${roleTag}${reviewTag}`;
  }
}
