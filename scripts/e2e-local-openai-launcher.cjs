const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function dshProjectDirectoryName(cwd) {
  const resolved = path.resolve(cwd);
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < resolved.length; index++) {
    const code = resolved.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

function appendJsonl(file, record) {
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function sessionFile(cwd) {
  const dshHome = process.env.DSH_HOME;
  if (!dshHome) throw new Error('DSH_HOME is required for the E2E mock launcher');
  const sessionId = `mock-${process.pid}-${Date.now()}`;
  const dir = path.join(dshHome, 'sessions', dshProjectDirectoryName(cwd), sessionId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  appendJsonl(file, { type: 'session', version: 0, id: sessionId, createdAt: Date.now(), cwd });
  return file;
}

function stateCount(cwd) {
  const root = process.env.AGENTBOARD_E2E_MOCK_STATE_DIR || path.join(process.env.DSH_HOME || cwd, 'mock-state');
  mkdirSync(root, { recursive: true });
  const key = Buffer.from(path.resolve(cwd)).toString('base64url');
  const file = path.join(root, `${key}.txt`);
  const previous = existsSync(file) ? Number.parseInt(readFileSync(file, 'utf8'), 10) || 0 : 0;
  const next = previous + 1;
  writeFileSync(file, String(next));
  return next;
}

function emitTestEvidence(command, text, failed = false) {
  const file = sessionFile(process.cwd());
  const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  appendJsonl(file, { type: 'command/run', seq: Date.now(), time: Date.now(), data: { commandId: id, name: 'npm', args: command.replace(/^npm\s+/, '') } });
  appendJsonl(file, { type: 'command/done', seq: Date.now() + 1, time: Date.now(), data: { commandId: id, kind: failed ? 'error' : 'success', text } });
}

function writeFile(relativePath, content) {
  const file = path.join(process.cwd(), relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(args) {
  return execFileSync('git', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

const taskText = process.argv[process.argv.length - 1] || '';
const cwd = process.cwd();
const attempt = stateCount(cwd);

const orderedStep = taskText.match(/E2E Ordered roadmap P([123])/);
const synchronizationStep = taskText.match(/E2E Synchronization (A1|A2|B1|B2)/);
if (synchronizationStep) {
  const step = synchronizationStep[1];
  const startedAt = Date.now();
  const baseline = git(['rev-parse', 'HEAD']);
  const prerequisite = step === 'A2' ? 'A1' : step === 'B2' ? 'A2' : undefined;
  if (prerequisite) {
    const file = `src/synchronization-${prerequisite}.json`;
    if (!existsSync(path.join(cwd, file))) throw new Error(`Missing synchronized result ${prerequisite}`);
    const commit = git(['log', '-1', '--format=%H', '--', file]);
    git(['merge-base', '--is-ancestor', commit, baseline]);
    git(['merge-base', '--is-ancestor', commit, 'main']);
  }
  // Keep independent roots alive together long enough to observe real overlap.
  setTimeout(() => {
    writeFile(`src/synchronization-${step}.json`, JSON.stringify({ baseline, startedAt, finishedAt: Date.now() }));
    git(['add', `src/synchronization-${step}.json`]);
    git(['commit', '-m', `Synchronization ${step} result`]);
    emitTestEvidence('npm test -- --synchronization', `Focused tests passed: ${step} verified synchronized baseline`);
    process.stdout.write('<task-summary>\n## Completed\nFocused tests passed: synchronization baseline verified.\nHostile review passed: prerequisite ancestry checked.\n</task-summary>\n');
    setTimeout(() => process.exit(0), 150);
  }, prerequisite ? 150 : 2000);
} else if (orderedStep) {
  const step = Number(orderedStep[1]);
  const baseline = git(['rev-parse', 'HEAD']);
  // Read real predecessor output from this isolated worktree before writing anything.
  for (let predecessor = 1; predecessor < step; predecessor++) {
    const file = `src/ordered-p${predecessor}.json`;
    if (!existsSync(path.join(cwd, file))) throw new Error(`Missing required P${predecessor} result for P${step}`);
    const commit = git(['log', '-1', '--format=%H', '--', file]);
    if (!commit) throw new Error(`Uncommitted P${predecessor} result`);
    git(['merge-base', '--is-ancestor', commit, baseline]);
    git(['merge-base', '--is-ancestor', commit, 'main']);
  }
  writeFile(`src/ordered-p${step}.json`, JSON.stringify({ baseline, worktree: cwd, branch: git(['branch', '--show-current']) }));
  git(['add', `src/ordered-p${step}.json`]);
  git(['commit', '-m', `Ordered roadmap P${step} result`]);
  emitTestEvidence('npm test -- --ordered-roadmap', `Focused tests passed: P${step} inherited all committed predecessors`);
  process.stdout.write('<task-summary>\n## Completed\nFocused tests passed: npm test -- --ordered-roadmap\nHostile review passed: verified committed predecessor ancestry in isolated worktree.\n</task-summary>\n');
  setTimeout(() => process.exit(0), 150);
} else if (taskText.includes('E2E Local AI real blocker')) {
  process.stdout.write('<task-summary>\n## Completed\nEnvironment error: mocked Local AI blocker prevented validation.\n## Remaining\nBlocked by mocked validation setup.\n</task-summary>\n');
  setTimeout(() => process.exit(1), 150);
} else if (taskText.includes('E2E Local AI recovery succeeds')) {
  if (attempt === 1) {
    process.stdout.write('<task-summary>\n## Completed\nFocused tests passed: no-op attempt claimed success.\nHostile review passed: no repository edits found yet.\n</task-summary>\n');
  } else {
    writeFile('src/recovered-local-ai.txt', `recovered on attempt ${attempt}\n`);
    emitTestEvidence('npm test -- --local-ai-recovery', 'Focused tests passed: mocked Local AI recovery regression');
    process.stdout.write('<task-summary>\n## Completed\nFocused tests passed: npm test -- --local-ai-recovery\nHostile review passed: recovered attempt produced repository changes and no policy expansion.\n</task-summary>\n');
  }
  setTimeout(() => process.exit(0), 150);
} else if (taskText.includes('E2E Local AI stays no-op')) {
  process.stdout.write('<task-summary>\n## Completed\nFocused tests passed: repeated no-op claim.\nHostile review passed: no repository edits found.\n</task-summary>\n');
  setTimeout(() => process.exit(0), 150);
} else if (taskText.includes('E2E Local AI precommitted')) {
  writeFile('src/precommitted-local-ai.txt', 'committed by mocked Local AI\n');
  git(['add', 'src/precommitted-local-ai.txt']);
  git(['commit', '-m', 'Mock Local AI task-owned commit']);
  emitTestEvidence('npm test -- --precommitted-local-ai', 'Focused tests passed: mocked precommitted Local AI regression');
  process.stdout.write('<task-summary>\n## Completed\nFocused tests passed: npm test -- --precommitted-local-ai\nHostile review passed: task-owned commit is present with a clean working tree.\n</task-summary>\n');
  setTimeout(() => process.exit(0), 150);
} else {
  writeFile('src/dependent-local-ai.txt', 'dependent card started after prerequisite success\n');
  emitTestEvidence('npm test -- --dependent-local-ai', 'Focused tests passed: mocked dependent Local AI regression');
  process.stdout.write('<task-summary>\n## Completed\nFocused tests passed: npm test -- --dependent-local-ai\nHostile review passed: dependent task started after prerequisite completion.\n</task-summary>\n');
  setTimeout(() => process.exit(0), 150);
}
