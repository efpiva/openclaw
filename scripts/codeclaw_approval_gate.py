#!/usr/bin/env python3
"""CodeClaw push approval gate for own-PR workflows.

This helper intentionally fails closed: behavior-changing CodeClaw-authored
changes must not be pushed until an explicit approval token is granted.
It is small/deterministic so AGENTS.md can require calling it before any
own-PR push.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

BEHAVIOR_PATH_PATTERNS = [
    r"(^|/)src/",
    r"(^|/)lib/",
    r"(^|/)crates/",
    r"(^|/)packages/",
    r"(^|/)services/",
    r"(^|/)apps/",
    r"(^|/)cmd/",
    r"(^|/)bin/",
    r"(^|/)scripts/",
    r"(^|/)\.github/workflows/",
    r"(^|/)\.pipelines/",
    r"(^|/)pipelines/",
    r"(^|/)deploy/",
    r"(^|/)deployment/",
    r"(^|/)k8s/",
    r"(^|/)helm/",
    r"(^|/)charts/",
    r"(^|/)terraform/",
    r"(^|/)bicep/",
    r"(^|/)infra/",
    r"(^|/)config/",
    r"(^|/)migrations/",
    r"(^|/)Dockerfile$",
    r"(^|/)docker-compose[^/]*\.ya?ml$",
    r"(^|/)justfile$",
    r"(^|/)Makefile$",
]

BEHAVIOR_EXTENSIONS = {
    ".rs", ".go", ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".kt",
    ".cs", ".cpp", ".c", ".h", ".hpp", ".swift", ".rb", ".php",
    ".sh", ".ps1", ".sql", ".bicep", ".tf", ".yaml", ".yml", ".json", ".toml",
}

DOC_BEHAVIOR_PATTERNS = [
    r"runbook", r"operations", r"deployment", r"release", r"pipeline", r"prod",
    r"operator", r"recovery", r"incident", r"approval", r"rollout",
]

STATE_DIR = Path(os.environ.get("CODECLAW_APPROVAL_DIR", ".codeclaw/approvals"))


@dataclass
class PendingApproval:
    token: str
    repo: str
    pr: str
    head: str
    base: str
    commit: str
    session_key: str
    files: list[str]
    impact: str
    validation: str
    requested_at: str
    expires_at: str
    status: str = "waiting"
    approved_by: str | None = None
    approved_at: str | None = None
    closed_at: str | None = None
    closed_by: str | None = None
    closed_reason: str | None = None


def behavior_reasons(paths: Iterable[str]) -> list[str]:
    reasons: list[str] = []
    for path in paths:
        p = path.strip()
        if not p:
            continue
        normalized = p.replace("\\", "/")
        suffix = Path(normalized).suffix
        if suffix in BEHAVIOR_EXTENSIONS:
            reasons.append(f"{p}: source/config/script extension {suffix}")
            continue
        if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in BEHAVIOR_PATH_PATTERNS):
            reasons.append(f"{p}: behavior-sensitive path")
            continue
        if normalized.lower().endswith((".md", ".mdx", ".txt")) and any(
            re.search(pattern, normalized, re.IGNORECASE) for pattern in DOC_BEHAVIOR_PATTERNS
        ):
            reasons.append(f"{p}: operator/release/runbook documentation path")
            continue
    return reasons


def token_for(pr: str) -> str:
    return f"push-pr-{pr}-{secrets.token_hex(3)}"


def state_path(token: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", token)
    return STATE_DIR / f"{safe}.json"


def read_paths(args: argparse.Namespace) -> list[str]:
    paths: list[str] = []
    for item in args.file or []:
        paths.extend(x for x in item.splitlines() if x.strip())
    if args.files_from:
        paths.extend(x for x in Path(args.files_from).read_text().splitlines() if x.strip())
    return paths


def cmd_classify(args: argparse.Namespace) -> int:
    paths = read_paths(args)
    reasons = behavior_reasons(paths)
    payload = {"behavior_changing": bool(reasons), "reasons": reasons, "files": paths}
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 2 if reasons else 0


def cmd_request(args: argparse.Namespace) -> int:
    paths = read_paths(args)
    reasons = behavior_reasons(paths)
    if args.non_behavioral and reasons:
        print("Refusing --non-behavioral: changed files look behavior-sensitive:", file=sys.stderr)
        for reason in reasons:
            print(f"- {reason}", file=sys.stderr)
        return 2
    if args.non_behavioral:
        print(json.dumps({"required": False, "reason": "declared non-behavioral and no sensitive paths detected"}))
        return 0

    now = datetime.now(timezone.utc)
    token = args.token or token_for(args.pr)
    pending = PendingApproval(
        token=token,
        repo=args.repo,
        pr=args.pr,
        head=args.head,
        base=args.base,
        commit=args.commit,
        session_key=args.session_key,
        files=paths,
        impact=args.impact,
        validation=args.validation,
        requested_at=now.isoformat(),
        expires_at=(now + timedelta(minutes=args.ttl_minutes)).isoformat(),
    )
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_path(token).write_text(json.dumps(asdict(pending), indent=2, sort_keys=True) + "\n")

    body = f"""Approval required before CodeClaw pushes behavior-changing changes.

