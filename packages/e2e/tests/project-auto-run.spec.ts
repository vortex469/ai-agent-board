import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, waitForBoard } from './helpers';

type Project = {
  id: string;
  name: string;
  autoRunEnabled?: boolean;
};

type Task = {
  id: string;
  title: string;
  columnId: string;
  agentStatus: string;
  sortOrder?: number;
};

async function createProject(request: APIRequestContext, name: string): Promise<Project> {
  const res = await request.post(`${API}/api/projects`, { data: { name } });
  expect(res.status()).toBe(201);
  return res.json();
}

async function createTask(request: APIRequestContext, projectId: string, title: string): Promise<Task> {
  const res = await request.post(`${API}/api/tasks`, {
    data: { projectId, title, description: 'Auto Run queue test' },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test.describe('Project Auto Run queue', () => {
  const projectIds: string[] = [];
  const taskIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of taskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    for (const id of projectIds) {
      await request.delete(`${API}/api/projects/${id}`).catch(() => {});
    }
    taskIds.length = 0;
    projectIds.length = 0;
  });

  test('shows and persists Auto Run state on desktop and mobile', async ({ page, request }) => {
    const project = await createProject(request, 'Auto Run Persistence');
    projectIds.push(project.id);

    await page.goto(`/projects/${project.id}`);
    await waitForBoard(page);
    await expect(page.getByRole('button', { name: 'Auto Run Off' })).toBeVisible();

    await page.getByRole('button', { name: 'Auto Run Off' }).click();
    await expect(page.getByRole('button', { name: 'Auto Run On' })).toBeVisible();
    await expect.poll(async () => {
      const res = await request.get(`${API}/api/projects/${project.id}`);
      return ((await res.json()) as Project).autoRunEnabled;
    }).toBe(true);

    await page.reload();
    await waitForBoard(page);
    await expect(page.getByRole('button', { name: 'Auto Run On' })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await waitForBoard(page);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('button', { name: 'Auto Run On' })).toBeVisible();
  });

  test('reorders Backlog cards and persists the future Auto Run order', async ({ request }) => {
    const project = await createProject(request, 'Auto Run Reorder');
    projectIds.push(project.id);
    const first = await createTask(request, project.id, 'Queue First');
    const second = await createTask(request, project.id, 'Queue Second');
    const third = await createTask(request, project.id, 'Queue Third');
    taskIds.push(first.id, second.id, third.id);

    const reorder = await request.post(`${API}/api/tasks/reorder`, {
      data: {
        projectId: project.id,
        columnId: 'backlog',
        orderedTaskIds: [second.id, first.id, third.id],
      },
    });
    expect(reorder.status()).toBe(200);

    const tasksRes = await request.get(`${API}/api/tasks?projectId=${project.id}`);
    const tasks = await tasksRes.json() as Task[];
    expect(tasks.map((task) => task.id)).toEqual([second.id, first.id, third.id]);
  });

  test('Auto Run considers only the first visible Backlog card and does not skip ahead', async ({ request }) => {
    const project = await createProject(request, 'Auto Run Strict Top');
    projectIds.push(project.id);
    const first = await createTask(request, project.id, 'Strict First');
    const second = await createTask(request, project.id, 'Strict Second');
    taskIds.push(first.id, second.id);

    await request.patch(`${API}/api/projects/${project.id}`, { data: { autoRunEnabled: true } });
    const tick = await request.post(`${API}/api/projects/${project.id}/auto-run/tick`, {
      data: { orderedBacklogIds: [first.id, second.id] },
    });
    expect(tick.status()).toBe(200);
    const body = await tick.json();
    expect(body.started).toBe(false);
    expect(body.reason).toBe('selected-agent-unavailable');
    expect(body.task.id).toBe(first.id);

    const tasksRes = await request.get(`${API}/api/tasks?projectId=${project.id}`);
    const tasks = await tasksRes.json() as Task[];
    expect(tasks.find((task) => task.id === first.id)?.columnId).toBe('backlog');
    expect(tasks.find((task) => task.id === second.id)?.columnId).toBe('backlog');
  });

  test('Auto Run waits for the current card to reach Done before starting the next Backlog card', async ({ request }) => {
    const project = await createProject(request, 'Auto Run Done Boundary');
    projectIds.push(project.id);
    const current = await createTask(request, project.id, 'Current Review Card');
    const next = await createTask(request, project.id, 'Next Backlog Card');
    taskIds.push(current.id, next.id);

    await request.patch(`${API}/api/tasks/${current.id}`, { data: { columnId: 'in-progress' } });
    await request.patch(`${API}/api/tasks/${current.id}`, { data: { agentStatus: 'complete', columnId: 'review' } });
    await request.patch(`${API}/api/projects/${project.id}`, { data: { autoRunEnabled: true } });

    const blockedTick = await request.post(`${API}/api/projects/${project.id}/auto-run/tick`, {
      data: { orderedBacklogIds: [next.id] },
    });
    expect(blockedTick.status()).toBe(200);
    await expect(blockedTick.json()).resolves.toMatchObject({
      started: false,
      reason: 'awaiting-current-card-done',
    });

    await request.patch(`${API}/api/tasks/${current.id}`, { data: { columnId: 'done' } });
    const nextTick = await request.post(`${API}/api/projects/${project.id}/auto-run/tick`, {
      data: { orderedBacklogIds: [next.id] },
    });
    expect(nextTick.status()).toBe(200);
    const body = await nextTick.json();
    expect(body.started).toBe(false);
    expect(body.reason).toBe('selected-agent-unavailable');
    expect(body.task.id).toBe(next.id);
  });

  test('Auto Run stops on a blocked top card instead of starting the card beneath it', async ({ request }) => {
    const project = await createProject(request, 'Auto Run Blocked');
    projectIds.push(project.id);
    const blocker = await createTask(request, project.id, 'Blocking Prerequisite');
    const blockedTop = await createTask(request, project.id, 'Blocked Top');
    const next = await createTask(request, project.id, 'Do Not Skip');
    taskIds.push(blocker.id, blockedTop.id, next.id);

    const relationship = await request.post(`${API}/api/tasks/${blockedTop.id}/relationships`, {
      data: { relatedTaskId: blocker.id, type: 'blocks' },
    });
    expect([200, 201]).toContain(relationship.status());

    await request.patch(`${API}/api/projects/${project.id}`, { data: { autoRunEnabled: true } });
    const tick = await request.post(`${API}/api/projects/${project.id}/auto-run/tick`, {
      data: { orderedBacklogIds: [blockedTop.id, next.id] },
    });
    expect(tick.status()).toBe(200);
    await expect(tick.json()).resolves.toMatchObject({
      started: false,
      reason: 'top-card-blocked',
      task: { id: blockedTop.id },
    });

    const tasksRes = await request.get(`${API}/api/tasks?projectId=${project.id}`);
    const tasks = await tasksRes.json() as Task[];
    expect(tasks.find((task) => task.id === blockedTop.id)?.agentStatus).toBe('idle');
    expect(tasks.find((task) => task.id === next.id)?.agentStatus).toBe('idle');
  });

  test('turning Auto Run off does not cancel already-running work', async ({ request }) => {
    const project = await createProject(request, 'Auto Run Disable Keeps Running');
    projectIds.push(project.id);
    const task = await createTask(request, project.id, 'Already Running');
    taskIds.push(task.id);

    const move = await request.patch(`${API}/api/tasks/${task.id}`, { data: { columnId: 'in-progress' } });
    expect(move.status()).toBe(200);
    const planning = await request.patch(`${API}/api/tasks/${task.id}`, { data: { agentStatus: 'planning' } });
    expect(planning.status()).toBe(200);

    await request.patch(`${API}/api/projects/${project.id}`, { data: { autoRunEnabled: true } });
    const disabled = await request.patch(`${API}/api/projects/${project.id}`, { data: { autoRunEnabled: false } });
    expect(disabled.status()).toBe(200);
    expect(((await disabled.json()) as Project).autoRunEnabled).toBe(false);

    const status = await request.get(`${API}/api/tasks/${task.id}/status`);
    await expect(status.json()).resolves.toMatchObject({
      id: task.id,
      agentStatus: 'planning',
      columnId: 'in-progress',
    });
  });
});
