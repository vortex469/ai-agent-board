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
