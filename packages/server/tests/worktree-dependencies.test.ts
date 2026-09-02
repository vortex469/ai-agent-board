import assert from 'node:assert/strict';
import type { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WORKTREE_DEPENDENCY_CONCURRENCY,
  DEFAULT_WORKTREE_MIN_FREE_SPACE_BYTES,
  assertMinimumFreeSpace,
  buildNpmCiArgs,
  detectNodeNpmProject,
  getWorktreeDependencyConfig,
  provisionWorktreeDependencies,
  worktreeNodeModulesUsable,
} from '../src/services/worktree-dependencies.js';

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeNpmProject(root: string): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {}, dependencies: {} }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
}

function markNodeModulesUsable(root: string): void {
  const nodeModules = path.join(root, 'node_modules');
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.writeFileSync(path.join(nodeModules, '.package-lock.json'), '{}');
}

function enoughSpaceFs(bytes: number): Pick<typeof fs, 'existsSync' | 'lstatSync' | 'statSync' | 'statfsSync'> {
  return {
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync,
    statfsSync: () => ({ bavail: bytes, bsize: 1 }) as fs.StatsFs,
  };
}

function fakeSuccessfulNpm(calls: Array<{ file: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }>): typeof execFile {
  return ((file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ file, args, cwd: options.cwd, env: options.env });
    if (options.cwd) markNodeModulesUsable(options.cwd);
    callback(null, '', '');
  }) as typeof execFile;
}

