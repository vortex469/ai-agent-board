import { assertTaskDependencies, DependencyGateError, getTaskDependencyGate, withDependencyAdmissionLock } from './task-dependencies.js';
import { verifyGroupBaseline } from './group-baseline.js';
import { v4 as uuid } from 'uuid';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Task, TaskGroup, AgentEvent, AgentType } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentProvider, AgentSession, AgentInfo, AgentAttachment } from '@codewithdan/agent-sdk-core';
import type { AgentEvent as CoreAgentEvent } from '@codewithdan/agent-sdk-core';
import { CopilotProvider, ClaudeProvider, CodexProvider, OpenCodeProvider, HermesProvider, OpenClawProvider, GrokProvider } from '@codewithdan/agent-sdk-core';
import { broadcast } from '../websocket.js';
import { getLocalOpenAIConfig, LocalOpenAIProvider } from './local-openai-provider.js';
import {
  cleanupTaskWorktree,
  inspectTaskWorktree,
  type WorktreeCleanupInspection,
  type WorktreeCleanupResult,
} from './worktree-cleanup.js';
import { UPLOADS_DIR } from '../routes/attachments.js';
import type { AttachmentStore } from '../repositories/attachment-types.js';
import { errorMessage } from '../utils.js';
import { detectAvailableAgents } from './agent-detection.js';
import { resolveTaskTimeoutMs } from './agent-timeout.js';
import {
  bootstrapNpmWorkspaceIfNeeded,
  detectProjectPythonEnvironment,
  provisionWorktreeDependencies,
  type PythonEnvironmentSelection,
  shouldBootstrapNpmWorkspace,
} from './worktree-dependencies.js';

function loadAttachmentAsBase64(filePath: string, displayName: string, mimeType: string): AgentAttachment | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[agent-manager] attachment file not found: ${filePath}`);
      return null;
    }
    const fileBuffer = fs.readFileSync(filePath);
    const data = fileBuffer.toString('base64');
    console.log(`[agent-manager] loaded attachment: ${displayName} (${mimeType}, ${fileBuffer.length} bytes, base64 length: ${data.length})`);
    return { type: 'base64_image', data, displayName, mediaType: mimeType };
  } catch (err) {
    console.error(`[agent-manager] failed to load attachment ${filePath}:`, err);
    return null;
  }
}

interface ManagedSession {
  session?: AgentSession;
  timeoutId?: ReturnType<typeof setTimeout>;
  startTime: number;
  agentType: AgentType;
}

function sanitizeAgentPromptText(value: string): string {
  return value.replace(/[<>]/g, '');
}

export function buildAgentExecutionPrompt(task: Pick<Task, 'title' | 'description'>): string {
  const safeTitle = sanitizeAgentPromptText(task.title);
  const safeDescription = sanitizeAgentPromptText(task.description || '');
  if (!safeDescription.trim()) return safeTitle;
  return [
    'Task details (authoritative; follow this when it conflicts with the display title):',
    safeDescription,
    '',
    'Display title (for board identification only):',
    safeTitle,
  ].join('\n');
}

export function buildAgentSystemPrompt(args: {
  workingDirectory: string;
  taskTitle: string;
  repoPath?: string;
  worktreePath?: string;
  hasGit: boolean;
  taskMode?: 'coding' | 'read-only';
  pythonEnvironment?: PythonEnvironmentSelection | null;
}): string {
  const safeTitle = sanitizeAgentPromptText(args.taskTitle);
  const taskMode = args.taskMode ?? (args.worktreePath ? 'coding' : 'read-only');
  const repositoryMutationContract = taskMode === 'coding'
    ? `
Task mode: Coding task.
- Implementation must occur inside the managed task worktree: ${args.worktreePath ?? args.workingDirectory}.
- Coding tasks are repository-mutation tasks. They are different from analysis/read-only tasks, which only inspect or explain existing code.
- Do not report coding completion based only on analysis, planning, proposed code, or instructions for someone else to apply.
- Before reporting coding completion, verify there is a non-empty git diff or a task-owned commit for the requested implementation.
- If no repository change was necessary because the requested implementation already exists, report that condition explicitly instead of claiming a normal coding completion.
- If blocked by permissions, sandboxing, missing dependencies, or external validation, report the blocker accurately instead of claiming completion.
`
    : `
Task mode: Analysis/read-only task.
- This task does not have a managed coding worktree. Inspect, explain, or validate as requested without applying repository-mutation completion requirements.
- Do not claim implementation work was completed unless this task is rerun as a coding task with a managed worktree and repository changes are actually made.
`;
  const completionInstructions = taskMode === 'coding'
    ? `Complete the task described in the user prompt. Be thorough — read relevant files,
make precise edits, and verify your changes compile/pass tests when applicable.
Before reporting completion, run the most focused relevant test or build check that proves the change. After tests pass, perform a hostile review of your own diff for regressions, edge cases, security issues, and missing tests. Only claim completion when both gates pass. In your final summary, include clear evidence using the phrases "Focused tests passed:" and "Hostile review passed:". If a required test cannot run because no suitable interpreter or runtime exists, report "Environment error:" with the missing interpreter/runtime and do not claim the validation gates passed.`
    : `Complete the analysis/read-only task described in the user prompt. Be thorough — read relevant files and verify claims with the most focused applicable evidence. If blocked by permissions, sandboxing, missing dependencies, or external validation, report the blocker accurately.`;
  const pythonInstructions = args.pythonEnvironment
    ? `
Python environment:
- Selected interpreter: ${args.pythonEnvironment.interpreterPath}
- Selection source: ${args.pythonEnvironment.source}
- Pytest availability: ${args.pythonEnvironment.pytestAvailable ? 'detected' : `not detected with \`${args.pythonEnvironment.interpreterPath} -m pytest --version\``}
- Run Python tests from ${args.workingDirectory} with the selected interpreter module form, for example: \`cd ${args.workingDirectory} && ${args.pythonEnvironment.interpreterPath} -m pytest\`.
- Do not run bare \`pytest\`, a different Python executable, or tests from another checkout when a selected interpreter is listed here.
${args.worktreePath && args.repoPath && !path.resolve(args.pythonEnvironment.interpreterPath).startsWith(`${path.resolve(args.worktreePath)}${path.sep}`)
  ? `- The interpreter may live outside the task worktree, but it is allowed only as the Python executable for commands run in ${args.workingDirectory}; keep all file reads, writes, and test working directories inside ${args.worktreePath}.`
  : ''}
- If pytest is required but unavailable from the selected interpreter, report \`Environment error: pytest is not installed for ${args.pythonEnvironment.interpreterPath}\` instead of claiming test validation passed.
- If Python packages are needed, never install them globally. ${args.pythonEnvironment.venvPath
  ? `Use \`${args.pythonEnvironment.interpreterPath} -m pip\` so packages install into ${args.pythonEnvironment.venvPath}.`
  : `Create or use a project-local virtual environment under ${args.workingDirectory} before installing packages.`}
`
    : `
Python environment:
- No Python interpreter was detected during setup.
- If Python is needed, create or use a project-local virtual environment under ${args.workingDirectory}; never install packages globally.
`;
  return `
<context>
You are an AI agent working on a task in the project directory: ${args.workingDirectory}
Task: ${safeTitle}
The detailed task description/source item in the user prompt is authoritative. If it conflicts with this generated display title, follow the detailed description/source item.
${args.worktreePath ? `\nIMPORTANT: All file paths MUST be under ${args.worktreePath}. Do NOT reference or edit files at ${args.repoPath} directly.` : ''}
${!args.hasGit && taskMode === 'coding' ? `\nIMPORTANT: This directory is not a git repository. Run \`git init\` first before making any changes, so all work is tracked.` : ''}
${repositoryMutationContract}
${pythonInstructions}
${completionInstructions}

