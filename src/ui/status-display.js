import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

/**
 * Color scheme for different agents
 */
const AGENT_COLORS = {
  claude: '#8A2BE2',      // Purple
  codex: '#00B67A',       // Green
  gemini: '#4285F4',      // Blue
  qwen: '#FF6A00',        // Orange
  opencode: '#007AFF',    // Navy
  coordinator: '#FFD166', // Yellow
};

/**
 * Icons for different action types (using ASCII characters for sleek professional look)
 */
const ACTION_ICONS = {
  init: '▸',
  plan: '■',
  exec: '▪',
  complete: '✓',
  error: '✖',
  'team-message': '→',
  message: '◆',
  request: '?',
};

/**
 * Returns a colored chalk function for the given agent
 * @param {string} agentId - The agent identifier
 * @returns {Function} Chalk color function
 */
function agentColor(agentId) {
  const hex = AGENT_COLORS[agentId] || '#FFFFFF';
  return chalk.hex(hex);
}

/**
 * Formats a title with focus indicator
 * @param {string} title - The title text
 * @param {boolean} focused - Whether this component is focused
 * @returns {string} Formatted title
 */
function focusTitle(title, focused) {
  return focused ? chalk.bold.cyan(`▶ ${title}`) : chalk.dim(`  ${title}`);
}

/**
 * Formats a timestamp for display
 * @param {string} timestamp - ISO timestamp string
 * @returns {string} Formatted time (HH:MM:SS)
 */
function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return '00:00:00';
  }
}

/**
 * Header component displaying current prompt and session info
 */
export function Header({ session, turnNumber }) {
  const hasPrompt = session.userPrompt && session.userPrompt.trim().length > 0;
  const promptText = hasPrompt
    ? session.userPrompt
    : chalk.gray.italic('Awaiting your first prompt...');

  const sessionId = session.id ? session.id.split('-')[0] : 'unknown';
  const turnInfo = turnNumber > 0 ? chalk.gray(` • Turn ${turnNumber}`) : '';
  const agentCount = session.agents?.length || 0;
  const agentInfo = chalk.gray(` • ${agentCount} agent${agentCount !== 1 ? 's' : ''}`);

  return React.createElement(
    Box,
    {
      borderStyle: 'double',
      borderColor: 'cyan',
      paddingX: 1,
      paddingY: 0,
      flexDirection: 'column',
    },
    React.createElement(
      Text,
      null,
      `${chalk.cyan.bold('❯')} ${promptText}`
    ),
    React.createElement(
      Text,
      { color: 'gray', dimColor: true },
      `Session ${chalk.white(sessionId)}${agentInfo}${turnInfo}`
    )
  );
}

/**
 * Status feed component showing agent activity log
 */
export function StatusFeed({ entries, focused }) {
  const recent = entries.slice(-20);
  const items =
    recent.length === 0
      ? [
          React.createElement(
            Text,
            { key: 'empty', color: 'gray', dimColor: true },
            '  No activity yet...'
          ),
        ]
      : recent.map((entry, index) => {
          const icon = ACTION_ICONS[entry.actionType] || '•';
          const time = formatTime(entry.timestamp);
          const agent = agentColor(entry.agentId)(entry.agentName || entry.agentId);
          const description = entry.description || '';

          return React.createElement(
            Text,
            { key: `${entry.timestamp}-${index}` },
            `${chalk.gray(time)} ${icon} ${agent} ${chalk.dim('›')} ${description}`
          );
        });

  return React.createElement(
    Box,
    {
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      flexDirection: 'column',
      flexGrow: 1,
      overflow: 'hidden',
    },
    React.createElement(Text, { bold: true }, focusTitle('Activity Feed', focused)),
    ...items
  );
}

/**
 * User messages component showing agent messages to the user
 */
export function UserMessages({ entries, focused }) {
  const recent = entries.slice(-20);
  const items =
    recent.length === 0
      ? [
          React.createElement(
            Text,
            { key: 'empty', color: 'gray', dimColor: true },
            '  No messages yet...'
          ),
        ]
      : recent.map((entry, index) => {
          const time = formatTime(entry.timestamp);
          const agent = agentColor(entry.agentId);
          const message = entry.message || '';

          return React.createElement(
            Text,
            { key: `${entry.timestamp}-${index}` },
            `${chalk.gray(time)} ${agent('●')} ${message}`
          );
        });

  return React.createElement(
    Box,
    {
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      flexDirection: 'column',
      flexGrow: 1,
      overflow: 'hidden',
    },
    React.createElement(Text, { bold: true }, focusTitle('Messages', focused)),
    ...items
  );
}

