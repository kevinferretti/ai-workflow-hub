export type GitLabSettings = {
  baseUrl: string
  tokenConfigured: boolean
}

export type ProjectConfig = {
  id: string
  name: string
  gitlabProjectId: string
  defaultRef: string
  repositoryUrl: string
  description: string
}

export type WorkflowVariable = {
  key: string
  value: string
}

export type WorkflowOutputPersistence = {
  jobName: string
  artifactPath: string
  repositoryPath: string
  commitMessage: string
}

export type WorkflowDefinition = {
  id: string
  name: string
  description: string
  defaultRef: string
  variables: WorkflowVariable[]
  outputPersistence?: WorkflowOutputPersistence
}

export type WorkflowRunStatus =
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled'
  | 'failed_to_trigger'
  | 'unknown'

export type WorkflowRunOutputPersistenceStatus =
  | 'pending'
  | 'persisted'
  | 'unchanged'
  | 'failed'

export type WorkflowRunOutputPersistence = WorkflowOutputPersistence & {
  status: WorkflowRunOutputPersistenceStatus
  jobId?: number
  action?: 'created' | 'updated' | 'unchanged'
  updatedAt?: string
  error?: string
}

export type WorkflowRun = {
  id: string
  projectId: string
  projectName: string
  workflowId: string
  workflowName: string
  ref: string
  status: WorkflowRunStatus
  variables: WorkflowVariable[]
  createdAt: string
  updatedAt: string
  gitlabPipelineId?: number
  gitlabPipelineIid?: number
  webUrl?: string
  error?: string
  outputPersistence?: WorkflowRunOutputPersistence
}

export type AppState = {
  gitlab: GitLabSettings
  projects: ProjectConfig[]
  workflows: WorkflowDefinition[]
  runs: WorkflowRun[]
}

export type SaveGitLabSettingsRequest = {
  baseUrl: string
  token?: string
}

export type SaveProjectRequest = Omit<ProjectConfig, 'id'> & {
  id?: string
}

export type SaveWorkflowRequest = Omit<WorkflowDefinition, 'id'> & {
  id?: string
}

export type TriggerWorkflowRequest = {
  projectId: string
  workflowId: string
  ref?: string
  variables?: WorkflowVariable[]
}
