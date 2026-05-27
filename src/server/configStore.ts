import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type {
  AppState,
  ProjectConfig,
  WorkflowDefinition,
  WorkflowRun,
} from '../shared/types.ts'

export type PersistedGitLabSettings = {
  baseUrl: string
  token: string
}

export type PersistedAppConfig = {
  gitlab: PersistedGitLabSettings
  projects: ProjectConfig[]
  workflows: WorkflowDefinition[]
  runs: WorkflowRun[]
}

const variableSchema = z.object({
  key: z.string(),
  value: z.string(),
})

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  gitlabProjectId: z.string(),
  defaultRef: z.string(),
  repositoryUrl: z.string(),
  description: z.string(),
})

const workflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  defaultRef: z.string(),
  variables: z.array(variableSchema),
  outputPersistence: z
    .object({
      jobName: z.string(),
      artifactPath: z.string(),
      repositoryPath: z.string(),
      commitMessage: z.string(),
      branchName: z.string().optional(),
      mergeRequestTargetBranch: z.string().optional(),
      mergeRequestTitle: z.string().optional(),
    })
    .optional(),
})

const runSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  ref: z.string(),
  status: z.string(),
  variables: z.array(variableSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  gitlabPipelineId: z.number().optional(),
  gitlabPipelineIid: z.number().optional(),
  webUrl: z.string().optional(),
  error: z.string().optional(),
  outputPersistence: z
    .object({
      jobName: z.string(),
      artifactPath: z.string(),
      repositoryPath: z.string(),
      commitMessage: z.string(),
      branchName: z.string().optional(),
      mergeRequestTargetBranch: z.string().optional(),
      mergeRequestTitle: z.string().optional(),
      status: z.enum(['pending', 'persisted', 'unchanged', 'failed']),
      jobId: z.number().optional(),
      action: z.enum(['created', 'updated', 'unchanged']).optional(),
      branch: z.string().optional(),
      mergeRequestIid: z.number().optional(),
      mergeRequestUrl: z.string().optional(),
      updatedAt: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
})

const configSchema = z.object({
  gitlab: z
    .object({
      baseUrl: z.string(),
      token: z.string(),
    })
    .default({ baseUrl: 'https://gitlab.com', token: '' }),
  projects: z.array(projectSchema).default([]),
  workflows: z.array(workflowSchema).default([]),
  runs: z.array(runSchema).default([]),
})

const emptyConfig: PersistedAppConfig = {
  gitlab: {
    baseUrl: 'https://gitlab.com',
    token: '',
  },
  projects: [],
  workflows: [],
  runs: [],
}

export class ConfigStore {
  private readonly filePath: string

  constructor(filePath = resolve(process.cwd(), '.devflow', 'config.json')) {
    this.filePath = filePath
  }

  async read(): Promise<PersistedAppConfig> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = configSchema.parse(JSON.parse(raw))
      return {
        gitlab: {
          baseUrl: parsed.gitlab.baseUrl || emptyConfig.gitlab.baseUrl,
          token: parsed.gitlab.token || '',
        },
        projects: parsed.projects,
        workflows: parsed.workflows,
        runs: parsed.runs as WorkflowRun[],
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return structuredClone(emptyConfig)
      }

      throw error
    }
  }

  async write(config: PersistedAppConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(tempPath, this.filePath)
  }

  async update(
    mutator: (config: PersistedAppConfig) => PersistedAppConfig,
  ): Promise<PersistedAppConfig> {
    const current = await this.read()
    const next = mutator(current)
    await this.write(next)
    return next
  }
}

export function redactConfig(config: PersistedAppConfig): AppState {
  return {
    gitlab: {
      baseUrl: config.gitlab.baseUrl,
      tokenConfigured: config.gitlab.token.trim().length > 0,
    },
    projects: config.projects,
    workflows: config.workflows,
    runs: config.runs,
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
