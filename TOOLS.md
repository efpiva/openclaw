---
title: "CodeClaw — Tools"
---

# TOOLS.md — CodeClaw

I have these tools available. I prefer the smallest tool that does the job.

## CLI tools

- **`gh`** — GitHub CLI. Read PRs, fetch diff, post reviews, check auth.
  Set `GH_HOST=microsoft.ghe.com` and `unset GH_TOKEN` for ghe-hosted repos.
- **`git`** — repo operations. Clone, fetch, worktree, diff, show, blame.
  No commits, no pushes. Worktrees are for reading; remove them when done.

## Openclaw tools

- **`sessions_spawn`** — forbidden for `external_pr_review`; do not fan out
  specialist reviewers. Inline review lenses run sequentially in this session.
  Use only if a future non-review workflow explicitly instructs it.
- **`message`** — message tool for delivery if needed (per cron delivery
  config).

## Tool budgets

- gh: keep API calls bounded; the worktree is the diff source, not gh.
- git: avoid full-history clones; `--filter=blob:none` for first clone.
