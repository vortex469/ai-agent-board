import { test, expect } from '@playwright/test';
import { API, cleanupTestPath, git, prepareTestRepo, waitForBoard } from './helpers';

const baseName = 'v0.11 Base Building';
const craftName = 'v0.12 Advanced Crafting & Workstations';
const gates = [[3, 3], [5, 6], [7, 8]] as const;

function roadmap(runtime = false) {
  return [
    `GROUP: ${baseName}`,
    ...(runtime ? ['AGENT: local-openai', 'AUTO RUN: true'] : []),
    ...Array.from({ length: 9 }, (_, i) => `${String(i + 1).padStart(2, '0')}. ${runtime ? 'E2E Imported roadmap A' : 'Construction '}${String(i + 1).padStart(2, '0')}`),
    '',
    `GROUP: ${craftName}`,
    ...(runtime ? ['AGENT: local-openai', 'AUTO RUN: true'] : []),
    ...Array.from({ length: 8 }, (_, i) => {
      const gate = gates.find(([dependent]) => dependent === i);
      return `${String(i + 1).padStart(2, '0')}. ${runtime ? 'E2E Imported roadmap B' : 'Workstation '}${String(i + 1).padStart(2, '0')}${gate ? `\n    DEPENDS ON: ${baseName} / ${String(gate[1] + 1).padStart(2, '0')}` : ''}`;
    }),
  ].join('\n');
}

test('imports two roadmap lanes with stable ordered gates and Auto Run releases after integration', async ({ page, request }) => {
  test.setTimeout(120_000);
  const repoPath = prepareTestRepo(`multi-roadmap-${Date.now()}`, { clean: true });
  let projectId: string | undefined;
  const groupIds: string[] = [];
  try {
    const response = await request.post(`${API}/api/projects`, { data: {
      name: `Multi roadmap ${Date.now()}`, repoPath, defaultAgentType: 'local-openai',
      defaultBaseBranch: 'main', defaultUseWorktree: true, autoRunEnabled: false,
    } });
    expect(response.status()).toBe(201);
    projectId = (await response.json()).id;
    await page.goto(`/projects/${projectId}`);
    await waitForBoard(page);
    await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
    await page.getByLabel('Creation mode').selectOption('multi-group');
    await page.getByLabel('Roadmap text').fill(roadmap(true));
    await page.getByRole('button', { name: 'Preview Cards' }).click();
    const preview = page.getByRole('group', { name: 'Multi-group import preview' });
    await expect(preview).toContainText('Cross-group');
    const creation = page.waitForResponse(res => res.url().endsWith('/api/roadmap-intake/import') && res.request().method() === 'POST');
    await page.getByRole('button', { name: /Create 2 Groups/ }).click();
    const importedResponse = await creation;
    expect(importedResponse.status()).toBe(201);
    const imported = await importedResponse.json();
    const [a, b] = imported.groups;
    groupIds.push(a.id, b.id);
    expect(imported.groups.map((group: any) => group.title)).toEqual([baseName, craftName]);
    for (const [group, count] of [[a, 9], [b, 8]] as const) {
      expect(group.children.map((child: any) => child.groupOrder)).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(group.children.map((child: any) => child.title)).toEqual(Array.from({ length: count }, (_, i) => `E2E Imported roadmap ${group.id === a.id ? 'A' : 'B'}${String(i + 1).padStart(2, '0')}`));
      expect(new Set(group.children.map((child: any) => child.id)).size).toBe(count);
      expect(group.children.every((child: any) => child.groupId === group.id)).toBe(true);
      // Immediate UI refresh: no navigation or reload after import.
      await expect(page.getByRole('tab', { name: group.title, exact: true })).toBeVisible();
    }
    for (const [dependent, prerequisite] of gates) {
      const rel = await request.get(`${API}/api/tasks/${b.children[dependent].id}/relationships`);
      expect(rel.ok()).toBeTruthy();
      const dependencies = (await rel.json()).filter((relationship: any) => relationship.type === 'blocks' && relationship.direction === 'blocked-by');
      expect(dependencies.map((relationship: any) => relationship.relatedTaskId).sort()).toEqual([b.children[dependent - 1].id, a.children[prerequisite].id].sort());
      const status = await (await request.get(`${API}/api/tasks/${b.children[dependent].id}/dependencies`)).json();
      expect(status.eligible).toBe(false);
      const task = await (await request.get(`${API}/api/tasks/${b.children[dependent].id}`)).json();
      expect(task.columnId).toBe('backlog');
      expect(task.worktreePath).toBeFalsy();
      expect(task.runClaimedAt).toBeFalsy();
    }
    await page.getByRole('tab', { name: b.title, exact: true }).click();
    const gatedChild = page.getByTestId('group-child').filter({ has: page.getByRole('button', { name: `Open ${b.children[3].title}`, exact: true }) });
    await expect(gatedChild.getByTestId('dependency-status')).toContainText(`${baseName} / ${a.children[3].title}`);
    await expect(gatedChild.getByTestId('dependency-status')).toContainText('Synchronization gate');
    await expect(gatedChild.getByTestId('dependency-status')).toContainText('Waiting');
    // Project-level pause remains authoritative even with imported Auto Run enabled.
    const paused = await (await request.get(`${API}/api/tasks?projectId=${projectId}`)).json();
    expect(paused.every((task: any) => !task.runClaimedAt && !task.worktreePath && task.agentStatus === 'idle')).toBe(true);
    expect((await request.patch(`${API}/api/projects/${projectId}`, { data: { autoRunEnabled: true } })).ok()).toBeTruthy();
    await expect.poll(async () => (await (await request.get(`${API}/api/tasks/${a.children[3].id}`)).json()).agentStatus, { timeout: 30_000, intervals: [100] }).toBe('executing');
    const waiting = await (await request.get(`${API}/api/tasks/${b.children[3].id}`)).json();
    expect(waiting.columnId).toBe('backlog');
    expect(waiting.runClaimedAt).toBeFalsy();
    expect(waiting.worktreePath).toBeFalsy();
    // Imported queues must wake automatically when each prerequisite is integrated.
    await expect.poll(async () => {
      const groups = await Promise.all(groupIds.map(async id => (await (await request.get(`${API}/api/groups/${id}`)).json())));
      return groups.flatMap(group => group.children).every(child => child.columnId === 'done' && child.agentStatus === 'complete');
    }, { timeout: 90_000, intervals: [500] }).toBe(true);
    for (const [dependent, prerequisite] of gates) {
      const aStep = `A${String(prerequisite + 1).padStart(2, '0')}`;
      const bStep = `B${String(dependent + 1).padStart(2, '0')}`;
      const commit = git(['log', '-1', '--format=%H', '--', `src/imported-${aStep}.json`], repoPath).trim();
      expect(commit).not.toBe('');
      const output = JSON.parse(git(['show', `main:src/imported-${bStep}.json`], repoPath));
      git(['merge-base', '--is-ancestor', commit, output.baseline], repoPath);
    }
  } finally {
    // Also remove groups if assertions fail before recording the import response.
    if (projectId) {
      const groups = await (await request.get(`${API}/api/groups?projectId=${projectId}`)).json();
      for (const group of groups.reverse()) await request.delete(`${API}/api/groups/${group.id}`);
      await request.delete(`${API}/api/projects/${projectId}`);
    }
    cleanupTestPath(repoPath);
  }
});

