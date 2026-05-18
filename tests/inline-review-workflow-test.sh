#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

agents=AGENTS.md
tools=TOOLS.md

require() {
  local pattern="$1" file="$2" message="$3"
  if ! grep -qE "$pattern" "$file"; then
    echo "$message" >&2
    exit 1
  fi
}

reject_between() {
  local start="$1" end="$2" pattern="$3" file="$4" message="$5"
  if awk -v start="$start" -v end="$end" -v pattern="$pattern" '
    $0 ~ start { in_block=1 }
    in_block && $0 ~ end { in_block=0 }
    in_block && $0 ~ pattern { found=1 }
    END { exit found ? 0 : 1 }
  ' "$file"; then
    echo "$message" >&2
    exit 1
  fi
}

require '### 4\. Select inline review lenses' "$agents" \
  "expected external_pr_review step 4 to select inline review lenses"
require '### 5\. Run inline lens passes sequentially' "$agents" \
  "expected external_pr_review step 5 to run inline lens passes sequentially"
require 'Never call `sessions_spawn`, `subagents`, or `/fleet` from `external_pr_review`' "$agents" \
  "expected external_pr_review to explicitly forbid specialist fanout"
require 'Inline lenses:' "$agents" \
  "expected GitHub review footer to report inline lenses"
require 'sessions_spawn.*forbidden for `external_pr_review`' "$tools" \
  "expected TOOLS.md to mark sessions_spawn forbidden for external_pr_review"

reject_between '^## Workflow: external_pr_review$' '^## Workflow: own_pr_comment_response$' \
  'Dispatch sub-agents|sessions_spawn\(|Wait for all to return|sub-agent' "$agents" \
  "external_pr_review must not instruct specialist subagent fanout"
