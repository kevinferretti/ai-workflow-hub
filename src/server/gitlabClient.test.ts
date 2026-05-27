import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitLabApiError, GitLabClient, normalizeBaseUrl } from './gitlabClient.ts'

describe('GitLabClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates pipelines with ref and variables', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: 42,
        iid: 7,
        status: 'pending',
        web_url: 'https://gitlab.example/group/repo/-/pipelines/42',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = new GitLabClient('https://gitlab.example/', 'secret-token')
    const pipeline = await client.createPipeline('group/repo', 'main', [
      { key: 'WORKFLOW', value: 'codex_skill' },
      { key: 'CODEX_SKILL', value: 'review' },
    ])

    expect(pipeline.id).toBe(42)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example/api/v4/projects/group%2Frepo/pipeline',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ref: 'main',
          variables: [
            { key: 'WORKFLOW', value: 'codex_skill' },
            { key: 'CODEX_SKILL', value: 'review' },
          ],
        }),
      }),
    )
  })

  it('normalizes base URLs', () => {
    expect(normalizeBaseUrl('https://gitlab.example///')).toBe('https://gitlab.example')
    expect(normalizeBaseUrl('')).toBe('https://gitlab.com')
  })

  it('lists pipeline jobs across GitLab pagination', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([{ id: 8, name: 'codex_skill', status: 'success' }], {
          headers: { 'x-next-page': '2' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json([{ id: 7, name: 'test', status: 'success' }], {
          headers: { 'x-next-page': '' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const client = new GitLabClient('https://gitlab.example', 'secret-token')
    const jobs = await client.listPipelineJobs('group/repo', 42)

    expect(jobs.map((job) => job.name)).toEqual(['codex_skill', 'test'])
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.example/api/v4/projects/group%2Frepo/pipelines/42/jobs?per_page=100&page=1',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://gitlab.example/api/v4/projects/group%2Frepo/pipelines/42/jobs?per_page=100&page=2',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('downloads a single job artifact file', async () => {
    const fetchMock = vi.fn(async () => new Response('# Skill output\n'))
    vi.stubGlobal('fetch', fetchMock)

    const client = new GitLabClient('https://gitlab.example', 'secret-token')
    const content = await client.downloadJobArtifactFile(
      'group/repo',
      8,
      'reports/skill output.md',
    )

    expect(content).toBe('# Skill output\n')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example/api/v4/projects/group%2Frepo/jobs/8/artifacts/reports/skill%20output.md',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('creates repository files when persisted output does not exist', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: '404 File Not Found' }, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json(
          { file_path: 'skill-runs/shipshape.md', branch: 'main' },
          { status: 201 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const client = new GitLabClient('https://gitlab.example', 'secret-token')
    const result = await client.upsertRepositoryFile(
      'group/repo',
      'main',
      'skill-runs/shipshape.md',
      '# Skill output\n',
      'Persist Codex skill output',
    )

    expect(result).toEqual({
      filePath: 'skill-runs/shipshape.md',
      branch: 'main',
      action: 'created',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.example/api/v4/projects/group%2Frepo/repository/files/skill-runs%2Fshipshape.md/raw?ref=main',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://gitlab.example/api/v4/projects/group%2Frepo/repository/files/skill-runs%2Fshipshape.md',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          branch: 'main',
          content: '# Skill output\n',
          commit_message: 'Persist Codex skill output',
        }),
      }),
    )
  })

  it('creates repository branches from a base ref when missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: '404 Branch Not Found' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ name: 'codex/prd-gaps-output' }, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new GitLabClient('https://gitlab.example', 'secret-token')
    await client.ensureRepositoryBranch(
      'group/repo',
      'codex/prd-gaps-output',
      'main',
    )

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.example/api/v4/projects/group%2Frepo/repository/branches/codex%2Fprd-gaps-output',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://gitlab.example/api/v4/projects/group%2Frepo/repository/branches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          branch: 'codex/prd-gaps-output',
          ref: 'main',
        }),
      }),
    )
  })

  it('reuses an open merge request for a persistence branch', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([
        {
          iid: 13,
          web_url: 'https://gitlab.example/group/repo/-/merge_requests/13',
          source_branch: 'codex/prd-gaps-output',
          target_branch: 'main',
        },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = new GitLabClient('https://gitlab.example', 'secret-token')
    const mergeRequest = await client.findOrCreateMergeRequest(
      'group/repo',
      'codex/prd-gaps-output',
      'main',
      'Persist PRD gap analysis',
    )

    expect(mergeRequest.iid).toBe(13)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example/api/v4/projects/group%2Frepo/merge_requests?state=opened&source_branch=codex%2Fprd-gaps-output&target_branch=main',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('throws a sanitized API error when GitLab rejects a request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ message: '401 Unauthorized' }, { status: 401 }),
      ),
    )

    const client = new GitLabClient('https://gitlab.example', 'bad-token')
    await expect(client.getPipeline('group/repo', 42)).rejects.toThrow(
      new GitLabApiError(401, '401 Unauthorized'),
    )
  })
})
