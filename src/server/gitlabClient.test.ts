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
