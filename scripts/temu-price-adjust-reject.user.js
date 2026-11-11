// ==UserScript==
// @name         Temu 调价单一键拒绝助手
// @namespace    https://agentseller.temu.com/
// @version      0.1.1
// @description  在商品价格申报页按当前账号所选店铺批量拒绝待卖家确认的调价单
// @author       Lucas
// @match        https://agentseller.temu.com/main/adjust-price-manage/order-price*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-price-adjust-reject.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-price-adjust-reject.user.js
// ==/UserScript==

(function () {
  "use strict";

  const API_USER_INFO = "/api/seller/auth/userInfo";
  const API_LIST = "/api/kiana/magnus/mms/price-adjust/page-query";
  const API_REJECT = "/api/kiana/magnus/mms/price-adjust/batch-review";
  const STATUS_CONFIRMING = 1;
  const RESULT_REJECT = 2;
  const PAGE_SIZE = 200;
  const REJECT_BATCH_SIZE = 100;
  const MAX_ROUNDS = 50; // 单店最大循环轮数兜底，防止后端 total 不归零时死循环
  const DEFAULT_REASON = "不接受调价";
  const POS_KEY = "tm_price_adjust_reject_pos";
  const STORE_SELECTION_KEY = "tm_price_adjust_reject_store_selection_v1";

  let running = false;
  let stopRequested = false;
  let expanded = false;
  let stores = [];
  let storeLoadPromise = null;

  function toText(value) {
    return value == null ? "" : String(value).trim();
  }

  function storeLabel(store) {
    return `${store.name} (${store.mallId})`;
  }

  async function readJsonResponse(response, label) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label}返回不是有效 JSON，HTTP ${response.status}`);
    }
  }

  async function fetchStores() {
    const response = await fetch(API_USER_INFO, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await readJsonResponse(response, "店铺列表");
    if (!response.ok || data.success === false) {
      const message =
        data.errorMsg ||
        data.error_msg ||
        data.message ||
        response.statusText ||
        "店铺列表读取失败";
      throw new Error(`${response.status} ${message}`);
    }

    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(data.result?.mallList) ? data.result.mallList : []) {
      const mallId = toText(item?.mallId);
      const name = toText(item?.mallName);
      if (!/^\d+$/.test(mallId) || !name || seen.has(mallId)) continue;
      seen.add(mallId);
      result.push({ mallId, name });
    }
    if (!result.length) throw new Error("当前账号未返回可用店铺");
    return result;
  }

  function loadSavedStoreIds() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE_SELECTION_KEY) || "[]");
      return Array.isArray(value) ? value.map(String) : [];
    } catch {
      return [];
    }
  }

  function selectedStoreIds(panel) {
    return Array.from(
      panel.querySelectorAll('.tm-store-list input[type="checkbox"]:checked'),
      (input) => input.value,
    );
  }

  function selectedStores(panel) {
    const ids = new Set(selectedStoreIds(panel));
    return stores.filter((store) => ids.has(store.mallId));
  }

  function saveStoreSelection(panel) {
    localStorage.setItem(
      STORE_SELECTION_KEY,
      JSON.stringify(selectedStoreIds(panel)),
    );
  }

  function renderStores(panel, selectedIds) {
    const list = panel.querySelector(".tm-store-list");
    const selected = new Set(selectedIds);
    list.textContent = "";
    for (const store of stores) {
      const label = document.createElement("label");
      label.className = "tm-store-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = store.mallId;
      input.checked = selected.has(store.mallId);
      const text = document.createElement("span");
      text.textContent = storeLabel(store);
      label.append(input, text);
      list.appendChild(label);
    }
    updateStoreSummary(panel);
  }

  function updateStoreSummary(panel) {
    const count = selectedStoreIds(panel).length;
    panel.querySelector(".tm-store-summary").textContent = stores.length
      ? `店铺（已选 ${count}/${stores.length}）`
      : "店铺";
    updateActionState(panel);
  }

  function updateActionState(panel) {
    const busy = running || Boolean(storeLoadPromise);
    const hasSelectedStore = selectedStoreIds(panel).length > 0;
    panel.querySelector(".tm-count").disabled = busy || !hasSelectedStore;
    panel.querySelector(".tm-run").disabled = busy || !hasSelectedStore;
    panel.querySelector(".tm-stop").disabled = !running;
    panel.querySelector(".tm-reload-stores").disabled = busy;
    panel.querySelector(".tm-select-all-stores").disabled = busy || !stores.length;
    panel.querySelector(".tm-clear-stores").disabled = busy || !stores.length;
    panel
      .querySelectorAll('.tm-store-list input[type="checkbox"]')
      .forEach((input) => {
        input.disabled = busy;
      });
  }

  async function reloadStores(panel, preserveCurrentSelection = true) {
    if (storeLoadPromise) return storeLoadPromise;
    const selectedIds = preserveCurrentSelection
      ? selectedStoreIds(panel)
      : loadSavedStoreIds();
    const list = panel.querySelector(".tm-store-list");
    list.innerHTML = '<div class="tm-store-message">正在读取当前账号店铺...</div>';
    storeLoadPromise = (async () => {
      stores = await fetchStores();
      const validIds = new Set(stores.map((store) => store.mallId));
      const restoredIds = selectedIds.filter((mallId) => validIds.has(mallId));
      renderStores(panel, restoredIds);
      localStorage.setItem(STORE_SELECTION_KEY, JSON.stringify(restoredIds));
      log(panel, `动态读取店铺完成：${stores.length} 个，已选 ${restoredIds.length} 个。`);
      return stores;
    })();
    updateActionState(panel);
    try {
      return await storeLoadPromise;
    } catch (error) {
      stores = [];
      list.textContent = "";
      const message = document.createElement("div");
      message.className = "tm-store-message tm-error";
      message.textContent = toText(error.message || error);
      list.appendChild(message);
      panel.querySelector(".tm-store-summary").textContent = "店铺（读取失败）";
      throw error;
    } finally {
      storeLoadPromise = null;
      updateActionState(panel);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function loadPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || "{}");
      return {
        right: Number.isFinite(saved.right) ? saved.right : 24,
        top: Number.isFinite(saved.top) ? saved.top : 120,
      };
    } catch {
      return { right: 24, top: 120 };
    }
  }

  function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 56));
    const right = Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 56));
    panel.style.top = `${top}px`;
    panel.style.right = `${right}px`;
    localStorage.setItem(POS_KEY, JSON.stringify({ top, right }));
  }

  function makeStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #tm-price-reject {
        position: fixed;
        z-index: 2147483647;
        top: 120px;
        right: 24px;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #1d1d1f;
        user-select: none;
      }
      #tm-price-reject .tm-bubble {
        width: 42px;
        height: 42px;
        border-radius: 50%;
        border: 1px solid rgba(0, 0, 0, 0.08);
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
        display: grid;
        place-items: center;
        cursor: pointer;
        backdrop-filter: blur(14px);
        font-weight: 700;
      }
      #tm-price-reject .tm-card {
        display: none;
        width: 310px;
        border-radius: 8px;
        border: 1px solid rgba(0, 0, 0, 0.08);
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.18);
        backdrop-filter: blur(16px);
        overflow: hidden;
      }
      #tm-price-reject.tm-open .tm-bubble { display: none; }
      #tm-price-reject.tm-open .tm-card { display: block; }
      #tm-price-reject .tm-head {
        height: 38px;
        padding: 0 10px 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid rgba(0, 0, 0, 0.06);
        cursor: move;
        font-weight: 650;
      }
      #tm-price-reject .tm-body { padding: 12px; }
      #tm-price-reject textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #d2d2d7;
        border-radius: 8px;
        padding: 8px 9px;
        outline: none;
        resize: vertical;
        font: inherit;
      }
      #tm-price-reject textarea:focus {
        border-color: #0071e3;
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.16);
      }
      #tm-price-reject .tm-store-block {
        margin-top: 10px;
        border: 1px solid #e5e5ea;
        border-radius: 10px;
        overflow: hidden;
      }
      #tm-price-reject .tm-store-head,
      #tm-price-reject .tm-store-tools {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 7px 8px;
      }
      #tm-price-reject .tm-store-head {
        border-bottom: 1px solid #ededf0;
        font-weight: 650;
      }
      #tm-price-reject .tm-store-tools {
        justify-content: flex-start;
        padding-top: 0;
      }
      #tm-price-reject .tm-store-tools button,
      #tm-price-reject .tm-store-head button {
        height: 26px;
        padding: 0 8px;
        font-size: 12px;
        font-weight: 600;
      }
      #tm-price-reject .tm-store-list {
        max-height: 142px;
        overflow: auto;
        padding: 5px 8px;
      }
      #tm-price-reject .tm-store-option {
        display: flex;
        align-items: flex-start;
        gap: 7px;
        padding: 5px 0;
        cursor: pointer;
        line-height: 1.35;
      }
      #tm-price-reject .tm-store-option input {
        width: 15px;
        height: 15px;
        margin: 1px 0 0;
        accent-color: #0071e3;
        flex: 0 0 auto;
      }
      #tm-price-reject .tm-store-message {
        padding: 8px 0;
        color: #6e6e73;
        font-size: 12px;
      }
      #tm-price-reject .tm-store-message.tm-error { color: #d70015; }
      #tm-price-reject .tm-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 10px;
      }
      #tm-price-reject button {
        height: 34px;
        border: 0;
        border-radius: 8px;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
      }
      #tm-price-reject .tm-primary { background: #0071e3; color: white; }
      #tm-price-reject .tm-gray { background: #f5f5f7; color: #1d1d1f; }
      #tm-price-reject .tm-danger { background: #ff3b30; color: white; }
      #tm-price-reject button:disabled { opacity: 0.48; cursor: not-allowed; }
      #tm-price-reject .tm-log {
        margin-top: 10px;
        height: 170px;
        overflow: auto;
        border-radius: 8px;
        background: #f5f5f7;
        padding: 8px;
        white-space: pre-wrap;
        user-select: text;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function makePanel() {
    const pos = loadPosition();
    const panel = document.createElement("div");
    panel.id = "tm-price-reject";
    panel.style.top = `${pos.top}px`;
    panel.style.right = `${pos.right}px`;
    panel.innerHTML = `
      <div class="tm-bubble" title="Temu 调价单拒绝">拒</div>
      <div class="tm-card">
        <div class="tm-head">
          <span>调价单拒绝助手</span>
          <button class="tm-gray tm-close" type="button" title="收起">×</button>
        </div>
        <div class="tm-body">
          <textarea class="tm-reason" rows="2" maxlength="200">${DEFAULT_REASON}</textarea>
          <div class="tm-store-block">
            <div class="tm-store-head">
              <span class="tm-store-summary">店铺</span>
              <button class="tm-gray tm-reload-stores" type="button">刷新</button>
            </div>
            <div class="tm-store-list">
              <div class="tm-store-message">正在读取当前账号店铺...</div>
            </div>
            <div class="tm-store-tools">
              <button class="tm-gray tm-select-all-stores" type="button">全选</button>
              <button class="tm-gray tm-clear-stores" type="button">清空</button>
            </div>
          </div>
          <div class="tm-row">
            <button class="tm-gray tm-count" type="button" disabled>查询数量</button>
            <button class="tm-primary tm-run" type="button" disabled>拒绝所选</button>
          </div>
          <div class="tm-row">
            <button class="tm-danger tm-stop" type="button" disabled>停止</button>
            <button class="tm-gray tm-clear" type="button">清空日志</button>
          </div>
          <div class="tm-log"></div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);
    wirePanel(panel);
    requestAnimationFrame(() => clampPanel(panel));
    reloadStores(panel, false).catch((error) => {
      log(panel, `店铺读取失败：${error.message || error}`);
    });
  }

  function wirePanel(panel) {
    const bubble = panel.querySelector(".tm-bubble");
    const close = panel.querySelector(".tm-close");
    const countBtn = panel.querySelector(".tm-count");
    const runBtn = panel.querySelector(".tm-run");
    const stopBtn = panel.querySelector(".tm-stop");
    const clearBtn = panel.querySelector(".tm-clear");
    const head = panel.querySelector(".tm-head");
    const storeList = panel.querySelector(".tm-store-list");

    bubble.addEventListener("click", () => setExpanded(panel, true));
    close.addEventListener("click", () => setExpanded(panel, false));
    clearBtn.addEventListener("click", () => setLog(panel, ""));
    countBtn.addEventListener("click", () => runCount(panel));
    runBtn.addEventListener("click", () => runRejectAll(panel));
    stopBtn.addEventListener("click", () => {
      stopRequested = true;
      log(panel, "已请求停止，当前批次结束后停下。");
    });
    panel
      .querySelector(".tm-reload-stores")
      .addEventListener("click", () => {
        reloadStores(panel, true).catch((error) => {
          log(panel, `店铺读取失败：${error.message || error}`);
        });
      });
    panel
      .querySelector(".tm-select-all-stores")
      .addEventListener("click", () => {
        storeList
          .querySelectorAll('input[type="checkbox"]')
          .forEach((input) => {
            input.checked = true;
          });
        saveStoreSelection(panel);
        updateStoreSummary(panel);
      });
    panel
      .querySelector(".tm-clear-stores")
      .addEventListener("click", () => {
        storeList
          .querySelectorAll('input[type="checkbox"]')
          .forEach((input) => {
            input.checked = false;
          });
        saveStoreSelection(panel);
        updateStoreSummary(panel);
      });
    storeList.addEventListener("change", (event) => {
      if (event.target?.type !== "checkbox") return;
      saveStoreSelection(panel);
      updateStoreSummary(panel);
    });

    let dragging = null;
    head.addEventListener("mousedown", (event) => {
      dragging = {
        startX: event.clientX,
        startY: event.clientY,
        startTop: panel.getBoundingClientRect().top,
        startRight: window.innerWidth - panel.getBoundingClientRect().right,
      };
      event.preventDefault();
    });
    window.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      panel.style.top = `${dragging.startTop + event.clientY - dragging.startY}px`;
      panel.style.right = `${dragging.startRight - (event.clientX - dragging.startX)}px`;
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = null;
      clampPanel(panel);
    });
    window.addEventListener("resize", () => clampPanel(panel));
  }

  function setExpanded(panel, value) {
    expanded = value;
    panel.classList.toggle("tm-open", expanded);
    clampPanel(panel);
  }

  function log(panel, message) {
    const logBox = panel.querySelector(".tm-log");
    const time = new Date().toLocaleTimeString();
    logBox.textContent += `[${time}] ${message}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  function setLog(panel, value) {
    panel.querySelector(".tm-log").textContent = value;
  }

  function setBusy(panel, value) {
    panel.querySelector(".tm-reason").disabled = value;
    updateActionState(panel);
  }

  async function postJson(path, mallId, payload) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        mallid: mallId,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!response.ok || data.success === false) {
      const message = data.errorMsg || data.error_msg || data.message || response.statusText;
      throw new Error(`${response.status} ${message}`);
    }
    return data.result || data.res || data;
  }

  async function queryPage(store, pageNo = 1) {
    return postJson(API_LIST, store.mallId, {
      pageInfo: { pageSize: PAGE_SIZE, pageNo },
      status: STATUS_CONFIRMING,
    });
  }

  async function queryCount(store) {
    const result = await queryPage(store, 1);
    return Number(result.total || 0);
  }

  function uniqueOrderIds(list) {
    return Array.from(new Set((list || []).map((item) => item && item.id).filter(Boolean)));
  }

  function chunk(list, size) {
    const chunks = [];
    for (let index = 0; index < list.length; index += size) {
      chunks.push(list.slice(index, index + size));
    }
    return chunks;
  }

  async function rejectOrders(store, ids, reason) {
    const rejectReasons = Object.fromEntries(ids.map((id) => [id, reason]));
    return postJson(API_REJECT, store.mallId, {
      batchResult: RESULT_REJECT,
      submitOrders: ids,
      rejectReasons,
    });
  }

  async function runCount(panel) {
    if (running) return;
    running = true;
    stopRequested = false;
    setBusy(panel, true);
    try {
      await reloadStores(panel, true);
      const targets = selectedStores(panel);
      if (!targets.length) {
        log(panel, "请至少选择一个店铺。");
        return;
      }
      log(panel, `开始查询所选 ${targets.length} 个店铺的待确认调价单数量。`);
      for (const store of targets) {
        if (stopRequested) {
          log(panel, "已停止查询。");
          return;
        }
        const total = await queryCount(store);
        log(panel, `${storeLabel(store)}: ${total} 条待拒绝`);
      }
      log(panel, "查询完成。");
    } catch (error) {
      log(panel, `查询失败：${error.message}`);
    } finally {
      running = false;
      setBusy(panel, false);
    }
  }

  async function runRejectAll(panel) {
    if (running) return;
    const reason = panel.querySelector(".tm-reason").value.trim();
    if (!reason) {
      alert("请先填写拒绝原因。");
      return;
    }

    running = true;
    stopRequested = false;
    setBusy(panel, true);
    try {
      await reloadStores(panel, true);
      const targets = selectedStores(panel);
      if (!targets.length) {
        log(panel, "请至少选择一个店铺。");
        return;
      }

      const counts = [];
      log(panel, "执行前先查询数量。");
      for (const store of targets) {
        if (stopRequested) {
          log(panel, "已停止。");
          return;
        }
        const total = await queryCount(store);
        counts.push({ store, total });
        log(panel, `${storeLabel(store)}: ${total} 条待拒绝`);
      }

      const totalAll = counts.reduce((sum, item) => sum + item.total, 0);
      if (!totalAll) {
        log(panel, "所选店铺都没有待拒绝调价单。");
        return;
      }

      const detail = counts
        .map((item) => `${storeLabel(item.store)}: ${item.total} 条`)
        .join("\n");
      if (!confirm(`确认拒绝以下调价单？\n\n${detail}\n\n拒绝原因：${reason}`)) {
        log(panel, "已取消。");
        return;
      }

      for (const { store } of counts) {
        await rejectStoreUntilEmpty(panel, store, reason);
        if (stopRequested) break;
      }
      log(panel, stopRequested ? "已停止。" : "全部处理完成。");
    } catch (error) {
      log(panel, `执行失败：${error.message}`);
    } finally {
      running = false;
      stopRequested = false;
      setBusy(panel, false);
    }
  }

  async function rejectStoreUntilEmpty(panel, store, reason) {
    // 按 mallId 分组隔离的已处理 id 集合：即使代码改成跨店铺共享，也不会出现
    // "店铺 A 的 id 误跳过店铺 B 的订单"的情况
    const handledIdsByStore = new Map();
    const handledIds = (handledIdsByStore.get(store.mallId) ||
      handledIdsByStore.set(store.mallId, new Set()).get(store.mallId));
    let handled = 0; // 累计成功条数（仅供面板日志展示）
    let round = 0;

    while (!stopRequested && round < MAX_ROUNDS) {
      round += 1;
      // 1) 拉首页：和原版一致用 pageNo=1，让后端按更新时间排序，
      //    新插入的单子排前面，已处理的单子会随时间下移到 page 2+。
      const listResult = await queryPage(store, 1);
      const allIds = uniqueOrderIds(listResult.list || []);
      // 2) 关键改动：把已成功拒绝过的 id 过滤掉，剩下的才是本轮真正要处理的
      const ids = allIds.filter((id) => !handledIds.has(id));
      const remaining = Number(listResult.total || 0);

      if (!ids.length) {
        log(panel, `${storeLabel(store)}: 已无新待处理调价单，累计成功拒绝 ${handled} 条。`);
        return;
      }

      log(panel, `${storeLabel(store)}: 第 ${round} 轮，后台剩余 ${remaining} 条，去重后本轮新 ${ids.length} 条。`);
      for (const idGroup of chunk(ids, REJECT_BATCH_SIZE)) {
        if (stopRequested) return;
        const rejectResult = await rejectOrders(store, idGroup, reason);
        // successOrders 是后端实际确认拒绝成功的 id 列表；
        // 只有把成功的 id 加入 handledIds，失败的才会在下一轮再次进入 list 等待重试
        const successIds = Array.isArray(rejectResult.successOrders) ? rejectResult.successOrders : [];
        const failedMap = rejectResult.failedOrders || {};
        for (const id of successIds) {
          if (!handledIds.has(id)) {
            handledIds.add(id);
            handled += 1;
          }
        }
        const failed = Object.keys(failedMap).length;
        const success = successIds.length;
        log(panel, `${storeLabel(store)}: 本批提交 ${idGroup.length} 条，成功 ${success} 条，失败 ${failed} 条。`);
        if (failed) {
          log(panel, `${storeLabel(store)}: 失败明细 ${JSON.stringify(failedMap)}`);
        }
        await sleep(500);
      }
      await sleep(800);
    }

    // 走到这里有两种可能：用户按了停止，或者达到最大轮数兜底
    if (!stopRequested) {
      log(panel, `${storeLabel(store)}: 已达最大轮数 ${MAX_ROUNDS} 兜底，累计成功 ${handled} 条，停止。`);
    }
  }

  makeStyles();
  makePanel();
})();
