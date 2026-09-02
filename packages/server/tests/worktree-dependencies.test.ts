import assert from 'node:assert/strict';
import type { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WORKTREE_DEPENDENCY_CONCURRENCY,
  DEFAULT_WORKTREE_MIN_FREE_SPACE_BYTES,
  assertMinimumFreeSpace,
  buildNpmCiArgs,
  buildNpmRunBuildSharedArgs,
  bootstrapNpmWorkspaceIfNeeded,
  detectNodeNpmProject,
  detectProjectPythonEnvironment,
  getWorktreeDependencyConfig,
  provisionWorktreeDependencies,
  shouldBootstrapNpmWorkspace,
  worktreeNodeModulesUsable,
} from '../src/services/worktree-dependencies.js';

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeNpmProject(root: string): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {}, dependencies: {} }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
}

function writeVenvPython(root: string, name = '.venv'): string {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const executableName = process.platform === 'win32' ? 'python.exe' : 'python';
  const interpreterPath = path.join(root, name, binDir, executableName);
  fs.mkdirSync(path.dirname(interpreterPath), { recursive: true });
  fs.writeFileSync(interpreterPath, '');
  return interpreterPath;
}

function writeNpmWorkspaceProject(root: string, scripts: Record<string, unknown> = { 'build:shared': 'echo build' }): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    workspaces: ['shared'],
    scripts,
    dependencies: {},
  }));
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

function fakeSuccessfulNpmScript(calls: Array<{ file: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }>): typeof execFile {
  return ((file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ file, args, cwd: options.cwd, env: options.env });
    callback(null, 'built\n', '');
  }) as typeof execFile;
}

