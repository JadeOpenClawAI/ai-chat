'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubAgentRunProgress, SubAgentTaskProgress } from '@/hooks/useChat';
import { cn } from '@/lib/utils';
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';

interface SubAgentPanelProps {
  runs: SubAgentRunProgress[];
  syncDismissState?: boolean;
}

const AUTO_CLOSE_PER_TASK_MS = 30_000;
const CLOSE_ANIMATION_MS = 260;
const PANEL_DISMISSED_STORAGE_KEY = 'ai-chat:sub-agent-panel:dismissed';

function parseDismissedState(raw: string | null): boolean | null {
  if (raw === '1') {
    return true;
  }
  if (raw === '0') {
    return false;
  }
  return null;
}

export function SubAgentPanel({ runs, syncDismissState = true }: SubAgentPanelProps) {
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [dismissed, setDismissed] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [idleSince, setIdleSince] = useState<number>(() => Date.now());
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<'empty' | 'active' | 'finished'>('empty');

  const hasActiveRuns = useMemo(() => (
    runs.some((run) =>
      run.completedAgents < run.totalAgents
      || run.agents.some((agent) => agent.state === 'queued' || agent.state === 'running'))
  ), [runs]);
  const totalSubAgentTaskCount = useMemo(
    () =>
      Math.max(
        1,
        runs.reduce((sum, run) => (
          sum + Math.max(1, run.totalAgents || run.agents.length || 1)
        ), 0),
      ),
    [runs],
  );

  const autoCloseDelayMs = useMemo(() => {
    return totalSubAgentTaskCount * AUTO_CLOSE_PER_TASK_MS;
  }, [totalSubAgentTaskCount]);
  const displayRuns = useMemo(
    () => [...runs].sort((a, b) => a.updatedAt - b.updatedAt),
    [runs],
  );
  const runById = useMemo(() => {
    const map = new Map<string, SubAgentRunProgress>();
    for (const run of displayRuns) {
      map.set(run.runId, run);
    }
    return map;
  }, [displayRuns]);
  const childRunsByParentAgentKey = useMemo(() => {
    const map = new Map<string, SubAgentRunProgress[]>();
    for (const run of displayRuns) {
      if (!run.parentRunId || !run.parentAgentId) {
        continue;
      }
      const key = `${run.parentRunId}:${run.parentAgentId}`;
      const existing = map.get(key);
      if (existing) {
        existing.push(run);
      } else {
        map.set(key, [run]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.updatedAt - b.updatedAt);
    }
    return map;
  }, [displayRuns]);
  const rootRuns = useMemo(() => (
    displayRuns.filter((run) => {
      if (!run.parentRunId || !run.parentAgentId) {
        return true;
      }
      return !runById.has(run.parentRunId);
    })
  ), [displayRuns, runById]);

  const nextTimestamp = useCallback((previous: number) => {
    const now = Date.now();
    return now > previous ? now : previous + 1;
  }, []);

  const markInteraction = useCallback(() => {
    if (hasActiveRuns || isClosing) {
      return;
    }
    setIdleSince((previous) => nextTimestamp(previous));
  }, [hasActiveRuns, isClosing, nextTimestamp]);

  const setDismissedSynced = useCallback((next: boolean) => {
    setDismissed(next);
    if (!syncDismissState || typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(PANEL_DISMISSED_STORAGE_KEY, next ? '1' : '0');
  }, [syncDismissState]);

  const requestDismiss = useCallback(() => {
    if (dismissed || isClosing) {
      return;
    }
    setIsClosing(true);
    closeTimerRef.current = setTimeout(() => {
      setDismissedSynced(true);
      setIsClosing(false);
      closeTimerRef.current = null;
    }, CLOSE_ANIMATION_MS);
  }, [dismissed, isClosing, setDismissedSynced]);

  useEffect(() => {
    if (typeof window === 'undefined' || !syncDismissState) {
      return;
    }

    const applyIncomingDismissed = (nextDismissed: boolean) => {
      setDismissed(nextDismissed);
      if (!nextDismissed) {
        setIsClosing(false);
      }
    };

    const stored = parseDismissedState(window.localStorage.getItem(PANEL_DISMISSED_STORAGE_KEY));
    if (stored !== null) {
      applyIncomingDismissed(stored);
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== PANEL_DISMISSED_STORAGE_KEY) {
        return;
      }
      const incoming = parseDismissedState(event.newValue);
      if (incoming === null) {
        return;
      }
      applyIncomingDismissed(incoming);
    };

    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [syncDismissState]);

  useEffect(() => {
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }

    if (runs.length === 0) {
      if (phaseRef.current !== 'empty') {
        setDismissedSynced(false);
        setIsClosing(false);
        setIdleSince((previous) => nextTimestamp(previous));
      }
      phaseRef.current = 'empty';
      return;
    }

    if (hasActiveRuns) {
      if (phaseRef.current !== 'active') {
        setDismissedSynced(false);
        setIsClosing(false);
        setIdleSince((previous) => nextTimestamp(previous));
      }
      phaseRef.current = 'active';
      return;
    }

    if (phaseRef.current !== 'finished') {
      // Transitioned from active -> finished; start idle countdown anchor now.
      setIdleSince((previous) => nextTimestamp(previous));
      phaseRef.current = 'finished';
      return;
    }

    const elapsedMs = Date.now() - idleSince;
    const remainingMs = Math.max(0, autoCloseDelayMs - elapsedMs);
    autoCloseTimerRef.current = setTimeout(() => {
      requestDismiss();
      autoCloseTimerRef.current = null;
    }, remainingMs);

    return () => {
      if (autoCloseTimerRef.current) {
        clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
    };
  }, [autoCloseDelayMs, hasActiveRuns, idleSince, nextTimestamp, requestDismiss, runs.length, setDismissedSynced]);

  useEffect(() => () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  if (runs.length === 0 || dismissed) {
    return null;
  }

  const drainAnimationKey = `${idleSince}-${autoCloseDelayMs}`;
  const renderRunTree = (
    run: SubAgentRunProgress,
    visited: Set<string>,
  ) => {
    if (visited.has(run.runId)) {
      return null;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(run.runId);

    const isComplete = run.completedAgents >= run.totalAgents;
    const expanded = expandedRuns[run.runId] ?? !isComplete;
    const completionRatio = run.totalAgents > 0 ? run.completedAgents / run.totalAgents : 0;

    return (
      <div
        key={run.runId}
        className="rounded border border-indigo-200/80 bg-white/90 dark:border-indigo-900/70 dark:bg-indigo-950/50"
      >
        <button
          type="button"
          onClick={() => setExpandedRuns((prev) => ({ ...prev, [run.runId]: !expanded }))}
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-indigo-500" />
            : <ChevronRight className="h-3.5 w-3.5 text-indigo-500" />}
          <span className="text-xs font-medium text-gray-800 dark:text-gray-100">
            {run.objective}
          </span>
          <span className="ml-auto text-[11px] text-gray-500 dark:text-gray-400">
            {run.completedAgents}/{run.totalAgents}
          </span>
        </button>

        <div className="px-2.5 pb-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-indigo-100 dark:bg-indigo-950">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                isComplete ? 'bg-green-500' : 'bg-indigo-500',
              )}
              style={{ width: `${Math.max(6, Math.min(100, completionRatio * 100))}%` }}
            />
          </div>
        </div>

        {expanded && (
          <div className="space-y-1.5 border-t border-indigo-100 px-2.5 py-2 dark:border-indigo-900">
            {run.agents.map((agent) => {
              const key = `${run.runId}:${agent.agentId}`;
              const hasDetails = Boolean(agent.progress || agent.result || agent.error);
              const expandedAgent = expandedAgents[key] ?? (agent.state === 'running' || agent.state === 'error');
              const childRuns = childRunsByParentAgentKey.get(key) ?? [];
              return (
                <div
                  key={agent.agentId}
                  className="rounded border border-gray-200/80 bg-gray-50/80 dark:border-gray-800 dark:bg-gray-900/60"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!hasDetails) {
                        return;
                      }
                      setExpandedAgents((prev) => ({ ...prev, [key]: !expandedAgent }));
                    }}
                    className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left"
                  >
                    <AgentStateIcon state={agent.state} />
                    <span
                      className="shrink-0 text-xs font-medium text-gray-700 dark:text-gray-200"
                      title={agent.label}
                    >
                      {agent.label}
                    </span>
                    {hasDetails && (
                      <span className="ml-auto shrink-0 text-gray-400">
                        {expandedAgent ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </span>
                    )}
                  </button>
                  {hasDetails && expandedAgent && (
                    <div className="space-y-1 border-t border-gray-200 px-2 py-1.5 text-[11px] dark:border-gray-800">
                      <div className="space-y-1">
                        <p className="font-medium text-gray-700 dark:text-gray-200">Task</p>
                        <pre
                          className={cn(
                            'max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-1.5 text-[11px] text-gray-700',
                            'dark:bg-white/5 dark:text-gray-200',
                          )}
                        >
                          {agent.task}
                        </pre>
                      </div>
                      {agent.progress && (
                        <p className="text-gray-600 dark:text-gray-300">{agent.progress}</p>
                      )}
                      {agent.error && (
                        <p className="text-red-600 dark:text-red-400">{agent.error}</p>
                      )}
                      {agent.result && (
                        <pre
                          className={cn(
                            'max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-1.5 text-[11px] text-gray-700',
                            'dark:bg-white/5 dark:text-gray-200',
                          )}
                        >
                          {agent.result}
                        </pre>
                      )}
                    </div>
                  )}

                  {childRuns.length > 0 && (
                    <div className="ml-3 mr-2 mt-1.5 space-y-2 border-l border-indigo-200 pb-2 pl-2 dark:border-indigo-900">
                      {childRuns.map((childRun) => renderRunTree(childRun, nextVisited))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={cn(
        'relative mx-4 mt-2 overflow-hidden rounded-lg border border-indigo-200 bg-indigo-50/70 p-2',
        'transform transition-all duration-300 ease-out',
        isClosing && '-translate-y-3 opacity-0',
        'dark:border-indigo-900 dark:bg-indigo-950/40',
      )}
      onPointerDownCapture={markInteraction}
      onKeyDownCapture={markInteraction}
    >
      <div>
        <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-indigo-700 dark:text-indigo-300">
          <span className="flex items-center gap-2">
            <Bot className="h-3.5 w-3.5" />
            Sub-agents
          </span>
          {!hasActiveRuns && (
            <button
              type="button"
              onClick={requestDismiss}
              title="Close sub-agent panel"
              className={cn(
                'rounded p-1 text-indigo-500 hover:bg-indigo-100 hover:text-indigo-700',
                'dark:hover:bg-indigo-900/70 dark:hover:text-indigo-200',
              )}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div
          className="max-h-[45vh] overflow-y-auto pr-1"
          onScrollCapture={markInteraction}
          onWheelCapture={markInteraction}
          onTouchMoveCapture={markInteraction}
        >
          <div className="space-y-2">
            {rootRuns.slice(-8).map((run) => renderRunTree(run, new Set<string>()))}
          </div>
        </div>
      </div>

      {!hasActiveRuns && (
        <div
          key={drainAnimationKey}
          className="mt-2 h-0.5 w-full origin-right animate-toast-drain bg-indigo-500/70 dark:bg-indigo-300/70"
          style={{ animationDuration: `${autoCloseDelayMs}ms` }}
        />
      )}
    </div>
  );
}

function AgentStateIcon({ state }: { state: SubAgentTaskProgress['state'] }) {
  if (state === 'queued' || state === 'running') {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500" />;
  }
  if (state === 'done') {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />;
  }
  return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />;
}
