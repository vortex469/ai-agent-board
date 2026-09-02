import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '../utils.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_WORKTREE_DEPENDENCY_CONCURRENCY = 2;
export const DEFAULT_WORKTREE_MIN_FREE_SPACE_BYTES = 8 * 1024 * 1024 * 1024;

const SUPPORTED_NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'] as const;

export interface WorktreeDependencyConfig {
  maxConcurrentInstalls: number;
  minFreeSpaceBytes: number;
}

export interface NodeProjectInfo {
  projectRoot: string;
  packageJsonPath: string;
  lockfilePath: string;
  lockfileName: string;
}

export type PythonEnvironmentSource = 'worktree-venv' | 'repo-venv' | 'configured' | 'system';

export interface PythonEnvironmentSelection {
  interpreterPath: string;
  source: PythonEnvironmentSource;
  venvPath?: string;
  pytestAvailable: boolean;
}

export type WorktreeDependencyProvisionResult =
  | { status: 'skipped'; reason: string }
  | { status: 'already-present'; project: NodeProjectInfo }
  | { status: 'installed'; project: NodeProjectInfo };

export type WorktreeWorkspaceBootstrapResult =
  | { status: 'skipped'; reason: string }
  | { status: 'ran'; project: NodeProjectInfo };

export interface WorktreeDependencyProvisionOptions {
  env?: NodeJS.ProcessEnv;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'lstatSync' | 'statSync' | 'statfsSync'>;
  execFileImpl?: typeof execFile;
}

export interface WorktreeWorkspaceBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync'>;
  execFileImpl?: typeof execFile;
}

export interface PythonEnvironmentDetectionOptions {
  repoPath?: string;
  env?: NodeJS.ProcessEnv;
  fsImpl?: Pick<typeof fs, 'existsSync'>;
  execFileSyncImpl?: typeof execFileSync;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number, name: string): number {
  const trimmed = value?.trim();
  if (!trimmed) return defaultValue;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function getWorktreeDependencyConfig(env: NodeJS.ProcessEnv = process.env): WorktreeDependencyConfig {
  return {
    maxConcurrentInstalls: parsePositiveInteger(
      env.AGENTBOARD_WORKTREE_DEPENDENCY_CONCURRENCY,
      DEFAULT_WORKTREE_DEPENDENCY_CONCURRENCY,
      'AGENTBOARD_WORKTREE_DEPENDENCY_CONCURRENCY',
    ),
    minFreeSpaceBytes: parsePositiveInteger(
      env.AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES,
      DEFAULT_WORKTREE_MIN_FREE_SPACE_BYTES,
      'AGENTBOARD_WORKTREE_MIN_FREE_SPACE_BYTES',
    ),
  };
}

export function detectNodeNpmProject(
  worktreePath: string,
  fsImpl: Pick<typeof fs, 'existsSync'> = fs,
): NodeProjectInfo | null {
  const projectRoot = path.resolve(worktreePath);
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!fsImpl.existsSync(packageJsonPath)) return null;

  for (const lockfileName of SUPPORTED_NPM_LOCKFILES) {
    const lockfilePath = path.join(projectRoot, lockfileName);
    if (fsImpl.existsSync(lockfilePath)) {
      return { projectRoot, packageJsonPath, lockfilePath, lockfileName };
    }
  }
  return null;
}

function pythonExecutableNames(): string[] {
  return process.platform === 'win32' ? ['python.exe', 'python'] : ['python'];
}

function virtualEnvPythonCandidates(rootPath: string): Array<{ venvPath: string; interpreterPath: string }> {
  const resolvedRoot = path.resolve(rootPath);
  const venvNames = ['.venv', 'venv'];
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const candidates: Array<{ venvPath: string; interpreterPath: string }> = [];
  for (const venvName of venvNames) {
    const venvPath = path.join(resolvedRoot, venvName);
    for (const executableName of pythonExecutableNames()) {
      candidates.push({
        venvPath,
        interpreterPath: path.join(venvPath, binDir, executableName),
      });
    }
  }
  return candidates;
}

