[CmdletBinding()]
param(
  [string]$SshTarget = "ai-workflow-ovh",
  [string]$RemoteDir = "/home/ubuntu/ai-workflow-hub",
  [string]$CaddyfilePath = "/opt/shipshape/src/deploy/ovh/Caddyfile",
  [string]$CaddyContainer = "shipshape-ovh-caddy-1"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-workflow-hub-deploy-" + [System.Guid]::NewGuid())
$remoteArchive = "/tmp/ai-workflow-hub-deploy.tar.gz"

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $name"
  }
}

function ConvertTo-PosixSingleQuoted($value) {
  return "'" + ($value -replace "'", "'\''") + "'"
}

function Invoke-CheckedCommand($filePath, [string[]]$argumentList) {
  & $filePath @argumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$filePath failed with exit code $LASTEXITCODE"
  }
}

Require-Command git
Require-Command ssh
Require-Command scp
Require-Command tar

Push-Location $repoRoot
try {
  $status = git status --short
  if ($status) {
    Write-Warning "Deploying the current working tree, including uncommitted tracked changes."
  }

  New-Item -ItemType Directory -Path $tempDir | Out-Null
  $fileList = Join-Path $tempDir "files.txt"
  $archive = Join-Path $tempDir "ai-workflow-hub.tar.gz"

  $trackedAndUnignoredFiles = git ls-files -co --exclude-standard
  if ($LASTEXITCODE -ne 0) {
    throw "git ls-files failed with exit code $LASTEXITCODE"
  }
  $trackedAndUnignoredFiles | Set-Content -Encoding ascii $fileList
  Invoke-CheckedCommand tar @("-czf", $archive, "-T", $fileList)

  Invoke-CheckedCommand ssh @($SshTarget, "mkdir -p '$RemoteDir/releases'")
  Invoke-CheckedCommand scp @($archive, "${SshTarget}:$remoteArchive")

  $remoteCommand = @'
set -eu
remote_dir=__REMOTE_DIR__
remote_archive=__REMOTE_ARCHIVE__
caddyfile_path=__CADDYFILE_PATH__
caddy_container=__CADDY_CONTAINER__
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
'@
  $remoteCommand = $remoteCommand.Replace(
    "__REMOTE_DIR__",
    (ConvertTo-PosixSingleQuoted $RemoteDir)
  ).Replace(
    "__REMOTE_ARCHIVE__",
    (ConvertTo-PosixSingleQuoted $remoteArchive)
  ).Replace(
    "__CADDYFILE_PATH__",
    (ConvertTo-PosixSingleQuoted $CaddyfilePath)
  ).Replace(
    "__CADDY_CONTAINER__",
    (ConvertTo-PosixSingleQuoted $CaddyContainer)
  )

  Invoke-CheckedCommand ssh @($SshTarget, $remoteCommand)
}
finally {
  Pop-Location
  if (Test-Path $tempDir) {
    Remove-Item -Recurse -Force $tempDir
  }
}
