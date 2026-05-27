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
})