Repo/PR: {args.repo}#{args.pr}
Session: {args.session_key}
Head/base: {args.head} / {args.base}
Commit: {args.commit}
Behavior impact: {args.impact}
Validation: {args.validation}
Files changed:\n"""
    for path in paths:
        body += f"- {path}\n"
    body += f"\nYou can ask follow-up questions normally. I will not push from ordinary chat replies.\n\nApprove only via button/callback or this explicit token command:\napprove {token}\n\nDecline command:\ndeny {token}\n"

    print(json.dumps({
        "required": True,
        "token": token,
        "state_file": str(state_path(token)),
        "session_key": args.session_key,
        "message": body,
        "presentation": {
            "title": f"Approve CodeClaw push for {args.repo}#{args.pr}",
            "tone": "warning",
            "blocks": [
                {"type": "text", "text": body},
                {"type": "buttons", "buttons": [
                    {"label": "Approve push", "value": f"approve {token}", "style": "success"},
                    {"label": "Deny push", "value": f"deny {token}", "style": "danger"},
                ]},
            ],
        },
    }, indent=2, sort_keys=True))
    return 3


def load_pending(token: str) -> PendingApproval:
    data = json.loads(state_path(token).read_text())
    known_fields = PendingApproval.__dataclass_fields__.keys()
    return PendingApproval(**{key: data[key] for key in known_fields if key in data})


def write_pending(pending: PendingApproval) -> None:
    write_pending_to_path(state_path(pending.token), pending)


def write_pending_to_path(path: Path, pending: PendingApproval) -> None:
    path.write_text(json.dumps(asdict(pending), indent=2, sort_keys=True) + "\n")


def parse_timestamp(raw: str) -> datetime:
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def is_expired(expires_at: str, now: datetime) -> bool:
    return now > parse_timestamp(expires_at)


def mark_expired(pending: PendingApproval, *, now: datetime, reason: str) -> None:
    pending.status = "expired"
    pending.closed_at = now.isoformat()
    pending.closed_by = "codeclaw-reconcile"
    pending.closed_reason = reason


def cmd_resolve(args: argparse.Namespace) -> int:
    pending = load_pending(args.token)
    now = datetime.now(timezone.utc)
    if is_expired(pending.expires_at, now):
        mark_expired(pending, now=now, reason="approval expired before resolution")
        write_pending(pending)
        print(f"approval expired for {args.token}", file=sys.stderr)
        return 2
    if args.decision == "approve":
        pending.status = "approved"
        pending.approved_by = args.by
        pending.approved_at = now.isoformat()
    else:
        pending.status = "denied"
        pending.approved_by = args.by
        pending.approved_at = now.isoformat()
    write_pending(pending)
    print(json.dumps(asdict(pending), indent=2, sort_keys=True))
    return 0


def cmd_assert(args: argparse.Namespace) -> int:
    pending = load_pending(args.token)
    now = datetime.now(timezone.utc)
    if is_expired(pending.expires_at, now):
        mark_expired(pending, now=now, reason="approval expired before push assertion")
        write_pending(pending)
        print(f"push blocked: approval {args.token} is expired", file=sys.stderr)
        return 2
    if pending.status != "approved":
        print(f"push blocked: approval {args.token} is {pending.status}", file=sys.stderr)
        return 2
    expected = {
        "repo": args.repo,
        "pr": args.pr,
        "head": args.head,
        "base": args.base,
        "commit": args.commit,
    }
    mismatches = []
    for key, value in expected.items():
        if value and getattr(pending, key) != value:
            mismatches.append(f"{key}: pending={getattr(pending, key)} current={value}")
    if mismatches:
        print("push blocked: approval context mismatch", file=sys.stderr)
        for mismatch in mismatches:
            print(f"- {mismatch}", file=sys.stderr)
        return 2
    fingerprint = hashlib.sha256("\n".join(pending.files).encode()).hexdigest()[:12]
    print(json.dumps({"approved": True, "token": args.token, "files_fingerprint": fingerprint}))
    return 0



def parse_approval_command(text: str) -> tuple[str, str] | None:
    match = re.fullmatch(r"\s*(approve|deny)\s+(push-pr-[A-Za-z0-9_.-]+)\s*", text or "", re.IGNORECASE)
    if not match:
        return None
    return match.group(1).lower(), match.group(2)


def cmd_handle_command(args: argparse.Namespace) -> int:
    parsed = parse_approval_command(args.text)
    if not parsed:
        print(json.dumps({"handled": False, "reason": "not an exact approval command"}))
        return 1
    decision, token = parsed
    pending = load_pending(token)
    now = datetime.now(timezone.utc)
    if is_expired(pending.expires_at, now):
        mark_expired(pending, now=now, reason="approval expired before command handling")
        write_pending(pending)
        print(json.dumps({
            "handled": True,
            "status": "expired",
            "token": token,
            "session_key": pending.session_key,
            "session_message": f"CODECLAW_APPROVAL_RESULT token={token} decision=expired by={args.by}",
        }, indent=2, sort_keys=True))
        return 2
    pending.status = "approved" if decision == "approve" else "denied"
    pending.approved_by = args.by
    pending.approved_at = now.isoformat()
    write_pending(pending)
    print(json.dumps({
        "handled": True,
        "status": pending.status,
        "token": token,
        "session_key": pending.session_key,
        "session_message": f"CODECLAW_APPROVAL_RESULT token={token} decision={decision} by={args.by}",
    }, indent=2, sort_keys=True))
    return 0


def iter_state_files() -> Iterable[Path]:
    if not STATE_DIR.exists():
        return []
    return sorted(STATE_DIR.glob("*.json"))


def cmd_reconcile(args: argparse.Namespace) -> int:
    now = datetime.now(timezone.utc)
    scanned = 0
    would_expire = 0
    expired = 0
    skipped = 0
    for path in iter_state_files():
        scanned += 1
        try:
            data = json.loads(path.read_text())
            pending = PendingApproval(**{
                key: data[key]
                for key in PendingApproval.__dataclass_fields__.keys()
                if key in data
            })
        except Exception as exc:  # pragma: no cover - defensive for manual state repair
            skipped += 1
            print(f"skipping unreadable approval state {path}: {exc}", file=sys.stderr)
            continue
        if pending.status != "waiting" or not is_expired(pending.expires_at, now):
            continue
        if args.dry_run:
            would_expire += 1
            continue
        mark_expired(pending, now=now, reason="waiting approval expired during reconciliation")
        write_pending_to_path(path, pending)
        expired += 1
    print(json.dumps({
        "scanned": scanned,
        "would_expire": would_expire,
        "expired": expired,
        "skipped": skipped,
        "dry_run": bool(args.dry_run),
    }, indent=2, sort_keys=True))
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    common_files = argparse.ArgumentParser(add_help=False)
    common_files.add_argument("--file", action="append", help="Changed file path; may be repeated or newline-separated")
    common_files.add_argument("--files-from", help="Read changed file paths from file")

    classify = sub.add_parser("classify", parents=[common_files], help="Classify changed files")
    classify.set_defaults(func=cmd_classify)

    req = sub.add_parser("request", parents=[common_files], help="Create pending approval and render request")
    req.add_argument("--repo", required=True)
    req.add_argument("--pr", required=True)
    req.add_argument("--head", required=True)
    req.add_argument("--base", required=True)
    req.add_argument("--commit", required=True)
    req.add_argument("--session-key", required=True, help="Paused PR session to notify after approval/deny")
    req.add_argument("--impact", required=True)
    req.add_argument("--validation", required=True)
    req.add_argument("--token")
    req.add_argument("--ttl-minutes", type=int, default=60)
    req.add_argument("--non-behavioral", action="store_true", help="Declare no approval needed; fails if sensitive paths are detected")
    req.set_defaults(func=cmd_request)

    resolve = sub.add_parser("resolve", help="Resolve a pending approval from a structured callback/token command")
    resolve.add_argument("token")
    resolve.add_argument("decision", choices=["approve", "deny"])
    resolve.add_argument("--by", required=True)
    resolve.set_defaults(func=cmd_resolve)

    ass = sub.add_parser("assert-approved", help="Fail unless approval token is approved for the exact push context")
    ass.add_argument("token")
    ass.add_argument("--repo", required=True)
    ass.add_argument("--pr", required=True)
    ass.add_argument("--head", required=True)
    ass.add_argument("--base", required=True)
    ass.add_argument("--commit", required=True)
    ass.set_defaults(func=cmd_assert)

    handle = sub.add_parser("handle-command", help="Parse an exact approve/deny token command and resolve it")
    handle.add_argument("--text", required=True)
    handle.add_argument("--by", required=True)
    handle.set_defaults(func=cmd_handle_command)

    reconcile = sub.add_parser("reconcile", help="Expire stale waiting approvals without deleting audit state")
    reconcile.add_argument("--dry-run", action="store_true")
    reconcile.set_defaults(func=cmd_reconcile)
    return p


def main() -> int:
    args = parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
