import { randomUUID } from 'crypto';
import type { AgentConfig } from './config.js';
import { runAgentWithRetry, type AgentEvent } from './agents/agent-runner.js';
import { getSystemPrompt, buildMessages } from './agents/prompts.js';
import type {
  AgentRole,
  AgentMessage,
  TechnicalPlan,
  PlanTask,
  BuildResult,
  ReviewResult,
  ResearchResult,
  ContextUsage,
  HarnessState,
  HarnessConfig,
} from './types.js';

type EventHandler = (event: { role: AgentRole; type: string; content: string }) => void;
type QuestionHandler = (questions: string[]) => Promise<string[]>;

export class MultiAgentHarness {
  private config: AgentConfig;
  private harnessConfig: HarnessConfig;
  private state: HarnessState;
  private handlers: {
    onEvent?: EventHandler;
    onQuestion?: QuestionHandler;
    onContextWarning?: (usage: ContextUsage) => Promise<boolean>;
  } = {};
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
  onQuestion(handler: QuestionHandler) { this.handlers.onQuestion = handler; }
  onContextWarning(handler: (usage: ContextUsage) => Promise<boolean>) { this.handlers.onContextWarning = handler; }

  private emit(role: AgentRole, type: string, content: string) {
    this.handlers.onEvent?.({ role, type, content });
  }

  private async runAgent(role: AgentRole, task: string, context?: string, allowedTools?: string[]): Promise<string> {
    const systemPrompt = this.harnessConfig.roles?.[role]?.systemPrompt ?? getSystemPrompt(role, process.cwd());
    const input = buildMessages(role, task, context);

    const result = await runAgentWithRetry(
      {
        ...this.config,
        model: this.harnessConfig.roles?.[role]?.model ?? this.config.model,
        maxSteps: this.harnessConfig.roles?.[role]?.maxSteps ?? this.config.maxSteps,
        maxCost: this.harnessConfig.roles?.[role]?.maxCost ?? this.config.maxCost,
      },
      input,
      {
        systemPrompt,
        allowedTools,
        maxSteps: this.harnessConfig.roles?.[role]?.maxSteps ?? this.config.maxSteps,
        maxCost: this.harnessConfig.roles?.[role]?.maxCost ?? this.config.maxCost,
        onEvent: (e: AgentEvent) => {
          if (e.type === 'text') this.emit(role, 'text', e.delta);
          else if (e.type === 'tool_call') this.emit(role, 'tool_call', `${e.name}: ${JSON.stringify(e.args)}`);
          else if (e.type === 'tool_result') this.emit(role, 'tool_result', `${e.name}: ${e.output}`);
        },
        signal: this.abortController?.signal,
      },
    );

    const inT = result.usage?.inputTokens ?? 0;
    const outT = result.usage?.outputTokens ?? 0;
    this.state.contextUsage.inputTokens += inT;
    this.state.contextUsage.outputTokens += outT;
    this.state.contextUsage.totalTokens += inT + outT;
    this.state.contextUsage.percentageUsed = Math.min(100, (this.state.contextUsage.totalTokens / 128000) * 100);

    if (this.state.contextUsage.percentageUsed > this.harnessConfig.contextThreshold && !this.state.janitorPending) {
      this.handleContextWarning();
    }

    this.logMessage({ from: role, to: 'orchestrator', type: 'result', payload: result.text, timestamp: new Date().toISOString() });
    return result.text;
  }

  private async handleContextWarning() {
    if (this.state.janitorPending) return;
    this.state.janitorPending = true;

    const shouldPrune = await this.handlers.onContextWarning?.(this.state.contextUsage);
    if (shouldPrune) {
      await this.runJanitor();
    }
    this.state.janitorPending = false;
  }

  private async runJanitor(): Promise<void> {
    this.emit('janitor', 'start', 'Pruning context...');

    const context = [
      'Current context usage: ' + this.state.contextUsage.percentageUsed.toFixed(1) + '%',
      'Total tokens: ' + this.state.contextUsage.totalTokens,
      'Please prune the following messages to reduce context usage while keeping critical information.',
      JSON.stringify(this.state.contextUsage.sessionMessages.slice(-20)),
    ].join('\n');

    await this.runAgent('janitor', context, undefined, ['file_read', 'file_write', 'file_edit', 'grep', 'glob', 'list_dir']);

    this.emit('janitor', 'complete', 'Context pruned. Saved ~' + Math.floor(this.state.contextUsage.totalTokens * 0.3) + ' tokens.');
    this.state.contextUsage.totalTokens = Math.floor(this.state.contextUsage.totalTokens * 0.7);
    this.state.contextUsage.percentageUsed = Math.min(100, (this.state.contextUsage.totalTokens / 128000) * 100);
  }

