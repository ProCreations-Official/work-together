import { jest } from '@jest/globals';

const registryInstances = [];
const ensureDir = jest.fn(async () => {});

jest.unstable_mockModule('fs-extra', () => {
  const mock = {
    ensureDir,
  };
  return {
    default: mock,
    ...mock,
  };
});

jest.unstable_mockModule('../src/agents/registry.js', () => {
  return {
    AgentRegistry: jest.fn().mockImplementation(() => {
      const instance = {
        runGeneratePlans: jest.fn(),
        executeAssignments: jest.fn(),
        discover: jest.fn(),
        initializeSelected: jest.fn(),
        broadcastStatus: jest.fn(),
        broadcastPlanning: jest.fn(),
        dispatchTeamMessage: jest.fn(),
        applyTeamRoster: jest.fn(),
        shutdown: jest.fn(),
        getAgentById: jest.fn(),
      };
      registryInstances.push(instance);
      return instance;
    }),
  };
});

const { Coordinator } = await import(new URL('../src/coordinator.js', import.meta.url));

function createCoordinator({ selectionMode = 'manual' } = {}) {
  registryInstances.length = 0;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const config = {
    settings: {
      collaborationMode: 'variant',
      variantSelectionMode: selectionMode,
    },
    preferences: {
      actionTimeoutMs: 0,
    },
    logger,
  };
  const coordinator = new Coordinator({ config });
  coordinator.messageBus.emitPlanning = jest.fn();
  coordinator.agentRegistry = registryInstances.at(-1) || coordinator.agentRegistry;
  return coordinator;
}

function seedSession(coordinator) {
  coordinator.session = {
    id: 'session-123',
    userPrompt: 'Implement core feature',
    roles: {
      claude: { id: 'claude', name: 'Claude Code', rolePrimary: 'Frontend', isReviewAgent: true },
      codex: { id: 'codex', name: 'OpenAI Codex', rolePrimary: 'Backend', isReviewAgent: false },
    },
    reviewAgentId: 'claude',
    agents: [
      { id: 'claude', name: 'Claude Code', rolePrimary: 'Frontend', isReviewAgent: true },
      { id: 'codex', name: 'OpenAI Codex', rolePrimary: 'Backend', isReviewAgent: false },
    ],
    plan: null,
    assignments: null,
  };
}

describe('Coordinator variant mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ensureDir.mockClear();
  });

  test('respects manual variant selection', async () => {
    const coordinator = createCoordinator({ selectionMode: 'manual' });
    seedSession(coordinator);

    coordinator.agentRegistry.runGeneratePlans.mockResolvedValue([
      { agentId: 'claude', agentName: 'Claude Code', plan: 'Claude proposed plan' },
      { agentId: 'codex', agentName: 'OpenAI Codex', plan: 'Codex proposed plan' },
    ]);
    coordinator.agentRegistry.executeAssignments.mockResolvedValue([
      { agentId: 'claude', transcript: 'Claude variant complete' },
      { agentId: 'codex', transcript: 'Codex variant complete' },
    ]);

    const planningPromise = coordinator.runPlanningPhase();
    await new Promise((resolve) => setImmediate(resolve));

    expect(coordinator.pendingVariantSelection?.requestId).toBeDefined();
    const selectionResult = coordinator.submitVariantSelection(
      coordinator.pendingVariantSelection.requestId,
      'codex'
    );

    expect(selectionResult.success).toBe(true);
    expect(selectionResult.mode).toBe('manual');

    const plan = await planningPromise;
    expect(plan.variant.selection.agentId).toBe('codex');
    expect(plan.variant.selection.mode).toBe('manual');
    expect(plan.variant.results).toHaveLength(2);
    expect(plan.variant.results.find((result) => result.agentId === 'codex')?.projectDir).toBeTruthy();
    expect(coordinator.session.assignments).toBeNull();
    expect(ensureDir).toHaveBeenCalledTimes(3);
    expect(coordinator.messageBus.emitPlanning).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'variant-results' })
    );
    expect(coordinator.messageBus.emitPlanning).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'variant-selected', agentId: 'codex' })
    );
  });

  test('auto selection defaults to review agent proposal', async () => {
    const coordinator = createCoordinator({ selectionMode: 'auto' });
    seedSession(coordinator);

    coordinator.agentRegistry.runGeneratePlans.mockResolvedValue([
      { agentId: 'claude', agentName: 'Claude Code', plan: 'Claude review plan' },
      { agentId: 'codex', agentName: 'OpenAI Codex', plan: 'Codex backup plan' },
    ]);
    coordinator.agentRegistry.executeAssignments.mockResolvedValue([
      { agentId: 'claude', transcript: 'Claude variant shipped' },
      { agentId: 'codex', transcript: 'Codex variant shipped' },
    ]);

    const plan = await coordinator.runPlanningPhase();

    expect(coordinator.pendingVariantSelection).toBeNull();
    expect(plan.variant.selection.agentId).toBe('claude');
    expect(plan.variant.selection.mode).toBe('auto');
    expect(plan.variant.selection.projectDir).toBeTruthy();
    expect(plan.consolidated.summary).toContain('Claude Code');
    expect(coordinator.messageBus.emitPlanning).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'variant-selected', agentId: 'claude' })
    );
  });
  
  test('setCollaborationMode updates state and clears pending selection', () => {
    const coordinator = createCoordinator({ selectionMode: 'manual' });
    seedSession(coordinator);
    const resolver = jest.fn();
    coordinator.pendingVariantSelection = { requestId: 'test', resolve: resolver };

    coordinator.setCollaborationMode('collaborative');

    expect(coordinator.getCollaborationMode()).toBe('collaborative');
    expect(coordinator.pendingVariantSelection).toBeNull();
    expect(resolver).toHaveBeenCalledWith({ type: 'auto' });
  });
});
