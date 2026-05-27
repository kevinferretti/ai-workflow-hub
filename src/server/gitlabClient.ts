import type { WorkflowRunStatus, WorkflowVariable } from '../shared/types.ts'

export type GitLabPipeline = {
  id: number
  iid?: number
  status?: WorkflowRunStatus
  web_url?: string
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
    return this.request<GitLabPipeline>(
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

  async getPipeline(
    projectId: string,
    pipelineId: number,
  ): Promise<GitLabPipeline> {
    return this.request<GitLabPipeline>(
      `/projects/${encodeURIComponent(projectId)}/pipelines/${pipelineId}`,
      {
        method: 'GET',
      },
    )
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
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

    return response.json() as Promise<T>
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
