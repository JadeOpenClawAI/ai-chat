'use client';

import { useState } from 'react';
import type { SubAgentRunProgress, SubAgentTaskProgress } from '@/hooks/useChat';
import { cn } from '@/lib/utils';
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

interface SubAgentPanelProps {
  runs: SubAgentRunProgress[];
}

export function SubAgentPanel({ runs }: SubAgentPanelProps) {
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  if (runs.length === 0) {
    return null;
  }

  return (
    <div className="mx-4 mt-2 rounded-lg border border-indigo-200 bg-indigo-50/70 p-2 dark:border-indigo-900 dark:bg-indigo-950/40">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-indigo-700 dark:text-indigo-300">
        <Bot className="h-3.5 w-3.5" />
        Sub-agents
      </div>

      <div className="space-y-2">
        {runs.slice(0, 4).map((run) => {
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
                          className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                        >
                          <AgentStateIcon state={agent.state} />
                          <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                            {agent.label}
                          </span>
                          <span className="ml-1 truncate text-[11px] text-gray-500 dark:text-gray-400">
                            {agent.task}
                          </span>
                          {hasDetails && (
                            <span className="ml-auto text-gray-400">
                              {expandedAgent ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </span>
                          )}
                        </button>
                        {hasDetails && expandedAgent && (
                          <div className="space-y-1 border-t border-gray-200 px-2 py-1.5 text-[11px] dark:border-gray-800">
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
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentStateIcon({ state }: { state: SubAgentTaskProgress['state'] }) {
  if (state === 'queued' || state === 'running') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />;
  }
  if (state === 'done') {
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  }
  return <AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
}
