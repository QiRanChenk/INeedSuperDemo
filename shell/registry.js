import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { PROJECTS_DIR, TEMPLATES_DIR, SDK_DIR } from './config.js';
import { checkpointAll } from './sqlite.js';

export const PROJECT_TYPES = {
  web: { label: 'B/S Web 应用', template: 'web-basic', hasUi: true },
  headless: { label: '无界面服务', template: 'headless-basic', hasUi: false },
  desktop: { label: 'C/S 桌面应用 (规划中)', template: null, hasUi: true },
};

// Starting skeletons for web projects (chosen in the plan step). fit: when to pick it — shown to the planner model.
export const SKELETONS = {
  admin: { label: '管理后台', template: 'admin-crud', fit: '登记、管理、查询一类业务数据，如客户、库存、设备、合同、工单' },
  form: { label: '表单收集与审批', template: 'form-approval', fit: '对外收集信息再由内部审核处理，如报名、预约、申请、报修、反馈' },
  dashboard: { label: '数据看板', template: 'dashboard', fit: '以指标、图表、趋势展示为主，如销售看板、运营日报、经营分析' },
  insight: { label: '数据洞察', template: 'web-basic', fit: '上传或选择一份表格数据，由 AI 分析给出结论和建议' },
  blank: { label: '空白页面', template: 'web-blank', fit: '以上都不贴切，如工具类、展示类、计算器、AI 助手' },
};
export const skeletonAvailable = k => !!SKELETONS[k] && fs.existsSync(path.join(TEMPLATES_DIR, SKELETONS[k].template, 'server.js'));

const BASE_PORT = 4100;

export function projectDir(id) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error('invalid project id');
  return path.join(PROJECTS_DIR, id);
}

export function readProject(id) {
  const file = path.join(projectDir(id), 'project.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeProject(p) {
  fs.writeFileSync(path.join(projectDir(p.id), 'project.json'), JSON.stringify(p, null, 2));
  return p;
}

export function listProjects() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => readProject(d.name))
    .filter(Boolean)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function slugify(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s.length >= 2 ? s : 'p' + Date.now().toString(36).slice(-5);
}

/** First port >= BASE_PORT not assigned to a project and not taken by another process on this machine. */
async function nextPort() {
  const used = new Set(listProjects().map(p => p.port));
  for (let port = BASE_PORT; port < BASE_PORT + 1000; port++) if (!used.has(port) && await portFree(port)) return port;
  throw new Error('no free port');
}
export function portFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export async function createProject({ name, description = '', type = 'web', skeleton, plan }) {
  if (!description || !description.trim()) throw new Error('请填写「你想做什么」');
  if (!name || !name.trim()) throw new Error('name required (generate it first)');
  const def = PROJECT_TYPES[type];
  if (!def) throw new Error('unknown project type: ' + type);
  if (!def.template) throw new Error(`${def.label} 尚未实现`);

  const sk = type === 'web' && skeleton && skeletonAvailable(skeleton) ? skeleton : null;
  const template = sk ? SKELETONS[sk].template : def.template;
  const port = await nextPort();
  let id = slugify(name);
  if (fs.existsSync(path.join(PROJECTS_DIR, id))) id += '-' + Math.random().toString(36).slice(2, 6);
  const dir = projectDir(id);

  fs.cpSync(path.join(TEMPLATES_DIR, template), dir, { recursive: true });
  fs.cpSync(SDK_DIR, path.join(dir, 'sdk'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.superdemo'), { recursive: true });

  const project = {
    id,
    name: name.trim(),
    description: description.trim(),
    type,
    template,
    ...(sk ? { skeleton: sk } : {}),
    ...(plan ? { plan } : {}),
    entry: 'server.js',
    port,
    autoStart: true,
    createdAt: new Date().toISOString(),
  };
  return writeProject(project);
}

/** Copy a project as a new variant: code + data, but a fresh history (no sessions, versions, feedback, logs). */
export async function duplicateProject(srcId, name) {
  const src = readProject(srcId);
  if (!src) throw new Error('project not found');
  const newName = String(name || '').trim() || `${src.name} 副本`;
  const port = await nextPort();
  let id = slugify(newName);
  if (id === srcId || fs.existsSync(path.join(PROJECTS_DIR, id))) id = `${srcId.slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`;
  const from = projectDir(srcId), dir = projectDir(id);
  checkpointAll(from);
  fs.cpSync(from, dir, { recursive: true, filter: f => {
    const rel = path.relative(from, f);
    return !(rel === '.superdemo' || rel.startsWith('.superdemo' + path.sep) || rel.split(path.sep).includes('node_modules') || /\.(db-wal|db-shm)$/.test(f));
  } });
  fs.mkdirSync(path.join(dir, '.superdemo'), { recursive: true });
  const { demoReset, demoLastResetAt, ...rest } = src;
  return writeProject({ ...rest, id, name: newName, port, autoStart: true, createdAt: new Date().toISOString(), forkedFrom: srcId });
}

/** sdk/ is shell-owned: refresh the copy inside a project so existing projects pick up new SDK features. */
export function syncSdk(id) {
  const dir = projectDir(id);
  if (!fs.existsSync(dir)) return;
  fs.cpSync(SDK_DIR, path.join(dir, 'sdk'), { recursive: true });
}

export function deleteProject(id) {
  const dir = projectDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Resolve a relative path inside a project, refusing escapes. */
export function safePath(id, rel = '.') {
  const dir = projectDir(id);
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error('path escapes project: ' + rel);
  return abs;
}

const IGNORE = new Set(['node_modules', '.git', '.superdemo', '.DS_Store']);

export function fileTree(id, rel = '.', depth = 4) {
  const abs = safePath(id, rel);
  const out = [];
  (function walk(dir, prefix, d) {
    if (d > depth) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORE.has(ent.name)) continue;
      const p = prefix ? prefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { out.push(p + '/'); walk(path.join(dir, ent.name), p, d + 1); }
      else out.push(p);
    }
  })(abs, '', 0);
  return out;
}
