import { test, expect, type Page, type Route } from '@playwright/test';
import { API, fillLocalPath, waitForBoard } from './helpers';

// Helper to open the create task dialog
async function openCreateDialog(page: Page) {
  const backlogHeading = page.getByRole('heading', { name: 'Backlog', exact: true });
  const headerRow = backlogHeading.locator('..').locator('..');
  const addButton = headerRow.locator('button').first();
  await addButton.click();
  await expect(page.getByRole('heading', { name: 'Create Task' })).toBeVisible();
}

// Helper to create a task — returns task ID via API lookup
async function createTask(page: Page, title: string, description = 'Test description'): Promise<string> {
  await openCreateDialog(page);
  await page.getByPlaceholder('What needs to be done?').fill(title);
  await page.getByPlaceholder('Describe the task for the selected agent...').fill(description);
  // Local path is required
  await fillLocalPath(page);
  await page.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.getByRole('heading', { name: 'Create Task' })).not.toBeVisible({ timeout: 3_000 });
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 5_000 });
  const id = await page.evaluate(async (t) => {
    const res = await fetch('/api/tasks');
    const tasks = await res.json();
    return tasks.find((tk: any) => tk.title === t)?.id ?? null;
  }, title);
  return id as string;
}

test.describe('Kanban Board', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);
  });

  test('renders all four columns', async ({ page }) => {
    for (const col of ['Backlog', 'In Progress', 'Review', 'Done']) {
      await expect(page.getByRole('heading', { name: col, exact: true })).toBeVisible();
    }
  });

  test('shows app title', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'AI Agent Board' })).toBeVisible();
  });

  test('has theme toggle button', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Toggle theme' })).toBeVisible();
  });
});