function pythonPytestProbeArgs(): string[] {
  return ['-m', 'pytest', '--version'];
}

function detectPytestAvailable(
  interpreterPath: string,
  execFileSyncImpl: typeof execFileSync,
): boolean {
  try {
    execFileSyncImpl(interpreterPath, pythonPytestProbeArgs(), {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

function detectVirtualEnvPython(
  rootPath: string | undefined,
  source: Extract<PythonEnvironmentSource, 'worktree-venv' | 'repo-venv'>,
  fsImpl: Pick<typeof fs, 'existsSync'>,
  execFileSyncImpl: typeof execFileSync,
): PythonEnvironmentSelection | null {
  if (!rootPath) return null;
  for (const candidate of virtualEnvPythonCandidates(rootPath)) {
    if (fsImpl.existsSync(candidate.interpreterPath)) {
      return {
        source,
        interpreterPath: candidate.interpreterPath,
        venvPath: candidate.venvPath,
        pytestAvailable: detectPytestAvailable(candidate.interpreterPath, execFileSyncImpl),
      };
    }
  }
  return null;
}

function pythonProbeArgs(prefixArgs: string[] = []): string[] {
  return [...prefixArgs, '-c', 'import sys; print(sys.executable)'];
}

function resolveUsablePython(
  command: string,
  prefixArgs: string[],
  execFileSyncImpl: typeof execFileSync,
): string | null {
  try {
    const output = execFileSyncImpl(command, pythonProbeArgs(prefixArgs), {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const executable = String(output).trim();
    return executable || command;
  } catch {
    return null;
  }
}

export function detectProjectPythonEnvironment(
  worktreePath: string | undefined,
  options: PythonEnvironmentDetectionOptions = {},
): PythonEnvironmentSelection | null {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;

  const worktreeVenv = detectVirtualEnvPython(worktreePath, 'worktree-venv', fsImpl, execFileSyncImpl);
  if (worktreeVenv) return worktreeVenv;

  const repoVenv = detectVirtualEnvPython(options.repoPath, 'repo-venv', fsImpl, execFileSyncImpl);
  if (repoVenv) return repoVenv;

  const configured = env.AGENTBOARD_PYTHON_INTERPRETER?.trim() || env.PYTHON?.trim();
  if (configured) {
    const executable = resolveUsablePython(configured, [], execFileSyncImpl);
    if (executable) {
      return { source: 'configured', interpreterPath: executable, pytestAvailable: detectPytestAvailable(executable, execFileSyncImpl) };
    }
  }

  const systemCandidates: Array<{ command: string; prefixArgs: string[] }> = process.platform === 'win32'
    ? [
        { command: 'py', prefixArgs: ['-3'] },
        { command: 'python', prefixArgs: [] },
        { command: 'python3', prefixArgs: [] },
      ]
    : [
        { command: 'python3', prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
      ];

  for (const candidate of systemCandidates) {
    const executable = resolveUsablePython(candidate.command, candidate.prefixArgs, execFileSyncImpl);
    if (executable) {
      return { source: 'system', interpreterPath: executable, pytestAvailable: detectPytestAvailable(executable, execFileSyncImpl) };
    }
  }

  return null;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function getFreeSpaceBytes(
  targetPath: string,
  fsImpl: Pick<typeof fs, 'statfsSync'> = fs,
): number {
  const stats = fsImpl.statfsSync(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function assertMinimumFreeSpace(
  targetPath: string,
  minFreeSpaceBytes: number,
  fsImpl: Pick<typeof fs, 'statfsSync'> = fs,
): void {
  const freeSpaceBytes = getFreeSpaceBytes(targetPath, fsImpl);
  if (freeSpaceBytes < minFreeSpaceBytes) {
    throw new Error(
      `Not enough free space to provision worktree dependencies at ${path.resolve(targetPath)}: ` +
      `${formatBytes(freeSpaceBytes)} available, ${formatBytes(minFreeSpaceBytes)} required.`,
    );
  }
}

export function worktreeNodeModulesUsable(
  project: NodeProjectInfo,
  fsImpl: Pick<typeof fs, 'existsSync' | 'lstatSync' | 'statSync'> = fs,
): boolean {
  const nodeModulesPath = path.join(project.projectRoot, 'node_modules');

  let nodeModulesStat: fs.Stats;
  try {
    nodeModulesStat = fsImpl.lstatSync(nodeModulesPath);
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') return false;
    throw err;
  }
  if (nodeModulesStat.isSymbolicLink() || !nodeModulesStat.isDirectory()) {
    throw new Error(`Refusing to use symbolic-link or non-directory node_modules in worktree: ${nodeModulesPath}`);
  }

  const npmInstallStatePath = path.join(nodeModulesPath, '.package-lock.json');
  if (!fsImpl.existsSync(npmInstallStatePath)) return false;
  const installStateStat = fsImpl.lstatSync(npmInstallStatePath);
  if (installStateStat.isSymbolicLink() || !installStateStat.isFile()) return false;

  const installMtime = installStateStat.mtimeMs;
  const packageMtime = fsImpl.statSync(project.packageJsonPath).mtimeMs;
  const lockfileMtime = fsImpl.statSync(project.lockfilePath).mtimeMs;
  return installMtime >= packageMtime && installMtime >= lockfileMtime;
}

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function stripNodeModulesBinFromPath(value: string | undefined): string | undefined {
  if (!value) return value;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const safeEntries = value
    .split(delimiter)
    .filter((entry) => {
      const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      return !normalized.endsWith('/node_modules/.bin') && normalized !== 'node_modules/.bin';
    });
  return safeEntries.length > 0 ? safeEntries.join(delimiter) : undefined;
}

export function buildProvisionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  const allowedKeys = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'CI',
    'NO_COLOR',
    'FORCE_COLOR',
  ];
  for (const key of allowedKeys) {
    if (env[key] !== undefined) next[key] = env[key];
  }
  next.PATH = stripNodeModulesBinFromPath(next.PATH);
  if (next.PATH === undefined) delete next.PATH;
  next.npm_config_prefer_offline = 'true';
  next.npm_config_audit = 'false';
  next.npm_config_fund = 'false';
  return next;
}

export function buildNpmCiArgs(): string[] {
  return ['ci', '--prefer-offline', '--no-audit', '--no-fund'];
}

export function buildNpmRunBuildSharedArgs(): string[] {
  return ['run', 'build:shared'];
}

function boundedOutput(value: unknown, maxLength = 8_000): string {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[output truncated to ${maxLength} characters]`;
}

function hasNpmWorkspaces(packageJson: unknown): boolean {
  if (!packageJson || typeof packageJson !== 'object') return false;
  const workspaces = (packageJson as { workspaces?: unknown }).workspaces;
  if (Array.isArray(workspaces)) return workspaces.length > 0 && workspaces.every((item) => typeof item === 'string');
  if (workspaces && typeof workspaces === 'object') {
    const packages = (workspaces as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.length > 0 && packages.every((item) => typeof item === 'string');
  }
  return false;
}

function hasExactBuildSharedScript(packageJson: unknown): boolean {
  if (!packageJson || typeof packageJson !== 'object') return false;
  const scripts = (packageJson as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return false;
  return Object.prototype.hasOwnProperty.call(scripts, 'build:shared') &&
    typeof (scripts as Record<string, unknown>)['build:shared'] === 'string';
}

type QueueTask<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

class AsyncInstallQueue {
  private active = 0;
  private pending: QueueTask<unknown>[] = [];

  constructor(private readonly limit: number) {}

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) return;
      this.active += 1;
      task.run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

const queuesByLimit = new Map<number, AsyncInstallQueue>();

function installQueue(limit: number): AsyncInstallQueue {
  let queue = queuesByLimit.get(limit);
  if (!queue) {
    queue = new AsyncInstallQueue(limit);
    queuesByLimit.set(limit, queue);
  }
  return queue;
}

async function runNpmCi(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  execFileImpl: typeof execFile = execFile,
): Promise<void> {
  const execAsync = execFileImpl === execFile ? execFileAsync : promisify(execFileImpl);
  try {
    await execAsync(npmExecutable(), buildNpmCiArgs(), {
      cwd: projectRoot,
      env: buildProvisionEnv(env),
      shell: false,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '').trim() : '';
    const detail = stderr || errorMessage(err);
    throw new Error(`npm dependency provisioning failed: ${detail}`);
  }
}

async function runNpmBuildShared(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  execFileImpl: typeof execFile = execFile,
): Promise<void> {
  const execAsync = execFileImpl === execFile ? execFileAsync : promisify(execFileImpl);
  try {
    await execAsync(npmExecutable(), buildNpmRunBuildSharedArgs(), {
      cwd: projectRoot,
      env: buildProvisionEnv(env),
      shell: false,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const stdout = err && typeof err === 'object' && 'stdout' in err
      ? boundedOutput((err as { stdout?: unknown }).stdout)
      : '';
    const stderr = err && typeof err === 'object' && 'stderr' in err
      ? boundedOutput((err as { stderr?: unknown }).stderr)
      : '';
    const parts = [
      stderr ? `stderr:\n${stderr}` : '',
      stdout ? `stdout:\n${stdout}` : '',
    ].filter(Boolean);
    const detail = parts.length > 0 ? parts.join('\n\n') : errorMessage(err);
    throw new Error(`npm workspace bootstrap failed: ${detail}`);
  }
}

export function shouldBootstrapNpmWorkspace(
  project: NodeProjectInfo,
  fsImpl: Pick<typeof fs, 'readFileSync'> = fs,
): { shouldBootstrap: true } | { shouldBootstrap: false; reason: string } {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(fsImpl.readFileSync(project.packageJsonPath, 'utf8'));
  } catch (err: unknown) {
    throw new Error(`Failed to read workspace package.json: ${errorMessage(err)}`);
  }

  if (!hasNpmWorkspaces(packageJson)) {
    return { shouldBootstrap: false, reason: 'Root package.json is not an npm workspace project.' };
  }
  if (!hasExactBuildSharedScript(packageJson)) {
    return { shouldBootstrap: false, reason: 'Root package.json has no exact build:shared script.' };
  }
  return { shouldBootstrap: true };
}

export async function bootstrapNpmWorkspaceIfNeeded(
  project: NodeProjectInfo,
  options: WorktreeWorkspaceBootstrapOptions = {},
): Promise<WorktreeWorkspaceBootstrapResult> {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const decision = shouldBootstrapNpmWorkspace(project, fsImpl);
  if (!decision.shouldBootstrap) return { status: 'skipped', reason: decision.reason };

  await runNpmBuildShared(project.projectRoot, env, options.execFileImpl);
  return { status: 'ran', project };
}

export async function provisionWorktreeDependencies(
  worktreePath: string,
  options: WorktreeDependencyProvisionOptions = {},
): Promise<WorktreeDependencyProvisionResult> {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const config = getWorktreeDependencyConfig(env);
  const project = detectNodeNpmProject(worktreePath, fsImpl);
  if (!project) {
    return { status: 'skipped', reason: 'No package.json with supported npm lockfile was found.' };
  }

  if (worktreeNodeModulesUsable(project, fsImpl)) {
    return { status: 'already-present', project };
  }

  assertMinimumFreeSpace(project.projectRoot, config.minFreeSpaceBytes, fsImpl);
  await installQueue(config.maxConcurrentInstalls).enqueue(() => runNpmCi(project.projectRoot, env, options.execFileImpl));

  if (!worktreeNodeModulesUsable(project, fsImpl)) {
    throw new Error('npm dependency provisioning completed but worktree-local node_modules is not usable.');
  }
  return { status: 'installed', project };
}
