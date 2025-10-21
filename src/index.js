#!/usr/bin/env node

/**
 * Work-Together CLI Entry Point
 *
 * A collaborative AI coding CLI that coordinates multiple agents
 * (Claude, Codex, Gemini, Qwen, OpenCode) to work together on coding tasks.
 *
 * @module index
 */

import 'dotenv/config';
import prompts from 'prompts';
import chalk from 'chalk';
import { initializeConfig } from './config.js';
import { Coordinator } from './coordinator.js';
import { launchCLI } from './ui/cli.js';

/**
 * Displays a welcome banner with version and basic info
 */
function displayWelcome() {
  console.log(chalk.cyan.bold('\n╭─────────────────────────────────────────╮'));
  console.log(chalk.cyan.bold('│     Work-Together CLI v1.0.4           │'));
  console.log(chalk.cyan.bold('│     Multi-Agent Collaboration          │'));
  console.log(chalk.cyan.bold('╰─────────────────────────────────────────╯\n'));
}

/**
 * Prompts the user to select which agents to use for collaboration
 * @param {Array} discovered - Array of discovered agent info objects
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} Selected agent IDs
 */
async function promptAgentSelection(discovered, config) {
  const defaults = Array.isArray(config.settings?.defaultAgents)
    ? config.settings.defaultAgents
    : [];

  const choices = discovered.map((info) => {
    const messages = [];
    if (info.issues?.length) {
      messages.push(chalk.red(info.issues.join(' ')));
    }
    if (info.notes?.length) {
      messages.push(chalk.gray(info.notes.join(' | ')));
    }

    // Color-code agent names
    const colorMap = {
      claude: chalk.hex('#8A2BE2'),
      codex: chalk.hex('#00B67A'),
      gemini: chalk.hex('#4285F4'),
      qwen: chalk.hex('#FF6A00'),
      opencode: chalk.hex('#007AFF'),
    };
    const colorFn = colorMap[info.id] || chalk.white;
    const titleText = info.available
      ? colorFn(info.name)
      : `${chalk.dim(info.name)} ${chalk.red('(unavailable)')}`;

    return {
      title: titleText,
      value: info.id,
      description: messages.length ? messages.join(' | ') : chalk.green('✓ Ready'),
      disabled: !info.available,
      selected: info.available && defaults.includes(info.id),
    };
  });

  const onCancel = () => {
    console.log(chalk.yellow('\n⚠ Selection cancelled. Exiting...'));
    process.exit(0);
  };

  const { agents } = await prompts(
    {
      type: 'multiselect',
      name: 'agents',
      message: chalk.bold('Select agents to collaborate'),
      hint: '— Space to toggle, Enter to confirm, at least 1 required —',
      choices,
      min: 1,
      instructions: false,
    },
    { onCancel }
  );

  if (!agents || agents.length === 0) {
    console.log(chalk.red('\n✖ No agents selected. Exiting...'));
    process.exit(0);
  }

  return agents;
}

/**
 * Main bootstrap function that initializes and runs the CLI
 */
async function bootstrap() {
  displayWelcome();

  // Initialize configuration
  console.log(chalk.gray('Initializing configuration...'));
  const config = await initializeConfig();

  // Create coordinator
  const coordinator = new Coordinator({ config });

  // Discover available agents
  console.log(chalk.gray('Discovering available agents...\n'));
  const discovered = await coordinator.discoverAgents();

  // Show warnings for unavailable agents (except opencode which is optional)
  const unavailable = discovered.filter((info) => !info.available && info.id !== 'opencode');
  if (unavailable.length > 0) {
    console.log(chalk.yellow('⚠ Some agents are unavailable:'));
    unavailable.forEach((info) => {
      const reason = info.issues?.join(', ') || 'unknown issue';
      console.log(chalk.yellow(`  • ${info.name}: ${reason}`));
    });
    console.log('');
  }

  // Check if any agents are available
  const available = discovered.filter((info) => info.available);
  if (!available.length) {
    console.error(chalk.red('✖ No agents available. Install required SDKs or configure API keys.\n'));
    console.log(chalk.bold('Agent Status:'));
    discovered.forEach((info) => {
      const status = info.issues?.join(', ') || 'Unknown issue';
      console.log(chalk.red(`  ✖ ${info.name}: ${status}`));
    });
    console.log(chalk.gray('\nPlease check the README for setup instructions.'));
    process.exit(1);
  }

  console.log(chalk.green(`✓ Found ${available.length} available agent${available.length !== 1 ? 's' : ''}\n`));

  // Select agents (auto or manual)
  let agentSelections = [];
  const defaults = Array.isArray(config.settings?.defaultAgents)
    ? config.settings.defaultAgents
    : [];

  if (config.settings?.autoSelectAgents && defaults.length) {
    agentSelections = defaults.filter((id) => available.some((info) => info.id === id));
    if (agentSelections.length) {
      const selectedNames = agentSelections
        .map((id) => discovered.find((info) => info.id === id)?.name || id)
        .join(', ');
      console.log(chalk.gray(`Auto-selecting agents: ${chalk.cyan(selectedNames)}\n`));
    } else {
      console.log(chalk.yellow('⚠ Configured default agents are unavailable. Showing selection prompt...\n'));
    }
  }

  if (!agentSelections.length) {
    agentSelections = await promptAgentSelection(discovered, config);
    console.log('');
  }

  // Initialize session
  const userPrompt = '';
  let session;
  try {
    console.log(chalk.gray('Initializing session...'));
    session = await coordinator.initializeSession({ agentSelections, userPrompt });
    console.log(chalk.green('✓ Session initialized\n'));
  } catch (err) {
    console.error(chalk.red('✖ Failed to initialize session:'), err.message || err);
    process.exit(1);
  }

  // Launch the CLI
  try {
    await launchCLI({ coordinator, config, session });
  } catch (err) {
    console.error(chalk.red('\n✖ CLI error:'), err.message || err);
    process.exit(1);
  } finally {
    // Clean shutdown
    console.log(chalk.gray('\nShutting down...'));
    await coordinator.shutdown({
      id: session.id,
      completed: true,
    });
    console.log(chalk.green('✓ Goodbye!\n'));
  }
}

// Handle uncaught errors gracefully
bootstrap().catch((err) => {
  console.error(chalk.red('\n✖ Fatal error:'), err.message || err);
  if (err.stack && process.env.DEBUG) {
    console.error(chalk.gray('\nStack trace:'));
    console.error(chalk.gray(err.stack));
  }
  console.log(chalk.gray('\nSet DEBUG=1 environment variable for stack traces.'));
  process.exit(1);
});
