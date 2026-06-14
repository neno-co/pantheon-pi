# Train Orchestrator

Drives a queue of Linear tickets through a fixed pipeline — **implement → review → address → human-gate → merge** — one stage at a time, pausing only when a human is genuinely needed. Each stage runs as an in-process **Claude Agent SDK** session: the orchestrator forces a structured result from the agent and owns every state transition itself, so the agent never has to remember to "report back".

It supports **multiple projects** in parallel (each an isolated train) and is safe to run **concurrently** (one autopilot loop per project, with a lock that prevents two loops corrupting the same project's state).

```
queued ──▶ implementing ──▶ reviewing ──▶ addressing ──▶ awaiting_human ──▶ merging ──▶ done
                 │              │             │               (human)          │
                 └──────────────┴─────────────┴── blocked / failed ◀───────────┘
                                          (halts the train)
```

---

## Install

```bash
cd train
./install.sh            # installs deps, a `train` launcher on PATH, and the stage commands
train help
```

`install.sh` is idempotent. It:

1. runs `bun install`,
2. drops a `train` launcher into `~/.bun/bin` (or `~/.local/bin`) so you run `train …` instead of `deno run -A …` / `bun run …/cli.ts …`,
3. installs the four stage slash-commands into `~/.claude/commands/` so the SDK sessions can resolve `/implement-linear-auto`, `/review-pr`, `/address-pr`, `/merge-pr` regardless of which repo a stage runs in. Use `./install.sh --force` to overwrite existing copies.

You can also run it without installing: `bun run cli.ts <command>` (or `bun cli.ts <command>`) from this directory.

### Requirements

- **[Bun](https://bun.sh)** — the runtime.
- **Anthropic auth** — same source the `claude` CLI uses (macOS keychain or `ANTHROPIC_API_KEY`).
- **`git`** and **`gh`** — for branches, worktrees, and PRs.
- **Deno** — only if you use the default `worktreeSetup` command (monorepo-core's `scripts/setup-worktree.ts`). Override or disable it for other repos (see [Configuration](#configuration)).

---

## Quickstart

**1. Write a queue file** (see `queue.example.json`):

```json
{
  "project": "https://linear.app/your-org/project/your-project-abc123def456/overview",
  "baseBranch": "feature/your-train-branch",
  "repoPath": "/absolute/path/to/your/repo",
  "worktreeSetup": "~/.deno/bin/deno run -A scripts/setup-worktree.ts {branch} --from origin/{base}",
  "tasks": [
    { "id": "NEO-123", "title": "Implement accountant inbox parsing", "linearUrl": "https://linear.app/your-org/issue/NEO-123" },
    { "id": "NEO-119", "title": "Refactor task source resolution", "linearUrl": "https://linear.app/your-org/issue/NEO-119" }
  ]
}
```

- `project` — Linear project reference; the readable part becomes the project **slug** (`your-project`).
- `baseBranch` — the **train branch**. Every PR targets this, never `main`. It **must exist on origin** before you run (see [recovery](#base-branch-not-on-origin)).
- `repoPath` — local checkout of the target repo. May be omitted and supplied with `--repo`, else defaults to the current directory.
- `worktreeSetup` *(optional)* — command run once before the implement stage to create the ticket's worktree. `{branch}`/`{base}` are substituted. Omit for the monorepo-core default; set to `null` to skip worktrees entirely (stages run in the repo root).
- `stageModels` *(optional)* — per-stage model overrides (defaults: implement/address = `sonnet`, review/merge = `opus`).

**2. Bootstrap and run:**

```bash
train bootstrap --queue ./queue.json --base feature/your-train-branch --repo /path/to/repo
train start          # full autopilot — runs stages until it must pause
```

`start` runs stages in a loop and **pauses only** on `awaiting_human` (run `approve`), `blocked` (run `unblock`), or `failed`.

---

## Multiple projects & concurrency

Each project is a self-contained train with its own `state.json`, `QUESTIONS.md`, `logs/`, and scratch files under `<TRAIN_HOME>/projects/<slug>/`. Several Linear projects can be in flight at once without clobbering each other.

```bash
train projects                          # every stream, one-line status (incl. which are running)
train use <slug>                        # set the active project; later commands need no flag
train bootstrap --project <slug> ...    # force a specific slug

# Run two streams truly concurrently — give each an explicit --project so neither
# depends on the shared active pointer:
train start --project stream-a
train start --project stream-b          # in another terminal
```

The active project is recorded in `<TRAIN_HOME>/active.json`. Resolution order for every command: `--state <path>` (raw escape hatch) → `--project <slug>` → the active pointer.

**Concurrency safety.** Different projects never share files, so they run independently. The one hazard — two loops on the *same* project — is blocked by a per-project lock (`.lock`). A second `start`/`run-stage` on a locked project fails fast with a clear message. A lock left by a crashed process (dead pid) is reclaimed automatically; release one manually with `train unlock`.

---

## How a stage runs

Each stage is one Agent SDK session driven by `src/runner.ts`:

- **cwd** = the task's worktree (or the repo root if worktrees are disabled).
- **model** per stage (`stageModels` in `state.json`).
- **permissions** = `bypassPermissions` (the worktree bounds the blast radius), with a deny-list for irrecoverable bash (`rm -rf /`, `git push --force`, `git reset --hard origin`, …).
- **settings + skills** are loaded explicitly (`settingSources: user/project/local`, `skills: all`) so `CLAUDE.md` and the `/implement-linear-auto` family of slash-commands work.
- the agent is **forced to return** `{ status: success | blocked | failed, prUrl?, reason }` via the SDK's `outputFormat`; the orchestrator parses it and transitions state. The agent never runs `train` itself.
- **caps**: per-stage `maxTurns` and a wall-clock `timeout` (`STAGE_MAX_TURNS` / `STAGE_TIMEOUT_MS` in `src/core.ts`). A turn-limit mid-task **resumes the same session** up to 2× to finish; hitting the timeout or exhausting resumes → the task is blocked with the cause.

Every session streams all messages to `logs/<task>-<stage>-<timestamp>.jsonl`. When a task pauses, the log path is printed and recorded — read it to see exactly what happened on an unattended run.

### The stage commands

The pipeline maps each stage to a slash-command (re-created in `train/commands/`, installed to `~/.claude/commands/`):

| Stage | Command | Purpose |
|------|---------|---------|
| implement | `/implement-linear-auto` | Autopilot twin of `/implement-linear`: records a plan and proceeds (no interactive sign-off), stops only on genuine blockers. |
| review | `/review-pr` | Independent PR review; posts findings by severity. |
| address | `/address-pr` | Implements review feedback, pushes to the PR branch. |
| merge | `/merge-pr` | Pre-merge checks and squash-merge into the train branch. |

---

## Command reference

```
Setup
  train bootstrap --queue <path> --base <branch> [--repo <path>] [--project <slug>]
  train init      --queue <path> [--repo <path>] [--project <slug>]   # uses queue baseBranch as-is; no first-prompt print

Run
  train start [--max-iterations <n>] [--dry-run] [--project <slug>]    # autopilot loop
  train run-stage --task <id> --stage <implement|review|address|merge> [--dry-run] [--project <slug>]
  train run [--project <slug>]                                         # just activate the next queued task

Inspect
  train projects                                                       # all streams
  train status   [--project <slug>]
  train next     [--project <slug>]                                    # prompt for the active stage
  train prompt   --task <id> --stage <stage> [--project <slug>]

Human gates & recovery
  train approve  --task <id> [--project <slug>]
  train unblock  --task <id> --answer <text> --resume <status> [--project <slug>]
  train block    --task <id> --stage <stage> --question <text> [--by <name>] [--project <slug>]
  train handoff  --task <id> --stage <stage> --status <ok|blocked|failed> [--pr <url>] [--note <text>]
  train unlock   [--project <slug>]
  train use      <slug>
```

`--dry-run` prepares worktrees and prints intent but starts no SDK session.

---

## Recovery runbook

The train is built to **stop loudly and stay recoverable**. When `start` pauses, run `train status` to see the active task and why. Then:

### A task is `blocked`
The agent (or the orchestrator) hit a decision it can't make. The question is in `QUESTIONS.md` and `state.json` (`blockedStage` / `blockedQuestion`).

```bash
train status                         # read the blocking question
train unblock --task <id> --answer "Use approach A; do not split emails" --resume implementing
train start                          # resume — your answer is injected into the next stage prompt
```

`--resume` is the status to re-enter: `implementing | reviewing | addressing | awaiting_human | merging`. Pick the stage the work should continue from (usually the one it blocked in). Your answer is passed to the agent as "Developer guidance … follow it" and cleared once that stage succeeds.

### A task is `awaiting_human` (the review gate)
The PR is reviewed and feedback addressed; it's waiting for you to approve the merge.

```bash
# review the PR yourself, then:
train approve --task <id>
train start                          # proceeds into the merge stage
```

If you do **not** want to merge, use `train block --task <id> --stage awaiting_human --question "Holding: needs product sign-off"` to park it, or fix things by hand and `train handoff`.

### A task is `failed`
A stage could not be completed (distinct from a blocking question). Inspect the JSONL log printed at failure, fix the underlying cause (often in the repo/worktree), then either retry the stage or convert it to a block:

```bash
train run-stage --task <id> --stage <stage>          # retry the same stage
# or, after fixing by hand and pushing:
train handoff --task <id> --stage <stage> --status ok --pr <url>
```

### Stage hit the turn limit or timed out
These surface as a `blocked` task whose reason mentions `error_max_turns` / `error_timeout`. The work so far is saved in the worktree. Re-running the stage resumes from it:

```bash
train unblock --task <id> --answer "continue and finish the stage" --resume <stage-status>
train start
```

(The runner already auto-resumes a turn-capped session up to twice before blocking; a block here means even that wasn't enough — usually the stage is too big and should be split into smaller tickets.)

### Base branch not on origin
`run-stage`/`start` fail fast with *"Base branch … is not on origin, so PRs would target main."* PRs can only target a base that exists on the remote.

```bash
git -C /path/to/repo push -u origin feature/your-train-branch
train start
```

### Worktree problems
- *"existing worktree path is not a valid git worktree"* — a stale dir is sitting where the worktree should be. Remove it (`git -C <repo> worktree remove <path>` or delete the directory) and re-run.
- *"worktree setup pre-step failed"* / *"implement preflight failed"* — the configured `worktreeSetup` command failed, or the base ref isn't fetchable. Run the command by hand from the repo root to see the real error, fix it (or adjust `worktreeSetup` in `state.json`), then retry the stage. Set `worktreeSetup` to `null` to skip worktree creation entirely.

### Project is locked / a loop crashed
*"Project is already locked by pid …"* means another loop is running, or one crashed without releasing the lock.

```bash
train projects            # shows which projects are "running"
# if you're sure the owning process is dead:
train unlock --project <slug>
```

(A lock whose pid is no longer alive is reclaimed automatically on the next `start`; `unlock` is the manual escape hatch.)

### Editing state directly
`state.json` is plain JSON validated against a schema (`StateSchema`). For surgical fixes (correcting a `prUrl`, resetting a `status`, clearing `activeTaskId`) you can edit it by hand — keep it valid JSON. `train status` / `train projects` will surface a parse/validation error if you break it.

---

## State & layout

```
<TRAIN_HOME>/                 # defaults to train/.data (override with TRAIN_HOME)
  active.json                 # { "slug": "<active project>" }
  projects/<slug>/
    state.json                # the full train state (schema-validated)
    QUESTIONS.md              # append-only log of every blocking question
    logs/<task>-<stage>-<ts>.jsonl   # full SDK message stream per stage run
    last-prompt.txt           # the exact prompt sent to the most recent stage
    .bootstrap-queue.json     # the queue this project was bootstrapped from
    .lock                     # present only while a loop holds the project
```

---

## Configuration

| Setting | Where | Default |
|--------|-------|---------|
| Data root | `TRAIN_HOME` env var | `train/.data` |
| Target repo | queue `repoPath` / `--repo` | current directory |
| Worktree command | queue `worktreeSetup` (in `state.json`) | monorepo-core `setup-worktree.ts`; `null` disables |
| Per-stage models | queue `stageModels` (in `state.json`) | implement/address `sonnet`, review/merge `opus` |
| Turn / time caps | `STAGE_MAX_TURNS` / `STAGE_TIMEOUT_MS` in `src/core.ts` | implement 80t/45m, review 25t/20m, address 40t/30m, merge 15t/15m |

---

## Development

```bash
cd train
bun test            # unit + integration tests (no live SDK calls)
bunx tsc -p .       # typecheck
bunx biome check .  # lint + format
```

The code is split so the state machine is testable without the SDK:

- `src/core.ts` — pure: schemas, the stage state machine, prompt rendering (no I/O).
- `src/commands.ts` — command handlers: state load/save, question logging, locking, worktree prep, runner invocation.
- `src/runner.ts` — the only module that imports the Agent SDK.
- `src/worktree.ts` / `src/lock.ts` / `src/io.ts` / `src/paths.ts` — worktree prep, per-project lock, fs/shell helpers, project layout.
- `cli.ts` — argv parsing and dispatch.
