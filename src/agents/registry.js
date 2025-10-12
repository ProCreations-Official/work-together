import { ClaudeAgent } from './claude.js';
import { CodexAgent } from './codex.js';
import { OpenCodeAgent } from './opencode.js';
import { GeminiAgent } from './gemini.js';
import { QwenAgent } from './qwen.js';
import { WebSearchAgent } from './web-search.js';

export class AgentRegistry {
  constructor({ messageBus, config }) {
    this.messageBus = messageBus;
    this.config = config;
    this.agents = [
      new ClaudeAgent({ messageBus, config }),
      new CodexAgent({ messageBus, config }),
      new GeminiAgent({ messageBus, config }),
      new QwenAgent({ messageBus, config }),
      new OpenCodeAgent({ messageBus, config }),
      new WebSearchAgent({ messageBus, config }),
    ];
    this.activeAgents = [];
  }

  list() {
    return this.agents;
  }

  getAgentById(id) {
    return this.agents.find((agent) => agent.id === id) || null;
  }

  async discover() {
    const availability = await Promise.all(
      this.agents.map(async (agent) => ({ agent, meta: await agent.checkAvailability() }))
    );
    return availability.map(({ meta }) => meta);
  }

  async initializeSelected({ agentIds, userPrompt }) {
    const selectionSet = new Set(agentIds || []);
    let selected = this.agents.filter((agent) => selectionSet.has(agent.id));

    if (this.config.settings?.enableWebSearchAgent !== false) {
      const searchAgent = this.agents.find((agent) => agent.id === 'web-search');
      if (searchAgent && !selectionSet.has(searchAgent.id) && searchAgent.available !== false) {
        selected = [...selected, searchAgent];
        this.config.logger?.info({ autoAdded: 'web-search' }, 'Auto-added web search agent to session');
      }
    }
    const initResults = await Promise.allSettled(
      selected.map(async (agent) => (
        await agent.initialize({ userPrompt }),
        agent
      ))
    );

    this.activeAgents = initResults
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);

    const failures = initResults
      .map((result, idx) => ({ result, idx }))
      .filter(({ result }) => result.status === 'rejected')
      .map(({ result, idx }) => ({
        agentId: selected[idx].id,
        error: result.reason,
      }));

    if (failures.length) {
      this.config.logger?.warn({ failures }, 'Some agents failed to initialise');
    }

    return { activeAgents: this.activeAgents, failures };
  }

  getActiveAgents() {
    return this.activeAgents;
  }

  async runGeneratePlans({ userPrompt }) {
    const results = await Promise.allSettled(
      this.activeAgents.map(async (agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        plan: await agent.generatePlan({ userPrompt }),
      }))
    );
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const agentId = this.activeAgents[index]?.id || 'unknown';
      const agentName = this.activeAgents[index]?.name || agentId;
      return {
        agentId,
        agentName,
        plan: `Plan generation failed: ${result.reason?.message || result.reason}`,
      };
    });
  }

  async runNegotiation({ consolidatedPlan, agentPlans }) {
    this.config.logger?.info({ agentCount: this.activeAgents.length }, 'Registry: Starting negotiation with agents');

    const results = await Promise.allSettled(
      this.activeAgents.map(async (agent) => {
        this.config.logger?.info({ agentId: agent.id }, `Registry: Requesting negotiation from ${agent.id}`);
        const allocation = await agent.negotiateResponsibilities({ consolidatedPlan, agentPlans });
        this.config.logger?.info({ agentId: agent.id, allocationLength: allocation?.length || 0 }, `Registry: Got allocation from ${agent.id}`);
        return {
          agentId: agent.id,
          allocation,
        };
      })
    );

    this.config.logger?.info({ resultCount: results.length }, 'Registry: All negotiation promises settled');

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        this.config.logger?.info({ agentId: result.value.agentId }, 'Registry: Negotiation succeeded');
        return result.value;
      }
      const agentId = this.activeAgents[index]?.id || 'unknown';
      const error = result.reason?.message || result.reason;
      this.config.logger?.error({ agentId, error }, 'Registry: Negotiation failed');
      return {
        agentId,
        allocation: `Allocation failed: ${error}`,
      };
    });
  }

  async executeAssignments(assignments, { timeoutMs }) {
    const results = await Promise.allSettled(
      this.activeAgents.map(async (agent) => ({
        agentId: agent.id,
        transcript: await agent.executeTasks({
          assignments: assignments[agent.id] || '',
          teamAssignments: assignments,
          timeoutMs,
        }),
      }))
    );
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const agentId = this.activeAgents[index]?.id || 'unknown';
      return {
        agentId,
        transcript: `Execution failed: ${result.reason?.message || result.reason}`,
      };
    });
  }

  async broadcastStatus(update) {
    await Promise.all(
      this.activeAgents.map(async (agent) => {
        if (agent.id === update.agentId) return;
        await agent.receiveStatusUpdate(update);
      })
    );
  }

  async broadcastPlanning(update) {
    await Promise.all(
      this.activeAgents.map(async (agent) => {
        if (typeof agent.receivePlanningUpdate === 'function') {
          await agent.receivePlanningUpdate(update);
        }
      })
    );
  }

  determineRecipientsForMessage(message) {
    const others = this.activeAgents.filter((agent) => agent.id !== message.from);
    if (!others.length) return [];

    if (others.length === 1) {
      return others;
    }

    const scope = (message.scope || 'auto').toLowerCase();
    const resolveTarget = (targetId) => {
      if (!targetId) return null;
      return others.find((agent) => agent.id === targetId || agent.name === targetId) || null;
    };

    if (scope === 'direct' || (scope === 'auto' && message.to)) {
      const target = resolveTarget(message.to);
      if (target) {
        return [target];
      }
      this.config.logger?.warn?.({ message }, 'Direct team message target not found; broadcasting instead');
      return others;
    }

    if (scope === 'group') {
      return others;
    }

    return others;
  }

  async dispatchTeamMessage(message) {
    const recipients = this.determineRecipientsForMessage(message);
    if (!recipients.length) return [];

    await Promise.all(
      recipients.map(async (agent) => {
        if (typeof agent.receiveTeamMessage === 'function') {
          try {
            await agent.receiveTeamMessage({ ...message, recipient: agent.id });
          } catch (err) {
            this.config.logger?.debug?.({ err, agent: agent.id }, 'receiveTeamMessage failed');
          }
        }
      })
    );

    return recipients;
  }

  async shutdown() {
    await Promise.allSettled(this.agents.map((agent) => agent.shutdown()))
      .catch(() => undefined);
  }

  applyTeamRoster(roster) {
    this.activeAgents.forEach((agent) => {
      if (typeof agent.setTeamRoster === 'function') {
        agent.setTeamRoster(roster);
      }
    });
  }
}