function fakePythonProbe(
  calls: Array<{ file: string; args: readonly string[] }>,
  results: Record<string, string | null>,
): typeof execFileSync {
  return ((file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const result = results[file];
    if (!result) throw new Error(`${file} unavailable`);
    return `${result}\n`;
  }) as typeof execFileSync;
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

test('python environment detection prefers worktree venv before repository venv', () => {
  const repo = makeDir('agentboard-python-repo-');
  const worktree = makeDir('agentboard-python-worktree-');
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  try {
    const repoPython = writeVenvPython(repo);
    const worktreePython = writeVenvPython(worktree);

    assert.deepEqual(detectProjectPythonEnvironment(worktree, {
      repoPath: repo,
      env: { AGENTBOARD_PYTHON_INTERPRETER: '/configured/python' },
      execFileSyncImpl: fakePythonProbe(calls, { '/configured/python': '/configured/python' }),
    }), {
      source: 'worktree-venv',
      interpreterPath: worktreePython,
      venvPath: path.join(worktree, '.venv'),
    });
    assert.equal(calls.length, 0);

    fs.rmSync(path.join(worktree, '.venv'), { recursive: true, force: true });
    assert.deepEqual(detectProjectPythonEnvironment(worktree, {
      repoPath: repo,
      env: { AGENTBOARD_PYTHON_INTERPRETER: '/configured/python' },
      execFileSyncImpl: fakePythonProbe(calls, { '/configured/python': '/configured/python' }),
    }), {
      source: 'repo-venv',
      interpreterPath: repoPython,
      venvPath: path.join(repo, '.venv'),
    });
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('python environment detection falls back to configured then system interpreter', () => {
  const worktree = makeDir('agentboard-python-fallback-');
  try {
    const configuredCalls: Array<{ file: string; args: readonly string[] }> = [];
    assert.deepEqual(detectProjectPythonEnvironment(worktree, {
      env: { AGENTBOARD_PYTHON_INTERPRETER: '/opt/project-python' },
      execFileSyncImpl: fakePythonProbe(configuredCalls, { '/opt/project-python': '/opt/project-python' }),
    }), {
      source: 'configured',
      interpreterPath: '/opt/project-python',
    });
    assert.equal(configuredCalls[0]!.file, '/opt/project-python');
    assert.deepEqual(configuredCalls[0]!.args, ['-c', 'import sys; print(sys.executable)']);

    const systemCalls: Array<{ file: string; args: readonly string[] }> = [];
    const firstSystemCandidate = process.platform === 'win32' ? 'py' : 'python3';
    const firstSystemArgs = process.platform === 'win32'
      ? ['-3', '-c', 'import sys; print(sys.executable)']
      : ['-c', 'import sys; print(sys.executable)'];
    assert.deepEqual(detectProjectPythonEnvironment(worktree, {
      env: {},
      execFileSyncImpl: fakePythonProbe(systemCalls, { [firstSystemCandidate]: '/usr/bin/python3' }),
    }), {
      source: 'system',
      interpreterPath: '/usr/bin/python3',
    });
    assert.equal(systemCalls[0]!.file, firstSystemCandidate);
    assert.deepEqual(systemCalls[0]!.args, firstSystemArgs);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
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

test('workspace bootstrap detection requires npm workspaces and exact build:shared script', () => {
  const root = makeDir('agentboard-workspace-detect-');
  try {
    writeNpmWorkspaceProject(root);
    const project = detectNodeNpmProject(root);
    assert.ok(project);
    assert.deepEqual(shouldBootstrapNpmWorkspace(project), { shouldBootstrap: true });

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      private: true,
      workspaces: { packages: ['packages/*'] },
      scripts: { 'build:shared': 'echo build' },
    }));
    assert.deepEqual(shouldBootstrapNpmWorkspace(project), { shouldBootstrap: true });

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: { 'build:shared': 'echo build' },
    }));
    assert.deepEqual(shouldBootstrapNpmWorkspace(project), {
      shouldBootstrap: false,
      reason: 'Root package.json is not an npm workspace project.',
    });

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      private: true,
      workspaces: ['shared'],
      scripts: { 'build-shared': 'echo build' },
    }));
    assert.deepEqual(shouldBootstrapNpmWorkspace(project), {
      shouldBootstrap: false,
      reason: 'Root package.json has no exact build:shared script.',
    });

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      private: true,
      workspaces: ['shared'],
      scripts: { 'build:shared': true },
    }));
    assert.deepEqual(shouldBootstrapNpmWorkspace(project), {
      shouldBootstrap: false,
      reason: 'Root package.json has no exact build:shared script.',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace bootstrap is a no-op when build:shared is absent', async () => {
  const root = makeDir('agentboard-workspace-noop-');
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  try {
    writeNpmWorkspaceProject(root, { build: 'echo build' });
    const project = detectNodeNpmProject(root);
    assert.ok(project);
    const result = await bootstrapNpmWorkspaceIfNeeded(project, {
      execFileImpl: fakeSuccessfulNpmScript(calls),
    });
    assert.deepEqual(result, { status: 'skipped', reason: 'Root package.json has no exact build:shared script.' });
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace bootstrap runs npm run build:shared with fixed arguments inside the worktree', async () => {
  const root = makeDir('agentboard-workspace-bootstrap-');
  const calls: Array<{ file: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  try {
    writeNpmWorkspaceProject(root);
    const project = detectNodeNpmProject(root);
    assert.ok(project);
    const result = await bootstrapNpmWorkspaceIfNeeded(project, {
      env: {
        PATH: `/tmp/repo/node_modules/.bin${path.delimiter}/usr/local/bin${path.delimiter}node_modules/.bin`,
        HOME: '/home/tester',
        SECRET_TOKEN: 'do-not-pass',
      },
      execFileImpl: fakeSuccessfulNpmScript(calls),
    });

    assert.equal(result.status, 'ran');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.file, /^npm(\.cmd)?$/);
    assert.deepEqual(calls[0]!.args, buildNpmRunBuildSharedArgs());
    assert.equal(calls[0]!.cwd, root);
    assert.equal(calls[0]!.env?.PATH, '/usr/local/bin');
    assert.equal(calls[0]!.env?.HOME, '/home/tester');
    assert.equal(calls[0]!.env?.SECRET_TOKEN, undefined);
    assert.equal(calls[0]!.env?.npm_config_prefer_offline, 'true');
    assert.equal(calls[0]!.env?.npm_config_audit, 'false');
    assert.equal(calls[0]!.env?.npm_config_fund, 'false');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace bootstrap failure reports bounded stdout and stderr', async () => {
  const root = makeDir('agentboard-workspace-failure-');
  const failingNpm = ((file: string, args: readonly string[], options: { cwd?: string }, callback: (error: Error & { stdout?: string; stderr?: string }, stdout: string, stderr: string) => void) => {
    void file;
    void args;
    void options;
    const error = new Error('npm exited') as Error & { stdout?: string; stderr?: string };
    error.stdout = 'out '.repeat(4_000);
    error.stderr = 'bootstrap boom';
    callback(error, error.stdout, error.stderr);
  }) as typeof execFile;
  try {
    writeNpmWorkspaceProject(root);
    const project = detectNodeNpmProject(root);
    assert.ok(project);
    await assert.rejects(
      () => bootstrapNpmWorkspaceIfNeeded(project, { execFileImpl: failingNpm }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /npm workspace bootstrap failed/);
        assert.match(err.message, /stderr:\nbootstrap boom/);
        assert.match(err.message, /stdout:\nout out/);
        assert.match(err.message, /\[output truncated to 8000 characters\]/);
        assert.ok(err.message.length < 9_000);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace bootstrap never modifies the source repository', async () => {
  const source = makeDir('agentboard-source-bootstrap-');
  const worktree = makeDir('agentboard-worktree-bootstrap-');
  const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
  try {
    writeNpmWorkspaceProject(source, { 'build:shared': 'echo source' });
    fs.writeFileSync(path.join(source, 'source-sentinel.txt'), 'keep\n');
    writeNpmWorkspaceProject(worktree, { 'build:shared': 'echo worktree' });

    const fakeNpm = ((file: string, args: readonly string[], options: { cwd?: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      calls.push({ file, args, cwd: options.cwd });
      if (options.cwd) fs.writeFileSync(path.join(options.cwd, 'bootstrap-output.txt'), 'worktree only\n');
      callback(null, '', '');
    }) as typeof execFile;

    const project = detectNodeNpmProject(worktree);
    assert.ok(project);
    const result = await bootstrapNpmWorkspaceIfNeeded(project, { execFileImpl: fakeNpm });

    assert.equal(result.status, 'ran');
    assert.equal(calls[0]!.cwd, worktree);
    assert.equal(fs.existsSync(path.join(worktree, 'bootstrap-output.txt')), true);
    assert.equal(fs.existsSync(path.join(source, 'bootstrap-output.txt')), false);
    assert.equal(fs.readFileSync(path.join(source, 'source-sentinel.txt'), 'utf8'), 'keep\n');
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
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
