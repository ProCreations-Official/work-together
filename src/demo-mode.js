/**
 * Demo Mode Module
 *
 * Provides a demonstration of the CLI interface with simulated data.
 * No API keys or agent setup required - perfect for previewing the UI.
 *
 * @module demo-mode
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

/**
 * Creates a mock message bus for demo mode
 * @returns {Object} Mock message bus
 */
function createMockMessageBus() {
  const emitter = new EventEmitter();
  const subscribers = {
    status: new Set(),
    planning: new Set(),
    error: new Set(),
    teamMessage: new Set(),
    request: new Set(),
  };

  return {
    emitStatus: (update) => {
      subscribers.status.forEach((cb) => cb(update));
    },
    emitPlanning: (update) => {
      subscribers.planning.forEach((cb) => cb(update));
    },
    emitError: (error) => {
      subscribers.error.forEach((cb) => cb(error));
    },
    emitTeamMessage: (message) => {
      subscribers.teamMessage.forEach((cb) => cb(message));
    },
    emitRequest: (request) => {
      subscribers.request.forEach((cb) => cb(request));
    },
    onStatus: (cb) => {
      subscribers.status.add(cb);
      return () => subscribers.status.delete(cb);
    },
    onPlanning: (cb) => {
      subscribers.planning.add(cb);
      return () => subscribers.planning.delete(cb);
    },
    onError: (cb) => {
      subscribers.error.add(cb);
      return () => subscribers.error.delete(cb);
    },
    onTeamMessage: (cb) => {
      subscribers.teamMessage.add(cb);
      return () => subscribers.teamMessage.delete(cb);
    },
    onRequest: (cb) => {
      subscribers.request.add(cb);
      return () => subscribers.request.delete(cb);
    },
    removeAll: () => {
      Object.values(subscribers).forEach((set) => set.clear());
    },
  };
}

/**
 * Creates a mock coordinator for demo mode
 * @returns {Object} Mock coordinator
 */
