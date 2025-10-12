import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

const AGENT_COLORS = {
  claude: '#8A2BE2',
  codex: '#00B67A',
  gemini: '#4285F4',
  qwen: '#FF6A00',
  opencode: '#007AFF',
  coordinator: '#FFD166',
};

function agentColor(agentId) {
  const hex = AGENT_COLORS[agentId] || '#FFFFFF';
  return chalk.hex(hex);
}

function focusTitle(title, focused) {
  return focused ? chalk.bold(`${title} ←`) : title;
}

export function Header({ session, turnNumber }) {
  const promptText =
    session.userPrompt && session.userPrompt.trim().length
      ? session.userPrompt
      : chalk.gray('Awaiting prompt...');
  return React.createElement(
    Box,
    { borderStyle: 'double', borderColor: 'cyan', paddingX: 1, flexDirection: 'column' },
    React.createElement(
      Text,
      null,
      `${chalk.cyan.bold('›')} ${promptText} ${turnNumber > 0 ? chalk.gray(`(turn ${turnNumber})`) : ''}`
    ),
    React.createElement(
      Text,
      { color: 'gray' },
      `Session ${session.id.split('-')[0]}`
    )
  );
}

export function StatusFeed({ entries, focused }) {
  const recent = entries.slice(-20);
  const items =
    recent.length === 0
      ? [React.createElement(Text, { key: 'empty', color: 'gray', dimColor: true }, 'Waiting..')]
      : recent.map((entry, index) =>
          React.createElement(
            Text,
            { key: `${entry.timestamp}-${index}` },
            `${chalk.gray(new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))} ` +
              `${agentColor(entry.agentId)(entry.agentName || entry.agentId)} ${chalk.dim('›')} ${entry.description}`
          )
        );

  return React.createElement(
    Box,
    {
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
      paddingX: 1,
      flexDirection: 'column',
      flexGrow: 1,
    },
    React.createElement(Text, { bold: true }, focusTitle('Status', focused)),
    items
  );
}

export function UserMessages({ entries, focused }) {
  const recent = entries.slice(-20);
  const items =
    recent.length === 0
      ? [React.createElement(Text, { key: 'empty', color: 'gray', dimColor: true }, 'No updates yet')]
      : recent.map((entry, index) =>
          React.createElement(
            Text,
            { key: `${entry.timestamp}-${index}` },
            `${agentColor(entry.agentId)('●')} ${entry.message}`
          )
        );

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

export function PlanningFeed({ entries, focused }) {
  const recent = entries.slice(-12);
  const items =
    recent.length === 0
      ? [React.createElement(Text, { key: 'empty', color: 'gray', dimColor: true }, 'No planning yet')]
      : recent.map((entry, index) => {
          const message = entry.message || '';
          // Word wrap long messages
          const maxWidth = 80;
          const lines = [];
          let currentLine = '';

          message.split(' ').forEach((word) => {
            if ((currentLine + word).length > maxWidth) {
              if (currentLine) lines.push(currentLine.trim());
              currentLine = word + ' ';
            } else {
              currentLine += word + ' ';
            }
          });
          if (currentLine) lines.push(currentLine.trim());

          return lines.map((line, lineIdx) =>
            React.createElement(
              Text,
              { key: `${entry.timestamp}-${index}-${lineIdx}` },
              lineIdx === 0
                ? `${agentColor(entry.agentId)('●')} ${line}`
              : `  ${line}` // Indent continuation lines
            )
          );
        }).flat();

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

export function AgentProgress({ session, progress, phase }) {
  // Map phase to friendly names
  const phaseMap = {
    'idle': 'READY',
    'planning': 'PLANNING',
    'execution': 'EXECUTING',
    'complete': 'COMPLETE',
    'error': 'ERROR'
  };

  const items = session.agents.map((agent) => {
    const item = progress[agent.id] || { status: 'waiting', actionType: 'init' };

    // Generate status based on phase and actionType
    let displayStatus = item.status;
    if (phase === 'idle') {
      displayStatus = item.status && item.status !== 'waiting' ? item.status : 'Waiting...';
    } else if (phase === 'planning' && item.actionType === 'plan') {
      // During planning, show simplified status
      if (item.status.includes('ready') || item.status.includes('Plan ready')) {
        displayStatus = '✓ Plan ready';
      } else if (item.status.includes('Negotiating') || item.status.includes('split')) {
        displayStatus = '⚙ Negotiating';
      } else if (item.status.includes('Drafting')) {
        displayStatus = '📝 Planning...';
      }
    } else if (phase === 'execution' && item.actionType === 'exec') {
      if (item.status.includes('complete') || item.status.includes('Tasks complete')) {
        displayStatus = '✓ Complete';
      } else if (item.status.includes('Executing')) {
        displayStatus = '⚙ Working...';
      }
    }

    return React.createElement(
      Text,
      { key: agent.id },
      `${agentColor(agent.id)('■')} ${agentColor(agent.id)(agent.name)} ${chalk.dim('›')} ${displayStatus}`
    );
  });

  return React.createElement(
    Box,
    {
      borderStyle: 'single',
      borderColor: phase === 'complete' ? 'green' : phase === 'error' ? 'red' : phase === 'idle' ? 'cyan' : 'yellow',
      paddingX: 1,
      flexDirection: 'column',
    },
    React.createElement(Text, { bold: true }, `${chalk.yellow(phaseMap[phase] || phase.toUpperCase())} • Agents`),
    React.createElement(Box, { flexDirection: 'row', gap: 2 }, ...items)
  );
}
