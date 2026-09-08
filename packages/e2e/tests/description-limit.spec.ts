import { test, expect } from '@playwright/test';
import { API, fillLocalPath, waitForBoard } from './helpers';

const ids: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of ids.splice(0)) await request.delete(`${API}/api/tasks/${id}`);
});

for (const length of [100, 5_001, 20_000]) {
  test(`task create, edit, and batch preserve ${length} characters`, async ({ request }) => {
    const description = 'x'.repeat(length);
    const created = await request.post(`${API}/api/tasks`, { data: { title: 'Description boundary', description } });
    expect(created.status()).toBe(201);
    const task = await created.json();
    ids.push(task.id);
    expect(task.description).toBe(description);
    const updated = await request.patch(`${API}/api/tasks/${task.id}`, { data: { description: 'y'.repeat(length) } });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).description).toBe('y'.repeat(length));
    expect((await (await request.get(`${API}/api/tasks`)).json()).find((item: { id: string }) => item.id === task.id).description).toBe('y'.repeat(length));
    const batch = await request.post(`${API}/api/tasks/batch`, { data: { tasks: [{ title: 'Batch boundary', description }] } });
    expect(batch.status()).toBe(201);
    const { tasks } = await batch.json();
    ids.push(...tasks.map((item: { id: string }) => item.id));
    expect(tasks[0].description).toBe(description);
  });
}

test('20,001 characters fail cleanly without changing existing tasks or partially creating a batch', async ({ request }) => {
  const description = 'x'.repeat(20_001);
  const created = await request.post(`${API}/api/tasks`, { data: { title: 'Unchanged fixture', description: 'Original description' } });
  expect(created.status()).toBe(201);
  const task = await created.json();
  ids.push(task.id);
  for (const response of [
    await request.post(`${API}/api/tasks`, { data: { title: 'Rejected description', description } }),
    await request.patch(`${API}/api/tasks/${task.id}`, { data: { description } }),
    await request.post(`${API}/api/tasks/batch`, { data: { tasks: [{ title: 'Must not create' }, { title: 'Rejected batch', description }] } }),
  ]) {
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain('description must be at most 20000 characters');
  }
  expect((await (await request.get(`${API}/api/tasks`)).json()).find((item: { id: string }) => item.id === task.id).description).toBe('Original description');
  const tasks = await (await request.get(`${API}/api/tasks`)).json();
  expect(tasks.some((item: { title: string }) => item.title === 'Must not create')).toBe(false);
});

test('New Task retains oversized input, displays the limit, and saves exactly 20,000 characters', async ({ page }) => {
  await page.goto('/');
  await waitForBoard(page);
  await page.getByRole('heading', { name: 'Backlog', exact: true }).locator('..').locator('..').locator('button').first().click();
  await page.getByPlaceholder('What needs to be done?').fill('New Task description boundary');
  await fillLocalPath(page);
  const description = page.getByLabel('Description', { exact: true });
  await description.fill('x'.repeat(20_001));
  await expect(description).toHaveValue('x'.repeat(20_001));
  await expect(page.getByRole('alert')).toContainText('Description must be at most 20,000 characters');
  await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeDisabled();
  await description.fill('x'.repeat(20_000));
  await expect(page.getByText('20,000 / 20,000 characters', { exact: true })).toBeVisible();
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const task = await response.json();
  ids.push(task.id);
  expect(task.description).toBe('x'.repeat(20_000));
});

test('Roadmap Intake preserves a 20,000-character source and validates edited descriptions before batch creation', async ({ page }) => {
  await page.goto('/');
  await waitForBoard(page);
  await page.getByRole('button', { name: 'Roadmap Intake', exact: true }).click();
  const source = '- Build coverage ' + 'x'.repeat(20_000 - '- Build coverage '.length);
  await page.getByLabel('Roadmap text').fill(source);
  await page.getByRole('button', { name: 'Preview Cards' }).click();
  const description = page.getByLabel('Description for roadmap item 1');
  await expect(description).toHaveValue(source);
  await expect(page.getByText('20,000 / 20,000 characters', { exact: true })).toBeVisible();
  await description.fill(source + 'x');
  await page.getByRole('button', { name: /Create 1 Cards/ }).click();
  await expect(page.getByText('Description must be at most 20,000 characters', { exact: true })).toBeVisible();
  await expect(description).toHaveValue(source + 'x');
  await description.fill(source);
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/tasks/batch') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /Create 1 Cards/ }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const { tasks } = await response.json();
  ids.push(...tasks.map((item: { id: string }) => item.id));
  expect(tasks[0].description).toBe(source);
});

test('full batches and JSON-escaped descriptions fit the request body limits', async ({ request }) => {
  // Each control character occupies six bytes when JSON encoded.
  const description = '\u0001'.repeat(20_000);
  const created = await request.post(`${API}/api/tasks`, { data: { title: 'Escaped description', description } });
  expect(created.status()).toBe(201);
  const task = await created.json();
  ids.push(task.id);
  expect(task.description).toBe(description);
  const batch = await request.post(`${API}/api/tasks/batch`, {
    data: { tasks: Array.from({ length: 50 }, (_, index) => ({ title: `Full batch ${index}`, description })) },
  });
  expect(batch.status()).toBe(201);
  const { tasks } = await batch.json();
  ids.push(...tasks.map((item: { id: string }) => item.id));
  expect(tasks).toHaveLength(50);
  expect(tasks.every((item: { description: string }) => item.description === description)).toBe(true);
});
