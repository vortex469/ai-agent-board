#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { v4 as uuid } from 'uuid';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = Date.now();
const runRoot = path.join(repoRoot, 'test-results', `live-roadmap-smoke-${stamp}`);
const smokeRepo = path.join(runRoot, 'repo');
const dbPath = path.join(runRoot, 'agentboard-smoke.db');
const agentboardHome = path.join(runRoot, 'agentboard-home');
const worktreeRoot = path.join(runRoot, 'worktrees');
const keepArtifacts = process.env.LIVE_ROADMAP_SMOKE_KEEP === '1';
const preferredAgent = process.env.LIVE_ROADMAP_SMOKE_AGENT?.trim();
const timeoutMs = Number(process.env.LIVE_ROADMAP_SMOKE_TIMEOUT_MS ?? 15 * 60_000);
let succeeded = false;

function log(message) {
  console.log(`[live-roadmap-smoke] ${message}`);
}

function git(args, cwd = smokeRepo) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function fail(message) {
  throw new Error(message);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function prepareRepo() {
  mkdirSync(smokeRepo, { recursive: true });
  try {
    git(['init', '-b', 'main']);
  } catch {
    git(['init']);
    git(['checkout', '-b', 'main']);
  }
  git(['config', 'user.email', 'smoke@example.invalid']);
  git(['config', 'user.name', 'Agent Board Smoke']);
  writeFileSync(
    path.join(smokeRepo, 'ROADMAP_SMOKE.md'),
    '# Live Roadmap Smoke\n\nThis file is modified by disposable smoke cards.\n',
  );
  git(['add', '.']);
  git(['commit', '-m', 'init smoke repo']);
}

function makeTask(index, agentType) {
  const ordinal = String(index + 1).padStart(2, '0');
  const line = `card-${index + 1}: ${stamp}`;
  return {
    id: uuid(),
    projectId: 'default',
    title: `${ordinal}. v0.7 Smoke card ${index + 1}`,
    description: [
      'Source roadmap item:',
      '',
      `v0.7 smoke step ${index + 1} - Append exactly this line to ROADMAP_SMOKE.md: ${line}`,
      '',
      'Only edit ROADMAP_SMOKE.md. Verify the file contains the new line. No manual board movement is allowed.',
    ].join('\n'),
    priority: 'medium',
    columnId: index === 0 ? 'in-progress' : 'backlog',
    agentStatus: 'idle',
    agentType,
    createdAt: stamp + index,
    repoPath: smokeRepo,
    branchName: `smoke/card-${index + 1}-${stamp}`,
    baseBranch: 'main',
    useWorktree: true,
    archived: false,
    timeoutMinutes: Math.ceil(timeoutMs / 60_000),
    expectedLine: line,
  };
}

async function waitForDone(repo, task, startedAfter) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await repo.getById(task.id);
    if (!current) fail(`Task disappeared: ${task.title}`);
    if (current.agentStatus === 'failed') {
      const events = await repo.getEventsByTaskId(task.id);
      const lastError = [...events].reverse().find((event) => event.type === 'error');
      fail(`${task.title} failed${lastError ? `: ${lastError.content}` : ''}`);
    }
    if (current.columnId === 'review') {
      const events = await repo.getEventsByTaskId(task.id);
      const lastError = [...events].reverse().find((event) => event.type === 'error');
      fail(`${task.title} stopped in Review instead of Done${lastError ? `: ${lastError.content}` : ''}`);
    }
    if (current.columnId === 'done' && current.agentStatus === 'complete') {
      if (startedAfter !== undefined && (!current.startedAt || current.startedAt < startedAfter)) {
        fail(`${task.title} started before its prerequisite completed`);
      }
      return current;
    }
    await sleep(5_000);
  }
  fail(`${task.title} did not reach Done within ${Math.round(timeoutMs / 1000)}s`);
}

async function main() {
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(agentboardHome, { recursive: true });
  prepareRepo();

  process.env.DB_PATH = dbPath;
  process.env.DATABASE_URL = '';
  process.env.AGENTBOARD_HOME = agentboardHome;
  process.env.XDG_CACHE_HOME ??= path.join(runRoot, 'xdg-cache');
  process.env.XDG_CONFIG_HOME ??= path.join(runRoot, 'xdg-config');
  process.env.XDG_DATA_HOME ??= path.join(runRoot, 'xdg-data');
  process.env.XDG_STATE_HOME ??= path.join(runRoot, 'xdg-state');
  process.env.TMPDIR = worktreeRoot;
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

  const [{ initDatabase }, { SqliteTaskRepository }, { AgentManager }, { startAgentForTask }] = await Promise.all([
    import('../packages/server/dist/db.js'),
    import('../packages/server/dist/repositories/sqlite.js'),
    import('../packages/server/dist/services/agent-manager.js'),
    import('../packages/server/dist/routes/helpers.js'),
  ]);

  const db = initDatabase();
  const taskRepo = new SqliteTaskRepository(db);
  const agentManager = new AgentManager();
  agentManager.initEventPersistence(taskRepo);

  try {
    await agentManager.initialize();
    const availableAgents = agentManager.getAvailableAgents().filter((agent) => agent.available);
    const agent = preferredAgent
      ? availableAgents.find((candidate) => candidate.name === preferredAgent)
      : availableAgents.find((candidate) => candidate.name === 'codex') ?? availableAgents[0];
    if (!agent) {
      fail(`No available live agent detected. Available status: ${JSON.stringify(agentManager.getAvailableAgents())}`);
    }

    log(`using ${agent.displayName || agent.name}`);
    const tasks = [0, 1, 2].map((index) => makeTask(index, agent.name));
    for (const task of tasks) {
      const { expectedLine, ...persisted } = task;
      await taskRepo.create(persisted);
      await taskRepo.requestRun(task.id, stamp);
    }
    await taskRepo.createDependency(tasks[0].id, tasks[1].id, stamp + 1);
    await taskRepo.createDependency(tasks[1].id, tasks[2].id, stamp + 2);

    log(`created disposable roadmap ${tasks.map((task) => task.id).join(' -> ')}`);
    await startAgentForTask(await taskRepo.getById(tasks[0].id), taskRepo, agentManager);

    let previousCompletedAt;
    for (const task of tasks) {
      const done = await waitForDone(taskRepo, task, previousCompletedAt);
      previousCompletedAt = done.completedAt;
      log(`${task.title} reached Done`);
    }

    const smokeFile = execFileSync('git', ['show', 'main:ROADMAP_SMOKE.md'], {
      cwd: smokeRepo,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    for (const task of tasks) {
      if (!smokeFile.includes(task.expectedLine)) {
        fail(`main branch is missing expected line: ${task.expectedLine}`);
      }
    }

    const final = await Promise.all(tasks.map((task) => taskRepo.getById(task.id)));
    log('final card states:');
    for (const task of final) {
      log(`  ${task.title}: ${task.columnId}/${task.agentStatus}`);
    }
    log(`verified automatic progression through Done for ${tasks.length} cards`);
    succeeded = true;
  } finally {
    agentManager.shutdownAll();
    db.close();
    if (keepArtifacts || !succeeded) {
      log(`kept artifacts at ${runRoot}`);
    } else if (existsSync(runRoot)) {
      rmSync(runRoot, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(`[live-roadmap-smoke] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