When you have finished, end your VERY LAST message with a task summary in EXACTLY this format (keep the tags on their own lines):
<task-summary>
## Completed
A clear description of what you accomplished. This section is required and must not be empty.
## Comments
Optional notes, caveats, decisions, or context. Omit the body if there is nothing to add.
## Remaining
Optional list of any work you did not complete or that should be followed up. Omit the body if everything is done.
</task-summary>
</context>
`;
}

// Event log per task (capped to prevent unbounded growth)
const MAX_EVENTS_PER_TASK = 2000;
const MAX_EVENT_LOG_TASKS = 200;

// Deleted-task guard TTL
const DELETED_TASK_TTL_MS = 60_000;

const STREAM_BUFFER_FLUSH_MS = 40;

// Upper bound on accumulated assistant prose kept for summary extraction.
// We only need the tail (the final <task-summary> block), so cap memory use.
const MAX_SUMMARY_BUFFER = 64_000;
const MAX_RESULT_BUFFER = 512 * 1024;
const APPROX_CHARS_PER_CONTEXT_TOKEN = 4;
const DEFAULT_LOCAL_AI_CONTEXT_LIMIT_TOKENS = 128_000;
const CONTEXT_COMPACT_UTILIZATION = 0.7;
const CONTEXT_CONTINUATION_UTILIZATION = 0.85;
const CONTEXT_EXHAUSTION_UTILIZATION = 0.92;
const MAX_CONTEXT_SUMMARY_EVENTS = 80;
const MAX_CONTEXT_SUMMARY_FILES = 12;
const MAX_CONTEXT_SUMMARY_TEXT = 4_000;
const CODING_TASK_NO_REPOSITORY_CHANGES_REASON = 'Coding task completed without repository changes.';
const CODING_TASK_NO_REPOSITORY_CHANGES_RECOVERY_INSTRUCTION =
  'This is a coding task. You must implement the requested change in the managed worktree and leave a non-empty repository diff or task-owned commit. Do not report completion without repository changes. If implementation is blocked, report the blocker instead.';
const MAX_NO_CHANGE_RECOVERY_RETRIES = 1;

function extractFullAgentOutput(buffer: string): string | null {
  const summaryStart = buffer.lastIndexOf('<task-summary>');
  const body = (summaryStart >= 0 ? buffer.slice(0, summaryStart) : buffer).trim();
  return body || null;
}

/**
 * Extract the agent-authored task summary from accumulated assistant prose.
 * Returns the trimmed contents of the LAST `<task-summary>…</task-summary>`
 * block, or null when no usable block is present.
 */
function extractTaskSummary(buffer: string): string | null {
  if (!buffer) return null;
  const closed = [...buffer.matchAll(/<task-summary>([\s\S]*?)<\/task-summary>/g)];
  if (closed.length > 0) {
    const body = closed[closed.length - 1][1].trim();
    return body.length > 0 ? body : null;
  }
  // Tolerate a missing closing tag: take everything after the last opening tag.
  const openIdx = buffer.lastIndexOf('<task-summary>');
  if (openIdx >= 0) {
    const body = buffer.slice(openIdx + '<task-summary>'.length).replace(/<\/task-summary>/g, '').trim();
    return body.length > 0 ? body : null;
  }
  return null;
}

function getErrorStderr(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    const stderr = (err as Error & { stderr?: Buffer | string }).stderr;
    return stderr?.toString() ?? '';
  }
  return '';
}

function estimateContextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / APPROX_CHARS_PER_CONTEXT_TOKEN));
}

function configuredLocalAIContextLimit(): number {
  const parsed = Number(process.env.LOCAL_AI_CONTEXT_LIMIT_TOKENS);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_LOCAL_AI_CONTEXT_LIMIT_TOKENS;
}

function contextBudgetState(utilization: number): NonNullable<NonNullable<AgentEvent['metadata']>['contextBudget']>['state'] {
  if (utilization >= CONTEXT_EXHAUSTION_UTILIZATION) return 'exhausted';
  if (utilization >= CONTEXT_CONTINUATION_UTILIZATION) return 'continuation';
  if (utilization >= CONTEXT_COMPACT_UTILIZATION) return 'compact';
  return 'normal';
}

function buildContextBudgetSnapshot(args: {
  promptText: string;
  historicalText?: string;
  maxContextTokens: number;
}): NonNullable<AgentEvent['metadata']>['contextBudget'] {
  const estimatedPromptTokens = estimateContextTokens(args.promptText);
  const estimatedHistoricalTokens = args.historicalText ? estimateContextTokens(args.historicalText) : 0;
  const estimatedContextTokens = estimatedPromptTokens + estimatedHistoricalTokens;
  const utilization = estimatedContextTokens / args.maxContextTokens;
  return {
    estimatedPromptTokens,
    estimatedContextTokens,
    maxContextTokens: args.maxContextTokens,
    utilization,
    state: contextBudgetState(utilization),
    refreshedAt: Date.now(),
  };
}

function truncateContextLine(value: string, maxLength = 220): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 3).trimEnd()}...`;
}

function uniqueRecent(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.unshift(value);
  }
  return result;
}

function repositoryContinuationState(workingDirectory: string, baseBranch?: string, branchName?: string): string[] {
  const lines: string[] = [];
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    lines.push(status ? `Current diff state: ${status.split(/\r?\n/).length} changed file(s).` : 'Current diff state: clean working tree.');
  } catch {
    lines.push('Current diff state: unavailable.');
  }

  if (baseBranch && branchName) {
    try {
      const ahead = execFileSync('git', ['rev-list', '--count', `${baseBranch}..${branchName}`], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().trim();
      lines.push(`Branch state: ${branchName} is ${ahead || '0'} commit(s) ahead of ${baseBranch}.`);
    } catch {
      lines.push(`Branch state: ${branchName} ahead count unavailable.`);
    }
  }
  return lines;
}

function buildContinuationContext(args: {
  task: Task;
  events: AgentEvent[];
  workingDirectory: string;
}): string {
  const recentEvents = args.events.slice(-MAX_CONTEXT_SUMMARY_EVENTS);
  const files = uniqueRecent(recentEvents
    .map((event) => event.metadata?.file)
    .filter((file): file is string => typeof file === 'string' && file.trim().length > 0))
    .slice(-MAX_CONTEXT_SUMMARY_FILES);
  const tests = recentEvents
    .filter((event) => event.type === 'test_result')
    .map((event) => {
      const state = event.metadata?.state ? ` (${event.metadata.state})` : '';
      return `- ${truncateContextLine(event.content)}${state}`;
    })
    .slice(-4);
  const blockers = recentEvents
    .filter((event) => event.type === 'error')
    .map((event) => `- ${truncateContextLine(event.content)}`)
    .slice(-4);
  const notableOutput = recentEvents
    .filter((event) =>
      (event.type === 'output' || event.type === 'complete') &&
      !event.metadata?.finalOutput &&
      /\b(Focused tests passed|Hostile review passed|Environment error|blocked|blocker|Automatic recovery retry|committed|merged)\b/i.test(event.content),
    )
    .map((event) => `- ${truncateContextLine(event.content)}`)
    .slice(-6);

  const sections = [
    'Continuation context (compacted; prior tool output is intentionally summarized, not replayed):',
    `Task scope: ${truncateContextLine(args.task.title)}.`,
    ...repositoryContinuationState(args.workingDirectory, args.task.baseBranch, args.task.branchName),
  ];

  if (files.length) sections.push(`Relevant files touched/read: ${files.join(', ')}.`);
  if (tests.length) sections.push('Recent test evidence:', ...tests);
  if (blockers.length) sections.push('Recent blockers/errors:', ...blockers);
  if (notableOutput.length) sections.push('Important prior findings:', ...notableOutput);

  const summary = sections.join('\n');
  if (summary.length <= MAX_CONTEXT_SUMMARY_TEXT) return summary;
  return `${summary.slice(0, MAX_CONTEXT_SUMMARY_TEXT - 80).trimEnd()}\n[Continuation context truncated to stay within budget.]`;
}

interface GroupQueue {
  groupId: string;
  maxConcurrency: number;
  pendingTaskIds: string[];
  runningTaskIds: Set<string>;
  completedTaskIds: Set<string>;
  failedTaskIds: Set<string>;
  tasks: Map<string, Task>;
  makeStatusCallback: (task: Task) => (status: Task['agentStatus']) => void | Promise<void>;
  makeWorktreeCallback: (task: Task) => (worktreePath: string) => void | Promise<void>;
  onChildComplete: (taskId: string) => void | Promise<void>;
}

