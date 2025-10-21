/**
 * Simple Console Demo Mode (No React/Ink)
 *
 * A fallback demo mode that works on any Node.js version, including v23+.
 * Uses only console output without React/Ink dependencies.
 *
 * @module simple-demo
 */

import chalk from 'chalk';

/**
 * Helper to sleep for demo timing
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clears the console
 */
function clearConsole() {
  console.clear();
}

/**
 * Display the logo
 */
function displayLogo() {
  const logo = [
    '  ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗    ████████╗ ██████╗  ██████╗ ███████╗████████╗██╗  ██╗███████╗██████╗ ',
    '  ██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝    ╚══██╔══╝██╔═══██╗██╔════╝ ██╔════╝╚══██╔══╝██║  ██║██╔════╝██╔══██╗',
    '  ██║ █╗ ██║██║   ██║██████╔╝█████╔╝        ██║   ██║   ██║██║  ███╗█████╗     ██║   ███████║█████╗  ██████╔╝',
    '  ██║███╗██║██║   ██║██╔══██╗██╔═██╗        ██║   ██║   ██║██║   ██║██╔══╝     ██║   ██╔══██║██╔══╝  ██╔══██╗',
    '  ╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗       ██║   ╚██████╔╝╚██████╔╝███████╗   ██║   ██║  ██║███████╗██║  ██║',
    '   ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝       ╚═╝    ╚═════╝  ╚═════╝ ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝',
  ];

  console.log('');
  logo.forEach((line, i) => {
    const colors = [chalk.cyan, chalk.cyan, chalk.blue, chalk.blue, chalk.blue, chalk.cyan];
    console.log(colors[i](line));
  });
  console.log('');
  console.log(chalk.dim('  Multi-Agent Collaboration Platform') + chalk.cyan('  │  ') + chalk.dim('v1.0.4'));
  console.log('');
  console.log(chalk.yellow('  ▸ DEMO MODE') + chalk.dim(' - Interactive showcase with simulated agents'));
  console.log(chalk.dim('  ▸ Simple Console Version') + chalk.gray(' (compatible with Node.js v23+)'));
  console.log('\n' + chalk.dim('  ─'.repeat(55)) + '\n');
}

/**
 * Display agent status bar
 */
function displayAgentStatus(agents, phase) {
  const phaseColors = {
    idle: chalk.cyan,
    planning: chalk.yellow,
    execution: chalk.blue,
    complete: chalk.green,
  };

  const phaseColor = phaseColors[phase] || chalk.white;
  console.log(chalk.dim('  ┌─ ') + phaseColor.bold(phase.toUpperCase()) + chalk.dim(' ─────────────────────────────────'));

  agents.forEach(agent => {
    const statusColor = agent.status === 'complete' ? chalk.green :
                       agent.status === 'working' ? chalk.blue :
                       chalk.dim;
    const icon = agent.status === 'complete' ? '✓' :
                 agent.status === 'working' ? '▸' :
                 agent.status === 'planning' ? '■' : '○';

    console.log(chalk.dim('  │ ') + agent.color(icon + ' ' + agent.name.padEnd(20)) + statusColor(agent.message));
  });

  console.log(chalk.dim('  └────────────────────────────────────────────────────\n'));
}

/**
 * Display activity log
 */
function displayActivity(message, agent = null, icon = '▸') {
  if (agent) {
    console.log(chalk.dim('  ' + new Date().toLocaleTimeString('en-US', { hour12: false })) +
                ' ' + icon + ' ' + agent.color(agent.name) + chalk.dim(' › ') + message);
  } else {
    console.log(chalk.dim('  ' + new Date().toLocaleTimeString('en-US', { hour12: false })) +
                ' ' + icon + ' ' + chalk.gray(message));
  }
}

/**
 * Runs the simple console demo
 */
