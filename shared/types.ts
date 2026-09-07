export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type ColumnId = 'backlog' | 'in-progress' | 'review' | 'done';
export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete' | 'failed';
export type AgentType = 'copilot' | 'claude' | 'codex' | 'opencode' | 'hermes' | 'openclaw' | 'grok' | 'local-openai';

export interface AgentInfo {
  name: AgentType;
  displayName: string;
  available: boolean;
  version?: string;
  reason?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  columnId: ColumnId;
  agentStatus: AgentStatus;
  createdAt: number;
  sortOrder?: number;
  startedAt?: number;
  completedAt?: number;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  worktreePath?: string;
  agentType?: AgentType;
  archived?: boolean;
  groupId?: string;
  groupOrder?: number;
  attachments?: TaskAttachment[];
  projectId: string;
  summary?: string | null;
  runRequestedAt?: number;
  runClaimedAt?: number;
  externalSource?: string;
  externalKey?: string;
  provenance?: TaskProvenance;
  /** Optional execution limit for this task. Omit to use the server default. */
  timeoutMinutes?: number | null;
}

/** A first-class link between two durable Board work items. */
export interface TaskRelationship {
  taskId: string;
  relatedTaskId: string;
  type: 'related' | 'blocks';
  direction?: 'blocks' | 'blocked-by';
  createdAt: number;
}

/** Immutable request snapshot for one execution of a durable Board card. */
export interface ExecutionAttempt {
  id: string;
  taskId: string;
  externalSource: string;
  externalKey: string;
  titleSnapshot: string;
  descriptionSnapshot: string;
  agentType: AgentType;
  relatedTaskId?: string;
  autoStart: boolean;
  timeoutMinutes?: number | null;
  /** Canonical JSON of every material orchestration request field. */
  requestSnapshot: string;
  status: 'pending' | 'dispatched';
  createdAt: number;
}

export interface TaskProvenance {
  sourceProfile?: string;
  sourcePlatform?: string;
  sourceSession?: string;
  sourceMessage?: string;
  sourceTask?: string;
  requestedBy?: string;
  origin?: Record<string, string | number | boolean | null>;
}

export interface TaskGroup {
  roadmapExecutionMode?: RoadmapExecutionMode;
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  columnId: ColumnId;
  repoPath?: string;
  baseBranch?: string;
  maxConcurrency: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  archived?: boolean;
  projectId: string;
}

export interface ProjectTaskCounts {
  backlog: number;
  'in-progress': number;
  review: number;
  done: number;
  total: number;
}

export interface Project {
  id: string;
  name: string;
  repoPath?: string;
  /** Source GitHub/git URL the project's local repo was cloned from, if any. */
  repoUrl?: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  taskCounts?: ProjectTaskCounts;
  /** Default task properties for this project. Each is overridable per task. */
  defaultAgentType?: AgentType;
  defaultPriority?: Priority;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
  autoRunEnabled?: boolean;
  aliases?: string[];
}

export interface CreateProjectRequest {
  name?: string;
  repoPath?: string;
  /** When provided, the server clones this git URL into the configured clone root and uses it as repoPath. */
  repoUrl?: string;
  defaultAgentType?: AgentType;
  defaultPriority?: Priority;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
  autoRunEnabled?: boolean;
  aliases?: string[];
}

export interface UpdateProjectRequest {
  name?: string;
  repoPath?: string | null;
  repoUrl?: string | null;
  defaultAgentType?: AgentType | null;
  defaultPriority?: Priority | null;
  defaultBaseBranch?: string | null;
  defaultUseWorktree?: boolean | null;
  autoRunEnabled?: boolean;
  aliases?: string[];
}

/** Server-side Agent Board configuration (persisted to the config file). */
export interface ProjectConfig {
  /** Absolute path under which repos cloned from a URL are placed. */
  cloneRoot: string;
}

export interface ProjectPathValidation {
  repoPath: string;
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: string;
  warning?: string;
}

export type RepositoryEvidenceState =
  | 'no_changes'
  | 'working_tree_changes'
  | 'task_commit_present'
  | 'clean_after_commit'
  | 'unavailable';

export interface RepositoryEvidenceFile {
  path: string;
  status: string;
}

export interface RepositoryEvidenceCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorDate: string;
}

export interface RepositoryEvidence {
  available: boolean;
  state: RepositoryEvidenceState;
  worktreePath?: string;
  taskBranch?: string;
  baseBranch?: string;
  baseCommit?: string;
  baseShortCommit?: string;
  changedFileCount: number;
  modifiedFileCount: number;
  untrackedFileCount: number;
  commitsAhead: number;
  changedFiles: RepositoryEvidenceFile[];
  latestTaskCommit?: RepositoryEvidenceCommit;
  error?: string;
}

export interface RoadmapProposedTask {
  order: number;
  title: string;
  description: string;
  sourceText: string;
  dependsOnTaskIndexes?: number[];
}

export type RoadmapCreationMode = 'loose' | 'group';

export type RoadmapExecutionMode = 'backlog' | 'first-card' | 'full-roadmap';

export interface RoadmapPreview {
  suggestedGroupName?: string;
  project: {
    id: string;
    repoPath?: string;
    defaultAgentType?: AgentType;
    defaultPriority?: Priority;
    defaultBaseBranch?: string;
    defaultUseWorktree?: boolean;
  };
  tasks: RoadmapProposedTask[];
}

export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command'
  | 'command_output'
  | 'output'
  | 'test_result'
  | 'error'
  | 'complete';

export interface ContextBudgetSnapshot {
  estimatedPromptTokens: number;
  estimatedContextTokens: number;
  maxContextTokens: number;
  utilization: number;
  state: 'normal' | 'compact' | 'continuation' | 'exhausted';
  refreshedAt: number;
}

export interface AgentEvent {
  id: string;
  taskId: string;
  type: AgentEventType;
  content: string;
  timestamp: number;
  metadata?: {
    file?: string;
    fileEventType?: string;
    language?: string;
    command?: string;
    diff?: string;
    agentType?: AgentType;
    callId?: string;
    toolName?: string;
    state?: 'running' | 'succeeded' | 'failed';
    operation?: string;
    duration?: number;
    error?: string;
    /** Persisted, complete assistant prose used by service integrations. */
    finalOutput?: boolean;
    /** Approximate prompt/context use for providers with local budget tracking. */
    contextBudget?: ContextBudgetSnapshot;
  };
}

export interface Column {
  id: ColumnId;
  title: string;
  color: string;
  icon: string;
}

export interface AgentCompletePayload {
  taskId: string;
  status: 'complete' | 'failed';
  agentType?: AgentType;
  duration: number;
  eventCount: number;
}

export interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: Priority;
  agentType: AgentType;
  repoPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  createdAt: number;
}

export interface AgentFollowUpPayload {
  taskId: string;
  message: string;
  attachmentIds?: string[];
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export type WSMessage =
  | { type: 'agent_event'; payload: AgentEvent }
  | { type: 'task_updated'; payload: Task }
  | { type: 'task_deleted'; payload: { id: string } }
  | { type: 'agent_complete'; payload: AgentCompletePayload }
  | { type: 'agent_follow_up'; payload: AgentFollowUpPayload }
  | { type: 'group_updated'; payload: TaskGroup }
  | { type: 'project_updated'; payload: Project }
  | { type: 'project_deleted'; payload: { id: string } };
