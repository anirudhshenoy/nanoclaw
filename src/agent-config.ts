import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

// --- Token usage tracking ---

const USAGE_PATH = path.join(DATA_DIR, 'token-usage.json');

export interface DayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  sessions: number;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
}

function readUsageFile(): Record<string, DayUsage> {
  try {
    if (fs.existsSync(USAGE_PATH)) {
      return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function writeUsageFile(data: Record<string, DayUsage>): void {
  fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true });
  fs.writeFileSync(USAGE_PATH, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Called by container-runner after each container run.
 * Reads the session-usage.json written by the agent runner and accumulates into daily totals.
 */
export function recordContainerUsage(groupIpcDir: string): void {
  const usageFile = path.join(groupIpcDir, 'session-usage.json');
  if (!fs.existsSync(usageFile)) return;

  let usage: SessionUsage;
  try {
    usage = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
    fs.unlinkSync(usageFile);
  } catch {
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const all = readUsageFile();
  const day = all[today] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    sessions: 0,
  };

  all[today] = {
    inputTokens: day.inputTokens + (usage.inputTokens || 0),
    outputTokens: day.outputTokens + (usage.outputTokens || 0),
    cacheReadTokens: day.cacheReadTokens + (usage.cacheReadTokens || 0),
    cacheCreationTokens:
      day.cacheCreationTokens + (usage.cacheCreationTokens || 0),
    costUSD: day.costUSD + (usage.costUSD || 0),
    sessions: day.sessions + 1,
  };

  writeUsageFile(all);
}

export function handleUsageCommand(): string {
  const all = readUsageFile();
  const dates = Object.keys(all).sort().reverse().slice(0, 7);

  if (dates.length === 0) {
    return 'No token usage recorded yet.';
  }

  const fmt = (n: number) => n.toLocaleString('en-US');
  const lines: string[] = ['Token usage (last 7 days):'];

  for (const date of dates) {
    const d = all[date];
    lines.push(
      `\n${date}`,
      `  Input:         ${fmt(d.inputTokens)}`,
      `  Output:        ${fmt(d.outputTokens)}`,
      `  Cache read:    ${fmt(d.cacheReadTokens)}`,
      `  Cache create:  ${fmt(d.cacheCreationTokens)}`,
      `  Cost:          $${d.costUSD.toFixed(4)}`,
      `  Sessions:      ${d.sessions}`,
    );
  }

  return lines.join('\n');
}

const CONFIG_PATH = path.join(DATA_DIR, 'agent-config.json');

export interface AgentConfig {
  model?: string;
  maxThinkingTokens?: number;
}

const KNOWN_MODELS: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
};

const MODEL_LIST = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

export function readAgentConfig(): AgentConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function saveAgentConfig(config: AgentConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function handleModelCommand(text: string): string {
  const config = readAgentConfig();
  const args = text.slice('/model'.length).trim();

  if (!args) {
    const current = config.model ?? '(default — claude-sonnet-4-6)';
    return `Current model: ${current}`;
  }

  if (args === 'list') {
    const currentModel = config.model ?? 'claude-sonnet-4-6';
    return MODEL_LIST.map(
      (id) => `${id === currentModel ? '→' : ' '} ${id}`,
    ).join('\n');
  }

  const modelId = KNOWN_MODELS[args];
  if (!modelId) {
    return `Unknown model: ${args}\nTry: opus, sonnet, haiku\nOr a full model ID. List with: /model list`;
  }

  saveAgentConfig({ ...config, model: modelId });
  return `Model set to: ${modelId}\n(takes effect on next agent session)`;
}

export function handleThinkingCommand(text: string): string {
  const config = readAgentConfig();
  const args = text.slice('/thinking'.length).trim();
  const parts = args.split(/\s+/);

  if (!args) {
    const enabled = !!config.maxThinkingTokens;
    return `Thinking: ${enabled ? `enabled (budget: ${config.maxThinkingTokens} tokens)` : 'disabled'}`;
  }

  if (parts[0] === 'off') {
    const { maxThinkingTokens: _removed, ...rest } = config;
    saveAgentConfig(rest);
    return 'Thinking disabled\n(takes effect on next agent session)';
  }

  if (parts[0] === 'on' || parts[0] === 'budget') {
    const budget = parseInt(parts[1] ?? '', 10) || 10000;
    saveAgentConfig({ ...config, maxThinkingTokens: budget });
    return `Thinking enabled (budget: ${budget} tokens)\n(takes effect on next agent session)`;
  }

  return 'Usage: /thinking [on [budget_tokens] | off | budget <tokens>]';
}
