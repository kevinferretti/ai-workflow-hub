import { Router, type ErrorRequestHandler } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ConfigStore, redactConfig } from './configStore.ts'
import { GitLabApiError, GitLabClient, normalizeBaseUrl } from './gitlabClient.ts'
import type {
  ProjectConfig,
  SaveGitLabSettingsRequest,
  SaveProjectRequest,
  SaveWorkflowRequest,
  TriggerWorkflowRequest,
  WorkflowDefinition,
  WorkflowOutputPersistence,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunOutputPersistence,
  WorkflowVariable,
} from '../shared/types.ts'

export type GitLabClientLike = Pick<
  GitLabClient,
  | 'createPipeline'
  | 'getPipeline'
  | 'listPipelineJobs'
  | 'downloadJobArtifactFile'
  | 'upsertRepositoryFile'
>

export type CreateApiRouterOptions = {
  store?: ConfigStore
  gitlabClientFactory?: (baseUrl: string, token: string) => GitLabClientLike
}

const saveGitLabSettingsSchema = z.object({
  baseUrl: z.string().trim().min(1),
  token: z.string().optional(),
})

const saveProjectSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1),
  gitlabProjectId: z.string().trim().min(1),
  defaultRef: z.string().trim().min(1),
  repositoryUrl: z.string().trim().optional().default(''),
  description: z.string().trim().optional().default(''),
})

const variableSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string(),
})

const saveWorkflowSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1),
  description: z.string().trim().optional().default(''),
  defaultRef: z.string().trim().optional().default(''),
  variables: z.array(variableSchema).default([]),
  outputPersistence: z
    .object({
      jobName: z.string().trim().min(1),
      artifactPath: z.string().trim().min(1),
      repositoryPath: z.string().trim().min(1),
      commitMessage: z.string().trim().min(1),
    })
    .optional(),
})

const triggerWorkflowSchema = z.object({
  projectId: z.string().trim().min(1),
  workflowId: z.string().trim().min(1),
  ref: z.string().trim().optional(),
  variables: z.array(variableSchema).optional(),
})

