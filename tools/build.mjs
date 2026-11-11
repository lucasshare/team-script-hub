import { readFile, realpath, mkdir, writeFile, rename, access } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function publicOrigin(value, local = false) {
  if (local) return 'http://127.0.0.1:4173';
  if (!value) throw new Error('正式构建缺少 SITE_URL，请设置为 Cloudflare Pages 的正式 HTTPS 地址。');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('SITE_URL 必须是正式 HTTPS 域名，不能包含凭据、端口、路径或查询参数。');
  }
  return url.origin;
}

export function metadata(source) {
  const header = source.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/m);
  if (!header || !source.startsWith('// ==UserScript==')) throw new Error('脚本必须以完整的油猴元信息开头。');
  const values = new Map();
  for (const match of header[1].matchAll(/^\/\/\s+@(\S+)\s+(.+)$/gm)) {
    const list = values.get(match[1]) ?? [];
    list.push(match[2].trim());
    values.set(match[1], list);
  }
  return { header: header[0], values };
}

export async function prepare({ root = projectRoot, origin, catalog } = {}) {
  if (!origin) throw new Error('缺少构建地址。');
  const entries = catalog ?? JSON.parse(await readFile(resolve(root, 'catalog.json'), 'utf8'));
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('发布清单必须是非空数组。');
  const files = new Map();
  const published = [];
  const seen = new Set();
  const sourcesRoot = await realpath(resolve(root, 'userscripts'));
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.id) || seen.has(entry.id)) throw new Error('脚本 ID 无效或重复。');
    seen.add(entry.id);
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0 || entry.platforms.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim()) || new Set(entry.platforms).size !== entry.platforms.length) throw new Error(`${entry.id} 的所属平台必须是非空且不重复的名称列表。`);
    for (const field of ['name', 'description', 'category', 'usage', 'releaseNotes', 'updated', 'version', 'file']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new Error(`${entry.id} 缺少 ${field}。`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(entry.version)) throw new Error(`${entry.id} 必须使用三段数字版本号。`);
    const date = new Date(`${entry.updated}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.updated) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry.updated) throw new Error('发布日期无效。');
    if (!Array.isArray(entry.pages) || entry.pages.length === 0 || entry.pages.some(page => typeof page !== 'string' || !/^https?:\/\//.test(page))) throw new Error('适用页面必须列出真实匹配地址。');
    const expected = `userscripts/${entry.id}/${entry.id}.v${entry.version}.user.js`;
    if (entry.file !== expected) throw new Error(`${entry.id} 的版本文件路径不符合约定。`);
    const sourcePath = await realpath(resolve(root, entry.file));
    if (!sourcePath.startsWith(sourcesRoot + sep)) throw new Error('脚本文件不得指向 userscripts 外部。');
    const source = await readFile(sourcePath, 'utf8');
    const { values } = metadata(source);
    const one = (key, expectedValue) => {
      const actual = values.get(key);
      if (actual?.length !== 1 || actual[0] !== expectedValue) throw new Error(`${entry.id} 的 @${key} 与发布约定不一致。`);
    };
    one('version', entry.version);
    one('name', entry.name);
    one('author', 'Lucas');
    one('namespace', 'https://github.com/lucasshare/team-script-hub');
    one('updateURL', `__PUBLIC_ORIGIN__/scripts/${entry.id}.meta.js`);
    one('downloadURL', `__PUBLIC_ORIGIN__/scripts/${entry.id}.user.js`);
    if (JSON.stringify(values.get('match')) !== JSON.stringify(entry.pages)) throw new Error(`${entry.id} 的适用页面与 @match 不一致。`);
    new Script(source, { filename: entry.file });
    const output = source.replaceAll('__PUBLIC_ORIGIN__', origin);
    files.set(`scripts/${entry.id}.user.js`, output);
    files.set(`scripts/${entry.id}.meta.js`, metadata(output).header + '\n');
    const { file, ...publicEntry } = entry;
    published.push({ ...publicEntry, installPath: `scripts/${entry.id}.user.js` });
  }
  for (const file of ['index.html', 'app.js', 'style.css', '_headers', '404.html']) {
    files.set(file, await readFile(resolve(root, 'web', file), 'utf8'));
  }
  files.set('scripts.json', JSON.stringify(published, null, 2) + '\n');
  return files;
}

export async function build({ root = projectRoot, origin } = {}) {
  // 先完整验证，再写入新目录；失败时保留上一份可用产物。
  const files = await prepare({ root, origin });
  const stamp = `${Date.now()}-${process.pid}`;
  const staging = resolve(root, '.trash', `build-${stamp}`);
  await mkdir(staging, { recursive: true });
  for (const [name, content] of files) {
    const target = resolve(staging, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  const dist = resolve(root, 'dist');
  try { await access(dist); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await rename(staging, dist);
    return files;
  }
  await rename(dist, resolve(root, '.trash', `previous-dist-${stamp}`));
  await rename(staging, dist);
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = publicOrigin(process.env.SITE_URL, process.argv.includes('--local'));
  const files = await build({ origin });
  console.log(`构建完成：${files.size} 个公开文件，安装与更新地址：${origin}`);
}
