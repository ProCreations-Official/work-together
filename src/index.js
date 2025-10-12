#!/usr/bin/env node
import 'dotenv/config';
import prompts from 'prompts';
import chalk from 'chalk';
import { initializeConfig } from './config.js';
import { Coordinator } from './coordinator.js';
import { launchCLI } from './ui/cli.js';

async function promptAgentSelection(discovered, config) {
  const defaults = Array.isArray(config.settings?.defaultAgents)
    ? config.settings.defaultAgents
    : [];

  const choices = discovered.map((info) => {
    const messages = [];
    if (info.issues?.length) {
      messages.push(info.issues.join(' '));
    }
    if (info.notes?.length) {
      messages.push(info.notes.join(' | '));
    }
    return {
      title: `${info.name}${info.available ? '' : chalk.red(' (unavailable)')}`,
      value: info.id,
      description: messages.length ? messages.join(' | ') : 'Ready',
      disabled: !info.available,
      selected: info.available && defaults.includes(info.id),
    };
  });

  const onCancel = () => {
    console.log('\nCancelled.');
    process.exit(1);
  };

  const { agents } = await prompts(
    {
      type: 'multiselect',
      name: 'agents',
      message: 'Select AI agents to collaborate (space to toggle, enter to confirm)',
      hint: 'Claude (purple), Codex (green), Gemini (blue), Qwen (orange), OpenCode (navy)',
      choices,
      min: 1,
    },
    { onCancel }
  );

  return agents;
}

async function bootstrap() {
  const config = await initializeConfig();
  const coordinator = new Coordinator({ config });

  const discovered = await coordinator.discoverAgents();
  discovered
    .filter((info) => !info.available && info.id !== 'opencode')
    .forEach((info) => {
      console.warn(`${info.name} unavailable: ${info.issues?.join(', ') || 'unknown issue'}`);
    });

  const available = discovered.filter((info) => info.available);
  if (!available.length) {
    console.error('No agents available. Install required SDKs or configure API keys.');
    discovered.forEach((info) => {
      console.error(`- ${info.name}: ${info.issues?.join(', ') || 'Unknown issue'}`);
    });
    process.exit(1);
  }

  let agentSelections = [];
  const defaults = Array.isArray(config.settings?.defaultAgents)
    ? config.settings.defaultAgents
    : [];
  if (config.settings?.autoSelectAgents && defaults.length) {
    agentSelections = defaults.filter((id) => available.some((info) => info.id === id));
    if (agentSelections.length) {
      console.log(chalk.gray(`Using agents from config: ${agentSelections.join(', ')}`));
    } else {
      console.warn('Configured default agents are unavailable; please select manually.');
    }
  }

  if (!agentSelections.length) {
    agentSelections = await promptAgentSelection(discovered, config);
  }

  const userPrompt = '';

  let session;
  try {
    session = await coordinator.initializeSession({ agentSelections, userPrompt });
  } catch (err) {
    console.error('Failed to initialise session:', err.message || err);
    process.exit(1);
  }

  await launchCLI({ coordinator, config, session });

  await coordinator.shutdown({
    id: session.id,
    completed: true,
  });
}

bootstrap().catch((err) => {
  console.error('Fatal error in work-together CLI:', err);
  process.exitCode = 1;
});
