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
      'v0.40: Parser and preview',
      'v0.41: Kanban creation',
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
          dependsOnTaskIndexes: task.dependsOnTaskIndexes,
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

    const secondRelationshipsRes = await request.get(`${API}/api/tasks/${created[1].id}/relationships`);
    expect(secondRelationshipsRes.status()).toBe(200);
    const secondRelationships = await secondRelationshipsRes.json();
    expect(secondRelationships.filter((relationship: any) => relationship.type === 'blocks').map((relationship: any) => ({
      relatedTaskId: relationship.relatedTaskId,
      direction: relationship.direction,
    }))).toEqual([
      { relatedTaskId: created[0].id, direction: 'blocked-by' },
      { relatedTaskId: created[2].id, direction: 'blocks' },
    ]);

    const tasksRes = await request.get(`${API}/api/tasks?projectId=${encodeURIComponent(project.id)}`);
    const tasks = await tasksRes.json();
    expect(tasks.filter((task: any) => createdTaskIds.includes(task.id)).map((task: any) => task.id)).toEqual(createdTaskIds);
  });

  test('humanizes generated preview titles while preserving exact identifiers in source descriptions', async ({ request }) => {
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
      '01. Create roadmap pipeline smoke',
      '02. Validate dry run behavior',
      '03. Read some env var before launch',
      '04. Update foo bar',
      '05. Pin package name',
      '06. Write normal prose title',
    ]);
    expect(preview.tasks[0].description).toBe('Source roadmap item:\n\n- Create ROADMAP_PIPELINE_SMOKE.md');
    expect(preview.tasks[3].sourceText).toBe('- Update src/foo_bar.ts');
  });

  test('summarizes long versioned roadmap preview titles and keeps source text exact', async ({ request }) => {
    const source = 'v0.1 - Improve Roadmap Intake card titles so generated titles are concise and readable while preserving exact identifiers in the source description.';
    const previewRes = await request.post(`${API}/api/roadmap-intake/preview`, {
      data: { text: source },
    });
    expect(previewRes.status()).toBe(200);
    const preview = await previewRes.json();
    expect(preview.tasks[0].title).toBe('v0.1: Improve Roadmap Intake card titles');
    expect(preview.tasks[0].description).toBe(`Source roadmap item:\n\n${source}`);
  });
});

