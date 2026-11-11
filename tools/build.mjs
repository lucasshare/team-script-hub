import { readFile, realpath, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REPOSITORY_URL = 'https://github.com/lucasshare/team-script-hub';
export const DISTRIBUTION_BASE = 'https://raw.githubusercontent.com/lucasshare/team-script-hub/main';

export function metadata(source) {
  const header = source.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/m);
  if (!header || !source.startsWith('// ==UserScript==')) throw new Error('脚本必须以完整的油猴元信息开头。');
  const values = new Map();
  for (const match of header[1].matchAll(/^\/\/[ \t]+@(\S+)(?:[ \t]+([^\r\n]*))?[ \t]*$/gm)) {
    const list = values.get(match[1]) ?? [];
    list.push((match[2] ?? '').trim());
    values.set(match[1], list);
  }
  return { header: header[0], values };
}

export function withUpdateUrls(source, origin, id) {
  const { header } = metadata(source);
  let updated = header;
  for (const [key, suffix] of [['updateURL', 'meta.js'], ['downloadURL', 'user.js']]) {
    const line = `// @${key.padEnd(13)}${origin}/scripts/${id}.${suffix}`;
    const pattern = new RegExp(`^//[ \\t]+@${key}[ \\t]+[^\\r\\n]+`, 'gm');
    const matches = [...updated.matchAll(pattern)];
    if (matches.length > 1) throw new Error(`${id} 的 @${key} 重复。`);
    updated = matches.length ? updated.replace(pattern, line) : updated.replace('// ==/UserScript==', line + '\n// ==/UserScript==');
  }
  // 只调整发布头；名称、命名空间、权限和业务正文保持原样。
  return updated + source.slice(header.length);
}