export async function runSimpleDemo() {
  clearConsole();
  displayLogo();

  console.log(chalk.dim('  Initializing demo environment...'));
  console.log(chalk.dim('  No API keys or agent setup required\n'));

  const agents = [
    {
      id: 'claude',
      name: 'Claude Code',
      color: chalk.hex('#8A2BE2'),
      status: 'idle',
      message: 'Ready'
    },
    {
      id: 'codex',
      name: 'OpenAI Codex',
      color: chalk.hex('#00B67A'),
      status: 'idle',
      message: 'Ready'
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      color: chalk.hex('#4285F4'),
      status: 'idle',
      message: 'Ready'
    },
  ];

  console.log(chalk.green('  ✓ ') + chalk.dim('Demo session initialized'));
  console.log(chalk.dim('  ├─ Agents: ') +
              agents.map(a => a.color(a.name)).join(chalk.dim(', ')));
  console.log(chalk.dim('  └─ Task: ') + 'Build authentication system\n');

  await sleep(1500);

  // Planning Phase
  clearConsole();
  displayLogo();
  console.log(chalk.yellow.bold('  ═══ PLANNING PHASE ═══\n'));

  agents[0].status = 'planning';
  agents[0].message = 'Drafting plan...';
  displayAgentStatus(agents, 'planning');

  await sleep(1000);
  displayActivity('Drafting plan for user authentication system', agents[0], '■');
  await sleep(800);

  displayActivity('Plan: Implement JWT-based authentication with OAuth2', agents[0], '→');
  console.log(chalk.dim('        Include user registration, login, password reset, and RBAC\n'));

  agents[0].status = 'complete';
  agents[0].message = '✓ Plan ready';
  agents[1].status = 'planning';
  agents[1].message = 'Drafting plan...';

  await sleep(1200);
  displayActivity('Drafting plan for backend infrastructure', agents[1], '■');
  await sleep(700);

  displayActivity('Plan: Express.js with PostgreSQL and Redis', agents[1], '→');
  console.log(chalk.dim('        RESTful API endpoints for authentication\n'));

  agents[1].status = 'complete';
  agents[1].message = '✓ Plan ready';
  agents[2].status = 'planning';
  agents[2].message = 'Drafting plan...';

  await sleep(1000);
  displayActivity('Drafting plan for frontend components', agents[2], '■');
  await sleep(600);

  displayActivity('Plan: React components with Tailwind CSS', agents[2], '→');
  console.log(chalk.dim('        Login, registration forms with validation\n'));

  agents[2].status = 'complete';
  agents[2].message = '✓ Plan ready';

  await sleep(1500);

  // Execution Phase
  clearConsole();
  displayLogo();
  console.log(chalk.blue.bold('  ═══ EXECUTION PHASE ═══\n'));

  agents.forEach(a => { a.status = 'idle'; a.message = 'Starting...'; });
  displayAgentStatus(agents, 'execution');

  await sleep(800);

  agents[0].status = 'working';
  agents[0].message = 'Creating database schema';
  displayActivity('Creating database schema', agents[0], '▸');
  await sleep(1200);
  displayActivity('File created: db/schema.sql', agents[0], '✓');

  await sleep(600);
  agents[1].status = 'working';
  agents[1].message = 'Setting up Express server';
  displayActivity('Setting up Express server', agents[1], '▸');
  await sleep(1000);
  displayActivity('File created: server/index.js', agents[1], '✓');

  await sleep(500);
  agents[2].status = 'working';
  agents[2].message = 'Creating login component';
  displayActivity('Creating login component', agents[2], '▸');
  await sleep(1100);
  displayActivity('File created: src/components/Login.jsx', agents[2], '✓');

  await sleep(1300);
  agents[0].message = 'Implementing JWT middleware';
  displayActivity('Implementing JWT middleware', agents[0], '▸');
  await sleep(1200);
  displayActivity('File created: server/middleware/auth.js', agents[0], '✓');

  await sleep(900);
  agents[1].message = 'Creating API endpoints';
  displayActivity('Creating API endpoints', agents[1], '▸');
  await sleep(1000);
  console.log(chalk.dim('        /login, /register, /logout, /refresh-token'));
  displayActivity('File created: server/routes/auth.js', agents[1], '✓');

  await sleep(800);
  agents[2].message = 'Adding form validation';
  displayActivity('Adding form validation', agents[2], '▸');
  await sleep(900);
  displayActivity('File created: src/utils/validation.js', agents[2], '✓');

  await sleep(1100);
  agents[0].message = 'Writing integration tests';
  displayActivity('Writing integration tests', agents[0], '▸');
  await sleep(1000);
  displayActivity('File created: tests/auth.test.js', agents[0], '✓');

  await sleep(1200);

  // Completion
  clearConsole();
  displayLogo();
  console.log(chalk.green.bold('  ═══ COMPLETE ═══\n'));

  agents.forEach(a => { a.status = 'complete'; a.message = '✓ Complete'; });
  displayAgentStatus(agents, 'complete');

  displayActivity('All tasks complete!', null, '✓');
  displayActivity('Authentication system is production-ready', null, '✓');
  displayActivity('All 24 tests passing', null, '✓');

  console.log('\n' + chalk.dim('  ─'.repeat(55)));
  console.log(chalk.green('\n  ✓ ') + chalk.dim('Demo complete!'));
  console.log('');
  console.log(chalk.cyan('  ▸ To use with real agents:') + chalk.dim(' work-together'));
  console.log(chalk.dim('  ▸ See setup guide: README.md'));
  console.log(chalk.dim('  ▸ Use Node.js 20 LTS for full interactive UI\n'));
}
