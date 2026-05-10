export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export type AgentRole = 'orchestrator' | 'planner' | 'researcher' | 'builder' | 'reviewer' | 'janitor';

export interface AgentIdentity {
  role: AgentRole;
  id: string;
  description: string;
}

export interface AgentMessage {
  from: AgentRole;
  to: AgentRole;
  type: 'task' | 'result' | 'review' | 'question' | 'research' | 'plan' | 'prune';
  payload: unknown;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface PlanTask {
  id: string;
  description: string;
  agentRole: AgentRole;
  dependencies: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  filesToModify?: string[];
  context?: string;
}

export interface TechnicalPlan {
  id: string;
  originalPrompt: string;
  tasks: PlanTask[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  notes?: string;
}

export interface BuildResult {
  taskId: string;
  success: boolean;
  filesModified: string[];
  summary: string;
  details: string;
  errors?: string[];
}

export interface ReviewResult {
  taskId: string;
  approved: boolean;
  feedback: string;
  changeRequests?: string[];
  notes?: string;
}

export interface ResearchResult {
  query: string;
  findings: string;
  sources?: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  percentageUsed: number;
  sessionMessages: ChatMessage[];
}

export interface PruneRequest {
  currentContext: ChatMessage[];
  usage: ContextUsage;
}

export interface PruneResult {
  prunedContext: ChatMessage[];
  summary: string;
  tokensSaved: number;
}

export interface AgentSystemPrompts {
  orchestrator: string;
  planner: string;
  researcher: string;
  builder: string;
  reviewer: string;
  janitor: string;
}

export interface HarnessState {
  currentPlan: TechnicalPlan | null;
  activeBuilders: Map<string, { task: PlanTask; startTime: Date }>;
  completedTasks: Map<string, PlanTask>;
  pendingReviews: Map<string, { task: PlanTask; result: BuildResult }>;
  messages: AgentMessage[];
  contextUsage: ContextUsage;
  janitorPending: boolean;
  isRunning: boolean;
}

export interface UserMessage {
  role: 'user' | 'system';
  content: string;
  timestamp: string;
}

export interface ToolPermission {
  toolName: string;
  allowed: boolean;
  requiresApproval: boolean;
}

export interface RoleConfig {
  model?: string;
  maxSteps?: number;
  maxCost?: number;
  systemPrompt?: string;
  toolPermissions?: ToolPermission[];
}

export interface DisplayConfig {
  toolDisplay: 'emoji' | 'grouped' | 'minimal' | 'hidden';
  reasoning: boolean;
  inputStyle: 'block' | 'bordered' | 'plain';
  loader: { text: string; style: 'gradient' | 'spinner' | 'minimal' };
}

export interface AgentConfig {
  apiKey: string;
  model: string;
  name: string;
  systemPrompt: string;
  maxSteps: number;
  maxCost: number;
  sessionDir: string;
  showBanner: boolean;
  display: DisplayConfig;
  slashCommands: boolean;
  contextThreshold: number;
  roles: Partial<Record<AgentRole, RoleConfig>>;
}

export interface HarnessConfig extends AgentConfig {
  roles: Partial<Record<AgentRole, RoleConfig>>;
  contextThreshold: number;
}
