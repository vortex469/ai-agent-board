import { Router, Request, Response } from 'express';
import type { ProjectRepository } from '../repositories/project-types.js';
import { parseRoadmapText } from '../services/roadmap-intake.js';
import { asyncHandler } from './helpers.js';

export function createRoadmapIntakeRouter(projectRepo: ProjectRepository): Router {
  const router = Router();

  router.post('/preview', asyncHandler(async (req: Request, res: Response) => {
    const project = typeof req.body.projectId === 'string' && req.body.projectId
      ? await projectRepo.getById(req.body.projectId)
      : await projectRepo.getDefault();
    if (!project) {
      res.status(400).json({ error: 'projectId is invalid' });
      return;
    }

    if (req.body.creationMode !== undefined && !['loose', 'group'].includes(req.body.creationMode)) {
      res.status(400).json({ error: 'creationMode must be loose or group' });
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
      suggestedGroupName: result.suggestedGroupName,
    });
  }));

  return router;
}
