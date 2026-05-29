[CmdletBinding()]
param(
  [string]$SshTarget = "ai-workflow-ovh",
  [string]$RemoteDir = "/opt/ai-workflow-hub",
  [string]$ReleaseId = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-workflow-hub-deploy-" + [System.Guid]::NewGuid())
$remoteArchive = "/tmp/ai-workflow-hub-deploy.tar.gz"
if (-not $ReleaseId) {
  $ReleaseId = [DateTime]::UtcNow.ToString("yyyyMMddHHmmss")
}

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

  Invoke-CheckedCommand scp @($archive, "${SshTarget}:$remoteArchive")

  $remoteCommand = @'
set -euo pipefail
remote_dir=__REMOTE_DIR__
remote_archive=__REMOTE_ARCHIVE__
release_id=__RELEASE_ID__
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
find "$remote_dir/releases" -mindepth 1 -maxdepth 1 -type d ! -samefile "$current_release" -exec rm -rf -- {} +
'@
  $remoteCommand = $remoteCommand.Replace(
    "__REMOTE_DIR__",
    (ConvertTo-PosixSingleQuoted $RemoteDir)
  ).Replace(
    "__REMOTE_ARCHIVE__",
    (ConvertTo-PosixSingleQuoted $remoteArchive)
  ).Replace(
    "__RELEASE_ID__",
    (ConvertTo-PosixSingleQuoted $ReleaseId)
  )

  Invoke-CheckedCommand ssh @($SshTarget, $remoteCommand)
}
finally {
  Pop-Location
  if (Test-Path $tempDir) {
    Remove-Item -Recurse -Force $tempDir
  }
}
