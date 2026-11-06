# pi-config

Portable Pi configuration: user instructions, settings, and custom extensions.
Cloned alongside a fresh Pi install to reproduce the same setup on another machine.

Deliberately **not** in this repo: credentials, chat history, and generated install trees.

| Tracked | Why |
|---|---|
| `agent/AGENTS.md` | User-level coding instructions applied in every project |
| `agent/settings.json` | Preferences, default model, and the `packages` list |
| `agent/extensions/auto-model/` | Custom extension: rates task difficulty and routes model + thinking level (feature/architecture planning, code review, and GitHub issue investigation always go to the expert tier at high or xhigh thinking), fails over to the next model, learns from your reactions to its answers |
| `agent/extensions/quality-gate/` | Custom extension: runs typecheck/lint/test after the agent changes files, `/checks`, `/ship` |
| `agent/extensions/build-workflow/` | Custom extension: `/build <task>` plans with you on the expert tier in your session; once the plan is saved it asks whether you agree and want it posted as a GitHub issue in the repo (the implementer and reviewers then read the plan from the issue), then implementer subagents (background `pi --mode rpc` processes on the model and thinking Jev picks by difficulty) build it (baseline checks first, the plan as a checklist, a self-review of the diff against the reviewers' checklist, and a report that claims only commands it ran): the planner may split the plan into up to 3 `## Work streams` with separate files, one implementer each, working in parallel in the same folder; each asks the planner when blocked (one question at a time, the answer goes back to the one that asked), and the implementers stay with the planner's session, so a fix round, a plan change or the next `/build` in that session goes to the same implementer with its context; then two reviewer subagents on the expert tier review it in parallel, one on Claude and one on OpenAI (read-only in the repo, probes under /tmp, a must-fix finding needs evidence, suggestions never block; the re-review sees the implementers' replies and blocks no new nitpicks) (it passes only when both pass; one fix round gets both reviews) and the run report lands back in your session, so you never switch windows. Ask the planner to change the plan at any point and it saves it again into the same plan file (and the issue): the implementer gets it at once, a running review is stopped or followed by a change round (you choose), and reviewed work gets a change round with a fresh review. A re-review that still finds problems asks you: one more fix round, accept, or review again. When the run ends the planner goes back to the model you had before. After a passing review it asks to ship: a new branch from HEAD, one commit (`Closes #N` with an issue) and a normal push, never a merge or force push (`/build ship` asks again later; a new `/build` or `/issue` instead ends the waiting run, leaving its changes uncommitted). `/issue <url or #123>` does the same for a GitHub issue on a new branch from the default branch, then `/issue pr` (prefilled, you confirm) commits, pushes and opens a draft PR with `Fixes #N`; needs `gh`, `auto-model` and `project-memory`. Alt+A or `/agents` opens a centered panel of the run with four tabs (keys 1–4 or Tab): **Agents** shows one row per agent (planner, each implementer with its work stream, each reviewer; all its rounds summed) with its model, thinking, time, cost and route reason and its live activity, ↑↓ + Enter messages any agent, `s` stops a subagent's turn, `r` restarts a stopped or crashed one (press twice while it works), and after a failed re-review `F` fixes again, `R` reviews again and `A` (twice) accepts; **Changes** lists the lines changed since implementation began (Enter opens a git-style diff with line numbers, syntax colors, hunk and file jumps); **Plan** shows the plan, marked when it changed; **Report** shows the last run report; `p` edits the plan in an editor from any tab, and saving it counts as a plan change. It also lists this session's `acp_delegate` background runs (role, model, status, time, cost, task, live activity; `x` twice cancels a running one), even when no build runs. **Dashboard** (every session): a status line above the editor shows the repo, changed lines, quality-gate checks, session cost, the routed model with its tier, and the context once it passes 60 %, plus one line per working subagent or `acp_delegate` run; on terminals 160+ columns wide a pane docks beside the chat while agents work (Alt+S gives it the keys or opens it when idle, Esc gives them back, Alt+A expands it); `/dashboard` picks the layout (strip full, compact or hidden; pane right, left or off), saved in `agent/dashboard.json` |
| `agent/extensions/project-memory/` | Custom extension: per-repo notes and agreed plans in `.scratch/`, `/note`, `/notes`, `/handoff` |
| `agent/extensions/guardrails.json` | Guardrails policy config |
| `install.sh` | Copies the above into `~/.pi/agent` and installs declared packages |

| Excluded | Why |
|---|---|
| `agent/auth.json` | OAuth tokens and API keys |
| `agent/secrets/` | `typesafe_api_key` used by the auto-model extension |
| `agent/models-store.json` | Model catalog cache, rewritten by Pi |
| `agent/sessions/` | Full conversation history |
| `agent/install/`, `agent/npm/` | Managed install and `node_modules` (148 MB + 285 MB) |
| `agent/trust.json` | Per-machine absolute project paths |
| `agent/bin/pi` | Launcher generated by the installer |
| `agent/pi-voice.json` | Contains an absolute model path from this machine's cache |
| `agent/auto-model.json` | Optional per-machine tier overrides, use your own |

## Layout

The primary checkout is the git repo inside `~/.pi` itself, so config edits are
versioned in place. On other machines the installer has already created `~/.pi`,
so clone next to it and copy the portable files across.

## Bootstrap a new machine

```bash
# 1. Install Pi (creates ~/.pi/agent, agent/bin/pi, agent/install/)
curl -fsSL https://pi.dev/install.sh | sh

# 2. Clone next to the agent dir (never over it, the installer already populated it)
git clone git@github.com:DinicaMadalin/pi-config.git ~/pi-config

# 3. Copy config + custom extensions, then install the npm extensions from settings.json
~/pi-config/install.sh

# 4. Authenticate per provider; this stays local and is never committed
pi        # then /login for each provider you use
```

`install.sh` is safe to re-run; it overwrites the tracked files and replaces
each custom extension directory wholesale so files deleted upstream disappear too.

### Extensions that come along

| Extension | How it syncs |
|---|---|
| `auto-model`, `quality-gate`, `project-memory`, `build-workflow` (yours) | Source copied from `agent/extensions/<name>/` |
| `billion-context`, `pi-subagents`, `pi-jev`, `@aliou/pi-guardrails`, `@earendil-works/pi-voice` | Declared in `settings.json` `packages`, installed by `pi update --extensions` |

`settings.json` sets `defaultProvider`/`defaultModel` to `auto`, which the
auto-model extension provides; it needs the Jev key below to rate tasks.

## Machine-local secrets the extensions need

`agent/extensions/auto-model/` needs a TypeSafe Jev API key, read from either
`$TYPESAFE_API_KEY` or `~/.pi/agent/secrets/typesafe_api_key`:

```bash
mkdir -p ~/.pi/agent/secrets
printf '%s' "$YOUR_KEY" > ~/.pi/agent/secrets/typesafe_api_key
```

## Syncing later changes

On the machine where you change config:

```bash
cd ~/.pi && git add -A && git commit -m "update settings" && git push
```

On the other machines: `cd ~/pi-config && git pull && ./install.sh`.
Because `.gitignore` denies everything by default, a newly added file only syncs
after you un-ignore it there — check `git status` after adding config.
