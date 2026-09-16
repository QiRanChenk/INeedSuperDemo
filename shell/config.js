import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECTS_DIR = path.join(ROOT, 'projects');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const SDK_DIR = path.join(ROOT, 'sdk');
export const DATA_DIR = path.join(ROOT, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' },
  { id: 'qwen-plan', label: 'Qwen Coding Plan (阿里云百炼)', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
  { id: 'qwen', label: 'Qwen 按量 (DashScope)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
  { id: 'ollama', label: 'Ollama (本地)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:14b' },
  { id: 'custom', label: '自定义 (OpenAI 兼容)', baseUrl: '', model: '' },
];

loadDotEnv();

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function readSettingsFile() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

/** Effective LLM settings: UI settings file overrides env. */
export function getSettings() {
  const s = readSettingsFile();
  return {
    baseUrl: (s.baseUrl || process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: s.apiKey || process.env.LLM_API_KEY || '',
    model: s.model || process.env.LLM_MODEL || '',
    temperature: Number.isFinite(s.temperature) ? s.temperature : 0.3,
    maxIterations: Number.isInteger(s.maxIterations) && s.maxIterations >= 1 ? s.maxIterations : 25,
  };
}

export function saveSettings(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cur = readSettingsFile();
  const next = { ...cur, ...patch };
  if (patch.apiKey === '') delete next.apiKey; // allow clearing back to env
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return getSettings();
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}
