import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
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
    this.variantSelectionSubscribers = new Set();
    this.pendingVariantSelection = null;
    this.mode = this.config.settings?.collaborationMode === 'variant' ? 'variant' : 'collaborative';

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
      mode: this.mode,
      variant: null,
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

  getCollaborationMode() {
    return this.mode;
  }

  subscribeToStatus(listener) {
    this.statusSubscribers.add(listener);
    return () => this.statusSubscribers.delete(listener);
  }

  subscribeToPlanning(listener) {
    this.planningSubscribers.add(listener);
    return () => this.planningSubscribers.delete(listener);
  }

  subscribeToVariantSelection(listener) {
    this.variantSelectionSubscribers.add(listener);
    return () => this.variantSelectionSubscribers.delete(listener);
  }

  notifyVariantSelection(request) {
    this.variantSelectionSubscribers.forEach((listener) => listener(request));
  }

  setCollaborationMode(mode) {
    const normalized = mode === 'variant' ? 'variant' : 'collaborative';
    this.mode = normalized;
    if (this.session) {
      this.session.mode = normalized;
    }
    if (this.config?.settings) {
      this.config.settings.collaborationMode = normalized;
    }
    if (normalized !== 'variant' && this.pendingVariantSelection) {
      const pending = this.pendingVariantSelection;
      this.pendingVariantSelection = null;
      pending.resolve?.({ type: 'auto' });
    }
    return this.mode;
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
    if (this.mode === 'variant') {
      return this.runVariantPlanningPhase();
    }

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

  async runVariantPlanningPhase() {
    if (!this.session) throw new Error('Session not initialised');
    this.logger?.info('=== VARIANT MODE START ===');

    this.logger?.info('Variant Step 1: Gathering private plans from each agent');
    const plans = await this.agentRegistry.runGeneratePlans({ userPrompt: this.session.userPrompt });
    const planMap = new Map();
    plans.forEach((entry) => planMap.set(entry.agentId, entry.plan));

    this.logger?.info('Variant Step 2: Preparing dedicated workspaces for each agent');
    const projectSlug = this.deriveVariantProjectSlug();
    const workspaceDir = await this.prepareVariantWorkspace(projectSlug);
    const assignments = {};
    const directories = {};
    for (const agent of this.session.agents) {
      const folderName = this.buildAgentFolderName(agent.name || agent.id, projectSlug);
      const projectDir = path.join(workspaceDir, folderName);
      await fs.ensureDir(projectDir);
      directories[agent.id] = { projectDir, folderName };
      assignments[agent.id] = this.buildVariantAssignment({
        agentName: agent.name || agent.id,
        projectDir,
        userPrompt: this.session.userPrompt,
      });
    }

    this.logger?.info('Variant Step 3: Executing independent variants');
    const timeoutMs = this.config.preferences?.actionTimeoutMs || 0;
    const transcripts = await this.agentRegistry.executeAssignments(assignments, { timeoutMs });

    const results = transcripts.map((entry, index) => {
      const directory = directories[entry.agentId] || {};
      return {
        agentId: entry.agentId,
        agentName: this.formatAgentLabel(entry.agentId),
        projectDir: directory.projectDir || null,
        folderName: directory.folderName || null,
        transcript: entry.transcript,
        plan: planMap.get(entry.agentId) || '',
        order: index + 1,
      };
    });

    const summaryLines = results.map(
      (result) =>
        `${result.order}. ${result.agentName || result.agentId}${
          result.projectDir ? ` → ${result.projectDir}` : ''
        }`
    );
    this.messageBus.emitPlanning({
      stage: 'variant-results',
      agentId: 'coordinator',
      plan: ['Variant outputs ready:', ...summaryLines].join('\n'),
    });

    this.session.plan = {
      initial: plans,
      consolidated: null,
      allocations: [],
      variant: {
        projectSlug,
        workspaceDir,
        results,
        selection: null,
      },
    };
    this.session.assignments = null;
    this.session.transcripts = transcripts;
    this.session.variant = {
      projectSlug,
      workspaceDir,
      results,
      selection: null,
    };

    const selection = await this.resolveVariantSelection(results);
    const selectedResult = selection.entry;
    const selectedAgentId = selection.agentId;
    const selectedAgentLabel = this.formatAgentLabel(selectedAgentId);

    const consolidatedText = [
      `Selected variant (${selection.mode === 'manual' ? 'manual' : 'auto'}): ${selectedAgentLabel}`,
      selectedResult?.projectDir ? `Project directory: ${selectedResult.projectDir}` : null,
      selection.rationale ? `Reason: ${selection.rationale}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    this.messageBus.emitPlanning({
      stage: 'variant-selected',
      agentId: selectedAgentId,
      plan: consolidatedText,
    });

    this.session.plan.consolidated = { summary: consolidatedText, variant: selectedResult };
    this.session.variant.selection = {
      agentId: selectedAgentId,
      rationale: selection.rationale,
      mode: selection.mode,
      projectDir: selectedResult?.projectDir || null,
    };
    if (this.session.plan.variant) {
      this.session.plan.variant.selection = {
        agentId: selectedAgentId,
        rationale: selection.rationale,
        mode: selection.mode,
        projectDir: selectedResult?.projectDir || null,
      };
    }

    this.logger?.info('=== VARIANT MODE COMPLETE ===');
    return this.session.plan;
  }

  async resolveVariantSelection(results) {
    if (!results?.length) {
      throw new Error('No variant results available for selection.');
    }
    const preference = this.config.settings?.variantSelectionMode === 'auto' ? 'auto' : 'manual';

    if (preference === 'manual') {
      const manualResult = await this.awaitManualVariantSelection(results);
      if (manualResult?.type === 'manual') {
        const chosen = results.find((entry) => entry.agentId === manualResult.agentId);
        if (chosen) {
          return {
            agentId: chosen.agentId,
            entry: chosen,
            mode: 'manual',
            rationale: manualResult.note || 'Chosen by user during variant selection.',
          };
        }
        this.logger?.warn({ selection: manualResult }, 'Manual selection did not match any plan; falling back to auto.');
      } else if (manualResult?.type === 'auto') {
        this.logger?.info('Manual selection delegated to automatic choice.');
        return this.autoSelectVariant(results);
      }
    }

    return this.autoSelectVariant(results);
  }

  async awaitManualVariantSelection(results) {
    const requestId = randomUUID();
    const options = results.map((entry, index) => ({
      agentId: entry.agentId,
      agentName: entry.agentName || entry.agentId,
      index: index + 1,
      projectDir: entry.projectDir || 'unknown project directory',
    }));

    this.logger?.info({ requestId, options }, 'Awaiting manual variant selection');

    const messageLines = options.map(
      (option) => `${option.index}. ${option.agentName} (${option.agentId}) → ${option.projectDir}`
    );
    this.messageBus.emitPlanning({
      stage: 'variant-selection-request',
      agentId: 'coordinator',
      plan: `Variant mode: choose the final result to adopt.\n${messageLines.join('\n')}\nType the number or agent id, or "auto" to delegate.`,
    });

    const pendingPromise = new Promise((resolve) => {
      this.pendingVariantSelection = {
        requestId,
        options,
        results,
        resolve,
      };
    });

    this.notifyVariantSelection({
      requestId,
      options,
      selectionMode: 'manual',
    });

    return pendingPromise;
  }

  async autoSelectVariant(results) {
    if (!results?.length) {
      throw new Error('No variant results available for selection.');
    }
    const reviewAgentId = this.session?.reviewAgentId;
    if (reviewAgentId) {
      const preferred = results.find((entry) => entry.agentId === reviewAgentId);
      if (preferred) {
        return {
          agentId: preferred.agentId,
          entry: preferred,
          mode: 'auto',
          rationale: `Defaulted to review agent ${this.formatAgentLabel(reviewAgentId)}.`,
        };
      }
    }
    const fallback = results[0];
    return {
      agentId: fallback.agentId,
      entry: fallback,
      mode: 'auto',
      rationale: `Used first available result (${this.formatAgentLabel(fallback.agentId)}).`,
    };
  }

  submitVariantSelection(requestId, rawValue) {
    const pending = this.pendingVariantSelection;
    if (!pending || pending.requestId !== requestId) {
      return { success: false, error: 'No active variant selection request.' };
    }
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!value) {
      return { success: false, error: 'Please enter a selection.' };
    }

    const normalised = value.toLowerCase();
    if (normalised === 'auto') {
      const resolution = { type: 'auto' };
      pending.resolve(resolution);
      this.pendingVariantSelection = null;
      return { success: true, mode: 'auto', message: 'Delegated to automatic selection.' };
    }

    const match = pending.options.find(
      (option) =>
        option.agentId.toLowerCase() === normalised ||
        option.agentName.toLowerCase() === normalised ||
        String(option.index) === normalised
    );

    if (!match) {
      return {
        success: false,
        error: `Unrecognised selection "${value}". Choose by number, agent id, agent name, or "auto".`,
      };
    }

    pending.resolve({ type: 'manual', agentId: match.agentId, note: `User selected ${match.agentName}.` });
    this.pendingVariantSelection = null;
    return {
      success: true,
      mode: 'manual',
      agentId: match.agentId,
      message: `Selected variant from ${match.agentName}.`,
    };
  }

  sanitiseForPath(value, fallback = 'item') {
    if (!value) return fallback;
    const cleaned = value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 48);
    return cleaned || fallback;
  }

  deriveVariantProjectSlug() {
    const prompt = this.session?.userPrompt || '';
    const core = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join('-');
    return this.sanitiseForPath(core, 'project');
  }

  async prepareVariantWorkspace(projectSlug) {
    const baseDir = this.baseDir || process.cwd();
    const sessionSuffix = this.session?.id ? this.session.id.split('-')[0] : randomUUID().slice(0, 8);
    const dirName = `variant-${projectSlug}-${sessionSuffix}`;
    const workspaceDir = path.join(baseDir, dirName);
    await fs.ensureDir(workspaceDir);
    return workspaceDir;
  }

  buildAgentFolderName(agentName, projectSlug) {
    const nameSlug = this.sanitiseForPath(agentName, 'agent');
    return `${nameSlug}-${projectSlug}`;
  }

  buildVariantAssignment({ agentName, projectDir, userPrompt }) {
    const promptText = userPrompt && userPrompt.trim() ? userPrompt.trim() : 'Follow the user prompt to deliver a complete solution.';
    return [
      `VARIANT MODE SOLO BUILD – ${agentName}`,
      '',
      `Prompt: ${promptText}`,
      `Project directory: ${projectDir}`,
      '',
      'Instructions:',
      `1. Work independently to deliver a complete, production-ready solution scoped to the prompt.`,
      `2. Run all commands inside the project directory. Start by executing: cd ${projectDir}`,
      '3. Keep all created or modified files within this directory. Do not touch other variant folders.',
      '4. Produce any build/test artifacts locally inside your folder.',
      '5. Finish with a concise summary of key deliverables and verification steps.',
      '',
      'Do not coordinate with other agents; each is building their own variant.',
    ].join('\n');
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
    if (this.mode === 'variant') {
      this.logger?.info('Variant mode: execution already completed during planning; skipping.');
      return this.session?.variant?.results || this.session?.transcripts || [];
    }
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
