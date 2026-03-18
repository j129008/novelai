---
name: ship
description: Run the full development pipeline — PM spec → implement → QA → PR → code review → PM approval
user-invocable: true
---

# Ship Feature Pipeline

Run the complete development workflow from spec to ship. Invoke with `/ship <feature description>`.

## Pipeline Steps

### Step 1: PM Spec (Steve Jobs)
Invoke the `steve-jobs` agent to write a feature spec:
- Problem definition
- Solution design
- Acceptance criteria
- Priority level

Present the spec to the user for confirmation before proceeding.

### Step 2: Implementation (Guido van Rossum / Lea Verou)
Based on the spec, dispatch to the appropriate engineer(s):
- **Backend changes** → `backend-dev` agent (Guido van Rossum)
- **Frontend changes** → `frontend-dev` agent (Lea Verou)
- **Full-stack changes** → Both agents, backend first

Run agents in parallel when their work is independent.

### Step 3: QA Testing (James Whittaker)
Invoke the `qa-tester` agent to test all changes:
- Must receive **PASS** to continue
- If **FAIL** — fix the bugs and re-test (loop back to Step 2)

### Step 4: Create PR
Use the `/create-pr` skill to:
- Create a feature branch
- Commit and push changes
- Open a GitHub PR

### Step 5: Code Review (Linus Torvalds)
Invoke the `linus-torvalds` agent to review the PR:
- Must receive **APPROVED** to continue
- If **NEEDS WORK** — fix issues and re-request review (loop back to Step 2)
- If **REJECTED** — escalate to user

### Step 6: PM Review (Steve Jobs)
Invoke the `steve-jobs` agent for final product review:
- Must receive **SHIP IT** to complete
- If **ITERATE** — make changes and loop back to Step 2
- If **KILL IT** — stop and discuss with user

### Step 7: Merge & Complete
After PM approval:
- Merge the PR via `gh pr merge --squash`
- Create the PM approval marker file to satisfy the Stop hook
- Report completion to user

## Rules
- Always confirm the spec with the user before implementing
- Never skip QA — no exceptions
- If any step fails twice, stop and ask the user for guidance
- The Stop hook will block completion until Steve Jobs says SHIP IT
