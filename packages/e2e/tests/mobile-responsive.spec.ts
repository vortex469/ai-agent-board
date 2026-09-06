import { test, expect, devices, request as apiRequest, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import path from 'path';
import { API, waitForBoard } from './helpers';

/**
 * Mobile / tablet / desktop responsive regression suite.
 *
 * Proves the touch-first horizontal Kanban rail (CSS scroll snap) and the
 * full-viewport task drawer geometry on phone portrait, phone landscape,
 * tablet, and desktop viewports. These tests FAIL under the previous
 * stacked `max-md:flex-col max-md:overflow-x-hidden` layout because the
 * rail then has no horizontal overflow (scrollWidth === clientWidth).
 */

const IPHONE_UA = devices['iPhone 13'].userAgent;
const FIXTURE_PREFIX = 'MobileFixture';
const LONG_TITLE = `${FIXTURE_PREFIX} Backlog with an intentionally very long task title that must wrap or truncate without breaking layout`;
const IN_PROGRESS_TITLE = `${FIXTURE_PREFIX} InProgress agent task`;
const REVIEW_TITLE = `${FIXTURE_PREFIX} Review task`;
const COMPLETED_WORKTREE_TITLE = `${FIXTURE_PREFIX} Completed worktree task`;
const DONE_SCROLL_PREFIX = `${FIXTURE_PREFIX} Done overflow`;
const DONE_SCROLL_COUNT = 24;
const LONG_DESCRIPTION = [
  'A long markdown description used to verify the expanded task description scroller.',
  '',
  '- step one with `inline code` and a fairly long line of explanatory prose to force wrapping',
  '- step two',
  '- step three',
  '',
  'Final paragraph with more prose so the description block has real height on short landscape viewports.',
].join('\n');

const SCREENSHOT_DIR = path.resolve('test-results', 'mobile-ux');

const MOBILE_VIEWPORTS = [
  { name: 'portrait-375x812', width: 375, height: 812 },
  { name: 'portrait-430x932', width: 430, height: 932 },
  { name: 'landscape-812x375', width: 812, height: 375 },
  { name: 'landscape-932x430', width: 932, height: 430 },
] as const;

const seededIds: string[] = [];

async function seedFixture(requestCtx: any) {
  const existing = await (await requestCtx.get(`${API}/api/tasks`)).json();
  const byTitle = new Map<string, any>(existing.map((t: any) => [t.title, t]));

  if (!byTitle.has(LONG_TITLE)) {
    const res = await requestCtx.post(`${API}/api/tasks`, {
      data: { title: LONG_TITLE, description: 'Backlog fixture', columnId: 'backlog' },
    });
    seededIds.push((await res.json()).id);
  }
  if (!byTitle.has(IN_PROGRESS_TITLE)) {
    const res = await requestCtx.post(`${API}/api/tasks`, {
      data: { title: IN_PROGRESS_TITLE, description: LONG_DESCRIPTION, columnId: 'in-progress' },
    });
    seededIds.push((await res.json()).id);
  }
  if (!byTitle.has(REVIEW_TITLE)) {
    const res = await requestCtx.post(`${API}/api/tasks`, {
      data: { title: REVIEW_TITLE, description: 'Review fixture', columnId: 'in-progress' },
    });
    const created = await res.json();
    seededIds.push(created.id);
    await requestCtx.patch(`${API}/api/tasks/${created.id}`, { data: { columnId: 'review' } });
  }

  const existingCompleted = byTitle.get(COMPLETED_WORKTREE_TITLE);
  if (!existingCompleted) {
    const res = await requestCtx.post(`${API}/api/tasks`, {
      data: { title: COMPLETED_WORKTREE_TITLE, description: LONG_DESCRIPTION, columnId: 'in-progress' },
    });
    const created = await res.json();
    seededIds.push(created.id);
    await requestCtx.post(`${API}/api/tasks/${created.id}/configure`, {
      data: {
        repoPath: process.cwd(),
        useWorktree: true,
        branchName: 'mobile/completed-worktree-fixture',
        baseBranch: 'main',
      },
    });
    await requestCtx.patch(`${API}/api/tasks/${created.id}`, { data: { agentStatus: 'complete' } });
  }

}

test.afterAll(async () => {
  const ctx = await apiRequest.newContext();
  for (const id of seededIds.splice(0)) {
    await ctx.delete(`${API}/api/tasks/${id}`).catch(() => {});
  }
  await ctx.dispose();
});

async function railMetrics(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector('[data-board-rail]') as HTMLElement | null;
    return {
      exists: !!rail,
      scrollWidth: rail?.scrollWidth ?? 0,
      clientWidth: rail?.clientWidth ?? 0,
      snapType: rail ? getComputedStyle(rail).scrollSnapType : '',
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
  });
}

