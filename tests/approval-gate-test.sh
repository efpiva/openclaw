#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

gate=scripts/codeclaw_approval_gate.py
state_dir=$(mktemp -d)
trap 'rm -rf "$state_dir"' EXIT
export CODECLAW_APPROVAL_DIR="$state_dir"

# Behavior-sensitive paths must be classified as approval-required.
if python3 "$gate" classify --file '.pipelines/lobster_openclaw/Prod-302-FRE.Release.yml' >/tmp/codeclaw-gate-classify.json; then
  echo "expected pipeline YAML to require approval" >&2
  exit 1
fi
grep -q 'behavior_changing.*true\|"behavior_changing": true' /tmp/codeclaw-gate-classify.json

# Pure memory/workflow notes are allowed to classify as non-behavioral.
python3 "$gate" classify --file 'memory/anti-patterns.md' >/tmp/codeclaw-gate-memory.json
grep -q '"behavior_changing": false' /tmp/codeclaw-gate-memory.json

# Requesting approval creates a durable pending token and fails closed until resolved.
set +e
python3 "$gate" request \
  --repo bic/lobster \
  --pr 1924 \
  --head HEADSHA \
  --base BASESHA \
  --commit COMMITSHA \
  --session-key session:pr-microsoft-ghe-com-bic-lobster-1924 \
  --impact 'pipeline behavior change' \
  --validation 'unit tests passed' \
  --token push-pr-1924-test \
  --file '.pipelines/lobster_openclaw/Prod-302-FRE.Release.yml' \
  >/tmp/codeclaw-gate-request.json
status=$?
set -e
if [[ "$status" -ne 3 ]]; then
  echo "expected approval request to exit 3, got $status" >&2
  exit 1
fi
grep -q 'push-pr-1924-test' /tmp/codeclaw-gate-request.json

grep -q '"status": "waiting"' "$state_dir/push-pr-1924-test.json"
if python3 "$gate" assert-approved push-pr-1924-test \
  --repo bic/lobster --pr 1924 --head HEADSHA --base BASESHA --commit COMMITSHA; then
  echo "assert-approved should fail before approval" >&2
  exit 1
fi

python3 "$gate" handle-command --text 'why is this needed?' --by Eduardo >/tmp/codeclaw-gate-chat.json && {
  echo "ordinary chat should not resolve approval" >&2
  exit 1
}
grep -q '"handled": false' /tmp/codeclaw-gate-chat.json
python3 "$gate" handle-command --text 'approve push-pr-1924-test' --by Eduardo >/tmp/codeclaw-gate-resolve.json
grep -q '"status": "approved"' /tmp/codeclaw-gate-resolve.json
grep -q 'session:pr-microsoft-ghe-com-bic-lobster-1924' /tmp/codeclaw-gate-resolve.json
python3 "$gate" assert-approved push-pr-1924-test \
  --repo bic/lobster --pr 1924 --head HEADSHA --base BASESHA --commit COMMITSHA \
  >/tmp/codeclaw-gate-assert.json
grep -q '"approved": true' /tmp/codeclaw-gate-assert.json

# Approval is bound to exact context; stale/mismatched pushes stay blocked.
if python3 "$gate" assert-approved push-pr-1924-test \
  --repo bic/lobster --pr 1924 --head DIFFERENT --base BASESHA --commit COMMITSHA; then
  echo "assert-approved should fail on context mismatch" >&2
  exit 1
fi

# Approved tokens must still expire; stale approvals cannot authorize later pushes.
python3 - "$state_dir/push-pr-1924-test.json" <<'PY'
import json, sys
from datetime import datetime, timedelta, timezone
path = sys.argv[1]
data = json.loads(open(path).read())
data["expires_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
open(path, "w").write(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
if python3 "$gate" assert-approved push-pr-1924-test \
  --repo bic/lobster --pr 1924 --head HEADSHA --base BASESHA --commit COMMITSHA; then
  echo "assert-approved should fail on expired approval" >&2
  exit 1
fi

# Reconciliation expires stale waiting records without deleting audit JSON.
set +e
python3 "$gate" request \
  --repo bic/lobster \
  --pr 1925 \
  --head HEADSHA2 \
  --base BASESHA2 \
  --commit COMMITSHA2 \
  --session-key session:pr-microsoft-ghe-com-bic-lobster-1925 \
  --impact 'runtime behavior change' \
  --validation 'focused tests passed' \
  --token push-pr-1925-expired \
  --ttl-minutes -1 \
  --file 'src/lobster_runtime/src/lib.rs' \
  >/tmp/codeclaw-gate-expired-request.json
status=$?
set -e
if [[ "$status" -ne 3 ]]; then
  echo "expected expired approval request setup to exit 3, got $status" >&2
  exit 1
fi
grep -q '"status": "waiting"' "$state_dir/push-pr-1925-expired.json"
python3 "$gate" reconcile --dry-run >/tmp/codeclaw-gate-reconcile-dry-run.json
grep -q '"would_expire": 1' /tmp/codeclaw-gate-reconcile-dry-run.json
grep -q '"status": "waiting"' "$state_dir/push-pr-1925-expired.json"
python3 "$gate" reconcile >/tmp/codeclaw-gate-reconcile.json
grep -q '"expired": 1' /tmp/codeclaw-gate-reconcile.json
grep -q '"status": "expired"' "$state_dir/push-pr-1925-expired.json"
grep -q '"closed_by": "codeclaw-reconcile"' "$state_dir/push-pr-1925-expired.json"

# Reconciliation must update the scanned file even when legacy filenames do not match tokens.
python3 - "$state_dir/push-pr-1925-expired.json" "$state_dir/push-pr-1925-expired.stale.json" <<'PY'
import json, sys
from datetime import datetime, timedelta, timezone
src, dst = sys.argv[1:]
data = json.loads(open(src).read())
data["token"] = "push-pr-1925-expired-legacy"
data["status"] = "waiting"
data["expires_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
for key in ["closed_at", "closed_by", "closed_reason"]:
    data.pop(key, None)
open(dst, "w").write(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
python3 "$gate" reconcile >/tmp/codeclaw-gate-reconcile-legacy.json
grep -q '"status": "expired"' "$state_dir/push-pr-1925-expired.stale.json"
test ! -e "$state_dir/push-pr-1925-expired-legacy.json"
