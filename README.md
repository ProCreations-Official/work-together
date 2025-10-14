# work-together

A collaborative CLI that coordinates multiple AI coding agents – Claude Code, OpenAI Codex, Gemini CLI, Qwen Code, and OpenCode – to plan, negotiate, and execute development tasks in real time.

## Installation

```bash
npm install -g @pro-creations/work-together
```

Or run once without a global install:

```bash
npx @pro-creations/work-together
```

## Development

```bash
npm install
npm start
```

### Gemini CLI setup

The Gemini agent shells out to `gemini "..."`. Make sure the CLI is installed (`pip install google-genai`) and either:

- run `gemini login` to cache interactive credentials, or
- export `GOOGLE_API_KEY` / `GEMINI_API_KEY` for headless usage.

Without one of those steps the Gemini agent will surface an authentication error when it tries to collaborate. The default model is `gemini-2.5-flash-latest`; if a region doesn’t expose it, the CLI automatically falls back through a set of supported Gemini models. By default we let the CLI reuse its cached login (no API key set); to force key-based auth set `geminiUseApiKey = true` and add `gemini = "your-key"` under `[apiKeys]`. For Vertex AI, set `geminiUseVertex = true` (or export `GOOGLE_GENAI_USE_VERTEXAI=true`) and provide the usual project/location environment variables.

### Qwen CLI setup

The Qwen agent calls `qwen -p "..."`. Install the CLI (`npm install -g @qwen-code/qwen-code`) and either rely on its cached login or provide a key in `QWEN_API_KEY` / `DASHSCOPE_API_KEY`. You can override the model with `qwenModel` in `config.toml`; the default is `qwen3-coder-plus` (supports command-line prompts and code generation).

### Agent-to-agent messaging

During any phase, agents can coordinate by emitting lines in their responses:

- `TEAM_MSG[GROUP]: note for every teammate`
- `TEAM_MSG[TO codex]: direct note to a specific agent (replace `codex` as needed)`

With only two agents the system automatically routes messages to the other collaborator. When three or more agents are active, the sender can choose between group broadcasts and direct messages using the formats above.

### Variant mode

Set `collaborationMode = "variant"` in `~/.work-together/config.toml` to have every agent build a full solution independently. Variant runs unfold as:

1. **Solo builds** – the coordinator creates a workspace named `variant-{project-slug}-{session}` with subfolders like `{agent-name}-{project-name}` (for example `claude-code-auth-api`). Each agent gets a private brief pointing to their folder and completes the entire task there with no cross-agent coordination.
2. **Result review** – once everyone is done the planning feed shows 📦 `RESULTS` with each project folder. When `variantSelectionMode = "manual"` (default) the CLI pauses so you can pick a final result by number or agent id, or enter `auto` to delegate. With `variantSelectionMode = "auto"` the review agent’s variant is adopted automatically.
3. **Handoff** – the selected variant is highlighted as ✅ `CHOSEN` together with the target directory so you can inspect, run, or promote it. No collaborative execution phase runs afterwards because every variant already contains a complete build.

Press <kbd>Ctrl</kbd>+<kbd>V</kbd> at any time to toggle between collaborative and variant modes; the change is saved to `config.toml` and takes effect on the next run if one is already in progress.

Switch back to collaborative planning by setting `collaborationMode = "collaborative"`.

### Web search agent

The CLI now auto-loads a lightweight Web Search assistant (unless `enableWebSearchAgent = false` in `config.toml`). Any agent can trigger a search by emitting `WEB_SEARCH: describe the query` in its response; the wrapper strips the directive from user-visible output and forwards the request. Include optional guidance inside brackets, for example `WEB_SEARCH[focus: security]: oauth pkce audit`. When `webSearchModel = "codex"` the assistant runs `codex --web-search` directly; other models reuse their usual CLI with a research prompt and return a concise report via a direct team message.

### Role coordination & review pass

During the planning phase the coordinator assigns each agent a primary focus (e.g., front-end, back-end, automation, QA) and designates one agent as the _review_ owner for the session. The role roster is injected into every prompt so agents stay aligned, and non-review agents send a `TEAM_MSG[TO <review-agent>]` when their work is done. The review agent waits for those signals, reviews the final deliverable, and posts a summary `TEAM_MSG[GROUP]`—raising direct follow-ups if fixes are required.

## Slash Commands

- `/settings` – open the active `~/.work-together/config.toml` in your default editor
- `/stats` – show live phase, turn, and feed counters without kicking off a new run
