# Work-Together CLI Demo

## Preview the CLI

To see the interactive demo with the sleek terminal UI:

```bash
npx @pro-creations/work-together --demo
```

## What You'll See

The demo showcases:

1. **ASCII Art Logo** - Sleek filled-in ASCII art inspired by Claude Code and Gemini CLI
2. **Multi-Panel Interface** - Three main panels:
   - Activity Feed: Real-time agent activity log
   - Messages: Agent messages to the user
   - Planning: Collaborative planning updates
3. **Agent Progress Bar** - Live status of all agents with color-coded indicators
4. **Simulated Workflow** - Watch agents collaborate on building an authentication system:
   - Planning phase with task negotiation
   - Execution phase with real-time updates
   - Completion with test results

## UI Features

- **Sleek Design**: Professional terminal interface with no emojis, clean icons
- **Color-Coded Agents**:
  - Claude Code (purple)
  - OpenAI Codex (green)
  - Gemini CLI (blue)
  - Qwen Code (orange)
  - OpenCode (navy)
- **Keyboard Shortcuts**: Full keyboard navigation (Ctrl+C, Ctrl+S, Ctrl+V, Tab)
- **Status Indicators**: ASCII symbols for different action types (▸, ■, ▪, ✓, ✖)

## Demo Flow

The demo automatically simulates:
1. Session initialization with 3 agents
2. Planning phase (30-40 seconds)
   - Each agent proposes a plan
   - Coordinator synthesizes plans
   - Agents negotiate task allocation
3. Execution phase (40-50 seconds)
   - Agents work on assigned tasks
   - Real-time file creation updates
   - Status messages and progress
4. Completion
   - All tests passing
   - System ready for deployment

Total demo runtime: ~2 minutes

## Screenshot

![Work-Together CLI Screenshot](./cli-screenshot.png)

_Screenshot coming soon - run `--demo` to see it live!_
