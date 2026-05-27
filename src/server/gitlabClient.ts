import type { WorkflowRunStatus, WorkflowVariable } from '../shared/types.ts'

export type GitLabPipeline = {
  id: number
  iid?: number
  status?: WorkflowRunStatus
  web_url?: string
}

export type GitLabPipelineJob = {
  id: number
  name: string
  status?: WorkflowRunStatus
  web_url?: string
}

export type RepositoryFileUpsertResult = {
  filePath: string
  branch: string
  action: 'created' | 'updated' | 'unchanged'
}

export class GitLabApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitLabApiError'
    this.status = status
  }
}

export class GitLabClient {
  private readonly baseUrl: string
  private readonly token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.token = token
  }

  async createPipeline(
    projectId: string,
    ref: string,
    variables: WorkflowVariable[],
  ): Promise<GitLabPipeline> {
    return this.requestJson<GitLabPipeline>(
      `/projects/${encodeURIComponent(projectId)}/pipeline`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref,
          variables: variables.map((variable) => ({
            key: variable.key,
            value: variable.value,
          })),
        }),
      },
    )
  }

  async listPipelineJobs(
    projectId: string,
    pipelineId: number,
  ): Promise<GitLabPipelineJob[]> {
    const jobs: GitLabPipelineJob[] = []
    let page = 1

    while (page > 0) {
      const response = await this.request(
        `/projects/${encodeURIComponent(projectId)}/pipelines/${pipelineId}/jobs?per_page=100&page=${page}`,
        {
          method: 'GET',
        },
      )
      jobs.push(...((await response.json()) as GitLabPipelineJob[]))

      const nextPage = Number(response.headers.get('x-next-page'))
      page = Number.isFinite(nextPage) ? nextPage : 0
    }

    return jobs
  }

  async downloadJobArtifactFile(
    projectId: string,
    jobId: number,
    artifactPath: string,
  ): Promise<string> {
    return this.requestText(
      `/projects/${encodeURIComponent(projectId)}/jobs/${jobId}/artifacts/${encodeArtifactPath(artifactPath)}`,
      {
        method: 'GET',
      },
    )
  }

  async upsertRepositoryFile(
    projectId: string,
    branch: string,
    filePath: string,
    content: string,
    commitMessage: string,
  ): Promise<RepositoryFileUpsertResult> {
    const normalizedPath = normalizeRepositoryPath(filePath)
    const encodedPath = encodeURIComponent(normalizedPath)
    const existingContent = await this.getRepositoryFileContent(
      projectId,
      branch,
      encodedPath,
    )

    if (existingContent === content) {
      return {
        filePath: normalizedPath,
        branch,
        action: 'unchanged',
      }
    }

    const action = existingContent === undefined ? 'created' : 'updated'
    const response = await this.requestJson<{ branch?: string; file_path?: string }>(
      `/projects/${encodeURIComponent(projectId)}/repository/files/${encodedPath}`,
      {
        method: action === 'created' ? 'POST' : 'PUT',
        body: JSON.stringify({
          branch,
          content,
          commit_message: commitMessage,
        }),
      },
    )

    return {
      filePath: response.file_path ?? normalizedPath,
      branch: response.branch ?? branch,
      action,
    }
  }

  async getPipeline(
    projectId: string,
    pipelineId: number,
  ): Promise<GitLabPipeline> {
    return this.requestJson<GitLabPipeline>(
      `/projects/${encodeURIComponent(projectId)}/pipelines/${pipelineId}`,
      {
        method: 'GET',
      },
    )
  }

  private async getRepositoryFileContent(
    projectId: string,
    branch: string,
    encodedPath: string,
  ): Promise<string | undefined> {
    try {
      return await this.requestText(
        `/projects/${encodeURIComponent(projectId)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(branch)}`,
        {
          method: 'GET',
        },
      )
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) {
        return undefined
      }
      throw error
    }
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.request(path, init)
    return response.json() as Promise<T>
  }

  private async requestText(path: string, init: RequestInit): Promise<string> {
    const response = await this.request(path, init)
    return response.text()
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    if (!this.token.trim()) {
      throw new GitLabApiError(401, 'GitLab token is not configured.')
    }

    const response = await fetch(`${this.baseUrl}/api/v4${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': this.token,
        ...init.headers,
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new GitLabApiError(
        response.status,
        gitlabErrorMessage(response.status, body),
      )
    }

    return response
  }
}

export function normalizeBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim() || 'https://gitlab.com'
  return trimmed.replace(/\/+$/, '')
}

function gitlabErrorMessage(status: number, body: string): string {
  if (!body.trim()) {
    return `GitLab API request failed with status ${status}.`
  }

  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown }
    const message = parsed.message ?? parsed.error
    if (typeof message === 'string') {
      return message
    }
    if (message && typeof message === 'object') {
      return JSON.stringify(message)
    }
  } catch {
    return body
  }

  return body
}

function encodeArtifactPath(rawPath: string): string {
  return normalizeRepositoryPath(rawPath).split('/').map(encodeURIComponent).join('/')
}

function normalizeRepositoryPath(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '')

  if (
    normalized.length === 0 ||
    normalized.includes('//') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new GitLabApiError(400, 'Repository file path is invalid.')
  }

  return normalized
}