export function createApiRouter(options: CreateApiRouterOptions = {}): Router {
  const router = Router()
  const store = options.store ?? new ConfigStore()
  const createGitLabClient =
    options.gitlabClientFactory ??
    ((baseUrl: string, token: string) => new GitLabClient(baseUrl, token))

  router.get('/state', async (_request, response, next) => {
    try {
      response.json(redactConfig(await store.read()))
    } catch (error) {
      next(error)
    }
  })

  router.put('/settings/gitlab', async (request, response, next) => {
    try {
      const payload = parseBody<SaveGitLabSettingsRequest>(
        saveGitLabSettingsSchema,
        request.body,
      )
      const updated = await store.update((config) => ({
        ...config,
        gitlab: {
          baseUrl: normalizeBaseUrl(payload.baseUrl),
          token:
            payload.token === undefined
              ? config.gitlab.token
              : payload.token.trim(),
        },
      }))
      response.json(redactConfig(updated))
    } catch (error) {
      next(error)
    }
  })

  router.post('/projects', async (request, response, next) => {
    try {
      const payload = parseBody<SaveProjectRequest>(
        saveProjectSchema,
        request.body,
      )
      const project = toProjectConfig(payload)
      const updated = await store.update((config) => ({
        ...config,
        projects: [...config.projects, project],
      }))
      response.status(201).json(redactConfig(updated))
    } catch (error) {
      next(error)
    }
  })

  router.patch('/projects/:id', async (request, response, next) => {
    try {
      const payload = parseBody<SaveProjectRequest>(
        saveProjectSchema,
        request.body,
      )
      const updated = await store.update((config) => ({
        ...config,
        projects: replaceById(
          config.projects,
          request.params.id,
          toProjectConfig({ ...payload, id: request.params.id }),
        ),
      }))
      response.json(redactConfig(updated))
    } catch (error) {
      next(error)
    }
  })

  router.delete('/projects/:id', async (request, response, next) => {
    try {
      const updated = await store.update((config) => ({
        ...config,
        projects: config.projects.filter(
          (project) => project.id !== request.params.id,
        ),
      }))
      response.json(redactConfig(updated))
    } catch (error) {
      next(error)
    }
  })

  router.post('/workflows', async (request, response, next) => {
    try {
      const payload = parseBody<SaveWorkflowRequest>(
        saveWorkflowSchema,
        request.body,
      )
      const workflow = toWorkflowDefinition(payload)
      const updated = await store.update((config) => ({
        ...config,
        workflows: [...config.workflows, workflow],
      }))
      response.status(201).json(redactConfig(updated))
    } catch (error) {
      next(error)
    }
  })

  router.patch('/workflows/:id', async (request, response, next) => {
    try {
      const payload = parseBody<SaveWorkflowRequest>(
        saveWorkflowSchema,
        request.body,
      )
      const updated = await store.update((config) => ({
        ...config,
        workflows: replaceById(
          config.workflows,
          request.params.id,
          toWorkflowDefinition({ ...payload, id: request.params.id }),
        ),
      }))
      response.json(redactConfig(updated))
    } catch (error) {
      next(error)
    }
  })

  router.delete('/workflows/:id', async (request, response, next) => {
    try {
      const updated = await store.update((config) => ({
        ...config,
        workflows: config.workflows.filter(
          (workflow) => workflow.id !== request.params.id,
        ),
      }))
      response.json(redactConfig(updated))
    } catch (error) {
      next(error)
    }
  })

  router.post('/runs', async (request, response, next) => {
    try {
      const payload = parseBody<TriggerWorkflowRequest>(
        triggerWorkflowSchema,
        request.body,
      )
      const config = await store.read()
      const project = config.projects.find((item) => item.id === payload.projectId)
      const workflow = config.workflows.find(
        (item) => item.id === payload.workflowId,
      )

      if (!project || !workflow) {
        response.status(404).json({ error: 'Project or workflow was not found.' })
        return
      }

      const ref = payload.ref || workflow.defaultRef || project.defaultRef
      const variables = mergeVariables(workflow.variables, payload.variables ?? [])
      const createdAt = new Date().toISOString()
      const runBase = {
        id: randomUUID(),
        projectId: project.id,
        projectName: project.name,
        workflowId: workflow.id,
        workflowName: workflow.name,
        ref,
        variables,
        createdAt,
        updatedAt: createdAt,
      }

      try {
        const client = createGitLabClient(config.gitlab.baseUrl, config.gitlab.token)
        const pipeline = await client.createPipeline(
          project.gitlabProjectId,
          ref,
          variables,
        )
        const run: WorkflowRun = {
          ...runBase,
          status: normalizeStatus(pipeline.status),
          gitlabPipelineId: pipeline.id,
          gitlabPipelineIid: pipeline.iid,
          webUrl: pipeline.web_url,
          outputPersistence: toRunOutputPersistence(workflow.outputPersistence),
        }
        const updated = await store.update((current) => ({
          ...current,
          runs: [run, ...current.runs],
        }))
        response.status(201).json(redactConfig(updated))
      } catch (error) {
        const run: WorkflowRun = {
          ...runBase,
          status: 'failed_to_trigger',
          error: errorMessage(error),
        }
        const updated = await store.update((current) => ({
          ...current,
          runs: [run, ...current.runs],
        }))
        response.status(error instanceof GitLabApiError ? error.status : 502).json({
          error: run.error,
          state: redactConfig(updated),
        })
      }
    } catch (error) {
      next(error)
    }
  })

  router.post('/runs/:id/refresh', async (request, response, next) => {
    try {
      const config = await store.read()
      const run = config.runs.find((item) => item.id === request.params.id)

      if (!run) {
        response.status(404).json({ error: 'Run was not found.' })
        return
      }

      const project = config.projects.find((item) => item.id === run.projectId)
      if (!project || run.gitlabPipelineId === undefined) {
        response.json(redactConfig(config))
        return
      }

      const client = createGitLabClient(config.gitlab.baseUrl, config.gitlab.token)
      const pipeline = await client.getPipeline(
        project.gitlabProjectId,
        run.gitlabPipelineId,
      )
      const refreshedRun: WorkflowRun = {
        ...run,
        status: normalizeStatus(pipeline.status),
        webUrl: pipeline.web_url ?? run.webUrl,
        updatedAt: new Date().toISOString(),
      }
      let updated = await store.update((current) => ({
        ...current,
        runs: current.runs.map((item) =>
          item.id === run.id ? { ...item, ...refreshedRun } : item,
        ),
      }))

      if (shouldPersistRunOutput(refreshedRun)) {
        try {
          const outputPersistence = await persistRunOutput(
            client,
            project.gitlabProjectId,
            refreshedRun,
          )
          updated = await store.update((current) => ({
            ...current,
            runs: current.runs.map((item) =>
              item.id === run.id
                ? {
                    ...item,
                    outputPersistence,
                    updatedAt: new Date().toISOString(),
                  }
                : item,
            ),
          }))
        } catch (error) {
          const outputPersistence = toFailedRunOutputPersistence(
            refreshedRun.outputPersistence,
            errorMessage(error),
          )
          updated = await store.update((current) => ({
            ...current,
            runs: current.runs.map((item) =>
              item.id === run.id
                ? {
                    ...item,
                    outputPersistence,
                    updatedAt: new Date().toISOString(),
                  }
                : item,
            ),
          }))
          response
            .status(error instanceof GitLabApiError ? error.status : 502)
            .json({ error: errorMessage(error), state: redactConfig(updated) })
          return
        }
      }

      response.json(redactConfig(updated))
    } catch (error) {
      next(error)
    }
  })

  const errorHandler: ErrorRequestHandler = (error, request, response, next) => {
    void request
    void next

    if (error instanceof z.ZodError) {
      response
        .status(400)
        .json({ error: error.issues[0]?.message ?? 'Invalid request.' })
      return
    }

    if (error instanceof GitLabApiError) {
      response.status(error.status).json({ error: error.message })
      return
    }

    response.status(500).json({ error: errorMessage(error) })
  }

  router.use(errorHandler)

  return router
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body)
}