test.describe('Task CRUD', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('create a new task', async ({ page }) => {
    const ts = Date.now();
    const taskTitle = `E2E Task ${ts}`;
    const taskDesc = `Automated test description ${ts}`;
    const id = await createTask(page, taskTitle, taskDesc);
    createdTaskIds.push(id);
    await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible();
    await expect(page.getByText(taskDesc).first()).toBeVisible();
  });

  test('create task dialog opens and closes', async ({ page }) => {
    await openCreateDialog(page);
    await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByPlaceholder('What needs to be done?')).not.toBeVisible({ timeout: 2_000 });
  });

  test('create task requires title', async ({ page }) => {
    await openCreateDialog(page);
    const createButton = page.getByRole('button', { name: 'Create Task' });
    await expect(createButton).toBeDisabled();
    await page.getByPlaceholder('What needs to be done?').fill('Valid Task');
    await expect(createButton).toBeEnabled();
    // Close without submitting
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('click task to open agent panel', async ({ page }) => {
    const taskTitle = `Panel Task ${Date.now()}`;
    const taskId = await createTask(page, taskTitle);
    createdTaskIds.push(taskId);

    await page.evaluate(async (id) => {
      await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: 'in-progress' }),
      });
    }, taskId);

    await page.reload();
    await waitForBoard(page);
    await page.getByRole('heading', { name: taskTitle }).click();
    await expect(page.getByRole('button', { name: 'Run agent' })).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('No agent activity yet')).toBeVisible();
  });

  test('Summary tab appears for review tasks and opens by default', async ({ page }) => {
    const taskTitle = `Review Panel ${Date.now()}`;
    const taskId = await createTask(page, taskTitle);
    createdTaskIds.push(taskId);

    // Move backlog -> in-progress -> review via valid transitions
    await page.evaluate(async (id) => {
      const patch = (body: unknown) =>
        fetch(`/api/tasks/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      await patch({ columnId: 'in-progress' });
      await patch({ columnId: 'review' });
    }, taskId);

    await page.reload();
    await waitForBoard(page);
    await page.getByRole('heading', { name: taskTitle }).click();

    // Summary tab is present and selected by default (empty-state visible)
    await expect(page.getByRole('button', { name: 'Summary', exact: true })).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('No summary was provided for this task.')).toBeVisible();
  });

  test('Copy Result copies clean task summary without event noise', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const taskTitle = `Copy Result Task ${Date.now()}`;
    const taskId = `copy-result-${Date.now()}`;
    const task = {
      id: taskId,
      projectId: 'default',
      title: taskTitle,
      description: 'Task with persisted result summary',
      priority: 'medium',
      columnId: 'review',
      agentStatus: 'complete',
      agentType: 'codex',
      createdAt: Date.now(),
      completedAt: Date.now(),
      summary: [
        '## Completed',
        '- Added the copy action.',
        '- Verified the copied text stays clean.',
        '',
        '## Comments',
        'Ready for review.',
        '',
        '## Remaining',
        'None.',
      ].join('\n'),
    };
    const eventNoise = 'terminal/event noise should not be copied';

    await page.route('**/api/projects', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'default', name: 'Default', isDefault: true, createdAt: 1, updatedAt: 1 }]),
    }));
    await page.route('**/api/projects/config', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cloneRoot: '/tmp' }),
    }));
    await page.route('**/api/tasks?*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([task]),
    }));
    await page.route(`**/api/tasks/${taskId}/events`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'event-noise',
        taskId,
        type: 'command_output',
        content: eventNoise,
        timestamp: Date.now(),
      }]),
    }));
    await page.route(`**/api/tasks/${taskId}/git-info`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hasRemote: false, mergeReady: true }),
    }));

    await page.goto('/');
    await waitForBoard(page);
    await page.getByRole('heading', { name: taskTitle }).click();

    const copyButton = page.getByRole('button', { name: 'Copy Result', exact: true });
    await expect(copyButton).toBeVisible({ timeout: 3_000 });
    await copyButton.click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();

    const copiedText = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedText).toBe([
      `Title: ${taskTitle}`,
      'Status: Review / Complete',
      '',
      'Completed:',
      '- Added the copy action.',
      '- Verified the copied text stays clean.',
      '',
      'Comments:',
      'Ready for review.',
      '',
      'Remaining:',
      'None.',
    ].join('\n'));
    expect(copiedText).not.toContain(eventNoise);
  });

  for (const agentCase of [
    { label: 'Codex', agentType: 'codex' },
    { label: 'DeepSeek', agentType: 'local-openai' },
    { label: 'Qwen', agentType: 'local-openai' },
  ] as const) {
    test(`mocked ${agentCase.label} command lifecycle renders in Events, Terminal, and Changes`, async ({ page }) => {
      const taskTitle = `${agentCase.label} Events Task ${Date.now()}`;
      const taskId = `${agentCase.label.toLowerCase()}-events-${Date.now()}`;
      const task = {
        id: taskId,
        projectId: 'default',
        title: taskTitle,
        description: `Task with mocked ${agentCase.label} normalized operational events`,
        priority: 'medium',
        columnId: 'in-progress',
        agentStatus: 'executing',
        agentType: agentCase.agentType,
        createdAt: Date.now(),
        repoPath: '/tmp/repo',
      };
      const now = Date.now();
      const events = [
        {
          id: `${agentCase.label}-command-test`,
          taskId,
          type: 'command',
          content: 'bash: {"command":"pytest tests/test_workbench.py"}',
          timestamp: now,
          metadata: { agentType: agentCase.agentType, callId: 'call-1', toolName: 'bash', command: 'pytest tests/test_workbench.py', state: 'running' },
        },
        {
          id: `${agentCase.label}-output-running`,
          taskId,
          type: 'command_output',
          content: '\x1b[32mcollected 3 items\x1b[0m\n',
          timestamp: now + 1,
          metadata: { agentType: agentCase.agentType, callId: 'call-1', toolName: 'bash', command: 'pytest tests/test_workbench.py', state: 'running' },
        },
        {
          id: `${agentCase.label}-output-succeeded`,
          taskId,
          type: 'command_output',
          content: '3 passed\n',
          timestamp: now + 2,
          metadata: { agentType: agentCase.agentType, callId: 'call-1', toolName: 'bash', command: 'pytest tests/test_workbench.py', state: 'succeeded' },
        },
        {
          id: `${agentCase.label}-command-build`,
          taskId,
          type: 'command',
          content: 'bash: {"command":"npm run build:server"}',
          timestamp: now + 3,
          metadata: { agentType: agentCase.agentType, callId: 'call-2', toolName: 'bash', command: 'npm run build:server', state: 'running' },
        },
        {
          id: `${agentCase.label}-output-failed`,
          taskId,
          type: 'command_output',
          content: 'server build failed\n',
          timestamp: now + 4,
          metadata: { agentType: agentCase.agentType, callId: 'call-2', toolName: 'bash', command: 'npm run build:server', state: 'failed' },
        },
        {
          id: `${agentCase.label}-read`,
          taskId,
          type: 'file_read',
          content: 'Read packages/server/src/index.ts',
          timestamp: now + 5,
          metadata: { agentType: agentCase.agentType, callId: 'call-3', toolName: 'read_file', file: 'packages/server/src/index.ts', state: 'running' },
        },
        {
          id: `${agentCase.label}-search`,
          taskId,
          type: 'command',
          content: 'search: {"command":"rg AgentPanel packages/client/src/components"}',
          timestamp: now + 6,
          metadata: { agentType: agentCase.agentType, callId: 'call-4', toolName: 'rg', command: 'rg AgentPanel packages/client/src/components', state: 'running' },
        },
        {
          id: `${agentCase.label}-edit`,
          taskId,
          type: 'file_edit',
          content: 'Edited packages/server/src/services/local-openai-provider.ts',
          timestamp: now + 7,
          metadata: { agentType: agentCase.agentType, callId: 'call-5', toolName: 'edit_file', file: 'packages/server/src/services/local-openai-provider.ts', state: 'succeeded' },
        },
        {
          id: `${agentCase.label}-test`,
          taskId,
          type: 'test_result',
          content: `Focused tests passed: ${agentCase.label} command lifecycle projection`,
          timestamp: now + 8,
          metadata: { agentType: agentCase.agentType, callId: 'call-1', toolName: 'bash', command: 'pytest tests/test_workbench.py', state: 'succeeded' },
        },
      ];

    await page.route('**/api/projects', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'default', name: 'Default', isDefault: true, createdAt: 1, updatedAt: 1 }]),
    }));
    await page.route('**/api/projects/config', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cloneRoot: '/tmp' }),
    }));
    const fulfillTasks = (route: Route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([task]),
    });
    await page.route('**/api/tasks', fulfillTasks);
    await page.route('**/api/tasks?*', fulfillTasks);
    await page.route(`**/api/tasks/${taskId}/events`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(events),
    }));
    await page.route(`**/api/tasks/${taskId}/git-info`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hasRemote: false, mergeReady: true }),
    }));

    await page.goto('/');
    await waitForBoard(page);
    await page.getByRole('heading', { name: taskTitle }).click();

    await expect(page.getByText('Started').first()).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('Running').first()).toBeVisible();
    await expect(page.getByText('Succeeded').first()).toBeVisible();
    await expect(page.getByText('Failed').first()).toBeVisible();
    await expect(page.getByText('pytest tests/test_workbench.py').first()).toBeVisible();
    await expect(page.getByText('collected 3 items')).toBeVisible();
    await expect(page.getByText('3 passed')).toBeVisible();
    await expect(page.getByText('server build failed')).toBeVisible();
    await expect(page.getByText('npm run build:server').first()).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('local-openai-provider.ts').first()).toBeVisible();
    await expect(page.getByText(`Focused tests passed: ${agentCase.label} command lifecycle projection`)).toBeVisible();
    await expect(page.getByText(/private reasoning|chain-of-thought/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect(page.getByText('$ pytest tests/test_workbench.py')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('collected 3 items')).toBeVisible();
    await expect(page.getByText('3 passed')).toBeVisible();
    await expect(page.getByText('$ npm run build:server')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('server build failed')).toBeVisible();
    await expect(page.getByText('packages/server/src/index.ts')).toBeVisible();

    await page.getByRole('button', { name: /^Changes/ }).click();
    await expect(page.getByText('pytest tests/test_workbench.py').first()).toBeVisible();
    await expect(page.getByText('npm run build:server').first()).toBeVisible();
    await expect(page.getByText('rg AgentPanel packages/client/src/components').first()).toBeVisible();
    await expect(page.getByText('packages/server/src/services/local-openai-provider.ts').first()).toBeVisible();
    await expect(page.getByText('running').first()).toBeVisible();
    await expect(page.getByText('succeeded').first()).toBeVisible();
    await expect(page.getByText('failed').first()).toBeVisible();
    await expect(page.getByText(`Focused tests passed: ${agentCase.label} command lifecycle projection`)).toBeVisible();
  });
  }

  test('repository evidence renders working-tree, committed, and no-change states', async ({ page }) => {
    const now = Date.now();
    const tasks = [
      {
        id: `repo-working-${now}`,
        title: `Repo Evidence Working ${now}`,
        description: 'Mocked task with managed worktree changes',
        priority: 'medium',
        columnId: 'in-progress',
        agentStatus: 'executing',
        agentType: 'codex',
        createdAt: now,
        projectId: 'default',
        repoPath: '/tmp/repo',
        worktreePath: '/tmp/agentboard-working-worktree',
        branchName: 'task/repo-working',
        baseBranch: 'main',
      },
      {
        id: `repo-commit-${now}`,
        title: `Repo Evidence Commit ${now}`,
        description: 'Mocked task with committed work',
        priority: 'medium',
        columnId: 'review',
        agentStatus: 'complete',
        agentType: 'codex',
        createdAt: now + 1,
        projectId: 'default',
        repoPath: '/tmp/repo',
        worktreePath: '/tmp/agentboard-commit-worktree',
        branchName: 'task/repo-commit',
        baseBranch: 'develop',
        summary: '## Completed\nCommitted work.\n',
      },
      {
        id: `repo-clean-${now}`,
        title: `Repo Evidence None ${now}`,
        description: 'Mocked task with no changes',
        priority: 'medium',
        columnId: 'in-progress',
        agentStatus: 'idle',
        agentType: 'codex',
        createdAt: now + 2,
        projectId: 'default',
        repoPath: '/tmp/repo',
        worktreePath: '/tmp/agentboard-clean-worktree',
        branchName: 'task/repo-clean',
        baseBranch: 'main',
      },
    ];
    const evidenceById: Record<string, any> = {
      [tasks[0].id]: {
        available: true,
        state: 'working_tree_changes',
        worktreePath: tasks[0].worktreePath,
        taskBranch: tasks[0].branchName,
        baseBranch: 'main',
        baseCommit: '1111111111111111111111111111111111111111',
        baseShortCommit: '1111111',
        changedFileCount: 2,
        modifiedFileCount: 1,
        untrackedFileCount: 1,
        commitsAhead: 0,
        changedFiles: [
          { path: 'packages/client/src/components/AgentPanel.tsx', status: 'M' },
          { path: 'packages/server/src/routes/git.ts', status: '??' },
        ],
      },
      [tasks[1].id]: {
        available: true,
        state: 'clean_after_commit',
        worktreePath: tasks[1].worktreePath,
        taskBranch: tasks[1].branchName,
        baseBranch: 'develop',
        baseCommit: '2222222222222222222222222222222222222222',
        baseShortCommit: '2222222',
        changedFileCount: 0,
        modifiedFileCount: 0,
        untrackedFileCount: 0,
        commitsAhead: 1,
        changedFiles: [],
        latestTaskCommit: {
          sha: 'abcdef1234567890abcdef1234567890abcdef12',
          shortSha: 'abcdef1',
          subject: 'Agent Board: repository evidence',
          authorName: 'Agent',
          authorDate: '2026-09-06T00:00:00Z',
        },
      },
      [tasks[2].id]: {
        available: true,
        state: 'no_changes',
        worktreePath: tasks[2].worktreePath,
        taskBranch: tasks[2].branchName,
        baseBranch: 'main',
        baseCommit: '3333333333333333333333333333333333333333',
        baseShortCommit: '3333333',
        changedFileCount: 0,
        modifiedFileCount: 0,
        untrackedFileCount: 0,
        commitsAhead: 0,
        changedFiles: [],
      },
    };

    await page.route('**/api/projects', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'default', name: 'Default', isDefault: true, createdAt: 1, updatedAt: 1 }]),
    }));
    await page.route('**/api/projects/config', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cloneRoot: '/tmp' }),
    }));
    const fulfillTasks = (route: Route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tasks),
    });
    await page.route('**/api/tasks', fulfillTasks);
    await page.route('**/api/tasks?*', fulfillTasks);
    await page.route('**/api/tasks/*/events', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }));
    await page.route('**/api/tasks/*/git-info', (route) => {
      const id = route.request().url().match(/\/api\/tasks\/([^/]+)\/git-info/)?.[1] ?? '';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hasRemote: false, mergeReady: true, repositoryEvidence: evidenceById[id] }),
      });
    });

    await page.goto('/');
    await waitForBoard(page);

    await page.getByRole('heading', { name: tasks[0].title }).click();
    await page.getByRole('button', { name: /^Changes/ }).click();
    await expect(page.getByText('Working-tree changes present')).toBeVisible();
    await expect(page.getByText('2').first()).toBeVisible();
    await expect(page.getByText('/tmp/agentboard-working-worktree')).toBeVisible();
    await expect(page.getByText('task/repo-working')).toBeVisible();
    await expect(page.getByText('main @ 1111111')).toBeVisible();
    await expect(page.getByText('packages/client/src/components/AgentPanel.tsx')).toBeVisible();
    await page.getByRole('button', { name: 'Copy changed file list' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('M packages/client/src/components/AgentPanel.tsx');
    await page.getByRole('button', { name: 'Close panel (Esc)' }).click();

    await page.getByRole('heading', { name: tasks[1].title }).click();
    await page.getByRole('button', { name: /^Changes/ }).click();
    await expect(page.getByText('Clean after commit')).toBeVisible();
    await expect(page.getByText('develop @ 2222222')).toBeVisible();
    await expect(page.getByText('abcdef1 Agent Board: repository evidence')).toBeVisible();
    await expect(page.getByText('No repository changes')).toBeVisible();
    await page.getByRole('button', { name: 'Close panel (Esc)' }).click();

    await page.getByRole('heading', { name: tasks[2].title }).click();
    await page.getByRole('button', { name: /^Changes/ }).click();
    await expect(page.getByText('No changes yet')).toBeVisible();
    await expect(page.getByText('Changed files')).toBeVisible();
    await expect(page.getByText('Commits ahead')).toBeVisible();
    await expect(page.getByText('No repository changes')).toBeVisible();
  });

  test('Summary tab is hidden for in-progress tasks', async ({ page }) => {
    const taskTitle = `Progress Panel ${Date.now()}`;
    const taskId = await createTask(page, taskTitle);
    createdTaskIds.push(taskId);

    await page.evaluate(async (id) => {
      await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: 'in-progress' }),
      });
    }, taskId);

    await page.reload();
    await waitForBoard(page);
    await page.getByRole('heading', { name: taskTitle }).click();

    await expect(page.getByRole('button', { name: 'Run agent' })).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: 'Summary', exact: true })).toHaveCount(0);
  });

  test('dragging task to In Progress starts the agent', async ({ page }) => {
    const taskTitle = `Drag Start Task ${Date.now()}`;
    const taskId = await createTask(page, taskTitle);
    createdTaskIds.push(taskId);

    let runRequests = 0;
    await page.route(`**/api/tasks/${taskId}/run`, async (route) => {
      runRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: taskId,
          title: taskTitle,
          description: 'Test description',
          priority: 'medium',
          columnId: 'in-progress',
          agentStatus: 'planning',
          agentType: 'copilot',
          createdAt: Date.now(),
        }),
      });
    });

    const taskCard = page.locator('[data-column="backlog"] .group').filter({
      has: page.getByRole('heading', { name: taskTitle }),
    });
    const targetColumn = page.locator('[data-column="in-progress"]');
    await taskCard.scrollIntoViewIfNeeded();

    const sourceBox = await taskCard.boundingBox();
    const targetBox = await targetColumn.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();

    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 20 });
    await page.mouse.up();

    await expect.poll(() => runRequests).toBe(1);
  });
});

test.describe('Theme Toggle', () => {
  test('toggles between dark and light mode', async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);

    const themeButton = page.getByRole('button', { name: 'Toggle theme' });
    const html = page.locator('html');
    const initialClass = await html.getAttribute('class');

    await themeButton.click();
    await page.waitForTimeout(300);
    const newClass = await html.getAttribute('class');
    expect(newClass).not.toBe(initialClass);

    await themeButton.click();
    await page.waitForTimeout(300);
    const revertedClass = await html.getAttribute('class');
    expect(revertedClass).toBe(initialClass);
  });
});

test.describe('Task Edit', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('edit button opens dialog with pre-populated data', async ({ page }) => {
    const ts = Date.now();
    const taskTitle = `Editable Task ${ts}`;
    const taskId = await createTask(page, taskTitle, 'Original description');
    createdTaskIds.push(taskId);

    const taskCard = page.locator('.group').filter({ has: page.getByRole('heading', { name: taskTitle }) });
    await taskCard.hover();
    await taskCard.getByRole('button', { name: 'Edit task' }).click();

    await expect(page.getByRole('heading', { name: 'Edit Task' })).toBeVisible();
    await expect(page.getByPlaceholder('What needs to be done?')).toHaveValue(taskTitle);
    await expect(page.getByPlaceholder('Describe the task for the selected agent...')).toHaveValue('Original description');

    const newTitle = `Edited Task ${ts}`;
    await page.getByPlaceholder('What needs to be done?').fill(newTitle);
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByRole('heading', { name: 'Edit Task' })).not.toBeVisible({ timeout: 2_000 });
    await expect(page.getByRole('heading', { name: newTitle })).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Task Priority', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('create task with high priority shows amber left border', async ({ page }) => {
    const ts = Date.now();
    const taskTitle = `Priority Task ${ts}`;

    await openCreateDialog(page);
    await page.getByPlaceholder('What needs to be done?').fill(taskTitle);
    // Local path is required
    await fillLocalPath(page);

    // Open priority dropdown within the dialog and select High
    const dialog = page.getByRole('dialog');
    // The priority dropdown button contains the emoji and label as separate elements
    // Click the button that currently shows "Medium" (the priority selector)
    const priorityButton = dialog.locator('button', { hasText: 'Medium' }).first();
    await priorityButton.click();
    await dialog.getByRole('button', { name: '🟠 High' }).click();

    await page.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByRole('heading', { name: 'Create Task' })).not.toBeVisible({ timeout: 3_000 });

    // Get the task ID for cleanup
    const id = await page.evaluate(async (t) => {
      const res = await fetch('/api/tasks');
      const tasks = await res.json();
      return tasks.find((tk: any) => tk.title === t)?.id ?? null;
    }, taskTitle);
    createdTaskIds.push(id as string);

    // Verify the task card has amber left border
    const taskCard = page.locator('.group').filter({ has: page.getByRole('heading', { name: taskTitle }) });
    await expect(taskCard).toHaveClass(/border-l-amber-500/);
  });

  test('edit task priority updates the border color', async ({ page }) => {
    const ts = Date.now();
    const taskTitle = `Edit Priority ${ts}`;
    const id = await createTask(page, taskTitle);
    createdTaskIds.push(id);

    // Default priority is medium — no visible border (medium is borderless)
    const taskCard = page.locator('.group').filter({ has: page.getByRole('heading', { name: taskTitle }) });
    await expect(taskCard).not.toHaveClass(/border-l-4/);

    // Edit task and change priority to critical
    await taskCard.hover();
    await taskCard.getByRole('button', { name: 'Edit task' }).click();
    await expect(page.getByRole('heading', { name: 'Edit Task' })).toBeVisible();

    // Open priority dropdown and select Critical
    const dialog = page.getByRole('dialog');
    const priorityButton = dialog.locator('button', { hasText: 'Medium' }).first();
    await priorityButton.click();
    await dialog.getByRole('button', { name: '🔴 Critical' }).click();

    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('heading', { name: 'Edit Task' })).not.toBeVisible({ timeout: 2_000 });

    // Verify the task card now has red left border
    await expect(taskCard).toHaveClass(/border-l-red-500/, { timeout: 3_000 });
  });
});

test.describe('Task Sorting', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('sort dropdown changes task order by priority', async ({ page, request }) => {
    // Create tasks with different priorities via API
    const tasks = [
      { title: 'Sort Low Task', priority: 'low' },
      { title: 'Sort Critical Task', priority: 'critical' },
      { title: 'Sort High Task', priority: 'high' },
    ];
    for (const t of tasks) {
      const res = await request.post(`${API}/api/tasks`, { data: { title: t.title, description: 'sort test', priority: t.priority } });
      const created = await res.json();
      createdTaskIds.push(created.id);
    }

    await page.reload();
    await waitForBoard(page);

    // Change sort to Priority ascending (critical first)
    const sortSelect = page.locator('select');
    await sortSelect.selectOption('priority');

    // Get task titles in backlog column order
    const backlog = page.locator('[data-column="backlog"]').first();
    const headings = backlog.locator('h3');
    const titles = await headings.allTextContents();

    // Filter to just our test tasks (titles include priority emoji prefix)
    const sortTitles = titles.filter(t => t.includes('Sort '));
    expect(sortTitles[0]).toContain('Sort Critical Task');
    expect(sortTitles[sortTitles.length - 1]).toContain('Sort Low Task');
  });
});

test.describe('Filter Chips', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('filter by agent type shows only matching tasks', async ({ page, request }) => {
    // Create tasks with different agent types via API
    const res1 = await request.post(`${API}/api/tasks`, { data: { title: 'Filter Claude Task', description: 'test', agentType: 'claude' } });
    const res2 = await request.post(`${API}/api/tasks`, { data: { title: 'Filter Copilot Task', description: 'test', agentType: 'copilot' } });
    createdTaskIds.push((await res1.json()).id, (await res2.json()).id);

    await page.reload();
    await waitForBoard(page);

    // Both tasks should be visible
    await expect(page.getByRole('heading', { name: 'Filter Claude Task' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Filter Copilot Task' })).toBeVisible();

    // Click Filter toggle then Claude filter chip
    await page.getByLabel('Toggle filters').click();
    await page.getByRole('button', { name: 'Claude', exact: true }).click();

    // Only Claude task should be visible
    await expect(page.getByRole('heading', { name: 'Filter Claude Task' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Filter Copilot Task' })).not.toBeVisible({ timeout: 2_000 });

    // Click Clear to reset
    await page.getByRole('button', { name: 'Clear' }).click();

    // Both visible again
    await expect(page.getByRole('heading', { name: 'Filter Claude Task' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Filter Copilot Task' })).toBeVisible();
  });
});

test.describe('Retry Failed Tasks', () => {
  let createdTaskIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    createdTaskIds = [];
    await page.goto('/');
    await waitForBoard(page);
  });

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    createdTaskIds = [];
  });

  test('retry button appears on failed tasks', async ({ page, request }) => {
    // Create a task and set it to failed via API
    const res = await request.post(`${API}/api/tasks`, {
      data: { title: 'Retry Test Task', description: 'test', columnId: 'in-progress' },
    });
    const task = await res.json();
    createdTaskIds.push(task.id);

    // Mark as failed
    await request.patch(`${API}/api/tasks/${task.id}`, {
      data: { agentStatus: 'failed' },
    });

    await page.reload();
    await waitForBoard(page);

    // Hover over the task card to reveal action buttons
    const taskCard = page.locator('.group').filter({ has: page.getByRole('heading', { name: 'Retry Test Task' }) });
    await taskCard.hover();

    // Retry button should be visible
    await expect(taskCard.getByRole('button', { name: 'Retry task' })).toBeVisible();
  });
});
