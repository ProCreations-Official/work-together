import { jest } from '@jest/globals';

const claudePlanChunks = ['Analyse task', 'Propose steps'];
const codexPlanChunks = ['Assess code surface', 'Draft function'];
const codexExecChunks = ['Create file', 'Implement function'];

const buildEvents = (chunks) => [
  ...chunks.map((text) => ({ type: 'item.completed', item: { type: 'agent_message', text } })),
  { type: 'turn.completed', usage: {} },
];

// Claude mocks
const claudeCreateThread = jest.fn(() => Promise.resolve());
const claudeQuery = jest.fn((options = {}) => {
  if (options.stream) {
    return createStream(claudePlanChunks);
  }
  return 'Claude handles design and review.';
});
const claudeAddContext = jest.fn(() => Promise.resolve());
const claudeCloseThread = jest.fn(() => Promise.resolve());

class MockClaudeClient {
  constructor() {
    this.createThread = claudeCreateThread;
    this.query = claudeQuery;
    this.addContext = claudeAddContext;
    this.closeThread = claudeCloseThread;
  }
}

// Codex mocks
let codexEventQueue = [];
const codexRunStreamed = jest.fn(async (input, queueRef) => {
  const events = queueRef.shift() || [];
  async function* generator() {
    for (const event of events) {
      yield event;
    }
  }
  return { events: generator() };
});
const codexAddMessage = jest.fn(() => Promise.resolve());
const codexArchive = jest.fn(() => Promise.resolve());

class MockCodexThread {
  constructor(queueRef) {
    this.id = 'thread-1';
    this.queueRef = queueRef;
  }

  async runStreamed(input, options = {}) {
    return codexRunStreamed(input, this.queueRef, options);
  }
}

const codexStartThread = jest.fn(() => Promise.resolve(new MockCodexThread(codexEventQueue)));

class MockCodexClient {
  constructor() {}
  startThread = codexStartThread;
  addMessage = codexAddMessage;
  archiveThread = codexArchive;
}

class MockOpenCodeClient {
  constructor() {}
  startSession = () => Promise.resolve({ id: 'opencode-session' });
  generatePlan = ({ prompt }) => `OpenCode mirrors prompt: ${prompt}`;
  proposeAllocation = () => 'OpenCode will watch for conflicts.';
  executeTasks = async function* execute() {
    yield 'OpenCode standby';
  };
  pushStatus = () => Promise.resolve();
  pushPlanningUpdate = () => Promise.resolve();
  endSession = () => Promise.resolve();
}

jest.unstable_mockModule('@anthropic-ai/claude-code', () => ({
  ClaudeSDKClient: MockClaudeClient,
}));

jest.unstable_mockModule('@openai/codex-sdk', () => ({
  Codex: MockCodexClient,
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
  OpenCode: MockOpenCodeClient,
}));

const detectCodexSubscriptionAuth = jest.fn(async () => ({
  hasTokens: true,
  preferredAuthMethod: 'chatgpt',
}));
const detectClaudeSubscriptionAuth = jest.fn(async () => ({
  hasAuthToken: true,
}));
const findExecutable = jest.fn(async (binary) => `/usr/bin/${binary}`);

jest.unstable_mockModule('../src/utils/subscription-auth.js', () => ({
  detectCodexSubscriptionAuth,
  detectClaudeSubscriptionAuth,
  findExecutable,
  verifyClaudeCliLogin: jest.fn(),
}));

const { CodexAgent } = await import(new URL('../src/agents/codex.js', import.meta.url));
const { Coordinator } = await import(new URL('../src/coordinator.js', import.meta.url));

