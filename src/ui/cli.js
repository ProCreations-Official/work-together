import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { Header, StatusFeed, UserMessages, PlanningFeed, AgentProgress } from './status-display.js';

function CoordinatorApp({ coordinator, config, session }) {
  const { exit } = useApp();
  const [phase, setPhase] = useState('idle');
  const [statusFeed, setStatusFeed] = useState([]);
  const [userMessages, setUserMessages] = useState([]);
  const [planningFeed, setPlanningFeed] = useState([]);
  const [progress, setProgress] = useState({});
  const [notice, setNotice] = useState(() => {
    if (session.failures?.length) {
      return `Inactive agents: ${session.failures
        .map((failure) => `${failure.agentId} (${failure.error?.message || failure.error || 'failed'})`)
        .join(', ')}`;
    }
    return null;
  });
  const [error, setError] = useState(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [turnNumber, setTurnNumber] = useState(0);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [variantSelectionRequest, setVariantSelectionRequest] = useState(null);
  const lastStatusRef = useRef({});
  const [collaborationMode, setCollaborationMode] = useState(() =>
    typeof coordinator.getCollaborationMode === 'function'
      ? coordinator.getCollaborationMode()
      : 'collaborative'
  );

  const shouldSupersedeStatus = (previousDescription = '', nextDescription = '') => {
    const prev = previousDescription.toLowerCase();
    const next = (nextDescription || '').toLowerCase();

    if (next.includes('plan ready') && prev.includes('drafting plan')) {
      return true;
    }
    if (next.includes('task split proposed') && prev.includes('negotiating tasks')) {
      return true;
    }
    if (next.includes('executing tasks') && (prev.includes('task split proposed') || prev.includes('negotiating tasks'))) {
      return true;
    }
    if (next.includes('tasks complete') && prev.includes('executing tasks')) {
      return true;
    }
    return false;
  };

  const isPlanNarrativeStatus = (update) => {
    if (update.actionType !== 'plan') return false;
    const text = (update.description || '').trim().toLowerCase();
    if (!text) return false;

    const essentialKeywords = ['drafting plan', 'plan ready', 'negotiating', 'task split', 'executing', 'tasks complete'];
    if (essentialKeywords.some((keyword) => text.includes(keyword))) {
      return false;
    }

    if (text.includes(' will handle')) {
      return true;
    }

    const narrativePatterns = [
      /^##\s*/,
      /^i\s*\(/,
      /^this task/,
      /^this is/,
      /^combined collaboration plan/,
      /^- /,
      /^analysis/,
      /^overall/,
    ];
    return narrativePatterns.some((pattern) => pattern.test(text));
  };

  const openSettingsFile = () => {
    const settingsPath = config.path || config.configPath;
    if (!settingsPath) {
      setNotice('Settings file path unavailable.');
      return;
    }

    const editorEnv = process.env.EDITOR || process.env.VISUAL || '';
    let command = null;
    let args = [];

    if (editorEnv) {
      const parts = editorEnv.split(/\s+/).filter(Boolean);
      if (parts.length) {
        command = parts[0];
        args = parts.slice(1);
        args.push(settingsPath);
      }
    }

    if (!command) {
      if (process.platform === 'darwin') {
        command = 'open';
        args = [settingsPath];
      } else if (process.platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', settingsPath];
      } else {
        command = 'xdg-open';
        args = [settingsPath];
      }
    }

    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        setNotice(`Settings file located at ${settingsPath}`);
        setError(err ? err.message || String(err) : null);
      });
      child.unref();
      setError(null);
      setNotice(`Opening settings file at ${settingsPath}`);
    } catch (err) {
      setNotice(`Settings file located at ${settingsPath}`);
      setError(err ? err.message || String(err) : null);
    }
  };

  const handleSlashCommand = (rawCommand) => {
    const command = rawCommand.slice(1).trim().toLowerCase();
    if (!command) {
      setNotice('Empty command. Try /settings or /stats.');
      setWaitingForInput(true);
      setInputValue('');
      return;
    }

    if (command === 'settings') {
      openSettingsFile();
    } else if (command === 'stats') {
      const stats = [
        `Phase: ${phase.toUpperCase()}`,
        `Turn: ${turnNumber}`,
        `Status entries: ${statusFeed.length}`,
        `User messages: ${userMessages.length}`,
        `Planning updates: ${planningFeed.length}`,
      ];
      setError(null);
      setNotice(`Stats → ${stats.join(' • ')}`);
    } else {
      setNotice(`Unknown command "${rawCommand}". Available commands: /settings, /stats.`);
    }

    setWaitingForInput(true);
    setInputValue('');
  };

  useEffect(() => {
    if (config.settings?.autoOpenSettingsOnStart) {
      openSettingsFile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    config.logger?.info('UI: Setting up subscriptions');

    const unsubscribeStatus = coordinator.subscribeToStatus((update) => {
      const ignorePlanNarrative = isPlanNarrativeStatus(update);

      if (!ignorePlanNarrative) {
        const lastEntry = lastStatusRef.current[update.agentId];
        const isDuplicate =
          Boolean(lastEntry) &&
          lastEntry.actionType === update.actionType &&
          lastEntry.description === update.description;

        lastStatusRef.current[update.agentId] = {
          actionType: update.actionType,
          description: update.description,
        };

      if (!isDuplicate || update.userMessage) {
        setStatusFeed((prev) => {
          const filtered = prev.filter(
            (entry) =>
              entry.agentId !== update.agentId ||
              !shouldSupersedeStatus(entry.description, update.description)
          );
          const next = [...filtered, update];
          return next.length > 100 ? next.slice(next.length - 100) : next;
        });
      }

        // Update progress with actionType for better status display
        setProgress((prev) => ({
          ...prev,
          [update.agentId]: {
            status: update.description,
            actionType: update.actionType
          },
        }));
      }

      // Check for user messages
      if (update.userMessage) {
        setUserMessages((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: update.agentId,
              message: update.userMessage,
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      }
    });

    const unsubscribePlanning = coordinator.subscribeToPlanning((update) => {
      config.logger?.info({ stage: update.stage, hasPlan: !!update.plan, hasAlloc: !!update.allocation, hasAssign: !!update.assignments }, 'UI: Planning update received');

      // Show planning updates in Planning panel (separate from user messages)
      if (update.stage === 'variant-proposal' && update.plan) {
        setPlanningFeed((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: update.agentId,
              message: `🧪 VARIANT: ${update.plan}`
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      } else if (update.stage === 'variant-results' && update.plan) {
        setPlanningFeed((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: update.agentId,
              message: `📦 RESULTS: ${update.plan}`
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      } else if (update.stage === 'variant-selection-request' && update.plan) {
        setPlanningFeed((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: update.agentId,
              message: `❓ SELECT: ${update.plan}`
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      } else if (update.stage === 'variant-selected' && update.plan) {
        setPlanningFeed((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: update.agentId,
              message: `✅ CHOSEN: ${update.plan}`
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      } else if (update.stage === 'initial-plan' && update.plan) {
        setPlanningFeed((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: update.agentId,
              message: `📋 PLAN: ${update.plan}`
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      } else if (update.stage === 'coordinator-summary' && update.plan) {
        setPlanningFeed((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: 'coordinator',
              message: `🤝 ${update.plan}`
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      } else if (update.stage === 'allocation' && update.allocation) {
        setPlanningFeed((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: update.agentId,
              message: `✋ NEGOTIATION: ${update.allocation}`
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      } else if (update.stage === 'final-division' && update.assignments) {
        const assignmentText = Object.entries(update.assignments)
          .map(([agentId, tasks]) => `${agentId}: ${tasks}`)
          .join(' | ');
        setPlanningFeed((prev) => {
          const next = [
            ...prev,
            {
              timestamp: update.timestamp,
              agentId: 'coordinator',
              message: `🎯 ASSIGNMENTS: ${assignmentText}`
            },
          ];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      }

    });
    const unsubscribeVariantSelection = coordinator.subscribeToVariantSelection((request) => {
      if (!request) return;
      const optionSummary = request.options
        .map((option) => `${option.index}. ${option.agentName || option.agentId}`)
        .join(' • ');
      setVariantSelectionRequest(request);
      setError(null);
      setPhase('variant-selection');
      setWaitingForInput(true);
      setInputValue('');
      setNotice(`Variant mode: choose a plan (${optionSummary}). Enter number, agent id, or "auto".`);
    });

    config.logger?.info('UI: Subscriptions set up complete');

    return () => {
      config.logger?.info('UI: Cleaning up subscriptions');
      unsubscribeStatus();
      unsubscribePlanning();
      unsubscribeVariantSelection();
    };
  }, [coordinator, config.logger]);

  useEffect(() => {
    let cancelled = false;
    async function runPhases() {
      if (!session.userPrompt || !session.userPrompt.trim()) {
        setPhase('idle');
        setWaitingForInput(true);
        setNotice((prev) => prev || 'Type your first prompt to get started. Use /settings to edit configuration.');
        setProgress({});
        return;
      }

      try {
        config.logger?.info('UI: Starting planning phase');
        setPhase(collaborationMode === 'variant' ? 'variant' : 'planning');
        // Clear progress when starting planning
        setProgress({});
        setWaitingForInput(false);
        setNotice(null);
        setError(null);

        await coordinator.runPlanningPhase();
        config.logger?.info('UI: Planning phase complete');
        if (cancelled) return;

        config.logger?.info('UI: Starting execution phase');
        setPhase('execution');
        // Don't clear progress here, just let it update

        await coordinator.runExecutionPhase();
        config.logger?.info('UI: Execution phase complete');
        if (cancelled) return;

        setPhase('complete');
        // Update all agents to complete status
        session.agents.forEach(agent => {
          setProgress((prev) => ({
            ...prev,
            [agent.id]: { status: '✓ Complete', actionType: 'complete' }
          }));
        });

        setNotice('Task complete! Type another prompt or press Ctrl+C to exit.');
        setWaitingForInput(true);
      } catch (err) {
        setPhase('error');
        setError(err);
        setNotice('An error occurred. Press Ctrl+C to exit.');
      }
    }
    runPhases();
    return () => {
      cancelled = true;
    };
  }, [coordinator, turnNumber, session.agents, config.logger, collaborationMode]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.ctrl && (input === 's' || input === 'S')) {
      coordinator.statusLogger?.record({
        type: 'snapshot',
        timestamp: new Date().toISOString(),
        note: 'Manual save from CLI',
      }).catch(() => undefined);
      setNotice(`Snapshot saved`);
      return;
    }
    if (key.ctrl && (input === 'l' || input === 'L')) {
      setNotice(`Log: ${coordinator.statusLogger?.filePath || 'not created yet'}`);
      return;
    }
    if (key.ctrl && (input === 'v' || input === 'V')) {
      const previousMode = collaborationMode;
      const previousSelection = variantSelectionRequest;
      const nextMode = previousMode === 'variant' ? 'collaborative' : 'variant';
      setNotice(`Toggling collaboration mode to ${nextMode}…`);
      setError(null);
      const applyToggle = async () => {
        try {
          if (typeof coordinator.setCollaborationMode === 'function') {
            coordinator.setCollaborationMode(nextMode);
          }
          setCollaborationMode(nextMode);
          if (nextMode === 'collaborative') {
            setVariantSelectionRequest(null);
          }
          if (typeof config.save === 'function') {
            await config.save({ settings: { collaborationMode: nextMode } });
          } else if (config.settings) {
            config.settings.collaborationMode = nextMode;
          }
          const timingNote =
            phase === 'planning' || phase === 'variant' || phase === 'execution'
              ? ' (takes effect after the current run completes)'
              : '';
          setNotice(`Collaboration mode set to ${nextMode}${timingNote}.`);
        } catch (err) {
          if (typeof coordinator.setCollaborationMode === 'function') {
            coordinator.setCollaborationMode(previousMode);
          }
          setCollaborationMode(previousMode);
          if (previousMode === 'variant' && previousSelection) {
            setVariantSelectionRequest(previousSelection);
          }
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setNotice('Failed to toggle collaboration mode.');
        }
      };
      applyToggle();
      return;
    }
    if (key.tab) {
      setFocusIndex((prev) => (prev + 1) % 3);
      return;
    }

    if (waitingForInput) return; // Let TextInput handle remaining input
  });

  const handleSubmit = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      handleSlashCommand(trimmed);
      return;
    }

    if (variantSelectionRequest) {
      const result = typeof coordinator.submitVariantSelection === 'function'
        ? coordinator.submitVariantSelection(variantSelectionRequest.requestId, trimmed)
        : { success: false, error: 'Variant selection unavailable.' };
      if (result.success) {
        setVariantSelectionRequest(null);
        setWaitingForInput(false);
        setNotice(result.message || 'Variant choice accepted.');
        setError(null);
        setPhase(collaborationMode === 'variant' ? 'variant' : phase);
      } else {
        setNotice(result.error || 'Unable to accept variant choice.');
        setWaitingForInput(true);
      }
      setInputValue('');
      return;
    }

    setWaitingForInput(false);
    setInputValue('');
    setTurnNumber((prev) => prev + 1);

    // Update session with new prompt
    session.userPrompt = trimmed;
    setNotice(null);
    setError(null);

    // Reset progress
    setProgress({});

    // Kick off planning via effect loop
    setPhase(collaborationMode === 'variant' ? 'variant' : 'planning');
  };

  const focusedStyles = useMemo(
    () => [focusIndex === 0, focusIndex === 1, focusIndex === 2],
    [focusIndex]
  );

  const noticeElement = notice
    ? React.createElement(
        Box,
        { borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
        React.createElement(Text, { color: 'yellow' }, notice)
      )
    : null;
  const errorElement = error
    ? React.createElement(
        Box,
        { borderStyle: 'round', borderColor: 'red', paddingX: 1 },
        React.createElement(Text, { color: 'red' }, String(error))
      )
    : null;

  const inputElement = waitingForInput
    ? React.createElement(
        Box,
        { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
        React.createElement(Text, { color: 'cyan', bold: true }, '› '),
        React.createElement(TextInput, {
          value: inputValue,
          onChange: setInputValue,
          onSubmit: handleSubmit,
          placeholder: 'Type your next prompt...'
        })
      )
    : null;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Header, { session, turnNumber }),
    React.createElement(AgentProgress, { session, progress, phase }),
    noticeElement,
    errorElement,
    React.createElement(
      Box,
      { flexDirection: 'row', gap: 1, flexGrow: 1 },
      focusIndex === 0
        ? React.createElement(StatusFeed, { entries: statusFeed, focused: true })
        : focusIndex === 1
        ? React.createElement(UserMessages, { entries: userMessages, focused: true })
        : React.createElement(PlanningFeed, { entries: planningFeed, focused: true })
    ),
    inputElement,
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: 'gray', dimColor: true }, `Ctrl+C exit • Ctrl+S save • Ctrl+L log • Tab: ${focusIndex === 0 ? 'Status' : focusIndex === 1 ? 'Messages' : 'Planning'}`)
    )
  );
}

export async function launchCLI({ coordinator, config, session }) {
  const app = render(React.createElement(CoordinatorApp, { coordinator, config, session }));
  await app.waitUntilExit();
  return { session: coordinator.getSession() };
}
