#!/bin/bash
# Stop hook: blocks stopping until both Steve Jobs and Linus Torvalds have approved.
# Checks for approval markers in /tmp/novelai-reviews/

REVIEW_DIR="/tmp/novelai-reviews"
STEVE_APPROVAL="$REVIEW_DIR/steve-jobs-approved"
LINUS_APPROVAL="$REVIEW_DIR/linus-torvalds-approved"

# If both approvals exist, allow stop
if [[ -f "$STEVE_APPROVAL" && -f "$LINUS_APPROVAL" ]]; then
  echo '{"decision":"allow","reason":"Both Steve Jobs and Linus Torvalds have approved. Ship it!"}'
  exit 0
fi

# Build message about what's missing
missing=""
if [[ ! -f "$STEVE_APPROVAL" ]]; then
  missing="Steve Jobs (UIUX review)"
fi
if [[ ! -f "$LINUS_APPROVAL" ]]; then
  if [[ -n "$missing" ]]; then
    missing="$missing and "
  fi
  missing="${missing}Linus Torvalds (Engineering review)"
fi

echo "{\"decision\":\"block\",\"reason\":\"Cannot stop yet. Still waiting for approval from: ${missing}. Run the steve-jobs and linus-torvalds agents to get their reviews. After each approves, create their marker file: mkdir -p ${REVIEW_DIR} && touch ${STEVE_APPROVAL} or ${LINUS_APPROVAL}\"}"
exit 0