export function createMockCoordinator() {
  const messageBus = createMockMessageBus();
  const statusSubscribers = new Set();
  const planningSubscribers = new Set();
  const variantSubscribers = new Set();

  let mode = 'collaborative';
  let isRunning = false;

  // Setup message bus forwarding
  messageBus.onStatus((update) => {
    statusSubscribers.forEach((cb) => cb(update));
  });

  messageBus.onPlanning((update) => {
    planningSubscribers.forEach((cb) => cb(update));
  });

  const coordinator = {
    config: {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      settings: {
        collaborationMode: 'collaborative',
      },
    },

    messageBus,

    discoverAgents: async () => {
      return [
        {
          id: 'claude',
          name: 'Claude Code',
          available: true,
          issues: [],
          notes: ['Latest Sonnet 4.5 model'],
        },
        {
          id: 'codex',
          name: 'OpenAI Codex',
          available: true,
          issues: [],
          notes: ['GPT-4 based'],
        },
        {
          id: 'gemini',
          name: 'Gemini CLI',
          available: true,
          issues: [],
          notes: ['Flash 2.5 model'],
        },
        {
          id: 'qwen',
          name: 'Qwen Code',
          available: false,
          issues: ['API key not configured'],
          notes: [],
        },
        {
          id: 'opencode',
          name: 'OpenCode',
          available: false,
          issues: ['SDK not installed'],
          notes: [],
        },
      ];
    },

    initializeSession: async ({ agentSelections, userPrompt }) => {
      const sessionId = randomUUID();
      const agents = agentSelections.map((id) => ({
        id,
        name: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'OpenAI Codex' : 'Gemini CLI',
        rolePrimary:
          id === 'claude'
            ? 'Full-stack development'
            : id === 'codex'
            ? 'Backend & API design'
            : 'Frontend & UI',
        isReviewAgent: id === 'claude',
      }));

      return {
        id: sessionId,
        userPrompt,
        createdAt: new Date().toISOString(),
        agents,
        failures: [],
      };
    },

    subscribeToStatus: (cb) => {
      statusSubscribers.add(cb);
      return () => statusSubscribers.delete(cb);
    },

    subscribeToPlanning: (cb) => {
      planningSubscribers.add(cb);
      return () => planningSubscribers.delete(cb);
    },

    subscribeToVariantSelection: (cb) => {
      variantSubscribers.add(cb);
      return () => variantSubscribers.delete(cb);
    },

    getCollaborationMode: () => mode,

    setCollaborationMode: (newMode) => {
      mode = newMode;
      return mode;
    },

    submitVariantSelection: () => {
      return { success: true, message: 'Selection accepted' };
    },

    runPlanningPhase: async () => {
      if (isRunning) return;
      isRunning = true;

      await sleep(500);

      // Emit planning status updates
      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'claude',
        agentName: 'Claude Code',
        actionType: 'plan',
        description: 'Drafting plan for user authentication system',
        affectedFiles: [],
      });

      await sleep(800);

      messageBus.emitPlanning({
        stage: 'initial-plan',
        agentId: 'claude',
        plan: 'Implement JWT-based authentication with OAuth2 support, including user registration, login, password reset, and role-based access control.',
      });

      await sleep(600);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'codex',
        agentName: 'OpenAI Codex',
        actionType: 'plan',
        description: 'Drafting plan for backend infrastructure',
        affectedFiles: [],
      });

      await sleep(700);

      messageBus.emitPlanning({
        stage: 'initial-plan',
        agentId: 'codex',
        plan: 'Set up Express.js server with PostgreSQL database, Redis for session management, and implement RESTful API endpoints for authentication.',
      });

      await sleep(500);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'gemini',
        agentName: 'Gemini CLI',
        actionType: 'plan',
        description: 'Drafting plan for frontend components',
        affectedFiles: [],
      });

      await sleep(600);

      messageBus.emitPlanning({
        stage: 'initial-plan',
        agentId: 'gemini',
        plan: 'Create React components for login, registration, and password reset forms with Tailwind CSS styling and form validation.',
      });

      await sleep(800);

      messageBus.emitPlanning({
        stage: 'coordinator-summary',
        plan: 'Combined plan: Full-stack authentication system with JWT, OAuth2, database integration, and responsive UI components.',
      });

      await sleep(600);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'claude',
        agentName: 'Claude Code',
        actionType: 'plan',
        description: 'Negotiating task allocation',
        affectedFiles: [],
      });

      await sleep(500);

      messageBus.emitPlanning({
        stage: 'allocation',
        agentId: 'claude',
        allocation: 'I will handle database schema design, JWT implementation, middleware setup, and integration testing.',
      });

      await sleep(400);

      messageBus.emitPlanning({
        stage: 'allocation',
        agentId: 'codex',
        allocation: 'I will build the Express server, API routes, password hashing with bcrypt, and Redis session store.',
      });

      await sleep(400);

      messageBus.emitPlanning({
        stage: 'allocation',
        agentId: 'gemini',
        allocation: 'I will create the UI components, form validation, responsive design, and client-side routing.',
      });

      await sleep(600);

      messageBus.emitPlanning({
        stage: 'final-division',
        assignments: {
          claude: 'Database schema, JWT, middleware, testing',
          codex: 'Express server, API routes, bcrypt, Redis',
          gemini: 'React components, forms, styling, routing',
        },
      });

      await sleep(500);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'coordinator',
        agentName: 'Coordinator',
        actionType: 'plan',
        description: 'Plan ready - starting execution phase',
        affectedFiles: [],
      });
    },

    runExecutionPhase: async () => {
      await sleep(800);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'claude',
        agentName: 'Claude Code',
        actionType: 'exec',
        description: 'Creating database schema',
        affectedFiles: ['db/schema.sql'],
      });

      await sleep(1200);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'codex',
        agentName: 'OpenAI Codex',
        actionType: 'exec',
        description: 'Setting up Express server',
        affectedFiles: ['server/index.js'],
      });

      await sleep(1000);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'gemini',
        agentName: 'Gemini CLI',
        actionType: 'exec',
        description: 'Creating login component',
        affectedFiles: ['src/components/Login.jsx'],
      });

      await sleep(1500);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'claude',
        agentName: 'Claude Code',
        actionType: 'exec',
        description: 'Implementing JWT middleware',
        affectedFiles: ['server/middleware/auth.js'],
      });

      await sleep(1300);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'codex',
        agentName: 'OpenAI Codex',
        actionType: 'exec',
        description: 'Creating API endpoints',
        affectedFiles: ['server/routes/auth.js'],
        userMessage: 'API endpoints created for /login, /register, /logout, and /refresh-token',
      });

      await sleep(1100);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'gemini',
        agentName: 'Gemini CLI',
        actionType: 'exec',
        description: 'Adding form validation',
        affectedFiles: ['src/utils/validation.js'],
      });

      await sleep(1400);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'claude',
        agentName: 'Claude Code',
        actionType: 'exec',
        description: 'Writing integration tests',
        affectedFiles: ['tests/auth.test.js'],
      });

      await sleep(1200);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'codex',
        agentName: 'OpenAI Codex',
        actionType: 'exec',
        description: 'Configuring Redis session store',
        affectedFiles: ['server/config/redis.js'],
      });

      await sleep(1000);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'gemini',
        agentName: 'Gemini CLI',
        actionType: 'exec',
        description: 'Tasks complete - UI ready for testing',
        affectedFiles: [],
        userMessage: 'All frontend components are complete and responsive. Ready for integration!',
      });

      await sleep(800);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'codex',
        agentName: 'OpenAI Codex',
        actionType: 'exec',
        description: 'Tasks complete - backend ready',
        affectedFiles: [],
      });

      await sleep(600);

      messageBus.emitStatus({
        timestamp: new Date().toISOString(),
        agentId: 'claude',
        agentName: 'Claude Code',
        actionType: 'exec',
        description: 'Tasks complete - all tests passing',
        affectedFiles: [],
        userMessage: 'Integration complete! All 24 tests passing. Authentication system is production-ready.',
      });

      await sleep(500);
    },

    shutdown: async () => {
      isRunning = false;
      messageBus.removeAll();
    },

    getSession: () => ({}),
  };

  return coordinator;
}

/**
 * Helper to sleep for demo timing
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates mock configuration for demo mode
 * @returns {Object} Mock config
 */
export function createMockConfig() {
  return {
    apiKeys: {},
    settings: {
      autoSelectAgents: true,
      defaultAgents: ['claude', 'codex', 'gemini'],
      collaborationMode: 'collaborative',
    },
    preferences: {},
    path: '~/.work-together/config.toml',
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}