  private logMessage(msg: AgentMessage) {
    this.state.messages.push(msg);
  }

  async processUserPrompt(prompt: string): Promise<string> {
    this.abortController = new AbortController();
    this.state.isRunning = true;
    this.state.contextUsage.sessionMessages.push({ role: 'user', content: prompt });

    try {
      this.emit('orchestrator', 'phase', 'Planning...');
      const planText = await this.runAgent('planner', prompt, undefined, [
        'file_read', 'file_write', 'file_edit', 'grep', 'glob', 'list_dir', 'shell',
      ]);
      const plan = this.parsePlan(planText, prompt);
      this.state.currentPlan = plan;
      this.emit('orchestrator', 'plan', `Plan created with ${plan.tasks.length} tasks`);

      const completedTaskIds = new Set<string>();
      const taskMap = new Map(plan.tasks.map((t) => [t.id, t]));

      while (completedTaskIds.size < plan.tasks.length) {
        const readyTasks = plan.tasks.filter(
          (t) => !completedTaskIds.has(t.id) && t.dependencies.every((dep) => completedTaskIds.has(dep)),
        );

        if (readyTasks.length === 0 && completedTaskIds.size < plan.tasks.length) {
          throw new Error('Deadlock detected in task dependencies');
        }

        const taskPromises = readyTasks.map(async (task) => {
          this.emit('orchestrator', 'task_start', `${task.agentRole} :: ${task.description}`);

          let context = '';
          for (const depId of task.dependencies) {
            const dep = taskMap.get(depId);
            if (dep?.result) context += `Dependency ${depId} result:\n${dep.result}\n\n`;
          }

          let resultText: string;
          if (task.agentRole === 'researcher') {
            resultText = await this.runAgent('researcher', task.description, context, [
              'file_read', 'grep', 'glob', 'list_dir', 'shell',
            ]);
            const researchResult: ResearchResult = {
              query: task.description,
              findings: resultText,
              confidence: 'medium',
            };
            task.result = JSON.stringify(researchResult);
          } else if (task.agentRole === 'builder') {
            const researchContext = plan.tasks
              .filter((t) => t.agentRole === 'researcher' && completedTaskIds.has(t.id))
              .map((t) => `Research: ${t.result}`)
              .join('\n\n');

            const builderContext = [context, researchContext, task.context].filter(Boolean).join('\n\n');
            resultText = await this.runAgent('builder', task.description, builderContext, [
              'file_read', 'file_write', 'file_edit', 'grep', 'glob', 'list_dir', 'shell',
            ]);

            task.result = resultText;

            this.emit('orchestrator', 'review', `Reviewing task ${task.id}`);
            const reviewText = await this.runAgent('reviewer', resultText, builderContext + '\n\nTask: ' + task.description, [
              'file_read', 'grep', 'glob', 'list_dir',
            ]);
            const review = this.parseReview(reviewText, task.id);

            if (!review.approved && review.changeRequests?.length) {
              this.emit('orchestrator', 'rework', `Re-working task ${task.id}`);
              const feedback = review.changeRequests.join('\n');
              resultText = await this.runAgent('builder', task.description + '\n\nFEEDBACK FROM REVIEWER (address these):\n' + feedback, builderContext, [
                'file_read', 'file_write', 'file_edit', 'grep', 'glob', 'list_dir', 'shell',
              ]);
              task.result = resultText;
              const review2 = await this.runAgent('reviewer', resultText, builderContext + '\n\nTask: ' + task.description + '\n\nThis is a re-review after changes.', [
                'file_read', 'grep', 'glob', 'list_dir',
              ]);
              const parsed2 = this.parseReview(review2, task.id);
              task.result += '\n\nReview status: ' + (parsed2.approved ? 'APPROVED' : 'NEEDS MANUAL REVIEW');
            } else {
              task.result += '\n\nReview status: APPROVED';
            }
          } else {
            resultText = await this.runAgent(task.agentRole, task.description, context);
            task.result = resultText;
          }

          completedTaskIds.add(task.id);
          this.emit('orchestrator', 'task_complete', `${task.id} done`);
        });

        await Promise.all(taskPromises);
      }

      const results = plan.tasks.map((t) => ({ id: t.id, role: t.agentRole, description: t.description, result: t.result }));
      const finalContext = `Task results:\n\n${ JSON.stringify(results, null, 2) }`;
      const finalResponse = await this.runAgent('orchestrator', `Synthesize a final response for the user. Original prompt: ${prompt}`, finalContext, [
        'file_read', 'grep', 'glob', 'list_dir',
      ]);

      this.state.contextUsage.sessionMessages.push({ role: 'assistant', content: finalResponse });
      return finalResponse;
    } finally {
      this.state.isRunning = false;
    }
  }