describe('CodexAgent wrapper and coordinator orchestration', () => {
  afterEach(() => {
    jest.clearAllMocks();
    codexEventQueue = [];
  });

  const baseConfig = {
    getApiKey: (agentId) => {
      if (agentId === 'codex') return 'test-openai-key';
      if (agentId === 'claude') return 'test-anthropic-key';
      if (agentId === 'opencode') return 'test-opencode-key';
      return null;
    },
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    preferences: { actionTimeoutMs: 60_000 },
  };

  it('generates a plan with a single Codex agent', async () => {
    codexEventQueue.push(buildEvents(codexPlanChunks));
    const emitted = [];
    const messageBus = {
      emitStatus: (update) => emitted.push(update),
    };
    const agent = new CodexAgent({ messageBus, config: baseConfig });
    const availability = await agent.checkAvailability();
    expect(availability.available).toBe(true);
    await agent.initialize({ userPrompt: 'Write a parser' });
    const plan = await agent.generatePlan({ userPrompt: 'Write a parser' });
    expect(plan).toContain('Assess code surface');
    expect(emitted.filter((evt) => evt.actionType === 'plan').length).toBeGreaterThan(0);
  });

  it('marks agent available via subscription login when API key missing', async () => {
    const emitted = [];
    const messageBus = { emitStatus: (update) => emitted.push(update) };
    const config = {
      ...baseConfig,
      getApiKey: () => null,
    };
    const agent = new CodexAgent({ messageBus, config });
    const availability = await agent.checkAvailability();
    expect(availability.available).toBe(true);
    expect(availability.notes?.some((note) => note.includes('subscription'))).toBe(true);
    expect(detectCodexSubscriptionAuth).toHaveBeenCalled();
  });

  it('runs planning and execution with Claude and Codex together', async () => {
    codexEventQueue.push(buildEvents(codexPlanChunks));
    codexEventQueue.push(buildEvents(['Codex handles implementation details.'])) ;
    codexEventQueue.push(buildEvents(codexExecChunks));
    const coordinator = new Coordinator({ config: baseConfig });
    const discoveries = await coordinator.discoverAgents();
    expect(discoveries.some((info) => info.id === 'codex' && info.available)).toBe(true);

    const session = await coordinator.initializeSession({
      agentSelections: ['claude', 'codex'],
      userPrompt: 'Create sum function',
    });

    expect(session.agents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining(['claude', 'codex', 'web-search'])
    );

    const plan = await coordinator.runPlanningPhase();
    expect(plan.initial.length).toBeGreaterThanOrEqual(3);
    expect(codexRunStreamed).toHaveBeenCalled();

    const transcripts = await coordinator.runExecutionPhase();
    expect(transcripts.length).toBeGreaterThanOrEqual(3);
    expect(transcripts.find((item) => item.agentId === 'codex').transcript).toContain('Create file');
  });

  it('propagates status updates across agents', async () => {
    codexEventQueue.push(buildEvents(codexPlanChunks));
    codexEventQueue.push(buildEvents(['Codex owns execution steps.']));
    const coordinator = new Coordinator({ config: baseConfig });
    await coordinator.discoverAgents();
    await coordinator.initializeSession({
      agentSelections: ['claude', 'codex'],
      userPrompt: 'Sync updates',
    });

    const claudeAgent = coordinator.agentRegistry.getAgentById('claude');
    claudeAgent.emitStatus({ actionType: 'plan', description: 'Outline ready' });

    expect(codexAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('Outline ready'),
      })
    );
  });

  it('continues when Codex fails during initialise', async () => {
    const coordinator = new Coordinator({ config: baseConfig });
    await coordinator.discoverAgents();

    const originalInitialize = coordinator.agentRegistry.getAgentById('codex').initialize;
    coordinator.agentRegistry.getAgentById('codex').initialize = jest.fn(() => {
      throw new Error('Codex offline');
    });

    const session = await coordinator.initializeSession({
      agentSelections: ['claude', 'codex'],
      userPrompt: 'Handle failure',
    });

    const agentIds = session.agents.map((agent) => agent.id);
    expect(agentIds).toContain('claude');
    expect(agentIds).not.toContain('codex');
    expect(agentIds).toContain('web-search');

    coordinator.agentRegistry.getAgentById('codex').initialize = originalInitialize;
  });
});
