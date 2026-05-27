# AI Workflow Hub

Local control plane for triggering GitLab-backed AI development workflows per project.

The first version deliberately uses GitLab pipelines as the execution layer. The app stores project and workflow definitions locally, calls the GitLab Pipeline API when you click **Run**, and records the resulting pipeline status and URL. It does not ship canned demo runs.

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Configure

1. Save a GitLab base URL and personal/project access token.
2. Add a project using either a numeric GitLab project ID or a path like `group/repo`.
3. Add a workflow with variables that your `.gitlab-ci.yml` understands.
4. Run the workflow from the selected project.

Example variables for a GitLab job that dispatches Codex work:

```text
WORKFLOW=codex_skill
CODEX_SKILL=review
```

Local configuration, including the token, is written to `.devflow/config.json`, which is ignored by git.

## Verify

```bash
npm run test
npm run build
```
