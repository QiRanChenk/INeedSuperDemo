import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, TEMPLATES_DIR, SDK_DIR } from './config.js';

export const PROJECT_TYPES = {
  web: { label: 'B/S Web 应用', template: 'web-basic', hasUi: true },
  headless: { label: '无界面服务', template: 'headless-basic', hasUi: false },
  desktop: { label: 'C/S 桌面应用 (规划中)', template: null, hasUi: true },
};

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
  return s.length >= 2 ? s : 'proj';
}

function nextPort() {
  const used = new Set(listProjects().map(p => p.port));
  let port = BASE_PORT;
  while (used.has(port)) port++;
  return port;
}

export function createProject({ name, description = '', type = 'web' }) {
  if (!name || !name.trim()) throw new Error('name required');
  const def = PROJECT_TYPES[type];
  if (!def) throw new Error('unknown project type: ' + type);
  if (!def.template) throw new Error(`${def.label} 尚未实现`);

  let id = slugify(name);
  if (fs.existsSync(path.join(PROJECTS_DIR, id))) id += '-' + Math.random().toString(36).slice(2, 6);
  const dir = projectDir(id);

  fs.cpSync(path.join(TEMPLATES_DIR, def.template), dir, { recursive: true });
  fs.cpSync(SDK_DIR, path.join(dir, 'sdk'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.superdemo'), { recursive: true });

  const project = {
    id,
    name: name.trim(),
    description: description.trim(),
    type,
    template: def.template,
    entry: 'server.js',
    port: nextPort(),
    autoStart: true,
    createdAt: new Date().toISOString(),
  };
  return writeProject(project);
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
