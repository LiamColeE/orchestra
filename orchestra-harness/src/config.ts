import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { AgentConfig, DisplayConfig, AgentRole, RoleConfig } from './types.js';

const DEFAULTS: AgentConfig = {
  apiKey: '',
  model: 'anthropic/claude-haiku-4.5',
  name: 'My Agent',
  systemPrompt: [
    'You are a coding assistant with access to tools for reading, writing, editing, and searching files, and running shell commands.',
    '',
    'Current working directory: {cwd}',
    '',
    'Guidelines:',
    '- Use your tools proactively. Explore the codebase to find answers instead of asking the user.',
    '- Keep working until the task is fully resolved before responding.',
    '- Do not guess or make up information — use your tools to verify.',
    '- Be concise and direct.',
    '- Show file paths clearly when working with files.',
    '- Prefer grep and glob tools over shell commands for file search.',
    '- When editing code, make minimal targeted changes consistent with the existing style.',
  ].join('\n'),
  maxSteps: 20,
  maxCost: 1.0,
  sessionDir: '.sessions',
  showBanner: true,
  display: {
    toolDisplay: 'grouped',
    reasoning: false,
    inputStyle: 'block',
    loader: { text: 'Working', style: 'spinner' },
  },
  slashCommands: true,
  contextThreshold: 50,
  roles: {},
};

export function loadConfig(overrides: Partial<AgentConfig> = {}, opts?: { skipApiKey?: boolean }): AgentConfig {
  let config = { ...DEFAULTS };

  const configPath = resolve('agent.config.json');
  if (existsSync(configPath)) {
    const file = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (file.display) {
      config.display = { ...config.display, ...file.display };
    }
    if (file.roles) {
      config.roles = { ...config.roles, ...file.roles };
    }
    config = { ...config, ...file, display: config.display, roles: config.roles };
  }

  if (process.env.OPENROUTER_API_KEY) config.apiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.AGENT_MODEL) config.model = process.env.AGENT_MODEL;
  if (process.env.AGENT_MAX_STEPS) config.maxSteps = Number(process.env.AGENT_MAX_STEPS);
  if (process.env.AGENT_MAX_COST) config.maxCost = Number(process.env.AGENT_MAX_COST);
  if (process.env.AGENT_CONTEXT_THRESHOLD) config.contextThreshold = Number(process.env.AGENT_CONTEXT_THRESHOLD);

  const storedKeyPath = resolve(`${process.env.HOME ?? process.env.USERPROFILE}/.config/orchestra/key.txt`);
  if (!config.apiKey && existsSync(storedKeyPath)) {
    config.apiKey = readFileSync(storedKeyPath, 'utf-8').trim();
  }

  if (overrides.display) {
    config.display = { ...config.display, ...overrides.display };
  }
  if (overrides.roles) {
    config.roles = { ...config.roles, ...overrides.roles };
  }
  config = { ...config, ...overrides, display: config.display, roles: config.roles };
  return config;
}

export type { AgentConfig, DisplayConfig, RoleConfig };
export type LoaderConfig = DisplayConfig['loader'];
