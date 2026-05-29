#!/usr/bin/env bash
set -euo pipefail

ssh_target="${SSH_TARGET:-ai-workflow-ovh}"
remote_dir="${REMOTE_DIR:-/opt/ai-workflow-hub}"
remote_archive="/tmp/ai-workflow-hub-deploy.tar.gz"
release_id="${RELEASE_ID:-${GITHUB_SHA:-$(date -u +%Y%m%d%H%M%S)}}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command git
require_command ssh
require_command scp
require_command tar

cd "$repo_root"

if [ -n "$(git status --short)" ]; then
  echo "Warning: deploying the current working tree, including uncommitted tracked changes." >&2
fi

file_list="$temp_dir/files.txt"
archive="$temp_dir/ai-workflow-hub.tar.gz"

git ls-files -co --exclude-standard > "$file_list"
tar -czf "$archive" -T "$file_list"

scp "$archive" "$ssh_target:$remote_archive"
ssh "$ssh_target" 'bash -s' -- "$remote_dir" "$remote_archive" "$release_id" <<'REMOTE_SCRIPT'
set -euo pipefail

remote_dir="$1"
remote_archive="$2"
release_id="$3"
release_dir="$remote_dir/releases/$release_id"

sudo mkdir -p "$remote_dir/releases"
sudo chown -R "$USER:$USER" "$remote_dir"

rm -rf "$release_dir"
mkdir -p "$release_dir"
tar -xzf "$remote_archive" -C "$release_dir"
rm -f "$remote_archive"

docker network create edge-proxy >/dev/null 2>&1 || true

if ! docker ps \
  --filter 'name=^/edge-proxy-caddy-1$' \
  --filter 'status=running' \
  --format '{{.Names}}' | grep -qx edge-proxy-caddy-1; then
  echo "edge-proxy is not running. Deploy kevinferretti/ovh-edge-proxy first." >&2
  exit 1
fi

ln -sfn "$release_dir" "$remote_dir/current"
cd "$remote_dir/current"
docker compose --project-name ai-workflow-hub -f deploy/compose.ovh.yaml up --build -d app

for attempt in $(seq 1 20); do
  if docker compose --project-name ai-workflow-hub -f deploy/compose.ovh.yaml exec -T app \
    node -e "fetch('http://127.0.0.1:5173/api/state').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    break
  fi

  if [ "$attempt" -eq 20 ]; then
    echo "AI Workflow Hub container did not become healthy." >&2
    docker compose --project-name ai-workflow-hub -f deploy/compose.ovh.yaml logs --tail=100 app >&2
    exit 1
  fi

  sleep 2
done

current_release="$(readlink -f "$remote_dir/current")"
find "$remote_dir/releases" -mindepth 1 -maxdepth 1 -type d ! -samefile "$current_release" -printf '%T@ %p\n' \
  | sort -n \
  | head -n -4 \
  | cut -d' ' -f2- \
  | xargs -r rm -rf
REMOTE_SCRIPT