function toProjectConfig(payload: SaveProjectRequest): ProjectConfig {
  return {
    id: payload.id ?? randomUUID(),
    name: payload.name,
    gitlabProjectId: payload.gitlabProjectId,
    defaultRef: payload.defaultRef,
    repositoryUrl: payload.repositoryUrl,
    description: payload.description,
  }
}

function toWorkflowDefinition(payload: SaveWorkflowRequest): WorkflowDefinition {
  return {
    id: payload.id ?? randomUUID(),
    name: payload.name,
    description: payload.description,
    defaultRef: payload.defaultRef,
    variables: payload.variables,
    outputPersistence: payload.outputPersistence,
  }
}

function replaceById<T extends { id: string }>(items: T[], id: string, next: T): T[] {
  return items.map((item) => (item.id === id ? next : item))
}

function mergeVariables(
  baseVariables: WorkflowVariable[],
  overrideVariables: WorkflowVariable[],
): WorkflowVariable[] {
  const variablesByKey = new Map<string, WorkflowVariable>()
  for (const variable of baseVariables) {
    variablesByKey.set(variable.key, variable)
  }
  for (const variable of overrideVariables) {
    variablesByKey.set(variable.key, variable)
  }
  return Array.from(variablesByKey.values())
}

function normalizeStatus(status: WorkflowRunStatus | undefined): WorkflowRunStatus {
  return status ?? 'unknown'
}

function toRunOutputPersistence(
  outputPersistence: WorkflowOutputPersistence | undefined,
): WorkflowRunOutputPersistence | undefined {
  if (!outputPersistence) {
    return undefined
  }

  return {
    ...outputPersistence,
    status: 'pending',
  }
}

function shouldPersistRunOutput(run: WorkflowRun): boolean {
  return (
    run.status === 'success' &&
    run.gitlabPipelineId !== undefined &&
    run.outputPersistence !== undefined &&
    !['persisted', 'unchanged'].includes(run.outputPersistence.status)
  )
}

async function persistRunOutput(
  client: GitLabClientLike,
  projectId: string,
  run: WorkflowRun,
): Promise<WorkflowRunOutputPersistence> {
  if (!run.outputPersistence || run.gitlabPipelineId === undefined) {
    throw new Error('Run output persistence is not configured.')
  }

  const jobs = await client.listPipelineJobs(projectId, run.gitlabPipelineId)
  const job = jobs.find((item) => item.name === run.outputPersistence?.jobName)

  if (!job) {
    throw new Error(
      `Job "${run.outputPersistence.jobName}" was not found in pipeline ${run.gitlabPipelineId}.`,
    )
  }

  if (job.status !== 'success') {
    throw new Error(
      `Job "${job.name}" is ${job.status ?? 'unknown'}, so its artifact is not ready.`,
    )
  }

  const content = await client.downloadJobArtifactFile(
    projectId,
    job.id,
    run.outputPersistence.artifactPath,
  )
  const result = await client.upsertRepositoryFile(
    projectId,
    run.ref,
    run.outputPersistence.repositoryPath,
    content,
    run.outputPersistence.commitMessage,
  )

  return {
    ...run.outputPersistence,
    repositoryPath: result.filePath,
    status: result.action === 'unchanged' ? 'unchanged' : 'persisted',
    action: result.action,
    jobId: job.id,
    updatedAt: new Date().toISOString(),
    error: undefined,
  }
}

function toFailedRunOutputPersistence(
  outputPersistence: WorkflowRunOutputPersistence | undefined,
  message: string,
): WorkflowRunOutputPersistence | undefined {
  if (!outputPersistence) {
    return undefined
  }

  return {
    ...outputPersistence,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    error: message,
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected server error.'
}