export class AgentManager {
  private providers = new Map<AgentType, AgentProvider>();
  private sessions = new Map<string, ManagedSession>();
  private deletedTasks = new Set<string>();
  /** Run identity prevents stopped admissions and late callbacks from affecting a retry. */
  private runEpochs = new Map<string, number>();
  private pendingAdmissions = new Map<string, number>();
  private eventLogs = new Map<string, AgentEvent[]>();
  private eventRepo: TaskRepository | null = null;
  private attachmentStore: AttachmentStore | null = null;
  private availableAgents: AgentInfo[] = [];
  /** Pending coalesced output/thinking broadcast per task */
  private streamBuffer = new Map<string, { event: AgentEvent; timer: ReturnType<typeof setTimeout> }>();
  private groupQueues = new Map<string, GroupQueue>();
  private pausedGroupAdmissions = new Set<string>();
  private drainingGroups = new Set<string>();
  private groupDrainRequested = new Set<string>();
  private dependencyWarnings = new Map<string, string>();
  /** Per-repo mutex to serialize git operations (merge, checkout) */
  private repoLocks = new Map<string, Promise<void>>();
  /** Automatic no-change recovery attempts for the current task execution cycle. */
  private noChangeRecoveryRetries = new Map<string, number>();

  /** Call once at startup to enable event persistence. */
  initEventPersistence(repo: TaskRepository): void {
    this.eventRepo = repo;
  }

  initAttachmentStore(store: AttachmentStore): void {
    this.attachmentStore = store;
  }

  /** Detect available agents, register providers, start the ones that are available. */
  async initialize(): Promise<void> {
    // Register all providers
    this.providers.set('copilot', new CopilotProvider());
    this.providers.set('claude', new ClaudeProvider());
    this.providers.set('codex', new CodexProvider());
    this.providers.set('opencode', new OpenCodeProvider());
    this.providers.set('hermes', new HermesProvider({
      command: process.env.HERMES_COMMAND?.trim() || 'hermes',
    }));
    this.providers.set('openclaw', new OpenClawProvider());
    this.providers.set('grok', new GrokProvider());
    if (getLocalOpenAIConfig()) {
      this.providers.set('local-openai', new LocalOpenAIProvider() as AgentProvider);
    }

    // Detect which agents are actually available on this system
    this.availableAgents = await detectAvailableAgents();
    const available = this.availableAgents.filter(a => a.available);

    console.log(
      `[agent-manager] detected agents: ${this.availableAgents.map(a => `${a.displayName}=${a.available ? 'yes' : 'no'}`).join(', ')}`
    );

    // In test/CI environments there are no real agent credentials, and some
    // provider SDKs spawn a background session on start() that rejects (e.g.
    // Copilot without GitHub auth) as a detached unhandled rejection — which
    // would crash the server. When startup is disabled we skip booting real SDK
    // clients. Because no provider is started, no agent can actually run, so we
    // also report every detected agent as unavailable. This keeps the agents
    // listed in the UI (as "Unavailable") while ensuring real-execution E2E
    // specs skip instead of attempting sessions that would hang or fail — a CLI
    // shim on PATH (e.g. node_modules/.bin/copilot) otherwise makes detection
    // report an agent that cannot be used here as "available".
    const skipAgentStartup =
      process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === '1' ||
      process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === 'true';
    if (skipAgentStartup) {
      console.log('[agent-manager] AGENTBOARD_DISABLE_AGENT_STARTUP set — skipping provider start()');
      const allowMockLocalOpenAI = process.env.AGENTBOARD_E2E_MOCK_LOCAL_OPENAI === '1' && getLocalOpenAIConfig() !== null;
      this.availableAgents = this.availableAgents.map(a => ({
        ...a,
        available: allowMockLocalOpenAI && String(a.name) === 'local-openai' ? true : false,
        reason: allowMockLocalOpenAI && String(a.name) === 'local-openai'
          ? undefined
          : 'Agent startup disabled (test environment)',
      }));
      return;
    }

    // Start available providers
    for (const info of available) {
      const provider = this.providers.get(info.name);
      if (provider) {
        try {
          await provider.start();
        } catch (err: unknown) {
          console.error(`[agent-manager] failed to start ${info.displayName}: ${errorMessage(err)}`);
          // Mark as unavailable
          const agentInfo = this.availableAgents.find(a => a.name === info.name);
          if (agentInfo) {
            agentInfo.available = false;
            agentInfo.reason = `Failed to start: ${errorMessage(err)}`;
          }
        }
      }
    }
  }

  async refresh(): Promise<AgentInfo[]> {
    const detected = await detectAvailableAgents();
    for (const info of detected) {
      const provider = this.providers.get(info.name);
      if (!info.available || !provider) continue;
      const wasAvailable = this.availableAgents.find((item) => item.name === info.name)?.available;
      if (wasAvailable) continue;
      try {
        await provider.start();
      } catch (err: unknown) {
        info.available = false;
        info.reason = `Failed to start: ${errorMessage(err)}`;
      }
    }
    this.availableAgents = detected;
    return this.getAvailableAgents();
  }

  getAvailableAgents(): AgentInfo[] {
    return [...this.availableAgents];
  }

  // ─── Event Management (moved from copilot.ts) ─────────────────────

  private emitEvent(taskId: string, event: AgentEvent): void {
    if (this.deletedTasks.has(taskId)) return;
    // Drop empty content events — nothing to show
    if (!event.content?.trim() && event.type !== 'complete' && event.type !== 'error') return;

    let log = this.eventLogs.get(taskId) || [];
    log.push(event);
    if (log.length > MAX_EVENTS_PER_TASK) {
      log = log.slice(-MAX_EVENTS_PER_TASK);
    }
    // LRU touch
    this.eventLogs.delete(taskId);
    this.eventLogs.set(taskId, log);
    if (this.eventLogs.size > MAX_EVENT_LOG_TASKS) {
      const oldest = this.eventLogs.keys().next().value;
      if (oldest) this.eventLogs.delete(oldest);
    }
    // Write-through to database
    if (this.eventRepo) {
      this.eventRepo.insertEvent(event).catch((err: unknown) => {
        console.error(`[agent-manager] failed to persist event: ${errorMessage(err)}`);
      });
    }
    const STREAMABLE = new Set(['output', 'thinking']);

    const flushBuffer = (taskId: string) => {
      const buf = this.streamBuffer.get(taskId);
      if (buf) {
        clearTimeout(buf.timer);
        broadcast({ type: 'agent_event', payload: buf.event });
        this.streamBuffer.delete(taskId);
      }
    };

    if (STREAMABLE.has(event.type)) {
      const existing = this.streamBuffer.get(event.taskId);
      if (existing && existing.event.type === event.type) {
        // Same type — merge content and reset timer
        clearTimeout(existing.timer);
        existing.event.content += event.content;
        existing.timer = setTimeout(() => flushBuffer(event.taskId), STREAM_BUFFER_FLUSH_MS);
      } else {
        // Different type or no buffer — flush existing, start new buffer
        if (existing) flushBuffer(event.taskId);
        const timer = setTimeout(() => flushBuffer(event.taskId), STREAM_BUFFER_FLUSH_MS);
        this.streamBuffer.set(event.taskId, { event: { ...event }, timer });
      }
    } else {
      // Non-streamable: flush pending buffer first, then broadcast immediately
      flushBuffer(event.taskId);
      broadcast({ type: 'agent_event', payload: event });
    }
  }

  async getEvents(taskId: string): Promise<AgentEvent[]> {
    // Prefer DB (complete, ordered) over in-memory (capped, may be partial)
    if (this.eventRepo) {
      const dbEvents = await this.eventRepo.getEventsByTaskId(taskId);
      if (dbEvents.length > 0) return dbEvents;
    }
    // Fall back to in-memory (task still running, not yet persisted)
    const memEvents = this.eventLogs.get(taskId);
    if (memEvents && memEvents.length > 0) {
      this.eventLogs.delete(taskId);
      this.eventLogs.set(taskId, memEvents);
      return [...memEvents];
    }
    return [];
  }

  clearEvents(taskId: string): void {
    this.deletedTasks.add(taskId);
    setTimeout(() => this.deletedTasks.delete(taskId), DELETED_TASK_TTL_MS);
    this.resetEvents(taskId);
  }

