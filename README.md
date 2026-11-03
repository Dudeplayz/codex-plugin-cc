# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

> [!IMPORTANT]
> **This is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)**, based on upstream
> `1.0.6` ([`db52e28`](https://github.com/openai/codex-plugin-cc/commit/db52e28)). It fixes the background
> processes that upstream leaks, lets you pick MCP servers per Codex thread, and routes delegated work to
> the GPT-6.1 models. Everything else behaves like upstream. [Install the fork](#install).

## What This Fork Changes

| | Upstream `1.0.6` | This fork |
| --- | --- | --- |
| **Shared broker** | Runs until something kills it; one per workspace, forever | Exits when idle, with its Claude session, and at `SessionEnd` |
| **`SessionEnd` cleanup** | Only the broker of the session's working directory | Every broker the session started, in every workspace and worktree |
| **MCP servers** | Every enabled server starts again for each Codex thread and stays until the app-server dies | App-server restarts after a few threads; `--mcp` switches servers per thread |
| **Killing processes** | Group kill by saved PID | Whole tree, MCP servers included, only after checking the PID is still the same process |
| **Model routing** | Codex defaults, `spark` = `gpt-5.3-codex-spark` | GPT-6.1 Sol / Terra and GPT-6 Luna policy, `spark` = `gpt-6-luna` (read-only), `--effort max` |
| **Worktrees** | `/codex:rescue` cannot target another worktree | `/codex:rescue --cwd <path>` |

> [!WARNING]
> **Why this fork exists.** Upstream starts a detached broker plus a `codex app-server` for every
> workspace and never stops them. Each Codex thread then starts its own full set of MCP servers inside
> that app-server. After a few days of Claude Code sessions with worktrees, one machine had **99 brokers
> and about 800 processes using roughly 40 GB of memory**, with swap full, and macOS charged all of it to
> Claude. A single app-server held 48 MCP child processes. The upstream test suite leaked brokers too.

### Background processes clean up after themselves

Commands share one `codex app-server` per workspace through a small broker process. The broker shuts
itself down, together with the app-server and every MCP server it started, when any of these happens:

- :hourglass: **Idle:** no client connected and no turn running for 30 minutes.
- :wave: **Claude session gone:** the Claude Code process that started it exits, even if `SessionEnd`
  never runs (crash, killed terminal, closed app window). The PID comes from `CLAUDE_PID` or the nearest
  `claude` ancestor process; `SessionStart` exports it as `CODEX_COMPANION_CLAUDE_PID`.
- :checkered_flag: **Session ended:** the `SessionEnd` hook stops every broker that session started, within
  the hook's 5-second budget.

Codex keeps every thread's MCP servers until the app-server exits, so the broker restarts its app-server
after a few loaded threads while nothing is running. Before it signals anything, it checks that the PID
still belongs to the same process (start time and command line), so a reused PID is never hit.

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS` | `1800000` (30 min) | Idle time before the broker exits; `0` turns the timeout off |
| `CODEX_COMPANION_BROKER_MAX_THREADS` | `4` | Threads an app-server may load before an idle restart; `0` turns restarts off |
| `CODEX_COMPANION_CLAUDE_PID` | set by `SessionStart` | Claude Code process the broker follows |
| `CODEX_COMPANION_DEFAULT_MCP` | unset | Default for `--mcp` |

Each broker logs restarts and the reason it shut down to `broker.log` in its session directory while it runs.

### Pick MCP servers per Codex thread

Every enabled MCP server in `~/.codex/config.toml` starts once for every Codex thread. Keep heavy servers
switched off there and turn them on only for the tasks that need them:

```toml
[mcp_servers.rea]
command = "rea"
args = ["mcp"]
enabled = false
```

```bash
/codex:rescue --mcp rea reverse engineer the bundled helper binary
/codex:review --mcp -context7
/codex:adversarial-review --mcp none,playwright check the checkout flow in the browser
```

| `--mcp` value | Effect for that thread |
| --- | --- |
| `rea` or `+rea` | Turn `rea` on, keep the rest of your config |
| `-context7` | Turn `context7` off, keep the rest |
| `none` | Turn every configured server off |
| `none,rea` | Run `rea` and nothing else |
| `all` or no flag | Use your config unchanged |

`--mcp` works for `/codex:rescue`, `/codex:review` and `/codex:adversarial-review`. Several values combine
with commas. Unknown names fail before Codex starts. The routing policy adds `--mcp rea` on its own only
for reverse engineering and `--mcp playwright` only for browser reproduction.

> [!NOTE]
> `--mcp` covers servers from `[mcp_servers]` in your Codex config. MCP servers that ship inside Codex
> plugins (for example computer use) follow the plugin and are not switched by `--mcp`.

### GPT-6.1 routing for `/codex:rescue`

The `codex:codex-rescue` subagent follows the `gpt-6-prompting` skill to choose model and effort:

| Model | Used for |
| --- | --- |
| **GPT-6.1 Sol** | Plans, reviews, architecture, security, root-cause work, anything ambiguous or cross-module (`high` when unsure) |
| **GPT-6.1 Terra** | One bounded low-risk coding task with clear acceptance checks, browser and screenshot reproduction, interpretation that outgrows Luna |
| **GPT-6 Luna** | Read-only routine work: file mapping, supplied logs, one named test command; the `spark` alias maps here |

An explicit `--model` or `--effort` always wins, and Astra is never picked automatically. If Terra's
verification fails, the task is rerun on Sol at `high`.

<details>
<summary><strong>Smaller changes</strong></summary>

- `/codex:rescue --cwd <path>` runs Codex in another repository or git worktree. Codex can only write
  inside the repository that path belongs to.
- `--effort max` is accepted.
- The test suite no longer inherits the surrounding Claude Code session, and every broker a test starts
  exits with the test process.

</details>

<details>
<summary><strong>Commits on top of upstream</strong></summary>

| Commit | Change |
| --- | --- |
| [`5edd7a7`](https://github.com/Dudeplayz/codex-plugin-cc/commit/5edd7a7) | Route rescue tasks to GPT-6.1 Sol/Terra and GPT-6 Luna |
| [`ccd90de`](https://github.com/Dudeplayz/codex-plugin-cc/commit/ccd90de) | Select MCP servers per Codex thread, forward `--cwd` |
| [`26b729f`](https://github.com/Dudeplayz/codex-plugin-cc/commit/26b729f) | Stop leaking brokers, app-servers and MCP servers |
| [`5fe18a4`](https://github.com/Dudeplayz/codex-plugin-cc/commit/5fe18a4) | Restart the app-server after 4 threads by default |
| [`3701ced`](https://github.com/Dudeplayz/codex-plugin-cc/commit/3701ced) | Check process identity before sending signals |
| [`819510f`](https://github.com/Dudeplayz/codex-plugin-cc/commit/819510f) | Close the remaining PID and registry races |
| [`c287669`](https://github.com/Dudeplayz/codex-plugin-cc/commit/c287669) | Switch MCP servers on per thread, also for reviews |

</details>

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add Dudeplayz/codex-plugin-cc
```

> [!TIP]
> The fork keeps the marketplace name `openai-codex` and the plugin id `codex@openai-codex`, so your
> settings and `enabledPlugins` stay valid. If you already use the upstream plugin, run
> `/plugin marketplace remove openai-codex` first, then add the fork as shown here.

Install the plugin:

```bash
/plugin install codex@openai-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Claude-Companion preserves active Codex model/provider config when `--model` is omitted. Configure GPT-6.1 Sol for implementation and complex work; select GPT-6 Luna for focused routine no-source-write work. The legacy spark alias is supplied-material, read-only summaries only. Sol medium fits clear bounded work; high fits reviews and ambiguous multi-step work; xhigh/max are selective escalations for a concrete quality gap. Astra is not automatically selected.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-6.1-sol --effort high investigate the flaky integration test
/codex:rescue --model spark summarize the supplied test logs
/codex:rescue --background investigate the regression
/codex:rescue --mcp rea reverse engineer the bundled helper binary
/codex:rescue --cwd /path/to/worktree fix the failing test there
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if `--model` is omitted, active Codex model/provider config applies; explicit `--effort` still passes through
- if you say `spark`, plugin maps it to `gpt-6-luna`; the legacy spark alias is read-only for supplied-material summaries
- follow-up rescue requests can continue the latest Codex task in the repo
- `--mcp` switches MCP servers from your Codex config for that thread; see [Pick MCP servers per Codex thread](#pick-mcp-servers-per-codex-thread)
- `--cwd <path>` runs Codex in another repository or git worktree; Codex can only write inside the repository that path belongs to

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or model used by the plugin, define it inside user-level or project-level `config.toml`. For example to use `gpt-6-luna` on `medium` for a specific project, add this to `.codex/config.toml` at project root:

```toml
model = "gpt-6-luna"
model_reasoning_effort = "medium"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
