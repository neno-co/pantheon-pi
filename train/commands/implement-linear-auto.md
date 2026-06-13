# Implement Linear Ticket (Autopilot)

You are tasked with implementing an approved task from Linear in **unattended autopilot mode**. This task contains necessary context, specific changes, and success criteria.

This is the autopilot twin of `/implement-linear`. The difference is the plan gate: instead of pausing for interactive user sign-off before implementing, you **record your plan to a durable artifact and proceed**. A human reviews the result at the PR/review stage, not the plan. You still stop for genuine decisions you cannot resolve on your own (see "When to Stop").

## Getting Started

When given a ticket id or URL:
- Read the ticket completely, **including all of its comments** — clarifications, scope changes, and decisions often live in the comment thread rather than the description, and the latest comment may supersede the original ask
- Read all files mentioned in it
- **Read files fully** - never use limit/offset parameters, you need complete context
- Think deeply about how the pieces fit together
- Run the **Plan & Record** step below, then proceed directly into the TDD cycle
- Create a todo list and begin the TDD cycle

If no url or ticket number is provided, that is itself a blocker — report it (see "When to Stop").

## Implementation Philosophy

Tickets are a strong starting point but not infallible. They can be stale, ambiguous, miss codebase context, or describe an approach that no longer fits after recent changes. Your job is to:
- Understand what the ticket is asking for and why
- Cross-check it against the current state of the codebase
- Record any mismatches up-front, before writing code
- Implement the agreed-upon plan fully
- Update checkboxes in the ticket as you complete sections if there are any

The ticket guides the work, but your judgment plus current codebase reality should be weighted alongside it. Do not silently deviate — record deviations in the plan artifact with your reasoning, then proceed. Reserve stopping for decisions you genuinely cannot make (see "When to Stop").

## Plan & Record (do this BEFORE implementing)

Before any implementation, perform an upfront sanity-check pass and **record** a short plan:

1. **Read** the ticket — description **and all comments** — and every file it references in full. Treat comments as authoritative where they conflict with or refine the original description.
2. **Cross-check against the codebase**: have file paths, functions, APIs, schemas, or surrounding patterns changed since the ticket was written? Are the assumptions the ticket makes still true? Use grep / read to verify, do not assume.
3. **Write the plan to a markdown file** under `thoughts/tasks/<ticket-id-and-slug>/` (matching the repo's existing task-doc convention — create the directory if needed), covering:
   - **What the ticket asks for**, in your own words (not a copy-paste)
   - **Assumptions in the ticket that no longer hold** (if any), with file:line evidence
   - **Chosen approach and any deviations** from the ticket and why — or an explicit "no deviations, ticket matches current state". When the ticket leaves a reasonable choice open and either option is defensible, **pick the one most consistent with existing patterns, record the decision and your rationale, and proceed** — do not stop for it.
   - **Resolved-vs-open**: list anything you decided autonomously and anything that is a genuine blocker (the latter means you stop — see below).
4. **Proceed** directly into the TDD / implementation cycle. Do not wait for sign-off. The plan file is committed as part of the work and is carried into the PR description, so the human can review your reasoning alongside the diff.

## When to Stop (genuine blockers only)

Autopilot is not "never ask". Return control to the orchestrator **only** when you hit a decision you genuinely cannot make from the ticket + codebase, where guessing wrong would be expensive or hard to reverse. Examples: a product/policy choice with materially different user-facing behavior and no precedent in the codebase; conflicting requirements; a required external resource or credential that is missing.

When you must stop, do not edit further. State the blocker clearly and concisely:

```
Expected: [what the ticket says / what you needed]
Found: [actual situation]
Why this matters: [why you can't safely pick]
The decision needed: [one clear question]
```

Do **not** stop merely to confirm a reasonable plan, to get permission to start, or for a choice where one option is clearly more consistent with the codebase — record those decisions and keep moving.

## Verification Approach (TDD Enforced)

While implementing, you MUST follow the TDD cycle and validation:

1. **RED Phase**: Verify tests fail before implementation
   - Run tests: `deno task test:local` or specific test file
   - Confirm tests fail for the right reasons
   - Document that RED phase is complete

2. **GREEN Phase**: Implement to make tests pass
   - Write minimal implementation
   - Run tests: `deno task test:local`
   - Confirm all tests pass

3. **VALIDATE Phase**: Run full validation
   - Execute: `deno task validate`
   - This runs: lint, fmt, check, and test:local
   - Fix any issues that arise
   - Confirm `deno task validate` exits with success

4. **Update Progress**:
   - Check off TDD checkboxes in plan (RED, GREEN, VALIDATE)
   - Update your todo list
   - Check off completed items in the plan file using Edit

5. **Commit**: Use `/commit` command (pre-commit hooks will validate)
6. **Push**: Use `/push` command to push changes to remote repository
7. **Update PR description**: use `/generate-pr-description` command to generate a PR description (incorporating the plan artifact) and push it to the PR using `gh` or `github mcp`

**IMPORTANT**: You MUST NOT skip the `deno task validate` step. If `deno task validate` fails, fix the issues before committing or proceeding.

## If You Get Stuck

When something isn't working as expected:
- First, make sure you've read and understood all the relevant code
- Consider if the codebase has evolved since the plan was written
- Try to resolve it yourself; only if it's a genuine blocker (see "When to Stop") do you return control

Use sub-tasks sparingly - mainly for targeted debugging or exploring unfamiliar territory.

## Resuming Work

If the plan file has existing checkmarks:
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

If you were resumed after a blocker, the developer's answer is provided as guidance in your prompt — follow it and continue without re-asking.

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.
