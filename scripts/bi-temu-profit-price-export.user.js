// ==UserScript==
// @name         致远BI TEMU利润率价格导出
// @namespace    lucas.bi.temu.profit.price.export
// @version      0.1.1
// @description  动态保留致远 BI TEMU售价参考页全部字段，并按利润率范围导出价格表
// @author       Lucas
// @match        https://bi.zhiyuansys.com/webroot/decision*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/bi-temu-profit-price-export.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/bi-temu-profit-price-export.user.js
// ==/UserScript==

(function () {
  "use strict";

  const CFG = {
    panelId: "__bi_profit_price_panel__",
    dotId: "__bi_profit_price_dot__",
    styleId: "__bi_profit_price_style__",
    storageKey: "__bi_profit_price_export_cfg_v1__",
    requestPath: "/webroot/decision/v5/design/widget/data",
    defaultMinRate: -20,
    defaultMaxRate: 30,
    defaultPlatformRate: 0.09,
    pageGapMs: 80,
    maxPages: 1000,
    adjustedColumn: "调整售价(USD)",
  };

  const state = {
    latestWidgetRequest: null,
    running: false,
    stopRequested: false,
    mounted: false,
    expanded: false,
  };

  function log(...args) {
    console.log("%c[利润价导出]", "color:#2563eb;font-weight:600", ...args);
  }

  function warn(...args) {
    console.warn("%c[利润价导出]", "color:#b45309;font-weight:600", ...args);
  }

  function loadCfg() {
    try {
      return JSON.parse(localStorage.getItem(CFG.storageKey) || "{}") || {};
    } catch {
      return {};
    }
  }

  function saveCfg(patch) {
    localStorage.setItem(CFG.storageKey, JSON.stringify({ ...loadCfg(), ...patch }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getCookie(name) {
    const prefix = `${name}=`;
    return document.cookie
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix))
      ?.slice(prefix.length) || "";
  }

  function toAbsoluteUrl(url) {
    return new URL(String(url || ""), location.origin).href;
  }

  function isWidgetDataUrl(url) {
    try {
      return new URL(String(url || ""), location.origin).pathname === CFG.requestPath;
    } catch {
      return false;
    }
  }

  function normalizeHeaders(headers) {
    const out = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      return out;
    }
    if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => {
        out[String(key).toLowerCase()] = String(value);
      });
      return out;
    }
    Object.entries(headers).forEach(([key, value]) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }

  function rememberWidgetRequest(source, method, url, bodyText, headers) {
    if (String(method || "GET").toUpperCase() !== "POST") return;
    if (!isWidgetDataUrl(url)) return;
    if (!bodyText || typeof bodyText !== "string") return;

    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      warn("请求体不是 JSON，已忽略", err);
      return;
    }

    const headerMap = normalizeHeaders(headers);
    state.latestWidgetRequest = {
      source,
      url: toAbsoluteUrl(url),
      body,
      headers: headerMap,
      capturedAt: Date.now(),
    };
    log("已捕获报表取数请求", state.latestWidgetRequest.url);
    updateCaptureHint();
  }

  function installRequestMonitor() {
    if (window.__biProfitPriceMonitorInstalled) return;
    window.__biProfitPriceMonitorInstalled = true;

    const rawFetch = window.fetch;
    window.fetch = function (input, init = {}) {
      const url = typeof input === "string" ? input : input?.url;
      const method = init.method || input?.method || "GET";
      const body = typeof init.body === "string" ? init.body : "";
      const headers = init.headers || input?.headers || {};
      rememberWidgetRequest("fetch", method, url, body, headers);
      return rawFetch.apply(this, arguments);
    };

    const RawXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const xhr = new RawXHR();
      const headers = {};
      let method = "GET";
      let url = "";

      const rawOpen = xhr.open;
      xhr.open = function (nextMethod, nextUrl) {
        method = nextMethod;
        url = nextUrl;
        return rawOpen.apply(xhr, arguments);
      };

      const rawSetRequestHeader = xhr.setRequestHeader;
      xhr.setRequestHeader = function (key, value) {
        headers[String(key).toLowerCase()] = String(value);
        return rawSetRequestHeader.apply(xhr, arguments);
      };

      const rawSend = xhr.send;
      xhr.send = function (body) {
        rememberWidgetRequest("xhr", method, url, typeof body === "string" ? body : "", headers);
        return rawSend.apply(xhr, arguments);
      };

      return xhr;
    };
  }

  function findCurrentProfitRate(body) {
    const stack = [body];
    const seen = new Set();
    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);

      const name = typeof item.name === "string" ? item.name : "";
      const valueList = item.value && Array.isArray(item.value.value) ? item.value.value : null;
      if (name.includes("调整利率") && valueList && valueList.length) {
        const rate = Number(valueList[0]);
        if (Number.isFinite(rate)) return rate;
      }

      Object.values(item).forEach((value) => {
        if (value && typeof value === "object") stack.push(value);
      });
    }
    return 0.1;
  }

  function findPlatformRate(body) {
    const measures = Array.isArray(body?.measures) ? body.measures : [];
    const target = measures.find((item) =>
      item?.transferName === CFG.adjustedColumn &&
      typeof item?.calculate?.value === "string"
    );
    const formula = target?.calculate?.value || "";
    const match = formula.match(/1\s*-\s*(0?\.\d+)\s*-\s*\$\{/);
    const rate = match ? Number(match[1]) : CFG.defaultPlatformRate;
    return Number.isFinite(rate) ? rate : CFG.defaultPlatformRate;
  }

  function findReferencePriceColumns(body) {
    const measures = Array.isArray(body?.measures) ? body.measures : [];
    return measures
      .map((item) => {
        const name = String(item?.transferName || "").trim();
        const formula = typeof item?.calculate?.value === "string" ? item.calculate.value : "";
        if (!name || name === CFG.adjustedColumn || !formula) return null;
        const match = formula.match(/\/\s*\(\s*1\s*-\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*-/);
        const rate = match ? Number(match[1]) : NaN;
        if (!Number.isFinite(rate) || rate < 0 || rate >= 1) return null;
        return { name, rate };
      })
      .filter(Boolean);
  }

  function clampNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function buildRateList(minRate, maxRate) {
    const start = Math.trunc(minRate);
    const end = Math.trunc(maxRate);
    if (start > end) throw new Error("利润率下限不能大于上限。");
    if (end - start > 200) throw new Error("利润率范围太大，请控制在 200 个整数以内。");
    const rates = [];
    for (let rate = start; rate <= end; rate += 1) rates.push(rate);
    return rates;
  }

  function getRequestHeaders(body, capturedHeaders) {
    const token = getCookie("fine_auth_token");
    const sessionId = body?.queryInfo?.sessionId || capturedHeaders.sessionid || "";
    const headers = {
      "content-type": "application/json;charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      "fine-sw-tag": "traceWorkType=config",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers.sessionid = sessionId;
    return headers;
  }

  async function fetchPage(page) {
    const latest = state.latestWidgetRequest;
    if (!latest) {
      throw new Error("还没有捕获到报表取数请求，请刷新页面或点击一次查询后再导出。");
    }

    const body = cloneJson(latest.body);
    body.page = page;
    body.realData = true;
    body.allData = true;

    const res = await fetch(latest.url, {
      method: "POST",
      credentials: "include",
      headers: getRequestHeaders(body, latest.headers || {}),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`第 ${page} 页请求失败：HTTP ${res.status} ${text.slice(0, 120)}`);
    }

    const json = await res.json();
    if (!json?.success) {
      throw new Error(`第 ${page} 页返回失败：${json?.message || json?.errorMsg || "未知错误"}`);
    }

    return json.data || {};
  }

  function cellText(cell) {
    if (!cell) return "";
    if (cell.text != null) return String(cell.text);
    if (cell.formatText != null) return String(cell.formatText);
    if (cell.value != null) return String(cell.value);
    return "";
  }

  function cellValue(cell) {
    if (!cell) return "";
    if (cell.value != null) return String(cell.value);
    if (cell.text != null) return String(cell.text);
    if (cell.formatText != null) return String(cell.formatText);
    return "";
  }

  function parseNumberText(value) {
    const cleaned = String(value ?? "").replace(/,/g, "").trim();
    if (!cleaned) return NaN;
    return Number(cleaned);
  }

  function round2(value) {
    if (!Number.isFinite(value)) return "";
    return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
  }

  function pageFromData(data) {
    const headers = (data.header || []).map((item, index) => {
      const name = String(item?.text ?? item?.formatText ?? item?.name ?? "").trim();
      return name || `未命名字段${index + 1}`;
    });
    if (!headers.length) throw new Error("接口返回缺少表头。");
    if (!headers.includes(CFG.adjustedColumn)) {
      throw new Error(`接口返回缺少计价字段：${CFG.adjustedColumn}`);
    }

    const rows = (data.items || []).map((row) => ({
      displayValues: headers.map((_, index) => cellText(row[index])),
      rawValues: headers.map((_, index) => cellValue(row[index])),
    }));
    return { headers, rows };
  }

  function sameHeaders(left, right) {
    return left.length === right.length && left.every((name, index) => name === right[index]);
  }

  async function fetchAllRows(setStatus) {
    const rows = [];
    let headers = null;
    let page = 1;
    let total = 0;
    let completed = false;
    while (page <= CFG.maxPages) {
      if (state.stopRequested) throw new Error("已停止。");
      setStatus(`读取第 ${page} 页...`);
      const data = await fetchPage(page);
      if (page === 1) total = Number(data.row || 0);
      const pageData = pageFromData(data);
      if (!headers) {
        headers = pageData.headers;
      } else if (!sameHeaders(headers, pageData.headers)) {
        throw new Error(`第 ${page} 页表头与第 1 页不一致，已停止以避免字段错位。`);
      }
      rows.push(...pageData.rows);
      setStatus(`已读取 ${rows.length}${total ? ` / ${total}` : ""} 行`);
      if (!data.hasNext) {
        completed = true;
        break;
      }
      page += 1;
      await sleep(CFG.pageGapMs);
    }
    if (!completed) {
      throw new Error(`数据超过 ${CFG.maxPages} 页，本次已停止，不导出不完整结果。`);
    }
    if (total && rows.length !== total) {
      throw new Error(`总行数校验失败：报表声明 ${total} 行，实际读取 ${rows.length} 行。`);
    }
    return { headers: headers || [], rows, total };
  }

  function median(values) {
    if (!values.length) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function derivePricingBasis(row, sourceHeaders, currentRate, referenceColumns) {
    const adjustedIndex = sourceHeaders.indexOf(CFG.adjustedColumn);
    const adjustedPrice = parseNumberText(row.rawValues[adjustedIndex] ?? row.displayValues[adjustedIndex]);
    if (!Number.isFinite(adjustedPrice)) return null;

    const candidates = referenceColumns
      .map((reference) => {
        const index = sourceHeaders.indexOf(reference.name);
        const price = index >= 0
          ? parseNumberText(row.rawValues[index] ?? row.displayValues[index])
          : NaN;
        return { ...reference, price };
      })
      .filter((reference) =>
        Number.isFinite(reference.price) &&
        Math.abs(reference.rate - currentRate) > 1e-9 &&
        Math.abs(reference.price - adjustedPrice) > 1e-9
      )
      .sort((left, right) =>
        Math.abs(right.rate - currentRate) - Math.abs(left.rate - currentRate)
      );

    for (const reference of candidates) {
      const deductionRate = (
        adjustedPrice * (1 - currentRate) -
        reference.price * (1 - reference.rate)
      ) / (adjustedPrice - reference.price);
      const baseCost = adjustedPrice * (1 - currentRate - deductionRate);
      if (
        Number.isFinite(deductionRate) &&
        deductionRate >= 0 &&
        deductionRate < 1 &&
        Number.isFinite(baseCost) &&
        baseCost >= 0
      ) {
        return { baseCost, deductionRate };
      }
    }
    return null;
  }

  function buildExportRows(rawData, rates, currentRate, fallbackPlatformRate, referenceColumns) {
    const sourceHeaders = rawData.headers;
    const outputHeaders = [
      ...sourceHeaders,
      ...rates.map((rate) => `${rate}%利润售价(USD)`),
    ];
    const directBases = rawData.rows.map((row) =>
      derivePricingBasis(row, sourceHeaders, currentRate, referenceColumns)
    );
    const derivedDeductionRate = median(
      directBases.filter(Boolean).map((basis) => basis.deductionRate)
    );
    const fallbackDeductionRate = Number.isFinite(derivedDeductionRate)
      ? derivedDeductionRate
      : fallbackPlatformRate;
    let fallbackRows = 0;

    const outputRows = rawData.rows.map((row, rowIndex) => {
      let basis = directBases[rowIndex];
      if (!basis) {
        fallbackRows += 1;
        const adjustedIndex = sourceHeaders.indexOf(CFG.adjustedColumn);
        const adjustedPrice = parseNumberText(
          row.rawValues[adjustedIndex] ?? row.displayValues[adjustedIndex]
        );
        basis = {
          baseCost: adjustedPrice * (1 - fallbackDeductionRate - currentRate),
          deductionRate: fallbackDeductionRate,
        };
      }

      const output = [...row.displayValues];
      rates.forEach((rate) => {
        const profitRate = rate / 100;
        const denominator = 1 - basis.deductionRate - profitRate;
        output.push(denominator > 0 ? round2(basis.baseCost / denominator) : "");
      });
      return output;
    });

    return {
      headers: outputHeaders,
      rows: outputRows,
      sourceColumnCount: sourceHeaders.length,
      derivedRows: rawData.rows.length - fallbackRows,
      fallbackRows,
      fallbackDeductionRate,
    };
  }

  function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function localDateStamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function downloadCsv(headers, rows, minRate, maxRate) {
    const content = [
      headers.map(csvCell).join(","),
      ...rows.map((row) => row.map(csvCell).join(",")),
    ].join("\r\n") + "\r\n";
    const filename = `TEMU利润价格_利润段${minRate}%至${maxRate}%_采集日期${localDateStamp()}.csv`;
    const blob = new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return filename;
  }

  function injectStyle() {
    if (document.getElementById(CFG.styleId)) return;
    const style = document.createElement("style");
    style.id = CFG.styleId;
    style.textContent = `
      #${CFG.dotId}, #${CFG.panelId} {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif;
        color: #1d1d1f;
        letter-spacing: 0;
        box-sizing: border-box;
      }
      #${CFG.dotId} {
        position: fixed;
        z-index: 2147483647;
        width: 54px;
        height: 54px;
        border-radius: 999px;
        border: 1px solid rgba(37, 99, 235, 0.28);
        background: rgba(37, 99, 235, 0.92);
        color: #fff;
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.12);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.05;
        cursor: move;
        user-select: none;
      }
      #${CFG.panelId} {
        position: fixed;
        z-index: 2147483647;
        width: 276px;
        border-radius: 12px;
        overflow: hidden;
        background: rgba(248, 250, 252, 0.88);
        -webkit-backdrop-filter: saturate(180%) blur(22px);
        backdrop-filter: saturate(180%) blur(22px);
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.08);
        font-size: 12px;
        user-select: none;
      }
      .bi-price-head {
        height: 38px;
        padding: 0 10px 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: move;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(255, 255, 255, 0.34);
      }
      .bi-price-title {
        font-size: 13px;
        font-weight: 700;
      }
      .bi-price-close {
        width: 24px;
        height: 24px;
        border: 0;
        border-radius: 50%;
        background: rgba(100, 116, 139, 0.12);
        color: #475569;
        cursor: pointer;
        font-size: 16px;
        line-height: 22px;
      }
      .bi-price-body {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .bi-price-row {
        display: grid;
        grid-template-columns: 1fr 86px;
        gap: 8px;
        align-items: center;
      }
      .bi-price-row label {
        color: #334155;
        font-size: 12px;
      }
      .bi-price-row input {
        width: 86px;
        height: 28px;
        border-radius: 7px;
        border: 1px solid rgba(148, 163, 184, 0.34);
        background: rgba(255,255,255,0.84);
        color: #0f172a;
        padding: 0 8px;
        outline: none;
        font-size: 12px;
      }
      .bi-price-row input:focus {
        border-color: rgba(37, 99, 235, 0.62);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
      }
      .bi-price-actions {
        display: grid;
        grid-template-columns: 1fr 74px;
        gap: 8px;
      }
      .bi-price-btn {
        height: 30px;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        font-family: inherit;
        font-size: 12px;
        font-weight: 650;
        cursor: pointer;
      }
      .bi-price-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .bi-price-primary {
        background: #2563eb;
        color: #fff;
        border-color: #2563eb;
      }
      .bi-price-secondary {
        background: rgba(255,255,255,0.72);
        color: #475569;
      }
      .bi-price-status {
        min-height: 32px;
        padding: 8px;
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.05);
        color: #475569;
        line-height: 1.35;
        word-break: break-word;
      }
      .bi-price-hint {
        color: #64748b;
        font-size: 11px;
        line-height: 1.35;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function clampPos(left, top, element) {
    const width = element.offsetWidth || 60;
    const height = element.offsetHeight || 60;
    return {
      left: Math.min(Math.max(6, left), Math.max(6, window.innerWidth - width - 6)),
      top: Math.min(Math.max(6, top), Math.max(6, window.innerHeight - height - 6)),
    };
  }

  function applyPosition(element, pos, fallback) {
    const next = pos && Number.isFinite(pos.left) && Number.isFinite(pos.top) ? pos : fallback;
    const clamped = clampPos(next.left, next.top, element);
    element.style.left = `${clamped.left}px`;
    element.style.top = `${clamped.top}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
  }

  function makeDraggable(element, handle, key, onClickWithoutDrag) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = element.offsetLeft;
      startTop = element.offsetTop;
      event.preventDefault();
    });

    document.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const pos = clampPos(startLeft + dx, startTop + dy, element);
      element.style.left = `${pos.left}px`;
      element.style.top = `${pos.top}px`;
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      saveCfg({ [key]: { left: element.offsetLeft, top: element.offsetTop } });
      setTimeout(() => {
        moved = false;
      }, 0);
    });

    if (onClickWithoutDrag) {
      handle.addEventListener("click", (event) => {
        if (moved) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClickWithoutDrag();
      });
    }
  }

  function updateCaptureHint() {
    const el = document.querySelector(".bi-price-capture");
    if (!el) return;
    if (state.latestWidgetRequest) {
      const date = new Date(state.latestWidgetRequest.capturedAt);
      el.textContent = `已捕获 ${date.toLocaleTimeString()}`;
    } else {
      el.textContent = "等待报表请求";
    }
  }

  function setStatus(text) {
    const el = document.querySelector(".bi-price-status");
    if (el) el.textContent = text;
  }

  function setRunningUI(running) {
    document.querySelectorAll(".bi-price-input").forEach((input) => {
      input.disabled = running;
    });
    const exportBtn = document.querySelector(".bi-price-export");
    const stopBtn = document.querySelector(".bi-price-stop");
    if (exportBtn) exportBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  async function handleExport() {
    if (state.running) return;
    const minInput = document.querySelector(".bi-price-min");
    const maxInput = document.querySelector(".bi-price-max");
    const minRate = clampNumber(minInput?.value, CFG.defaultMinRate);
    const maxRate = clampNumber(maxInput?.value, CFG.defaultMaxRate);
    const rates = buildRateList(minRate, maxRate);

    saveCfg({ minRate, maxRate });
    state.running = true;
    state.stopRequested = false;
    setRunningUI(true);

    try {
      if (!state.latestWidgetRequest) {
        throw new Error("还没有捕获到报表请求。请刷新页面，或在报表里点击一次查询后再点导出。");
      }
      const currentRate = findCurrentProfitRate(state.latestWidgetRequest.body);
      const platformRate = findPlatformRate(state.latestWidgetRequest.body);
      const referenceColumns = findReferencePriceColumns(state.latestWidgetRequest.body);
      setStatus(`准备导出 ${rates.length} 个利润率列...`);

      const rawData = await fetchAllRows(setStatus);
      const exportData = buildExportRows(
        rawData,
        rates,
        currentRate,
        platformRate,
        referenceColumns
      );
      const filename = downloadCsv(
        exportData.headers,
        exportData.rows,
        rates[0],
        rates[rates.length - 1]
      );
      setStatus(
        `已读取 ${rawData.rows.length} 行、${exportData.sourceColumnCount} 个源字段，` +
        `已发起下载：${filename}` +
        (exportData.fallbackRows
          ? `（${exportData.fallbackRows} 行使用兼容扣除率）`
          : "")
      );
    } catch (err) {
      setStatus(err?.message || String(err));
      warn(err);
    } finally {
      state.running = false;
      state.stopRequested = false;
      setRunningUI(false);
    }
  }

  function mountUI() {
    if (state.mounted || !document.body) return;
    state.mounted = true;
    injectStyle();

    const cfg = loadCfg();
    state.expanded = false;

    const dot = document.createElement("div");
    dot.id = CFG.dotId;
    dot.textContent = "利润价";
    document.body.appendChild(dot);
    applyPosition(dot, cfg.dotPos, { left: window.innerWidth - 72, top: 180 });
    makeDraggable(dot, dot, "dotPos", () => {
      state.expanded = true;
      dot.style.display = "none";
      panel.style.display = "block";
      applyPosition(panel, loadCfg().panelPos, { left: window.innerWidth - 306, top: 180 });
    });

    const panel = document.createElement("div");
    panel.id = CFG.panelId;
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="bi-price-head">
        <div class="bi-price-title">利润价格导出</div>
        <button class="bi-price-close" type="button" title="收起">-</button>
      </div>
      <div class="bi-price-body">
        <div class="bi-price-row">
          <label>利润率下限(%)</label>
          <input class="bi-price-input bi-price-min" type="number" step="1" value="${cfg.minRate ?? CFG.defaultMinRate}">
        </div>
        <div class="bi-price-row">
          <label>利润率上限(%)</label>
          <input class="bi-price-input bi-price-max" type="number" step="1" value="${cfg.maxRate ?? CFG.defaultMaxRate}">
        </div>
        <div class="bi-price-actions">
          <button class="bi-price-btn bi-price-primary bi-price-export" type="button">导出</button>
          <button class="bi-price-btn bi-price-secondary bi-price-stop" type="button" disabled>停止</button>
        </div>
        <div class="bi-price-status">就绪</div>
        <div class="bi-price-hint bi-price-capture">等待报表请求</div>
        <div class="bi-price-hint">保留当前报表全部字段，并追加利润段售价。</div>
      </div>
    `;
    document.body.appendChild(panel);
    applyPosition(panel, cfg.panelPos, { left: window.innerWidth - 306, top: 180 });
    makeDraggable(panel, panel.querySelector(".bi-price-head"), "panelPos");

    panel.querySelector(".bi-price-close").addEventListener("click", () => {
      state.expanded = false;
      panel.style.display = "none";
      dot.style.display = "flex";
      applyPosition(dot, loadCfg().dotPos, { left: window.innerWidth - 72, top: 180 });
    });

    panel.querySelector(".bi-price-export").addEventListener("click", () => {
      handleExport();
    });

    panel.querySelector(".bi-price-stop").addEventListener("click", () => {
      state.stopRequested = true;
      setStatus("正在停止...");
    });

    window.addEventListener("resize", () => {
      applyPosition(dot, { left: dot.offsetLeft, top: dot.offsetTop }, { left: window.innerWidth - 72, top: 180 });
      applyPosition(panel, { left: panel.offsetLeft, top: panel.offsetTop }, { left: window.innerWidth - 306, top: 180 });
      saveCfg({
        dotPos: { left: dot.offsetLeft, top: dot.offsetTop },
        panelPos: { left: panel.offsetLeft, top: panel.offsetTop },
      });
    });

    updateCaptureHint();
  }

  installRequestMonitor();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountUI);
  } else {
    mountUI();
  }
})();
