# Deployment

AI Workflow Hub is deployed to the OVH VPS at `15.204.255.0` and served at
`https://workflow.kevinferretti.com`.

## Production Topology

- Public DNS: `workflow.kevinferretti.com A 15.204.255.0`
- SSH from this workstation: `ai-workflow-ovh`
- GitHub Actions SSH target: `ubuntu@movement.kevinferretti.com`
- App release directory: `/opt/ai-workflow-hub`
- Current release symlink: `/opt/ai-workflow-hub/current`
- App container: `ai-workflow-hub-app-1`
- Docker network: `edge-proxy`
- Public proxy: shared `edge-proxy-caddy-1` container
- Managed Caddyfile: `/opt/edge-proxy/Caddyfile`, sourced from `kevinferretti/ovh-edge-proxy`

The app container is not published on host ports. The shared edge Caddy stack is
the only public entrypoint on ports 80 and 443, terminates TLS with Let's
Encrypt, requires HTTP basic auth, and reverse-proxies to `ai-workflow-hub:5173`
on the shared `edge-proxy` Docker network.

Do not commit the basic-auth password or GitLab token. The edge proxy auth
snippet lives on the VPS at
`/opt/edge-proxy/secrets/ai-workflow-hub-auth.caddy`, and app state including
the GitLab token is persisted in the Docker volume mounted at `/app/.devflow`.

## Manual Deploy

From Windows:

```powershell
.\scripts\deploy-vps.ps1
```

From Linux, macOS, or GitHub Actions:

```bash
bash scripts/deploy-vps.sh
```

Both scripts package the current tracked and unignored working tree, upload it
to the VPS, create a release, rebuild the app container, attach it to the shared
`edge-proxy` Docker network, and verify the app's internal health endpoint.
After a successful deploy, non-current releases are removed. Route changes
belong in `kevinferretti/ovh-edge-proxy`.

## Continuous Deployment

GitHub Actions runs `.github/workflows/deploy.yml`.

- Every push to `main` runs lint, tests, build, and then deploys production.
- Manual deploys can also be started with `workflow_dispatch`.
- A local commit by itself does not trigger CI/CD. The commit must be pushed to
  GitHub.
- No self-hosted runner is required while SSH remains reachable on
  `15.204.255.0:22`.

If SSH is later locked down to the Tailscale address `100.78.38.82`, switch to
either a self-hosted runner on the VPS or a GitHub-hosted runner that joins
Tailscale with an auth key.

## Required GitHub Secrets

Create these repository secrets in
`kevinferretti/ai-workflow-hub -> Settings -> Secrets and variables -> Actions`:

```text
OVH_SSH_PRIVATE_KEY
OVH_SSH_KNOWN_HOSTS
```

`OVH_SSH_PRIVATE_KEY` should be the full private key generated for GitHub
Actions on this workstation:

```powershell
Get-Content $HOME\.ssh\ai-workflow-ovh_ed25519 -Raw
```

`OVH_SSH_KNOWN_HOSTS` should pin the VPS host key. Use the existing trusted
entry from this workstation:

```powershell
ssh-keygen -F movement.kevinferretti.com | Where-Object { $_ -notmatch '^#' }
```

The matching public key is already authorized on the VPS for the `ubuntu` user.

## Verify Production

Unauthenticated requests should be rejected:

```bash
curl -I https://workflow.kevinferretti.com/api/state
```

Authenticated requests should return app state:

```bash
curl -u '<user>:<password>' https://workflow.kevinferretti.com/api/state
```

Check the running container:

```bash
ssh ai-workflow-ovh "docker compose --project-name ai-workflow-hub -f /opt/ai-workflow-hub/current/deploy/compose.ovh.yaml ps"
```
