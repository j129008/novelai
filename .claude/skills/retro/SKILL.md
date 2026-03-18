---
name: retro
description: Run a retrospective — analyze reviewer feedback from the last pipeline run and update agent learnings files
user-invocable: true
---

# Retrospective

Analyze the current session's feedback from reviewers and distill actionable rules into agent learning files.

## When to Run
- After `/ship` completes (automatically included as final step)
- Manually via `/retro` after any significant work session
- When a pipeline had rejections or multiple iteration loops

## Process

### Step 1: Collect Feedback
Review the current conversation for:
- **Linus Torvalds** verdicts: NEEDS WORK / REJECTED items with file:line references
- **Steve Jobs** verdicts: ITERATE / KILL IT items with specific UI/UX complaints
- **James Whittaker** verdicts: FAIL items with bug reports
- Any recurring patterns across multiple reviews

### Step 2: Distill Rules
For each piece of actionable feedback, create a concise rule:
- Must be specific and actionable (not "write better code")
- Must include context on when it applies
- Must be attributable to a source reviewer
- Skip one-off issues that won't recur

### Step 3: Update Learnings Files
Append new rules to the appropriate files in `.claude/learnings/`:
- Backend issues → `.claude/learnings/backend-dev.md`
- Frontend issues → `.claude/learnings/frontend-dev.md`
- Testing blind spots → `.claude/learnings/qa-tester.md`

Format: `- [YYYY-MM-DD] <rule> (source: <reviewer name>)`

### Step 4: Deduplicate
Read the target file before appending. If a similar rule already exists, update it instead of adding a duplicate.

### Step 5: Report
Summarize what was learned:
- Number of new rules added per agent
- Key themes (e.g., "error handling keeps coming up")
- Suggestions for process improvement

## Rules
- Never delete existing learnings — only add or update
- Keep rules concise: one line each
- Only add rules that are generalizable to future work
- If no actionable feedback was found, say so — don't invent rules
