// ==UserScript==
// @name         Temu 面单批量下载
// @namespace    temu-waybill-batch
// @version      1.5.6
// @description  接收 OMS 本批任务，按当前账号动态店铺范围查询并下载普通或补寄面单，支持三站协作和 CSV 货号映射
// @author       Lucas
// @match        https://oms.zhiyuansys.com/Order/index*
// @match        https://agentseller.temu.com/mmsos/waybill.html*
// @match        https://agentseller-us.temu.com/mmsos/waybill.html*
// @match        https://agentseller-eu.temu.com/mmsos/waybill.html*
// @match        https://agentseller.temu.com/mmsos/reship-list.html*
// @match        https://agentseller-us.temu.com/mmsos/reship-list.html*
// @match        https://agentseller-eu.temu.com/mmsos/reship-list.html*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const IS_OMS = location.hostname === "oms.zhiyuansys.com";
  const PANEL_ID = "__temuWaybillPanel";
  const LS_POS = "tm_waybill_panel_pos_v150";
  const LS_MIN = "tm_waybill_panel_min_v150";
  const LS_ORDERS = "tm_waybill_last_orders_v150";
  const LS_STORE_SELECTION = "tm_waybill_store_selection_v153";
  const LS_DAYS = "tm_waybill_days_v150";
  const SKU_MAP_KEY = "tm_waybill_sku_map_v150";
  const COMMAND_KEY = "tm_waybill_command_v150";
  const DOWNLOAD_LOCK_KEY = "tm_waybill_download_lock_v152";
  const OMS_TASK_EVENT_KEY = "lucas:oms:temuTaskEvent:v1";
  const OMS_TASK_CHANNEL = "lucas-oms-temu-task-v1";
  const OMS_TASKS_KEY = "tm_waybill_oms_tasks_v156";
  const OMS_ACTIVE_TASK_KEY = "tm_waybill_oms_active_task_v156";
  const MAX_OMS_TASKS = 20;
  const CLIENT_ID = `${location.hostname}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const LIST_PATH = "/mms/eagle/package/main_batch_query";
  const RESHIP_LIST_PATH = "/garen/mms/goodsReship/queryReshipList";
  const RESHIP_PAGE_SIZE = 10;
  const PRINT_PATH = "/mms/eagle/package/batch_print_shipping_label";
  const DOWNLOAD_GAP_MS = 240;
  const DOWNLOAD_LOCK_TTL_MS = 30 * 60 * 1000;

  const SITE_CONFIGS = [
    { key: "us", label: "US", host: "agentseller-us.temu.com", url: "https://agentseller-us.temu.com/mmsos/waybill.html" },
    { key: "eu", label: "EU", host: "agentseller-eu.temu.com", url: "https://agentseller-eu.temu.com/mmsos/waybill.html" },
    { key: "main", label: "主站", host: "agentseller.temu.com", url: "https://agentseller.temu.com/mmsos/waybill.html" },
  ];

  let STORE_CONFIGS = [];

  let els = {};
  let panel;
  let selectedStoreIds = new Set();
  let days = Number(localStorage.getItem(LS_DAYS) || 30);
  if (!Number.isFinite(days) || days < 1) days = 30;
  let lastCommandId = "";
  let running = false;
  let aborting = false;
  let logs = [];
  let failureRows = [];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function gmGet(key, fallback) {
    try { return typeof GM_getValue === "function" ? GM_getValue(key, fallback) : fallback; }
    catch (_) { return fallback; }
  }

  function gmSet(key, value) {
    if (typeof GM_setValue === "function") GM_setValue(key, value);
  }

  function taskOrders(task) {
    const source = safeArray(task?.poList).length
      ? task.poList
      : safeArray(task?.rows).map((row) => row?.po);
    return Array.from(new Set(source.map((value) => String(value || "").trim()).filter(Boolean)));
  }

  function taskList() {
    return safeArray(gmGet(OMS_TASKS_KEY, [])).filter((task) => task && task.id && taskOrders(task).length);
  }

  function activeTask() {
    const tasks = taskList();
    const activeId = String(gmGet(OMS_ACTIVE_TASK_KEY, "") || "");
    return tasks.find((task) => task.id === activeId) || tasks[0] || null;
  }

  function saveOmsTask(task) {
    if (!task || !task.id || !taskOrders(task).length) return false;
    const tasks = taskList().filter((item) => item.id !== task.id);
    tasks.unshift(task);
    gmSet(OMS_TASKS_KEY, tasks.slice(0, MAX_OMS_TASKS));
    gmSet(OMS_ACTIVE_TASK_KEY, task.id);
    return true;
  }

  function acceptOmsTaskEnvelope(envelope) {
    if (!envelope || envelope.type !== "upsert-task" || !envelope.task) return;
    saveOmsTask(envelope.task);
  }

  function startOmsBridge() {
    try { acceptOmsTaskEnvelope(JSON.parse(localStorage.getItem(OMS_TASK_EVENT_KEY) || "null")); }
    catch (_) { /* 当前 OMS 页没有待同步任务。 */ }
    window.addEventListener("lucas:oms:temu-task", (event) => acceptOmsTaskEnvelope(event.detail));
    window.addEventListener("storage", (event) => {
      if (event.key !== OMS_TASK_EVENT_KEY || !event.newValue) return;
      try { acceptOmsTaskEnvelope(JSON.parse(event.newValue)); }
      catch (_) { /* 忽略非任务内容。 */ }
    });
    try {
      const channel = new BroadcastChannel(OMS_TASK_CHANNEL);
      channel.addEventListener("message", (event) => acceptOmsTaskEnvelope(event.data));
    } catch (_) { /* 不支持 BroadcastChannel 时仍使用同页事件和 localStorage。 */ }
  }

  function selectedOrderSource() {
    const task = activeTask();
    const useManual = Boolean(els.manualOverride?.checked) || !task;
    const orders = useManual ? parseOrderInput(els.orders?.value || "") : taskOrders(task);
    return {
      orders,
      type: useManual ? "manual" : "oms-task",
      taskId: useManual ? "" : task.id,
      label: useManual ? "手工订单号" : `OMS 本批任务：${task.label || task.id}`,
    };
  }

  function renderTaskOptions() {
    if (!els.taskSelect || !els.taskInfo) return;
    const tasks = taskList();
    const task = activeTask();
    els.taskSelect.disabled = running || !tasks.length;
    els.taskSelect.innerHTML = tasks.length
      ? tasks.map((item) => `<option value="${escapeHtml(item.id)}" ${task && task.id === item.id ? "selected" : ""}>${escapeHtml(item.label || item.id)}</option>`).join("")
      : '<option value="">尚未收到 OMS 本批任务</option>';
    const orders = taskOrders(task);
    els.taskInfo.className = `tm-task-info${task ? "" : " warn"}`;
    els.taskInfo.textContent = task
      ? `当前批次 ${orders.length} 个订单，直接点击下载即可。`
      : "请先在 OMS 订单采集器勾选订单并点击“设为本批 TEMU 任务”；也可展开下方手工输入。";
    if (els.manualOverride) els.manualOverride.disabled = running || !task;
  }

  function listenOmsTaskChanges() {
    if (typeof GM_addValueChangeListener !== "function") return;
    [OMS_TASKS_KEY, OMS_ACTIVE_TASK_KEY].forEach((key) => {
      GM_addValueChangeListener(key, () => {
        renderTaskOptions();
        updateStats();
      });
    });
  }

  function currentSite() {
    return SITE_CONFIGS.find((item) => item.host === location.hostname) || null;
  }

  function currentPageKind() {
    return location.pathname === "/mmsos/reship-list.html" ? "reship" : "waybill";
  }

  function pageKindLabel(kind = currentPageKind()) {
    return kind === "reship" ? "补寄面单" : "普通面单";
  }

  function getCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function currentStore() {
    const mallId = localStorage.getItem("agentseller-mall-info-id") || getCookie("mallid") || "";
    return STORE_CONFIGS.find((store) => store.mallId === mallId)
      || { key: "current", name: `当前店铺 ${mallId || "未知"}`, mallId };
  }

  function savedStoreIds() {
    try {
      const value = JSON.parse(localStorage.getItem(LS_STORE_SELECTION) || "null");
      return Array.isArray(value) ? value.map(String) : null;
    } catch (_) {
      return null;
    }
  }

  function saveStoreIds() {
    localStorage.setItem(LS_STORE_SELECTION, JSON.stringify([...selectedStoreIds]));
  }

  async function loadStores() {
    if (STORE_CONFIGS.length) return STORE_CONFIGS;
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const response = await pageWindow.fetch("/api/seller/auth/userInfo", {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json, text/plain, */*", "content-type": "application/json;charset=UTF-8" },
      body: "{}",
    });
    const json = await response.json();
    const result = json?.result || json?.data || json;
    if (!response.ok || !Array.isArray(result?.mallList)) throw new Error("当前账号店铺列表读取失败");
    const seen = new Set();
    STORE_CONFIGS = result.mallList.map((item) => ({
      key: String(item?.mallId || ""),
      mallId: String(item?.mallId || ""),
      name: String(item?.mallName || item?.mallId || "").trim(),
    })).filter((store) => {
      if (!store.mallId || seen.has(store.mallId)) return false;
      seen.add(store.mallId);
      return true;
    });
    if (!STORE_CONFIGS.length) throw new Error("当前账号没有可用店铺");
    const valid = new Set(STORE_CONFIGS.map((store) => store.mallId));
    const saved = savedStoreIds();
    if (saved === null) {
      const currentId = currentStore().mallId;
      selectedStoreIds = new Set(currentId && valid.has(currentId) ? [currentId] : []);
    } else {
      selectedStoreIds = new Set(saved.filter((id) => valid.has(id)));
    }
    saveStoreIds();
    renderStoreOptions();
    updateStats();
    return STORE_CONFIGS;
  }

  function selectedStores(storeIds = [...selectedStoreIds]) {
    const wanted = new Set(storeIds.map(String));
    return STORE_CONFIGS.filter((store) => wanted.has(store.mallId));
  }

  async function apiPost(path, payload, mallId) {
    const text = await new Promise((resolve, reject) => {
      const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      const xhr = new pageWindow.XMLHttpRequest();
      xhr.open("POST", path, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", "application/json;charset=UTF-8");
      xhr.setRequestHeader("mallid", String(mallId || ""));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText || "");
          return;
        }
        reject(new Error(`HTTP ${xhr.status}: ${(xhr.responseText || "").slice(0, 160)}`));
      };
      xhr.onerror = () => reject(new Error(`XHR 请求失败：${path}`));
      xhr.send(JSON.stringify(payload));
    });
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error(`接口返回不是 JSON: ${text.slice(0, 160)}`);
    }
    if (json.success !== true) {
      const code = json.error_code || json.errorCode || "unknown";
      const msg = json.error_msg || json.errorMsg || json.message || "接口返回失败";
      throw new Error(`${code}: ${msg}`);
    }
    return json.result || {};
  }

  function sanitizeName(value) {
    return String(value || "")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  function parseOrderInput(text) {
    return Array.from(new Set(String(text || "")
      .split(/[\s,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean)));
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function buildListPayload(orderList, page = 1) {
    const end = nowSeconds();
    const begin = end - Math.max(1, days) * 86400;
    return {
      page,
      page_size: 50,
      parent_order_sn_list: orderList.join(" "),
      logistics_create_time: [begin * 1000, end * 1000],
      page_number: page,
      sort_type: 1,
      po_sn_list: orderList,
      call_begin_time: begin,
      call_end_time: end,
    };
  }

  function buildReshipListPayload(orderList, page = 1) {
    return {
      pageNumber: page,
      pageSize: RESHIP_PAGE_SIZE,
      parentOrderSnText: orderList.join(" "),
      groupSearchType: 0,
    };
  }

  function readSkuMap() {
    const fallback = { map: {}, updatedAt: "", count: 0 };
    try {
      return GM_getValue(SKU_MAP_KEY, fallback) || fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeSkuMap(data) {
    GM_setValue(SKU_MAP_KEY, data);
  }

  function normalizeHeader(value) {
    return String(value || "").trim().toLowerCase().replace(/[\s_\-]/g, "");
  }

  function parseCsvLine(line) {
    const cells = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted && ch === "\"" && line[i + 1] === "\"") {
        cur += "\"";
        i += 1;
      } else if (ch === "\"") {
        quoted = !quoted;
      } else if (ch === "," && !quoted) {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells.map((cell) => cell.trim());
  }

  function parseCsv(text) {
    const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) throw new Error("CSV 至少需要表头和一行数据");
    const headers = parseCsvLine(lines[0]);
    const normalized = headers.map(normalizeHeader);
    const idNames = ["skuid", "sku编号", "商品skuid", "商品skuid", "productskuid", "temuskuid"];
    const codeNames = ["sku", "货号", "skucode", "sellsku", "sellersku", "customsku", "自定义sku", "商品货号"];
    const idIndex = normalized.findIndex((name) => idNames.includes(name) || name.includes("skuid"));
    const codeIndex = normalized.findIndex((name) => codeNames.includes(name) || name.includes("货号"));
    if (idIndex < 0 || codeIndex < 0) {
      throw new Error(`找不到必要列。当前表头：${headers.join(", ")}`);
    }
    const map = {};
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const id = String(cells[idIndex] || "").trim();
      const code = String(cells[codeIndex] || "").trim();
      if (id && code) map[id] = code;
    }
    return { map, count: Object.keys(map).length, updatedAt: new Date().toLocaleString() };
  }

  function skuCodesForPackage(pkg, skuMap) {
    const ids = [];
    const codes = [];
    for (const order of pkg.order_send_info_list || []) {
      const candidates = [order.sku_id, order.product_sku_id].filter((value) => value !== undefined && value !== null && value !== "");
      for (const candidate of candidates) {
        const id = String(candidate);
        ids.push(id);
        if (skuMap[id]) codes.push(skuMap[id]);
      }
    }
    const uniqueCodes = Array.from(new Set(codes.map(sanitizeName).filter(Boolean)));
    const uniqueIds = Array.from(new Set(ids.map(sanitizeName).filter(Boolean)));
    if (uniqueCodes.length) return uniqueCodes.join("+");
    return uniqueIds.length ? `sku未匹配-${uniqueIds.join("+")}` : "sku未知";
  }

  function primaryOrderSn(pkg, info) {
    const preferred = pkg.preferred_parent_order_sn || "";
    const fromInfo = Array.isArray(info?.parent_order_sn_list) ? info.parent_order_sn_list[0] : "";
    const fromPkg = pkg.order_send_info_list?.[0]?.parent_order_sn || "";
    return preferred || fromInfo || fromPkg || "订单未知";
  }

  function buildFilename(pkg, info, skuMap) {
    const orderSn = primaryOrderSn(pkg, info);
    const tracking = info?.tracking_number || pkg.tracking_number || "运单未知";
    const sku = skuCodesForPackage(pkg, skuMap);
    return `${sanitizeName(orderSn)}_${sanitizeName(tracking)}_${sanitizeName(sku)}.pdf`;
  }

  function readDownloadLocks() {
    const locks = GM_getValue(DOWNLOAD_LOCK_KEY, {});
    return locks && typeof locks === "object" && !Array.isArray(locks) ? locks : {};
  }

  async function acquireDownloadLock(commandId, filename) {
    const now = Date.now();
    const key = `${commandId || "manual"}::${filename}`;
    const owner = `${CLIENT_ID}_${now}_${Math.random().toString(16).slice(2)}`;
    const locks = readDownloadLocks();
    for (const [lockKey, lock] of Object.entries(locks)) {
      if (!lock?.at || now - lock.at > DOWNLOAD_LOCK_TTL_MS) delete locks[lockKey];
    }
    const existing = locks[key];
    if (existing?.at && now - existing.at <= DOWNLOAD_LOCK_TTL_MS) return false;
    locks[key] = { owner, at: now, host: location.hostname };
    GM_setValue(DOWNLOAD_LOCK_KEY, locks);
    await sleep(40);
    const latest = readDownloadLocks();
    return latest[key]?.owner === owner;
  }

  async function downloadBlob(url, filename) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`下载 PDF 失败 HTTP ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    return blob.size;
  }

  function addFailure(stage, reason, extra = {}) {
    const site = currentSite();
    failureRows.push({
      time: new Date().toISOString(),
      stage,
      reason,
      site: site?.label || location.hostname,
      mallId: extra.mallId || "",
      storeName: extra.storeName || "",
      orderSn: extra.orderSn || "",
      packageSn: extra.packageSn || "",
      tracking: extra.tracking || "",
    });
  }

  async function queryPackages(orderList, store) {
    const first = await apiPost(LIST_PATH, buildListPayload(orderList, 1), store.mallId);
    const total = Number(first.total_count || 0);
    const pages = Math.max(1, Math.ceil(total / 50));
    const all = Array.isArray(first.package_info_result_list) ? first.package_info_result_list.slice() : [];
    for (let page = 2; page <= pages; page += 1) {
      if (aborting) break;
      const data = await apiPost(LIST_PATH, buildListPayload(orderList, page), store.mallId);
      if (Array.isArray(data.package_info_result_list)) all.push(...data.package_info_result_list);
      await sleep(120);
    }
    const seen = new Set();
    return all.filter((pkg) => {
      const key = `${store.mallId}:${pkg.package_sn}`;
      if (!pkg.package_sn || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeReshipPackage(item) {
    const parentOrderSn = String(item?.parentOrderSn || "").trim();
    const orderItems = Array.isArray(item?.reshipTradeTicketItemVOList)
      ? item.reshipTradeTicketItemVOList
      : [];
    return {
      package_sn: String(item?.packageSn || "").trim(),
      tracking_number: String(item?.reshipWayBillSn || "").trim(),
      order_send_info_list: orderItems.length
        ? orderItems.map((orderItem) => ({
          parent_order_sn: parentOrderSn,
          product_sku_id: orderItem?.productSkuId,
        }))
        : [{ parent_order_sn: parentOrderSn }],
      preferred_parent_order_sn: parentOrderSn,
      reship_trade_ticket_sn: String(item?.tradeTicketSn || "").trim(),
    };
  }

  async function queryReshipPackages(orderList, store) {
    const first = await apiPost(RESHIP_LIST_PATH, buildReshipListPayload(orderList, 1), store.mallId);
    const firstPage = first?.mmsPageVO || {};
    const total = Number(firstPage.totalCount || 0);
    const pages = Math.max(1, Math.ceil(total / RESHIP_PAGE_SIZE));
    const all = Array.isArray(firstPage.data) ? firstPage.data.slice() : [];
    for (let page = 2; page <= pages; page += 1) {
      if (aborting) break;
      const data = await apiPost(RESHIP_LIST_PATH, buildReshipListPayload(orderList, page), store.mallId);
      if (Array.isArray(data?.mmsPageVO?.data)) all.push(...data.mmsPageVO.data);
      await sleep(120);
    }
    const seen = new Set();
    const packages = [];
    for (const item of all) {
      const pkg = normalizeReshipPackage(item);
      const orderSn = primaryOrderSn(pkg, null);
      if (!pkg.package_sn) {
        addFailure("查询补寄面单", `补寄单 ${item?.tradeTicketSn || "未知"} 尚无可打印包裹`, {
          mallId: store.mallId,
          storeName: store.name,
          orderSn,
          tracking: pkg.tracking_number,
        });
        continue;
      }
      const key = `${store.mallId}:${pkg.package_sn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      packages.push(pkg);
    }
    return packages;
  }

  async function downloadPackages(packages, store, skuMap, commandId, downloadedNames) {
    const result = await apiPost(PRINT_PATH, {
      package_sn_list: packages.map((pkg) => pkg.package_sn),
      batch_event_type: 2,
      pdf_format: true,
    }, store.mallId);
    const infos = new Map((result.shipping_label_info_list || []).map((item) => [item.package_sn, item]));
    let initiated = 0;
    let skipped = 0;
    for (const pkg of packages) {
      if (aborting) break;
      const info = infos.get(pkg.package_sn) || {};
      const url = info.shipping_label_url || result.shipping_label_url_map?.[pkg.package_sn];
      const filename = buildFilename(pkg, info, skuMap);
      if (downloadedNames.has(filename)) {
        skipped += 1;
        log(`  跳过重复：${filename}`, "warn");
        continue;
      }
      if (!url) {
        addFailure("取 PDF URL", "接口未返回 shipping_label_url", {
          mallId: store.mallId,
          storeName: store.name,
          packageSn: pkg.package_sn,
          orderSn: primaryOrderSn(pkg, info),
          tracking: info.tracking_number || pkg.tracking_number,
        });
        log(`  失败：${pkg.package_sn} 未返回 PDF 地址`, "error");
        continue;
      }
      try {
        const locked = await acquireDownloadLock(commandId, filename);
        if (!locked) {
          skipped += 1;
          downloadedNames.add(filename);
          log(`  跳过重复：${filename}`, "warn");
          continue;
        }
        const size = await downloadBlob(url, filename);
        downloadedNames.add(filename);
        initiated += 1;
        log(`  已按自定义文件名发起下载：${filename} ${(size / 1024).toFixed(1)}KB`, "info");
      } catch (err) {
        addFailure("下载 PDF", readError(err), {
          mallId: store.mallId,
          storeName: store.name,
          packageSn: pkg.package_sn,
          orderSn: primaryOrderSn(pkg, info),
          tracking: info.tracking_number || pkg.tracking_number,
        });
        log(`  失败：${filename} ${readError(err)}`, "error");
      }
      await sleep(DOWNLOAD_GAP_MS);
    }
    return { initiated, skipped };
  }

  function readError(err) {
    return err?.message || String(err);
  }

  async function runCurrentSite(command) {
    if (running) {
      log("已有任务运行中，忽略新指令", "warn");
      return;
    }
    const site = currentSite();
    if (!site) {
      log("当前页面不是支持的 Temu Seller 站点", "warn");
      return;
    }
    const pageKind = command.pageKind === "reship" ? "reship" : "waybill";
    const orderList = parseOrderInput(command.orders || "");
    if (!orderList.length) {
      log("请输入至少一个订单号", "warn");
      return;
    }
    try {
      await loadStores();
    } catch (err) {
      log(`店铺读取失败：${readError(err)}`, "error");
      return;
    }
    const skuMapData = readSkuMap();
    const stores = selectedStores(command.storeIds || []);
    if (!stores.length) {
      log("当前任务没有选中有效店铺", "warn");
      return;
    }
    running = true;
    aborting = false;
    failureRows = [];
    setProgress(0, 1);
    setButtonsBusy(true);
    log(`开始 ${site.label} ${pageKindLabel(pageKind)}，订单 ${orderList.length} 个，店铺 ${stores.length} 个`, "info");
    log(`订单来源：${command.taskLabel || (command.orderSource === "oms-task" ? "OMS 本批任务" : "手工订单号")}`, "info");
    log(`SKU 映射 ${skuMapData.count || 0} 条`, skuMapData.count ? "ok" : "warn");

    let totalPkgs = 0;
    let donePkgs = 0;
    let initiatedPkgs = 0;
    let skippedPkgs = 0;
    const downloadedNames = new Set();
    try {
      const batches = [];
      for (const store of stores) {
        if (aborting) break;
        try {
          log(`查询：${store.name}`, "info");
          const packages = pageKind === "reship"
            ? await queryReshipPackages(orderList, store)
            : await queryPackages(orderList, store);
          totalPkgs += packages.length;
          batches.push({ store, packages });
          log(`${store.name} 查到 ${packages.length} 个包裹`, packages.length ? "ok" : "warn");
        } catch (err) {
          addFailure(pageKind === "reship" ? "查询补寄面单" : "查询面单", readError(err), { mallId: store.mallId, storeName: store.name });
          log(`${store.name} 查询失败：${readError(err)}`, "error");
        }
      }
      setProgress(0, totalPkgs || 1);
      for (const batch of batches) {
        if (aborting || !batch.packages.length) continue;
        log(`取面单：${batch.store.name} ${batch.packages.length} 个`, "info");
        const before = failureRows.length;
        const result = await downloadPackages(batch.packages, batch.store, skuMapData.map || {}, command.id, downloadedNames);
        initiatedPkgs += result.initiated;
        skippedPkgs += result.skipped;
        donePkgs += result.initiated + result.skipped + (failureRows.length - before);
        setProgress(donePkgs, totalPkgs || 1);
      }
      log(`完成：${site.label} 已按自定义文件名发起 ${initiatedPkgs}，跳过重复 ${skippedPkgs}，共查到 ${totalPkgs}`, failureRows.length ? "warn" : "ok");
      if (failureRows.length) log(`失败 ${failureRows.length} 条，可导出失败记录`, "warn");
    } finally {
      running = false;
      aborting = false;
      setButtonsBusy(false);
      updateStats();
    }
  }

  async function sendCommand(action) {
    const orderSource = selectedOrderSource();
    if (!orderSource.orders.length) {
      log("当前没有 OMS 本批任务，请先在 OMS 设置本批任务或填写手工订单号", "warn");
      return;
    }
    try {
      await loadStores();
    } catch (err) {
      log(`店铺读取失败：${readError(err)}`, "error");
      return;
    }
    if (!selectedStoreIds.size) {
      log("请至少选择一个店铺", "warn");
      return;
    }
    const command = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      action,
      targetHost: action === "current" ? location.hostname : "",
      pageKind: currentPageKind(),
      orders: orderSource.orders.join("\n"),
      orderSource: orderSource.type,
      taskId: orderSource.taskId,
      taskLabel: orderSource.label,
      storeIds: [...selectedStoreIds],
      days,
      from: CLIENT_ID,
      at: Date.now(),
    };
    localStorage.setItem(LS_ORDERS, els.orders.value);
    saveStoreIds();
    localStorage.setItem(LS_DAYS, String(days));
    GM_setValue(COMMAND_KEY, command);
    handleCommand(command, false);
    if (action === "all") log(`已发送三站下载指令；来源：${orderSource.label}`, "info");
  }

  function handleCommand(command) {
    if (!command || command.id === lastCommandId) return;
    if (command.action === "current" && command.targetHost && command.targetHost !== location.hostname) return;
    const commandPageKind = command.pageKind === "reship" ? "reship" : "waybill";
    if (commandPageKind !== currentPageKind()) return;
    lastCommandId = command.id;
    if (command.days) {
      days = Number(command.days) || days;
      localStorage.setItem(LS_DAYS, String(days));
      if (els.days) els.days.value = String(days);
    }
    if (command.action === "all" || command.action === "current") {
      void runCurrentSite(command);
    }
  }

  function listenCommands() {
    if (typeof GM_addValueChangeListener !== "function") return;
    GM_addValueChangeListener(COMMAND_KEY, (_name, _oldValue, newValue) => {
      handleCommand(newValue);
    });
  }

  function log(message, level = "info") {
    const prefix = { info: "", ok: "✓ ", warn: "! ", error: "✗ " }[level] || "";
    const line = `${new Date().toLocaleTimeString()} ${prefix}${message}`;
    console.log("[Temu Waybill]", line);
    logs.push(line);
    if (logs.length > 80) logs = logs.slice(-80);
    if (els.status) {
      els.status.textContent = logs.join("\n");
      els.status.scrollTop = els.status.scrollHeight;
    }
  }

  function setProgress(done, total) {
    if (!els.bar) return;
    els.bar.style.width = total ? `${Math.min(100, (done / total) * 100).toFixed(1)}%` : "0%";
  }

  function setButtonsBusy(busy) {
    [els.startCurrent, els.startAll, els.importCsv, els.exportFailed, els.storeCurrent, els.storeAll, els.storeClear].forEach((button) => {
      if (button) button.disabled = busy;
    });
    if (els.storeList) {
      els.storeList.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = busy; });
    }
    if (els.taskSelect) els.taskSelect.disabled = busy || !taskList().length;
    if (els.manualOverride) els.manualOverride.disabled = busy || !activeTask();
    if (els.orders) els.orders.disabled = busy;
    if (els.stop) els.stop.disabled = !busy;
  }

  function updateStats() {
    if (!els.stats) return;
    const skuMap = readSkuMap();
    const site = currentSite();
    const store = currentStore();
    els.stats.innerHTML = `
      <div>当前站点</div><div>${site?.label || location.hostname}</div>
      <div>页面类型</div><div>${pageKindLabel()}</div>
      <div>当前店铺</div><div>${store.name || "-"}</div>
      <div>已选店铺</div><div>${selectedStoreIds.size}/${STORE_CONFIGS.length || 0}</div>
      <div>订单来源</div><div>${escapeHtml(selectedOrderSource().label)}</div>
      <div>SKU映射</div><div>${skuMap.count || 0} 条</div>
      <div>更新时间</div><div>${skuMap.updatedAt || "-"}</div>
    `;
  }

  function exportFailures() {
    if (!failureRows.length) {
      log("没有失败记录可导出", "warn");
      return;
    }
    const fields = ["time", "stage", "reason", "site", "mallId", "storeName", "orderSn", "packageSn", "tracking"];
    const esc = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = `${[fields.join(","), ...failureRows.map((row) => fields.map((field) => esc(row[field])).join(","))].join("\r\n")}\r\n`;
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `temu-waybill-failed-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    log(`已发起失败记录下载：${a.download}`, "info");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function decodeCsvBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = new Uint8Array(bytes.length - 2);
      for (let i = 2; i + 1 < bytes.length; i += 2) { swapped[i - 2] = bytes[i + 1]; swapped[i - 1] = bytes[i]; }
      return new TextDecoder("utf-16le").decode(swapped);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (_) { return new TextDecoder("gb18030").decode(bytes); }
  }

  async function importCsvFile(file) {
    if (!file) return;
    const text = decodeCsvBuffer(await file.arrayBuffer());
    const data = parseCsv(text);
    writeSkuMap(data);
    updateStats();
    log(`已导入 SKU 映射 ${data.count} 条`, "ok");
  }

  function clampPanel() {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - Math.min(rect.width, window.innerWidth));
    const maxY = Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight));
    const left = Math.max(0, Math.min(maxX, rect.left));
    const top = Math.max(0, Math.min(maxY, rect.top));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    localStorage.setItem(LS_POS, JSON.stringify({ left, top }));
  }

  function makeDraggable() {
    const head = panel.querySelector("[data-head]");
    let drag = null;
    let moved = false;
    head.addEventListener("mousedown", (event) => {
      if (event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      moved = false;
      event.preventDefault();
    });
    document.addEventListener("mousemove", (event) => {
      if (!drag) return;
      moved = true;
      const width = panel.offsetWidth || 120;
      const height = panel.offsetHeight || 42;
      const left = Math.max(0, Math.min(window.innerWidth - Math.min(width, window.innerWidth), event.clientX - drag.dx));
      const top = Math.max(0, Math.min(window.innerHeight - Math.min(height, window.innerHeight), event.clientY - drag.dy));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      if (panel.classList.contains("min")) snapPanel(); else clampPanel();
      if (moved) panel.dataset.justDragged = "1";
      setTimeout(() => { panel.dataset.justDragged = ""; }, 120);
    });
  }

  function snapPanel() {
    if (!panel || !panel.classList.contains("min")) return clampPanel();
    const rect = panel.getBoundingClientRect();
    const size = 44;
    let left = Math.max(8, Math.min(window.innerWidth - size - 8, rect.left));
    let top = Math.max(8, Math.min(window.innerHeight - size - 8, rect.top));
    const nearest = [
      ["left", left],
      ["right", window.innerWidth - left - size],
      ["top", top],
      ["bottom", window.innerHeight - top - size],
    ].sort((a, b) => a[1] - b[1])[0][0];
    if (nearest === "left") left = 8;
    if (nearest === "right") left = window.innerWidth - size - 8;
    if (nearest === "top") top = 8;
    if (nearest === "bottom") top = window.innerHeight - size - 8;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    localStorage.setItem(LS_POS, JSON.stringify({ left, top }));
  }

  function renderStoreOptions() {
    if (!els.storeList) return;
    els.storeList.innerHTML = STORE_CONFIGS.length
      ? STORE_CONFIGS.map((store) => `<label><input type="checkbox" value="${escapeHtml(store.mallId)}" ${selectedStoreIds.has(store.mallId) ? "checked" : ""}><span>${escapeHtml(store.name)}</span></label>`).join("")
      : '<div class="tm-store-empty">店铺读取中…</div>';
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <style>
        #${PANEL_ID}{position:fixed;z-index:2147483647;top:84px;right:20px;width:300px;max-height:min(560px,calc(100vh - 16px));background:#fff;border:1px solid #dde2ea;border-radius:14px;box-shadow:0 14px 36px rgba(20,34,58,.16);font-family:-apple-system,BlinkMacSystemFont,"SF Pro","PingFang SC",sans-serif;font-size:12px;color:#1d1d1f;overflow:hidden;user-select:none}
        #${PANEL_ID}.min{width:44px;height:44px;border-radius:50%;background:#303640;border-color:rgba(255,255,255,.9);box-shadow:0 6px 18px rgba(15,23,42,.24),inset 0 0 0 1px rgba(255,255,255,.12);color:#fff}
        #${PANEL_ID}.min::after{content:'';position:absolute;right:2px;bottom:3px;width:7px;height:7px;border:2px solid #303640;border-radius:50%;background:#8b5cf6}
        #${PANEL_ID}.min [data-body]{display:none}
        #${PANEL_ID}.min [data-head]{width:44px;height:44px;padding:0;justify-content:center;border-bottom:none}
        #${PANEL_ID} [data-head]{display:flex;align-items:center;justify-content:space-between;padding:8px 9px 8px 11px;border-bottom:1px solid #e9edf3;cursor:move}
        #${PANEL_ID} .tm-title{font-weight:700;font-size:12px}
        #${PANEL_ID} .tm-title-mini{display:none}
        #${PANEL_ID}.min .tm-title-full{display:none}
        #${PANEL_ID}.min .tm-title-mini{display:inline}
        #${PANEL_ID}.min [data-min]{display:none}
        #${PANEL_ID} .tm-icon{width:20px;height:20px;border:none;border-radius:6px;background:transparent;color:#777;cursor:pointer}
        #${PANEL_ID} .tm-icon:hover{background:rgba(0,0,0,.06);color:#111}
        #${PANEL_ID} [data-body]{padding:8px 9px 9px;max-height:516px;overflow:auto}
        #${PANEL_ID} textarea{width:100%;min-height:52px;resize:vertical;box-sizing:border-box;border:.5px solid rgba(0,0,0,.14);border-radius:8px;padding:7px 8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,.8);outline:none}
        #${PANEL_ID} select{width:100%;box-sizing:border-box;border:1px solid #dfe5ee;border-radius:8px;padding:6px 8px;background:#fff;color:#1d1d1f;font:inherit;outline:none}
        #${PANEL_ID} .tm-task-card{padding:7px;border:1px solid #e5e9ef;border-radius:8px;background:#fbfcfe;margin-bottom:7px}
        #${PANEL_ID} .tm-task-label{font-size:11px;color:#747f91;margin-bottom:4px}
        #${PANEL_ID} .tm-task-info{margin-top:5px;color:#4d596d;font-size:11px;line-height:1.4}
        #${PANEL_ID} .tm-task-info.warn{color:#a55700}
        #${PANEL_ID} .tm-manual{margin-bottom:7px;border:1px solid #e5e9ef;border-radius:8px;padding:5px 7px}
        #${PANEL_ID} .tm-manual summary{cursor:pointer;color:#596579;font-weight:650;font-size:11px}
        #${PANEL_ID} .tm-manual label{display:flex;align-items:center;gap:5px;margin:6px 0;color:#666;font-size:11px}
        #${PANEL_ID} input[type="number"]{width:56px;border:.5px solid rgba(0,0,0,.14);border-radius:7px;padding:5px 6px;font:inherit;background:#fff}
        #${PANEL_ID} .tm-store-tools{display:flex;gap:4px;margin:6px 0 4px}
        #${PANEL_ID} .tm-store-tools button{flex:1;border:0;border-radius:7px;padding:4px;background:#edf0f5;color:#4b5565;font:inherit;font-size:11px;cursor:pointer}
        #${PANEL_ID} .tm-store-list{max-height:88px;overflow:auto;border:1px solid #e5e9ef;border-radius:8px;padding:4px 6px;background:#fbfcfe}
        #${PANEL_ID} .tm-store-list label{display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer}
        #${PANEL_ID} .tm-store-list input{accent-color:#0a84ff}
        #${PANEL_ID} .tm-store-empty{color:#888;font-size:11px}
        #${PANEL_ID} .tm-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:7px 0}
        #${PANEL_ID} .tm-btn{border:none;border-radius:8px;padding:7px 8px;font:inherit;font-weight:700;cursor:pointer}
        #${PANEL_ID} .tm-primary{background:#0a84ff;color:#fff}
        #${PANEL_ID} .tm-secondary{background:#e9e9ed;color:#1d1d1f}
        #${PANEL_ID} .tm-danger{background:rgba(255,59,48,.1);color:#d70015}
        #${PANEL_ID} .tm-btn:disabled{opacity:.55;cursor:not-allowed}
        #${PANEL_ID} button:focus-visible,#${PANEL_ID} textarea:focus-visible,#${PANEL_ID} input:focus-visible,#${PANEL_ID} select:focus-visible,#${PANEL_ID} summary:focus-visible{outline:2px solid rgba(10,132,255,.42);outline-offset:1px}
        #${PANEL_ID} .tm-progress{height:2px;background:rgba(0,0,0,.08);border-radius:2px;overflow:hidden;margin:7px 0}
        #${PANEL_ID} .tm-progress div{height:100%;width:0;background:#0a84ff;transition:width .2s}
        #${PANEL_ID} .tm-stats{display:grid;grid-template-columns:70px 1fr;gap:3px 7px;color:#666;font-size:11px;line-height:1.35;margin:7px 0}
        #${PANEL_ID} .tm-stats div:nth-child(even){font-weight:650;color:#222;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        #${PANEL_ID} .tm-log{height:92px;overflow:auto;white-space:pre-wrap;background:rgba(0,0,0,.035);border:.5px solid rgba(0,0,0,.06);border-radius:8px;padding:7px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#3a3a3c;line-height:1.45}
        #${PANEL_ID} .tm-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0;color:#666}
        #${PANEL_ID} .tm-file{display:none}
        #${PANEL_ID} [hidden]{display:none!important}
        @media (prefers-reduced-motion:reduce){#${PANEL_ID} .tm-progress div{transition:none}}
      </style>
      <div data-head>
        <div class="tm-title"><span class="tm-title-full">面单下载</span><span class="tm-title-mini">下载</span></div>
        <button class="tm-icon" data-min title="收起">−</button>
      </div>
      <div data-body>
        <div class="tm-task-card">
          <div class="tm-task-label">当前 OMS 批次</div>
          <select data-task-select></select>
          <div class="tm-task-info" data-task-info></div>
        </div>
        <details class="tm-manual">
          <summary>手工订单号（可选）</summary>
          <label><input data-manual-override type="checkbox">忽略当前 OMS 批次，使用下方订单号</label>
          <textarea data-orders placeholder="一行或空格分隔多个订单号"></textarea>
        </details>
        <div class="tm-row" data-days-row><span>查询天数</span><input data-days type="number" min="1" max="30" step="1"></div>
        <div class="tm-store-tools"><button type="button" data-store-current>当前</button><button type="button" data-store-all>全选</button><button type="button" data-store-clear>清空</button></div>
        <div class="tm-store-list" data-store-list><div class="tm-store-empty">店铺读取中…</div></div>
        <div class="tm-grid">
          <button class="tm-btn tm-secondary" data-current type="button">当前站下载</button>
          <button class="tm-btn tm-primary" data-all type="button">三站下载</button>
          <button class="tm-btn tm-secondary" data-import type="button">更新SKU CSV</button>
          <button class="tm-btn tm-secondary" data-export type="button">导出失败</button>
        </div>
        <button class="tm-btn tm-danger" data-stop type="button" disabled style="width:100%;margin-bottom:7px;">停止</button>
        <input class="tm-file" data-file type="file" accept=".csv,text/csv">
        <div class="tm-progress"><div data-bar></div></div>
        <div class="tm-stats" data-stats></div>
        <div class="tm-log" data-status>就绪</div>
      </div>
    `;
    document.body.appendChild(panel);

    els = {
      min: panel.querySelector("[data-min]"),
      taskSelect: panel.querySelector("[data-task-select]"),
      taskInfo: panel.querySelector("[data-task-info]"),
      manualOverride: panel.querySelector("[data-manual-override]"),
      orders: panel.querySelector("[data-orders]"),
      days: panel.querySelector("[data-days]"),
      daysRow: panel.querySelector("[data-days-row]"),
      storeList: panel.querySelector("[data-store-list]"),
      storeCurrent: panel.querySelector("[data-store-current]"),
      storeAll: panel.querySelector("[data-store-all]"),
      storeClear: panel.querySelector("[data-store-clear]"),
      startCurrent: panel.querySelector("[data-current]"),
      startAll: panel.querySelector("[data-all]"),
      importCsv: panel.querySelector("[data-import]"),
      exportFailed: panel.querySelector("[data-export]"),
      stop: panel.querySelector("[data-stop]"),
      file: panel.querySelector("[data-file]"),
      bar: panel.querySelector("[data-bar]"),
      stats: panel.querySelector("[data-stats]"),
      status: panel.querySelector("[data-status]"),
    };

    try {
      const pos = JSON.parse(localStorage.getItem(LS_POS) || "null");
      if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
        panel.style.right = "auto";
      }
    } catch (err) {}
    panel.classList.add("min");
    els.min.textContent = panel.classList.contains("min") ? "+" : "−";
    els.min.title = panel.classList.contains("min") ? "展开" : "收起";
    const queryOrderText = currentPageKind() === "reship"
      ? new URLSearchParams(location.search).get("parentOrderSnText") || ""
      : "";
    els.orders.value = queryOrderText || localStorage.getItem(LS_ORDERS) || "";
    els.orders.placeholder = currentPageKind() === "reship"
      ? "一行或空格分隔多个原订单号"
      : "一行或空格分隔多个订单号";
    els.daysRow.hidden = currentPageKind() === "reship";
    if (queryOrderText) localStorage.setItem(LS_ORDERS, queryOrderText);
    els.days.value = String(days);

    makeDraggable();
    renderTaskOptions();
    renderStoreOptions();
    updateStats();
    window.addEventListener("resize", () => panel.classList.contains("min") ? snapPanel() : clampPanel());
    if (panel.classList.contains("min")) setTimeout(snapPanel, 0);

    els.min.addEventListener("click", () => {
      if (panel.dataset.justDragged === "1") return;
      const min = panel.classList.toggle("min");
      localStorage.setItem(LS_MIN, min ? "1" : "0");
      els.min.textContent = min ? "+" : "−";
      els.min.title = min ? "展开" : "收起";
      setTimeout(() => min ? snapPanel() : clampPanel(), 0);
    });
    panel.querySelector("[data-head]").addEventListener("click", (event) => {
      if (!panel.classList.contains("min") || event.target.closest("button") || panel.dataset.justDragged === "1") return;
      panel.classList.remove("min");
      localStorage.setItem(LS_MIN, "0");
      els.min.textContent = "−";
      els.min.title = "收起";
      setTimeout(clampPanel, 0);
    });
    els.orders.addEventListener("input", () => localStorage.setItem(LS_ORDERS, els.orders.value));
    els.taskSelect.addEventListener("change", () => {
      gmSet(OMS_ACTIVE_TASK_KEY, els.taskSelect.value);
      renderTaskOptions();
      updateStats();
      const task = activeTask();
      log(`已切换 OMS 本批任务：${task?.label || els.taskSelect.value}`, "info");
    });
    els.manualOverride.addEventListener("change", () => {
      updateStats();
      log(els.manualOverride.checked ? "本次改用手工订单号" : "本次恢复使用 OMS 本批任务", "info");
    });
    els.days.addEventListener("change", () => {
      days = Math.max(1, Math.min(30, Number(els.days.value || 30)));
      els.days.value = String(days);
      localStorage.setItem(LS_DAYS, String(days));
    });
    els.storeList.addEventListener("change", (event) => {
      const input = event.target.closest('input[type="checkbox"]');
      if (!input) return;
      if (input.checked) selectedStoreIds.add(input.value); else selectedStoreIds.delete(input.value);
      saveStoreIds();
      updateStats();
    });
    els.storeCurrent.addEventListener("click", () => {
      const currentId = currentStore().mallId;
      selectedStoreIds = new Set(currentId ? [currentId] : []);
      saveStoreIds(); renderStoreOptions(); updateStats();
    });
    els.storeAll.addEventListener("click", () => {
      selectedStoreIds = new Set(STORE_CONFIGS.map((store) => store.mallId));
      saveStoreIds(); renderStoreOptions(); updateStats();
    });
    els.storeClear.addEventListener("click", () => {
      selectedStoreIds.clear(); saveStoreIds(); renderStoreOptions(); updateStats();
    });
    els.startCurrent.addEventListener("click", () => void sendCommand("current"));
    els.startAll.addEventListener("click", () => void sendCommand("all"));
    els.importCsv.addEventListener("click", () => els.file.click());
    els.file.addEventListener("change", () => {
      importCsvFile(els.file.files?.[0]).catch((err) => log(`CSV 导入失败：${readError(err)}`, "error"));
      els.file.value = "";
    });
    els.exportFailed.addEventListener("click", exportFailures);
    els.stop.addEventListener("click", () => {
      aborting = true;
      log("收到停止指令，当前请求结束后停止", "warn");
    });
    void loadStores().then(() => log(`店铺已读取：${STORE_CONFIGS.length} 家`, "ok")).catch((err) => log(`店铺读取失败：${readError(err)}`, "error"));
    log(`${pageKindLabel()}面板已加载，请选择店铺后下载`, "ok");
  }

  function init() {
    if (IS_OMS) {
      startOmsBridge();
      return;
    }
    const site = currentSite();
    if (!site) return;
    if (!document.body) {
      setTimeout(init, 120);
      return;
    }
    injectPanel();
    listenCommands();
    listenOmsTaskChanges();
  }

  init();
})();
