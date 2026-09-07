import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, cleanupTestPath, git, prepareTestRepo } from './helpers';

type Project = {
  id: string;
  name: string;
};

type Task = {
  id: string;
  title: string;
  columnId: string;
  agentStatus: string;
  worktreePath?: string;
  branchName?: string;
  repositoryBaseline?: {
    startCommit: string;
    predecessorTaskId?: string;
    predecessorBranch?: string;
    predecessorCommit?: string;
  };
};

type AgentEvent = {
  type: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

async function createLocalAiProject(request: APIRequestContext, repoPath: string, name: string): Promise<Project> {
  const res = await request.post(`${API}/api/projects`, {
    data: {
      name,
      repoPath,
      defaultAgentType: 'local-openai',
      defaultBaseBranch: 'main',
      defaultUseWorktree: true,
      autoRunEnabled: true,
    },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function createRoadmapTasks(request: APIRequestContext, projectId: string, stamp: string, firstTitle: string): Promise<Task[]> {
  const res = await request.post(`${API}/api/tasks/batch`, {
    data: {
      tasks: [
        {
          projectId,
          title: `${firstTitle} ${stamp}`,
          description: 'Exercise mocked Local AI coding progression.',
          columnId: 'in-progress',
          agentType: 'local-openai',
          branchName: `e2e/${stamp}-first`,
          autoRun: true,
        },
        {
          projectId,
          title: `E2E Local AI dependent ${stamp}`,
          description: 'This card must only start after the first card reaches Done.',
          columnId: 'backlog',
          agentType: 'local-openai',
          branchName: `e2e/${stamp}-second`,
          autoRun: true,
          dependsOnTaskIndexes: [0],
        },
      ],
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { tasks: Task[] };
  return body.tasks;
}

async function getTasks(request: APIRequestContext, projectId: string): Promise<Task[]> {
  const res = await request.get(`${API}/api/tasks?projectId=${projectId}`);
  expect(res.status()).toBe(200);
  return res.json();
}

async function getTask(request: APIRequestContext, id: string, projectId: string): Promise<Task> {
  const tasks = await getTasks(request, projectId);
  const task = tasks.find((item) => item.id === id);
  expect(task).toBeTruthy();
  return task as Task;
}

async function getEvents(request: APIRequestContext, id: string): Promise<AgentEvent[]> {
  const res = await request.get(`${API}/api/tasks/${id}/events`);
  expect(res.status()).toBe(200);
  return res.json();
}

async function waitForTask(
  request: APIRequestContext,
  projectId: string,
  id: string,
  predicate: (task: Task) => boolean,
): Promise<Task> {
  let matched: Task | undefined;
  await expect.poll(async () => {
    const task = await getTask(request, id, projectId);
    matched = task;
    return predicate(task);
  }, { timeout: 20_000, intervals: [250, 500, 1000] }).toBe(true);
  return matched as Task;
}

async function waitForEventText(
  request: APIRequestContext,
  id: string,
  pattern: RegExp,
): Promise<AgentEvent[]> {
  let matched: AgentEvent[] = [];
  await expect.poll(async () => {
    matched = await getEvents(request, id);
    return pattern.test(eventText(matched));
  }, { timeout: 20_000, intervals: [250, 500, 1000] }).toBe(true);
  return matched;
}

function eventText(events: AgentEvent[]): string {
  return events.map((event) => `${event.content}\n${String(event.metadata?.command ?? '')}`).join('\n');
}

test.describe('Local AI Workbench progression regression', () => {
  const projectIds: string[] = [];
  const taskIds: string[] = [];
  const repoPaths: string[] = [];
  const groupIds: string[] = [];

  test.afterEach(async ({ request }) => {
    const knownTasks: Task[] = [];
    for (const projectId of projectIds) {
      const res = await request.get(`${API}/api/tasks?projectId=${projectId}`).catch(() => undefined);
      if (res?.ok()) knownTasks.push(...await res.json() as Task[]);
    }
    for (const groupId of groupIds) {
      const res = await request.get(`${API}/api/groups/${groupId}`).catch(() => undefined);
      if (res?.ok()) knownTasks.push(...(await res.json() as { children: Task[] }).children);
    }
    for (const id of taskIds) {
      const task = knownTasks.find((item) => item.id === id);
      if (task?.worktreePath) {
        for (const repoPath of repoPaths) {
          try { git(['worktree', 'remove', task.worktreePath, '--force'], repoPath); break; } catch { /* try next repo */ }
        }
        cleanupTestPath(task.worktreePath);
      }
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    for (const id of groupIds) {
      await request.delete(`${API}/api/groups/${id}`).catch(() => {});
    }
    for (const id of projectIds) {
      await request.delete(`${API}/api/projects/${id}`).catch(() => {});
    }
    for (const repoPath of repoPaths) {
      try { git(['worktree', 'prune'], repoPath); } catch { /* already removed */ }
      cleanupTestPath(repoPath);
    }
    taskIds.length = 0;
    projectIds.length = 0;
    repoPaths.length = 0;
    groupIds.length = 0;
  });

  test('Auto Run executes grouped P1 P2 P3 from each predecessor committed result in isolated worktrees', async ({ request }) => {
    const stamp = `ordered-roadmap-${Date.now()}`;
    const repoPath = prepareTestRepo(stamp, { clean: true });
    repoPaths.push(repoPath);
    const initialCommit = git(['rev-parse', 'main'], repoPath).trim();
    const project = await createLocalAiProject(request, repoPath, stamp);
    projectIds.push(project.id);
    const response = await request.post(`${API}/api/groups`, {
      data: {
        projectId: project.id,
        title: stamp,
        roadmapExecutionMode: 'full-roadmap',
        children: [1, 2, 3].map(step => ({
          title: `E2E Ordered roadmap P${step} ${stamp}`,
          description: 'Implement this coding task in an isolated worktree, preserving the committed results of all previous steps.',
          agentType: 'local-openai',
          useWorktree: true,
        })),
      },
    });
    expect(response.status()).toBe(201);
    const group = await response.json() as { id: string; children: Task[] };
    groupIds.push(group.id);
    taskIds.push(...group.children.map(task => task.id));
    const completed: Task[] = [];
    for (const child of group.children) {
      let finished: Task | undefined;
      await expect.poll(async () => {
        const current = await request.get(`${API}/api/groups/${group.id}`);
        expect(current.status()).toBe(200);
        finished = ((await current.json()) as { children: Task[] }).children.find(task => task.id === child.id);
        return finished?.columnId === 'done' && finished.agentStatus === 'complete';
      }, { timeout: 20_000, intervals: [250, 500, 1000] }).toBe(true);
      completed.push(finished!);
    }

    const worktrees = new Set<string>();
    for (let index = 0; index < completed.length; index++) {
      const child = completed[index];
      expect(child.branchName).toBeTruthy();
      const branch = child.branchName!;
      const output = JSON.parse(git(['show', `${branch}:src/ordered-p${index + 1}.json`], repoPath)) as {
        baseline: string; worktree: string; branch: string;
      };
      const expectedBaseline = index === 0 ? initialCommit
        : git(['rev-parse', completed[index - 1].branchName!], repoPath).trim();
      expect(output.baseline).toBe(expectedBaseline);
      expect(output.branch).toBe(branch);
      expect(output.worktree).not.toBe(repoPath);
      worktrees.add(output.worktree);
      expect(child.repositoryBaseline?.startCommit).toBe(expectedBaseline);
      if (index > 0) {
        expect(child.repositoryBaseline).toMatchObject({
          predecessorTaskId: completed[index - 1].id,
          predecessorBranch: completed[index - 1].branchName,
          predecessorCommit: expectedBaseline,
        });
      }
      git(['merge-base', '--is-ancestor', expectedBaseline, branch], repoPath);
      git(['merge-base', '--is-ancestor', branch, 'main'], repoPath);
      const events = eventText(await getEvents(request, child.id));
      expect(events).toContain(`Focused tests passed: P${index + 1} inherited all committed predecessors`);
      expect(events).not.toMatch(/\bgit push\b|\bcreate-pr\b|\bdeploy\b/i);
    }
    expect(worktrees.size).toBe(3);
    expect(completed[2].repositoryBaseline?.startCommit).not.toBe(git(['rev-parse', completed[0].branchName!], repoPath).trim());
  });

  test('retries one empty Local AI result, accepts validation evidence, and starts the next roadmap card after Done', async ({ request }) => {
    const stamp = `local-ai-recovery-${Date.now()}`;
    const repoPath = prepareTestRepo(stamp, { clean: true });
    repoPaths.push(repoPath);
    const project = await createLocalAiProject(request, repoPath, `Local AI Recovery ${stamp}`);
    projectIds.push(project.id);

    const [first, second] = await createRoadmapTasks(request, project.id, stamp, 'E2E Local AI recovery succeeds');
    taskIds.push(first.id, second.id);

    const firstDone = await waitForTask(request, project.id, first.id, (task) => task.columnId === 'done' && task.agentStatus === 'complete');
    expect(firstDone.worktreePath).toBeUndefined();
    await waitForTask(request, project.id, second.id, (task) => task.columnId !== 'backlog' || task.agentStatus !== 'idle');

    const firstEvents = await getEvents(request, first.id);
    const secondEvents = await waitForEventText(request, second.id, /Focused tests passed: mocked dependent Local AI regression/);
    const firstOutput = eventText(firstEvents);
    const secondOutput = eventText(secondEvents);
    const firstAutoMerge = firstEvents.find((event) => event.content.includes('Auto-merged'));
    const secondWorktree = secondEvents.find((event) => event.content.includes('git worktree'));

    expect(firstEvents.filter((event) => event.content.includes('Automatic recovery retry triggered'))).toHaveLength(1);
    expect(firstEvents.filter((event) => event.content.includes('DeepSeek Harness headless started'))).toHaveLength(2);
    expect(firstOutput).toContain('Focused tests passed: mocked Local AI recovery regression');
    expect(firstOutput).toContain('Hostile review passed');
    expect(firstAutoMerge).toBeTruthy();
    expect(secondWorktree).toBeTruthy();
    expect(secondWorktree!.timestamp).toBeGreaterThanOrEqual(firstAutoMerge!.timestamp);
    expect(secondOutput).toContain('Focused tests passed: mocked dependent Local AI regression');
    expect(firstOutput + secondOutput).not.toMatch(/\bgit push\b|\bcreate-pr\b|\bdeploy\b/i);
    expect(git(['log', '--oneline', '--', 'src/recovered-local-ai.txt'], repoPath)).toContain('Agent Board: E2E Local AI recovery succeeds');
  });

  test('stops safely when the bounded Local AI recovery retry is also a no-op', async ({ request }) => {
    const stamp = `local-ai-noop-${Date.now()}`;
    const repoPath = prepareTestRepo(stamp, { clean: true });
    repoPaths.push(repoPath);
    const project = await createLocalAiProject(request, repoPath, `Local AI Noop ${stamp}`);
    projectIds.push(project.id);

    const [first, second] = await createRoadmapTasks(request, project.id, stamp, 'E2E Local AI stays no-op');
    taskIds.push(first.id, second.id);

    const failed = await waitForTask(request, project.id, first.id, (task) => task.agentStatus === 'failed');
    const blockedDependent = await getTask(request, second.id, project.id);
    const firstEvents = await getEvents(request, first.id);

    expect(failed.columnId).toBe('in-progress');
    expect(blockedDependent.columnId).toBe('backlog');
    expect(blockedDependent.agentStatus).toBe('idle');
    expect(firstEvents.filter((event) => event.content.includes('Automatic recovery retry triggered'))).toHaveLength(1);
    expect(firstEvents.filter((event) => event.content.includes('DeepSeek Harness headless started'))).toHaveLength(2);
    expect(eventText(firstEvents)).toContain('Coding task completed without repository changes.');
    expect(git(['rev-list', '--count', `main..e2e/${stamp}-first`], repoPath).trim()).toBe('0');
  });

  test('surfaces a real Local AI blocker without retrying forever', async ({ request }) => {
    const stamp = `local-ai-blocker-${Date.now()}`;
    const repoPath = prepareTestRepo(stamp, { clean: true });
    repoPaths.push(repoPath);
    const project = await createLocalAiProject(request, repoPath, `Local AI Blocker ${stamp}`);
    projectIds.push(project.id);

    const [task] = await createRoadmapTasks(request, project.id, stamp, 'E2E Local AI real blocker');
    taskIds.push(task.id);

    await waitForTask(request, project.id, task.id, (item) => item.agentStatus === 'failed');
    const events = await getEvents(request, task.id);
    const output = eventText(events);

    expect(events.filter((event) => event.content.includes('Automatic recovery retry triggered'))).toHaveLength(0);
    expect(events.filter((event) => event.content.includes('DeepSeek Harness headless started'))).toHaveLength(1);
    expect(output).toContain('mocked Local AI blocker prevented validation');
  });

  test('accepts a task-owned commit when the final working tree is clean', async ({ request }) => {
    const stamp = `local-ai-precommitted-${Date.now()}`;
    const repoPath = prepareTestRepo(stamp, { clean: true });
    repoPaths.push(repoPath);
    const project = await createLocalAiProject(request, repoPath, `Local AI Precommitted ${stamp}`);
    projectIds.push(project.id);

    const res = await request.post(`${API}/api/tasks`, {
      data: {
        projectId: project.id,
        title: `E2E Local AI precommitted ${stamp}`,
        description: 'Accept a task-owned commit even though the working tree is clean at completion.',
        columnId: 'in-progress',
        agentType: 'local-openai',
        branchName: `e2e/${stamp}`,
        autoRun: true,
      },
    });
    expect(res.status()).toBe(201);
    const task = await res.json() as Task;
    taskIds.push(task.id);

    await waitForTask(request, project.id, task.id, (item) => item.columnId === 'done' && item.agentStatus === 'complete');
    const events = await getEvents(request, task.id);

    expect(eventText(events)).not.toContain('Coding task completed without repository changes.');
    expect(git(['status', '--porcelain=v1'], repoPath).trim()).toBe('');
    expect(git(['log', '--oneline', '--', 'src/precommitted-local-ai.txt'], repoPath)).toContain('Mock Local AI task-owned commit');
  });
});
