import { test, expect } from '@playwright/test';
import { API, prepareTestRepo } from './helpers';

test.describe('Pending group configuration', () => {
  let groupId: string;

  test.beforeEach(async ({ page }) => {
    // Configuration does not execute agents; deterministic discovery for the selector.
    await page.route('**/api/agents', route => route.fulfill({ json: [
      { name: 'copilot', displayName: 'Copilot', available: true },
      { name: 'codex', displayName: 'Codex', available: true },
    ] }));
  });

  test.afterEach(async ({ request }) => {
    if (groupId) await request.delete(`${API}/api/groups/${groupId}`);
    groupId = '';
  });

  test('a child starting while the editor is open rejects the bulk change without modifying other children', async ({ page, request }) => {
    const response = await request.post(`${API}/api/groups`, { data: {
      title: 'Stale configuration', maxConcurrency: 1,
      children: [
        { title: 'Pending one', agentType: 'copilot' },
        { title: 'Pending two', agentType: 'codex' },
        { title: 'Needs intervention', agentType: 'copilot' },
      ],
    } });
    expect(response.status()).toBe(201);
    const original = await response.json();
    groupId = original.id;
    expect((await request.patch(`${API}/api/tasks/${original.children[2].id}`, { data: { agentStatus: 'failed' } })).ok()).toBeTruthy();
    await page.goto('/');
    const card = page.locator('div.group.relative').filter({ has: page.getByRole('heading', { name: 'Stale configuration', exact: true }) });
    await card.getByRole('button', { name: 'Edit group' }).click();
    await page.getByLabel('Pending agent', { exact: true }).selectOption('codex');
    await expect(page.getByText('2 pending child tasks will be affected.', { exact: true })).toBeVisible();
    expect((await request.patch(`${API}/api/tasks/${original.children[0].id}`, { data: { agentStatus: 'executing' } })).ok()).toBeTruthy();
    const before = await (await request.get(`${API}/api/groups/${groupId}`)).json();
    await page.getByRole('button', { name: 'Apply to 2 pending tasks', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('no longer pending');
    await expect(page.getByRole('heading', { name: 'Edit Task Group' })).toBeVisible();
    expect(await (await request.get(`${API}/api/groups/${groupId}`)).json()).toEqual(before);
  });

  for (const mobile of [false, true]) {
    test(`reconfigures six roadmap children and selected mixed children on ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }) => {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      const response = await request.post(`${API}/api/groups`, { data: {
        title: 'Reconfigure roadmap', roadmapExecutionMode: 'backlog', maxConcurrency: 1,
        repoPath: prepareTestRepo('group-reconfigure'), baseBranch: 'main',
        children: Array.from({ length: 6 }, (_, i) => ({
          title: `Milestone ${i + 1}`, description: `## Detailed instructions ${i + 1}\n\nPreserve this text exactly.\n`,
          agentType: 'copilot', useWorktree: false, dependsOnTaskIndexes: i ? [i - 1] : [],
        })),
      } });
      expect(response.status()).toBe(201);
      const original = await response.json();
      groupId = original.id;
      const relationships = await Promise.all(original.children.map(async (child: { id: string }) =>
        (await request.get(`${API}/api/tasks/${child.id}/relationships`)).json()));

      await page.goto('/');
      const card = page.locator('div.group.relative').filter({ has: page.getByRole('heading', { name: 'Reconfigure roadmap', exact: true }) });
      await card.getByRole('button', { name: 'Edit group' }).click();
      await expect(page.getByRole('heading', { name: 'Edit Task Group' })).toBeVisible();
      await page.getByLabel('Pending agent', { exact: true }).selectOption('codex');
      await page.getByLabel('Pending priority', { exact: true }).selectOption('high');
      await page.getByLabel('Change timeout', { exact: true }).check();
      await page.getByLabel('Timeout (minutes)', { exact: true }).fill('45');
      await page.getByRole('button', { name: 'Apply to 6 pending tasks', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edit Task Group' })).not.toBeVisible();
      await expect(card.getByText('Codex (6)', { exact: true }).first()).toBeVisible();

      const updated = await (await request.get(`${API}/api/groups/${groupId}`)).json();
      expect(updated.children).toEqual(original.children.map((child: object) => ({ ...child, agentType: 'codex', priority: 'high', timeoutMinutes: 45 })));
      expect({ ...updated, children: [] }).toEqual({ ...original, children: [] });
      const afterRelationships = await Promise.all(original.children.map(async (child: { id: string }) =>
        (await request.get(`${API}/api/tasks/${child.id}/relationships`)).json()));
      // Relationship responses also embed related task metadata; compare the durable edges.
      const edges = (sets: any[][]) => sets.map(rows => rows.map(({ taskId, relatedTaskId, type, direction, createdAt }) => ({ taskId, relatedTaskId, type, direction, createdAt })));
      expect(edges(afterRelationships)).toEqual(edges(relationships));

      await card.getByRole('button', { name: 'Edit group' }).click();
      await page.getByLabel('Apply to', { exact: true }).selectOption('selected');
      await page.getByLabel('Milestone 2', { exact: true }).check();
      await page.getByLabel('Milestone 5', { exact: true }).check();
      await page.getByLabel('Pending agent', { exact: true }).selectOption('copilot');
      await page.getByRole('button', { name: 'Apply to 2 pending tasks', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edit Task Group' })).not.toBeVisible();
      await expect(card.getByText('Codex (4)', { exact: true }).first()).toBeVisible();
      await expect(card.getByText('Copilot (2)', { exact: true }).first()).toBeVisible();
      const selected = await (await request.get(`${API}/api/groups/${groupId}`)).json();
      expect(selected.children).toEqual(updated.children.map((child: object, i: number) => ({ ...child, agentType: i === 1 || i === 4 ? 'copilot' : 'codex' })));
    });
  }
});
