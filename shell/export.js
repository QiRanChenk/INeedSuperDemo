// Export a project as a deployable unit: zip download, local Docker image build, image tarball download.
// Zero dependencies: the zip writer below is a minimal ZIP (deflate, UTF-8 names, no zip64) built on node:zlib.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFile } from 'node:child_process';
import { projectDir, readProject } from './registry.js';
import { getProjectLlm } from './config.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.superdemo']);
const SKIP_FILES = new Set(['.DS_Store', '.env']); // .env may hold a real API key: never ship it
const SKIP_SUFFIXES = ['.db-wal', '.db-shm'];      // SQLite side files; the .db itself is exported

export const imageTag = id => `superdemo-${id}:latest`;

/** Write .env.example (current endpoint/model, key blank) and .dockerignore so the exported dir is deploy-ready. */
export function ensureDeployFiles(id) {
  const project = readProject(id);
  if (!project) throw new Error('project not found');
  const dir = projectDir(id);
  const llm = getProjectLlm();
  const env = [
    'PORT=3000',
    `SUPERDEMO_PROJECT_NAME=${project.name}`,
    `SUPERDEMO_LLM_BASE_URL=${llm.baseUrl || 'https://api.deepseek.com'}`,
    'SUPERDEMO_LLM_API_KEY=',
    `SUPERDEMO_LLM_MODEL=${llm.model || 'deepseek-chat'}`,
    '',
  ].join('\n');
  writeIfChanged(path.join(dir, '.env.example'), env);
  const di = path.join(dir, '.dockerignore');
  if (!fs.existsSync(di)) fs.writeFileSync(di, ['node_modules', '.git', '.superdemo', '.env', '.DS_Store', 'data/*.db-wal', 'data/*.db-shm', ''].join('\n'));
  return project;
}
function writeIfChanged(file, content) {
  try { if (fs.readFileSync(file, 'utf8') === content) return; } catch {}
  fs.writeFileSync(file, content);
}

/** Relative paths of every file that belongs in the export. */
function collectFiles(dir) {
  const out = [];
  (function walk(abs, rel) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(path.join(abs, ent.name), r); continue; }
      if (!ent.isFile() || SKIP_FILES.has(ent.name) || SKIP_SUFFIXES.some(s => ent.name.endsWith(s))) continue;
      out.push(r);
    }
  })(dir, '');
  return out;
}

/** Zip the project directory (top-level folder = project id). Returns { name, buffer, files }. */
export function zipProject(id) {
  const project = ensureDeployFiles(id);
  const dir = projectDir(id);
  const files = collectFiles(dir);
  const entries = files.map(rel => {
    const abs = path.join(dir, rel);
    const data = fs.readFileSync(abs);
    return { name: `${id}/${rel}`, data, mtime: fs.statSync(abs).mtime };
  });
  return { name: `${safeName(project.name) || id}.zip`, buffer: buildZip(entries), files: files.length };
}
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// ---- minimal zip writer ----
function buildZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data);
    let method = 8, body = zlib.deflateRawSync(e.data, { level: 6 });
    if (body.length >= e.data.length) { method = 0; body = e.data; } // store when deflate does not help
    const { time, date } = dosTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0o100644 * 0x10000, 38); // unix mode -rw-r--r-- in the high 16 bits
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// ---- docker ----
function run(args, timeout = 10_000) {
  return new Promise(resolve => execFile('docker', args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), code: err?.code })));
}

/** Is the docker CLI present and the daemon reachable? */
export async function dockerInfo() {
  const r = await run(['version', '--format', '{{.Server.Version}}']);
  if (r.ok && r.stdout) return { available: true, version: r.stdout };
  const cli = await run(['--version']);
  if (!cli.ok) return { available: false, reason: '未检测到 docker 命令，请安装 Docker Desktop 或 Docker Engine' };
  return { available: false, reason: 'Docker 守护进程未运行，请先启动 Docker Desktop / colima / dockerd', detail: r.stderr.split('\n')[0] };
}

/** Local image for this project, if one has been built. */
export async function imageInfo(id) {
  const r = await run(['image', 'inspect', imageTag(id), '--format', '{{.Size}} {{.Created}}']);
  if (!r.ok) return null;
  const [size, created] = r.stdout.split(' ');
  return { tag: imageTag(id), size: Number(size) || 0, created };
}

const building = new Set();
export const isBuilding = id => building.has(id);

/** docker build the project dir; onLine({ stream, line }) for every output line. Resolves { ok, code, image, ms }. */
export function buildImage(id, onLine) {
  if (building.has(id)) return Promise.reject(new Error('该项目正在构建镜像'));
  ensureDeployFiles(id);
  const cwd = projectDir(id), tag = imageTag(id), t0 = Date.now();
  building.add(id);
  return new Promise(resolve => {
    const proc = spawn('docker', ['build', '-t', tag, '.'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const emit = (stream, chunk) => { for (const line of String(chunk).split('\n')) if (line.trim()) onLine({ stream, line }); };
    proc.stdout.on('data', d => emit('out', d));
    proc.stderr.on('data', d => emit('err', d)); // buildkit writes progress to stderr; not an error per se
    proc.on('error', e => { building.delete(id); onLine({ stream: 'err', line: 'docker: ' + e.message }); resolve({ ok: false, code: -1, image: tag, ms: Date.now() - t0 }); });
    proc.on('exit', code => { building.delete(id); resolve({ ok: code === 0, code, image: tag, ms: Date.now() - t0 }); });
  });
}

/** `docker save <tag>` piped through gzip. Returns the child process; caller pipes .stdout and gzips. */
export function saveImage(id) {
  return spawn('docker', ['save', imageTag(id)], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Shell commands to show the user for running the image / the extracted zip. */
export function runHints(id, project) {
  const tag = imageTag(id);
  return {
    image: tag,
    tarball: `superdemo-${id}.tar.gz`,
    dockerRun: `docker run -d --name ${id} -p 3000:3000 -v "$PWD/data:/app/data" --env-file .env ${tag}`,
    dockerLoad: `docker load -i superdemo-${id}.tar.gz`,
    zipRun: `cd ${id}\ncp .env.example .env    # 填入 API Key\nnpm start                # 需要 Node >= 22.13；或 docker compose up -d --build`,
    name: project?.name || id,
  };
}