for (const viewport of [{ width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test.describe(`Multi-group roadmap preview ${viewport.width}px`, () => {
    test.use({ viewport });
    test('edits group and task settings with readable cross-group dependencies', async ({ page }) => {
      await page.goto('/');
      await waitForBoard(page);
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible()) {
        await menu.click();
        await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
      }
      await page.getByLabel('Creation mode').selectOption('multi-group');
      await page.getByLabel('Roadmap text').fill(roadmap());
      await page.getByRole('button', { name: 'Preview Cards' }).click();
      const preview = page.getByRole('group', { name: 'Multi-group import preview' });
      await expect(preview).toContainText('Cross-group');
      await page.getByLabel('Group 1 name').fill('v0.11 Edited Base Building');
      await page.getByLabel('Group 2 task 8 title').fill('Edited integration');
      const dependency = page.getByLabel('Group 2 task 8 dependencies');
      await dependency.scrollIntoViewIfNeeded();
      await expect(dependency).toBeVisible();
      await expect(dependency).toHaveValue('v0.11 Edited Base Building / 09');
      await page.getByLabel('Group 2 agent', { exact: true }).selectOption('codex');
      await page.getByLabel('Group 2 task 8 auto run', { exact: true }).selectOption('false');
      const create = page.getByRole('button', { name: /Create 2 Groups/ });
      await create.scrollIntoViewIfNeeded();
      await expect(create).toBeEnabled();
      const dialog = page.getByRole('dialog', { name: 'Roadmap Intake' });
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      let payload: any;
      await page.route('**/api/roadmap-intake/import', async route => {
        payload = route.request().postDataJSON();
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ groups: [], tasks: [] }) });
      });
      await create.click();
      await expect(dialog).not.toBeVisible();
      expect(payload.groups[0].title).toBe('v0.11 Edited Base Building');
      expect(payload.groups[1].agentType).toBe('codex');
      expect(payload.groups[1].tasks[7]).toMatchObject({ title: 'Edited integration', autoRun: false, dependencies: ['v0.11 Edited Base Building / 09'] });
    });
  });
}
