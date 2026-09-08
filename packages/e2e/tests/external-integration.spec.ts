import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { API, waitForBoard, prepareTestRepo, cleanupTestPath, git } from './helpers';

test('Recheck integration verifies an external fast-forward and refreshes dependents without rerunning the prerequisite', async ({ page, request }) => {
  test.setTimeout(60_000);
  const repoPath = prepareTestRepo(`external-integration-${Date.now()}`, { clean: true, files: {
    'external-integration-conflict.txt': 'E2E external integration original\n',
  } });
  let projectId: string | undefined;
  let groupId: string | undefined;
  try {
    const projectResponse = await request.post(`${API}/api/projects`, { data: {
      name: `External integration ${Date.now()}`, repoPath, defaultAgentType: 'local-openai',
      defaultBaseBranch: 'main', defaultUseWorktree: true, autoRunEnabled: true,
    } });
    expect(projectResponse.status()).toBe(201);
    projectId = (await projectResponse.json()).id;
    const response = await request.post(`${API}/api/groups`, { data: {
      projectId, title: 'External integration recovery', repoPath, baseBranch: 'main',
      roadmapExecutionMode: 'first-card', children: [
        { title: 'E2E Synchronization A1 External integration conflict', agentType: 'local-openai', useWorktree: true },
        { title: 'E2E Synchronization A2 Observe running transition', agentType: 'local-openai', useWorktree: true },
      ],
    } });
    expect(response.status()).toBe(201);
    const group = await response.json(); groupId = group.id;
    const taskId = group.children[0].id;
    const children = async () => (await (await request.get(`${API}/api/groups/${groupId}`)).json()).children;
    await page.route('**/api/projects/*/auto-run/tick', route => route.fulfill({ json: { started: false, reason: 'test-server-scheduling' } }));
    let reruns = 0;
    await page.route(`**/api/tasks/${taskId}/run`, route => { reruns++; return route.abort(); });
    await page.goto(`/projects/${projectId}`); await waitForBoard(page);
    await expect.poll(async () => (await children())[0].columnId, { timeout: 20_000 }).toBe('review');
    await expect.poll(async () => {
      const events = await (await request.get(`${API}/api/tasks/${taskId}/events`)).json();
      return events.some((event: { type: string; content: string }) => event.type === 'error' && event.content.startsWith('Auto-merge failed:'));
    }, { timeout: 20_000 }).toBe(true);
    await page.getByRole('heading', { name: group.title, exact: true }).click();
    const row = page.getByTestId('group-child').filter({ has: page.getByRole('button', { name: `Open ${group.children[0].title}`, exact: true }) });
    await expect(row).toContainText('Integration pending');
    await row.getByRole('button', { name: 'Recheck integration', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Recheck integration', exact: true })).toBeEnabled();
    await expect(row).toContainText('Integration pending');
    const prerequisite = (await children())[0];
    expect((await children())[1].worktreePath).toBeFalsy();
    const originalResult = prerequisite.repositoryBaseline.resultCommit;
    // Manual Done cleans up the old managed worktree before repository evidence
    // is reconciled. Pause automatic admission while reproducing that state.
    expect((await request.patch(`${API}/api/projects/${projectId}`, { data: { autoRunEnabled: false } })).ok()).toBeTruthy();
    // Repair the genuine automatic conflict outside Workbench, preserving the
    // task's recorded rebase lineage while changing its commit hash.
    expect(() => git(['rebase', 'main'], prerequisite.worktreePath)).toThrow();
    writeFileSync(path.join(prerequisite.worktreePath, 'external-integration-conflict.txt'), 'E2E external integration resolved main and task edits\n');
    git(['add', 'external-integration-conflict.txt'], prerequisite.worktreePath);
    execFileSync('git', ['rebase', '--continue'], { cwd: prerequisite.worktreePath, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const repairedResult = git(['rev-parse', 'HEAD'], prerequisite.worktreePath).trim();
    expect(repairedResult).not.toBe(originalResult);
    git(['merge', '--ff-only', prerequisite.branchName], repoPath);
    expect((await request.patch(`${API}/api/tasks/${taskId}`, { data: { columnId: 'done' } })).ok()).toBeTruthy();
    expect((await children())[0].worktreePath).toBeFalsy();
    // Polling may already have reconciled and removed the button. The pending
    // button was exercised above; the final API recheck must be idempotent.
    const recheck = await request.post(`${API}/api/tasks/${taskId}/recheck-integration`);
    expect(recheck.status()).toBe(200);
    expect((await recheck.json()).synchronized).toBe(true);
    const evidence = (await (await request.get(`${API}/api/tasks/${taskId}/git-info`)).json()).repositoryEvidence;
    expect(evidence.available).toBe(true);
    expect(evidence.latestTaskCommit.sha).toBe(repairedResult);
    expect(evidence.commitsAhead).toBe(0);
    expect((await request.patch(`${API}/api/projects/${projectId}`, { data: { autoRunEnabled: true } })).ok()).toBeTruthy();
    await expect(row).toContainText('Synchronized / integrated');
    await expect(row.getByRole('button', { name: 'Recheck integration', exact: true })).toHaveCount(0);
    await expect(row).not.toContainText('Integration pending');
    await expect.poll(async () => (await children()).every((child: any) => child.columnId === 'done'), { timeout: 20_000 }).toBe(true);
    const reconciled = (await children())[0];
    expect(reconciled.repositoryBaseline.resultCommit).toBe(repairedResult);
    expect(reconciled.repositoryBaseline.originalResultCommit).toBe(originalResult);
    expect(reconciled.startedAt).toBe(prerequisite.startedAt);
    expect(reruns).toBe(0);
    const successor = JSON.parse(git(['show', 'main:src/synchronization-A2.json'], repoPath));
    git(['merge-base', '--is-ancestor', repairedResult, successor.baseline], repoPath);
  } finally {
    if (groupId) await request.delete(`${API}/api/groups/${groupId}`);
    if (projectId) await request.delete(`${API}/api/projects/${projectId}`);
    cleanupTestPath(repoPath);
  }
});