async function openTaskDrawer(page: Page, title: string) {
  const heading = page.getByRole('heading', { name: title });
  await heading.scrollIntoViewIfNeeded();
  await heading.click();
  await expect(page.locator('#agent-panel')).toBeVisible({ timeout: 5_000 });
}

async function expectTouchTarget(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function isInViewport(locator: Locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth;
  });
}

async function touchSwipe(page: Page, startX: number, startY: number, endX: number, endY: number, steps = 5) {
  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y: startY }],
  });
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        x: startX + (endX - startX) * ratio,
        y: startY + (endY - startY) * ratio,
      }],
    });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
}

for (const vp of MOBILE_VIEWPORTS) {
  test.describe(`Mobile ${vp.name}`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      userAgent: IPHONE_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });

    test.beforeEach(async ({ page, request }) => {
      await seedFixture(request);
      await page.goto('/');
      await waitForBoard(page);
    });

    test('board is a horizontal snap rail, not a vertical stack', async ({ page }) => {
      const m = await railMetrics(page);
      expect(m.exists).toBe(true);
      // Horizontal swipe geometry: the rail overflows horizontally...
      expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
      // ...with CSS scroll snap on the x axis...
      expect(m.snapType).toContain('x');
      // ...and no document-level horizontal overflow outside the rail.
      expect(m.docScrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
      expect(m.bodyScrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);

      // Each column fits within the viewport width (next column peeks in).
      const wrappers = page.locator('[data-board-rail] [data-column]');
      await expect(wrappers).toHaveCount(4);
      for (let i = 0; i < 4; i++) {
        const box = await wrappers.nth(i).boundingBox();
        expect(box, `column ${i} has a box`).not.toBeNull();
        expect(box!.width).toBeLessThanOrEqual(vp.width);
        expect(box!.width).toBeGreaterThan(0);
      }
    });

    test('a real horizontal touch swipe advances the board rail', async ({ page }) => {
      const rail = page.locator('[data-board-rail]');
      const box = await rail.boundingBox();
      expect(box).not.toBeNull();
      const y = box!.y + Math.min(box!.height - 20, 180);
      const startX = box!.x + box!.width - 35;
      const client = await page.context().newCDPSession(page);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y }],
      });
      for (const distance of [60, 120, 180, 240]) {
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX - distance, y }],
        });
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(20);
      await client.detach();
    });

    test('all four columns are reachable via the position affordance', async ({ page }) => {
      const nav = page.locator('nav[aria-label="Board columns"]');
      await expect(nav).toBeVisible();
      const dots = nav.locator('button');
      await expect(dots).toHaveCount(4);
      for (let i = 0; i < 4; i++) {
        const target = await dots.nth(i).boundingBox();
        expect(target!.width).toBeGreaterThanOrEqual(44);
        expect(target!.height).toBeGreaterThanOrEqual(44);
      }

      const headings = ['Backlog', 'In Progress', 'Review', 'Done'];
      for (let i = 3; i >= 0; i--) {
        await dots.nth(i).click();
        await expect(page.getByRole('heading', { name: headings[i], exact: true }))
          .toBeInViewport({ timeout: 5_000 });
      }
      // Position label reflects the first column after navigating back.
      await expect(nav.getByText('1 of 4', { exact: true })).toBeVisible();
      // aria-current marks the active dot for assistive tech.
      await expect(nav.locator('button[aria-current="true"]')).toHaveCount(1);
    });

    test('empty column shows its empty state on the rail', async ({ page }) => {
      // Filter to the fixture prefix so the Done column is deterministically empty.
      await page.getByRole('button', { name: 'Open menu' }).click();
      // Two search inputs exist (hidden desktop + mobile menu) — use the visible one.
      await page.locator('input[aria-label="Search tasks"]:visible').fill(FIXTURE_PREFIX);
      await page.getByRole('button', { name: 'Close menu' }).click();

      const nav = page.locator('nav[aria-label="Board columns"]');
      await nav.locator('button').nth(3).click();
      await expect(page.getByRole('heading', { name: 'Done', exact: true })).toBeInViewport();
      await expect(page.getByText('Reviewed tasks', { exact: true })).toBeVisible();
    });

    test('cards keep native pan gestures (deliberate drag only)', async ({ page }) => {
      const card = page
        .locator('[data-column="backlog"] .group')
        .filter({ has: page.getByRole('heading', { name: LONG_TITLE }) });
      await card.scrollIntoViewIfNeeded();
      const touchAction = await card.evaluate((el) => getComputedStyle(el).touchAction);
      // touch-action: manipulation preserves pan-x/pan-y scrolling; drags
      // require the TouchSensor press-and-hold activation.
      expect(touchAction).toBe('manipulation');
    });

    test('card actions and filter chips expose 44px touch targets', async ({ page }) => {
      const card = page
        .locator('[data-column="backlog"] .group')
        .filter({ has: page.getByRole('heading', { name: LONG_TITLE }) });
      await card.scrollIntoViewIfNeeded();
      await expectTouchTarget(card.getByRole('button', { name: 'Edit task' }));
      await expectTouchTarget(card.getByRole('button', { name: 'Delete task' }));

      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('button', { name: 'Toggle filters' }).click();
      for (const name of ['Copilot', 'Running', 'Failed', 'Complete']) {
        await expectTouchTarget(page.getByRole('button', { name, exact: true }));
      }
    });

    test('header keeps compact mobile controls without overlap', async ({ page }) => {
      const hamburger = page.getByRole('button', { name: 'Open menu' });
      await expect(hamburger).toBeVisible();
      // Desktop-only controls must not appear at phone widths (incl. landscape).
      await expect(page.getByRole('button', { name: 'New Task' })).toBeHidden();

      const title = page.getByRole('heading', { name: 'AI Agent Board' });
      const titleBox = await title.boundingBox();
      const burgerBox = await hamburger.boundingBox();
      expect(titleBox).not.toBeNull();
      expect(burgerBox).not.toBeNull();
      // Title never overlaps the actions cluster.
      expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(burgerBox!.x + 1);
      // Hamburger is a >=44px touch target.
      expect(burgerBox!.width).toBeGreaterThanOrEqual(44);
      expect(burgerBox!.height).toBeGreaterThanOrEqual(44);
    });

    test('task drawer is a full-viewport sheet with visible composer', async ({ page }) => {
      await openTaskDrawer(page, IN_PROGRESS_TITLE);
      const panel = page.locator('#agent-panel');

      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      // Full sheet: fills the viewport, never exceeds it.
      expect(Math.round(box!.width)).toBeGreaterThanOrEqual(vp.width - 1);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.y).toBeGreaterThanOrEqual(-1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);

      // Composer stays visible and inside the viewport.
      const composer = page.getByPlaceholder('Send a message to the agent...');
      await expect(composer).toBeInViewport();
      const composerBox = await composer.boundingBox();
      expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(vp.height + 1);
      expect(composerBox!.height).toBeGreaterThanOrEqual(40);

      // Tabs/action row scrolls horizontally instead of clipping.
      const tabs = page.locator('[data-panel-tabs]');
      const overflowX = await tabs.evaluate((el) => getComputedStyle(el).overflowX);
      expect(['auto', 'scroll']).toContain(overflowX);
      for (const tab of ['Events', 'Terminal']) {
        const button = page.getByRole('button', { name: tab });
        await expect(button).toBeInViewport();
        const target = await button.boundingBox();
        expect(target!.height).toBeGreaterThanOrEqual(44);
      }

      // Events content area exists between header and composer.
      await expect(page.getByText('No agent activity yet')).toBeVisible();
    });

    test('expanded description and tab switches never hide the composer', async ({ page }) => {
      await openTaskDrawer(page, IN_PROGRESS_TITLE);
      const composer = page.getByPlaceholder('Send a message to the agent...');

      // Expand the long task description — composer must remain visible.
      await page.getByRole('button', { name: /Task Description/ }).click();
      await expect(composer).toBeInViewport();

      // Terminal tab.
      await page.getByRole('button', { name: 'Terminal' }).click();
      await expect(composer).toBeInViewport();

      // Changes tab.
      await page.getByRole('button', { name: /^Changes/ }).click();
      await expect(composer).toBeInViewport();
    });

    test('completed branch metadata scrolls while composer and actions stay reachable', async ({ page }) => {
      await page.route('**/api/tasks/*/git-info', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hasRemote: false,
          mergeReady: true,
          repositoryEvidence: {
            available: true,
            state: 'working_tree_changes',
            worktreePath: '/tmp/agentboard-mobile-evidence-worktree',
            taskBranch: 'mobile/completed-worktree-fixture',
            baseBranch: 'main',
            baseCommit: '4444444444444444444444444444444444444444',
            baseShortCommit: '4444444',
            changedFileCount: 2,
            modifiedFileCount: 1,
            untrackedFileCount: 1,
            commitsAhead: 0,
            changedFiles: [
              { path: 'packages/client/src/components/AgentPanel.tsx', status: 'M' },
              { path: 'packages/server/src/routes/git.ts', status: '??' },
            ],
          },
        }),
      }));
      await page.reload();
      await waitForBoard(page);
      await openTaskDrawer(page, COMPLETED_WORKTREE_TITLE);

      const composer = page.getByPlaceholder('Send a message to the agent...');
      await page.getByRole('button', { name: /Task Description/ }).click();
      await expect(page.getByText('mobile/completed-worktree-fixture')).toBeVisible();
      await expect(composer).toBeInViewport();

      const scrollRegion = page.locator('[data-panel-scroll-region]');
      const scrollMetrics = await scrollRegion.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowY: getComputedStyle(el).overflowY,
      }));
      expect(scrollMetrics.overflowY).toBe('auto');
      if (vp.width > vp.height) {
        expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
      } else {
        expect(scrollMetrics.scrollHeight).toBeGreaterThanOrEqual(scrollMetrics.clientHeight);
      }

      const merge = page.getByRole('button', { name: 'Merge to main' });
      await merge.scrollIntoViewIfNeeded();
      await expectTouchTarget(merge);
      await expect(composer).toBeInViewport();

      await page.getByRole('button', { name: /^Changes/ }).click();
      await expect(page.getByText('Working-tree changes present')).toBeInViewport();
      await expect(page.getByText('/tmp/agentboard-mobile-evidence-worktree')).toBeVisible();
      await expect(page.getByText('packages/client/src/components/AgentPanel.tsx')).toBeVisible();
      await expect(composer).toBeInViewport();

      const widthMetrics = await page.evaluate(() => ({
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(widthMetrics.docScrollWidth).toBeLessThanOrEqual(widthMetrics.innerWidth + 1);
      expect(widthMetrics.bodyScrollWidth).toBeLessThanOrEqual(widthMetrics.innerWidth + 1);
    });


    test('review task drawer shows Summary tab within the viewport', async ({ page }) => {
      await openTaskDrawer(page, REVIEW_TITLE);
      const summaryTab = page.getByRole('button', { name: 'Summary', exact: true });
      await expect(summaryTab).toBeInViewport();
      await expect(page.getByText('No summary was provided for this task.')).toBeInViewport();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-drawer-summary.png`) });
    });

    test('capture board + drawer screenshots', async ({ page }) => {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-board.png`) });

      // Second column in view for the populated-board shot.
      await page.locator('nav[aria-label="Board columns"] button').nth(1).click();
      await expect(page.getByRole('heading', { name: 'In Progress', exact: true })).toBeInViewport();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-board-in-progress.png`) });

      await openTaskDrawer(page, IN_PROGRESS_TITLE);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-drawer-events.png`) });
      await page.getByRole('button', { name: 'Terminal' }).click();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-drawer-terminal.png`) });
    });
  });
}

test.describe('Mobile portrait Done column overflow', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    userAgent: IPHONE_UA,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });

  test.beforeEach(async ({ page, request }) => {
    await seedFixture(request);

    const existing = await (await request.get(`${API}/api/tasks`)).json();
    const existingTitles = new Set(existing.map((task: any) => task.title));
    for (let i = 1; i <= DONE_SCROLL_COUNT; i++) {
      const title = `${DONE_SCROLL_PREFIX} ${String(i).padStart(2, '0')}`;
      if (existingTitles.has(title)) continue;
      const res = await request.post(`${API}/api/tasks`, {
        data: {
          title,
          description: 'Done overflow fixture',
          columnId: 'done',
          agentStatus: 'complete',
        },
      });
      seededIds.push((await res.json()).id);
    }

    await page.goto('/');
    await waitForBoard(page);
  });

  test('vertical touch scroll reaches the last Done card while horizontal rail swipe still works', async ({ page }) => {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('input[aria-label="Search tasks"]:visible').fill(DONE_SCROLL_PREFIX);
    await page.getByRole('button', { name: 'Close menu' }).click();

    const nav = page.locator('nav[aria-label="Board columns"]');
    const rail = page.locator('[data-board-rail]');
    await nav.locator('button').nth(3).click();
    await expect(page.getByRole('heading', { name: 'Done', exact: true })).toBeInViewport();

    const doneScroller = page.locator('[data-column="done"] [data-column-scroll]');
    await expect(doneScroller).toBeVisible();
    await expect(doneScroller).toHaveCSS('overflow-y', 'auto');

    const firstDone = page.getByRole('heading', { name: `${DONE_SCROLL_PREFIX} 01`, exact: true });
    const lastDone = page.getByRole('heading', { name: `${DONE_SCROLL_PREFIX} ${DONE_SCROLL_COUNT}`, exact: true });
    const lastDoneCard = page
      .locator('[data-column="done"] .group')
      .filter({ has: lastDone });
    await expect(firstDone).toBeInViewport();
    await expect(lastDone).not.toBeInViewport();

    const scrollBox = await doneScroller.boundingBox();
    expect(scrollBox).not.toBeNull();
    const x = scrollBox!.x + scrollBox!.width / 2;
    const startY = Math.min(scrollBox!.y + scrollBox!.height - 24, 740);
    const endY = scrollBox!.y + 80;

    for (let i = 0; i < 8; i++) {
      await touchSwipe(page, x, startY, x + (i % 2 === 0 ? 2 : -2), endY, 6);
      if (await isInViewport(lastDone)) break;
    }

    await expect.poll(() => doneScroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(lastDone).toBeInViewport();

    const lastBox = await lastDoneCard.boundingBox();
    const navBox = await nav.boundingBox();
    expect(lastBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(navBox!.y);

    await nav.locator('button').nth(0).click();
    await expect(page.getByRole('heading', { name: 'Backlog', exact: true })).toBeInViewport();

    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    await touchSwipe(
      page,
      railBox!.x + railBox!.width - 35,
      railBox!.y + 180,
      railBox!.x + 35,
      railBox!.y + 182,
      6
    );
    await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(20);
  });
});

test.describe('Tablet portrait 768x1024', () => {
  test.use({
    viewport: { width: 768, height: 1024 },
    userAgent: IPHONE_UA,
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ page, request }) => {
    await seedFixture(request);
    await page.goto('/');
    await waitForBoard(page);
  });

  test('keeps the swipeable rail with compact fixed columns', async ({ page }) => {
    const m = await railMetrics(page);
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
    expect(m.snapType).toContain('x');
    // Compact fixed column width (sm:w-72 = 288px) — more than one column visible.
    const first = await page.locator('[data-board-rail] [data-column]').first().boundingBox();
    expect(first!.width).toBeLessThanOrEqual(320);
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
    await expect(page.locator('nav[aria-label="Board columns"]')).toBeVisible();
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'tablet-768x1024-board.png') });
  });
});

test.describe('Tablet landscape 1024x768', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

  test.beforeEach(async ({ page, request }) => {
    await seedFixture(request);
    await page.goto('/');
    await waitForBoard(page);
  });

  test('shows desktop controls and side drawer', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
    await expect(page.locator('nav[aria-label="Board columns"]')).toBeHidden();

    await openTaskDrawer(page, IN_PROGRESS_TITLE);
    const box = await page.locator('#agent-panel').boundingBox();
    // Right-side drawer, responsive width capped sensibly (not a full sheet).
    expect(box!.width).toBeLessThanOrEqual(480);
    expect(box!.width).toBeLessThan(1024);
    expect(Math.round(box!.x + box!.width)).toBeGreaterThanOrEqual(1023);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'tablet-1024x768-drawer.png') });
  });
});

test.describe('Desktop 1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page, request }) => {
    await seedFixture(request);
    await page.goto('/');
    await waitForBoard(page);
  });

  test('multi-column board with all columns visible and side drawer', async ({ page }) => {
    // All four columns fit side by side — no snap rail affordance.
    for (const col of ['Backlog', 'In Progress', 'Review', 'Done']) {
      await expect(page.getByRole('heading', { name: col, exact: true })).toBeInViewport();
    }
    await expect(page.locator('nav[aria-label="Board columns"]')).toBeHidden();
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible();

    await openTaskDrawer(page, IN_PROGRESS_TITLE);
    const box = await page.locator('#agent-panel').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(480);
    await expect(page.getByPlaceholder('Send a message to the agent...')).toBeInViewport();
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-1440x900-drawer.png') });
  });
});
