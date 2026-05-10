import type { AgentConfig } from './config.js';
import { runAgentWithRetry, type AgentEvent } from './agents/agent-runner.js';
import { getSystemPrompt } from './agents/prompts.js';
import { createSpawnAgentTool } from './tools/spawn-agent.js';
import type {
  AgentRole,
  ContextUsage,
  HarnessState,
  HarnessConfig,
} from './types.js';

type EventHandler = (event: { role: AgentRole; type: string; content: string }) => void;

export class MultiAgentHarness {
  private config: AgentConfig;
  private harnessConfig: HarnessConfig;
  private state: HarnessState;
  private handlers: { onEvent?: EventHandler } = {};
  private abortController: AbortController | null = null;

  constructor(config: AgentConfig, harnessConfig: HarnessConfig) {
    this.config = config;
    this.harnessConfig = harnessConfig;
    this.state = {
      currentPlan: null,
      activeBuilders: new Map(),
      completedTasks: new Map(),
      pendingReviews: new Map(),
      messages: [],
      contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, percentageUsed: 0, sessionMessages: [] },
      janitorPending: false,
      isRunning: false,
    };
  }

  onEvent(handler: EventHandler) { this.handlers.onEvent = handler; }

  private emit(role: AgentRole, type: string, content: string) {
    this.handlers.onEvent?.({ role, type, content });
  }

  async processUserPrompt(prompt: string): Promise<string> {
    this.abortController = new AbortController();
    this.state.isRunning = true;
    this.state.contextUsage.sessionMessages.push({ role: 'user', content: prompt });

    try {
      const spawnAgentTool = createSpawnAgentTool(
        this.config,
        this.harnessConfig,
        (role, type, content) => this.emit(role, type, content),
        this.abortController.signal,
      );

      const orchestratorConfig = this.harnessConfig.roles?.orchestrator;
      const result = await runAgentWithRetry(
        {
          ...this.config,
          model: orchestratorConfig?.model ?? this.config.model,
          maxSteps: orchestratorConfig?.maxSteps ?? this.config.maxSteps,
          maxCost: orchestratorConfig?.maxCost ?? this.config.maxCost,
        },
        prompt,
        {
          systemPrompt: orchestratorConfig?.systemPrompt ?? getSystemPrompt('orchestrator', process.cwd()),
          allowedTools: ['file_read', 'grep', 'glob', 'list_dir'],
          additionalTools: [spawnAgentTool],
          onEvent: (e: AgentEvent) => {
            if (e.type === 'text') this.emit('orchestrator', 'text', e.delta);
            else if (e.type === 'tool_call') this.emit('orchestrator', 'tool_call', `${e.name}: ${JSON.stringify(e.args)}`);
            else if (e.type === 'tool_result') this.emit('orchestrator', 'tool_result', `${e.name}: ${e.output}`);
          },
          signal: this.abortController.signal,
        },
      );

      const inT = result.usage?.inputTokens ?? 0;
      const outT = result.usage?.outputTokens ?? 0;
      this.state.contextUsage.inputTokens += inT;
      this.state.contextUsage.outputTokens += outT;
      this.state.contextUsage.totalTokens += inT + outT;
      this.state.contextUsage.percentageUsed = Math.min(100, (this.state.contextUsage.totalTokens / 128000) * 100);

      this.state.contextUsage.sessionMessages.push({ role: 'assistant', content: result.text });
      return result.text;
    } finally {
      this.state.isRunning = false;
    }
  }

  getState(): HarnessState {
    return { ...this.state };
  }

  stop() {
    this.abortController?.abort();
    this.state.isRunning = false;
  }
}
