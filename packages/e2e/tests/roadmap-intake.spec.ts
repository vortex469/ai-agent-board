import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, prepareTestRepo, waitForBoard } from './helpers';

type Project = {
  id: string;
  repoPath?: string;
};

async function createProject(request: APIRequestContext, name: string): Promise<Project> {
  const repoPath = prepareTestRepo(name, { clean: true });
  const res = await request.post(`${API}/api/projects`, {
    data: {
      name,
      repoPath,
      defaultAgentType: 'claude',
      defaultPriority: 'high',
      defaultBaseBranch: 'develop',
      defaultUseWorktree: true,
    },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test.describe('Roadmap intake API', () => {
  const createdTaskIds: string[] = [];
  const createdProjectIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    for (const id of createdProjectIds) {
      await request.delete(`${API}/api/projects/${id}`).catch(() => {});
    }
    createdTaskIds.length = 0;
    createdProjectIds.length = 0;
  });

  test('previews versioned roadmap text and rejects ambiguous input without creating tasks', async ({ request }) => {
    const beforeRes = await request.get(`${API}/api/tasks`);
    const beforeCount = (await beforeRes.json()).length;

    const previewRes = await request.post(`${API}/api/roadmap-intake/preview`, {
      data: {
        text: `
v0.40 - Parser and preview
- deterministic split

v0.41 - Kanban creation
- submit accepted cards
        `,
      },
    });
    expect(previewRes.status()).toBe(200);
    const preview = await previewRes.json();
    expect(preview.tasks.map((task: any) => task.title)).toEqual([
      '01. v0.40: Parser and preview',
      '02. v0.41: Kanban creation',
    ]);

    const ambiguousRes = await request.post(`${API}/api/roadmap-intake/preview`, {
      data: { text: 'Please make the next release better.' },
    });
    expect(ambiguousRes.status()).toBe(400);
    await expect(ambiguousRes.json()).resolves.toMatchObject({
      error: expect.stringMatching(/clear task boundaries/i),
    });

    const afterRes = await request.get(`${API}/api/tasks`);
    expect((await afterRes.json()).length).toBe(beforeCount);
  });

  test('creates accepted preview cards through task batch with project binding and stable order', async ({ request }) => {
    const project = await createProject(request, `Roadmap API Project ${Date.now()}`);
    createdProjectIds.push(project.id);

    const previewRes = await request.post(`${API}/api/roadmap-intake/preview`, {
      data: {
        projectId: project.id,
        text: `
1. Add intake dialog
2. Persist accepted roadmap cards
3. Verify project defaults
        `,
      },
    });
    expect(previewRes.status()).toBe(200);
    const preview = await previewRes.json();

    const createRes = await request.post(`${API}/api/tasks/batch`, {
      data: {
        tasks: preview.tasks.map((task: any) => ({
          title: task.title,
          description: task.description,
          columnId: 'backlog',
          projectId: project.id,
        })),
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()).tasks;
    createdTaskIds.push(...created.map((task: any) => task.id));
    expect(created.map((task: any) => task.title)).toEqual(preview.tasks.map((task: any) => task.title));
    expect(created.map((task: any) => task.projectId)).toEqual([project.id, project.id, project.id]);
    expect(created.map((task: any) => task.repoPath)).toEqual([project.repoPath, project.repoPath, project.repoPath]);
    expect(created[0]).toMatchObject({
      priority: 'high',
      agentType: 'claude',
      baseBranch: 'develop',
      useWorktree: true,
    });
    expect(created[0].createdAt).toBeLessThan(created[1].createdAt);
    expect(created[1].createdAt).toBeLessThan(created[2].createdAt);

    const tasksRes = await request.get(`${API}/api/tasks?projectId=${encodeURIComponent(project.id)}`);
    const tasks = await tasksRes.json();
    expect(tasks.filter((task: any) => createdTaskIds.includes(task.id)).map((task: any) => task.id)).toEqual(createdTaskIds);
  });

  test('preserves exact identifiers in generated preview titles and source descriptions', async ({ request }) => {
    const previewRes = await request.post(`${API}/api/roadmap-intake/preview`, {
      data: {
        text: `
- Create ROADMAP_PIPELINE_SMOKE.md
- Validate --dry-run behavior
- Read SOME_ENV_VAR before launch
- Update src/foo_bar.ts
- Pin package/name@1.2.3
- Write normal prose title
        `,
      },
    });
    expect(previewRes.status()).toBe(200);
    const preview = await previewRes.json();
    expect(preview.tasks.map((task: any) => task.title)).toEqual([
      '01. Create ROADMAP_PIPELINE_SMOKE.md',
      '02. Validate --dry-run behavior',
      '03. Read SOME_ENV_VAR before launch',
      '04. Update src/foo_bar.ts',
      '05. Pin package/name@1.2.3',
      '06. Write normal prose title',
    ]);
    expect(preview.tasks[0].description).toBe('Source roadmap item:\n\n- Create ROADMAP_PIPELINE_SMOKE.md');
    expect(preview.tasks[3].sourceText).toBe('- Update src/foo_bar.ts');
  });
});

test.describe('Roadmap intake UI', () => {
  const createdTaskIds: string[] = [];
  const createdProjectIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    for (const id of createdProjectIds) {
      await request.delete(`${API}/api/projects/${id}`).catch(() => {});
    }
    createdTaskIds.length = 0;
    createdProjectIds.length = 0;
  });

  test('previews editable cards and creates accepted backlog tasks', async ({ page, request }) => {
    const stamp = Date.now();
    await page.goto('/');
    await waitForBoard(page);

    await page.getByRole('button', { name: 'Roadmap Intake' }).click();
    await expect(page.getByRole('heading', { name: 'Roadmap Intake' })).toBeVisible();
    await page.getByLabel('Roadmap text').fill(`
- Build intake parser ${stamp}
- Add preview UI ${stamp}
- Wire batch creation ${stamp}
    `);
    await page.getByRole('button', { name: 'Preview Cards' }).click();
    await expect(page.getByLabel('Title for roadmap item 1')).toHaveValue(`01. Build intake parser ${stamp}`);
    await page.getByLabel('Title for roadmap item 1').fill(`01. Edited intake parser ${stamp}`);
    await page.getByRole('button', { name: 'Remove roadmap item 2' }).click();
    await page.getByRole('button', { name: /Create 2 Cards/ }).click();
    await expect(page.getByRole('heading', { name: 'Roadmap Intake' })).not.toBeVisible({ timeout: 5_000 });

    await expect(page.getByRole('heading', { name: `01. Edited intake parser ${stamp}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: `03. Wire batch creation ${stamp}` })).toBeVisible();

    const tasks = await (await request.get(`${API}/api/tasks`)).json();
    const created = tasks.filter((task: any) => task.title.includes(String(stamp)));
    createdTaskIds.push(...created.map((task: any) => task.id));
    expect(created.map((task: any) => task.columnId)).toEqual(['backlog', 'backlog']);
    expect(created.map((task: any) => task.title)).toEqual([
      `01. Edited intake parser ${stamp}`,
      `03. Wire batch creation ${stamp}`,
    ]);
  });

  test('start now submits normal in-progress autoRun task definitions for the selected project', async ({ page, request }) => {
    const project = await createProject(request, `Roadmap UI Project ${Date.now()}`);
    createdProjectIds.push(project.id);

    let batchPayload: any;
    await page.route('**/api/tasks/batch', async (route) => {
      batchPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.goto(`/projects/${encodeURIComponent(project.id)}`);
    await waitForBoard(page);
    await page.getByRole('button', { name: 'Roadmap Intake' }).click();
    await page.getByLabel('Roadmap text').fill(`
- Build auto-run payload
- Use selected project path
    `);
    await page.getByRole('button', { name: 'Preview Cards' }).click();
    await expect(page.getByLabel('Title for roadmap item 1')).toHaveValue('01. Build auto-run payload');
    await page.getByLabel('Destination').selectOption('run');
    await page.getByLabel('Agent').selectOption('codex');
    await page.getByRole('button', { name: /Create 2 Cards/ }).click();

    expect(batchPayload.tasks).toHaveLength(2);
    expect(batchPayload.tasks.map((task: any) => task.columnId)).toEqual(['in-progress', 'in-progress']);
    expect(batchPayload.tasks.map((task: any) => task.autoRun)).toEqual([true, true]);
    expect(batchPayload.tasks.map((task: any) => task.agentType)).toEqual(['codex', 'codex']);
    expect(batchPayload.tasks.map((task: any) => task.projectId)).toEqual([project.id, project.id]);
    expect(batchPayload.tasks.map((task: any) => task.repoPath)).toEqual([project.repoPath, project.repoPath]);
  });
});