export async function prepare({ root = projectRoot, origin = DISTRIBUTION_BASE, catalog } = {}) {
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
    for (const field of ['name', 'namespace', 'description', 'category', 'usage', 'releaseNotes', 'updated', 'version', 'file']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new Error(`${entry.id} 缺少 ${field}。`);
    }
    if (!/^\d+(?:\.\d+){1,3}$/.test(entry.version)) throw new Error(`${entry.id} 必须使用原脚本的两到四段数字版本号。`);
    const date = new Date(`${entry.updated}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.updated) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry.updated) throw new Error('发布日期无效。');
    if (!Array.isArray(entry.pages) || entry.pages.length === 0 || entry.pages.some(page => typeof page !== 'string' || !/^https?:\/\//.test(page))) throw new Error('适用页面必须列出真实匹配地址。');
    const expected = `userscripts/${entry.id}/${entry.id}.v${entry.version}.user.js`;
    if (entry.file !== expected) throw new Error(`${entry.id} 的版本文件路径不符合约定。`);
    const sourcePath = await realpath(resolve(root, entry.file));
    if (!sourcePath.startsWith(sourcesRoot + sep)) throw new Error('脚本文件不得指向 userscripts 外部。');
    const source = await readFile(sourcePath, 'utf8');
    if (entry.sourceSha256 && createHash('sha256').update(source, 'utf8').digest('hex') !== entry.sourceSha256) throw new Error(`${entry.id} 的源文件与已选版本指纹不一致。`);
    const { values } = metadata(source);
    const one = (key, expectedValue) => {
      const actual = values.get(key);
      if (actual?.length !== 1 || actual[0] !== expectedValue) throw new Error(`${entry.id} 的 @${key} 与发布约定不一致。`);
    };
    one('version', entry.version);
    one('name', entry.name);
    one('author', 'Lucas');
    one('namespace', entry.namespace);
    if (JSON.stringify(values.get('match')) !== JSON.stringify(entry.pages)) throw new Error(`${entry.id} 的适用页面与 @match 不一致。`);
    new Script(source, { filename: entry.file });
    let output = withUpdateUrls(source, origin, entry.id);
    // 安装示例的主页占位符也只在元信息内替换。
    const outputHeader = metadata(output).header;
    output = outputHeader.replaceAll('__PUBLIC_ORIGIN__', REPOSITORY_URL) + output.slice(outputHeader.length);
    files.set(`scripts/${entry.id}.user.js`, output);
    files.set(`scripts/${entry.id}.meta.js`, metadata(output).header + '\n');
    const { file, sourceSha256, ...publicEntry } = entry;
    published.push({ ...publicEntry, installPath: `scripts/${entry.id}.user.js` });
  }
  const workflows = new Map();
  for (const entry of entries.filter(item => item.workflow)) {
    const flow = entry.workflow;
    if (!/^[a-z][a-z0-9-]*$/.test(flow.id) || typeof flow.name !== 'string' || !flow.name.trim() || !Number.isInteger(flow.step) || flow.step < 1 || typeof flow.role !== 'string' || !flow.role.trim()) throw new Error(`${entry.id} 的工作流信息无效。`);
    const group = workflows.get(flow.id) ?? { name: flow.name, steps: new Set() };
    if (group.name !== flow.name || group.steps.has(flow.step)) throw new Error('工作流名称冲突或步骤重复。');
    group.steps.add(flow.step);
    workflows.set(flow.id, group);
  }
  for (const group of workflows.values()) {
    if ([...group.steps].sort((a, b) => a - b).some((step, index) => step !== index + 1)) throw new Error('工作流步骤必须从 1 连续排列。');
  }
  files.set('scripts.json', JSON.stringify(published, null, 2) + '\n');
  files.set('README.md', renderReadme(entries, origin));
  return files;
}

function markdown(value) {
  return String(value).replaceAll('|', '&#124;').replace(/[\r\n]+/g, ' ');
}

export function renderReadme(entries, base = DISTRIBUTION_BASE) {
  const header = '| 平台 | 脚本名称 | 用途 | 使用注意 | 当前版本 | 安装链接 |\n| --- | --- | --- | --- | --- | --- |';
  const table = items => header + '\n' + items.map(entry => {
    const note = entry.workflow ? `面单第 ${entry.workflow.step} 步。${entry.notes ?? entry.usage}` : entry.notes ?? entry.usage;
    return `| ${entry.platforms.map(markdown).join('、')} | ${markdown(entry.name)} | ${markdown(entry.description)} | ${markdown(note)} | v${entry.version} | [安装脚本](${base}/scripts/${entry.id}.user.js) |`;
  }).join('\n');
  const flow = entries.filter(item => item.workflow).sort((a, b) => a.workflow.step - b.workflow.step);
  const standalone = entries.filter(item => !item.workflow && !item.demo);
  const demo = entries.filter(item => item.demo);
  return `# 团队共享脚本中心

团队共享的油猴脚本库。打开本页查看用途，点击“安装脚本”，在 Tampermonkey 页面确认安装。无需单独的网站或 GitHub 登录。

当前收录 **${flow.length + standalone.length} 个业务脚本**，均为已确认共享的最新版；另提供安装验证示例。由 Lucas 统一维护，后续更新使用固定地址。

## 先安装油猴

从 [Tampermonkey 官网](https://www.tampermonkey.net/)选择浏览器并安装扩展。如果安装链接只显示代码，请确认油猴已启用，或复制该链接到油猴管理面板“实用工具”的 URL 安装入口。

## OMS / TEMU 面单工作流

以下 **${flow.length} 个脚本需分别安装**。按“库存查询 → 订单采集 → 填仓 → 下载面单 → 按需删除旧面单 → 上传新面单”配套使用。库存查询和采集器使用同一浏览器配置；先核对本批任务，再进入后续步骤。签名、物流渠道和最终下单仍由人工处理。

${table(flow)}

仓库优先级 CSV、商品尺寸表及 SKU 映射表按实际业务准备，详见 [配套使用说明](docs/shared-scripts.md)。

## 其他共享工具

${table(standalone)}

## 安装验证

${table(demo)}

## 安装与更新

- 每个脚本独立安装，名称和命名空间沿用原脚本，权限及业务逻辑保持原样。
- 已安装同版本旧脚本时，从本页手动安装一次以采用共享更新地址；后续由油猴按设置检查更高版本。更新不是实时强制推送。
- 在对应平台登录并具有业务权限后使用。ERP 同步自建版还需要能访问原有工作台服务。
- 这里提供已确认的脚本文件和说明。发布检查不等于已在每位同事的账号或 Windows 环境完成业务运行验收。

## 管理与发布

源码原文件在 \`userscripts/\`，发布清单在 \`catalog.json\`；本页目录、\`scripts/\` 中的安装/更新文件和 \`scripts.json\` 由工具生成。

\`\`\`sh
npm test
npm run build
npm run check
\`\`\`

新增或升级时保留旧版源文件，更新清单，运行检查，再提交和推送。不要直接修改生成的脚本文件或首页表格。详细规则见 [AGENTS.md](AGENTS.md) 和 [分发说明](docs/deployment.md)。历史网页草案仅留存，不作为使用入口，也不构建或部署独立网站。
`;
}

export async function build({ root = projectRoot, check = false } = {}) {
  const files = await prepare({ root });
  const failures = [];
  for (const [name, content] of files) {
    const target = resolve(root, name);
    if (check) {
      try { if (await readFile(target, 'utf8') !== content) failures.push(name); }
      catch (error) { if (error.code === 'ENOENT') failures.push(name); else throw error; }
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
  }
  try {
    const actual = await readdir(resolve(root, 'scripts'));
    for (const file of actual) {
      if (!files.has('scripts/' + file)) failures.push('未在发布清单中的 scripts/' + file);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (failures.length) throw new Error('发布文件未同步或包含多余文件：' + failures.join('、') + '；请核对清单并运行 npm run build。');
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await build({ check: process.argv.includes('--check') });
  console.log(`${process.argv.includes('--check') ? '检查通过' : '生成完成'}：${files.size} 个分发文件，更新地址：${DISTRIBUTION_BASE}/scripts/`);
}
