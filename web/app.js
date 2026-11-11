const search = document.querySelector('#search');
const category = document.querySelector('#category');
const platform = document.querySelector('#platform');
const container = document.querySelector('#scripts');
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const count = document.querySelector('#count');
let entries = [];
let ready = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function scriptCard(entry) {
  const card = element('article', undefined, 'card');
  const top = element('div', undefined, 'card-top');
  const tags = element('div', undefined, 'tags');
  for (const name of entry.platforms) tags.append(element('span', name, 'tag platform-tag'));
  tags.append(element('span', entry.category, 'tag'));
  top.append(tags, element('span', `v${entry.version}`, 'version'));
  card.append(top, element('h3', entry.name), element('p', entry.description, 'description'));
  if (entry.demo) card.append(element('p', '演示脚本 · 用于确认安装流程', 'demo-label'));
  const pageLabel = element('p', '适用页面', 'small-label');
  const pages = element('div', undefined, 'pages');
  for (const page of entry.pages) pages.append(element('code', page));
  const details = element('details', undefined, 'script-details');
  details.append(element('summary', '用法与本次更新'), element('p', entry.usage), element('p', entry.releaseNotes));
  const bottom = element('div', undefined, 'card-bottom');
  const updated = element('span', `更新于 ${entry.updated}`, 'muted');
  const install = element('a', '安装脚本 ↗', 'button');
  install.href = entry.installPath;
  install.target = '_blank';
  install.rel = 'noopener noreferrer';
  install.setAttribute('aria-label', `安装 ${entry.name} v${entry.version}`);
  bottom.append(updated, install);
  card.append(pageLabel, pages, details, bottom);
  return card;
}

function render() {
  if (!ready) return;
  const query = search.value.trim().toLocaleLowerCase('zh-CN');
  const matches = entries.filter(entry => (!category.value || entry.category === category.value) && (!platform.value || entry.platforms.includes(platform.value)) && [entry.name, entry.description, entry.category, ...entry.platforms, ...entry.pages].join(' ').toLocaleLowerCase('zh-CN').includes(query));
  container.replaceChildren(...matches.map(scriptCard));
  count.textContent = `显示 ${matches.length} / ${entries.length} 个脚本`;
  status.hidden = matches.length > 0;
  status.textContent = matches.length ? '' : '没有找到匹配的脚本，试试其他关键词、平台或分类。';
}

async function load() {
  ready = false;
  status.hidden = false;
  status.textContent = '正在读取脚本清单…';
  retry.hidden = true;
  container.replaceChildren();
  count.textContent = '正在加载清单…';
  try {
    const response = await fetch('scripts.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data) || data.some(entry => !entry || !/^[a-z][a-z0-9-]*$/.test(entry.id) || entry.installPath !== `scripts/${entry.id}.user.js` || !Array.isArray(entry.platforms) || entry.platforms.length === 0 || entry.platforms.some(name => typeof name !== 'string' || !name.trim()) || !Array.isArray(entry.pages) || entry.pages.some(page => typeof page !== 'string') || ['name', 'description', 'category', 'version', 'updated', 'usage', 'releaseNotes'].some(key => typeof entry[key] !== 'string'))) throw new Error('脚本清单格式不正确');
    entries = data;
    for (const [select, names, label] of [
      [platform, entries.flatMap(entry => entry.platforms), '全部平台'],
      [category, entries.map(entry => entry.category), '全部分类']
    ]) {
      select.replaceChildren(element('option', label));
      select.firstElementChild.value = '';
      select.value = '';
      for (const name of new Set(names)) {
        const option = element('option', name);
        option.value = name;
        select.append(option);
      }
    }
    ready = true;
    render();
  } catch (error) {
    count.textContent = '加载失败';
    status.textContent = `暂时无法加载脚本清单（${error.message}），请稍后重试。`;
    retry.hidden = false;
  }
}

search.addEventListener('input', render);
category.addEventListener('change', render);
platform.addEventListener('change', render);
retry.addEventListener('click', load);
load();
