import fs from 'node:fs';
import path from 'node:path';

export interface DependencyLinkTarget {
  relativePath: string;
  sourcePath: string;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertContainedDirectory(candidatePath: string, root: string, label: string): string {
  const resolved = path.resolve(candidatePath);
  if (!isWithin(normalizedPath(resolved), normalizedPath(root))) {
    throw new Error(`${label} is outside the source repository`);
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve ${label}: ${reason}`);
  }
  if (!isWithin(normalizedPath(canonical), normalizedPath(root))) {
    throw new Error(`${label} resolves outside the source repository`);
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`${label} is not a directory`);
  }
  return canonical;
}

export function discoverNodeDependencyLinks(repoPath: string): DependencyLinkTarget[] {
  const resolvedRepo = path.resolve(repoPath);
  const canonicalRepo = fs.realpathSync(resolvedRepo);
  const targets: DependencyLinkTarget[] = [];

  const walk = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name === 'node_modules') {
        assertContainedDirectory(entryPath, canonicalRepo, `Dependency directory ${entryPath}`);
        targets.push({
          relativePath: path.relative(canonicalRepo, path.resolve(entryPath)),
          sourcePath: path.resolve(entryPath),
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const canonicalEntry = fs.realpathSync(entryPath);
      if (!isWithin(normalizedPath(canonicalEntry), normalizedPath(canonicalRepo))) continue;
      walk(entryPath);
    }
  };

  walk(canonicalRepo);
  return targets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function linkNodeDependenciesIntoWorktree(repoPath: string, worktreePath: string): DependencyLinkTarget[] {
  const targets = discoverNodeDependencyLinks(repoPath);
  if (targets.length === 0) return [];

  const canonicalRepo = fs.realpathSync(path.resolve(repoPath));
  const canonicalWorktree = fs.realpathSync(path.resolve(worktreePath));
  if (normalizedPath(canonicalRepo) === normalizedPath(canonicalWorktree)) {
    throw new Error('Refusing to link dependencies into the source repository checkout');
  }

  const linked: DependencyLinkTarget[] = [];
  for (const target of targets) {
    const sourcePath = path.resolve(target.sourcePath);
    assertContainedDirectory(sourcePath, canonicalRepo, `Dependency directory ${sourcePath}`);

    const destinationPath = path.resolve(canonicalWorktree, target.relativePath);
    if (!isWithin(normalizedPath(destinationPath), normalizedPath(canonicalWorktree))) {
      throw new Error(`Dependency link destination ${destinationPath} is outside the worktree`);
    }
    const parent = path.dirname(destinationPath);
    if (fs.existsSync(destinationPath) || !fs.existsSync(parent)) {
      continue;
    }
    const canonicalParent = fs.realpathSync(parent);
    if (!isWithin(normalizedPath(canonicalParent), normalizedPath(canonicalWorktree))) {
      throw new Error(`Dependency link parent ${parent} resolves outside the worktree`);
    }

    fs.symlinkSync(sourcePath, destinationPath, 'dir');
    linked.push(target);
  }

  return linked;
}
