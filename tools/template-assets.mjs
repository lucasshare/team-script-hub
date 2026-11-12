import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export function readZip(bytes) {
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (bytes.readUInt32LE(position) === 0x06054b50) { end = position; break; }
  }
  if (end < 0) throw new Error('ZIP 缺少结束目录。');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录无效。');
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (files.has(name) || name.split('/').includes('..')) throw new Error('ZIP 路径重复或越界。');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    if (![0, 8].includes(method)) throw new Error('ZIP 压缩格式不支持。');
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('CSV 双引号未闭合。');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(values => values.some(value => value.trim()));
}

export async function loadTemplates(root, entries) {
  const manifest = JSON.parse(await readFile(resolve(root, 'templates/manifest.json'), 'utf8'));
  if (manifest.sampleRows !== 5 || !Array.isArray(manifest.assets)) throw new Error('样例清单必须明确每张表最多 5 条数据。');
  const usedIds = new Set(entries.flatMap(entry => entry.templateIds ?? []));
  const assets = new Map();
  const downloadNames = new Set();
  const content = new Map();
  async function verify(file, directory) {
    if (typeof file.path !== 'string' || !file.path.startsWith(directory + '/')) throw new Error('模板路径无效。');
    const base = await realpath(resolve(root, directory));
    const actual = await realpath(resolve(root, file.path));
    if (!actual.startsWith(base + sep)) throw new Error('模板路径越界。');
    const bytes = await readFile(actual);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('模板内容与已审查指纹不一致：' + file.path);
    content.set(file.path, bytes);
    return bytes;
  }
  for (const asset of manifest.assets) {
    if (!/^[a-z0-9-]+$/.test(asset.id) || assets.has(asset.id) || !Array.isArray(asset.sheets) || !asset.sheets.length || asset.sheets.some(sheet => !Number.isInteger(sheet.dataRows) || sheet.dataRows < 0 || sheet.dataRows > 5 || !Array.isArray(sheet.headers))) throw new Error('模板标识或保留行数无效。');
    if (!/^[a-z0-9][a-z0-9.-]*\.(?:csv|xlsx)$/.test(asset.downloadName) || downloadNames.has(asset.downloadName) || !asset.downloadName.endsWith('.' + asset.format.toLowerCase())) throw new Error('模板下载附件名无效或重复。');
    downloadNames.add(asset.downloadName);
    if (!usedIds.has(asset.id)) throw new Error('不能发布未关联已共享脚本的模板：' + asset.name);
    const owner = entries.find(entry => (entry.templateIds ?? []).includes(asset.id));
    if (asset.path !== `userscripts/${owner.id}/templates/${asset.name}` || !/^[^/\\]+$/.test(asset.name)) throw new Error('模板必须放在对应脚本的 templates 子目录。');
    const bytes = await verify(asset, `userscripts/${owner.id}/templates`);
    if (asset.format === 'CSV') {
      if (!bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) throw new Error('CSV 必须使用 UTF-8 BOM。');
      const rows = parseCsv(bytes.toString('utf8'));
      if (rows.length !== asset.sheets[0].dataRows + 1 || JSON.stringify(rows[0]) !== JSON.stringify(asset.sheets[0].headers)) throw new Error('CSV 表头或数据行数不符合已审查清单。');
    } else if (asset.format === 'XLSX') {
      const zip = readZip(bytes);
      if ([...zip.keys()].some(name => /externalLinks|pivotCache|vbaProject|comments/i.test(name))) throw new Error('样例 Excel 不能包含外链、完整缓存、宏或批注。');
      const sheets = [...zip.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
      if (sheets.length !== asset.sheets.length) throw new Error('Excel 工作表数量不符。');
      for (const [, xml] of sheets) {
        const text = xml.toString('utf8').replace(/(<\/?)[A-Za-z_][\w.-]*:/g, '$1');
        if (/<f(?:\s|>|\/)/.test(text) || [...text.matchAll(/<row\b[^>]*\br="(\d+)"/g)].some(match => Number(match[1]) > 6)) throw new Error('样例 Excel 含公式或第 6 行之后的数据。');
      }
    } else throw new Error('不支持的模板格式。');
    assets.set(asset.id, asset);
  }
  const bundle = await verify(manifest.bundle, 'templates');
  const members = readZip(bundle);
  if (members.size !== assets.size) throw new Error('样例合集文件数量不一致。');
  for (const asset of assets.values()) {
    const owner = entries.find(entry => (entry.templateIds ?? []).includes(asset.id));
    const bytes = members.get(`${owner.id}/${asset.name}`);
    if (!bytes || !bytes.equals(content.get(asset.path))) throw new Error('ZIP 不是当前已审查的精简样例：' + asset.name);
  }
  for (const entry of entries) {
    for (const id of entry.templateIds ?? []) {
      const asset = assets.get(id);
      if (!asset || asset.scriptVersions[entry.id] !== entry.version) throw new Error('脚本关联模板或适用版本不一致：' + entry.id);
    }
  }
  return { manifest, assets };
}

export function urlPath(path) {
  return path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

export const TEMPLATE_DOWNLOAD_BASE = 'https://github.com/lucasshare/team-script-hub/releases/download/template-samples';

export function templateDownloadUrl(file) {
  return `${TEMPLATE_DOWNLOAD_BASE}/${urlPath(file.downloadName ?? file.name ?? file.path.split('/').at(-1))}`;
}
