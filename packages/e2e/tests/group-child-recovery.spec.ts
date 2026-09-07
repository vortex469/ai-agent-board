import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { API, prepareTestRepo, waitForBoard } from './helpers';

for (const mobile of [false, true]) {
  test.describe(mobile ? 'Grouped recovery on touch' : 'Grouped recovery on desktop', () => {
    test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile });

    test('failed children open, reconfigure, retry and reset without selecting the group', async ({ page, request }) => {
      const repoPath = prepareTestRepo('group-recovery');
      const response = await request.post(`${API}/api/groups`, { data: {
        title: 'Recovery batch', repoPath, maxConcurrency: 1,
        children: [1, 2].map((n) => ({ title: `Failed child ${n}`, description: 'Wrong agent', agentType: 'copilot', useWorktree: false })),
      } });
      expect(response.ok()).toBeTruthy();
      const group = await response.json();
      const [child, sibling] = group.children;
      const activate = async (locator: Locator) => mobile ? locator.tap() : locator.click();
      try {
        for (const task of group.children) {
          const result = await request.patch(`${API}/api/tasks/${task.id}`, { data: { agentStatus: 'failed' } });
          expect(result.ok()).toBeTruthy();
        }
        await page.route('**/api/agents', (route) => route.fulfill({ json: [
          { name: 'copilot', available: true }, { name: 'codex', available: true },
        ] }));
        let runs = 0;
        let configuredAgent: string | undefined;
        await page.route(`**/api/tasks/${child.id}/configure`, async (route) => {
          configuredAgent = route.request().postDataJSON().agentType;
          await route.continue();
        });
        // Keep execution deterministic: exercise the real edit/reset endpoints,
        // but do not launch an external coding agent from this browser test.
        await page.route(`**/api/tasks/${child.id}/run`, async (route) => {
          runs++;
          const current = await request.get(`${API}/api/tasks/${child.id}`);
          await route.fulfill({ json: await current.json() });
        });
        await page.goto('/');
        await waitForBoard(page);
        const card = page.getByTestId('group-card-child').filter({ hasText: child.title });
        await activate(card.getByRole('button', { name: `Open ${child.title}` }));
        await expect(page.getByTitle('Reconfigure and retry')).toBeVisible();
        await expect(page.getByTestId('group-child')).toHaveCount(0);
        await activate(page.getByTitle('Reconfigure and retry'));
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog.getByPlaceholder('What needs to be done?').fill('Recovered child');
        await activate(dialog.getByRole('button', { name: 'Copilot', exact: true }));
        await activate(dialog.getByRole('button', { name: /^Codex\b/ }));
        await activate(dialog.getByRole('button', { name: 'Save Changes' }));
        await expect(dialog).toBeHidden();
        await expect.poll(async () => (await (await request.get(`${API}/api/tasks/${child.id}`)).json()).agentType).toBe('codex');
        await activate(page.getByTitle('Retry agent'));
        await expect.poll(() => runs).toBe(1);
        expect(configuredAgent).toBe('codex');
        await activate(page.getByTitle('Close panel (Esc)'));
        const row = page.getByTestId('group-child').filter({ hasText: 'Recovered child' });
        await activate(row.getByRole('button', { name: 'Retry task', exact: true }));
        await expect.poll(() => runs).toBe(2);
        await expect(row).toBeVisible();
        await activate(row.getByRole('button', { name: 'Edit task', exact: true }));
        await expect(dialog).toBeVisible();
        await activate(dialog.getByRole('button', { name: 'Save Changes' }));
        await expect(dialog).toBeHidden();
        const recoveredCard = page.getByTestId('group-card-child').filter({ hasText: 'Recovered child' });
        await activate(recoveredCard.getByRole('button', { name: 'Reset task', exact: true }));
        await expect(recoveredCard.getByRole('button', { name: 'Reset task', exact: true })).toHaveCount(0);
        await expect(page.getByTestId('group-child')).toHaveCount(0);
        const reset = await (await request.get(`${API}/api/tasks/${child.id}`)).json();
        expect(reset.agentStatus).toBe('idle');
        expect(reset.columnId).toBe('backlog');
        expect(reset.agentType).toBe('codex');
        const unchanged = await (await request.get(`${API}/api/tasks/${sibling.id}`)).json();
        expect(unchanged.agentStatus).toBe('failed');
        expect(unchanged.agentType).toBe('copilot');
        expect((await (await request.get(`${API}/api/groups/${group.id}`)).json()).columnId).toBe('backlog');
        // Exercise the compact-card retry callback independently of panel retry.
        await request.patch(`${API}/api/tasks/${child.id}`, { data: { agentStatus: 'failed' } });
        await activate(recoveredCard.getByRole('button', { name: 'Retry task', exact: true }));
        await expect.poll(() => runs).toBe(3);
        await expect(page.getByTestId('group-child')).toHaveCount(0);
        await activate(page.getByTitle('Close panel (Esc)'));
        // A failed retry can leave a child in review; reset must use a valid transition.
        expect((await request.patch(`${API}/api/tasks/${child.id}`, { data: { columnId: 'in-progress' } })).ok()).toBeTruthy();
        await expect(row.getByRole('button', { name: 'Reset task', exact: true })).toHaveCount(0);
        expect((await request.patch(`${API}/api/tasks/${child.id}`, { data: { columnId: 'review', agentStatus: 'failed' } })).ok()).toBeTruthy();
        await expect(row.getByRole('button', { name: 'Reset task', exact: true })).toBeVisible();
        await activate(row.getByRole('button', { name: 'Reset task', exact: true }));
        await expect(row.getByRole('button', { name: 'Reset task', exact: true })).toHaveCount(0);
        await expect(row).toBeVisible();
        const reviewReset = await (await request.get(`${API}/api/tasks/${child.id}`)).json();
        expect(reviewReset.agentStatus).toBe('idle');
        expect(reviewReset.columnId).toBe('in-progress');
        expect(runs).toBe(3);
      } finally {
        await request.delete(`${API}/api/groups/${group.id}`);
      }
    });
  });
}
