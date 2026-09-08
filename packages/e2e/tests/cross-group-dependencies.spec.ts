import { test, expect } from '@playwright/test';
import { API, waitForBoard, prepareTestRepo, cleanupTestPath, git } from './helpers';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test.describe(`Cross-group editor ${viewport.width}px`, () => {
    test.use({ viewport });
    test('adds a stable-ID synchronization gate and updates failure status without refresh', async ({ page, request }) => {
      const groups: string[] = [];
      try {
        const create = async (title: string, prefix: string) => {
          const response = await request.post(`${API}/api/groups`, { data: { title, maxConcurrency: 2, children: [1, 2].map(n => ({ title: `${prefix}${n}`, useWorktree: false })) } });
          expect(response.ok()).toBeTruthy();
          const group = await response.json(); groups.push(group.id); return group;
        };
        const a = await create('Dependency Base Building', 'Base');
        const b = await create('Dependency Crafting', 'Craft');
        await page.goto('/'); await waitForBoard(page);
        await page.getByRole('heading', { name: b.title, exact: true }).click();
        const child = page.getByTestId('group-child').filter({ has: page.getByRole('button', { name: 'Open Craft2', exact: true }) });
        await child.getByText('Edit dependencies', { exact: true }).click();
        const select = child.getByLabel('Dependency for Craft2');
        await expect(select).toBeEnabled();
        await expect(select.locator(`option[value="${b.children[1].id}"]`)).toHaveCount(0);
        await select.selectOption(a.children[1].id);
        await child.getByRole('button', { name: 'Add dependency', exact: true }).click();
        await expect(child.getByTestId('dependency-status')).toContainText('Dependency Base Building / Base2');
        await expect(child.getByTestId('dependency-status')).toContainText('Synchronization gate');
        await expect(child.getByTestId('dependency-status')).toContainText('Waiting');
        const gate = await request.get(`${API}/api/tasks/${b.children[1].id}/dependencies`);
        expect((await gate.json()).eligible).toBe(false);
        const rejected = await request.post(`${API}/api/tasks/${b.children[1].id}/run`);
        expect(rejected.ok()).toBe(false);
        expect((await request.patch(`${API}/api/tasks/${a.children[1].id}`, { data: { agentStatus: 'failed' } })).ok()).toBeTruthy();
        await expect(child.getByTestId('dependency-status')).toContainText('Failed');
        const bounds = await select.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.width).toBeGreaterThan(100);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        await child.getByRole('button', { name: 'Remove dependency Base2' }).click();
        await expect(child.getByTestId('dependency-status')).not.toContainText('Base2');
      } finally {
        for (const id of groups.reverse()) await request.delete(`${API}/api/groups/${id}`);
      }
    });
  });
}


test('two Auto Run groups overlap and unlock an integrated cross-group prerequisite', async ({ request }) => {
  test.setTimeout(60_000);
  const repoPath = prepareTestRepo(`cross-group-runtime-${Date.now()}`, { clean: true });
  let projectId: string | undefined;
  const groupIds: string[] = [];
  try {
    const response = await request.post(`${API}/api/projects`, { data: {
      name: `Synchronization ${Date.now()}`, repoPath, defaultAgentType: 'local-openai',
      defaultBaseBranch: 'main', defaultUseWorktree: true, autoRunEnabled: false,
    } });
    expect(response.status()).toBe(201); projectId = (await response.json()).id;
    const create = async (prefix: string) => {
      const response = await request.post(`${API}/api/groups`, { data: {
        projectId, title: `Synchronization group ${prefix}`, repoPath, baseBranch: 'main', maxConcurrency: 2,
        children: [1, 2].map(n => ({ title: `E2E Synchronization ${prefix}${n}`, agentType: 'local-openai', useWorktree: true })),
      } });
      expect(response.status()).toBe(201); const group = await response.json(); groupIds.push(group.id); return group;
    };
    const a = await create('A'); const b = await create('B');
    for (const [dependent, prerequisite] of [[a.children[1], a.children[0]], [b.children[1], a.children[1]]]) {
      expect((await request.post(`${API}/api/tasks/${dependent.id}/relationships`, { data: { relatedTaskId: prerequisite.id, type: 'blocks', direction: 'blocked-by' } })).ok()).toBeTruthy();
    }
    expect((await request.patch(`${API}/api/projects/${projectId}`, { data: { autoRunEnabled: true } })).ok()).toBeTruthy();
    // Explicitly request both queues as well; root agents may run concurrently,
    // while later wakeups must happen automatically after successful integration.
    for (const id of groupIds) expect((await request.post(`${API}/api/groups/${id}/run`)).ok()).toBeTruthy();
    const getChildren = async (id: string) => (await (await request.get(`${API}/api/groups/${id}`)).json()).children;
    await expect.poll(async () => {
      const children = await getChildren(b.id);
      return children[0].agentStatus;
    }, { timeout: 15_000 }).toBe('executing');
    const gated = (await getChildren(b.id))[1];
    expect(gated.columnId).toBe('backlog'); expect(gated.worktreePath).toBeFalsy(); expect(gated.runClaimedAt).toBeFalsy();
    await expect.poll(async () => {
      const children = [...await getChildren(a.id), ...await getChildren(b.id)];
      return children.every(child => child.columnId === 'done' && child.agentStatus === 'complete');
    }, { timeout: 40_000, intervals: [250, 500] }).toBe(true);
    const output = (step: string) => JSON.parse(git(['show', `main:src/synchronization-${step}.json`], repoPath));
    const firstA = output('A1'); const firstB = output('B1');
    expect(Math.max(firstA.startedAt, firstB.startedAt)).toBeLessThan(Math.min(firstA.finishedAt, firstB.finishedAt));
    const a2Commit = git(['log', '-1', '--format=%H', '--', 'src/synchronization-A2.json'], repoPath).trim();
    git(['merge-base', '--is-ancestor', a2Commit, output('B2').baseline], repoPath);
  } finally {
    for (const id of groupIds.reverse()) await request.delete(`${API}/api/groups/${id}`);
    if (projectId) await request.delete(`${API}/api/projects/${projectId}`);
    cleanupTestPath(repoPath);
  }
});
