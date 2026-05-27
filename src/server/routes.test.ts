import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiApp } from './app.ts'
import { ConfigStore } from './configStore.ts'
import type { GitLabClientLike } from './routes.ts'

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'workflow-hub-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('workflow API', () => {
  it('stores GitLab settings without returning the token', async () => {
    const app = createApiApp({
      store: new ConfigStore(join(tempDir, 'config.json')),
    })

    const response = await request(app).put('/api/settings/gitlab').send({
      baseUrl: 'https://gitlab.example/',
      token: 'secret-token',
    })

    expect(response.status).toBe(200)
    expect(response.body.gitlab).toEqual({
      baseUrl: 'https://gitlab.example',
      tokenConfigured: true,
    })
    expect(JSON.stringify(response.body)).not.toContain('secret-token')
  })

  it('triggers a GitLab pipeline and records the run', async () => {
    const store = new ConfigStore(join(tempDir, 'config.json'))
    const createPipeline = vi.fn(async () => ({
      id: 123,
      iid: 4,
      status: 'pending' as const,
      web_url: 'https://gitlab.example/group/repo/-/pipelines/123',
    }))
    const gitlabClient: GitLabClientLike = {
      createPipeline,
      getPipeline: vi.fn(),
      listPipelineJobs: vi.fn(),
      downloadJobArtifactFile: vi.fn(),
      upsertRepositoryFile: vi.fn(),
      ensureRepositoryBranch: vi.fn(),
      findOrCreateMergeRequest: vi.fn(),
    }
    const app = createApiApp({
      store,
      gitlabClientFactory: () => gitlabClient,
    })

    await request(app).put('/api/settings/gitlab').send({
      baseUrl: 'https://gitlab.example',
      token: 'secret-token',
    })
    const projectResponse = await request(app).post('/api/projects').send({
      name: 'Shipshape',
      gitlabProjectId: 'team/shipshape',
      defaultRef: 'main',
      repositoryUrl: '',
      description: '',
    })
    const workflowResponse = await request(app).post('/api/workflows').send({
      name: 'Run Codex Skill',
      description: '',
      defaultRef: '',
      variables: [{ key: 'CODEX_SKILL', value: 'review' }],
    })

    const response = await request(app).post('/api/runs').send({
      projectId: projectResponse.body.projects[0].id,
      workflowId: workflowResponse.body.workflows[0].id,
    })

    expect(response.status).toBe(201)
    expect(createPipeline).toHaveBeenCalledWith('team/shipshape', 'main', [
      { key: 'CODEX_SKILL', value: 'review' },
    ])
    expect(response.body.runs[0]).toMatchObject({
      projectName: 'Shipshape',
      workflowName: 'Run Codex Skill',
      status: 'pending',
      gitlabPipelineId: 123,
    })
  })

  it('persists a successful skill artifact back to the repository on refresh', async () => {
    const store = new ConfigStore(join(tempDir, 'config.json'))
    const createPipeline = vi.fn(async () => ({
      id: 123,
      iid: 4,
      status: 'pending' as const,
      web_url: 'https://gitlab.example/group/repo/-/pipelines/123',
    }))
    const getPipeline = vi.fn(async () => ({
      id: 123,
      iid: 4,
      status: 'success' as const,
      web_url: 'https://gitlab.example/group/repo/-/pipelines/123',
    }))
    const listPipelineJobs = vi.fn(async () => [
      { id: 8, name: 'codex_skill', status: 'success' as const },
    ])
    const downloadJobArtifactFile = vi.fn(async () => '# Skill output\n')
    const upsertRepositoryFile = vi.fn(async () => ({
      filePath: 'skill-runs/shipshape.md',
      branch: 'main',
      action: 'created' as const,
    }))
    const ensureRepositoryBranch = vi.fn()
    const findOrCreateMergeRequest = vi.fn()
    const gitlabClient: GitLabClientLike = {
      createPipeline,
      getPipeline,
      listPipelineJobs,
      downloadJobArtifactFile,
      upsertRepositoryFile,
      ensureRepositoryBranch,
      findOrCreateMergeRequest,
    }
    const app = createApiApp({
      store,
      gitlabClientFactory: () => gitlabClient,
    })

    await request(app).put('/api/settings/gitlab').send({
      baseUrl: 'https://gitlab.example',
      token: 'secret-token',
    })
    const projectResponse = await request(app).post('/api/projects').send({
      name: 'Shipshape',
      gitlabProjectId: 'team/shipshape',
      defaultRef: 'main',
      repositoryUrl: 'https://gitlab.example/team/shipshape',
      description: '',
    })
    const workflowResponse = await request(app).post('/api/workflows').send({
      name: 'Run Codex Skill',
      description: '',
      defaultRef: '',
      variables: [{ key: 'CODEX_SKILL', value: 'review' }],
      outputPersistence: {
        jobName: 'codex_skill',
        artifactPath: 'skill-output.md',
        repositoryPath: 'skill-runs/shipshape.md',
        commitMessage: 'Persist Codex skill output',
      },
    })
    const runResponse = await request(app).post('/api/runs').send({
      projectId: projectResponse.body.projects[0].id,
      workflowId: workflowResponse.body.workflows[0].id,
      variables: [
        {
          key: 'SKILL_TARGET_URL',
          value: 'https://gitlab.example/team/shipshape',
        },
      ],
    })

    const response = await request(app).post(
      `/api/runs/${runResponse.body.runs[0].id}/refresh`,
    )

    expect(response.status).toBe(200)
    expect(listPipelineJobs).toHaveBeenCalledWith('team/shipshape', 123)
    expect(downloadJobArtifactFile).toHaveBeenCalledWith(
      'team/shipshape',
      8,
      'skill-output.md',
    )
    expect(upsertRepositoryFile).toHaveBeenCalledWith(
      'team/shipshape',
      'main',
      'skill-runs/shipshape.md',
      '# Skill output\n',
      'Persist Codex skill output',
    )
    expect(ensureRepositoryBranch).not.toHaveBeenCalled()
    expect(findOrCreateMergeRequest).not.toHaveBeenCalled()
    expect(response.body.runs[0].outputPersistence).toMatchObject({
      status: 'persisted',
      action: 'created',
      jobId: 8,
      repositoryPath: 'skill-runs/shipshape.md',
    })
  })

  it('persists a successful skill artifact to a branch and opens a merge request', async () => {
    const store = new ConfigStore(join(tempDir, 'config.json'))
    const createPipeline = vi.fn(async () => ({
      id: 123,
      iid: 4,
      status: 'pending' as const,
      web_url: 'https://gitlab.example/group/repo/-/pipelines/123',
    }))
    const getPipeline = vi.fn(async () => ({
      id: 123,
      iid: 4,
      status: 'success' as const,
      web_url: 'https://gitlab.example/group/repo/-/pipelines/123',
    }))
    const listPipelineJobs = vi.fn(async () => [
      { id: 8, name: 'codex_skill', status: 'success' as const },
    ])
    const downloadJobArtifactFile = vi.fn(async () => '# Skill output\n')
    const ensureRepositoryBranch = vi.fn()
    const upsertRepositoryFile = vi.fn(async () => ({
      filePath: 'gaps/GAPS-PRD.md',
      branch: 'codex/prd-gaps-output',
      action: 'updated' as const,
    }))
    const findOrCreateMergeRequest = vi.fn(async () => ({
      iid: 13,
      web_url: 'https://gitlab.example/team/shipshape/-/merge_requests/13',
      source_branch: 'codex/prd-gaps-output',
      target_branch: 'main',
    }))
    const gitlabClient: GitLabClientLike = {
      createPipeline,
      getPipeline,
      listPipelineJobs,
      downloadJobArtifactFile,
      upsertRepositoryFile,
      ensureRepositoryBranch,
      findOrCreateMergeRequest,
    }
    const app = createApiApp({
      store,
      gitlabClientFactory: () => gitlabClient,
    })

    await request(app).put('/api/settings/gitlab').send({
      baseUrl: 'https://gitlab.example',
      token: 'secret-token',
    })
    const projectResponse = await request(app).post('/api/projects').send({
      name: 'Shipshape',
      gitlabProjectId: 'team/shipshape',
      defaultRef: 'main',
      repositoryUrl: 'https://gitlab.example/team/shipshape',
      description: '',
    })
    const workflowResponse = await request(app).post('/api/workflows').send({
      name: 'PRD Gap Analysis',
      description: '',
      defaultRef: '',
      variables: [{ key: 'CODEX_SKILL', value: 'PRD-gaps' }],
      outputPersistence: {
        jobName: 'codex_skill',
        artifactPath: 'gaps/GAPS-PRD.md',
        repositoryPath: 'gaps/GAPS-PRD.md',
        commitMessage: 'Persist PRD gap analysis',
        branchName: 'codex/prd-gaps-output',
        mergeRequestTargetBranch: 'main',
        mergeRequestTitle: 'Persist PRD gap analysis',
      },
    })
    const runResponse = await request(app).post('/api/runs').send({
      projectId: projectResponse.body.projects[0].id,
      workflowId: workflowResponse.body.workflows[0].id,
    })

    const response = await request(app).post(
      `/api/runs/${runResponse.body.runs[0].id}/refresh`,
    )

    expect(response.status).toBe(200)
    expect(ensureRepositoryBranch).toHaveBeenCalledWith(
      'team/shipshape',
      'codex/prd-gaps-output',
      'main',
    )
    expect(upsertRepositoryFile).toHaveBeenCalledWith(
      'team/shipshape',
      'codex/prd-gaps-output',
      'gaps/GAPS-PRD.md',
      '# Skill output\n',
      'Persist PRD gap analysis',
    )
    expect(findOrCreateMergeRequest).toHaveBeenCalledWith(
      'team/shipshape',
      'codex/prd-gaps-output',
      'main',
      'Persist PRD gap analysis',
    )
    expect(response.body.runs[0].outputPersistence).toMatchObject({
      status: 'persisted',
      action: 'updated',
      branch: 'codex/prd-gaps-output',
      mergeRequestIid: 13,
      mergeRequestUrl: 'https://gitlab.example/team/shipshape/-/merge_requests/13',
    })
  })
})