test('detectNodeNpmProject requires package.json and a supported npm lockfile', () => {
  const root = makeDir('agentboard-node-detect-');
  try {
    assert.equal(detectNodeNpmProject(root), null);

    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    assert.equal(detectNodeNpmProject(root), null);

    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const project = detectNodeNpmProject(root);
    assert.equal(project?.projectRoot, root);
    assert.equal(project?.lockfileName, 'package-lock.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dependency config uses safe defaults and validates overrides', () => {
  assert.deepEqual(getWorktreeDependencyConfig({}), {
    maxConcurrentInstalls: DEFAULT_WORKTREE_DEPENDENCY_CONCURRENCY,
    minFreeSpaceBytes: DEFAULT_WORKTREE_MIN_FREE_SPACE_BYTES,
  });
  assert.deepEqual(getWorktreeDependencyConfig({
    AGENTBOARD_WORKTREE_DEPENDENCY_CONCURRENCY: '4',
    AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '12345',
  }), {
    maxConcurrentInstalls: 4,
    minFreeSpaceBytes: 12345,
  });
  assert.throws(
    () => getWorktreeDependencyConfig({ AGENTBOARD_WORKTREE_DEPENDENCY_CONCURRENCY: '0' }),
    /AGENTBOARD_WORKTREE_DEPENDENCY_CONCURRENCY must be a positive integer/,
  );
  assert.throws(
    () => getWorktreeDependencyConfig({ AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '8GiB' }),
    /AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES must be a positive integer/,
  );
});

test('free-space guard defaults to 8 GiB and fails before install', async () => {
  const root = makeDir('agentboard-node-space-');
  const calls: unknown[] = [];
  try {
    writeNpmProject(root);
    assert.throws(
      () => assertMinimumFreeSpace(root, DEFAULT_WORKTREE_MIN_FREE_SPACE_BYTES, enoughSpaceFs(DEFAULT_WORKTREE_MIN_FREE_SPACE_BYTES - 1)),
      /Not enough free space/,
    );
    await assert.rejects(
      () => provisionWorktreeDependencies(root, {
        env: {},
        fsImpl: enoughSpaceFs(DEFAULT_WORKTREE_MIN_FREE_SPACE_BYTES - 1),
        execFileImpl: fakeSuccessfulNpm(calls as Array<{ file: string; args: readonly string[] }>),
      }),
      /Not enough free space/,
    );
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful provisioning runs npm ci with fixed arguments inside the worktree', async () => {
  const root = makeDir('agentboard-node-install-');
  const calls: Array<{ file: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  try {
    writeNpmProject(root);
    const result = await provisionWorktreeDependencies(root, {
      env: {
        AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '1',
        AGENTBOARD_WORKTREE_DEPENDENCY_CONCURRENCY: '2',
        PATH: `/tmp/repo/node_modules/.bin${path.delimiter}/usr/bin`,
      },
      fsImpl: enoughSpaceFs(1024),
      execFileImpl: fakeSuccessfulNpm(calls),
    });
    assert.equal(result.status, 'installed');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.file, /^npm(\.cmd)?$/);
    assert.deepEqual(calls[0]!.args, buildNpmCiArgs());
    assert.equal(calls[0]!.cwd, root);
    assert.equal(calls[0]!.env?.PATH, '/usr/bin');
    assert.equal(calls[0]!.env?.npm_config_prefer_offline, 'true');
    assert.equal(calls[0]!.env?.npm_config_audit, 'false');
    assert.equal(calls[0]!.env?.npm_config_fund, 'false');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reused worktree skips install when local node_modules matches current package files', async () => {
  const root = makeDir('agentboard-node-reuse-');
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  try {
    writeNpmProject(root);
    markNodeModulesUsable(root);
    const project = detectNodeNpmProject(root);
    assert.ok(project);
    assert.equal(worktreeNodeModulesUsable(project), true);

    const result = await provisionWorktreeDependencies(root, {
      env: { AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '1' },
      fsImpl: enoughSpaceFs(1024),
      execFileImpl: fakeSuccessfulNpm(calls),
    });
    assert.equal(result.status, 'already-present');
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reused worktree reinstalls when local node_modules is stale for the current lockfile', async () => {
  const root = makeDir('agentboard-node-stale-');
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  try {
    writeNpmProject(root);
    markNodeModulesUsable(root);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(root, 'node_modules', '.package-lock.json'), old, old);
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"new":{}}}');

    const result = await provisionWorktreeDependencies(root, {
      env: { AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '1' },
      fsImpl: enoughSpaceFs(1024),
      execFileImpl: fakeSuccessfulNpm(calls),
    });
    assert.equal(result.status, 'installed');
    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dependency provisioning allows at most two concurrent npm installs per process', async () => {
  const roots = Array.from({ length: 5 }, () => makeDir('agentboard-node-concurrency-'));
  let active = 0;
  let maxActive = 0;
  const fakeNpm = ((file: string, args: readonly string[], options: { cwd?: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    void file;
    void args;
    active += 1;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      if (options.cwd) markNodeModulesUsable(options.cwd);
      active -= 1;
      callback(null, '', '');
    }, 25);
  }) as typeof execFile;

  try {
    for (const root of roots) writeNpmProject(root);
    await Promise.all(roots.map((root) => provisionWorktreeDependencies(root, {
      env: {
        AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '1',
        AGENTBOARD_WORKTREE_DEPENDENCY_CONCURRENCY: '2',
      },
      fsImpl: enoughSpaceFs(1024),
      execFileImpl: fakeNpm,
    })));
    assert.equal(maxActive, 2);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('npm failure prevents success and preserves the worktree for diagnosis', async () => {
  const root = makeDir('agentboard-node-failure-');
  const failingNpm = ((file: string, args: readonly string[], options: { cwd?: string }, callback: (error: Error & { stderr?: string }, stdout: string, stderr: string) => void) => {
    void file;
    void args;
    void options;
    const error = new Error('npm exited') as Error & { stderr?: string };
    error.stderr = 'dependency boom';
    callback(error, '', 'dependency boom');
  }) as typeof execFile;
  try {
    writeNpmProject(root);
    await assert.rejects(
      () => provisionWorktreeDependencies(root, {
        env: { AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '1' },
        fsImpl: enoughSpaceFs(1024),
        execFileImpl: failingNpm,
      }),
      /dependency boom/,
    );
    assert.equal(fs.existsSync(root), true);
    assert.equal(fs.existsSync(path.join(root, 'package.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source repository node_modules remains a real untouched directory', async () => {
  const source = makeDir('agentboard-source-node-modules-');
  const worktree = makeDir('agentboard-worktree-node-modules-');
  const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
  try {
    fs.mkdirSync(path.join(source, 'node_modules'));
    fs.writeFileSync(path.join(source, 'node_modules', 'sentinel.txt'), 'keep\n');
    writeNpmProject(worktree);

    const result = await provisionWorktreeDependencies(worktree, {
      env: { AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '1' },
      fsImpl: enoughSpaceFs(1024),
      execFileImpl: fakeSuccessfulNpm(calls),
    });

    assert.equal(result.status, 'installed');
    assert.equal(fs.lstatSync(path.join(source, 'node_modules')).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(source, 'node_modules')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(source, 'node_modules', 'sentinel.txt'), 'utf8'), 'keep\n');
    assert.equal(calls[0]!.cwd, worktree);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('source-repository and self-referential worktree node_modules symlinks are rejected and not replaced', async () => {
  const source = makeDir('agentboard-source-symlink-');
  const worktree = makeDir('agentboard-worktree-symlink-');
  const selfLinked = makeDir('agentboard-worktree-self-symlink-');
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  try {
    fs.mkdirSync(path.join(source, 'node_modules'));
    writeNpmProject(worktree);
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(worktree, 'node_modules'), 'dir');
    writeNpmProject(selfLinked);
    fs.symlinkSync('node_modules', path.join(selfLinked, 'node_modules'), 'dir');

    await assert.rejects(
      () => provisionWorktreeDependencies(worktree, {
        env: { AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '1' },
        fsImpl: enoughSpaceFs(1024),
        execFileImpl: fakeSuccessfulNpm(calls),
      }),
      /Refusing to use symbolic-link/,
    );
    assert.equal(calls.length, 0);
    assert.equal(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(source, 'node_modules')).isDirectory(), true);

    await assert.rejects(
      () => provisionWorktreeDependencies(selfLinked, {
        env: { AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES: '1' },
        fsImpl: enoughSpaceFs(1024),
        execFileImpl: fakeSuccessfulNpm(calls),
      }),
      /Refusing to use symbolic-link/,
    );
    assert.equal(calls.length, 0);
    assert.equal(fs.lstatSync(path.join(selfLinked, 'node_modules')).isSymbolicLink(), true);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(selfLinked, { recursive: true, force: true });
  }
});