  private parsePlan(planText: string, originalPrompt: string): TechnicalPlan {
    const plan: TechnicalPlan = {
      id: randomUUID(),
      originalPrompt,
      tasks: [],
      estimatedComplexity: 'medium',
    };

    const lines = planText.split('\n');
    let currentTask: Partial<PlanTask> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const taskMatch = trimmed.match(/^Task\s+(\S+):\s*(.+)/i) || trimmed.match(/^-?\s*(\w+)\s*:\s*(.+)/i);
      if (taskMatch) {
        if (currentTask && currentTask.id) {
          plan.tasks.push(currentTask as PlanTask);
        }
        currentTask = {
          id: taskMatch[1],
          description: taskMatch[2],
          dependencies: [],
          status: 'pending',
          agentRole: 'builder',
        };
      } else if (currentTask) {
        if (trimmed.toLowerCase().includes('depends on:') || trimmed.toLowerCase().includes('dependencies:')) {
          const deps = trimmed.split(':')[1];
          if (deps) currentTask.dependencies = deps.split(',').map((d) => d.trim()).filter(Boolean);
        } else if (trimmed.toLowerCase().includes('role:') || trimmed.toLowerCase().includes('agent:')) {
          const role = trimmed.split(':')[1]?.trim().toLowerCase();
          if (role === 'researcher' || role === 'builder') currentTask.agentRole = role as any;
        } else if (trimmed.toLowerCase().includes('files:') || trimmed.toLowerCase().includes('modify:')) {
          const files = trimmed.split(':')[1];
          if (files) currentTask.filesToModify = files.split(',').map((f) => f.trim()).filter(Boolean);
        } else if (trimmed.toLowerCase().includes('complexity:')) {
          const comp = trimmed.split(':')[1]?.trim().toLowerCase();
          if (comp === 'low' || comp === 'medium' || comp === 'high') plan.estimatedComplexity = comp;
        } else {
          currentTask.description += '\n' + trimmed;
        }
      }
    }

    if (currentTask && currentTask.id) plan.tasks.push(currentTask as PlanTask);

    if (plan.tasks.length === 0) {
      plan.tasks = [{
        id: 'task-1',
        description: planText,
        agentRole: 'builder',
        dependencies: [],
        status: 'pending',
      }];
    }

    return plan;
  }

  private parseReview(reviewText: string, taskId: string): ReviewResult {
    const approved = reviewText.toLowerCase().includes('approved: true') ||
      reviewText.toLowerCase().includes('approved') && !reviewText.toLowerCase().includes('not approved');

    const changeRequests: string[] = [];
    const lines = reviewText.split('\n');
    let inChanges = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().includes('change request') || trimmed.toLowerCase().includes('changes needed')) {
        inChanges = true;
      } else if (inChanges && (trimmed.startsWith('-') || trimmed.startsWith('*'))) {
        changeRequests.push(trimmed.replace(/^[-*]\s*/, ''));
      } else if (inChanges && trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('*')) {
        inChanges = false;
      }
    }

    return {
      taskId,
      approved: approved && changeRequests.length === 0,
      feedback: reviewText,
      changeRequests: changeRequests.length > 0 ? changeRequests : undefined,
    };
  }

  getState(): HarnessState {
    return { ...this.state };
  }

  stop() {
    this.abortController?.abort();
    this.state.isRunning = false;
  }
}
