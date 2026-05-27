#!/usr/bin/env bash
set -euo pipefail

ssh_target="${SSH_TARGET:-ai-workflow-ovh}"
remote_dir="${REMOTE_DIR:-/home/ubuntu/ai-workflow-hub}"
caddyfile_path="${CADDYFILE_PATH:-/opt/shipshape/src/deploy/ovh/Caddyfile}"
caddy_container="${CADDY_CONTAINER:-shipshape-ovh-caddy-1}"
remote_archive="/tmp/ai-workflow-hub-deploy.tar.gz"

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
ssh "$ssh_target" 'bash -s' -- "$remote_dir" "$remote_archive" "$caddyfile_path" "$caddy_container" <<'REMOTE_SCRIPT'
set -euo pipefail

remote_dir="$1"
remote_archive="$2"
caddyfile_path="$3"
caddy_container="$4"
release_dir="$remote_dir/releases/$(date +%Y%m%d%H%M%S)"

mkdir -p "$release_dir"
tar -xzf "$remote_archive" -C "$release_dir"

if [ ! -f "$remote_dir/.env" ]; then
  cp "$release_dir/.env.deploy.example" "$remote_dir/.env"
  echo "Created $remote_dir/.env. Set BASIC_AUTH_USER and BASIC_AUTH_HASH, then rerun this script." >&2
  exit 2
fi

cp "$remote_dir/.env" "$release_dir/.env"
ln -sfn "$release_dir" "$remote_dir/current"
cd "$remote_dir/current"
docker compose --project-name ai-workflow-hub -f deploy/compose.ovh.yaml up --build -d app

basic_auth_user="$(awk -F= '$1 == "BASIC_AUTH_USER" { sub(/^[^=]*=/, ""); print; exit }' "$remote_dir/.env")"
basic_auth_hash="$(awk -F= '$1 == "BASIC_AUTH_HASH" { sub(/^[^=]*=/, ""); print; exit }' "$remote_dir/.env")"

if [ -z "$basic_auth_user" ] || [ -z "$basic_auth_hash" ]; then
  echo "Set BASIC_AUTH_USER and BASIC_AUTH_HASH in $remote_dir/.env, then rerun this script." >&2
  exit 2
fi

if printf '%s' "$basic_auth_hash" | grep -q 'replace-with-caddy-hash-password-output'; then
  echo "Replace the placeholder BASIC_AUTH_HASH in $remote_dir/.env, then rerun this script." >&2
  exit 2
fi

tmp_caddyfile="$(mktemp)"
awk '
  /^# BEGIN ai-workflow-hub$/ { skip = 1; next }
  /^# END ai-workflow-hub$/ { skip = 0; next }
  skip != 1 { print }
' "$caddyfile_path" > "$tmp_caddyfile"
cat >> "$tmp_caddyfile" <<CADDY

# BEGIN ai-workflow-hub
workflow.kevinferretti.com {
	encode zstd gzip

	basic_auth {
		$basic_auth_user $basic_auth_hash
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	reverse_proxy ai-workflow-hub:5173
}
# END ai-workflow-hub
CADDY
install -m 0644 "$tmp_caddyfile" "$caddyfile_path"
rm -f "$tmp_caddyfile"

docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile
docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile
REMOTE_SCRIPT
