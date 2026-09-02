import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentExecutionPrompt, buildAgentSystemPrompt } from '../src/services/agent-manager.js';

test('agent execution prompt treats detailed task description as authoritative over display title', () => {
  const prompt = buildAgentExecutionPrompt({
    title: '01. Create ROADMAPPIPELINESMOKE.md',
    description: 'Source roadmap item:\n\n- Create ROADMAP_PIPELINE_SMOKE.md',
  });

  assert.match(prompt, /^Task details \(authoritative; follow this when it conflicts with the display title\):/);
  assert.ok(prompt.indexOf('ROADMAP_PIPELINE_SMOKE.md') < prompt.indexOf('ROADMAPPIPELINESMOKE.md'));
  assert.match(prompt, /Display title \(for board identification only\):\n01\. Create ROADMAPPIPELINESMOKE\.md/);
});

test('agent system prompt repeats that detailed source text wins title conflicts', () => {
  const systemPrompt = buildAgentSystemPrompt({
    workingDirectory: '/tmp/repo',
    taskTitle: '01. Create ROADMAPPIPELINESMOKE.md',
    hasGit: true,
  });

  assert.match(systemPrompt, /detailed task description\/source item in the user prompt is authoritative/i);
  assert.match(systemPrompt, /follow the detailed description\/source item/i);
});

test('agent system prompt records selected Python interpreter and forbids global package installs', () => {
  const systemPrompt = buildAgentSystemPrompt({
    workingDirectory: '/tmp/worktree',
    taskTitle: 'Run Python tests',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    hasGit: true,
    pythonEnvironment: {
      source: 'worktree-venv',
      interpreterPath: '/tmp/worktree/.venv/bin/python',
      venvPath: '/tmp/worktree/.venv',
      pytestAvailable: true,
    },
  });

  assert.match(systemPrompt, /Selected interpreter: \/tmp\/worktree\/\.venv\/bin\/python/);
  assert.match(systemPrompt, /Selection source: worktree-venv/);
  assert.match(systemPrompt, /Pytest availability: detected/);
  assert.match(systemPrompt, /cd \/tmp\/worktree && \/tmp\/worktree\/\.venv\/bin\/python -m pytest/);
  assert.match(systemPrompt, /Do not run bare `pytest`, a different Python executable, or tests from another checkout/);
  assert.match(systemPrompt, /never install them globally/i);
  assert.match(systemPrompt, /\/tmp\/worktree\/\.venv\/bin\/python -m pip/);
});

test('agent system prompt permits an external selected interpreter only for worktree-scoped test commands', () => {
  const systemPrompt = buildAgentSystemPrompt({
    workingDirectory: '/tmp/agentboard-task-worktree',
    taskTitle: 'Run Atlas tests',
    repoPath: '/opt/atlas',
    worktreePath: '/tmp/agentboard-task-worktree',
    hasGit: true,
    pythonEnvironment: {
      source: 'repo-venv',
      interpreterPath: '/opt/atlas/.venv/bin/python',
      venvPath: '/opt/atlas/.venv',
      pytestAvailable: true,
    },
  });

  assert.match(systemPrompt, /Selected interpreter: \/opt\/atlas\/\.venv\/bin\/python/);
  assert.match(systemPrompt, /cd \/tmp\/agentboard-task-worktree && \/opt\/atlas\/\.venv\/bin\/python -m pytest/);
  assert.match(systemPrompt, /interpreter may live outside the task worktree/);
  assert.match(systemPrompt, /allowed only as the Python executable for commands run in \/tmp\/agentboard-task-worktree/);
  assert.match(systemPrompt, /keep all file reads, writes, and test working directories inside \/tmp\/agentboard-task-worktree/);
});

test('agent system prompt reports missing pytest and still forbids global installs', () => {
  const systemPrompt = buildAgentSystemPrompt({
    workingDirectory: '/tmp/python-worktree',
    taskTitle: 'Run pytest',
    repoPath: '/tmp/source-repo',
    worktreePath: '/tmp/python-worktree',
    hasGit: true,
    pythonEnvironment: {
      source: 'system',
      interpreterPath: '/usr/bin/python3',
      pytestAvailable: false,
    },
  });

  assert.match(systemPrompt, /Pytest availability: not detected with `\/usr\/bin\/python3 -m pytest --version`/);
  assert.match(systemPrompt, /Environment error: pytest is not installed for \/usr\/bin\/python3/);
  assert.match(systemPrompt, /Create or use a project-local virtual environment under \/tmp\/python-worktree before installing packages/);
  assert.match(systemPrompt, /never install them globally/i);
  assert.doesNotMatch(systemPrompt, /\/usr\/bin\/python3 -m pip install/);
});
