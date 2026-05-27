# AI Workflow Hub

Local control plane for triggering GitLab-backed AI development workflows per project.

The app deliberately uses GitLab pipelines as the execution layer. It stores project and workflow definitions locally, calls the GitLab Pipeline API when you click **Run**, records the resulting pipeline status and URL, and can persist a successful skill run artifact back into the same repository. It does not ship canned demo runs.

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5174`.

## Configure

1. Save a GitLab base URL and personal/project access token.
2. Add a project using either a numeric GitLab project ID or a path like `group/repo`.
3. Add a workflow with variables that your `.gitlab-ci.yml` understands.
4. Optionally enable artifact persistence for the workflow.
5. Run the workflow from the selected project.

For `https://labs.gauntletai.com/kevinferretti/shipshape`:

```text
GitLab base URL: https://labs.gauntletai.com
Project ID/path: kevinferretti/shipshape
Repo URL: https://labs.gauntletai.com/kevinferretti/shipshape
```

Example variables for a GitLab job that dispatches Codex work:

```text
WORKFLOW=codex_skill
CODEX_SKILL=review
SKILL_TARGET_URL=https://labs.gauntletai.com/kevinferretti/shipshape
SKILL_OUTPUT_ARTIFACT=skill-output.md
```

Artifact persistence expects the pipeline to upload the skill output as a job artifact. Configure the workflow persistence fields to match the real CI job:

```text
Artifact job: codex_skill
Artifact path: skill-output.md
Repository path: skill-runs/shipshape.md
Commit message: Persist Codex skill output
```

When a refresh sees the pipeline in `success`, the app lists the exact pipeline jobs, downloads `Artifact path` from `Artifact job`, and creates or updates `Repository path` on the run ref. Missing jobs, missing artifacts, failed artifact jobs, and GitLab commit failures are recorded as output persistence failures.

The target repository must have a CI job that writes the artifact path. A typical contract is:

```yaml
codex_skill:
  rules:
    - if: '$WORKFLOW == "codex_skill"'
  script:
    - ./scripts/run-codex-skill --skill "$CODEX_SKILL" --target "$SKILL_TARGET_URL" --output "$SKILL_OUTPUT_ARTIFACT"
  artifacts:
    paths:
      - "$SKILL_OUTPUT_ARTIFACT"
```

Local configuration, including the token, is written to `.devflow/config.json`, which is ignored by git.

## Verify

```bash
npm run test
npm run build
```

## Deploy to OVH VPS

The production deployment uses Docker Compose with Caddy in front of the
Express app. Caddy terminates HTTPS for `workflow.kevinferretti.com` and
requires HTTP basic auth before any request reaches the app. The app container
is not published directly, and `.devflow/config.json` is persisted in a Docker
volume.

1. Point DNS at the VPS:

```text
workflow.kevinferretti.com A 15.204.255.0
```

2. Install Docker and the Compose plugin on the VPS, then allow only SSH, HTTP,
   and HTTPS through the VPS firewall. On the current OVH host, SSH is configured
   as `ai-workflow-ovh` and the existing public Caddy container owns ports 80
   and 443.

3. Generate a Caddy password hash on a machine with Docker:

```bash
docker run --rm -it caddy:2-alpine caddy hash-password
```

4. On the VPS, create `/home/ubuntu/ai-workflow-hub/.env` from
   `.env.deploy.example` and set:

```text
BASIC_AUTH_USER=kevin
BASIC_AUTH_HASH=<output from caddy hash-password>
```

5. From this repo on Windows, deploy the current working tree:

```powershell
.\scripts\deploy-vps.ps1
```

6. Check the deployment:

```bash
ssh ai-workflow-ovh "cd /home/ubuntu/ai-workflow-hub/current && docker compose --project-name ai-workflow-hub -f deploy/compose.ovh.yaml ps"
```

The first deploy intentionally stops after creating
`/home/ubuntu/ai-workflow-hub/.env` if the file does not already exist. Fill in
the basic-auth values, rerun the script, and Caddy will request the TLS
certificate once DNS resolves.

See `docs/deployment.md` for the current production topology, GitHub Actions
CI/CD setup, required repository secrets, and verification commands.
