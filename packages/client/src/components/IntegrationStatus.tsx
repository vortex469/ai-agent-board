import { useEffect, useRef, useState } from 'react';
import type { Task } from '@/types';
import { api, connectWS, type TaskIntegrationStatus } from '@/lib/api';
import { useDependencies } from './TaskDependencies';

export function IntegrationStatusView({ status, busy, error, onRecheck }: {
  status: TaskIntegrationStatus | null; busy: boolean; error: string; onRecheck: () => void;
}) {
  return <div className="mt-2 space-y-1 text-xs" onClick={event => event.stopPropagation()}>
    <p role="status" className={status?.synchronized ? 'text-emerald-400' : 'text-amber-300'}>
      Repository: {status?.synchronized ? 'Synchronized / integrated' : status ? 'Integration pending' : 'Checking integration…'}
    </p>
    {!status?.synchronized && status?.reason && <p className="text-amber-300">{status.reason}</p>}
    {!status?.synchronized && <button type="button" disabled={busy} onClick={onRecheck}
      className="min-h-11 rounded border border-zinc-600 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
      {busy ? 'Checking integration…' : 'Recheck integration'}
    </button>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </div>;
}

export function IntegrationStatus({ task, onSynchronized }: { task: Task; onSynchronized?: () => void }) {
  const [status, setStatus] = useState<TaskIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const inFlight = useRef(false);
  const activeTask = useRef(task.id);
  activeTask.current = task.id;
  const synchronized = useRef(onSynchronized);
  synchronized.current = onSynchronized;
  const { refresh } = useDependencies();
  const applicable = task.agentStatus === 'complete' && !!task.groupId && !!task.repositoryBaseline?.resultCommit;
  useEffect(() => {
    setStatus(null); setError(''); setBusy(false); inFlight.current = false;
    if (!applicable) return;
    let disposed = false;
    const read = async () => {
      const current = ++generation.current;
      try {
        const info = await api.getGitInfo(task.id);
        if (disposed || current !== generation.current) return;
        setStatus(info.integration ?? null);
        setError('');
        if (info.integration?.synchronized) synchronized.current?.();
      } catch (err) {
        if (!disposed && current === generation.current) setError(err instanceof Error ? err.message : 'Integration status unavailable');
      }
    };
    void read();
    const disconnect = connectWS(message => {
      if (message.type === 'task_updated' && message.payload.id === task.id) void read();
    }, () => { void read(); });
    return () => { disposed = true; ++generation.current; disconnect(); };
  }, [task.id, applicable]);
  if (!applicable) return null;
  const recheck = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await api.recheckIntegration(task.id);
      if (current !== generation.current) return;
      setStatus(result);
      if (result.synchronized) synchronized.current?.();
      await refresh();
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'Failed to recheck integration');
    } finally {
      if (activeTask.current === task.id) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  return <IntegrationStatusView status={status} busy={busy} error={error} onRecheck={() => { void recheck(); }} />;
}
