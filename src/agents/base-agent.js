import chalk from 'chalk';
import { randomUUID } from 'crypto';

const MAX_TEAM_MESSAGES = 10;

export class BaseAgent {
  constructor({ id, name, color, messageBus, config, roleProfile = {} }) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.messageBus = messageBus;
    this.config = config;
    this.logger = config.logger;
    this.available = false;
    this.apiKey = null;
    this.teamMessages = [];
    this.teamRoster = {};
    this.teamRosterLower = {};
    this.roleProfile = {
      primary: roleProfile.primary || 'Generalist contributor',
      secondary: roleProfile.secondary || '',
      reviewPreferred: Boolean(roleProfile.reviewPreferred),
      reviewPriority: typeof roleProfile.reviewPriority === 'number' ? roleProfile.reviewPriority : 0,
    };
  }

  colorize(text) {
    if (typeof this.color === 'string') {
      return chalk.hex(this.color)(text);
    }
    return text;
  }

  async checkAvailability() {
    throw new Error('checkAvailability must be implemented by subclasses.');
  }

  async initialize() {
    throw new Error('initialize must be implemented by subclasses.');
  }

  async generatePlan() {
    return null;
  }

  async negotiateResponsibilities() {
    return null;
  }

  async executeTasks() {
    return null;
  }

  async shutdown() {
    return null;
  }

  async receiveStatusUpdate() {
    return null;
  }

  async receivePlanningUpdate() {
    return null;
  }

  emitStatus({ actionType, description, affectedFiles = [], userMessage = null }) {
    // Allow longer descriptions for planning phase
    const maxLength = actionType === 'plan' ? 500 : 100;
    const update = {
      timestamp: new Date().toISOString(),
      agentId: this.id,
      agentName: this.name,
      actionType,
      description: description.slice(0, maxLength),
      affectedFiles,
      userMessage: userMessage ? userMessage.slice(0, 500) : null,
    };
    this.messageBus.emitStatus(update);
    return update;
  }

  sendUserMessage(message) {
    return this.emitStatus({
      actionType: 'message',
      description: message.slice(0, 100),
      userMessage: message,
    });
  }

  sendTeamMessage(message, options = {}) {
    if (!message || !message.trim()) return null;
    const potentialTo = options.to ? this.resolveAgentIdentifier(options.to) : null;
    const resolvedTo = potentialTo && this.teamRoster[potentialTo] ? potentialTo : null;
    const scope = resolvedTo ? 'direct' : options.scope || 'auto';
    const payload = {
      timestamp: new Date().toISOString(),
      from: this.id,
      fromName: this.name,
      message: message.slice(0, 800),
      scope,
      to: resolvedTo,
    };
    this.messageBus.emitTeamMessage(payload);
    return payload;
  }

  sendDirectMessage(targetAgentId, message) {
    return this.sendTeamMessage(message, { scope: 'direct', to: targetAgentId });
  }

  sendGroupMessage(message) {
    return this.sendTeamMessage(message, { scope: 'group' });
  }

  receiveTeamMessage(message) {
    if (!message) return;
    this.teamMessages.push(message);
    if (this.teamMessages.length > MAX_TEAM_MESSAGES) {
      this.teamMessages = this.teamMessages.slice(-MAX_TEAM_MESSAGES);
    }
  }

  buildTeamMessagesContext() {
    if (!this.teamMessages.length) return '';
    const lines = this.teamMessages.map((entry) => {
      const from = this.formatAgentLabel(entry.from) || entry.fromName || entry.from;
      return `- ${from}: ${entry.message}`;
    });
    return `Recent teammate messages:\n${lines.join('\n')}`;
  }

  setTeamRoster(roster = []) {
    const map = {};
    const lower = {};
    roster.forEach(({ id, name, rolePrimary, isReviewAgent }) => {
      if (!id) return;
      const displayName = name || id;
      map[id] = {
        id,
        name: displayName,
        rolePrimary: rolePrimary || '',
        isReviewAgent: Boolean(isReviewAgent),
      };
      lower[id.toLowerCase()] = id;
      lower[displayName.toLowerCase()] = id;
    });
    this.teamRoster = map;
    this.teamRosterLower = lower;
  }

  resolveAgentIdentifier(identifier) {
    if (!identifier) return null;
    const key = String(identifier).toLowerCase();
    return this.teamRosterLower[key] || identifier;
  }

  buildRosterSummary(includeSelf = false) {
    const entries = Object.values(this.teamRoster)
      .filter((entry) => includeSelf || entry.id !== this.id)
      .map((entry) => {
        const reviewTag = entry.isReviewAgent ? ' [Review]' : '';
        const roleTag = entry.rolePrimary ? ` – ${entry.rolePrimary}` : '';
        return `- ${entry.name} (${entry.id})${roleTag}${reviewTag}`;
      });
    return entries.join('\n');
  }

  buildCoordinationHint() {
    const teammates = Object.values(this.teamRoster).filter((entry) => entry.id !== this.id);
    if (!teammates.length) {
      return 'TEAM_MSG[GROUP]: message for all agents';
    }
    const [first] = teammates;
    const teammateSummary = teammates
      .map((entry) => {
        const roleTag = entry.rolePrimary ? ` – ${entry.rolePrimary}` : '';
        return `${entry.name} (${entry.id})${roleTag}`;
      })
      .join(', ');
    return `Active teammates: ${teammateSummary}\nTEAM_MSG[GROUP]: message for all agents\nTEAM_MSG[TO ${first.id}]: direct message to ${first.name}`;
  }

  buildRosterContext(includeSelf = false) {
    const summary = this.buildRosterSummary(includeSelf);
    return summary ? `Team roster:\n${summary}` : '';
  }

  formatAgentLabel(agentId) {
    if (!agentId) return '';
    const entry = this.teamRoster?.[agentId];
    if (!entry) return agentId;
    const roleTag = entry.rolePrimary ? ` – ${entry.rolePrimary}` : '';
    return `${entry.name} (${agentId})${roleTag}`;
  }

  extractTeamMessages(text) {
    if (typeof text !== 'string') {
      return { cleanedText: text, messages: [], searchRequests: [] };
    }
    const lines = text.split(/\r?\n/);
    const keptLines = [];
    const messages = [];
    const searchRequests = [];

    lines.forEach((line) => {
      const trimmed = line.trim();
      const match = trimmed.match(/^TEAM_MSG(?:\[(.+?)\])?:\s*(.+)$/i);
      if (match) {
        const directive = match[1] ? match[1].trim().toLowerCase() : null;
        const content = match[2]?.trim();
        if (!content) return;
        let scope = 'auto';
        let to = null;
        if (directive) {
          if (directive === 'group') {
            scope = 'group';
          } else if (directive.startsWith('to ')) {
            scope = 'direct';
            to = directive.slice(3).trim();
          }
        }
        messages.push({ content, options: { scope, to } });
      } else {
        const searchMatch = trimmed.match(/^WEB_SEARCH(?:\[(.+?)\])?:\s*(.+)$/i);
        if (searchMatch) {
          const directive = searchMatch[1]?.trim() || null;
          const query = searchMatch[2]?.trim();
          if (query) {
            searchRequests.push({
              query,
              directive,
              raw: line,
            });
          }
        } else {
          keptLines.push(line);
        }
      }
    });

    return { cleanedText: keptLines.join('\n').trim(), messages, searchRequests };
  }

  processTeamMessages(text) {
    const { cleanedText, messages, searchRequests } = this.extractTeamMessages(text);
    messages.forEach(({ content, options }) => {
      this.sendTeamMessage(content, options);
    });
    searchRequests.forEach(({ query, directive, raw }) => {
      this.requestWebSearch(query, { instructions: directive, rawDirective: raw });
    });
    return typeof cleanedText === 'string' ? cleanedText : text;
  }

  requestWebSearch(query, options = {}) {
    if (!query || !this.messageBus || typeof this.messageBus.emitRequest !== 'function') {
      return null;
    }
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return null;

    const payload = {
      id: randomUUID(),
      type: 'web-search',
      targetAgentId: 'web-search',
      query: trimmedQuery,
      instructions: (options.instructions || '').trim() || null,
      rawDirective: options.rawDirective || null,
      requestingAgentId: this.id,
      requestingAgentName: this.name,
      timestamp: new Date().toISOString(),
    };

    this.messageBus.emitRequest(payload);
    this.emitStatus({
      actionType: 'request',
      description: `Web search requested: ${trimmedQuery.slice(0, 100)}`,
    });
    return payload;
  }
}
