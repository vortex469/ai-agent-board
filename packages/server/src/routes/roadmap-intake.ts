import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { TaskRepository } from '../repositories/types.js';
import { importRoadmap, RoadmapValidationError } from '../services/roadmap-import.js';
import { broadcastGroupUpdate, broadcastTaskUpdate } from './helpers.js';
import { Router, Request, Response } from 'express';
import type { ProjectRepository } from '../repositories/project-types.js';
import { parseRoadmapText } from '../services/roadmap-intake.js';
import { asyncHandler } from './helpers.js';

export function createRoadmapIntakeRouter(projectRepo: ProjectRepository, groupRepo?: TaskGroupRepository, taskRepo?: TaskRepository): Router {
  const router = Router();

  router.post('/preview', asyncHandler(async (req: Request, res: Response) => {
    const project = typeof req.body.projectId === 'string' && req.body.projectId
      ? await projectRepo.getById(req.body.projectId)
      : await projectRepo.getDefault();
    if (!project) {
      res.status(400).json({ error: 'projectId is invalid' });
      return;
    }

    if (req.body.creationMode !== undefined && !['loose', 'group', 'multi-group'].includes(req.body.creationMode)) {
      res.status(400).json({ error: 'creationMode must be loose, group or multi-group' });
      return;
    }
    const result = parseRoadmapText(req.body.text, req.body.creationMode);
    if (typeof result === 'string') {
      res.status(400).json({ error: result });
      return;
    }

    res.json({
      project: {
        id: project.id,
        repoPath: project.repoPath,
        defaultAgentType: project.defaultAgentType,
        defaultPriority: project.defaultPriority,
        defaultBaseBranch: project.defaultBaseBranch,
        defaultUseWorktree: project.defaultUseWorktree,
      },
      tasks: result.tasks,
      groups: result.groups,
      suggestedGroupName: result.suggestedGroupName,
    });
  }));

  router.post('/import', asyncHandler(async (req: Request, res: Response) => {
    if (req.body.projectId !== undefined && (typeof req.body.projectId !== 'string' || !req.body.projectId.trim())) { res.status(400).json({ error: 'projectId is invalid' }); return; }
    const project = typeof req.body.projectId === 'string' && req.body.projectId
      ? await projectRepo.getById(req.body.projectId) : await projectRepo.getDefault();
    if (!project) { res.status(400).json({ error: 'projectId is invalid' }); return; }
    if (!groupRepo || !taskRepo) { res.status(503).json({ error: 'Import repositories unavailable' }); return; }
    try {
      const result = await importRoadmap(project, req.body.groups, groupRepo, taskRepo);
      for (const group of result.groups) broadcastGroupUpdate(group);
      for (const task of result.tasks) broadcastTaskUpdate(task);
      res.status(201).json(result);
    } catch (error) {
      res.status(error instanceof RoadmapValidationError ? 400 : 500).json({ error: error instanceof Error ? error.message : 'Roadmap import failed' });
    }
  }));
  return router;
}
