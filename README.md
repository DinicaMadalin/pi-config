# pi-config

Portable Pi configuration: user instructions, settings, and custom extensions.
Cloned alongside a fresh Pi install to reproduce the same setup on another machine.

Deliberately **not** in this repo: credentials, chat history, and generated install trees.

| Tracked | Why |
|---|---|
| `agent/AGENTS.md` | User-level coding instructions applied in every project |
| `agent/settings.json` | Preferences, default model, and the `packages` list |
| `agent/extensions/auto-model/` | Custom extension: rates task difficulty and routes model + thinking level (feature/architecture planning, code review, and GitHub issue investigation always go to the expert tier at high or xhigh thinking), fails over to the next model, honors a tier ceiling from `PI_AUTO_MODEL_MAX_TIER`, learns from your reactions to its answers. **Design-first hand-off** (normal `auto/auto` chats only, not `/build` or capped sessions): implementing an agreed plan or directly building a substantial feature routes to the expert tier (complex fallback), where the model is instructed before its first answer to refine the plan and design contracts instead of typing out code. Then it writes the exact signatures with stub bodies, each under a `@handoff-contract begin` … `@handoff-contract end` comment block (behavior, edge cases, what must not change, acceptance cases), then calls `hand_off_implementation`; the following turns run on the standard tier, which fills in the bodies and runs the checks; when it finishes, the designer's model reviews, sends fix steps back to the cheap model (at most 3 hand-offs per task) or calls `approve_implementation`, which deletes every contract block in the repo, then reruns the checks |
| `agent/extensions/quality-gate/` | Custom extension: `/checks` runs typecheck/lint/test on demand and `/ship` runs them before committing; no checks run after ordinary prompts. Inside `/build` the same checks are recorded as a baseline when the run starts, run again after the implementers finish and before shipping, and only failures not in the baseline count. Inside herdr the main session's checks run visibly in one pane below Pi (a check falls back to a hidden run when herdr fails); build helpers run them in the background |
| `agent/extensions/build-workflow/` | Custom extension: the default build flow. Saving an agreed plan (`save_agreed_plan`) in a normal chat opens the start dialog (start, start with a GitHub issue, or Not now, which returns to the chat); `/build <task>` still plans first. Before the designer starts, the project's checks are recorded as a baseline in the run's worktree. A **designer** subagent (expert tier) writes signatures with stub bodies and temporary `@handoff-contract` blocks, then implementer subagents (cheap standard tier, up to 3 work streams in parallel, in herdr panes or background `pi --mode rpc` processes) build it. After the implementers finish the checks run again: new failures versus the baseline get one implementer fix round, and whatever still fails is shown to the reviewers. A single reviewer runs on the expert tier, to keep reviews cheap: the vendor (Claude or OpenAI) of the first logged-in model in the expert tier's configured order; if neither has one the run pauses with a clear error and `/build implement` resumes it once a model is available. Shipping needs the reviewer to pass. A cleanup gate then removes contract blocks in code, reruns the checks and blocks only on failures new since the baseline. Controls: `/build implement` asks what to do after a failed review or failed cleanup (fix, accept where allowed, re-review, retry) and restarts stopped or crashed agents; `/build plan` edits the run plan; `/build status`, `/build stop`, `/build ship`, `/build here|back`. Plan changes follow the run (plan-changes.ts). Inside herdr the run's worktree workspace has helper tabs (**Implementers**, **Reviewers**) and, once the review passed, a **Diff** tab (changed files, Enter opens a file's diff). After a pass, shipping makes a new branch, one commit and a normal push (`ship_build`); the main chat can end a run with `stop_build` (a run waiting on you stops at once, one with working agents asks first). GitHub issues and PRs get only the plan's Problem, Proposed change and Acceptance criteria, with repo paths made relative and lines naming local material left out. `/issue <url or #123>` runs the same flow for a GitHub issue ending in a draft PR; needs `gh`, `auto-model` and `project-memory`. The dashboard, `/agents` and Alt+A overview were removed |
| `agent/extensions/prompt-rewriter/` | Custom extension: before a typed message goes to the model, Jev judges whether it is clear (clear messages go straight through, no dialog); otherwise a cheap model (auto-model's trivial tier) rewrites it into a clear, structured, ready-to-send prompt with the same meaning (the actual request first, not an explanation or summary; then Context, Requirements, Constraints, Done when, Assumptions; filler and typos removed, every path, name and error kept verbatim, nothing invented), asks you up to three questions first only when Jev finds the message ambiguous, has Jev check the rewrite kept everything, added nothing, kept your maybes and is a direct request to the agent (one retry with the findings, then a notice), and sends the rewrite on its own, without a dialog; a rewrite the check still doubts is replaced by your own text with a warning notice (Esc still puts your message back in the editor); `/build` tasks get the same treatment; short replies, commands and already structured prompts go as typed, and so does anything when the rewrite fails, and without Jev the rewriter decides alone; `/rewrite on\|off` (saved in `agent/prompt-rewriter.json`); needs `auto-model` |
| `agent/extensions/herdr-tools/` | Shared herdr client library (`herdr-cli.ts`, `command-pane.ts`) used by `/build` panes and the checks pane; no commands of its own |
| `agent/extensions/project-memory/` | Custom extension: per-repo notes and agreed plans in `.scratch/`, `/note`, `/notes`, `/handoff` |
| `agent/extensions/guardrails.json` | Guardrails policy config |
| `agent/extensions/safe-commands/` | Custom extension: answers Guardrails' dangerous-command prompt for routine work, so removing scratch files under `/tmp` or in a generated folder, dropping a scratch worktree, unstaging files (`git restore --staged`, `git rm --cached`), changing directory and a plain `git push` to any branch except `main` or `master` run without a prompt, also when followed by ordinary commands. A push whose destination is `main`/`master` or unknown, a force push, a remote delete and `--all` still ask; for a push without a branch name, git is asked which remote branch it updates. The check runs per part of the command, so an allowed part cannot carry a force push or a script piped into a shell, and anything else still asks. It tells Guardrails through the decision-delegate events (`guardrails:delegate:register`), reads the dangerous patterns from `guardrails.json`, and abstains when that file cannot be read |
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
| `auto-model`, `quality-gate`, `project-memory`, `build-workflow`, `prompt-rewriter`, `herdr-tools` (yours) | Source copied from `agent/extensions/<name>/` |
| `billion-context`, `pi-jev`, `@aliou/pi-guardrails` | Declared in `settings.json` `packages`, installed by `pi update --extensions` |

To run the extension tests, run `npm install` once at the repo root; it installs only the test dev dependencies (`esbuild` and `@earendil-works/pi-tui`). Then run `node --test agent/extensions/auto-model/*.test.ts agent/extensions/build-workflow/*.test.ts`.

`settings.json` sets `defaultProvider`/`defaultModel` to `auto`, which the
auto-model extension provides; it needs the Jev key below to rate tasks.

### Default design-first implementation

Use `/model auto/auto` for normal automatic routing. When you ask to implement a rough or detailed plan already discussed, or request a substantial feature directly, auto-model routes to an expert designer (the complex tier is the fallback when no configured expert model is usable). The designer refines the plan, writes signatures, stubs, behavior contracts and acceptance tests, then hands off to the standard-tier implementer for code and checks; the designer reviews before removing contracts. Tiny edits, questions and plan-only discussion keep normal routing. Workflow pins such as `/build` and `PI_AUTO_MODEL_MAX_TIER` retain control and disable this in-chat handoff. The same design and review stages add model cost; tier model lists remain governed by `~/.pi/agent/auto-model.json`.

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
