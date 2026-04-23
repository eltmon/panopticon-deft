# ~/.panopticon/bin/hook-lib.sh
# Shared helpers for Panopticon heartbeat hooks (PAN-800)
# Sourced by pre-tool-hook, heartbeat-hook, stop-hook, session-start-hook, etc.
#
# Usage: source "$(dirname "$0")/hook-lib.sh"

# Resolve agent ID from env (set by pan work start) or tmux session name
_panopticon_resolve_agent_id() {
  if [ -n "$PANOPTICON_AGENT_ID" ]; then
    echo "$PANOPTICON_AGENT_ID"
  elif [ -n "$TMUX" ]; then
    tmux display-message -p '#S' 2>/dev/null || echo "main-cli"
  else
    echo "main-cli"
  fi
}

# Dashboard endpoint (default to localhost if not configured)
_panopticon_dashboard_url() {
  echo "${PANOPTICON_DASHBOARD_URL:-http://localhost:3000}"
}

# POST a typed event to the dashboard heartbeat endpoint.
# On failure, buffers to pending-events.jsonl with flock serialization.
# Always returns 0 — never breaks the calling hook.
panopticon_post_event() {
  local agent_id="${1:-unknown}"
  local body="$2"
  local dashboard_url
  dashboard_url="$(_panopticon_dashboard_url)"
  local agent_dir="$HOME/.panopticon/agents/$agent_id"
  local pending_file="$agent_dir/pending-events.jsonl"
  local lock_file="$agent_dir/pending.lock"

  # Try POST with 0.5s timeout
  if curl -s -o /dev/null -w "%{http_code}" \
       --max-time 0.5 \
       -X POST \
       -H "Content-Type: application/json" \
       -d "$body" \
       "$dashboard_url/api/agents/$agent_id/heartbeat" 2>/dev/null | grep -q "^2"; then

    # On success, replay any pending events first
    if [ -f "$pending_file" ]; then
      (
        flock -x -w 5 200 || exit 0
        while IFS= read -r line; do
          [ -n "$line" ] || continue
          curl -s -o /dev/null --max-time 0.5 \
            -X POST -H "Content-Type: application/json" \
            -d "$line" \
            "$dashboard_url/api/agents/$agent_id/heartbeat" 2>/dev/null || true
        done < "$pending_file"
        : > "$pending_file"
      ) 200>"$lock_file"
    fi
    return 0
  fi

  # On failure, append to pending-events.jsonl with flock
  mkdir -p "$agent_dir"
  (
    flock -x -w 5 200 || exit 0
    echo "$body" >> "$pending_file"
  ) 200>"$lock_file"
  return 1
}
