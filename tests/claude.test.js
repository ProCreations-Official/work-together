import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

function createChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function resolveChild(child, { stdout = '', stderr = '', code = 0, signal = null } = {}) {
  if (stdout) {
    child.stdout.emit('data', stdout);
  }
  if (stderr) {
    child.stderr.emit('data', stderr);
  }
  child.emit('close', code, signal);
}

const spawnMock = jest.fn();
const verifyClaudeCliLogin = jest.fn(async () => ({ ok: true, path: '/usr/bin/claude' }));
const detectClaudeSubscriptionAuth = jest.fn(async () => ({ hasAuthToken: false }));
const findExecutable = jest.fn(async () => '/usr/bin/claude');

jest.unstable_mockModule('child_process', () => ({ spawn: spawnMock }));
jest.unstable_mockModule('../src/utils/subscription-auth.js', () => ({
  detectClaudeSubscriptionAuth,
  detectCodexSubscriptionAuth: jest.fn(),
  findExecutable,
  verifyClaudeCliLogin,
}));

const { ClaudeAgent } = await import(new URL('../src/agents/claude.js', import.meta.url));

describe('ClaudeAgent CLI integration', () => {
  afterEach(() => {
    jest.clearAllMocks();
    spawnMock.mockReset();
  });

  it('allows CLI usage even if verification fails but CLI exists', async () => {
    verifyClaudeCliLogin.mockResolvedValueOnce({ ok: false, message: 'Temporary error' });
    const agent = new ClaudeAgent({
      messageBus: { emitStatus: jest.fn() },
      config: { getApiKey: () => null, logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } },
    });

    const availability = await agent.checkAvailability();
    expect(availability.available).toBe(true);
    expect(availability.notes?.some((note) => note.includes('Claude CLI'))).toBe(true);
  });

  it('marks agent available when CLI login is detected', async () => {
    const agent = new ClaudeAgent({
      messageBus: { emitStatus: jest.fn() },
      config: { getApiKey: () => null, logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } },
    });

    const availability = await agent.checkAvailability();
    expect(availability.available).toBe(true);
    expect(availability.notes?.some((note) => note.includes('Claude CLI login'))).toBe(true);
    expect(verifyClaudeCliLogin).toHaveBeenCalled();
  });

  it('runs prompts through the CLI and emits plan status updates', async () => {
    spawnMock.mockImplementation(() => {
      const child = createChildProcess();
      setImmediate(() => {
        resolveChild(child, {
          stdout: 'Analyse requirements\nOutline steps\nConfirm deliverables',
        });
      });
      return child;
    });

    const emitted = [];
    const agent = new ClaudeAgent({
      messageBus: { emitStatus: (update) => emitted.push(update) },
      config: { getApiKey: () => null, logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } },
    });

    await agent.checkAvailability();
    await agent.initialize({ userPrompt: 'Create helper' });
    const plan = await agent.generatePlan({ userPrompt: 'Create helper' });

    expect(plan).toContain('Analyse requirements');
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/claude',
      expect.arrayContaining(['-p', expect.any(String)]),
      expect.objectContaining({ cwd: process.cwd() })
    );
    expect(emitted.some((event) => event.actionType === 'plan')).toBe(true);
  });

  it('injects teammate updates via system prompt', async () => {
    const receivedArgs = [];
    spawnMock.mockImplementation((cmd, args) => {
      receivedArgs.push(args);
      const child = createChildProcess();
      setImmediate(() => {
        resolveChild(child, { stdout: 'Done' });
      });
      return child;
    });

    const agent = new ClaudeAgent({
      messageBus: { emitStatus: jest.fn() },
      config: { getApiKey: () => null, logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } },
    });

    await agent.checkAvailability();
    await agent.initialize({ userPrompt: 'Init' });
    await agent.receiveStatusUpdate({
      agentId: 'codex',
      agentName: 'OpenAI Codex',
      description: 'Plan ready',
      timestamp: new Date('2025-10-10T12:00:00Z').toISOString(),
    });

    await agent.generatePlan({ userPrompt: 'Do something' });

    const lastArgs = receivedArgs.pop();
    const appendIndex = lastArgs.findIndex((arg) => arg === '--append-system-prompt');
    expect(appendIndex).not.toBe(-1);
    expect(lastArgs[appendIndex + 1]).toContain('OpenAI Codex: Plan ready');
  });
});
