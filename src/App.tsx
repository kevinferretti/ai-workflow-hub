import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  History,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  TerminalSquare,
  Trash2,
  Workflow,
} from 'lucide-react'
import './App.css'
import type {
  AppState,
  ProjectConfig,
  SaveProjectRequest,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowVariable,
} from './shared/types.ts'

const emptyState: AppState = {
  gitlab: {
    baseUrl: 'https://gitlab.com',
    tokenConfigured: false,
  },
  projects: [],
  workflows: [],
  runs: [],
}

const starterVariables =
  'WORKFLOW=codex_skill\nCODEX_SKILL=\nSKILL_OUTPUT_ARTIFACT=skill-output.md'

const starterOutputPersistence = {
  enabled: false,
  jobName: 'codex_skill',
  artifactPath: 'skill-output.md',
  repositoryPath: 'skill-runs/skill-output.md',
  commitMessage: 'Persist Codex skill output',
  branchName: 'codex/skill-output',
  mergeRequestTargetBranch: 'main',
  mergeRequestTitle: 'Persist Codex skill output',
}

function App() {
  const [state, setState] = useState<AppState>(emptyState)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSavingGitLab, setIsSavingGitLab] = useState(false)
  const [isSavingProject, setIsSavingProject] = useState(false)
  const [isSavingWorkflow, setIsSavingWorkflow] = useState(false)
  const [runningWorkflowId, setRunningWorkflowId] = useState('')
  const [refreshingRunId, setRefreshingRunId] = useState('')
  const [gitlabForm, setGitlabForm] = useState({
    baseUrl: 'https://gitlab.com',
    token: '',
  })
  const [projectForm, setProjectForm] = useState<SaveProjectRequest>({
    name: '',
    gitlabProjectId: '',
    defaultRef: 'main',
    repositoryUrl: '',
    description: '',
  })
  const [workflowForm, setWorkflowForm] = useState({
    name: '',
    description: '',
    defaultRef: '',
    variablesText: starterVariables,
    outputPersistence: starterOutputPersistence,
  })
  const [runForm, setRunForm] = useState({
    ref: '',
    variablesText: '',
  })

  useEffect(() => {
    void loadState()
  }, [])

  const selectedProject = useMemo(
    () =>
      state.projects.find((project) => project.id === selectedProjectId) ??
      state.projects[0],
    [selectedProjectId, state.projects],
  )

  const projectRuns = useMemo(
    () =>
      selectedProject
        ? state.runs.filter((run) => run.projectId === selectedProject.id)
        : state.runs,
    [selectedProject, state.runs],
  )

  const activeRuns = state.runs.filter((run) =>
    ['created', 'pending', 'preparing', 'running', 'waiting_for_resource'].includes(
      run.status,
    ),
  )

  async function loadState() {
    setIsLoading(true)
    setErrorMessage('')
    try {
      const nextState = await apiRequest<AppState>('/api/state')
      setState(nextState)
      setGitlabForm((current) => ({
        ...current,
        baseUrl: nextState.gitlab.baseUrl,
      }))
    } catch (error) {
      setErrorMessage(errorText(error))
    } finally {
      setIsLoading(false)
    }
  }

  async function saveGitLabSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSavingGitLab(true)
    const nextState = await submitStateChange('/api/settings/gitlab', 'PUT', {
      baseUrl: gitlabForm.baseUrl,
      token: gitlabForm.token || undefined,
    })
    if (nextState) {
      setGitlabForm({
        baseUrl: nextState.gitlab.baseUrl,
        token: '',
      })
    }
    setIsSavingGitLab(false)
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSavingProject(true)
    const nextState = await submitStateChange('/api/projects', 'POST', projectForm)
    if (nextState) {
      const lastProject = nextState.projects.at(-1)
      if (lastProject) {
        setSelectedProjectId(lastProject.id)
        setRunForm({
          ref: '',
          variablesText: '',
        })
      }
      setProjectForm({
        name: '',
        gitlabProjectId: '',
        defaultRef: 'main',
        repositoryUrl: '',
        description: '',
      })
    }
    setIsSavingProject(false)
  }

  async function saveWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSavingWorkflow(true)
    const nextState = await submitStateChange('/api/workflows', 'POST', {
      name: workflowForm.name,
      description: workflowForm.description,
      defaultRef: workflowForm.defaultRef,
      variables: parseVariables(workflowForm.variablesText),
      outputPersistence: workflowForm.outputPersistence.enabled
        ? {
            jobName: workflowForm.outputPersistence.jobName,
            artifactPath: workflowForm.outputPersistence.artifactPath,
            repositoryPath: workflowForm.outputPersistence.repositoryPath,
            commitMessage: workflowForm.outputPersistence.commitMessage,
            branchName: workflowForm.outputPersistence.branchName,
            mergeRequestTargetBranch:
              workflowForm.outputPersistence.mergeRequestTargetBranch,
            mergeRequestTitle: workflowForm.outputPersistence.mergeRequestTitle,
          }
        : undefined,
    })
    if (nextState) {
      setWorkflowForm({
        name: '',
        description: '',
        defaultRef: '',
        variablesText: starterVariables,
        outputPersistence: starterOutputPersistence,
      })
    }
    setIsSavingWorkflow(false)
  }

  async function triggerWorkflow(workflow: WorkflowDefinition) {
    if (!selectedProject) {
      return
    }

    setRunningWorkflowId(workflow.id)
    setErrorMessage('')
    setStatusMessage('')
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: selectedProject.id,
          workflowId: workflow.id,
          ref: runForm.ref || undefined,
          variables: parseVariables(runForm.variablesText),
        }),
      })
      const body = (await response.json()) as { error?: string; state?: AppState } | AppState
      if (!response.ok) {
        if ('state' in body && body.state) {
          setState(body.state)
        }
        throw new Error('error' in body && body.error ? body.error : 'Workflow run failed.')
      }

      setState(body as AppState)
      setStatusMessage(`Triggered ${workflow.name} for ${selectedProject.name}.`)
    } catch (error) {
      setErrorMessage(errorText(error))
    } finally {
      setRunningWorkflowId('')
    }
  }

  async function refreshRun(run: WorkflowRun) {
    setRefreshingRunId(run.id)
    await submitStateChange(`/api/runs/${run.id}/refresh`, 'POST')
    setRefreshingRunId('')
  }

  async function deleteProject(project: ProjectConfig) {
    await submitStateChange(`/api/projects/${project.id}`, 'DELETE')
    if (project.id === selectedProjectId) {
      setSelectedProjectId('')
    }
  }

  async function deleteWorkflow(workflow: WorkflowDefinition) {
    await submitStateChange(`/api/workflows/${workflow.id}`, 'DELETE')
  }

  function selectProject(project: ProjectConfig) {
    setSelectedProjectId(project.id)
    setRunForm({
      ref: '',
      variablesText: '',
    })
  }

  function updateProjectRepositoryUrl(repositoryUrl: string) {
    setProjectForm((current) => {
      const derived = deriveProjectFromRepositoryUrl(repositoryUrl)
      return {
        ...current,
        repositoryUrl,
        name: current.name || derived?.name || '',
        gitlabProjectId: current.gitlabProjectId || derived?.gitlabProjectId || '',
      }
    })

    const derived = deriveProjectFromRepositoryUrl(repositoryUrl)
    if (derived && (!gitlabForm.baseUrl || gitlabForm.baseUrl === 'https://gitlab.com')) {
      setGitlabForm((current) => ({
        ...current,
        baseUrl: derived.baseUrl,
      }))
    }
  }

  function updateWorkflowOutputPersistence(
    patch: Partial<typeof starterOutputPersistence>,
  ) {
    setWorkflowForm((current) => ({
      ...current,
      outputPersistence: {
        ...current.outputPersistence,
        ...patch,
      },
    }))
  }

  async function submitStateChange(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<AppState | undefined> {
    setErrorMessage('')
    setStatusMessage('')
    try {
      const nextState = await apiRequest<AppState>(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      setState(nextState)
      setStatusMessage('Saved.')
      return nextState
    } catch (error) {
      if (error instanceof ApiRequestError && error.state) {
        setState(error.state)
      }
      setErrorMessage(errorText(error))
      return undefined
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Project navigation">
        <div className="brand">
          <div className="brand-mark">
            <Workflow size={22} aria-hidden="true" />
          </div>
          <div>
            <strong>AI Workflow Hub</strong>
            <span>GitLab control plane</span>
          </div>
        </div>

        <section className="sidebar-section">
          <div className="section-label">
            <GitBranch size={16} aria-hidden="true" />
            Projects
          </div>
          <div className="project-list">
            {state.projects.map((project) => (
              <button
                type="button"
                key={project.id}
                className={project.id === selectedProject?.id ? 'selected' : ''}
                onClick={() => selectProject(project)}
              >
                <span>{project.name}</span>
                <small>{project.defaultRef}</small>
              </button>
            ))}
            {state.projects.length === 0 ? (
              <p className="empty-copy">No projects configured.</p>
            ) : null}
          </div>
        </section>

        <section className="sidebar-section">
          <div className="section-label">
            <Activity size={16} aria-hidden="true" />
            Activity
          </div>
          <dl className="metric-list">
            <div>
              <dt>Active runs</dt>
              <dd>{activeRuns.length}</dd>
            </div>
            <div>
              <dt>Workflows</dt>
              <dd>{state.workflows.length}</dd>
            </div>
          </dl>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Project workflow console</p>
            <h1>{selectedProject?.name ?? 'Configure your first project'}</h1>
          </div>
          <button type="button" className="icon-button" onClick={() => void loadState()}>
            {isLoading ? (
              <Loader2 size={18} className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={18} aria-hidden="true" />
            )}
            <span>Refresh</span>
          </button>
        </header>

        {errorMessage ? (
          <div className="alert error" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            {errorMessage}
          </div>
        ) : null}

        {statusMessage ? (
          <div className="alert success" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            {statusMessage}
          </div>
        ) : null}

        <section className="overview-grid" aria-label="Configuration status">
          <StatusTile
            icon={<GitPullRequest size={19} aria-hidden="true" />}
            label="GitLab"
            value={state.gitlab.tokenConfigured ? 'Token configured' : 'Token required'}
            tone={state.gitlab.tokenConfigured ? 'success' : 'warning'}
          />
          <StatusTile
            icon={<GitBranch size={19} aria-hidden="true" />}
            label="Projects"
            value={`${state.projects.length} configured`}
          />
          <StatusTile
            icon={<TerminalSquare size={19} aria-hidden="true" />}
            label="Workflows"
            value={`${state.workflows.length} ready`}
          />
          <StatusTile
            icon={<History size={19} aria-hidden="true" />}
            label="Runs"
            value={`${state.runs.length} recorded`}
          />
        </section>

        <section className="main-grid">
          <div className="panel run-panel">
            <div className="panel-heading">
              <div>
                <h2>Run Workflow</h2>
                <p>Trigger a GitLab pipeline for the selected project.</p>
              </div>
              {selectedProject?.repositoryUrl ? (
                <a
                  className="link-button"
                  href={selectedProject.repositoryUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink size={16} aria-hidden="true" />
                  Repo
                </a>
              ) : null}
            </div>

            {selectedProject ? (
              <>
                <div className="project-summary">
                  <span>{selectedProject.gitlabProjectId}</span>
                  <strong>{selectedProject.defaultRef}</strong>
                </div>
                <div className="run-controls">
                  <label>
                    Ref override
                    <input
                      value={runForm.ref}
                      onChange={(event) =>
                        setRunForm((current) => ({
                          ...current,
                          ref: event.target.value,
                        }))
                      }
                      placeholder={selectedProject.defaultRef}
                    />
                  </label>
                  <label>
                    Run variables
                    <textarea
                      value={runForm.variablesText}
                      placeholder={defaultRunVariables(selectedProject)}
                      onChange={(event) =>
                        setRunForm((current) => ({
                          ...current,
                          variablesText: event.target.value,
                        }))
                      }
                      rows={4}
                    />
                  </label>
                </div>
              </>
            ) : (
              <EmptyPanel icon={<GitBranch size={22} />} title="Add a project first" />
            )}

            <div className="workflow-list">
              {state.workflows.map((workflow) => (
                <article className="workflow-row" key={workflow.id}>
                  <div>
                    <h3>{workflow.name}</h3>
                    <p>{workflow.description || 'No description set.'}</p>
                    <code>{workflow.defaultRef || selectedProject?.defaultRef || 'ref unset'}</code>
                    {workflow.outputPersistence ? (
                      <p className="output-note">
                        Persists {workflow.outputPersistence.artifactPath} to{' '}
                        {workflow.outputPersistence.repositoryPath}
                      </p>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="icon-button quiet"
                      aria-label={`Delete ${workflow.name}`}
                      title={`Delete ${workflow.name}`}
                      onClick={() => void deleteWorkflow(workflow)}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={
                        !selectedProject ||
                        !state.gitlab.tokenConfigured ||
                        runningWorkflowId === workflow.id
                      }
                      onClick={() => void triggerWorkflow(workflow)}
                    >
                      {runningWorkflowId === workflow.id ? (
                        <Loader2 size={16} className="spin" aria-hidden="true" />
                      ) : (
                        <Play size={16} aria-hidden="true" />
                      )}
                      Run
                    </button>
                  </div>
                </article>
              ))}
              {state.workflows.length === 0 ? (
                <EmptyPanel icon={<TerminalSquare size={22} />} title="No workflows yet" />
              ) : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <div>
                <h2>Run History</h2>
                <p>Statuses are refreshed from GitLab on demand.</p>
              </div>
            </div>

            <div className="run-list">
              {projectRuns.map((run) => (
                <article className="run-row" key={run.id}>
                  <div>
                    <span className={`status-pill ${run.status}`}>{run.status}</span>
                    <h3>{run.workflowName}</h3>
                    <p>
                      {run.ref} · {formatDate(run.createdAt)}
                    </p>
                    {run.error ? <p className="run-error">{run.error}</p> : null}
                    {run.outputPersistence ? (
                      <p
                        className={
                          run.outputPersistence.status === 'failed'
                            ? 'run-error'
                            : 'output-note'
                        }
                      >
                        Output {run.outputPersistence.status}: {run.outputPersistence.repositoryPath}
                        {run.outputPersistence.branch
                          ? ` on ${run.outputPersistence.branch}`
                          : ''}
                        {run.outputPersistence.error ? ` - ${run.outputPersistence.error}` : ''}
                      </p>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    {run.outputPersistence?.mergeRequestUrl ? (
                      <a
                        className="icon-button quiet"
                        href={run.outputPersistence.mergeRequestUrl}
                        rel="noreferrer"
                        target="_blank"
                        title="Open merge request"
                      >
                        <GitPullRequest size={16} aria-hidden="true" />
                      </a>
                    ) : null}
                    {run.webUrl ? (
                      <a
                        className="icon-button quiet"
                        href={run.webUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink size={16} aria-hidden="true" />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="icon-button quiet"
                      disabled={!run.gitlabPipelineId || refreshingRunId === run.id}
                      title="Refresh status"
                      onClick={() => void refreshRun(run)}
                    >
                      {refreshingRunId === run.id ? (
                        <Loader2 size={16} className="spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw size={16} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </article>
              ))}
              {projectRuns.length === 0 ? (
                <EmptyPanel icon={<History size={22} />} title="No runs recorded" />
              ) : null}
            </div>
          </div>
        </section>

        <section className="config-grid">
          <form className="panel config-panel" onSubmit={(event) => void saveGitLabSettings(event)}>
            <div className="panel-heading">
              <div>
                <h2>GitLab Connection</h2>
                <p>Local token storage</p>
              </div>
              <Settings size={18} aria-hidden="true" />
            </div>
            <label>
              Base URL
              <input
                value={gitlabForm.baseUrl}
                onChange={(event) =>
                  setGitlabForm((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }))
                }
                placeholder="https://gitlab.com"
              />
            </label>
            <label>
              Access token
              <input
                type="password"
                value={gitlabForm.token}
                onChange={(event) =>
                  setGitlabForm((current) => ({
                    ...current,
                    token: event.target.value,
                  }))
                }
                placeholder={
                  state.gitlab.tokenConfigured ? 'Leave blank to keep current token' : 'Required'
                }
              />
            </label>
            <button type="submit" className="primary-button" disabled={isSavingGitLab}>
              {isSavingGitLab ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <Save size={16} aria-hidden="true" />
              )}
              Save connection
            </button>
          </form>

          <form className="panel config-panel" onSubmit={(event) => void saveProject(event)}>
            <div className="panel-heading">
              <div>
                <h2>Add Project</h2>
                <p>GitLab project locator</p>
              </div>
              <Plus size={18} aria-hidden="true" />
            </div>
            <label>
              Name
              <input
                value={projectForm.name}
                onChange={(event) =>
                  setProjectForm((current) => ({ ...current, name: event.target.value }))
                }
                required
              />
            </label>
            <label>
              GitLab project ID/path
              <input
                value={projectForm.gitlabProjectId}
                onChange={(event) =>
                  setProjectForm((current) => ({
                    ...current,
                    gitlabProjectId: event.target.value,
                  }))
                }
                placeholder="group/subgroup/repo"
                required
              />
            </label>
            <div className="split-fields">
              <label>
                Default ref
                <input
                  value={projectForm.defaultRef}
                  onChange={(event) =>
                    setProjectForm((current) => ({
                      ...current,
                      defaultRef: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label>
                Repo URL
                <input
                  value={projectForm.repositoryUrl}
                  onChange={(event) => updateProjectRepositoryUrl(event.target.value)}
                  placeholder="https://labs.gauntletai.com/kevinferretti/shipshape"
                />
              </label>
            </div>
            <label>
              Description
              <input
                value={projectForm.description}
                onChange={(event) =>
                  setProjectForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </label>
            <button type="submit" className="primary-button" disabled={isSavingProject}>
              {isSavingProject ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <Plus size={16} aria-hidden="true" />
              )}
              Add project
            </button>
          </form>

          <form className="panel config-panel" onSubmit={(event) => void saveWorkflow(event)}>
            <div className="panel-heading">
              <div>
                <h2>Add Workflow</h2>
                <p>Pipeline variable set</p>
              </div>
              <TerminalSquare size={18} aria-hidden="true" />
            </div>
            <label>
              Name
              <input
                value={workflowForm.name}
                onChange={(event) =>
                  setWorkflowForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Run Codex skill"
                required
              />
            </label>
            <label>
              Description
              <input
                value={workflowForm.description}
                onChange={(event) =>
                  setWorkflowForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Ref override
              <input
                value={workflowForm.defaultRef}
                onChange={(event) =>
                  setWorkflowForm((current) => ({
                    ...current,
                    defaultRef: event.target.value,
                  }))
                }
                placeholder="Leave blank to use project default"
              />
            </label>
            <label>
              Variables
              <textarea
                value={workflowForm.variablesText}
                onChange={(event) =>
                  setWorkflowForm((current) => ({
                    ...current,
                    variablesText: event.target.value,
                  }))
                }
                rows={5}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={workflowForm.outputPersistence.enabled}
                onChange={(event) =>
                  updateWorkflowOutputPersistence({
                    enabled: event.target.checked,
                  })
                }
              />
              Persist artifact output
            </label>
            {workflowForm.outputPersistence.enabled ? (
              <div className="persistence-fields">
                <label>
                  Artifact job
                  <input
                    value={workflowForm.outputPersistence.jobName}
                    onChange={(event) =>
                      updateWorkflowOutputPersistence({
                        jobName: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label>
                  Artifact path
                  <input
                    value={workflowForm.outputPersistence.artifactPath}
                    onChange={(event) =>
                      updateWorkflowOutputPersistence({
                        artifactPath: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label>
                  Repository path
                  <input
                    value={workflowForm.outputPersistence.repositoryPath}
                    onChange={(event) =>
                      updateWorkflowOutputPersistence({
                        repositoryPath: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label>
                  Commit message
                  <input
                    value={workflowForm.outputPersistence.commitMessage}
                    onChange={(event) =>
                      updateWorkflowOutputPersistence({
                        commitMessage: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label>
                  Persistence branch
                  <input
                    value={workflowForm.outputPersistence.branchName}
                    onChange={(event) =>
                      updateWorkflowOutputPersistence({
                        branchName: event.target.value,
                      })
                    }
                    placeholder="Leave blank to commit to the run ref"
                  />
                </label>
                <label>
                  MR target branch
                  <input
                    value={workflowForm.outputPersistence.mergeRequestTargetBranch}
                    onChange={(event) =>
                      updateWorkflowOutputPersistence({
                        mergeRequestTargetBranch: event.target.value,
                      })
                    }
                    placeholder="Leave blank to skip MR creation"
                  />
                </label>
                <label>
                  MR title
                  <input
                    value={workflowForm.outputPersistence.mergeRequestTitle}
                    onChange={(event) =>
                      updateWorkflowOutputPersistence({
                        mergeRequestTitle: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
            ) : null}
            <button type="submit" className="primary-button" disabled={isSavingWorkflow}>
              {isSavingWorkflow ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <Plus size={16} aria-hidden="true" />
              )}
              Add workflow
            </button>
          </form>
        </section>

        <section className="panel table-panel">
          <div className="panel-heading">
            <div>
              <h2>Configured Projects</h2>
              <p>Project records are local pointers to GitLab repositories.</p>
            </div>
          </div>
          <div className="table-list">
            {state.projects.map((project) => (
              <div className="table-row" key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <span>{project.gitlabProjectId}</span>
                </div>
                <code>{project.defaultRef}</code>
                <button
                  type="button"
                  className="icon-button quiet"
                  aria-label={`Delete ${project.name}`}
                  title={`Delete ${project.name}`}
                  onClick={() => void deleteProject(project)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
            {state.projects.length === 0 ? (
              <EmptyPanel icon={<GitBranch size={22} />} title="No project records" />
            ) : null}
          </div>
        </section>
      </section>
    </main>
  )
}

function StatusTile({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: ReactNode
  label: string
  value: string
  tone?: 'neutral' | 'success' | 'warning'
}) {
  return (
    <div className={`status-tile ${tone}`}>
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function EmptyPanel({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="empty-panel">
      {icon}
      <span>{title}</span>
    </div>
  )
}

function defaultRunVariables(project: ProjectConfig | undefined): string {
  if (!project?.repositoryUrl) {
    return ''
  }
  return `SKILL_TARGET_URL=${project.repositoryUrl}`
}

function deriveProjectFromRepositoryUrl(
  repositoryUrl: string,
): { baseUrl: string; gitlabProjectId: string; name: string } | undefined {
  try {
    const url = new URL(repositoryUrl)
    const gitlabProjectId = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, '')

    if (!gitlabProjectId) {
      return undefined
    }

    const name = gitlabProjectId.split('/').at(-1)?.replace(/[-_]/g, ' ') ?? ''
    return {
      baseUrl: url.origin,
      gitlabProjectId,
      name: titleCase(name),
    }
  } catch {
    return undefined
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json()) as { error?: string; state?: AppState }
  if (!response.ok) {
    throw new ApiRequestError(body.error ?? 'Request failed.', body.state)
  }
  return body as T
}

function parseVariables(text: string): WorkflowVariable[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf('=')
      if (separatorIndex === -1) {
        return { key: line, value: '' }
      }
      return {
        key: line.slice(0, separatorIndex).trim(),
        value: line.slice(separatorIndex + 1).trim(),
      }
    })
    .filter((variable) => variable.key.length > 0)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected error.'
}

class ApiRequestError extends Error {
  readonly state?: AppState

  constructor(message: string, state?: AppState) {
    super(message)
    this.name = 'ApiRequestError'
    this.state = state
  }
}

export default App
