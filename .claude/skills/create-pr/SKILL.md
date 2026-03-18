---
name: create-pr
description: Create a pull request from current changes — branches, commits, pushes, and opens a GitHub PR
user-invocable: true
---

# Create Pull Request

Create a PR from the current working changes.

## Steps

1. **Check state** — Run `git status` and `git diff` to see what changed
2. **Create branch** — If on `main`, create a feature branch:
   - Format: `feat/<short-description>` or `fix/<short-description>`
   - Ask the user for branch name if unclear
3. **Stage & commit** — Stage relevant files (never `.env` or secrets), write a clear commit message
4. **Push** — Push the branch with `-u` flag
5. **Create PR** — Use `gh pr create`:
   - Title: short, under 70 chars
   - Body: Summary bullets + Test plan checklist
   - Format:
   ```
   gh pr create --title "title" --body "$(cat <<'EOF'
   ## Summary
   <bullets>

   ## Test plan
   <checklist>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```
6. **Return PR URL** — Show the user the PR link

## Rules
- Never commit `.env`, credentials, or secrets
- Never force push
- Always create a new branch from latest main
- Stage specific files, not `git add -A`