  /** Clear stored events for a task without suppressing future events (used on re-run) */
  async resetEvents(taskId: string): Promise<void> {
    this.eventLogs.delete(taskId);
    if (this.eventRepo) {
      await this.eventRepo.deleteEventsByTaskId(taskId).catch((err: unknown) => {
        console.error(`[agent-manager] failed to delete persisted events: ${errorMessage(err)}`);
      });
    }
  }

  // ─── Worktree Management (moved from copilot.ts) ──────────────────

  // Returns true when `worktreePath` is registered with git as a worktree
  // checked out on `branchName`. Used to safely reuse a worktree left over
  // from a prior (e.g. failed) run instead of colliding on the branch.
  private worktreeRegisteredForBranch(repoPath: string, worktreePath: string, branchName: string): boolean {
    try {
      const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const target = norm(worktreePath);
      for (const block of out.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/);
        const wtLine = lines.find((l) => l.startsWith('worktree '));
        if (!wtLine) continue;
        if (norm(wtLine.slice('worktree '.length)) !== target) continue;
        return lines.includes(`branch refs/heads/${branchName}`);
      }
    } catch {
      /* fall through — treat as not reusable */
    }
    return false;
  }

  private branchExists(repoPath: string, branchName: string): boolean {
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  private verifyTaskWorktree(task: Task): string {
    if (!task.repoPath || !task.branchName || !task.worktreePath) {
      throw new Error('Task has no worktree, repo path, or branch configured');
    }
    const resolvedRepo = path.resolve(task.repoPath);
    const resolvedWorktree = path.resolve(task.worktreePath);
    if (resolvedRepo === resolvedWorktree) {
      throw new Error('Refusing to use the main repository checkout as a task worktree');
    }
    if (!fs.existsSync(resolvedWorktree)) {
      throw new Error('Task worktree directory is missing');
    }
    if (!this.worktreeRegisteredForBranch(resolvedRepo, resolvedWorktree, task.branchName)) {
      throw new Error('Task worktree is not registered on the expected branch');
    }

    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedWorktree,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    const worktreeCommon = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolvedWorktree,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    const repoCommon = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolvedRepo,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    if (
      path.resolve(topLevel) !== fs.realpathSync(resolvedWorktree) ||
      path.resolve(worktreeCommon) !== path.resolve(repoCommon)
    ) {
      throw new Error('Task worktree identity does not match its repository');
    }
    return resolvedWorktree;
  }

  private ensureNoUncommittedWork(task: Task): void {
    if (!task.worktreePath) return;
    const worktreePath = this.verifyTaskWorktree(task);
    const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    if (status.length > 0) {
      throw new Error('Worktree has uncommitted or untracked changes. Commit, discard, or rerun the task before merging or creating a PR.');
    }
  }

  getMergeReadiness(task: Task): { ready: boolean; reason?: string } {
    try {
      this.ensureNoUncommittedWork(task);
      return { ready: true };
    } catch (err: unknown) {
      return { ready: false, reason: errorMessage(err) };
    }
  }

  private commitWorktreeChanges(task: Task): { committed: boolean; commit?: string } {
    const worktreePath = this.verifyTaskWorktree(task);
    execFileSync('git', ['add', '-A'], { cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      execFileSync('git', ['diff', '--cached', '--quiet', '--exit-code'], {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { committed: false };
    } catch {
      const safeTitle = task.title.replace(/\s+/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
      const subject = `Agent Board: ${safeTitle || task.id}`.slice(0, 72);
      execFileSync('git', ['commit', '-m', subject, '-m', `Automated commit for Agent Board task ${task.id}.`], {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().trim();
      return { committed: true, commit };
    }
  }

  private hasWorktreeChanges(task: Task): boolean {
    const worktreePath = this.verifyTaskWorktree(task);
    const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    if (status.length > 0) return true;

    try {
      execFileSync('git', ['diff', '--quiet', '--exit-code'], {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('git', ['diff', '--cached', '--quiet', '--exit-code'], {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return false;
    } catch {
      return true;
    }
  }

  private hasTaskBranchCommitsAhead(task: Task): boolean {
    if (!task.repoPath || !task.branchName) return false;
    const baseBranch = task.repositoryBaseline?.startCommit || task.baseBranch || 'main';
    try {
      const count = execFileSync('git', ['rev-list', '--count', `${baseBranch}..${task.branchName}`], {
        cwd: task.repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().trim();
      return Number.parseInt(count, 10) > 0;
    } catch {
      return false;
    }
  }

  private finalizeCodingTaskWorktreeChanges(task: Task): { committed: boolean; commit?: string } {
    const hadWorktreeChanges = this.hasWorktreeChanges(task);
    if (hadWorktreeChanges) {
      const commit = this.commitWorktreeChanges(task);
      if (commit.committed || this.hasTaskBranchCommitsAhead(task)) return commit;
      throw new Error(CODING_TASK_NO_REPOSITORY_CHANGES_REASON);
    }
    if (this.hasTaskBranchCommitsAhead(task)) return { committed: false };
    throw new Error(CODING_TASK_NO_REPOSITORY_CHANGES_REASON);
  }

  setupWorktree(task: Task): string | undefined {
    if (!task.useWorktree) return undefined;
    if (!task.repoPath) throw new Error('Worktree tasks require repoPath');
    if (!task.branchName) throw new Error('Worktree tasks require branchName');

    verifyGroupBaseline(task);

    // Reuse a valid worktree left over from a prior run (e.g. after a failed
    // attempt). Without this, a restart would mint a new temp dir and fail with
    // "branch already used by worktree", since the old worktree still holds the
    // branch — and any in-progress work in it would be stranded.
    if (
      task.worktreePath &&
      path.resolve(task.worktreePath) !== path.resolve(task.repoPath) &&
      fs.existsSync(task.worktreePath) &&
      this.worktreeRegisteredForBranch(task.repoPath, task.worktreePath, task.branchName)
    ) {
      console.log(`[worktree] reusing existing ${task.worktreePath}`);
      return task.worktreePath;
    }

    // Clear stale worktree records (e.g. dirs deleted out from under git) so a
    // fresh add for this branch isn't blocked by a dangling registration.
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: task.repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      /* best effort */
    }

    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), `agentboard-${task.id}-`));
    const baseBranch = task.repositoryBaseline?.startCommit || task.baseBranch || 'main';

    const branchExists = this.branchExists(task.repoPath, task.branchName);

    try {
      execFileSync(
        'git',
        branchExists
          ? ['worktree', 'add', worktreePath, task.branchName]
          : ['worktree', 'add', '-b', task.branchName, worktreePath, baseBranch],
        { cwd: task.repoPath, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      console.log(branchExists
        ? `[worktree] attached existing branch ${task.branchName} at ${worktreePath}`
        : `[worktree] created at ${worktreePath} from ${baseBranch}`);
      return worktreePath;
    } catch (err: unknown) {
      console.error(`[worktree] failed:`, errorMessage(err));
      if (!this.worktreeRegisteredForBranch(task.repoPath, worktreePath, task.branchName)) {
        try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      throw new Error(`Failed to create worktree: ${errorMessage(err)}`);
    }
  }

  inspectWorktree(task: Task): WorktreeCleanupInspection {
    return inspectTaskWorktree(task);
  }

  removeWorktree(task: Task): WorktreeCleanupResult {
    const result = cleanupTaskWorktree(task);
    if (result.status === 'removed') {
      console.log(`[worktree] removed ${task.worktreePath}; branch ${task.branchName} retained`);
    } else if (result.status === 'blocked') {
      console.warn(`[worktree] retained ${task.worktreePath}: ${result.reason}`);
    }
    return result;
  }

  createPR(task: Task): { url: string } {
    if (!task.repoPath || !task.branchName) {
      throw new Error('Task has no repo path or branch name configured');
    }
    const baseBranch = task.baseBranch || 'main';
    const cwd = task.worktreePath || task.repoPath;

    // Check that a remote named 'origin' exists
    try {
      const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      if (!remoteUrl) throw new Error('empty');
    } catch {
      throw new Error(
        'No git remote "origin" configured. Push your repo to GitHub first:\n' +
        `  cd ${task.repoPath}\n` +
        '  gh repo create <name> --source=. --push'
      );
    }

    try {
      this.ensureNoUncommittedWork(task);
      execFileSync('git', ['push', '-u', 'origin', task.branchName], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const prTitle = task.title.replace(/[<>]/g, '').slice(0, 200);
      const result = execFileSync(
        'gh',
        ['pr', 'create', '--base', baseBranch, '--head', task.branchName,
         '--title', prTitle, '--body', `Automated PR from Kanban task ${task.id}`, '--'],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const url = result.toString().trim();
      console.log(`[pr] created: ${url}`);
      return { url };
    } catch (err: unknown) {
      const stderr = getErrorStderr(err);
      const msg = stderr || errorMessage(err);
      console.error(`[pr] creation failed:`, msg);
      throw new Error(`PR creation failed: ${msg.trim()}`);
    }
  }

  private async withRepoLock<T>(repoPath: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(repoPath) ?? Promise.resolve();
    let resolve: () => void;
    const lock = new Promise<void>((r) => { resolve = r; });
    this.repoLocks.set(repoPath, lock);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
      if (this.repoLocks.get(repoPath) === lock) this.repoLocks.delete(repoPath);
    }
  }

  async mergeLocal(task: Task): Promise<{ merged: true; baseBranch: string }> {
    if (!task.repoPath || !task.branchName) {
      throw new Error('Task has no repo path or branch name configured');
    }
    const repoPath = task.repoPath;
    const branchName = task.branchName;
    const baseBranch = task.baseBranch || 'main';

    return this.withRepoLock(repoPath, () => {
      try {
        this.ensureNoUncommittedWork(task);
        execFileSync('git', ['checkout', baseBranch], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
        execFileSync('git', ['merge', branchName, '--no-edit'], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
        console.log(`[merge] merged ${branchName} into ${baseBranch}`);
        return { merged: true as const, baseBranch };
      } catch (err: unknown) {
        try { execFileSync('git', ['merge', '--abort'], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* already clean */ }
        const stderr = getErrorStderr(err);
        const msg = stderr || errorMessage(err);
        console.error(`[merge] failed:`, msg);
        throw new Error(`Merge failed (conflicts?). Branch ${branchName} was not merged:\n${msg.trim()}`);
      }
    });
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────

  startAgent(
    task: Task,
    onStatusChange: (status: Task['agentStatus']) => void | Promise<void>,
    onWorktreeCreated?: (worktreePath: string) => void | Promise<void>,
  ): void {
    if (this.sessions.has(task.id)) return;
    const epoch = (this.runEpochs.get(task.id) ?? 0) + 1;
    this.runEpochs.set(task.id, epoch);
    if (this.eventRepo) {
      const repo = this.eventRepo;
      this.pendingAdmissions.set(task.id, epoch);
      void (async () => {
        try {
          await withDependencyAdmissionLock(async () => {
            if (this.sessions.has(task.id) || this.runEpochs.get(task.id) !== epoch) return;
            await assertTaskDependencies(task, repo);
            const current = await repo.getById(task.id);
            if (!current || this.runEpochs.get(task.id) !== epoch) return;
            await assertTaskDependencies(current, repo);
            this.startAgentChecked(current, onStatusChange, onWorktreeCreated, epoch);
          });
        } catch (error) {
          if (this.runEpochs.get(task.id) !== epoch) return;
          await this.deferDependencyBlockedTask(task, error);
        } finally {
          if (this.pendingAdmissions.get(task.id) === epoch) this.pendingAdmissions.delete(task.id);
        }
      })();
      return;
    }
    this.startAgentChecked(task, onStatusChange, onWorktreeCreated, epoch);
  }

  private async deferDependencyBlockedTask(task: Task, error: unknown): Promise<void> {
    const repo = this.eventRepo;
    if (this.sessions.has(task.id)) return;
    if (repo) {
      const current = await repo.getById(task.id);
      if (current?.runRequestedAt !== undefined) await repo.requestRun(task.id, current.runRequestedAt);
      else await repo.clearRun(task.id);
      if (current && !this.sessions.has(task.id) && current.agentStatus === 'planning') {
        const pending = await repo.update(task.id, { agentStatus: 'idle', columnId: 'backlog' });
        if (pending) broadcast({ type: 'task_updated', payload: pending });
      }
    }
    for (const queue of this.groupQueues.values()) {
      if (queue.runningTaskIds.delete(task.id) && !queue.pendingTaskIds.includes(task.id)) queue.pendingTaskIds.push(task.id);
    }
    this.emitEvent(task.id, { id: uuid(), taskId: task.id, type: 'error', timestamp: Date.now(), content: `Dependency gate: ${errorMessage(error)}` });
  }

  private startAgentChecked(
    task: Task,
    onStatusChange: (status: Task['agentStatus']) => void | Promise<void>,
    onWorktreeCreated?: (worktreePath: string) => void | Promise<void>,
    admissionEpoch?: number,
  ): void {
    if (this.sessions.has(task.id)) return;
    const epoch = admissionEpoch ?? (this.runEpochs.get(task.id) ?? 0) + 1;
    this.runEpochs.set(task.id, epoch);
    const isCurrentRun = () => this.runEpochs.get(task.id) === epoch;
    const agentType = task.agentType || 'copilot';
    const sessionStartTime = Date.now();
    const noChangeRecoveryRetryCount = this.noChangeRecoveryRetries.get(task.id) ?? 0;
    let terminated = false;

    // Clear any prior run's summary so a rerun never displays a stale result
    // (e.g. if this run fails before producing a new summary).
    if (task.summary != null) {
      void this.eventRepo?.update(task.id, { summary: null }).catch(() => {});
    }
    const terminateOnce = async (status: 'complete' | 'failed', errorMessage?: string) => {
      if (terminated) return;
      // If the task was stopped by the user, stopAgent already handled cleanup
      if (!isCurrentRun()) { terminated = true; return; }
      terminated = true;
      this.noChangeRecoveryRetries.delete(task.id);
      const entry = this.sessions.get(task.id);
      if (entry?.timeoutId) clearTimeout(entry.timeoutId);
      const duration = Date.now() - sessionStartTime;

      // Item 5: Emit structured summary event
      if (status === 'complete') {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'complete',
          content: 'Task completed successfully.',
          timestamp: Date.now(),
          metadata: { agentType, duration },
        });
      } else {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: errorMessage || 'Task failed.',
          timestamp: Date.now(),
          metadata: { agentType, duration, error: errorMessage },
        });
      }

      // An event lookup can overlap a stop/retry; old runs cannot settle the new run.
      const eventCount = (await this.getEvents(task.id)).length;
      if (!isCurrentRun()) return;
      // Item 2: Broadcast agent_complete WS event
      broadcast({
        type: 'agent_complete',
        payload: {
          taskId: task.id,
          status,
          agentType,
          duration,
          eventCount,
        },
      });

      onStatusChange(status);
    };

    const provider = this.providers.get(agentType);
    if (!provider) {
      void terminateOnce('failed', `No provider registered for agent type: ${agentType}`);
      return;
    }

    // Check if agent is available
    const agentInfo = this.availableAgents.find(a => a.name === agentType);
    if (!agentInfo?.available) {
      void terminateOnce('failed', `Agent ${provider.displayName} is not available: ${agentInfo?.reason || 'unknown reason'}`);
      return;
    }

    // Synchronous placeholder to prevent duplicate starts during async session creation
    this.sessions.set(task.id, { startTime: sessionStartTime, agentType });

    // Set up worktree if configured
    let worktreePath: string | undefined;
    if (task.useWorktree) {
      const priorWorktree = task.worktreePath;
      try {
        worktreePath = this.setupWorktree(task);
        if (worktreePath) {
          task.worktreePath = worktreePath;
          if (onWorktreeCreated) onWorktreeCreated(worktreePath);
          const reused = priorWorktree != null && path.resolve(priorWorktree) === path.resolve(worktreePath);
          let dirtyHint = '';
          if (reused) {
            try {
              const status = execFileSync('git', ['status', '--porcelain'], {
                cwd: worktreePath, stdio: ['ignore', 'pipe', 'pipe'],
              }).toString().trim();
              dirtyHint = status ? '\nNote: worktree has uncommitted changes from a prior run.' : '';
            } catch {
              /* ignore status probe failures */
            }
          }
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'output',
            content: `${reused ? 'Reusing existing git worktree at' : 'Git worktree created at'} ${worktreePath}\nBranch: ${task.branchName}\nBase: ${task.baseBranch || 'main'}${dirtyHint}`,
            timestamp: Date.now(),
          });
        }
      } catch (err: unknown) {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: `Worktree setup failed: ${errorMessage(err)}`,
          timestamp: Date.now(),
        });
        terminateOnce('failed', `Worktree setup failed: ${errorMessage(err)}`);
        return;
      }
    }

    // Launch the agent session asynchronously
    (async () => {
      try {
        const workingDirectory = worktreePath || task.repoPath || process.cwd();
        const hasGit = fs.existsSync(path.join(workingDirectory, '.git'));
        const pythonEnvironment = detectProjectPythonEnvironment(worktreePath, {
          repoPath: task.repoPath || workingDirectory,
        });
        const systemPrompt = buildAgentSystemPrompt({
          workingDirectory,
          taskTitle: task.title,
          repoPath: task.repoPath,
          worktreePath,
          hasGit,
          taskMode: worktreePath ? 'coding' : 'read-only',
          pythonEnvironment,
        });

        if (pythonEnvironment) {
          const pytestStatus = pythonEnvironment.pytestAvailable
            ? 'pytest detected'
            : 'pytest not detected; report an Environment error if pytest is required before installing it into a project-local virtual environment';
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'output',
            content: `Selected Python interpreter: ${pythonEnvironment.interpreterPath} (${pythonEnvironment.source}); ${pytestStatus}.`,
            timestamp: Date.now(),
          });
        } else {
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'output',
            content: 'No Python interpreter detected during pre-agent setup. Python package installs must still use a project-local virtual environment.',
            timestamp: Date.now(),
          });
        }

        if (worktreePath) {
          try {
            const dependencyResult = await provisionWorktreeDependencies(worktreePath);
            if (dependencyResult.status === 'installed') {
              this.emitEvent(task.id, {
                id: uuid(), taskId: task.id, type: 'output',
                content: `Provisioned npm dependencies inside worktree using ${dependencyResult.project.lockfileName}.`,
                timestamp: Date.now(),
                metadata: { command: 'npm ci' },
              });
            } else if (dependencyResult.status === 'already-present') {
              this.emitEvent(task.id, {
                id: uuid(), taskId: task.id, type: 'output',
                content: `Reusing existing worktree-local node_modules for ${dependencyResult.project.lockfileName}.`,
                timestamp: Date.now(),
              });
            }
            if (dependencyResult.status !== 'skipped') {
              const bootstrapDecision = shouldBootstrapNpmWorkspace(dependencyResult.project);
              if (bootstrapDecision.shouldBootstrap) {
                this.emitEvent(task.id, {
                  id: uuid(), taskId: task.id, type: 'output',
                  content: 'Bootstrapping npm workspace: npm run build:shared.',
                  timestamp: Date.now(),
                  metadata: { command: 'npm run build:shared' },
                });
              }
              const bootstrapResult = await bootstrapNpmWorkspaceIfNeeded(dependencyResult.project);
              if (bootstrapResult.status === 'ran') {
                this.emitEvent(task.id, {
                  id: uuid(), taskId: task.id, type: 'output',
                  content: 'npm workspace bootstrap succeeded: npm run build:shared.',
                  timestamp: Date.now(),
                  metadata: { command: 'npm run build:shared' },
                });
              }
            }
          } catch (err: unknown) {
            const dependencyError = `Pre-agent setup failed: ${errorMessage(err)}`;
            this.emitEvent(task.id, {
              id: uuid(), taskId: task.id, type: 'error',
              content: dependencyError,
              timestamp: Date.now(),
            });
            const entry = this.sessions.get(task.id);
            if (entry) this.sessions.delete(task.id);
            terminateOnce('failed', dependencyError);
            return;
          }
        }

        const promptPieces = [
          buildAgentExecutionPrompt(task),
          ...(noChangeRecoveryRetryCount > 0
            ? [
                '',
                buildContinuationContext({
                  task,
                  events: await this.getEvents(task.id),
                  workingDirectory,
                }),
                '',
                'Internal recovery instruction:',
                CODING_TASK_NO_REPOSITORY_CHANGES_RECOVERY_INSTRUCTION,
              ]
            : []),
        ];
        const prompt = promptPieces.join('\n');

        const localContextBudget = agentType === 'local-openai'
          ? buildContextBudgetSnapshot({
              promptText: [systemPrompt, prompt].join('\n\n'),
              maxContextTokens: configuredLocalAIContextLimit(),
            })
          : undefined;

        if (localContextBudget) {
          const percent = Math.round(localContextBudget.utilization * 100);
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'output',
            content: `Local AI context budget: approximately ${localContextBudget.estimatedContextTokens.toLocaleString()} / ${localContextBudget.maxContextTokens.toLocaleString()} tokens (${percent}%).`,
            timestamp: Date.now(),
            metadata: { agentType, contextBudget: localContextBudget },
          });

          if (localContextBudget.state === 'exhausted') {
            const contextError = 'Local AI context budget would exceed the safe launch threshold. Start a fresh task continuation with the compacted summary instead of growing this session to the model hard limit.';
            this.emitEvent(task.id, {
              id: uuid(), taskId: task.id, type: 'error',
              content: contextError,
              timestamp: Date.now(),
              metadata: { agentType, contextBudget: localContextBudget, error: contextError },
            });
            const entry = this.sessions.get(task.id);
            if (entry) this.sessions.delete(task.id);
            terminateOnce('failed', contextError);
            return;
          }
        }

        // Track file context across tool_execution_start → command_output pairs
        let lastFileEventFile: string | null = null;
        let lastFileEventType: string | null = null;

        // Accumulate assistant prose ('output' events) to extract the agent's
        // end-of-task <task-summary> marker block after completion and persist
        // the complete answer for service integrations.
        let summaryBuffer = '';
        let resultBuffer = '';

        const session = await withDependencyAdmissionLock(async () => {
          if (this.eventRepo) await assertTaskDependencies(task, this.eventRepo);
          verifyGroupBaseline(task);
          if (!isCurrentRun()) throw new Error('Task was stopped before agent creation');
          return provider.createSession({
          contextId: task.id,
          workingDirectory,
          repoPath: task.repoPath,
          systemPrompt,
          onEvent: (coreEvent: CoreAgentEvent) => {
            if (!isCurrentRun()) return;
            const metadata: Record<string, unknown> = { ...coreEvent.metadata };
            let eventType = coreEvent.type;
            let content = coreEvent.content;

            // Accumulate raw assistant prose for summary extraction, then strip
            // the literal sentinel tags so they don't render in the Events tab.
            if (coreEvent.type === 'output') {
              summaryBuffer += content;
              resultBuffer += content;
              if (resultBuffer.length > MAX_RESULT_BUFFER) {
                resultBuffer = `[Earlier agent output omitted because it exceeded ${MAX_RESULT_BUFFER} characters.]\n\n${resultBuffer.slice(-MAX_RESULT_BUFFER)}`;
              }
              if (summaryBuffer.length > MAX_SUMMARY_BUFFER) {
                summaryBuffer = summaryBuffer.slice(-MAX_SUMMARY_BUFFER);
              }
              if (content.includes('task-summary')) {
                content = content.replace(/<\/?task-summary>/g, '');
              }
            }

            // Reclassify 'create' tool as file_write
            if (coreEvent.type === 'command' && metadata.command === 'create') {
              eventType = 'file_write';
            }

            // Enrich file events with metadata.file extracted from tool arguments
            if ((eventType === 'file_write' || eventType === 'file_edit' || eventType === 'file_read') && !metadata.file) {
              const colonIdx = coreEvent.content.indexOf(':');
              if (colonIdx > 0) {
                try {
                  const args = JSON.parse(coreEvent.content.slice(colonIdx + 1).trim());
                  const filePath = args.path || args.file_path || args.file || args.filename;
                  if (filePath) {
                    metadata.file = filePath;
                    lastFileEventFile = filePath;
                    lastFileEventType = eventType;
                  }
                } catch { /* not JSON args, skip */ }
              }
            }

            // Detect file writes from bash commands (cat > file, echo > file, mkdir, etc.)
            if (coreEvent.type === 'command' && metadata.command === 'bash') {
              const content = coreEvent.content;
              // Match: cat > path, cat >> path, echo ... > path, tee path
              const redirectMatch = content.match(/(?:cat|echo|printf)\s+.*?>\s*(\S+)/);
              const teeMatch = content.match(/tee\s+(\S+)/);
              const filePath = redirectMatch?.[1] || teeMatch?.[1];
              if (filePath && !filePath.startsWith('-')) {
                metadata.file = filePath.replace(/['"]/g, '');
                metadata.fileEventType = 'file_write';
              }
            }

            // Carry file metadata from preceding file_write/file_edit to its command_output
            if (coreEvent.type === 'command_output' && lastFileEventFile && lastFileEventType) {
              metadata.file = lastFileEventFile;
              metadata.fileEventType = lastFileEventType;
              lastFileEventFile = null;
              lastFileEventType = null;
            } else if (eventType !== 'file_write' && eventType !== 'file_edit' && eventType !== 'file_read') {
              lastFileEventFile = null;
              lastFileEventType = null;
            }

            this.emitEvent(task.id, {
              id: coreEvent.id,
              taskId: task.id,
              type: eventType as AgentEvent['type'],
              content,
              timestamp: coreEvent.timestamp,
              metadata,
            });
          },
          });
        });

        if (!isCurrentRun()) { await session.destroy().catch(() => {}); return; }
        this.sessions.set(task.id, { session, startTime: sessionStartTime, agentType });
        onStatusChange('executing');

        // Timeout guard. A task override is persisted with the card so retries
        // stay managed by Agent Board instead of escaping to a direct process.
        const taskTimeoutMs = resolveTaskTimeoutMs(task);
        const timeoutId = setTimeout(() => {
          if (!isCurrentRun() || !this.sessions.has(task.id)) return;
          const timeoutMsg = `Agent timed out after ${Math.round(taskTimeoutMs / 60000)} minutes`;
          console.warn(`[agent-manager] task ${task.id} timed out after ${taskTimeoutMs}ms`);
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'error',
            content: timeoutMsg,
            timestamp: Date.now(),
          });
          const entry = this.sessions.get(task.id);
          if (entry) {
            this.sessions.delete(task.id);
            entry.session?.abort().catch(() => {});
            entry.session?.destroy().catch(() => {});
          }
          terminateOnce('failed', timeoutMsg);
        }, taskTimeoutMs);

        const entry = this.sessions.get(task.id);
        if (entry) entry.timeoutId = timeoutId;

        // Load image attachments if available
        let agentAttachments: AgentAttachment[] | undefined;
        if (this.attachmentStore) {
          const taskAttachments = await this.attachmentStore.getByTaskId(task.id);
          if (taskAttachments.length > 0) {
            const loaded: AgentAttachment[] = [];
            for (const a of taskAttachments) {
              const srcPath = path.join(UPLOADS_DIR, a.taskId, a.filename);
              const att = loadAttachmentAsBase64(srcPath, a.originalName, a.mimeType);
              if (att) loaded.push(att);
            }
            if (loaded.length > 0) agentAttachments = loaded;
          }
        }

        console.log(`[agent-manager] executing ${agentType} for task ${task.id}${agentAttachments?.length ? ` with ${agentAttachments.length} image(s)` : ''}`);
        if (!isCurrentRun()) { await session.destroy().catch(() => {}); return; }
        const result = await session.execute(prompt, agentAttachments);
        console.log(`[agent-manager] ${agentType} ${result.status} for task ${task.id}${result.error ? `: ${result.error}` : ''}`);

        clearTimeout(timeoutId);

        // Primary completion path — status comes from the provider
        if (isCurrentRun() && this.sessions.has(task.id)) {
          this.sessions.delete(task.id);
          // On success, persist the agent-authored summary BEFORE the status
          // transition so the task-update broadcast carries it to clients.
          // Always write (extracted value or null) so a rerun can't leave a
          // stale summary from a previous run. Never let this block completion.
          if (result.status === 'complete') {
            try {
              if (worktreePath) {
                const commit = this.finalizeCodingTaskWorktreeChanges(task);
                if (commit.committed) {
                  this.emitEvent(task.id, {
                    id: uuid(), taskId: task.id, type: 'output',
                    content: `Committed worktree changes on ${task.branchName}: ${commit.commit}`,
                    timestamp: Date.now(),
                    metadata: { command: 'git commit' },
                  });
                }
              }
              const summary = extractTaskSummary(summaryBuffer);
              await this.eventRepo?.update(task.id, { summary });
              const fullOutput = extractFullAgentOutput(resultBuffer);
              if (fullOutput && this.eventRepo) {
                await this.eventRepo.insertEvent({
                  id: uuid(), taskId: task.id, type: 'complete', content: fullOutput,
                  timestamp: Date.now(), metadata: { finalOutput: true },
                });
              }
            } catch (err) {
              console.error(`[agent-manager] failed to finalize result for task ${task.id}:`, errorMessage(err));
              if (
                worktreePath &&
                errorMessage(err) === CODING_TASK_NO_REPOSITORY_CHANGES_REASON &&
                noChangeRecoveryRetryCount < MAX_NO_CHANGE_RECOVERY_RETRIES
              ) {
                this.noChangeRecoveryRetries.set(task.id, noChangeRecoveryRetryCount + 1);
                this.emitEvent(task.id, {
                  id: uuid(), taskId: task.id, type: 'output',
                  content: 'Automatic recovery retry triggered: coding task completed with an empty repository result. Retrying once in the same managed worktree.',
                  timestamp: Date.now(),
                  metadata: {
                    agentType,
                    error: CODING_TASK_NO_REPOSITORY_CHANGES_REASON,
                  },
                });
                session.destroy().catch(() => {});
                this.startAgent(task, onStatusChange, onWorktreeCreated);
                return;
              }
              result.status = 'failed';
              result.error = errorMessage(err);
            }
          }
          terminateOnce(result.status, result.error);
          session.destroy().catch(() => {});
        }
      } catch (err: unknown) {
        if (!isCurrentRun()) return;
        if (err instanceof DependencyGateError) {
          this.sessions.delete(task.id);
          await this.deferDependencyBlockedTask(task, err);
          return;
        }
        const message = errorMessage(err);
        const isCliMissing =
          message.includes('ENOENT') ||
          message.includes('not found') ||
          message.includes('spawn');

        const errorContent = isCliMissing
          ? `${provider.displayName} CLI is not installed or not found in PATH.`
          : `Failed to start ${provider.displayName} session: ${message}`;

        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: errorContent,
          timestamp: Date.now(),
        });

        const entry = this.sessions.get(task.id);
        if (entry) this.sessions.delete(task.id);
        terminateOnce('failed', errorContent);
      }
    })().catch((err: unknown) => {
      console.error(`[agent-manager] unhandled error for task ${task.id}:`, err);
      terminateOnce('failed');
    });
  }

  async sendMessage(taskId: string, message: string, attachmentIds?: string[]): Promise<boolean> {
    const entry = this.sessions.get(taskId);
    if (!entry?.session) return false;

    this.emitEvent(taskId, {
      id: uuid(), taskId, type: 'command',
      content: `Follow-up message sent: ${message}${attachmentIds?.length ? ` (with ${attachmentIds.length} image(s))` : ''}`,
      timestamp: Date.now(),
    });

    // Load attachments if IDs provided
    let agentAttachments: AgentAttachment[] | undefined;
    if (attachmentIds?.length && this.attachmentStore) {
      const loaded: AgentAttachment[] = [];
      for (const id of attachmentIds) {
        const a = await this.attachmentStore.getById(id);
        if (!a) continue;
        const srcPath = path.join(UPLOADS_DIR, a.taskId, a.filename);
        const att = loadAttachmentAsBase64(srcPath, a.originalName, a.mimeType);
        if (att) loaded.push(att);
      }
      if (loaded.length > 0) agentAttachments = loaded;
    }

    try {
      await entry.session.send(message, agentAttachments);
    } catch (err: unknown) {
      const providerName = this.providers.get(entry.agentType)?.displayName || entry.agentType;
      throw new Error(`${providerName} failed to process follow-up: ${errorMessage(err)}`);
    }
    return true;
  }

  async stopAgent(taskId: string): Promise<boolean> {
    const entry = this.sessions.get(taskId);
    const pending = this.pendingAdmissions.delete(taskId);
    if (!entry && !pending) return false;
    const stoppedEpoch = (this.runEpochs.get(taskId) ?? 0) + 1;
    this.runEpochs.set(taskId, stoppedEpoch);
    if (!entry) return true;

    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    const duration = Date.now() - entry.startTime;
    const { agentType } = entry;
    this.sessions.delete(taskId);
    this.noChangeRecoveryRetries.delete(taskId);

    (async () => {
      try { await entry.session?.abort(); } catch { /* ignore */ }
      try { await entry.session?.destroy(); } catch { /* ignore */ }
    })();

    this.emitEvent(taskId, {
      id: uuid(), taskId, type: 'error',
      content: 'Agent stopped by user.',
      timestamp: Date.now(),
      metadata: { agentType, duration, error: 'Agent stopped by user.' },
    });

    const eventCount = (await this.getEvents(taskId)).length;
    if (this.runEpochs.get(taskId) !== stoppedEpoch) return true;
    // Broadcast agent_complete so WS listeners know the agent finished
    broadcast({
      type: 'agent_complete',
      payload: {
        taskId,
        status: 'failed',
        agentType,
        duration,
        eventCount,
      },
    });

    // Clean up stale group queue entry if this task belongs to a running group
    for (const [groupId, q] of this.groupQueues) {
      if (q.runningTaskIds.delete(taskId)) {
        q.failedTaskIds.add(taskId);
        Promise.resolve(q.onChildComplete(taskId)).catch((err: unknown) =>
          console.error('[group] onChildComplete failed:', err),
        );
        if (q.pendingTaskIds.length === 0 && q.runningTaskIds.size === 0) {
          this.groupQueues.delete(groupId);
        } else {
          queueMicrotask(() => this.drainGroupQueue(groupId));
        }
        break;
      }
    }

    return true;
  }

  isRunning(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  shutdownAll(): void {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();

    for (const [taskId, entry] of entries) {
      this.runEpochs.set(taskId, (this.runEpochs.get(taskId) ?? 0) + 1);
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      (async () => {
        try { await entry.session?.abort(); } catch { /* ignore */ }
        try { await entry.session?.destroy(); } catch { /* ignore */ }
      })();
    }

    for (const provider of this.providers.values()) {
      provider.stop().catch(() => {});
    }
  }

  // ─── Group Queue ──────────────────────────────────────────────────

  isGroupRunning(groupId: string): boolean {
    return this.groupQueues.has(groupId);
  }

  isGroupChildRunning(groupId: string, taskId: string): boolean {
    return this.groupQueues.get(groupId)?.runningTaskIds.has(taskId) ?? false;
  }

  /** Hold legacy queue admission while persisting and refreshing pending task snapshots. */
  async reconfigurePendingGroupTasks(groupId: string, save: () => Promise<Task[]>): Promise<Task[]> {
    this.pausedGroupAdmissions.add(groupId);
    try {
      const updated = await save();
      const queue = this.groupQueues.get(groupId);
      for (const task of updated) {
        if (queue?.pendingTaskIds.includes(task.id)) queue.tasks.set(task.id, task);
      }
      return updated;
    } finally {
      this.pausedGroupAdmissions.delete(groupId);
      // Only resume an existing queue; configuration never creates an execution.
      queueMicrotask(() => this.drainGroupQueue(groupId));
    }
  }

  startGroup(
    group: TaskGroup,
    children: Task[],
    makeStatusCb: (task: Task) => (status: Task['agentStatus']) => void | Promise<void>,
    makeWorktreeCb: (task: Task) => (worktreePath: string) => void | Promise<void>,
    onChildComplete: (taskId: string) => void | Promise<void>,
  ): void {
    if (this.groupQueues.has(group.id)) return;

    const queue: GroupQueue = {
      groupId: group.id,
      maxConcurrency: group.maxConcurrency,
      pendingTaskIds: children.map((c) => c.id),
      runningTaskIds: new Set(),
      completedTaskIds: new Set(),
      failedTaskIds: new Set(),
      tasks: new Map(children.map((c) => [c.id, c])),
      makeStatusCallback: makeStatusCb,
      makeWorktreeCallback: makeWorktreeCb,
      onChildComplete,
    };

    this.groupQueues.set(group.id, queue);
    this.drainGroupQueue(group.id);
  }

  /** Reconsider pending legacy queues after any prerequisite changes. */
  reevaluateGroupQueues(): void {
    for (const groupId of this.groupQueues.keys()) this.drainGroupQueue(groupId);
    if (this.eventRepo) {
      const repo = this.eventRepo;
      void (async () => {
        for (const taskId of this.sessions.keys()) {
          const gate = await getTaskDependencyGate(repo, taskId);
          if (!this.sessions.has(taskId)) continue;
          if (gate.eligible) { this.dependencyWarnings.delete(taskId); continue; }
          const reason = gate.reason || 'Prerequisite no longer satisfied';
          if (this.dependencyWarnings.get(taskId) === reason) continue;
          this.dependencyWarnings.set(taskId, reason);
          this.emitEvent(taskId, { id: uuid(), taskId, type: 'error', timestamp: Date.now(),
            content: `Dependency inconsistency while running: ${reason}. The active agent continues; review its repository inputs before integration.` });
        }
      })().catch(error => console.error('[dependencies] running-task check failed:', error));
    }
  }

  private drainGroupQueue(groupId: string): void {
    if (this.drainingGroups.has(groupId)) { this.groupDrainRequested.add(groupId); return; }
    this.drainingGroups.add(groupId);
    void (async () => {
      const q = this.groupQueues.get(groupId);
      if (!q || this.pausedGroupAdmissions.has(groupId)) return;
      for (const taskId of [...q.pendingTaskIds]) {
        if (this.groupQueues.get(groupId) !== q || this.pausedGroupAdmissions.has(groupId)
          || q.runningTaskIds.size >= q.maxConcurrency) break;
        await withDependencyAdmissionLock(async () => {
          const task = this.eventRepo ? await this.eventRepo.getById(taskId) : q.tasks.get(taskId);
          if (!task || this.sessions.has(taskId)) return;
          if (this.eventRepo && !(await getTaskDependencyGate(this.eventRepo, taskId)).eligible) return;
          if (this.groupQueues.get(groupId) !== q || this.pausedGroupAdmissions.has(groupId)
            || !q.pendingTaskIds.includes(taskId) || q.runningTaskIds.size >= q.maxConcurrency) return;
          // Leave blocked tasks pending: an external completion will wake this queue.
          q.pendingTaskIds = q.pendingTaskIds.filter(id => id !== taskId);
          q.runningTaskIds.add(taskId);
          const originalStatusCb = q.makeStatusCallback(task);
          const wrappedStatusCb = async (status: Task['agentStatus']) => {
            await originalStatusCb(status);
            if (status === 'complete' || status === 'failed') {
              q.runningTaskIds.delete(taskId);
              (status === 'complete' ? q.completedTaskIds : q.failedTaskIds).add(taskId);
              try { await q.onChildComplete(taskId); } catch (error) { console.error('[group] onChildComplete failed:', error); }
              if (q.pendingTaskIds.length === 0 && q.runningTaskIds.size === 0) this.groupQueues.delete(groupId);
              this.reevaluateGroupQueues();
            }
          };
          this.startAgentChecked(task, wrappedStatusCb, q.makeWorktreeCallback(task));
        });
      }
    })().catch(error => console.error('[group] dependency admission failed:', error))
      .finally(() => {
        this.drainingGroups.delete(groupId);
        if (this.groupDrainRequested.delete(groupId)) this.drainGroupQueue(groupId);
      });
  }

  async stopGroup(groupId: string): Promise<void> {
    const queue = this.groupQueues.get(groupId);
    if (!queue) return;

    // Clear pending
    queue.pendingTaskIds.length = 0;

    // Stop running children
    const running = [...queue.runningTaskIds];
    for (const taskId of running) {
      await this.stopAgent(taskId);
    }

    this.groupQueues.delete(groupId);
  }
}