/**
 * Wraps text to specified width
 * @param {string} text - Text to wrap
 * @param {number} maxWidth - Maximum line width
 * @returns {string[]} Array of wrapped lines
 */
function wrapText(text, maxWidth = 80) {
  const lines = [];
  let currentLine = '';

  text.split(' ').forEach((word) => {
    if ((currentLine + word).length > maxWidth) {
      if (currentLine) lines.push(currentLine.trim());
      currentLine = word + ' ';
    } else {
      currentLine += word + ' ';
    }
  });
  if (currentLine) lines.push(currentLine.trim());

  return lines;
}

/**
 * Planning feed component showing collaborative planning updates
 */
export function PlanningFeed({ entries, focused }) {
  const recent = entries.slice(-12);
  const items =
    recent.length === 0
      ? [
          React.createElement(
            Text,
            { key: 'empty', color: 'gray', dimColor: true },
            '  Planning phase will appear here...'
          ),
        ]
      : recent
          .map((entry, index) => {
            const message = entry.message || '';
            const agent = agentColor(entry.agentId);
            const lines = wrapText(message, 80);

            return lines.map((line, lineIdx) =>
              React.createElement(
                Text,
                { key: `${entry.timestamp}-${index}-${lineIdx}` },
                lineIdx === 0
                  ? `${agent('▪')} ${line}`
                  : `  ${chalk.dim(line)}` // Indent and dim continuation lines
              )
            );
          })
          .flat();

  return React.createElement(
    Box,
    {
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      flexDirection: 'column',
      flexGrow: 1,
      overflow: 'hidden',
    },
    React.createElement(Text, { bold: true }, focusTitle('Planning', focused)),
    ...items
  );
}

/**
 * Maps phase values to display names and icons (sleek ASCII style)
 */
const PHASE_CONFIG = {
  idle: { name: 'READY', icon: '◐', color: 'cyan' },
  planning: { name: 'PLANNING', icon: '■', color: 'yellow' },
  variant: { name: 'VARIANT MODE', icon: '◆', color: 'magenta' },
  'variant-selection': { name: 'SELECTION', icon: '?', color: 'yellow' },
  execution: { name: 'EXECUTING', icon: '▸', color: 'blue' },
  complete: { name: 'COMPLETE', icon: '✓', color: 'green' },
  error: { name: 'ERROR', icon: '✖', color: 'red' },
};

/**
 * Generates a clean status display for an agent based on current phase
 * @param {Object} item - Progress item for the agent
 * @param {string} phase - Current phase
 * @returns {string} Display status
 */
function getAgentDisplayStatus(item, phase) {
  const status = item.status || '';

  if (phase === 'variant-selection') {
    return chalk.yellow('Awaiting choice');
  }

  if ((phase === 'planning' || phase === 'variant') && item.actionType === 'plan') {
    if (status.includes('ready') || status.includes('Plan ready')) {
      return chalk.green('✓ Ready');
    }
    if (status.includes('Negotiating') || status.includes('split')) {
      return chalk.yellow('▪ Negotiating');
    }
    if (status.includes('Drafting')) {
      return chalk.blue('■ Planning');
    }
  }

  if (phase === 'execution' && item.actionType === 'exec') {
    if (status.includes('complete') || status.includes('Tasks complete')) {
      return chalk.green('✓ Done');
    }
    if (status.includes('Executing')) {
      return chalk.blue('▸ Working');
    }
  }

  if (phase === 'complete') {
    return chalk.green('✓ Complete');
  }

  if (phase === 'idle') {
    return status && status !== 'waiting' ? status : chalk.dim('Idle');
  }

  return status || chalk.dim('...');
}

/**
 * Agent progress component showing current status of all agents
 */
export function AgentProgress({ session, progress, phase }) {
  const phaseConfig = PHASE_CONFIG[phase] || { name: phase.toUpperCase(), icon: '●', color: 'white' };

  const items = (session.agents || []).map((agent) => {
    const item = progress[agent.id] || { status: 'waiting', actionType: 'init' };
    const displayStatus = getAgentDisplayStatus(item, phase);

    return React.createElement(
      Text,
      { key: agent.id },
      `${agentColor(agent.id)('●')} ${agentColor(agent.id).bold(agent.name)} ${chalk.dim('›')} ${displayStatus}`
    );
  });

  return React.createElement(
    Box,
    {
      borderStyle: 'single',
      borderColor: phaseConfig.color,
      paddingX: 1,
      flexDirection: 'column',
    },
    React.createElement(
      Text,
      { bold: true },
      `${phaseConfig.icon} ${chalk.hex(AGENT_COLORS.coordinator)(phaseConfig.name)}`
    ),
    React.createElement(Box, { flexDirection: 'row', gap: 2, flexWrap: 'wrap' }, ...items)
  );
}
