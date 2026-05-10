import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { runAgentWithRetry } from '../agents/agent-runner.js';
import { getSystemPrompt } from '../agents/prompts.js';
import type { AgentConfig } from '../config.js';
import type { AgentRole, HarnessConfig } from '../types.js';

type OnEvent = (role: AgentRole, type: string, content: string) => void;

const ROLE_TOOLS: Record<string, string[]> = {
  planner:    ['file_read', 'grep', 'glob', 'list_dir'],
  researcher: ['file_read', 'grep', 'glob', 'list_dir', 'shell'],
  builder:    ['file_read', 'file_write', 'file_edit', 'grep', 'glob', 'list_dir', 'shell'],
  reviewer:   ['file_read', 'grep', 'glob', 'list_dir'],
};

export function createSpawnAgentTool(
  config: AgentConfig,
  harnessConfig: HarnessConfig,
  onEvent: OnEvent,
  signal?: AbortSignal,
) {
  return tool({
    name: 'spawn_agent',
    description: [
      'Spawn a subagent to perform a specific task. Available roles:',
      '- planner: Reads the codebase and creates a structured plan. Returns tasks with roles, dependencies, and file context.',
      '- researcher: Searches the codebase or web for information. Returns findings.',
      '- builder: Implements code changes for a specific, focused task. Returns a summary of files modified.',
      '- reviewer: Reviews builder output for correctness, style, and completeness. Returns approved=true or change requests.',
    ].join('\n'),
    inputSchema: z.object({
      role: z.enum(['planner', 'researcher', 'builder', 'reviewer']),
      task: z.string().describe('The task or prompt to give the agent'),
      context: z.string().optional().describe('Additional context to pass to the agent (e.g. dependency results, research findings)'),
    }),
    execute: async ({ role, task, context }) => {
      const agentRole = role as AgentRole;
      const roleConfig = harnessConfig.roles?.[agentRole];
      const systemPrompt = roleConfig?.systemPrompt ?? getSystemPrompt(agentRole, process.cwd());
      const input = context ? `${task}\n\n## Context\n${context}` : task;

      onEvent(agentRole, 'start', task.slice(0, 120));

      try {
        const result = await runAgentWithRetry(
          {
            ...config,
            model: roleConfig?.model ?? config.model,
            maxSteps: roleConfig?.maxSteps ?? config.maxSteps,
            maxCost: roleConfig?.maxCost ?? config.maxCost,
          },
          input,
          {
            systemPrompt,
            allowedTools: ROLE_TOOLS[role],
            onEvent: (e) => {
              if (e.type === 'text') onEvent(agentRole, 'text', e.delta);
              else if (e.type === 'tool_call') onEvent(agentRole, 'tool_call', `${e.name}: ${JSON.stringify(e.args)}`);
              else if (e.type === 'tool_result') onEvent(agentRole, 'tool_result', `${e.name}: ${e.output}`);
            },
            signal,
          },
        );

        onEvent(agentRole, 'complete', 'Task complete.');
        return { success: true, result: result.text };
      } catch (err: any) {
        onEvent(agentRole, 'error', err.message);
        return { success: false, error: err.message };
      }
    },
  });
}
