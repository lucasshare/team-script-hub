// ==UserScript==
// @name         OMS ERP面单一键批量删除
// @namespace    lucas.oms.bulkdelete
// @version      1.8
// @description  紧凑预览当前订单的全部关联附件，并在二次核对后顺序删除和逐项验证
// @author       Lucas
// @match        https://oms.zhiyuansys.com/Order/index*
// @run-at       document-idle
// @grant        GM_download
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/oms-erp-waybill-bulk-delete.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/oms-erp-waybill-bulk-delete.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG_KEY = '__oms_waybill_delete_v160__';
  const BUBBLE_SIZE = 44;
  const MARGIN = 8;
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const state = {
    running: false,
    paused: false,
    stopRequested: false,
    preview: [],
    results: [],
  };
  let root;
  let config = loadConfig();
  let dragMoved = false;

  function loadConfig() {
    try {
      return { x: 18, y: 180, interval: 500, limit: 0, scope: 'checked', ...JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') };
    } catch (_) {
      return { x: 18, y: 180, interval: 500, limit: 0, scope: 'checked' };
    }
  }

  function saveConfig(patch) {
    config = { ...config, ...patch };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function interruptibleWait(ms) {
    let remaining = ms;
    while (remaining > 0 && !state.stopRequested) {
      while (state.paused && !state.stopRequested) await sleep(150);
      const step = Math.min(150, remaining);
      await sleep(step);
      remaining -= step;
    }
  }

  function checkedOrderIds() {
    const ids = new Set();
    document.querySelectorAll('#example1 tbody input[name="checkList"]:checked').forEach(input => {
      const candidates = [input.getAttribute('values'), input.value, input.dataset.id, input.getAttribute('data-id')];
      const id = candidates.find(value => /^\d+$/.test(String(value || '')));
      if (id) ids.add(String(id));
      const row = input.closest('tr');
      if (!row) return;
      const onclick = [...row.querySelectorAll('[onclick]')].map(element => element.getAttribute('onclick') || '').join('\n');
      const match = onclick.match(/(?:attach_file|doEdit)\((\d+)/);
      if (match) ids.add(match[1]);
    });
    return ids;
  }

  function currentDataTableRows() {
    const jq = pageWindow.jQuery;
    if (!jq || !jq.fn || !jq.fn.DataTable || !jq.fn.DataTable.isDataTable('#example1')) {
      throw new Error('订单表格尚未初始化，请先等待页面加载或查询一次');
    }
    const table = jq('#example1').DataTable();
    return table.rows({ search: 'applied', page: 'current' }).data().toArray();
  }

  function parseOrderItem(item) {
    const info = item && item.info || {};
    const attachments = Array.isArray(item && item.attach_file) ? item.attach_file : [];
    return {
      orderId: String(info.id || ''),
      systemOrder: normalizeText(info.label || ''),
      platformOrder: normalizeText(info.src_oid || ''),
      attachments,
    };
  }

  function buildPreview(scope, limit) {
    const checked = checkedOrderIds();
    if (scope === 'checked' && !checked.size) throw new Error('当前页没有勾选订单');
    const orders = [];
    currentDataTableRows().forEach(item => {
      const order = parseOrderItem(item);
      if (!order.orderId) return;
      if (scope === 'checked' && !checked.has(order.orderId)) return;
      orders.push(order);
    });

    const selectedOrders = limit > 0 ? orders.slice(0, limit) : orders;
    const tasks = [];
    selectedOrders.forEach(order => {
      order.attachments.forEach(attachment => {
        const attachmentId = String(attachment && attachment.id || '');
        if (!attachmentId) return;
        tasks.push({
          orderId: order.orderId,
          systemOrder: order.systemOrder,
          platformOrder: order.platformOrder,
          attachmentId,
          fileName: normalizeText(attachment.srcname || attachment.file_name || attachment.name || ''),
          type: normalizeText(attachment.type_str || '') || '未标注类型',
        });
      });
    });

    const unique = [];
    const seen = new Set();
    tasks.forEach(task => {
      const key = `${task.orderId}:${task.attachmentId}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(task);
    });
    return unique;
  }

  async function postForm(path, params) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams(params),
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; }
    catch (_) { throw new Error(`返回不是 JSON：${text.slice(0, 120)}`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 120)}`);
    return json;
  }

  async function deleteAttachment(task) {
    const response = await postForm('/Order/delFile', { id: task.attachmentId });
    if (response.code !== 400) throw new Error(response.message || '删除请求失败');
    if (response.data != null && String(response.data) !== task.orderId) {
      throw new Error(`删除返回订单 ID ${response.data}，预期 ${task.orderId}`);
    }
    const verify = await postForm('/Order/getFileLists', { id: task.orderId });
    if (verify.code !== 400) throw new Error(verify.message || '附件列表核验失败');
    const list = Array.isArray(verify.data) ? verify.data : [];
    if (list.some(item => String(item && item.id || '') === task.attachmentId)) {
      throw new Error('删除后核验仍存在该附件');
    }
    return true;
  }

  function refreshOrderTable() {
    const jq = pageWindow.jQuery;
    if (!jq || !jq.fn || !jq.fn.DataTable || !jq.fn.DataTable.isDataTable('#example1')) return;
    jq('#example1').DataTable().draw(false);
  }

  function csvEscape(value) {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function resultCsv() {
    const headers = ['系统订单号', '平台订单号', '订单内部ID', '附件ID', '文件名', '类型', '结果', '备注', '完成时间'];
    const rows = state.results.map(item => [
      item.systemOrder, item.platformOrder, item.orderId, item.attachmentId, item.fileName,
      item.type, item.success ? '成功' : '失败', item.message, item.finishedAt,
    ]);
    return `\ufeff${[headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
  }

  function downloadResults() {
    if (!state.results.length) return setStatus('当前没有可导出的结果', 'error');
    const blob = new Blob([resultCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const name = `OMS关联附件删除结果_${stamp}.csv`;
    if (typeof GM_download === 'function') {
      GM_download({
        url,
        name,
        saveAs: false,
        timeout: 60000,
        onload: () => { URL.revokeObjectURL(url); setStatus(`结果文件下载完成：${name}`, 'success'); },
        onerror: error => { URL.revokeObjectURL(url); setStatus(`结果下载失败：${error && error.error || '未知错误'}`, 'error'); },
        ontimeout: () => { URL.revokeObjectURL(url); setStatus('结果下载超时', 'error'); },
      });
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus(`已发起结果下载：${name}`, 'info');
  }

  function clamp(x, y, width, height) {
    return {
      x: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      y: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    };
  }

  function snap(x, y) {
    const position = clamp(x, y, BUBBLE_SIZE, BUBBLE_SIZE);
    const nearest = [
      ['left', position.x], ['right', window.innerWidth - position.x - BUBBLE_SIZE],
      ['top', position.y], ['bottom', window.innerHeight - position.y - BUBBLE_SIZE],
    ].sort((a, b) => a[1] - b[1])[0][0];
    if (nearest === 'left') position.x = MARGIN;
    if (nearest === 'right') position.x = window.innerWidth - BUBBLE_SIZE - MARGIN;
    if (nearest === 'top') position.y = MARGIN;
    if (nearest === 'bottom') position.y = window.innerHeight - BUBBLE_SIZE - MARGIN;
    return clamp(position.x, position.y, BUBBLE_SIZE, BUBBLE_SIZE);
  }

  function place(element, position) {
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
  }

  function avoidUploadPanel(panel) {
    const other = document.querySelector('#__erp_auto_panel:not(.min)');
    if (!other) return;
    const panelRect = panel.getBoundingClientRect();
    const otherRect = other.getBoundingClientRect();
    const overlaps = (left, top) => !(
      left + panelRect.width + 6 <= otherRect.left
      || left >= otherRect.right + 6
      || top + panelRect.height + 6 <= otherRect.top
      || top >= otherRect.bottom + 6
    );
    if (!overlaps(panelRect.left, panelRect.top)) return;
    const candidates = [
      { x: otherRect.right + 8, y: otherRect.top },
      { x: otherRect.left - panelRect.width - 8, y: otherRect.top },
      { x: otherRect.left, y: otherRect.top - panelRect.height - 8 },
      { x: otherRect.left, y: otherRect.bottom + 8 },
    ];
    const target = candidates.find(item => (
      item.x >= MARGIN && item.y >= MARGIN
      && item.x + panelRect.width <= window.innerWidth - MARGIN
      && item.y + panelRect.height <= window.innerHeight - MARGIN
      && !overlaps(item.x, item.y)
    ));
    if (!target) return;
    place(panel, target);
    saveConfig({ x: Math.round(target.x), y: Math.round(target.y) });
  }

  function bindDrag(handle, target, isBubble) {
    handle.addEventListener('pointerdown', event => {
      if (!isBubble && event.target.closest('button,input,select')) return;
      event.preventDefault();
      let moved = false;
      if (isBubble) dragMoved = false;
      const rect = target.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      handle.setPointerCapture(event.pointerId);
      const onMove = moveEvent => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (Math.hypot(dx, dy) > 5) { moved = true; if (isBubble) dragMoved = true; }
        place(target, clamp(rect.left + dx, rect.top + dy, target.offsetWidth, target.offsetHeight));
      };
      const onUp = upEvent => {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        const current = target.getBoundingClientRect();
        const position = isBubble ? snap(current.left, current.top) : clamp(current.left, current.top, target.offsetWidth, target.offsetHeight);
        place(target, position);
        saveConfig({ x: Math.round(position.x), y: Math.round(position.y) });
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  const css = `
    #__bdPanel,#__bdBubble{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;color:#1d1d1f;box-sizing:border-box}#__bdPanel *{box-sizing:border-box}
    #__bdBubble{position:fixed;z-index:2147483570;width:${BUBBLE_SIZE}px;height:${BUBBLE_SIZE}px;border:1px solid rgba(255,255,255,.92);border-radius:50%;display:grid;place-items:center;padding:0;background:#303640;color:#fff;box-shadow:0 6px 18px rgba(15,23,42,.24),inset 0 0 0 1px rgba(255,255,255,.12);font-size:11px;font-weight:700;text-align:center;cursor:grab;user-select:none}
    #__bdBubble::after{content:'';position:absolute;right:2px;bottom:3px;width:7px;height:7px;border:2px solid #303640;border-radius:50%;background:#ef4444}
    #__bdPanel{position:fixed;z-index:2147483570;width:min(220px,calc(100vw - 16px));height:auto;max-height:min(520px,calc(100vh - 16px));display:flex;flex-direction:column;background:#fff;border:1px solid #dde2ea;border-radius:14px;box-shadow:0 14px 36px rgba(20,34,58,.16);overflow:hidden;font-size:11px}
    #__bdPanel .head{height:38px;min-height:38px;padding:0 6px 0 9px;display:flex;align-items:center;gap:4px;cursor:move;user-select:none;border-bottom:1px solid #e9edf3;background:#f7f8fa}#__bdPanel .title{font-weight:700;font-size:12px}#__bdPanel .spacer{flex:1}
    #__bdPanel .body{padding:6px;overflow-x:hidden;overflow-y:auto;flex:0 1 auto;max-height:480px}#__bdPanel .card{padding:6px;border:1px solid #e7ebf2;border-radius:8px;background:#fff;margin-bottom:5px}#__bdPanel .row{display:flex;align-items:center;gap:4px;flex-wrap:wrap}#__bdPanel .row+ .row{margin-top:4px}#__bdPanel .row.nowrap{flex-wrap:nowrap}#__bdPanel .compact-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px}#__bdPanel .compact-field{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:3px}#__bdPanel .actions{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin-top:5px}
    #__bdPanel label{font-size:10px;color:#596579;white-space:nowrap}#__bdPanel input,#__bdPanel select{min-width:0;font:inherit;border:1px solid #dfe5ee;border-radius:6px;background:#fbfcfe;padding:4px 5px;color:#1d1d1f}#__bdPanel select{flex:1}#__bdPanel input[type=number]{width:100%}#__bdPanel input[type=checkbox]{accent-color:#c5362e;width:14px;height:14px;padding:0}
    #__bdPanel button{font:inherit;font-weight:600;font-size:10px;min-height:24px;border:0;border-radius:6px;padding:3px 4px;background:#edf1f6;color:#344158;cursor:pointer}#__bdPanel button:hover{filter:brightness(.98)}#__bdPanel button:active{transform:translateY(1px)}#__bdPanel button:disabled{opacity:.45;cursor:not-allowed;transform:none}#__bdPanel button:focus-visible,#__bdPanel input:focus-visible,#__bdPanel select:focus-visible,#__bdBubble:focus-visible{outline:3px solid rgba(197,54,46,.3);outline-offset:2px}
    #__bdPanel .primary{background:#0878ef;color:#fff}#__bdPanel .danger{width:100%;margin-top:5px;background:#c5362e;color:#fff}#__bdPanel .icon{width:26px;padding:0;background:transparent;color:#6f7784;font-size:15px}
    #__bdStatus{padding:5px 6px;border-radius:7px;background:#f3f5f8;color:#4c586b;font-size:10px;line-height:1.35;white-space:pre-wrap}#__bdStatus.error{background:#fff0f0;color:#a92c2c}#__bdStatus.success{background:#eaf8f1;color:#126b4b}
    #__bdPreview{max-height:158px;overflow:auto;border:1px solid #e6eaf0;border-radius:7px;background:#fbfcfe}#__bdPreview .preview-item{padding:6px;border-bottom:1px solid #e8ecf2}#__bdPreview .preview-item:last-child{border-bottom:0}#__bdPreview .preview-head{display:flex;align-items:center;gap:4px;font-size:10px}#__bdPreview .preview-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#__bdPreview .preview-type{margin-left:auto;flex:none;padding:1px 4px;border-radius:999px;background:#edf1f6;color:#526076;font-size:9px}#__bdPreview .preview-file{margin-top:2px;color:#273247;font-size:10px;line-height:1.25;word-break:break-all}#__bdPreview .preview-meta{margin-top:2px;color:#7b8494;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #__bdConfirm{display:none;padding:6px;border-radius:8px;background:#fff4f2;border:1px solid #ffd0cc}#__bdConfirm.visible{display:block}#__bdConfirm label{display:flex;align-items:flex-start;gap:4px;white-space:normal;line-height:1.3}
    #__bdPanel details{margin-top:5px}#__bdPanel summary{cursor:pointer;color:#657084;font-size:10px}#__bdLog{max-height:74px;overflow:auto;margin-top:4px;padding:5px;border-radius:7px;background:#f4f6f9;font:9px/1.45 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap}
    @media(prefers-color-scheme:dark){#__bdBubble{border-color:#fff;box-shadow:0 9px 24px rgba(0,0,0,.55),0 0 0 2px #000}}@media(prefers-reduced-motion:reduce){#__bdPanel,#__bdBubble{transition:none!important}}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function setStatus(message, type = '') {
    const element = root.querySelector('#__bdStatus');
    if (!element) return;
    element.className = type;
    element.id = '__bdStatus';
    element.textContent = message;
  }

  function log(message, color = '') {
    const box = root.querySelector('#__bdLog');
    if (!box) return;
    const line = document.createElement('div');
    line.textContent = message;
    if (color) line.style.color = color;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function renderBubble() {
    root.innerHTML = '<button id="__bdBubble" type="button" title="展开面单删除">删单</button>';
    const bubble = root.querySelector('#__bdBubble');
    const position = snap(config.x, config.y);
    place(bubble, position);
    saveConfig({ x: Math.round(position.x), y: Math.round(position.y) });
    bindDrag(bubble, bubble, true);
    bubble.addEventListener('click', () => {
      if (!dragMoved) renderPanel();
      dragMoved = false;
    });
  }

  function renderPanel() {
    root.innerHTML = `
      <section id="__bdPanel">
        <header class="head"><span class="title">关联附件删除</span><span class="spacer"></span><button id="__bdMin" class="icon" type="button" title="收起">—</button></header>
        <main class="body">
          <section class="card">
            <div class="row nowrap"><label for="__bdScope">范围</label><select id="__bdScope"><option value="checked" ${config.scope === 'checked' ? 'selected' : ''}>已勾选订单</option><option value="page" ${config.scope === 'page' ? 'selected' : ''}>当前页全部订单</option></select></div>
            <div class="compact-grid"><label class="compact-field" for="__bdLimit"><span>上限</span><input id="__bdLimit" type="number" min="0" step="1" title="0 = 全部订单" value="${Number(config.limit) || 0}"></label><label class="compact-field" for="__bdInterval"><span>间隔</span><input id="__bdInterval" type="number" min="300" step="100" title="毫秒" value="${Math.max(300, Number(config.interval) || 500)}"></label></div>
            <div class="actions"><button id="__bdPreviewBtn" class="primary" type="button" title="读取预览">预览</button><button id="__bdExport" type="button" title="导出结果" ${state.results.length ? '' : 'disabled'}>导出</button><button id="__bdPause" type="button" disabled>暂停</button><button id="__bdStop" type="button" disabled>停止</button></div>
          </section>
          <div id="__bdStatus">读取选中订单的全部关联附件；确认前不会删除。</div>
          <section class="card" style="margin-top:5px"><div id="__bdPreview"><div style="padding:12px;text-align:center;color:#7b8494">尚未读取</div></div></section>
          <section id="__bdConfirm"><label><input id="__bdChecked" type="checkbox"> <span id="__bdConfirmText"></span></label><button id="__bdStart" class="danger" type="button" disabled></button></section>
          <details><summary>运行记录</summary><div id="__bdLog"></div></details>
        </main>
      </section>`;
    const panel = root.querySelector('#__bdPanel');
    place(panel, clamp(config.x, config.y, panel.offsetWidth, panel.offsetHeight));
    avoidUploadPanel(panel);
    bindDrag(panel.querySelector('.head'), panel, false);
    bindPanelEvents();
  }

  function clearPreview(reason = '') {
    state.preview = [];
    const preview = root.querySelector('#__bdPreview');
    if (preview) preview.innerHTML = '<div style="padding:18px;text-align:center;color:#7b8494">配置已变化，请重新读取</div>';
    const confirm = root.querySelector('#__bdConfirm');
    if (confirm) confirm.classList.remove('visible');
    if (reason) setStatus(reason, '');
  }

  function renderPreview() {
    const box = root.querySelector('#__bdPreview');
    if (!state.preview.length) {
      box.innerHTML = '<div style="padding:18px;text-align:center;color:#a92c2c">范围内没有关联附件</div>';
      root.querySelector('#__bdConfirm').classList.remove('visible');
      return;
    }
    box.innerHTML = state.preview.map((task, index) => `<article class="preview-item"><div class="preview-head"><strong>#${index + 1} ${escapeHtml(task.systemOrder || task.platformOrder)}</strong><span class="preview-type">${escapeHtml(task.type)}</span></div><div class="preview-file" title="${escapeHtml(task.fileName)}">${escapeHtml(task.fileName || '未命名附件')}</div><div class="preview-meta" title="${escapeHtml(task.platformOrder)} · 附件 ID ${escapeHtml(task.attachmentId)}">${escapeHtml(task.platformOrder)} · ID ${escapeHtml(task.attachmentId)}</div></article>`).join('');
    const confirm = root.querySelector('#__bdConfirm');
    confirm.classList.add('visible');
    const orderCount = new Set(state.preview.map(task => task.orderId)).size;
    root.querySelector('#__bdConfirmText').textContent = `已核对 ${orderCount} 个订单，共 ${state.preview.length} 个附件`;
    root.querySelector('#__bdStart').textContent = `删除 ${state.preview.length} 个附件`;
    root.querySelector('#__bdChecked').checked = false;
    root.querySelector('#__bdStart').disabled = true;
    avoidUploadPanel(root.querySelector('#__bdPanel'));
  }

  function setRunning(next) {
    state.running = next;
    root.querySelectorAll('#__bdScope,#__bdLimit,#__bdInterval,#__bdPreviewBtn,#__bdChecked,#__bdStart,#__bdMin').forEach(element => { if (element) element.disabled = next; });
    root.querySelector('#__bdPause').disabled = !next;
    root.querySelector('#__bdStop').disabled = !next;
  }

  async function executeDeletion() {
    if (state.running || !state.preview.length) return;
    state.results = [];
    state.stopRequested = false;
    state.paused = false;
    const interval = Math.max(300, Number(root.querySelector('#__bdInterval').value) || 500);
    setRunning(true);
    root.querySelector('#__bdLog').innerHTML = '';
    setStatus(`准备顺序处理 ${state.preview.length} 个关联附件。`, '');
    try {
      for (let index = 0; index < state.preview.length; index++) {
        if (state.stopRequested) break;
        while (state.paused && !state.stopRequested) await sleep(150);
        if (state.stopRequested) break;
        const task = state.preview[index];
        setStatus(`处理中 ${index + 1}/${state.preview.length} · ${task.systemOrder || task.platformOrder}`, '');
        try {
          await deleteAttachment(task);
          state.results.push({ ...task, success: true, message: '删除并核验通过', finishedAt: new Date().toISOString() });
          log(`${index + 1}/${state.preview.length} 成功 · ${task.systemOrder} · ${task.fileName}`, '#126b4b');
        } catch (error) {
          state.results.push({ ...task, success: false, message: error.message, finishedAt: new Date().toISOString() });
          log(`${index + 1}/${state.preview.length} 失败 · ${task.systemOrder} · ${error.message}`, '#a92c2c');
        }
        if (index < state.preview.length - 1 && !state.stopRequested) await interruptibleWait(interval);
      }
      const success = state.results.filter(item => item.success).length;
      const failed = state.results.length - success;
      setStatus(`处理结束：成功 ${success}，失败 ${failed}${state.stopRequested ? `，停止前已处理 ${state.results.length}/${state.preview.length}` : ''}。`, failed ? 'error' : 'success');
      root.querySelector('#__bdExport').disabled = !state.results.length;
      if (success) refreshOrderTable();
    } finally {
      setRunning(false);
      root.querySelector('#__bdPause').textContent = '暂停';
      state.preview = [];
      root.querySelector('#__bdConfirm').classList.remove('visible');
      root.querySelector('#__bdChecked').checked = false;
      root.querySelector('#__bdStart').disabled = true;
    }
  }

  function bindPanelEvents() {
    root.querySelector('#__bdMin').addEventListener('click', renderBubble);
    ['#__bdScope', '#__bdLimit', '#__bdInterval'].forEach(selector => {
      root.querySelector(selector).addEventListener('change', () => clearPreview('配置已变化，请重新读取并核对。'));
    });
    root.querySelector('#__bdPreviewBtn').addEventListener('click', () => {
      try {
        const scope = root.querySelector('#__bdScope').value;
        const limit = Math.max(0, Number(root.querySelector('#__bdLimit').value) || 0);
        const interval = Math.max(300, Number(root.querySelector('#__bdInterval').value) || 500);
        saveConfig({ scope, limit, interval });
        state.preview = buildPreview(scope, limit);
        renderPreview();
        const orderCount = new Set(state.preview.map(task => task.orderId)).size;
        setStatus(`已读取 ${orderCount} 个订单的 ${state.preview.length} 个关联附件。请核对类型、文件名和附件 ID。`, state.preview.length ? '' : 'error');
      } catch (error) {
        state.preview = [];
        renderPreview();
        setStatus(error.message, 'error');
      }
    });
    root.querySelector('#__bdChecked').addEventListener('change', event => {
      root.querySelector('#__bdStart').disabled = !event.target.checked;
    });
    root.querySelector('#__bdStart').addEventListener('click', executeDeletion);
    root.querySelector('#__bdPause').addEventListener('click', () => {
      if (!state.running) return;
      state.paused = !state.paused;
      root.querySelector('#__bdPause').textContent = state.paused ? '继续' : '暂停';
      setStatus(state.paused ? `已暂停 · 已处理 ${state.results.length}/${state.preview.length}` : '继续处理。', '');
    });
    root.querySelector('#__bdStop').addEventListener('click', () => {
      state.stopRequested = true;
      state.paused = false;
      setStatus('已请求停止，将在当前请求完成后停止。', '');
    });
    root.querySelector('#__bdExport').addEventListener('click', downloadResults);
  }

  root = document.createElement('div');
  document.body.appendChild(root);
  renderPanel();
  window.addEventListener('resize', () => {
    const bubble = root.querySelector('#__bdBubble');
    const panel = root.querySelector('#__bdPanel');
    const target = bubble || panel;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const position = bubble ? snap(rect.left, rect.top) : clamp(rect.left, rect.top, target.offsetWidth, target.offsetHeight);
    place(target, position);
    saveConfig({ x: Math.round(position.x), y: Math.round(position.y) });
  });
})();