test.describe('Roadmap intake UI', () => {
  const createdTaskIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdProjectIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    for (const id of createdGroupIds) {
      await request.delete(`${API}/api/groups/${id}`).catch(() => {});
    }
    for (const id of createdProjectIds) {
      await request.delete(`${API}/api/projects/${id}`).catch(() => {});
    }
    createdTaskIds.length = 0;
    createdGroupIds.length = 0;
    createdProjectIds.length = 0;
  });

  test('previews editable cards and creates accepted backlog tasks', async ({ page, request }) => {
    const stamp = Date.now();
    await page.goto('/');
    await waitForBoard(page);

    await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
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

  test('shows roadmap-level progress across project cards', async ({ page, request }) => {
    const stamp = Date.now();
    const project = await createProject(request, `Roadmap Progress Project ${stamp}`);
    createdProjectIds.push(project.id);

    const createTask = async (title: string) => {
      const res = await request.post(`${API}/api/tasks`, {
        data: {
          title,
          description: 'Roadmap progress fixture',
          columnId: 'backlog',
          projectId: project.id,
        },
      });
      expect(res.status()).toBe(201);
      const task = await res.json();
      createdTaskIds.push(task.id);
      return task;
    };

    const done = await createTask(`01. Completed progress ${stamp}`);
    await request.patch(`${API}/api/tasks/${done.id}`, { data: { columnId: 'in-progress' } });
    await request.patch(`${API}/api/tasks/${done.id}`, { data: { columnId: 'review', agentStatus: 'complete' } });
    await request.patch(`${API}/api/tasks/${done.id}`, { data: { columnId: 'done', agentStatus: 'complete' } });

    const groupRes = await request.post(`${API}/api/groups`, {
      data: {
        title: `02. Running group progress ${stamp}`,
        description: 'Roadmap progress group fixture',
        maxConcurrency: 1,
        projectId: project.id,
        children: [
          { title: `Grouped child A ${stamp}`, description: 'First child' },
          { title: `Grouped child B ${stamp}`, description: 'Second child' },
        ],
      },
    });
    expect(groupRes.status()).toBe(201);
    const group = await groupRes.json();
    createdGroupIds.push(group.id);
    await request.patch(`${API}/api/tasks/${group.children[0].id}`, { data: { agentStatus: 'executing' } });

    const review = await createTask(`03. Review progress ${stamp}`);
    await request.patch(`${API}/api/tasks/${review.id}`, { data: { columnId: 'in-progress' } });
    await request.patch(`${API}/api/tasks/${review.id}`, { data: { columnId: 'review', agentStatus: 'complete' } });

    await createTask(`04. Next progress ${stamp}`);

    await page.goto(`/projects/${encodeURIComponent(project.id)}`);
    await waitForBoard(page);

    const progress = page.getByRole('region', { name: 'Roadmap progress' });
    await expect(progress).toBeVisible();
    await expect(progress.getByLabel('Total cards')).toHaveText('4');
    await expect(progress.getByLabel('Completed cards')).toHaveText('1');
    await expect(progress.getByLabel('Current running card')).toHaveText(`02. Running group progress ${stamp}`);
    await expect(progress.getByLabel('Blocked or review card')).toHaveText(`03. Review progress ${stamp}`);
    await expect(progress.getByLabel('Next eligible card')).toHaveText(`04. Next progress ${stamp}`);
  });

  test('creates six ordered group children with full descriptions and persists manual reordering', async ({ page, request }) => {
    const project = await createProject(request, `Grouped Roadmap ${Date.now()}`);
    createdProjectIds.push(project.id);
    const names = ['Parser', 'Preview', 'Creation', 'Ordering', 'Execution', 'Validation'];
    await page.goto(`/projects/${project.id}`);
    await waitForBoard(page);
    await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
    await page.getByLabel('Creation mode').selectOption('group');
    await page.getByLabel('Roadmap text').fill(names.map((name) => `v0.54 - ${name}\n- Preserve ${name.toLowerCase()} details`).join('\n\n'));
    await page.getByRole('button', { name: 'Preview Cards' }).click();
    await expect(page.getByLabel('Group Name')).toHaveValue('v0.54');
    const groupName = `Edited milestone ${project.id}`;
    await page.getByLabel('Group Name').fill(groupName);
    const descriptions: string[] = [];
    for (let index = 0; index < names.length; index++) {
      // Plain titles deliberately avoid prefixes: the ordering model must carry the order.
      await page.getByLabel(`Title for roadmap item ${index + 1}`).fill(names[index]);
      descriptions.push(await page.getByLabel(`Description for roadmap item ${index + 1}`).inputValue());
    }
    descriptions[0] = `Full source details\n${'Keep every requirement and exact identifier.\n'.repeat(180)}Final requirement survives.`;
    await page.getByLabel('Description for roadmap item 1').fill(descriptions[0]);
    await expect(page.getByRole('region', { name: 'Group preview' })).toContainText(groupName);
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/groups') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create Group · 6 Tasks' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const group = await response.json();
    createdGroupIds.push(group.id);
    expect(group.children.map((child: any) => child.title)).toEqual(names);
    expect(group.children.map((child: any) => child.description)).toEqual(descriptions);
    expect(group.children.map((child: any) => child.groupOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const child of group.children) {
      expect(child).toMatchObject({ groupId: group.id, projectId: project.id, repoPath: project.repoPath, agentType: 'claude', priority: 'high', baseBranch: 'develop', useWorktree: true });
    }
    const groups = await (await request.get(`${API}/api/groups?projectId=${project.id}`)).json();
    expect(groups.map((entry: any) => entry.id)).toEqual([group.id]);
    const loose = await (await request.get(`${API}/api/tasks?projectId=${project.id}`)).json();
    expect(loose.filter((task: any) => !task.groupId)).toEqual([]);
    await page.getByRole('heading', { name: groupName, exact: true }).click();
    await expect(page.getByTestId('group-child')).toHaveCount(6);
    await expect(page.getByText('0/6 complete', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Move Preview up', exact: true }).click();
    await expect(page.getByTestId('group-child').first()).toContainText('Preview');
    const persisted = await (await request.get(`${API}/api/groups/${group.id}`)).json();
    expect(persisted.children.map((child: any) => child.title)).toEqual(['Preview', 'Parser', ...names.slice(2)]);
    await page.reload();
    await waitForBoard(page);
    await page.getByRole('heading', { name: groupName, exact: true }).click();
    await expect(page.getByTestId('group-child').first()).toContainText('Preview');
  });

  test('group execution modes preserve the selected agent and project without artificial dependencies', async ({ page, request }) => {
    const project = await createProject(request, `Group Modes ${Date.now()}`);
    createdProjectIds.push(project.id);
    const payloads: any[] = [];
    await page.route('**/api/groups', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const payload = route.request().postDataJSON();
      payloads.push(payload);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...payload, id: `mock-${payloads.length}`, columnId: 'backlog', children: [] }) });
    });
    await page.goto(`/projects/${project.id}`);
    await waitForBoard(page);
    for (const mode of ['first-card', 'full-roadmap']) {
      await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
      await page.getByLabel('Creation mode').selectOption('group');
      await page.getByLabel('Roadmap text').fill('- Build parser\n- Build preview');
      await page.getByRole('button', { name: 'Preview Cards' }).click();
      await expect(page.getByLabel('Title for roadmap item 1')).toHaveValue('Build parser');
      await page.getByLabel('Group Name').fill(`Group ${mode}`);
      await page.getByLabel('Execution mode').selectOption(mode);
      await page.getByLabel('Agent', { exact: true }).selectOption('codex');
      await page.getByRole('button', { name: 'Create Group · 2 Tasks' }).click();
      await expect(page.getByRole('dialog', { name: 'Roadmap Intake' })).not.toBeVisible();
    }
    expect(payloads.map((payload) => payload.roadmapExecutionMode)).toEqual(['first-card', 'full-roadmap']);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ maxConcurrency: 1, projectId: project.id, repoPath: project.repoPath });
      expect(payload.children).toHaveLength(2);
      expect(payload.children.map((child: any) => child.agentType)).toEqual(['codex', 'codex']);
      expect(payload.children.every((child: any) => !child.dependsOnTaskIndexes?.length)).toBe(true);
    }
  });

  test('group preview and creation controls remain reachable on a narrow mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await waitForBoard(page);
    await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
    await page.getByLabel('Creation mode').selectOption('group');
    await page.getByLabel('Roadmap text').fill('- Parser\n- Preview\n- Creation\n- Ordering\n- Execution\n- Validation');
    await page.getByRole('button', { name: 'Preview Cards' }).click();
    await page.getByLabel('Group Name').fill('Mobile milestone');
    await page.getByLabel('Title for roadmap item 6').scrollIntoViewIfNeeded();
    await expect(page.getByLabel('Title for roadmap item 6')).toBeVisible();
    const create = page.getByRole('button', { name: 'Create Group · 6 Tasks' });
    await create.scrollIntoViewIfNeeded();
    await expect(create).toBeEnabled();
    const bounds = await page.getByRole('dialog', { name: 'Roadmap Intake' }).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  });

  test('execution mode submits first-card and full-roadmap payloads for the selected project', async ({ page, request }) => {
    const project = await createProject(request, `Roadmap UI Project ${Date.now()}`);
    createdProjectIds.push(project.id);

    const batchPayloads: any[] = [];
    await page.route('**/api/tasks/batch', async (route) => {
      batchPayloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      });
    });

    await page.goto(`/projects/${encodeURIComponent(project.id)}`);
    await waitForBoard(page);
    await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
    await page.getByLabel('Roadmap text').fill(`
- Build first-card payload
- Use selected project path
    `);
    await page.getByRole('button', { name: 'Preview Cards' }).click();
    await expect(page.getByLabel('Title for roadmap item 1')).toHaveValue('01. Build first card payload');
    await page.getByLabel('Execution mode').selectOption('first-card');
    await page.getByLabel('Agent').selectOption('codex');
    await page.getByRole('button', { name: /Create 2 Cards/ }).click();

    await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
    await page.getByLabel('Roadmap text').fill(`
- Build full-roadmap payload
- Queue dependent card
    `);
    await page.getByRole('button', { name: 'Preview Cards' }).click();
    await expect(page.getByLabel('Title for roadmap item 1')).toHaveValue('01. Build full roadmap payload');
    await page.getByLabel('Execution mode').selectOption('full-roadmap');
    await page.getByLabel('Agent').selectOption('codex');
    await page.getByRole('button', { name: /Create 2 Cards/ }).click();

    expect(batchPayloads).toHaveLength(2);
    expect(batchPayloads[0].tasks).toHaveLength(2);
    expect(batchPayloads[0].tasks.map((task: any) => task.columnId)).toEqual(['in-progress', 'backlog']);
    expect(batchPayloads[0].tasks.map((task: any) => task.autoRun)).toEqual([true, undefined]);
    expect(batchPayloads[0].tasks.map((task: any) => task.agentType)).toEqual(['codex', 'codex']);
    expect(batchPayloads[0].tasks.map((task: any) => task.projectId)).toEqual([project.id, project.id]);
    expect(batchPayloads[0].tasks.map((task: any) => task.repoPath)).toEqual([project.repoPath, project.repoPath]);
    expect(batchPayloads[0].tasks.map((task: any) => task.dependsOnTaskIndexes)).toEqual([undefined, [0]]);

    expect(batchPayloads[1].tasks).toHaveLength(2);
    expect(batchPayloads[1].tasks.map((task: any) => task.columnId)).toEqual(['in-progress', 'backlog']);
    expect(batchPayloads[1].tasks.map((task: any) => task.autoRun)).toEqual([true, true]);
    expect(batchPayloads[1].tasks.map((task: any) => task.agentType)).toEqual(['codex', 'codex']);
    expect(batchPayloads[1].tasks.map((task: any) => task.projectId)).toEqual([project.id, project.id]);
    expect(batchPayloads[1].tasks.map((task: any) => task.repoPath)).toEqual([project.repoPath, project.repoPath]);
    expect(batchPayloads[1].tasks.map((task: any) => task.dependsOnTaskIndexes)).toEqual([undefined, [0]]);
  });
});
