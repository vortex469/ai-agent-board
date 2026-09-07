import type { Task } from '@/types';

// A broadcast received during a mutation supersedes its eventual REST response.
// Tokens also keep an older request from replacing a newer mutation's result.
export function createTaskUpdateTracker(apply: (task: Task) => void) {
  const pending = new Map<string, symbol>();
  return {
    start(id: string): (task?: Task) => void {
      const token = Symbol(id);
      pending.set(id, token);
      return (task?: Task) => {
        if (pending.get(id) !== token) return;
        pending.delete(id);
        if (task) apply(task);
      };
    },
    receive(task: Task): void {
      pending.delete(task.id);
      apply(task);
    },
  };
}
