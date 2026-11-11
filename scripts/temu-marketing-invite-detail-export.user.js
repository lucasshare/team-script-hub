// ==UserScript==
// @name         Temu 活动采集与精确退出
// @namespace    https://agentseller.temu.com/
// @version      0.1.23
// @description  支持按 SPU 前置筛选并按动态店铺、活动与站点采集活动列表、活动邀约和报名明细，或按 CSV 精确退出指定活动
// @author       Lucas
// @match        https://agentseller.temu.com/activity/marketing-activity*
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_info
// @grant        GM_download
// @updateURL    https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-marketing-invite-detail-export.meta.js
// @downloadURL  https://raw.githubusercontent.com/lucasshare/team-script-hub/main/scripts/temu-marketing-invite-detail-export.user.js
// ==/UserScript==

(function () {
  "use strict";

  const PAGE_WIN = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const SCRIPT_VERSION =
    typeof GM_info !== "undefined" && GM_info?.script?.version
      ? GM_info.script.version
      : "0.1.23";

  const API_USER_INFO = "/api/seller/auth/userInfo";
  const API_INVITE_LIST =
    "/api/kiana/gamblers/marketing/enroll/invite/inviteActivityList";
  const API_INVITE_PRODUCTS =
    "/api/kiana/gamblers/marketing/enroll/invite/scrollMatchSemi";
  const API_ACTIVITY_DETAIL =
    "/api/kiana/gamblers/marketing/enroll/activity/detail";
  const API_MAIN_ACTIVITY_LIST =
    "/api/kiana/gamblers/marketing/enroll/activity/list";
  const API_MAIN_ACTIVITY_PRODUCTS =
    "/api/kiana/gamblers/marketing/enroll/semi/scroll/match";
  const API_ENROLL_LIST = "/api/kiana/gamblers/marketing/enroll/list";
  const API_CANCEL_ENROLL = "/api/kiana/gamblers/marketing/enroll/cancel";

  const POSITION_KEY = "tm_marketing_invite_export_position_v1";
  const COLLAPSED_KEY = "tm_marketing_invite_export_collapsed_v1";
  const SELECTED_STORES_KEY = "tm_marketing_invite_export_selected_stores_v1";
  const MAIN_ACTIVITY_SITE_PRESETS_KEY =
    "tm_marketing_activity_page_export_site_presets_v1";
  const PAGE_SIZE = 50;
  const REQUEST_GAP_MS = 350;
  const ENROLL_REQUEST_GAP_MS = 2000;
  const RATE_LIMIT_BACKOFF_MS = 5000;
  const REQUEST_TIMEOUT_MS = 30000;
  const MAX_RETRIES = 3;
  const ENROLL_MAX_RETRIES = 5;
  const MAX_PAGES_PER_ACTIVITY = 500;
  const MAIN_ACTIVITY_REQUEST_GAP_MS = 2000;
  const MAIN_ACTIVITY_MAX_NORMAL_RETRIES = 3;
  const MAIN_ACTIVITY_MAX_RATE_LIMIT_RETRIES = 12;
  const MAIN_ACTIVITY_RATE_LIMIT_WAIT_STEP_MS = 5000;
  const MAIN_ACTIVITY_RATE_LIMIT_WAIT_MAX_MS = 60000;
  const MAIN_ACTIVITY_PRODUCT_BATCH_SIZE = 50;
  const MAX_ACTIVITY_DETAIL_PAGES = 10000;
  const ACTIVITY_DETAIL_ROWS_PER_SHEET = 900000;
  const ENROLL_PRODUCT_BATCH_SIZE = 50;
  const ENROLL_PAGE_SIZE = 50;
  const CANCEL_BATCH_SIZE = 20;
  const DOWNLOAD_TIMEOUT_MS = 60000;
  const DOWNLOAD_URL_REVOKE_DELAY_MS = 60000;
  const DEFAULT_CANCEL_REASON = "亏损";
  const DISPLAY_TIME_ZONE = "Asia/Shanghai";
  const CANCEL_LOOKUP_STATUSES = [1, 2];
  const OVERLAP_SESSION_STATUSES = [1, 2];
  const ACTIVITY_STATUS_OPTIONS = [
    { value: 1, label: "未开始", defaultSelected: true },
    { value: 2, label: "进行中", defaultSelected: true },
    { value: 3, label: "已结束", defaultSelected: false },
    { value: 4, label: "已退出", defaultSelected: false },
  ];

  const STORE_NAME_ALIASES = new Map([
    ["lichuan home", "lichuan home essentials"],
  ]);

  const HEADERS = [
    "邀约活动名称",
    "店铺信息",
    "采集状态",
    "活动专题ID",
    "活动类型ID",
    "活动类型",
    "规则叠加结论",
    "规则叠加说明",
    "活动开始时间",
    "活动结束时间",
    "报名截止时间",
    "活动周期天数",
    "申报折扣门槛",
    "邀约商品数",
    "可邀约商品数",
    "已报名商品数",
    "商品ID",
    "商品名称",
    "商品大区",
    "可经营站点",
    "报名站点",
    "报名站点ID",
    "商品销售库存",
    "目标活动库存",
    "建议活动库存",
    "可报名场次数",
    "已报名场次ID",
    "建议报名场次ID",
    "图片",
    "SKC ID",
    "SKC货号",
    "SKC属性",
    "SKU ID",
    "SKU货号",
    "SKU属性",
    "币种",
    "日常申报价",
    "日常申报价原始值",
    "建议活动折扣",
    "建议活动价",
    "建议活动价原始值",
    "原始建议活动价",
    "是否必须权益",
    "是否低销标签",
    "失败备注",
  ];

  const TEMPLATE_HEADERS = [
    "活动类型(活动主题）",
    "SPU ID",
    "SKC ID",
    "SKC货号",
    "SKU ID",
    "SKU货号",
    "颜色属性",
    "尺码属性",
    "站点",
    "活动申报价格",
    "币种",
    "日常参考价",
    "规则叠加结论",
    "规则叠加说明",
    "重叠活动最低申报价",
    "是否需要叠加",
    "叠加后预计最低结算价",
    "决策参考价",
    "叠加活动名称",
    "叠加活动场次",
    "叠加活动剩余库存",
    "价格计算说明",
  ];

  const ACTIVITY_DETAIL_HEADERS = [
    "店铺信息",
    "活动状态",
    "活动类型ID",
    "活动类型",
    "活动专题ID",
    "活动专题",
    "SPU ID",
    "SKC ID",
    "SKC货号",
    "SKU ID",
    "SKU货号",
    "SKU属性",
    "站点",
    "站点ID",
    "日常申报价",
    "活动申报价格",
    "活动折扣",
    "币种",
    "场次ID",
    "场次名称",
    "场次开始时间",
    "场次结束时间",
    "活动库存",
    "剩余活动库存",
    "报名ID",
  ];

  const ACTIVITY_TEMPLATE_HEADERS = [
    "活动类型(活动主题）",
    "SPU ID",
    "SKC ID",
    "SKC货号",
    "SKU ID",
    "SKU货号",
    "颜色属性",
    "尺码属性",
    "站点",
    "活动申报价格",
    "币种",
    "店铺",
  ];

  const MAIN_ACTIVITY_PRICE_HEADERS = [
    "活动类型(活动主题）",
    "SPU ID",
    "SKC ID",
    "SKC货号",
    "SKU ID",
    "SKU货号",
    "颜色属性",
    "尺码属性",
    "站点",
    "活动申报价格",
    "币种",
    "店铺名称",
  ];

  const MAIN_ACTIVITY_STOCK_HEADERS = [
    "活动类型(活动主题）",
    "SPU ID",
    "活动库存",
  ];

  const MAIN_ACTIVITY_LOG_HEADERS = [
    "时间",
    "级别",
    "店铺名称",
    "活动类型(活动主题）",
    "任务状态",
    "需采集SPU数",
    "数量口径",
    "页面实际返回SPU数",
    "筛选后实际采集SPU数",
    "完成页数",
    "失败页码",
    "候选池待扫描",
    "价格行数",
    "库存行数",
    "页码",
    "日志内容",
  ];

  const CANCEL_CSV_HEADERS = [
    "店铺",
    "SPU ID",
    "活动类型(活动主题）",
    "活动申报价格",
  ];
  const CANCEL_RESULT_HEADERS = [
    "CSV源行",
    "店铺",
    "SPU ID",
    "活动类型(活动主题）",
    "CSV活动申报价格",
    "报名记录活动申报价格",
    "报名ID",
    "活动场次",
    "核对状态",
    "执行状态",
    "失败原因",
  ];

  let running = false;
  let paused = false;
  let stopRequested = false;
  let currentController = null;
  let lastRequestAt = 0;
  let rows = [];
  let templateRows = [];
  let activityDetailRows = [];
  let failedActivities = [];
  let priceLookupFailures = [];
  let activityDetailFailures = [];
  let cancelCsvRows = [];
  let cancelPreviewRows = [];
  let cancelExecutionRows = [];
  let cancelResultRows = [];
  let cancelResultsAutoDownloaded = false;
  let cancelLookupFailures = [];
  let runningMode = "";
  let stores = [];
  let loadedInviteJobs = [];
  let loadedInviteGroups = [];
  let loadedStoreSignature = "";
  let loadingSelections = false;
  let loadingMainActivities = false;
  let loadedMainActivitySignature = "";
  let loadedMainActivityJobs = [];
  let failedMainActivityStoreLoads = [];
  let mainActivityPriceRows = [];
  let mainActivityStockRows = [];
  let mainActivityLogRows = [];
  let mainActivityProblemKeys = new Set();
  let mainActivityFailures = [];
  let mainActivityMissingPriceCount = 0;
  let mainActivityMissingStockCount = 0;
  let panelRefs = null;

  class StopError extends Error {
    constructor(message = "任务已停止") {
      super(message);
      this.name = "StopError";
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function toText(value) {
    return value == null ? "" : String(value).trim();
  }

  function activityDisplayName(activity) {
    return (
      toText(activity?.activityThematicName) ||
      toText(activity?.activityName) ||
      (activity?.activityType != null ? `活动类型 ${activity.activityType}` : "未命名活动")
    );
  }

  function activityStackingRule(activity) {
    const activityType = Number(activity?.activityType);
    if (activityType === 51) {
      return {
        conclusion: "明确会叠加",
        tone: "stack",
        description:
          "跨店满减规则明确：以成交时日常申报价或其他生效官方活动申报价二者较低者为基数，再乘跨店满减活动申报价折扣；会与同时生效的其他官方活动价格叠加。",
      };
    }
    if (activityType === 53) {
      return {
        conclusion: "存在额外优惠层",
        tone: "extra",
        description:
          "促销活动加补规则明确存在动态优惠券层，会在活动申报价格基础上产生额外优惠；接口未返回券额、费用承担方及完整互斥关系。",
      };
    }
    return {
      conclusion: "规则未明确",
      tone: "unknown",
      description:
        "当前活动规则未明确声明与其他已有活动叠加或互斥；不能据此认定会叠加，也不进行价格连乘。",
    };
  }

  function activitySelectionKey(activity) {
    return `${normalizedId(activity?.activityType)}|${normalizedId(
      activity?.activityThematicId
    )}`;
  }

  function formatDateMinute(value) {
    const text = formatDateTime(value);
    return text ? text.slice(0, 16) : "时间未返回";
  }

  function activitySelectionLabel(activity) {
    const duration = Number(activity?.durationDays);
    const durationText =
      Number.isFinite(duration) && duration > 0 ? `持续 ${duration} 天` : "持续时间未返回";
    return `${activityDisplayName(activity)}｜${durationText}｜${formatDateMinute(
      activity?.activityStartTime
    )} → ${formatDateMinute(activity?.activityEndTime)}`;
  }

  function listText(value) {
    if (!Array.isArray(value)) return toText(value);
    return value.map(toText).filter(Boolean).join("、");
  }

  function idListText(value) {
    if (!Array.isArray(value)) return toText(value);
    return value
      .map((item) => (item && typeof item === "object" ? item.sessionId ?? item.id : item))
      .map(toText)
      .filter(Boolean)
      .join("、");
  }

  function propertiesText(value) {
    if (!value || typeof value !== "object") return "";
    return Object.entries(value)
      .map(([key, item]) => {
        const name = toText(key);
        const content = Array.isArray(item) ? listText(item) : toText(item);
        if (!name) return content;
        return content ? `${name}：${content}` : name;
      })
      .filter(Boolean)
      .join("；");
  }

  function propertyValue(properties, keywords) {
    if (!properties || typeof properties !== "object") return "";
    const targets = keywords.map((keyword) => keyword.toLowerCase());
    for (const [key, value] of Object.entries(properties)) {
      const normalizedKey = toText(key).toLowerCase().replace(/\s+/g, "");
      if (!targets.some((target) => normalizedKey === target || normalizedKey.includes(target))) {
        continue;
      }
      return Array.isArray(value) ? listText(value) : toText(value);
    }
    return "";
  }

  function centsToPrice(value) {
    if (value == null || value === "") return "";
    const number = Number(value);
    return Number.isFinite(number) ? (number / 100).toFixed(2) : "";
  }

  function centsToNumber(value) {
    if (value == null || value === "") return "";
    const number = Number(value);
    return Number.isFinite(number) ? number / 100 : "";
  }

  function firstFiniteNumber(...values) {
    for (const value of values) {
      if (value == null || value === "") continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function resolveDiscountRaw(activity, skc, sku) {
    return firstFiniteNumber(
      sku?.suggestActivityDiscount,
      skc?.suggestActivityDiscount,
      activity?.discountThreshold
    );
  }

  function resolveReferencePriceRaw(activity, skc, sku) {
    const directPrice = firstFiniteNumber(
      sku?.suggestActivityPrice,
      skc?.suggestActivityPrice,
      sku?.rawSuggestActivityPrice,
      skc?.rawSuggestActivityPrice
    );
    if (directPrice != null) return directPrice;

    const dailyPrice = firstFiniteNumber(sku?.dailyPrice, skc?.dailyPrice);
    const discount = resolveDiscountRaw(activity, skc, sku);
    if (dailyPrice == null || discount == null || discount <= 0 || discount > 100) return null;

    return Math.round((dailyPrice * discount) / 100);
  }

  function chunkList(list, size) {
    const output = [];
    for (let index = 0; index < list.length; index += size) {
      output.push(list.slice(index, index + size));
    }
    return output;
  }

  function normalizedId(value) {
    return value == null || value === "" ? "" : String(value);
  }

  function parseSpuIds(value) {
    const tokens = toText(value)
      .split(/[\s,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const invalid = tokens.filter((item) => !/^\d+$/.test(item));
    if (invalid.length) {
      throw new Error(`SPU ID 只能包含数字：${invalid.slice(0, 3).join("、")}`);
    }
    return [...new Set(tokens)];
  }

  function normalizeMatchText(value) {
    return toText(value)
      .replace(/^\uFEFF/, "")
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function resolveStoreInput(value) {
    const normalized = normalizeMatchText(value);
    const aliasTarget = STORE_NAME_ALIASES.get(normalized) || normalized;
    return stores.find(
      (store) =>
        normalizeMatchText(store.name) === aliasTarget ||
        normalizeMatchText(store.mallId) === normalized ||
        (Array.isArray(store.aliases) &&
          store.aliases.some((alias) => normalizeMatchText(alias) === normalized))
    );
  }

  function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    const source = String(text || "").replace(/^\uFEFF/, "");

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (char === '"') {
        if (quoted && source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === "," && !quoted) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        row.push(field);
        field = "";
        if (row.some((value) => toText(value))) rows.push(row);
        row = [];
        if (char === "\r" && source[index + 1] === "\n") index += 1;
      } else {
        field += char;
      }
    }
    if (quoted) throw new Error("CSV 存在未闭合的双引号");
    row.push(field);
    if (row.some((value) => toText(value))) rows.push(row);
    return rows;
  }

  function decodeCsvBytes(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const decode = (encoding, offset = 0) =>
      new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));

    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: decode("utf-8", 3), encoding: "UTF-8 BOM" };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: decode("utf-16le", 2), encoding: "UTF-16LE" };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: decode("utf-16be", 2), encoding: "UTF-16BE" };
    }

    const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4096);
    if (sampleLength >= 4) {
      let evenZeroCount = 0;
      let oddZeroCount = 0;
      for (let index = 0; index < sampleLength; index += 2) {
        if (bytes[index] === 0) evenZeroCount += 1;
        if (bytes[index + 1] === 0) oddZeroCount += 1;
      }
      const pairCount = sampleLength / 2;
      if (oddZeroCount / pairCount >= 0.3 && evenZeroCount / pairCount <= 0.05) {
        return { text: decode("utf-16le"), encoding: "UTF-16LE（无 BOM）" };
      }
      if (evenZeroCount / pairCount >= 0.3 && oddZeroCount / pairCount <= 0.05) {
        return { text: decode("utf-16be"), encoding: "UTF-16BE（无 BOM）" };
      }
    }

    try {
      return { text: decode("utf-8"), encoding: "UTF-8" };
    } catch (utf8Error) {
      try {
        return { text: decode("gb18030"), encoding: "GB18030 / GBK" };
      } catch (gb18030Error) {
        throw new Error(
          "无法识别 CSV 编码；请在 Excel 中另存为“CSV UTF-8（逗号分隔）”后重试"
        );
      }
    }
  }

  async function readCsvFile(file) {
    return decodeCsvBytes(await file.arrayBuffer());
  }

  function findHeaderIndex(headers, aliases) {
    const normalizedAliases = new Set(aliases.map(normalizeMatchText));
    return headers.findIndex((header) => normalizedAliases.has(normalizeMatchText(header)));
  }

  function parseActivityPriceRaw(value) {
    const text = toText(value).replace(/^'+/, "");
    if (!text) return null;
    const normalized = text.replace(/^[￥¥$€£]\s*/, "").replace(/,/g, "");
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
    const [wholePart, decimalPart = ""] = normalized.split(".");
    const raw = Number(wholePart) * 100 + Number(decimalPart.padEnd(2, "0"));
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }

  function uniqueActivityPriceRaws(values) {
    return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))].sort(
      (left, right) => left - right
    );
  }

  function formatActivityPriceRaws(values) {
    return uniqueActivityPriceRaws(values).map(centsToPrice).join("、");
  }

  function parseCancelCsv(text) {
    const matrix = parseCsvText(text);
    if (matrix.length < 2) throw new Error("CSV 只有表头或没有数据行");
    const headers = matrix[0];
    const storeIndex = findHeaderIndex(headers, ["店铺", "店铺名称", "店铺信息", "store"]);
    const spuIndex = findHeaderIndex(headers, ["SPU ID", "SPUID", "商品ID"]);
    const activityIndex = findHeaderIndex(headers, [
      "活动类型(活动主题）",
      "活动类型(活动主题)",
      "活动主题",
      "活动专题",
      "邀约活动名称",
    ]);
    const enrollIndex = findHeaderIndex(headers, ["报名ID", "enrollId"]);
    const activityPriceIndex = findHeaderIndex(headers, [
      "活动申报价格",
      "活动价格",
      "activityPrice",
    ]);
    if (storeIndex < 0 || spuIndex < 0 || (activityIndex < 0 && enrollIndex < 0)) {
      throw new Error(
        "CSV 至少需要“店铺、SPU ID、活动类型(活动主题）”；也可用“报名ID”代替活动主题"
      );
    }

    const parsedRows = [];
    const rowByKey = new Map();
    let duplicateCount = 0;
    for (let index = 1; index < matrix.length; index += 1) {
      const sourceRow = matrix[index];
      const storeText = toText(sourceRow[storeIndex]);
      const store = resolveStoreInput(storeText);
      const productId = toText(sourceRow[spuIndex]).replace(/^'+/, "");
      const activityText = activityIndex >= 0 ? toText(sourceRow[activityIndex]) : "";
      const enrollId = enrollIndex >= 0 ? toText(sourceRow[enrollIndex]).replace(/^'+/, "") : "";
      const activityPriceText =
        activityPriceIndex >= 0 ? toText(sourceRow[activityPriceIndex]) : "";
      const activityPriceRaw = parseActivityPriceRaw(activityPriceText);
      let validationError = "";
      if (!storeText) validationError = "店铺为空";
      else if (!store) validationError = `未知店铺：${storeText}`;
      else if (!/^\d+$/.test(productId)) validationError = "SPU ID 为空或不是数字";
      else if (!activityText && !/^\d+$/.test(enrollId)) {
        validationError = "活动主题与报名ID不能同时为空";
      }
      const key = [
        store?.mallId || storeText,
        productId,
        normalizeMatchText(activityText),
        enrollId,
      ].join("|");
      const existing = rowByKey.get(key);
      if (existing) {
        duplicateCount += 1;
        if (activityPriceRaw != null) {
          existing.activityPriceRaws = uniqueActivityPriceRaws([
            ...existing.activityPriceRaws,
            activityPriceRaw,
          ]);
        }
        if (activityPriceText && activityPriceRaw == null) {
          existing.activityPriceWarnings = [
            ...new Set([
              ...existing.activityPriceWarnings,
              `无法识别活动申报价格：${activityPriceText}`,
            ]),
          ];
        }
        continue;
      }
      const parsedRow = {
        sourceLine: index + 1,
        store,
        storeText,
        productId,
        activityText,
        enrollId,
        activityPriceRaws: activityPriceRaw == null ? [] : [activityPriceRaw],
        activityPriceWarnings:
          activityPriceText && activityPriceRaw == null
            ? [`无法识别活动申报价格：${activityPriceText}`]
            : [],
        validationError,
      };
      rowByKey.set(key, parsedRow);
      parsedRows.push(parsedRow);
    }
    if (!parsedRows.length) throw new Error("CSV 没有可读取的数据行");
    return { rows: parsedRows, duplicateCount };
  }

  function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function downloadErrorMessage(error) {
    const code = toText(error?.error);
    const details = toText(error?.details);
    const labels = {
      not_enabled: "Tampermonkey 下载功能未启用",
      not_whitelisted: "CSV 文件扩展名未获 Tampermonkey 允许",
      not_permitted: "Tampermonkey 没有浏览器下载权限",
      not_supported: "当前浏览器或 Tampermonkey 版本不支持扩展下载",
      not_succeeded: "浏览器未能启动下载",
    };
    return [labels[code] || code || readableError(error), details].filter(Boolean).join("：");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);

    if (typeof GM_download === "function") {
      return new Promise((resolve, reject) => {
        let settled = false;
        const releaseUrl = () => {
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        };
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          releaseUrl();
          callback(value);
        };
        const timeoutId = setTimeout(() => {
          finish(reject, new Error(`下载等待超过 ${DOWNLOAD_TIMEOUT_MS / 1000} 秒`));
        }, DOWNLOAD_TIMEOUT_MS);

        try {
          GM_download({
            url,
            name: filename,
            saveAs: false,
            conflictAction: "uniquify",
            onload: () => finish(resolve, "tampermonkey"),
            onerror: (error) => finish(reject, new Error(downloadErrorMessage(error))),
            ontimeout: (error) => finish(reject, new Error(downloadErrorMessage(error))),
          });
        } catch (error) {
          finish(reject, new Error(downloadErrorMessage(error)));
        }
      });
    }

    return new Promise((resolve, reject) => {
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
        resolve("browser");
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    });
  }

  async function downloadCsvRows(dataRows, headers, filename) {
    const lines = [
      headers.map(csvCell).join(","),
      ...dataRows.map((row) => headers.map((header) => csvCell(row?.[header])).join(",")),
    ];
    const blob = new Blob(["\uFEFF", `${lines.join("\r\n")}\r\n`], {
      type: "text/csv;charset=utf-8",
    });
    return downloadBlob(blob, filename);
  }

  async function downloadCancelTemplate() {
    return downloadCsvRows([], CANCEL_CSV_HEADERS, "Temu活动退出模板.csv");
  }

  async function downloadCancelResults() {
    if (!cancelResultRows.length) throw new Error("当前没有可下载的退出结果");
    return downloadCsvRows(
      cancelResultRows,
      CANCEL_RESULT_HEADERS,
      `Temu批量退出结果_${timestampForFile()}.csv`
    );
  }

  async function autoDownloadCancelResults() {
    cancelResultsAutoDownloaded = false;
    if (!cancelResultRows.length) return false;
    try {
      await downloadCancelResults();
      cancelResultsAutoDownloaded = true;
      appendLog(`已自动下载退出结果：${cancelResultRows.length} 条`, "success");
      return true;
    } catch (error) {
      appendLog(`退出结果自动下载失败，可点击“下载退出结果”重试：${readableError(error)}`, "error");
      return false;
    }
  }

  function apiProductId(value) {
    const text = normalizedId(value);
    const number = Number(text);
    return Number.isSafeInteger(number) && number > 0 ? number : text;
  }

  function activityStatusLabel(value) {
    const number = Number(value);
    return ACTIVITY_STATUS_OPTIONS.find((option) => option.value === number)?.label || toText(value);
  }

  function registeredActivityText(record) {
    const thematicId = normalizedId(record?.activityThematicId);
    const thematicName = toText(record?.activityThematicName);
    if (thematicId && thematicId !== "0") {
      return `${thematicId}-专题活动-${thematicName}`;
    }
    const activityType = normalizedId(record?.activityType);
    const activityTypeName = toText(record?.activityTypeName);
    return activityType ? `${activityType}-长期活动-${activityTypeName}` : activityTypeName;
  }

  function siteKey(siteId, siteName) {
    const id = normalizedId(siteId);
    return id ? `id:${id}` : `name:${toText(siteName).toLowerCase()}`;
  }

  function toTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function timeRangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
    const starts = [toTimestamp(leftStart), toTimestamp(rightStart)];
    const ends = [toTimestamp(leftEnd), toTimestamp(rightEnd)];
    if (starts.includes(null) || ends.includes(null)) return false;
    return Math.max(...starts) <= Math.min(...ends);
  }

  function uniqueText(values) {
    return [...new Set(values.map(toText).filter(Boolean))].join("、");
  }

  function pickHeaders(row, headers) {
    return Object.fromEntries(headers.map((header) => [header, row?.[header] ?? ""]));
  }

  function discountText(value) {
    if (value == null || value === "") return "";
    const number = Number(value);
    if (!Number.isFinite(number)) return toText(value);
    return `${(number / 10).toFixed(number % 10 === 0 ? 0 : 1)}折`;
  }

  function yesNo(value) {
    if (value == null) return "";
    return value ? "是" : "否";
  }

  function formatDateTime(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "";
    const date = new Date(number);
    if (Number.isNaN(date.getTime())) return "";
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: DISPLAY_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function timestampForFile() {
    const date = new Date();
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate()
    )}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  }

  function autosizeSheet(sheet, dataRows, headers) {
    sheet["!cols"] = headers.map((header) => {
      const maxLength = dataRows.reduce((width, row) => {
        const value = row[header] == null ? "" : String(row[header]);
        return Math.max(width, value.length);
      }, header.length);
      const upperLimit = header.includes("说明")
        ? 64
        : header.includes("名称") || header.includes("备注")
        ? 42
        : 24;
      return { wch: Math.min(Math.max(maxLength + 2, 11), upperLimit) };
    });
    if (sheet["!ref"]) sheet["!autofilter"] = { ref: sheet["!ref"] };
  }

  function forceIdentifierText(xlsx, sheet, headers, rowCount, identifierHeaders) {
    for (const header of identifierHeaders) {
      const columnIndex = headers.indexOf(header);
      if (columnIndex < 0) continue;
      for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
        const address = xlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
        const cell = sheet[address];
        if (!cell || cell.v == null || cell.v === "") continue;
        cell.t = "s";
        cell.v = String(cell.v);
        delete cell.w;
      }
    }
  }

  function setNumberFormat(xlsx, sheet, headers, rowCount, header, format) {
    const columnIndex = headers.indexOf(header);
    if (columnIndex < 0) return;
    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const address = xlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = sheet[address];
      if (cell && cell.t === "n") cell.z = format;
    }
  }

  function downloadWorkbook(dataRows, compactRows, partial = false) {
    if (!dataRows.length) throw new Error("当前没有可下载的邀约数据");
    const xlsx = typeof XLSX !== "undefined" ? XLSX : PAGE_WIN.XLSX;
    if (!xlsx) throw new Error("Excel 组件未加载，请刷新页面后重试");

    const fullExportRows = dataRows.map((row) => pickHeaders(row, HEADERS));
    const compactExportRows = compactRows.map((row) => pickHeaders(row, TEMPLATE_HEADERS));
    const fullSheet = xlsx.utils.json_to_sheet(fullExportRows, { header: HEADERS });
    const compactSheet = xlsx.utils.json_to_sheet(compactExportRows, {
      header: TEMPLATE_HEADERS,
    });
    autosizeSheet(fullSheet, fullExportRows, HEADERS);
    autosizeSheet(compactSheet, compactExportRows, TEMPLATE_HEADERS);
    forceIdentifierText(xlsx, fullSheet, HEADERS, dataRows.length, [
      "活动专题ID",
      "商品ID",
      "报名站点ID",
      "已报名场次ID",
      "建议报名场次ID",
      "SKC ID",
      "SKC货号",
      "SKU ID",
      "SKU货号",
    ]);
    forceIdentifierText(xlsx, compactSheet, TEMPLATE_HEADERS, compactRows.length, [
      "SPU ID",
      "SKC ID",
      "SKC货号",
      "SKU ID",
      "SKU货号",
    ]);
    for (const header of ["活动申报价格", "日常参考价"]) {
      setNumberFormat(
        xlsx,
        compactSheet,
        TEMPLATE_HEADERS,
        compactRows.length,
        header,
        "0.00"
      );
    }
    for (const header of [
      "重叠活动最低申报价",
      "叠加后预计最低结算价",
      "决策参考价",
    ]) {
      setNumberFormat(xlsx, compactSheet, TEMPLATE_HEADERS, compactRows.length, header, "0.00");
    }

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, fullSheet, "邀约完整明细");
    xlsx.utils.book_append_sheet(workbook, compactSheet, "活动提报明细");
    xlsx.writeFile(
      workbook,
      `Temu活动邀约详情_${partial ? "部分结果_" : ""}${timestampForFile()}.xlsx`,
      { compression: true }
    );
  }

  function downloadActivityDetailWorkbook(detailRows, partial = false) {
    if (!detailRows.length) throw new Error("当前没有可下载的活动明细");
    const xlsx = typeof XLSX !== "undefined" ? XLSX : PAGE_WIN.XLSX;
    if (!xlsx) throw new Error("Excel 组件未加载，请刷新页面后重试");

    const workbook = xlsx.utils.book_new();
    for (
      let startIndex = 0, sheetIndex = 1;
      startIndex < detailRows.length;
      startIndex += ACTIVITY_DETAIL_ROWS_PER_SHEET, sheetIndex += 1
    ) {
      const partRows = detailRows.slice(
        startIndex,
        startIndex + ACTIVITY_DETAIL_ROWS_PER_SHEET
      );
      const exportRows = partRows.map((row) => pickHeaders(row, ACTIVITY_DETAIL_HEADERS));
      const sheet = xlsx.utils.json_to_sheet(exportRows, { header: ACTIVITY_DETAIL_HEADERS });
      autosizeSheet(sheet, exportRows, ACTIVITY_DETAIL_HEADERS);
      forceIdentifierText(xlsx, sheet, ACTIVITY_DETAIL_HEADERS, partRows.length, [
        "活动专题ID",
        "SPU ID",
        "SKC ID",
        "SKC货号",
        "SKU ID",
        "SKU货号",
        "站点ID",
        "场次ID",
        "报名ID",
      ]);
      for (const header of ["日常申报价", "活动申报价格"]) {
        setNumberFormat(xlsx, sheet, ACTIVITY_DETAIL_HEADERS, partRows.length, header, "0.00");
      }
      xlsx.utils.book_append_sheet(
        workbook,
        sheet,
        sheetIndex === 1 ? "活动明细" : `活动明细${sheetIndex}`
      );
    }

    const templateRows = buildActivityTemplateRows(detailRows);
    for (
      let startIndex = 0, sheetIndex = 1;
      startIndex < templateRows.length;
      startIndex += ACTIVITY_DETAIL_ROWS_PER_SHEET, sheetIndex += 1
    ) {
      const partRows = templateRows.slice(
        startIndex,
        startIndex + ACTIVITY_DETAIL_ROWS_PER_SHEET
      );
      const exportRows = partRows.map((row) => pickHeaders(row, ACTIVITY_TEMPLATE_HEADERS));
      const sheet = xlsx.utils.json_to_sheet(exportRows, { header: ACTIVITY_TEMPLATE_HEADERS });
      autosizeSheet(sheet, exportRows, ACTIVITY_TEMPLATE_HEADERS);
      forceIdentifierText(xlsx, sheet, ACTIVITY_TEMPLATE_HEADERS, partRows.length, [
        "SPU ID",
        "SKC ID",
        "SKC货号",
        "SKU ID",
        "SKU货号",
      ]);
      setNumberFormat(
        xlsx,
        sheet,
        ACTIVITY_TEMPLATE_HEADERS,
        partRows.length,
        "活动申报价格",
        "0.00"
      );
      xlsx.utils.book_append_sheet(
        workbook,
        sheet,
        sheetIndex === 1 ? "活动提报明细" : `活动提报明细${sheetIndex}`
      );
    }
    xlsx.writeFile(
      workbook,
      `Temu活动明细_${partial ? "部分结果_" : ""}${timestampForFile()}.xlsx`,
      { compression: true }
    );
  }

  async function waitUntilRunnable() {
    while (paused && !stopRequested) await sleep(150);
    if (stopRequested) throw new StopError();
  }

  async function waitRequestGap(gapMs = REQUEST_GAP_MS) {
    await waitUntilRunnable();
    const waitMs = Math.max(0, gapMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    await waitUntilRunnable();
    lastRequestAt = Date.now();
  }

  function readableError(error) {
    if (error instanceof StopError) return error.message;
    if (error?.name === "AbortError") {
      return stopRequested ? "任务已停止" : "请求超时";
    }
    return error instanceof Error ? error.message : String(error);
  }

  function isRateLimitError(error) {
    return /\b429\b|操作太快|请求过于频繁|network\s*timeout|please\s*try\s*again\s*later|too\s*fast|rate\s*limit/i.test(
      readableError(error)
    );
  }

  async function fetchMallList() {
    const response = await PAGE_WIN.fetch(API_USER_INFO, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `店铺列表返回无法解析：${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok || data.success === false) {
      throw new Error(
        data.errorMsg ||
          data.error_msg ||
          data.message ||
          `店铺列表读取失败 ${response.status}`
      );
    }
    const mallList = Array.isArray(data.result?.mallList) ? data.result.mallList : [];
    return mallList
      .map((mall) => ({
        mallId: normalizedId(mall?.mallId),
        name: toText(mall?.mallName) || `店铺 ${normalizedId(mall?.mallId)}`,
      }))
      .filter((mall) => mall.mallId);
  }

  async function postJson(store, path, payload) {
    await waitRequestGap(path === API_ENROLL_LIST ? ENROLL_REQUEST_GAP_MS : REQUEST_GAP_MS);
    const controller = new PAGE_WIN.AbortController();
    currentController = controller;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await PAGE_WIN.fetch(path, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          mallid: String(store.mallId),
        },
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `返回内容无法解析：${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (!response.ok || data.success === false) {
        const message =
          data.errorMsg || data.error_msg || data.message || response.statusText || "读取失败";
        throw new Error(`${response.status} ${message}`);
      }
      return data.result || data.res || data;
    } finally {
      clearTimeout(timeoutId);
      if (currentController === controller) currentController = null;
    }
  }

  async function requestWithRetry(store, path, payload, label) {
    let lastError = null;
    const maxAttempts = path === API_ENROLL_LIST ? ENROLL_MAX_RETRIES : MAX_RETRIES;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await waitUntilRunnable();
      try {
        return await postJson(store, path, payload);
      } catch (error) {
        if (stopRequested || error instanceof StopError) throw new StopError();
        lastError = error;
        const rateLimited = isRateLimitError(error);
        const retryWaitMs = rateLimited ? RATE_LIMIT_BACKOFF_MS * attempt : attempt * 700;
        appendLog(
          `${label}失败（${attempt}/${maxAttempts}）：${readableError(error)}${
            rateLimited && attempt < maxAttempts
              ? `；触发限流，等待 ${retryWaitMs / 1000} 秒后重试`
              : ""
          }`,
          "error"
        );
        if (attempt < maxAttempts) await sleep(retryWaitMs);
      }
    }
    throw lastError || new Error(`${label}失败`);
  }

  async function fetchInviteActivities(store) {
    const result = await requestWithRetry(
      store,
      API_INVITE_LIST,
      {},
      `${store.name} 读取活动邀约列表`
    );
    const list = Array.isArray(result.inviteActivityVOS) ? result.inviteActivityVOS : [];
    if (!list.length) throw new Error("当前页面没有可采集的活动邀约");
    return list;
  }

  async function fetchInviteActivitySites(store, activity) {
    const result = await requestWithRetry(
      store,
      API_ACTIVITY_DETAIL,
      {
        activityType: activity.activityType,
        activityThematicId: activity.activityThematicId,
      },
      `${store.name} · ${activityDisplayName(activity)} · 读取站点`
    );
    const thematicSites = Array.isArray(result?.thematicInfo?.sites)
      ? result.thematicInfo.sites
      : [];
    const activitySites = Array.isArray(result?.activityInfo?.sites)
      ? result.activityInfo.sites
      : [];
    const siteMap = new Map();
    for (const site of [...thematicSites, ...activitySites]) {
      const siteName = toText(site?.siteName);
      if (siteName && !siteMap.has(siteName)) siteMap.set(siteName, site);
    }
    return [...siteMap.values()];
  }

  async function fetchActivityProductList(
    store,
    activity,
    activityIndex,
    activityTotal,
    path,
    listKey,
    listLabel
  ) {
    const products = [];
    let searchScrollContext = "";
    let hasMore = true;
    let pageNo = 0;
    const seenContexts = new Set();

    while (hasMore) {
      await waitUntilRunnable();
      pageNo += 1;
      if (pageNo > MAX_PAGES_PER_ACTIVITY) {
        throw new Error(`分页超过 ${MAX_PAGES_PER_ACTIVITY} 页，已停止该活动以避免死循环`);
      }

      setStatus(
        `${store.name} · 活动 ${activityIndex}/${activityTotal} · ${listLabel}第 ${pageNo} 页 · 已读取 ${products.length} 个商品`,
        "busy"
      );
      const payload = {
        activityType: activity.activityType,
        activityThematicId: activity.activityThematicId,
        rowCount: PAGE_SIZE,
        addSite: true,
      };
      if (searchScrollContext) payload.searchScrollContext = searchScrollContext;

      const result = await requestWithRetry(
        store,
        path,
        payload,
        `${store.name} · ${activityDisplayName(activity)} · ${listLabel}第 ${pageNo} 页`
      );
      const list = Array.isArray(result[listKey]) ? result[listKey] : [];
      products.push(...list);
      hasMore = result.hasMore === true;

      if (hasMore) {
        const nextContext = toText(result.searchScrollContext);
        if (!nextContext) throw new Error("分页仍有更多商品，但没有返回下一页游标");
        if (seenContexts.has(nextContext)) throw new Error("分页游标重复，已停止该活动以避免死循环");
        seenContexts.add(nextContext);
        searchScrollContext = nextContext;
      }

      appendLog(
        `${store.name} · 活动 ${activityIndex}/${activityTotal} · ${listLabel}第 ${pageNo} 页：返回 ${list.length} 个商品，剩余 ${
          Number.isFinite(Number(result.stillCount)) ? Number(result.stillCount) : "-"
        }`
      );
    }

    return products;
  }

  async function fetchActivityProducts(store, activity, activityIndex, activityTotal) {
    return fetchActivityProductList(
      store,
      activity,
      activityIndex,
      activityTotal,
      API_INVITE_PRODUCTS,
      "matchList",
      "可报名商品"
    );
  }

  function registeredActivityKey(record) {
    const enrollId = normalizedId(record?.enrollId);
    if (enrollId) return `enroll:${enrollId}`;
    return [
      normalizedId(record?.productId),
      normalizedId(record?.activityType),
      normalizedId(record?.activityThematicId),
    ].join("|");
  }

  async function fetchExistingActivityRecords(
    store,
    productIds,
    sessionStatuses = OVERLAP_SESSION_STATUSES,
    failureSink = priceLookupFailures
  ) {
    const recordMap = new Map();
    const failedProductIds = new Set();
    const failedStatusesByProductId = new Map();
    const uniqueProducts = new Map();
    for (const productId of productIds) {
      const key = normalizedId(productId);
      if (key && !uniqueProducts.has(key)) uniqueProducts.set(key, productId);
    }
    const batches = chunkList([...uniqueProducts.values()], ENROLL_PRODUCT_BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      for (const sessionStatus of sessionStatuses) {
        let pageNo = 1;
        let loaded = 0;
        while (true) {
          await waitUntilRunnable();
          setStatus(
            `${store.name} · 核对现有活动 ${batchIndex + 1}/${batches.length} · 状态 ${sessionStatus} · 第 ${pageNo} 页`,
            "busy"
          );

          let result;
          try {
            result = await requestWithRetry(
              store,
              API_ENROLL_LIST,
              {
                pageNo,
                pageSize: ENROLL_PAGE_SIZE,
                productIds: batch,
                sessionStatus,
              },
              `${store.name} 核对现有活动（状态 ${sessionStatus}，第 ${pageNo} 页）`
            );
          } catch (error) {
            if (stopRequested || error instanceof StopError) throw new StopError();
            batch.forEach((productId) => failedProductIds.add(normalizedId(productId)));
            batch.forEach((productId) => {
              const key = normalizedId(productId);
              if (!failedStatusesByProductId.has(key)) {
                failedStatusesByProductId.set(key, new Set());
              }
              failedStatusesByProductId.get(key).add(Number(sessionStatus));
            });
            failureSink.push({
              store: store.name,
              productIds: batch.map(normalizedId),
              sessionStatus,
              error: readableError(error),
            });
            appendLog(
              `${store.name} 现有活动核对失败，本批决策价留空：${readableError(error)}`,
              "error"
            );
            break;
          }

          const list = Array.isArray(result?.list) ? result.list : [];
          const total = Number(result?.total);
          loaded += list.length;
          for (const record of list) {
            const key = registeredActivityKey(record);
            const existing = recordMap.get(key);
            if (!existing) {
              recordMap.set(key, record);
              continue;
            }
            recordMap.set(key, {
              ...existing,
              assignSessionList: [
                ...(Array.isArray(existing.assignSessionList) ? existing.assignSessionList : []),
                ...(Array.isArray(record.assignSessionList) ? record.assignSessionList : []),
              ],
              skcList:
                Array.isArray(existing.skcList) && existing.skcList.length
                  ? existing.skcList
                  : record.skcList,
            });
          }

          appendLog(
            `${store.name} · 现有活动状态 ${sessionStatus} · 第 ${pageNo} 页：返回 ${list.length} 条`
          );
          if (!list.length || (Number.isFinite(total) && loaded >= total)) break;
          if (!Number.isFinite(total) && list.length < ENROLL_PAGE_SIZE) break;
          pageNo += 1;
          if (pageNo > MAX_PAGES_PER_ACTIVITY) {
            throw new Error(`现有活动分页超过 ${MAX_PAGES_PER_ACTIVITY} 页，已停止以避免死循环`);
          }
        }
      }
    }

    return { records: [...recordMap.values()], failedProductIds, failedStatusesByProductId };
  }

  function cancelActivityDescriptors(record) {
    return new Set(
      [
        registeredActivityText(record),
        record?.activityThematicName,
        record?.activityTypeName,
        record?.activityThematicId,
      ]
        .map(normalizeMatchText)
        .filter(Boolean)
    );
  }

  function cancelRecordActivityPriceRaws(record) {
    const prices = [];
    const skcList = Array.isArray(record?.skcList) ? record.skcList : [];
    for (const skc of skcList) {
      const skuList = Array.isArray(skc?.skuList) ? skc.skuList : [];
      for (const sku of skuList) {
        const sitePriceList = Array.isArray(sku?.sitePriceList) ? sku.sitePriceList : [];
        for (const sitePrice of sitePriceList) {
          const raw = Number(sitePrice?.activityPrice);
          if (Number.isSafeInteger(raw) && raw > 0) prices.push(raw);
        }
      }
    }
    return uniqueActivityPriceRaws(prices);
  }

  function activityPriceSetsEqual(leftValues, rightValues) {
    const left = uniqueActivityPriceRaws(leftValues);
    const right = uniqueActivityPriceRaws(rightValues);
    return (
      left.length > 0 &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  function cancelSessionText(record) {
    return uniqueText(
      (Array.isArray(record?.assignSessionList) ? record.assignSessionList : []).map(
        (session) => session?.sessionName
      )
    );
  }

  function cancelResultRow(item, executeStatus = "未执行", failureReason = "") {
    return {
      "CSV源行": item.sourceLine,
      "店铺": item.store?.name || item.storeText,
      "SPU ID": item.productId,
      "活动类型(活动主题）": item.record
        ? registeredActivityText(item.record)
        : item.activityText,
      "CSV活动申报价格": formatActivityPriceRaws(item.activityPriceRaws || []),
      "报名记录活动申报价格": item.record
        ? formatActivityPriceRaws(cancelRecordActivityPriceRaws(item.record))
        : item.candidateActivityPriceText || "",
      "报名ID": item.record ? toText(item.record.enrollId) : item.enrollId,
      "活动场次": item.record ? cancelSessionText(item.record) : "",
      "核对状态": item.previewStatus || "",
      "执行状态": executeStatus,
      "失败原因": failureReason || item.previewMessage || "",
    };
  }

  function renderCancelPreview() {
    if (!panelRefs?.cancelPreview) return;
    const blockingRows = cancelPreviewRows.filter((row) => row.blocking);
    const duplicateRows = cancelPreviewRows.filter((row) => row.previewStatus === "重复报名ID");
    const lines = [
      `CSV ${cancelCsvRows.length} 条；可退出 ${cancelExecutionRows.length} 个活动；重复合并 ${duplicateRows.length} 条；将跳过 ${blockingRows.length} 条。`,
      ...cancelPreviewRows.slice(0, 8).map((row) => {
        const mark = row.blocking ? "⚠" : row.previewStatus === "重复报名ID" ? "↳" : "✓";
        return `${mark} ${row.store?.name || row.storeText}｜SPU ${row.productId || "-"}｜${
          row.record ? registeredActivityText(row.record) : row.activityText || "-"
        }${row.previewMessage ? `｜${row.previewMessage}` : ""}`;
      }),
    ];
    if (cancelPreviewRows.length > 8) lines.push(`…另有 ${cancelPreviewRows.length - 8} 条`);
    panelRefs.cancelPreview.textContent = lines.join("\n");
    panelRefs.cancelPreview.dataset.type = blockingRows.length ? "error" : "success";
    renderControlState();
  }

  async function runCancelPreflight() {
    if (!cancelCsvRows.length) throw new Error("请先选择 CSV 文件");
    cancelPreviewRows = [];
    cancelExecutionRows = [];
    cancelResultRows = [];
    cancelResultsAutoDownloaded = false;
    cancelLookupFailures = [];
    const rowsByStore = new Map();
    for (const row of cancelCsvRows) {
      if (row.validationError || !row.store) continue;
      if (!rowsByStore.has(row.store.mallId)) rowsByStore.set(row.store.mallId, []);
      rowsByStore.get(row.store.mallId).push(row);
    }

    const lookupByStore = new Map();
    for (const store of stores) {
      const storeRows = rowsByStore.get(store.mallId) || [];
      if (!storeRows.length) continue;
      const productIds = [...new Set(storeRows.map((row) => apiProductId(row.productId)))];
      appendLog(`${store.name}：核对 CSV 中 ${productIds.length} 个 SPU 的具体活动`);
      const lookup = await fetchExistingActivityRecords(
        store,
        productIds,
        CANCEL_LOOKUP_STATUSES,
        cancelLookupFailures
      );
      lookupByStore.set(store.mallId, lookup);
    }

    const selectedEnrollIds = new Set();
    for (const row of cancelCsvRows) {
      const preview = { ...row, record: null, previewStatus: "", previewMessage: "", blocking: false };
      if (row.validationError) {
        preview.previewStatus = "CSV错误";
        preview.previewMessage = row.validationError;
        preview.blocking = true;
        cancelPreviewRows.push(preview);
        continue;
      }
      const lookup = lookupByStore.get(row.store.mallId);
      if (!lookup || lookup.failedProductIds.has(normalizedId(row.productId))) {
        preview.previewStatus = "读取失败";
        preview.previewMessage = "该 SPU 的活动记录没有完整读取";
        preview.blocking = true;
        cancelPreviewRows.push(preview);
        continue;
      }
      let candidates = lookup.records.filter(
        (record) => normalizedId(record?.productId) === normalizedId(row.productId)
      );
      if (row.enrollId) {
        candidates = candidates.filter(
          (record) => normalizedId(record?.enrollId) === normalizedId(row.enrollId)
        );
      }
      if (row.activityText) {
        const activityKey = normalizeMatchText(row.activityText);
        candidates = candidates.filter((record) => cancelActivityDescriptors(record).has(activityKey));
      }
      let ambiguityMessage = "";
      let matchedByPrice = false;
      if (candidates.length > 1) {
        preview.candidateActivityPriceText = candidates
          .map(
            (record) =>
              `${normalizedId(record?.enrollId) || "无报名ID"}: ${
                formatActivityPriceRaws(cancelRecordActivityPriceRaws(record)) || "空"
              }`
          )
          .join(" / ");
        const csvPrices = uniqueActivityPriceRaws(row.activityPriceRaws || []);
        if (!csvPrices.length) {
          const warningText = (row.activityPriceWarnings || []).join("；");
          ambiguityMessage = `找到 ${candidates.length} 个报名记录，但 CSV“活动申报价格”没有可用数值${
            warningText ? `（${warningText}）` : ""
          }`;
        } else {
          const priceMatchedCandidates = candidates.filter((record) =>
            activityPriceSetsEqual(csvPrices, cancelRecordActivityPriceRaws(record))
          );
          if (priceMatchedCandidates.length === 1) {
            candidates = priceMatchedCandidates;
            matchedByPrice = true;
          } else if (!priceMatchedCandidates.length) {
            ambiguityMessage = `找到 ${candidates.length} 个报名记录，但 CSV 价格 ${formatActivityPriceRaws(
              csvPrices
            )} 与报名记录价格（${preview.candidateActivityPriceText}）均不完全一致`;
          } else {
            ambiguityMessage = `找到 ${candidates.length} 个报名记录，其中 ${
              priceMatchedCandidates.length
            } 个的活动申报价格都与 CSV ${formatActivityPriceRaws(csvPrices)} 完全一致`;
          }
        }
      }
      if (!candidates.length) {
        preview.previewStatus = "未匹配";
        preview.previewMessage = "未找到同店铺、同 SPU、同活动的未开始或进行中报名记录";
        preview.blocking = true;
      } else if (ambiguityMessage || candidates.length > 1) {
        preview.previewStatus = "匹配不唯一";
        preview.previewMessage = `${
          ambiguityMessage || `找到 ${candidates.length} 个报名记录`
        }，已跳过；如需退出请在 CSV 增加“报名ID”列`;
        preview.blocking = true;
      } else {
        const record = candidates[0];
        preview.record = record;
        const enrollId = normalizedId(record?.enrollId);
        if (!enrollId) {
          preview.previewStatus = "不可退出";
          preview.previewMessage = "页面记录没有报名ID";
          preview.blocking = true;
        } else if (Number(record?.cancelApplyInfo?.reviewStatus) === 1) {
          preview.previewStatus = "不可退出";
          preview.previewMessage = "该活动已申请退出，正在审核中";
          preview.blocking = true;
        } else if (record?.canCancelEnroll !== true) {
          preview.previewStatus = "不可退出";
          preview.previewMessage = "页面标记该报名记录当前不可退出";
          preview.blocking = true;
        } else if (selectedEnrollIds.has(enrollId)) {
          preview.previewStatus = "重复报名ID";
          preview.previewMessage = "重复的 SKU/站点行已合并，不会重复提交";
        } else {
          selectedEnrollIds.add(enrollId);
          preview.previewStatus = matchedByPrice ? "可退出（价格完全一致）" : "可退出";
          cancelExecutionRows.push(preview);
        }
      }
      cancelPreviewRows.push(preview);
    }

    renderCancelPreview();
    const blockingCount = cancelPreviewRows.filter((row) => row.blocking).length;
    if (blockingCount) {
      setStatus(
        `退出清单核对完成：可退出 ${cancelExecutionRows.length} 个，跳过 ${blockingCount} 条`,
        cancelExecutionRows.length ? "warning" : "error"
      );
      appendLog(
        `退出清单核对完成；${blockingCount} 条存在问题将跳过，其余 ${cancelExecutionRows.length} 个继续`,
        cancelExecutionRows.length ? "warning" : "error"
      );
    } else if (!cancelExecutionRows.length) {
      throw new Error("CSV 没有匹配到可退出的活动");
    } else {
      const dryRun = panelRefs.cancelDryRun.checked;
      setStatus(
        dryRun
          ? `试跑核对完成：${cancelExecutionRows.length} 个活动符合退出条件`
          : `提交前核对完成：将精确退出 ${cancelExecutionRows.length} 个活动`,
        "success"
      );
      appendLog(
        `${dryRun ? "试跑" : "提交前"}核对完成：${
          cancelExecutionRows.length
        } 个唯一报名ID；未放入 CSV 的活动不会退出`,
        "success"
      );
    }
  }

  async function runBatchCancel() {
    if (!cancelExecutionRows.length) throw new Error("退出清单没有可执行的活动");
    const cancelReason = toText(panelRefs.cancelReason.value);
    if (!cancelReason) throw new Error("请填写退出原因");

    stopRequested = false;
    paused = false;
    lastRequestAt = 0;
    cancelResultsAutoDownloaded = false;
    const executionSourceLines = new Set(cancelExecutionRows.map((item) => item.sourceLine));
    cancelResultRows = cancelPreviewRows.map((item) =>
      executionSourceLines.has(item.sourceLine)
        ? cancelResultRow(item, "待执行")
        : cancelResultRow(item, "已跳过", item.previewMessage)
    );
    const resultBySourceLine = new Map(
      cancelResultRows.map((row) => [Number(row["CSV源行"]), row])
    );
    const resultByEnrollId = new Map(
      cancelExecutionRows.map((item) => [
        normalizedId(item.record?.enrollId),
        resultBySourceLine.get(Number(item.sourceLine)),
      ])
    );
    const groups = [];
    for (const store of stores) {
      const storeItems = cancelExecutionRows.filter((item) => item.store?.mallId === store.mallId);
      for (const batch of chunkList(storeItems, CANCEL_BATCH_SIZE)) {
        if (batch.length) groups.push({ store, batch });
      }
    }
    updateProgress(0, groups.length, 0);
    appendLog(
      `开始批量退出：提交 ${cancelExecutionRows.length} 个活动，跳过 ${
        cancelResultRows.length - cancelExecutionRows.length
      } 条问题项，拆成 ${groups.length} 次提交；写请求不自动重试`
    );

    try {
      for (let index = 0; index < groups.length; index += 1) {
      await waitUntilRunnable();
      const { store, batch } = groups[index];
      const enrollIds = batch.map((item) => apiProductId(item.record?.enrollId));
      setStatus(`${store.name} · 退出第 ${index + 1}/${groups.length} 批 · ${batch.length} 个活动`, "busy");
      try {
        const result = await postJson(store, API_CANCEL_ENROLL, {
          enrollIds,
          cancelReason,
        });
        const failList = Array.isArray(result?.failList) ? result.failList : [];
        const failMap = new Map(
          failList.map((failure) => [normalizedId(failure?.enrollId), failure])
        );
        const expectedSuccessCount = batch.length - failMap.size;
        const reportedSuccessCount = Number(result?.enrollSuccessCount);
        const countsConsistent =
          !Number.isFinite(reportedSuccessCount) || reportedSuccessCount === expectedSuccessCount;
        for (const item of batch) {
          const enrollId = normalizedId(item.record?.enrollId);
          const resultRow = resultByEnrollId.get(enrollId);
          const failure = failMap.get(enrollId);
          if (!resultRow) continue;
          if (failure) {
            resultRow["执行状态"] = "退出失败";
            resultRow["失败原因"] =
              toText(failure.failMsg) || toText(failure.failReason) || "接口返回失败";
          } else if (countsConsistent) {
            resultRow["执行状态"] = "已提交退出";
            resultRow["失败原因"] = "";
          } else {
            resultRow["执行状态"] = "状态未知";
            resultRow["失败原因"] = "接口成功数量与本批明细不一致，未自动重试";
          }
        }
        appendLog(
          `${store.name} · 第 ${index + 1}/${groups.length} 批：成功 ${
            Number.isFinite(reportedSuccessCount) ? reportedSuccessCount : expectedSuccessCount
          }，失败 ${failMap.size}`,
          failMap.size ? "error" : "success"
        );
      } catch (error) {
        for (const item of batch) {
          const resultRow = resultByEnrollId.get(normalizedId(item.record?.enrollId));
          if (!resultRow) continue;
          resultRow["执行状态"] = "状态未知";
          resultRow["失败原因"] = `${readableError(error)}；为避免重复退出，未自动重试`;
        }
        appendLog(
          `${store.name} · 第 ${index + 1}/${groups.length} 批响应不确定，未自动重试：${readableError(
            error
          )}`,
          "error"
        );
        if (stopRequested || error instanceof StopError || error?.name === "AbortError") {
          throw new StopError("退出任务已停止；进行中的一批状态未知");
        }
        appendLog("本批响应不确定，已停止后续退出批次；待执行记录未提交", "error");
        break;
      }
        updateProgress(index + 1, groups.length, cancelResultRows.length);
      }
    } finally {
      await autoDownloadCancelResults();
    }

    const successCount = cancelResultRows.filter((row) => row["执行状态"] === "已提交退出").length;
    const skippedCount = cancelResultRows.filter((row) => row["执行状态"] === "已跳过").length;
    const failureCount = cancelResultRows.length - successCount - skippedCount;
    setStatus(
      `批量退出完成：已提交 ${successCount} 个，跳过 ${skippedCount} 条，失败或待核对 ${failureCount} 个`,
      failureCount || skippedCount ? "warning" : "success"
    );
    appendLog(
      `批量退出结束：已提交 ${successCount}，跳过 ${skippedCount}，失败或待核对 ${failureCount}；结果${
        cancelResultsAutoDownloaded ? "已自动下载" : "可手动下载"
      }`,
      failureCount ? "error" : "success"
    );
  }

  async function runCancelFlow() {
    const dryRun = panelRefs.cancelDryRun.checked;
    if (!dryRun && !toText(panelRefs.cancelReason.value)) {
      throw new Error("提交模式请填写退出原因");
    }
    await runCancelPreflight();
    const blockingCount = cancelPreviewRows.filter((row) => row.blocking).length;

    if (dryRun) {
      cancelResultRows = cancelPreviewRows.map((item) =>
        cancelResultRow(item, "试跑未提交", item.previewMessage)
      );
      const downloaded = await autoDownloadCancelResults();
      setStatus(
        `试跑完成：${cancelExecutionRows.length} 个活动可退出，${blockingCount} 条需处理，未提交`,
        blockingCount ? "warning" : "success"
      );
      appendLog(
        `试跑完成：可退出 ${cancelExecutionRows.length} 个，需处理 ${blockingCount} 条，全程未调用退出接口；结果${
          downloaded ? "已自动下载" : "可手动下载"
        }`,
        blockingCount ? "error" : "success"
      );
      return;
    }

    if (!cancelExecutionRows.length) {
      cancelResultRows = cancelPreviewRows.map((item) =>
        cancelResultRow(item, "已跳过", item.previewMessage)
      );
      const downloaded = await autoDownloadCancelResults();
      setStatus(
        `没有可退出的活动，已跳过 ${cancelResultRows.length} 条；结果${
          downloaded ? "已自动下载" : "可手动下载"
        }`,
        "warning"
      );
      appendLog(`没有可退出的活动；${cancelResultRows.length} 条问题项已写入退出结果`, "error");
      return;
    }
    await runBatchCancel();
  }

  function buildExistingPriceIndex(records) {
    const index = new Map();
    const seen = new Set();

    for (const record of records) {
      if (Number(record?.activityType) === 51) continue;
      const remainingStock = firstFiniteNumber(
        record?.remainingActivityStock,
        record?.activityStock
      );
      if (remainingStock == null || remainingStock <= 0) continue;

      const productId = normalizedId(record?.productId);
      const activityName = activityDisplayName({
        activityThematicName: record?.activityThematicName,
        activityName: record?.activityTypeName,
        activityType: record?.activityType,
      });
      const sessions = Array.isArray(record?.assignSessionList) ? record.assignSessionList : [];
      const skcList = Array.isArray(record?.skcList) ? record.skcList : [];

      for (const skc of skcList) {
        const skuList = Array.isArray(skc?.skuList) ? skc.skuList : [];
        for (const sku of skuList) {
          const skuId = normalizedId(sku?.skuId);
          const sitePrices = Array.isArray(sku?.sitePriceList) ? sku.sitePriceList : [];
          for (const sitePrice of sitePrices) {
            const activityPriceRaw = firstFiniteNumber(sitePrice?.activityPrice);
            if (activityPriceRaw == null || activityPriceRaw <= 0) continue;
            const priceSiteKey = siteKey(sitePrice?.siteId, sitePrice?.siteName);
            const matchingSessions = sessions.filter(
              (session) =>
                OVERLAP_SESSION_STATUSES.includes(Number(session?.sessionStatus)) &&
                siteKey(session?.siteId, session?.siteName) === priceSiteKey
            );

            for (const session of matchingSessions) {
              const candidate = {
                activityName,
                activityPriceRaw,
                remainingStock,
                sessionId: normalizedId(session?.sessionId),
                sessionName: toText(session?.sessionName),
                startTime: session?.startTime,
                endTime: session?.endTime,
              };
              const indexKey = `${productId}|${skuId}|${priceSiteKey}`;
              const seenKey = `${indexKey}|${registeredActivityKey(record)}|${candidate.sessionId}|${activityPriceRaw}`;
              if (seen.has(seenKey)) continue;
              seen.add(seenKey);
              if (!index.has(indexKey)) index.set(indexKey, []);
              index.get(indexKey).push(candidate);
            }
          }
        }
      }
    }

    return index;
  }

  function buildActivityDetailRows(store, records, allowedStatuses, seen = new Set()) {
    const output = [];

    for (const record of records) {
      const sessions = (Array.isArray(record?.assignSessionList) ? record.assignSessionList : []).filter(
        (session) => allowedStatuses.has(Number(session?.sessionStatus))
      );
      if (!sessions.length) continue;

      const skcList = Array.isArray(record?.skcList) && record.skcList.length ? record.skcList : [null];
      for (const skc of skcList) {
        const skuList = Array.isArray(skc?.skuList) && skc.skuList.length ? skc.skuList : [null];
        for (const sku of skuList) {
          const sitePriceList =
            Array.isArray(sku?.sitePriceList) && sku.sitePriceList.length
              ? sku.sitePriceList
              : [null];
          for (const sitePrice of sitePriceList) {
            const priceSiteKey = sitePrice
              ? siteKey(sitePrice.siteId, sitePrice.siteName)
              : "";
            const matchingSessions = sitePrice
              ? sessions.filter(
                  (session) => siteKey(session?.siteId, session?.siteName) === priceSiteKey
                )
              : sessions;

            for (const session of matchingSessions) {
              const rowKey = [
                store.mallId,
                registeredActivityKey(record),
                normalizedId(skc?.skcId),
                normalizedId(sku?.skuId),
                priceSiteKey,
                normalizedId(session?.sessionId),
              ].join("|");
              if (seen.has(rowKey)) continue;
              seen.add(rowKey);
              output.push({
                "店铺信息": store.name,
                "活动状态": activityStatusLabel(session?.sessionStatus),
                "活动类型ID": record?.activityType,
                "活动类型": record?.activityTypeName,
                "活动专题ID": record?.activityThematicId,
                "活动专题": record?.activityThematicName || record?.activityTypeName,
                "SPU ID": toText(record?.productId),
                "SKC ID": toText(skc?.skcId),
                "SKC货号": toText(skc?.extCode),
                "SKU ID": toText(sku?.skuId),
                "SKU货号": toText(sku?.extCode),
                "SKU属性": propertiesText(sku?.properties),
                "站点": sitePrice?.siteName || session?.siteName,
                "站点ID": sitePrice?.siteId ?? session?.siteId,
                "日常申报价": centsToNumber(sitePrice?.dailyPrice),
                "活动申报价格": centsToNumber(sitePrice?.activityPrice),
                "活动折扣": discountText(sitePrice?.activityDiscount),
                "币种": sitePrice?.currency || sku?.currency || skc?.currency || record?.currency,
                "场次ID": toText(session?.sessionId),
                "场次名称": session?.sessionName,
                "场次开始时间": formatDateTime(session?.startTime),
                "场次结束时间": formatDateTime(session?.endTime),
                "活动库存": record?.activityStock,
                "剩余活动库存": record?.remainingActivityStock,
                "报名ID": toText(record?.enrollId),
                __activityTemplateText: registeredActivityText(record),
                __color:
                  toText(skc?.color) ||
                  propertyValue(skc?.properties, ["颜色", "color", "colour"]) ||
                  propertyValue(sku?.properties, ["颜色", "color", "colour"]),
                __size:
                  toText(sku?.size) ||
                  propertyValue(sku?.properties, ["尺码", "尺寸", "size"]) ||
                  propertyValue(skc?.properties, ["尺码", "尺寸", "size"]),
              });
            }
          }
        }
      }
    }

    return output;
  }

  function buildActivityTemplateRows(detailRows) {
    const output = [];
    const seen = new Set();
    for (const detailRow of detailRows) {
      const row = {
        "活动类型(活动主题）": detailRow.__activityTemplateText,
        "SPU ID": detailRow["SPU ID"],
        "SKC ID": detailRow["SKC ID"],
        "SKC货号": detailRow["SKC货号"],
        "SKU ID": detailRow["SKU ID"],
        "SKU货号": detailRow["SKU货号"],
        "颜色属性": detailRow.__color,
        "尺码属性": detailRow.__size,
        "站点": detailRow["站点"],
        "活动申报价格": detailRow["活动申报价格"],
        "币种": detailRow["币种"],
        "店铺": detailRow["店铺信息"],
      };
      const key = JSON.stringify(ACTIVITY_TEMPLATE_HEADERS.map((header) => row[header] ?? ""));
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(row);
    }
    return output;
  }

  async function fetchActivityDetailRows(store, productIds, statuses, onPageRows = null) {
    const output = [];
    let outputCount = 0;
    const seen = new Set();
    const uniqueProducts = new Map();
    for (const productId of productIds) {
      const key = normalizedId(productId);
      if (key && !uniqueProducts.has(key)) uniqueProducts.set(key, productId);
    }
    const batches = uniqueProducts.size
      ? chunkList([...uniqueProducts.values()], ENROLL_PRODUCT_BATCH_SIZE)
      : [[]];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      for (const sessionStatus of statuses) {
        seen.clear();
        let pageNo = 1;
        let loaded = 0;
        while (true) {
          await waitUntilRunnable();
          const payload = {
            pageNo,
            pageSize: ENROLL_PAGE_SIZE,
            sessionStatus,
          };
          if (batch.length) payload.productIds = batch;
          const scopeLabel = batch.length
            ? `SPU批次 ${batchIndex + 1}/${batches.length}`
            : "全部SPU";
          setStatus(
            `${store.name} · ${scopeLabel} · ${activityStatusLabel(sessionStatus)} · 第 ${pageNo} 页 · 已生成 ${
              activityDetailRows.length + (onPageRows ? 0 : output.length)
            } 行`,
            "busy"
          );

          let result;
          try {
            result = await requestWithRetry(
              store,
              API_ENROLL_LIST,
              payload,
              `${store.name} 活动明细（${scopeLabel}，${activityStatusLabel(
                sessionStatus
              )}，第 ${pageNo} 页）`
            );
          } catch (error) {
            if (stopRequested || error instanceof StopError) throw new StopError();
            activityDetailFailures.push({
              store: store.name,
              productIds: batch.map(normalizedId),
              sessionStatus,
              pageNo,
              error: readableError(error),
            });
            appendLog(
              `${store.name} · ${scopeLabel} · ${activityStatusLabel(
                sessionStatus
              )}第 ${pageNo} 页最终失败；已停止本次活动明细采集，避免漏页结果被当成完整结果：${readableError(
                error
              )}`,
              "error"
            );
            throw new Error(
              `${store.name} · ${scopeLabel} · ${activityStatusLabel(
                sessionStatus
              )}第 ${pageNo} 页读取失败，后续页面未采集`
            );
          }

          const list = Array.isArray(result?.list) ? result.list : [];
          const scopedList = uniqueProducts.size
            ? list.filter((record) => uniqueProducts.has(normalizedId(record?.productId)))
            : list;
          const total = Number(result?.total);
          loaded += list.length;
          const pageRows = buildActivityDetailRows(
            store,
            scopedList,
            new Set([Number(sessionStatus)]),
            seen
          );
          outputCount += pageRows.length;
          if (typeof onPageRows === "function") onPageRows(pageRows);
          else output.push(...pageRows);
          if (panelRefs) {
            panelRefs.rowCount.textContent = `${
              activityDetailRows.length + (onPageRows ? 0 : output.length)
            } 行`;
          }
          appendLog(
            `${store.name} · ${scopeLabel} · ${activityStatusLabel(sessionStatus)}第 ${pageNo} 页：记录 ${
              scopedList.length
            } 条，明细 ${pageRows.length} 行，总数 ${Number.isFinite(total) ? total : "-"}`
          );

          if (!list.length || (Number.isFinite(total) && loaded >= total)) break;
          if (!Number.isFinite(total) && list.length < ENROLL_PAGE_SIZE) break;
          pageNo += 1;
          if (pageNo > MAX_ACTIVITY_DETAIL_PAGES) {
            throw new Error(
              `活动明细分页超过 ${MAX_ACTIVITY_DETAIL_PAGES} 页，已停止以避免异常死循环`
            );
          }
        }
      }
    }

    return typeof onPageRows === "function" ? outputCount : output;
  }

  async function fetchActivityLookups(productIdsByStore, statuses) {
    const lookups = new Map();
    for (const store of stores) {
      const productIds = productIdsByStore.get(normalizedId(store.mallId)) || [];
      if (!productIds.length) continue;
      appendLog(
        `${store.name}：核对 ${productIds.length} 个商品，状态 ${statuses
          .map(activityStatusLabel)
          .join("、")}`
      );
      const lookup = await fetchExistingActivityRecords(store, productIds, statuses);
      const priceFailedProductIds = new Set();
      for (const [productId, failedStatuses] of lookup.failedStatusesByProductId) {
        if (OVERLAP_SESSION_STATUSES.some((status) => failedStatuses.has(status))) {
          priceFailedProductIds.add(productId);
        }
      }
      lookups.set(normalizedId(store.mallId), {
        records: lookup.records,
        index: buildExistingPriceIndex(lookup.records),
        failedProductIds: priceFailedProductIds,
      });
      appendLog(`${store.name}：现有活动读取到 ${lookup.records.length} 条报名记录`, "success");
    }
    return lookups;
  }

  function applyBaseDecision(row) {
    const applicationPrice = row["活动申报价格"];
    row["重叠活动最低申报价"] = "";
    row["叠加后预计最低结算价"] = "";
    row["叠加活动名称"] = "";
    row["叠加活动场次"] = "";
    row["叠加活动剩余库存"] = "";
    row["决策参考价"] = applicationPrice;

    if (Number(row.__activityType) === 53) {
      row["是否需要叠加"] = "待确认";
      row["价格计算说明"] =
        "规则含动态优惠券，但接口未返回券额及承担方；决策参考价暂按活动申报价格，未扣优惠券。";
      return;
    }

    row["是否需要叠加"] = "不适用";
    row["价格计算说明"] = applicationPrice === "" ? "没有可用的活动申报价格。" : "按活动申报价格判断。";
  }

  async function enrichPriceDecisionRows(compactRows, preparedStoreLookups = null) {
    compactRows.forEach(applyBaseDecision);
    const crossStoreRows = compactRows.filter((row) => Number(row.__activityType) === 51);
    if (!crossStoreRows.length) return;

    let storeLookups = preparedStoreLookups;
    if (!storeLookups) {
      const productIdsByStore = new Map();
      for (const store of stores) {
        const productMap = new Map();
        for (const row of crossStoreRows) {
          if (normalizedId(row.__storeMallId) !== normalizedId(store.mallId)) continue;
          const key = normalizedId(row.__productId);
          if (key && !productMap.has(key)) productMap.set(key, row.__productId);
        }
        productIdsByStore.set(normalizedId(store.mallId), [...productMap.values()]);
      }
      storeLookups = await fetchActivityLookups(productIdsByStore, OVERLAP_SESSION_STATUSES);
    }

    for (const row of crossStoreRows) {
      row["决策参考价"] = "";
      row["是否需要叠加"] = "";
      const storeLookup = storeLookups.get(normalizedId(row.__storeMallId));
      const productId = normalizedId(row.__productId);
      const dailyPriceRaw = firstFiniteNumber(row.__dailyPriceRaw);
      const discountRaw = firstFiniteNumber(row.__discountRaw);

      if (!storeLookup || storeLookup.failedProductIds.has(productId)) {
        row["是否需要叠加"] = "核对失败";
        row["价格计算说明"] = "现有活动记录读取失败，为避免低估结算价，决策参考价留空。";
        continue;
      }
      if (dailyPriceRaw == null || dailyPriceRaw <= 0 || discountRaw == null || discountRaw <= 0 || discountRaw > 100) {
        row["是否需要叠加"] = "无法计算";
        row["价格计算说明"] = "缺少有效的日常申报价或跨店满减折扣，决策参考价留空。";
        continue;
      }
      const targetStart = toTimestamp(row.__activityStartTime);
      const targetEnd = toTimestamp(row.__activityEndTime);
      if (!targetStart || !targetEnd || targetStart > targetEnd) {
        row["是否需要叠加"] = "无法计算";
        row["价格计算说明"] = "邀约活动缺少有效起止时间，无法判断场次是否重叠。";
        continue;
      }
      if (
        !productId ||
        !normalizedId(row.__skuId) ||
        (!normalizedId(row.__siteId) && !toText(row.__siteName))
      ) {
        row["是否需要叠加"] = "无法计算";
        row["价格计算说明"] = "缺少 SPU、SKU 或站点标识，无法精确匹配现有活动。";
        continue;
      }

      const indexKey = `${productId}|${normalizedId(row.__skuId)}|${siteKey(
        row.__siteId,
        row.__siteName
      )}`;
      const overlapping = (storeLookup.index.get(indexKey) || []).filter((candidate) =>
        timeRangesOverlap(
          row.__activityStartTime,
          row.__activityEndTime,
          candidate.startTime,
          candidate.endTime
        )
      );

      if (!overlapping.length) {
        const expectedRaw = Math.round((dailyPriceRaw * discountRaw) / 100);
        row["是否需要叠加"] = "否";
        row["叠加后预计最低结算价"] = centsToNumber(expectedRaw);
        row["决策参考价"] = centsToNumber(expectedRaw);
        row["价格计算说明"] = `未找到时间重叠且有剩余库存的其他官方活动；日常申报价 ${centsToPrice(
          dailyPriceRaw
        )} × ${discountText(discountRaw)} = ${centsToPrice(expectedRaw)}。`;
        continue;
      }

      const minimumActivityPriceRaw = Math.min(
        ...overlapping.map((candidate) => candidate.activityPriceRaw)
      );
      const minimumCandidates = overlapping.filter(
        (candidate) => candidate.activityPriceRaw === minimumActivityPriceRaw
      );
      const settlementBaseRaw = Math.min(dailyPriceRaw, minimumActivityPriceRaw);
      const expectedRaw = Math.round((settlementBaseRaw * discountRaw) / 100);
      row["重叠活动最低申报价"] = centsToNumber(minimumActivityPriceRaw);
      row["是否需要叠加"] = "是";
      row["叠加后预计最低结算价"] = centsToNumber(expectedRaw);
      row["决策参考价"] = centsToNumber(expectedRaw);
      row["叠加活动名称"] = uniqueText(minimumCandidates.map((candidate) => candidate.activityName));
      row["叠加活动场次"] = uniqueText(
        minimumCandidates.map((candidate) => candidate.sessionName || candidate.sessionId)
      );
      row["叠加活动剩余库存"] = uniqueText(
        minimumCandidates.map(
          (candidate) => `${candidate.activityName}：${candidate.remainingStock}`
        )
      );
      const baseLabel =
        minimumActivityPriceRaw < dailyPriceRaw ? "重叠活动最低申报价" : "日常申报价";
      row["价格计算说明"] = `${baseLabel} ${centsToPrice(settlementBaseRaw)} × ${discountText(
        discountRaw
      )} = ${centsToPrice(expectedRaw)}；已按时间、站点、SKU、状态和剩余库存筛选。`;
    }
  }

  function baseActivityRow(store, activity) {
    const stackingRule = activityStackingRule(activity);
    return {
      "邀约活动名称": activityDisplayName(activity),
      "店铺信息": store.name,
      "活动专题ID": activity.activityThematicId,
      "活动类型ID": activity.activityType,
      "活动类型": activity.activityName,
      "规则叠加结论": stackingRule.conclusion,
      "规则叠加说明": stackingRule.description,
      "活动开始时间": formatDateTime(activity.activityStartTime),
      "活动结束时间": formatDateTime(activity.activityEndTime),
      "报名截止时间": formatDateTime(activity.enrollEndTime),
      "活动周期天数": activity.durationDays,
      "申报折扣门槛": discountText(activity.discountThreshold),
      "邀约商品数": activity.allProductNum,
      "可邀约商品数": activity.validInviteProductNum,
      "已报名商品数": activity.enrollProductNum,
    };
  }

  function inviteActivityTemplateText(activity) {
    const thematicId = normalizedId(activity?.activityThematicId);
    const thematicName =
      toText(activity?.activityThematicName) || toText(activity?.activityName);
    if (thematicId && thematicId !== "0") {
      if (!thematicName) throw new Error("专题邀约缺少活动名称");
      return `${thematicId}-专题活动-${thematicName}`;
    }
    const activityType = normalizedId(activity?.activityType);
    const activityName = toText(activity?.activityName) || thematicName;
    if (!activityType || !activityName) {
      throw new Error("长期邀约缺少活动类型或活动名称");
    }
    return `${activityType}-长期活动-${activityName}`;
  }

  function buildRows(store, activity, products, emptyReason = "可报名商品返回为空") {
    const output = [];
    const compactOutput = [];
    const base = baseActivityRow(store, activity);
    const stackingRule = activityStackingRule(activity);

    for (const product of products) {
      const siteInfos =
        Array.isArray(product.activitySiteInfoList) && product.activitySiteInfoList.length
          ? product.activitySiteInfoList
          : [null];

      for (const siteInfo of siteInfos) {
        const skcList =
          Array.isArray(siteInfo?.skcList) && siteInfo.skcList.length ? siteInfo.skcList : [null];

        for (const skc of skcList) {
          const skuList = Array.isArray(skc?.skuList) && skc.skuList.length ? skc.skuList : [null];

          for (const sku of skuList) {
            const dailyPriceRaw = sku?.dailyPrice ?? skc?.dailyPrice;
            const discountRaw = resolveDiscountRaw(activity, skc, sku);
            const suggestPriceRaw = resolveReferencePriceRaw(activity, skc, sku);
            const rawSuggestPrice = firstFiniteNumber(
              sku?.rawSuggestActivityPrice,
              skc?.rawSuggestActivityPrice,
              suggestPriceRaw
            );
            const currency = sku?.currency || skc?.currency || product.currency;

            compactOutput.push({
              "活动类型(活动主题）": inviteActivityTemplateText(activity),
              "SPU ID": toText(product.productId),
              "SKC ID": toText(skc?.skcId),
              "SKC货号": toText(skc?.extCode),
              "SKU ID": toText(sku?.skuId),
              "SKU货号": toText(sku?.extCode),
              "颜色属性":
                toText(skc?.color) ||
                propertyValue(skc?.properties, ["颜色", "color", "colour"]) ||
                propertyValue(sku?.properties, ["颜色", "color", "colour"]),
              "尺码属性":
                toText(sku?.size) ||
                propertyValue(sku?.properties, ["尺码", "尺寸", "size"]) ||
                propertyValue(skc?.properties, ["尺码", "尺寸", "size"]),
              "站点": siteInfo?.siteName,
              "活动申报价格": centsToNumber(suggestPriceRaw),
              "币种": currency,
              "日常参考价": centsToNumber(dailyPriceRaw),
              "规则叠加结论": stackingRule.conclusion,
              "规则叠加说明": stackingRule.description,
              "重叠活动最低申报价": "",
              "是否需要叠加": "",
              "叠加后预计最低结算价": "",
              "决策参考价": "",
              "叠加活动名称": "",
              "叠加活动场次": "",
              "叠加活动剩余库存": "",
              "价格计算说明": "",
              __storeMallId: store.mallId,
              __activityType: activity.activityType,
              __activityThematicId: activity.activityThematicId,
              __activityStartTime: activity.activityStartTime,
              __activityEndTime: activity.activityEndTime,
              __productId: product.productId,
              __siteId: siteInfo?.siteId,
              __siteName: siteInfo?.siteName,
              __skuId: sku?.skuId,
              __dailyPriceRaw: dailyPriceRaw,
              __discountRaw: discountRaw,
              __activityApplicationPriceRaw: suggestPriceRaw,
            });

            output.push({
              "采集状态": "成功",
              ...base,
              "商品ID": product.productId,
              "商品名称": product.productName,
              "商品大区": product.goodsExtAttr?.semiDrCode,
              "可经营站点": listText(
                (Array.isArray(product.sites) ? product.sites : []).map((site) => site.siteName)
              ),
              "报名站点": siteInfo?.siteName,
              "报名站点ID": siteInfo?.siteId,
              "商品销售库存": product.salesStock,
              "目标活动库存": product.targetActivityStock,
              "建议活动库存": product.suggestActivityStock,
              "可报名场次数": product.canEnrollSessionCount,
              "已报名场次ID": idListText(product.enrollSessionIdList),
              "建议报名场次ID": idListText(product.suggestEnrollSessionIdList),
              "图片": product.pictureUrl,
              "SKC ID": skc?.skcId,
              "SKC货号": skc?.extCode,
              "SKC属性": propertiesText(skc?.properties),
              "SKU ID": sku?.skuId,
              "SKU货号": sku?.extCode,
              "SKU属性": propertiesText(sku?.properties),
              "币种": currency,
              "日常申报价": centsToPrice(dailyPriceRaw),
              "日常申报价原始值": dailyPriceRaw,
              "建议活动折扣": discountText(
                sku?.suggestActivityDiscount ?? skc?.suggestActivityDiscount
              ),
              "建议活动价": centsToPrice(suggestPriceRaw),
              "建议活动价原始值": suggestPriceRaw,
              "原始建议活动价": centsToPrice(rawSuggestPrice),
              "是否必须权益": yesNo(siteInfo?.mustPrivilege),
              "是否低销标签": yesNo(product.activityExtAttr?.lowSoldScore),
              "失败备注": "",
            });
          }
        }
      }
    }

    if (!output.length) {
      output.push({
        "采集状态": emptyReason.includes("所选站点") ? "所选站点无可报名商品" : "无可报名商品",
        ...base,
        "失败备注": emptyReason,
      });
    }
    return { fullRows: output, compactRows: compactOutput };
  }

  function buildFailureRow(store, activity, error) {
    return {
      "采集状态": "失败",
      ...baseActivityRow(store, activity),
      "失败备注": readableError(error),
    };
  }

  function getSelectedStores() {
    if (!panelRefs?.storeList) return [];
    const selectedIds = new Set(
      [...panelRefs.storeList.querySelectorAll("[data-store-id]:checked")].map(
        (input) => input.dataset.storeId
      )
    );
    return stores.filter((store) => selectedIds.has(store.mallId));
  }

  function getSelectedActivityKeys() {
    if (!panelRefs?.activityList) return new Set();
    return new Set(
      [...panelRefs.activityList.querySelectorAll("[data-activity-key]:checked")].map(
        (input) => input.dataset.activityKey
      )
    );
  }

  function getSelectedSiteNames() {
    if (!panelRefs?.siteList) return new Set();
    return new Set(
      [...panelRefs.siteList.querySelectorAll("[data-site-name]:checked")].map(
        (input) => input.dataset.siteName
      )
    );
  }

  function currentStoreSignature() {
    return getSelectedStores()
      .map((store) => store.mallId)
      .sort()
      .join("|");
  }

  function saveSelectedStoreIds() {
    localStorage.setItem(
      SELECTED_STORES_KEY,
      JSON.stringify(getSelectedStores().map((store) => store.mallId))
    );
  }

  function loadSavedStoreIds() {
    try {
      const value = JSON.parse(localStorage.getItem(SELECTED_STORES_KEY) || "[]");
      return Array.isArray(value) ? value.map(normalizedId).filter(Boolean) : [];
    } catch (error) {
      console.warn("[活动邀约采集] 店铺选择记录无法解析", error);
      return [];
    }
  }

  function refreshStoreCount() {
    if (!panelRefs?.storeList) return;
    const all = panelRefs.storeList.querySelectorAll("[data-store-id]");
    const selected = panelRefs.storeList.querySelectorAll("[data-store-id]:checked");
    panelRefs.storeCount.textContent = `${selected.length}/${all.length}`;
  }

  function refreshActivityCount() {
    if (!panelRefs?.activityList) return;
    const all = panelRefs.activityList.querySelectorAll("[data-activity-key]");
    const selected = panelRefs.activityList.querySelectorAll("[data-activity-key]:checked");
    panelRefs.activityCount.textContent = `${selected.length}/${all.length}`;
  }

  function refreshSiteCount() {
    if (!panelRefs?.siteList) return;
    const all = panelRefs.siteList.querySelectorAll("[data-site-name]");
    const selected = panelRefs.siteList.querySelectorAll("[data-site-name]:checked");
    panelRefs.siteCount.textContent = `${selected.length}/${all.length}`;
  }

  function renderStoreOptions(initialIds = []) {
    if (!panelRefs?.storeList) return;
    const selectedIds = new Set(initialIds.map(normalizedId));
    panelRefs.storeList.textContent = "";
    for (const store of stores) {
      const label = document.createElement("label");
      label.className = "choice-option store-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.storeId = store.mallId;
      input.checked = selectedIds.has(store.mallId);
      const text = document.createElement("span");
      text.textContent = `${store.name} · ${store.mallId}`;
      label.append(input, text);
      panelRefs.storeList.appendChild(label);
    }
    if (!stores.length) {
      panelRefs.storeList.innerHTML = '<div class="choice-empty">没有读取到可用店铺</div>';
    }
    refreshStoreCount();
  }

  function renderActivityOptions() {
    if (!panelRefs?.activityList) return;
    panelRefs.activityList.textContent = "";
    for (const group of loadedInviteGroups) {
      const stackingRule = activityStackingRule(group.activity);
      const label = document.createElement("label");
      label.className = "choice-option activity-option";
      label.dataset.searchText = `${activitySelectionLabel(group.activity)} ${group.key} ${
        group.activity.activityType ?? ""
      } ${group.activity.activityThematicId ?? ""} ${stackingRule.conclusion} ${
        stackingRule.description
      }`.toLowerCase();
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.activityKey = group.key;
      input.checked = true;
      const text = document.createElement("span");
      const main = document.createElement("strong");
      main.textContent = activitySelectionLabel(group.activity);
      const ruleBadge = document.createElement("em");
      ruleBadge.className = `rule-badge rule-${stackingRule.tone}`;
      ruleBadge.textContent = stackingRule.conclusion;
      const ruleNote = document.createElement("small");
      ruleNote.className = "rule-note";
      ruleNote.textContent = stackingRule.description;
      const meta = document.createElement("small");
      meta.textContent = `类型 ${group.activity.activityType ?? "-"} · 专题 ${
        group.activity.activityThematicId ?? "-"
      } · ${group.storeIds.size} 个店铺有此邀约`;
      text.append(main, ruleBadge, ruleNote, meta);
      label.append(input, text);
      panelRefs.activityList.appendChild(label);
    }
    if (!loadedInviteGroups.length) {
      panelRefs.activityList.innerHTML =
        '<div class="choice-empty">选择店铺后点击“加载邀约活动”</div>';
    }
    panelRefs.activitySearch.value = "";
    refreshActivityCount();
  }

  function renderSiteOptions(selectAllNew = false) {
    if (!panelRefs?.siteList) return;
    const previous = getSelectedSiteNames();
    const selectedKeys = getSelectedActivityKeys();
    const orderedNames = [];
    const seen = new Set();
    for (const group of loadedInviteGroups) {
      if (!selectedKeys.has(group.key)) continue;
      for (const site of group.sites) {
        const name = toText(site?.siteName);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        orderedNames.push(name);
      }
    }

    panelRefs.siteList.textContent = "";
    for (const siteName of orderedNames) {
      const label = document.createElement("label");
      label.className = "choice-option site-option";
      label.dataset.searchText = siteName.toLowerCase();
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.siteName = siteName;
      input.checked = selectAllNew || previous.has(siteName);
      const text = document.createElement("span");
      text.textContent = siteName;
      label.append(input, text);
      panelRefs.siteList.appendChild(label);
    }
    if (!orderedNames.length) {
      panelRefs.siteList.innerHTML =
        '<div class="choice-empty">所选活动没有返回可选站点</div>';
    }
    panelRefs.siteSearch.value = "";
    refreshSiteCount();
  }

  function filterChoiceOptions(list, selector, keyword) {
    const normalized = toText(keyword).toLowerCase();
    for (const option of list.querySelectorAll(selector)) {
      option.hidden = Boolean(normalized) && !option.dataset.searchText.includes(normalized);
    }
  }

  function invalidateLoadedInviteOptions(message = "店铺已变化，请重新加载邀约活动") {
    loadedInviteJobs = [];
    loadedInviteGroups = [];
    loadedStoreSignature = "";
    renderActivityOptions();
    renderSiteOptions();
    if (message) setStatus(message, "idle");
    renderControlState();
  }

  async function loadInviteOptions() {
    const selectedStores = getSelectedStores();
    if (!selectedStores.length) throw new Error("请至少选择一个店铺");
    loadingSelections = true;
    loadedInviteJobs = [];
    loadedInviteGroups = [];
    loadedStoreSignature = "";
    renderControlState();
    appendLog(`开始读取 ${selectedStores.length} 个所选店铺的邀约活动`);

    try {
      const groupMap = new Map();
      let successfulStores = 0;
      for (let storeIndex = 0; storeIndex < selectedStores.length; storeIndex += 1) {
        const store = selectedStores[storeIndex];
        setStatus(
          `读取店铺 ${storeIndex + 1}/${selectedStores.length}：${store.name} 的邀约活动`,
          "busy"
        );
        try {
          const activities = await fetchInviteActivities(store);
          successfulStores += 1;
          for (const activity of activities) {
            const key = activitySelectionKey(activity);
            const job = { store, activity, key };
            loadedInviteJobs.push(job);
            if (!groupMap.has(key)) {
              groupMap.set(key, {
                key,
                activity,
                jobs: [],
                storeIds: new Set(),
                sites: [],
              });
            }
            const group = groupMap.get(key);
            group.jobs.push(job);
            group.storeIds.add(store.mallId);
          }
          appendLog(`${store.name}：读取到 ${activities.length} 个活动邀约`, "success");
        } catch (error) {
          appendLog(`${store.name}：邀约活动读取失败，继续其他店铺：${readableError(error)}`, "error");
        }
      }

      loadedInviteGroups = [...groupMap.values()];
      if (!loadedInviteGroups.length) {
        throw new Error(
          successfulStores ? "所选店铺当前没有活动邀约" : "所选店铺的邀约活动都读取失败"
        );
      }

      for (let index = 0; index < loadedInviteGroups.length; index += 1) {
        const group = loadedInviteGroups[index];
        setStatus(
          `读取活动站点 ${index + 1}/${loadedInviteGroups.length}：${activityDisplayName(
            group.activity
          )}`,
          "busy"
        );
        const siteMap = new Map();
        let successCount = 0;
        const siteErrors = [];
        for (const job of group.jobs) {
          try {
            const jobSites = await fetchInviteActivitySites(job.store, job.activity);
            successCount += 1;
            for (const site of jobSites) {
              const siteName = toText(site?.siteName);
              if (siteName && !siteMap.has(siteName)) siteMap.set(siteName, site);
            }
          } catch (error) {
            siteErrors.push(`${job.store.name}：${readableError(error)}`);
          }
        }
        group.sites = [...siteMap.values()];
        if (!successCount) {
          appendLog(
            `${activityDisplayName(group.activity)}：站点读取失败，活动仍保留：${siteErrors.join(
              "；"
            )}`,
            "error"
          );
        } else if (siteErrors.length) {
          appendLog(
            `${activityDisplayName(group.activity)}：部分店铺站点读取失败，已保留其他店铺站点：${siteErrors.join(
              "；"
            )}`,
            "error"
          );
        }
      }

      loadedStoreSignature = currentStoreSignature();
      renderActivityOptions();
      renderSiteOptions(true);
      const siteCount = panelRefs.siteList.querySelectorAll("[data-site-name]").length;
      setStatus(
        `已加载 ${selectedStores.length} 个店铺、${loadedInviteGroups.length} 个活动、${siteCount} 个站点`,
        "success"
      );
      appendLog(
        `邀约选择已加载：店铺 ${selectedStores.length} 个，活动 ${loadedInviteGroups.length} 个，店铺活动组合 ${loadedInviteJobs.length} 个，站点 ${siteCount} 个`,
        "success"
      );
    } finally {
      loadingSelections = false;
      renderControlState();
    }
  }

  function filterProductsBySites(products, selectedSiteNames) {
    if (!selectedSiteNames.size) return products;
    const output = [];
    for (const product of products) {
      const siteInfos = Array.isArray(product?.activitySiteInfoList)
        ? product.activitySiteInfoList.filter((site) =>
            selectedSiteNames.has(toText(site?.siteName))
          )
        : [];
      if (!siteInfos.length) continue;
      output.push({ ...product, activitySiteInfoList: siteInfos });
    }
    return output;
  }

  async function runCollection() {
    const selectedStores = getSelectedStores();
    if (!selectedStores.length) throw new Error("请至少选择一个店铺");
    if (!loadedInviteGroups.length || loadedStoreSignature !== currentStoreSignature()) {
      throw new Error("店铺选择已变化，请先重新加载邀约活动");
    }
    const selectedActivityKeys = getSelectedActivityKeys();
    if (!selectedActivityKeys.size) throw new Error("请至少选择一个邀约活动");
    const availableSiteCount = panelRefs.siteList.querySelectorAll("[data-site-name]").length;
    const selectedSiteNames = getSelectedSiteNames();
    if (availableSiteCount && !selectedSiteNames.size) throw new Error("请至少选择一个站点");

    rows = [];
    templateRows = [];
    failedActivities = [];
    priceLookupFailures = [];
    stopRequested = false;
    paused = false;
    lastRequestAt = 0;
    renderControlState();
    const selectedStoreIds = new Set(selectedStores.map((store) => store.mallId));
    const storeJobs = selectedStores
      .map((store) => ({
        store,
        activities: loadedInviteJobs
          .filter(
            (job) =>
              job.store.mallId === store.mallId &&
              selectedActivityKeys.has(job.key) &&
              selectedStoreIds.has(job.store.mallId)
          )
          .map((job) => job.activity),
      }))
      .filter((job) => job.activities.length);

    const activityTotal = storeJobs.reduce((sum, job) => sum + job.activities.length, 0);
    let completed = 0;
    updateProgress(0, activityTotal, 0);

    if (activityTotal === 0) throw new Error("所选店铺没有对应的已选邀约活动");
    setStatus(`开始采集 ${activityTotal} 个店铺活动组合`, "busy");
    appendLog(
      `开始邀约采集：店铺 ${selectedStores.length} 个，活动 ${selectedActivityKeys.size} 个，店铺活动组合 ${activityTotal} 个，站点 ${
        selectedSiteNames.size || "不限"
      }`
    );

    for (const { store, activities } of storeJobs) {
      for (let index = 0; index < activities.length; index += 1) {
        await waitUntilRunnable();
        const activity = activities[index];
        const label = activityDisplayName(activity);
        appendLog(`开始 ${store.name} · ${index + 1}/${activities.length}：${label}`);

        try {
          const allMatchProducts = await fetchActivityProducts(
            store,
            activity,
            index + 1,
            activities.length
          );
          const matchProducts = filterProductsBySites(allMatchProducts, selectedSiteNames);
          const activityRows = buildRows(
            store,
            activity,
            matchProducts,
            allMatchProducts.length && !matchProducts.length
              ? "接口有可报名商品，但所选站点没有匹配商品"
              : "可报名商品返回为空"
          );
          rows.push(...activityRows.fullRows);
          templateRows.push(...activityRows.compactRows);
          appendLog(
            `完成 ${store.name} · ${index + 1}/${activities.length}：接口可报名 ${allMatchProducts.length} 个，所选站点保留 ${matchProducts.length} 个，完整明细 ${activityRows.fullRows.length} 行`,
            "success"
          );
        } catch (error) {
          if (stopRequested || error instanceof StopError) throw new StopError();
          failedActivities.push({ store, activity, error: readableError(error) });
          rows.push(buildFailureRow(store, activity, error));
          appendLog(
            `活动采集失败，继续下一个：${store.name} · ${label}｜${readableError(error)}`,
            "error"
          );
        }

        completed += 1;
        updateProgress(completed, activityTotal, rows.length);
      }
    }

    if (!rows.length) throw new Error("未采集到可导出的邀约结果");
    setStatus("正在核对跨店满减商品的现有活动与预计结算价…", "busy");
    await enrichPriceDecisionRows(templateRows);
    const partial = failedActivities.length > 0 || priceLookupFailures.length > 0;
    downloadWorkbook(rows, templateRows, partial);

    if (partial) {
      setStatus(
        `邀约采集完成，活动失败 ${failedActivities.length} 个，价格核对失败 ${priceLookupFailures.length} 批，已下载部分结果`,
        "warning"
      );
      appendLog(
        `邀约采集结束：共 ${rows.length} 行，失败活动 ${failedActivities.length} 个，价格核对失败 ${priceLookupFailures.length} 批`,
        "error"
      );
    } else {
      setStatus(`邀约采集完成并下载：完整 ${rows.length} 行，提报 ${templateRows.length} 行`, "success");
      appendLog(
        `邀约采集全部完成：完整明细 ${rows.length} 行，活动提报明细 ${templateRows.length} 行`,
        "success"
      );
    }
  }

  async function runActivityDetailCollection() {
    const selectedStores = getSelectedStores();
    if (!selectedStores.length) throw new Error("活动明细请至少选择一个店铺");
    activityDetailRows = [];
    activityDetailFailures = [];
    const statuses = [...panelRefs.statusChecks]
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => Number(checkbox.value));
    if (!statuses.length) throw new Error("活动明细请至少选择一个活动状态");
    const spuIds = parseSpuIds(panelRefs.spuInput.value).map(apiProductId);
    stopRequested = false;
    paused = false;
    lastRequestAt = 0;
    renderControlState();
    updateProgress(0, selectedStores.length, 0);
    appendLog(
      `开始单独采集活动明细；状态：${statuses
        .map(activityStatusLabel)
        .join("、")}；SPU：${spuIds.length ? `${spuIds.length} 个` : "全部"}`
    );

    for (let storeIndex = 0; storeIndex < selectedStores.length; storeIndex += 1) {
      await waitUntilRunnable();
      const store = selectedStores[storeIndex];
      const storeRowCount = await fetchActivityDetailRows(
        store,
        spuIds,
        statuses,
        (pageRows) => activityDetailRows.push(...pageRows)
      );
      updateProgress(storeIndex + 1, selectedStores.length, activityDetailRows.length);
      appendLog(`${store.name}：活动明细完成 ${storeRowCount} 行`, "success");
    }

    if (!activityDetailRows.length) throw new Error("所选状态和 SPU 没有可导出的活动明细");
    const partial = activityDetailFailures.length > 0;
    downloadActivityDetailWorkbook(activityDetailRows, partial);
    if (partial) {
      setStatus(
        `活动明细完成，失败 ${activityDetailFailures.length} 页，已下载部分结果 ${activityDetailRows.length} 行`,
        "warning"
      );
    } else {
      setStatus(`活动明细完成并下载：${activityDetailRows.length} 行`, "success");
    }
    appendLog(
      `活动明细采集结束：${activityDetailRows.length} 行，失败 ${activityDetailFailures.length} 页`,
      partial ? "error" : "success"
    );
  }

  function mainActivityTimeDisplay(activity) {
    if (!activity?.isThematic) {
      return { duration: "长期有效", start: "—", end: "—" };
    }
    const durationDays = Number(activity?.durationDays);
    return {
      duration:
        Number.isInteger(durationDays) && durationDays > 0 ? `${durationDays}天` : "—",
      start: formatDateTime(activity?.startTime) || "—",
      end: formatDateTime(activity?.endTime) || "—",
    };
  }

  function mainActivityThemeText(activity) {
    const activityType = toText(activity?.activityType);
    const activityName = toText(activity?.activityName);
    if (!activityType || !activityName) {
      throw new Error("活动列表缺少活动类型或活动名称");
    }
    if (activity?.isThematic) {
      const thematicId = toText(activity?.activityThematicId);
      const thematicName = toText(activity?.activityThematicName);
      if (!thematicId || !thematicName) {
        throw new Error("专题活动缺少专题 ID 或专题名称");
      }
      return `${thematicId}-专题活动-${thematicName}`;
    }
    return `${activityType}-长期活动-${activityName}`;
  }

  function mainActivityLogName(activity) {
    try {
      return mainActivityThemeText(activity);
    } catch {
      return `${toText(activity?.activityType) || "缺少类型"} · ${
        toText(activity?.activityThematicId) || "长期活动"
      }`;
    }
  }

  function mainActivityKey(activity) {
    return `${activity.activityType}|${
      activity.activityThematicId || "long"
    }|${mainActivityThemeText(activity)}`;
  }

  function mainActivityTaskKey(store, activity) {
    return store?.mallId && activity?.key ? `${store.mallId}|${activity.key}` : "";
  }

  function flattenMainActivities(result) {
    const groups = Array.isArray(result?.activityList) ? result.activityList : [];
    const activities = [];
    let excludedInviteCount = 0;

    for (const group of groups) {
      const activityType = toText(group?.activityType);
      const activityName = toText(group?.activityName);
      if (!activityType || !activityName) {
        throw new Error("活动列表返回了缺少活动类型或活动名称的记录");
      }
      const thematicList = Array.isArray(group?.thematicList) ? group.thematicList : [];
      if (!thematicList.length) {
        const activity = {
          ...group,
          activityType,
          activityName,
          activityThematicId: null,
          activityThematicName: null,
          isThematic: false,
        };
        activity.key = mainActivityKey(activity);
        activities.push(activity);
        continue;
      }

      for (const thematic of thematicList) {
        if (thematic?.activityThemeType == null) {
          excludedInviteCount += 1;
          continue;
        }
        const activityThematicId = toText(thematic?.activityThematicId);
        const activityThematicName = toText(thematic?.activityThematicName);
        if (
          !activityThematicId ||
          activityThematicId === "0" ||
          !activityThematicName
        ) {
          throw new Error(`${activityName} 返回了缺少专题 ID 或专题名称的记录`);
        }
        const activity = {
          ...group,
          ...thematic,
          activityType,
          activityName,
          activityThematicId,
          activityThematicName,
          isThematic: true,
        };
        activity.key = mainActivityKey(activity);
        activities.push(activity);
      }
    }
    return { activities, excludedInviteCount };
  }

  async function interruptibleMainActivitySleep(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await waitUntilRunnable();
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    await waitUntilRunnable();
  }

  async function postMainActivityJson(store, path, payload) {
    await waitRequestGap(MAIN_ACTIVITY_REQUEST_GAP_MS);
    const controller = new PAGE_WIN.AbortController();
    currentController = controller;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await PAGE_WIN.fetch(path, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          mallid: String(store.mallId),
        },
        body: JSON.stringify(payload),
      });
      const responseText = await response.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (error) {
        throw new Error(
          `返回内容无法解析：${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!response.ok || data.success === false) {
        const message =
          data.errorMsg ||
          data.error_msg ||
          data.message ||
          response.statusText ||
          "读取失败";
        throw new Error(`${response.status} ${message}`);
      }
      return data.result || data.res || data;
    } finally {
      clearTimeout(timeoutId);
      if (currentController === controller) currentController = null;
    }
  }

  async function requestMainActivityWithRetry(
    store,
    path,
    payload,
    label,
    logContext = {}
  ) {
    let lastError = null;
    let normalAttempt = 0;
    let rateLimitAttempt = 0;
    while (normalAttempt < MAIN_ACTIVITY_MAX_NORMAL_RETRIES) {
      await waitUntilRunnable();
      try {
        return await postMainActivityJson(store, path, payload);
      } catch (error) {
        if (stopRequested || error instanceof StopError) throw new StopError();
        lastError = error;
        if (isRateLimitError(error)) {
          rateLimitAttempt += 1;
          if (rateLimitAttempt > MAIN_ACTIVITY_MAX_RATE_LIMIT_RETRIES) break;
          const waitMs = Math.min(
            rateLimitAttempt * MAIN_ACTIVITY_RATE_LIMIT_WAIT_STEP_MS,
            MAIN_ACTIVITY_RATE_LIMIT_WAIT_MAX_MS
          );
          appendMainActivityLog(
            `${label}触发限流（${rateLimitAttempt}/${MAIN_ACTIVITY_MAX_RATE_LIMIT_RETRIES}）：${readableError(
              error
            )}；等待 ${Math.ceil(waitMs / 1000)} 秒后重试同一页`,
            "warning",
            logContext
          );
          await interruptibleMainActivitySleep(waitMs);
          continue;
        }
        normalAttempt += 1;
        appendMainActivityLog(
          `${label}失败（${normalAttempt}/${MAIN_ACTIVITY_MAX_NORMAL_RETRIES}）：${readableError(
            error
          )}`,
          "error",
          logContext
        );
        if (normalAttempt < MAIN_ACTIVITY_MAX_NORMAL_RETRIES) {
          await interruptibleMainActivitySleep(normalAttempt * 2000);
        }
      }
    }
    throw lastError || new Error(`${label}失败`);
  }

  async function fetchMainActivities(store) {
    const result = await requestMainActivityWithRetry(
      store,
      API_MAIN_ACTIVITY_LIST,
      { needSessionItem: true, needCanEnrollCnt: true },
      `${store.name} 读取活动列表`,
      { store }
    );
    const flattened = flattenMainActivities(result);
    if (!flattened.activities.length) {
      throw new Error("当前页面没有可采集的活动列表记录");
    }
    return flattened;
  }

  function getSelectedMainActivityKeys() {
    return new Set(
      [
        ...panelRefs.mainActivityList.querySelectorAll(
          "[data-main-activity-key]:checked"
        ),
      ].map((input) => input.dataset.mainActivityKey)
    );
  }

  function getSelectedMainActivitySiteNames() {
    return new Set(
      [
        ...panelRefs.mainActivitySiteList.querySelectorAll(
          "[data-main-site-name]:checked"
        ),
      ].map((input) => input.dataset.mainSiteName)
    );
  }

  function refreshMainActivityCount() {
    const all = panelRefs.mainActivityList.querySelectorAll(
      "[data-main-activity-key]"
    );
    const selected = panelRefs.mainActivityList.querySelectorAll(
      "[data-main-activity-key]:checked"
    );
    panelRefs.mainActivityCount.textContent = `${selected.length}/${all.length}`;
  }

  function refreshMainActivitySiteCount() {
    const all = panelRefs.mainActivitySiteList.querySelectorAll(
      "[data-main-site-name]"
    );
    const selected = panelRefs.mainActivitySiteList.querySelectorAll(
      "[data-main-site-name]:checked"
    );
    panelRefs.mainActivitySiteCount.textContent = `${selected.length}/${all.length}`;
  }

  function renderMainActivityOptions() {
    const optionMap = new Map();
    for (const { store, activities } of loadedMainActivityJobs) {
      for (const activity of activities) {
        if (!optionMap.has(activity.key)) {
          optionMap.set(activity.key, { activity, stores: [] });
        }
        optionMap.get(activity.key).stores.push(store.name);
      }
    }
    panelRefs.mainActivityList.textContent = "";
    const groups = new Map();
    for (const option of optionMap.values()) {
      const groupName = option.activity.activityName;
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(option);
    }
    for (const [groupName, options] of groups) {
      const section = document.createElement("section");
      section.className = "activity-group";
      const title = document.createElement("div");
      title.className = "activity-group-title";
      title.textContent = `${groupName}（${options.length}）`;
      section.appendChild(title);
      for (const { activity, stores: activityStores } of options) {
        const time = mainActivityTimeDisplay(activity);
        const timeText = `持续：${time.duration}｜开始：${time.start}｜结束：${time.end}`;
        const label = document.createElement("label");
        label.className = "choice-option main-activity-option";
        label.dataset.searchText = `${mainActivityThemeText(
          activity
        )} ${activityStores.join(" ")} ${timeText}`.toLowerCase();
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.mainActivityKey = activity.key;
        const content = document.createElement("span");
        const nameLine = document.createElement("strong");
        nameLine.textContent = `${mainActivityThemeText(activity)} · ${
          activityStores.length
        }/${loadedMainActivityJobs.length} 所选店铺`;
        const timeLine = document.createElement("small");
        timeLine.textContent = activity.isThematic
          ? `${timeText}（北京时间）`
          : timeText;
        content.append(nameLine, timeLine);
        label.append(checkbox, content);
        section.appendChild(label);
      }
      panelRefs.mainActivityList.appendChild(section);
    }
    if (!optionMap.size) {
      panelRefs.mainActivityList.innerHTML =
        '<div class="choice-empty">所选店铺没有读取到活动列表</div>';
    }
    refreshMainActivityCount();
  }

  function renderMainActivitySiteOptions() {
    const previous = getSelectedMainActivitySiteNames();
    const siteNames = [];
    const seen = new Set();
    for (const { activities } of loadedMainActivityJobs) {
      for (const activity of activities) {
        for (const site of Array.isArray(activity?.sites) ? activity.sites : []) {
          const siteName = toText(site?.siteName);
          if (!siteName || seen.has(siteName)) continue;
          seen.add(siteName);
          siteNames.push(siteName);
        }
      }
    }
    panelRefs.mainActivitySiteList.textContent = "";
    for (const siteName of siteNames) {
      const label = document.createElement("label");
      label.className = "choice-option main-site-option";
      label.dataset.searchText = siteName.toLowerCase();
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = previous.size ? previous.has(siteName) : true;
      checkbox.dataset.mainSiteName = siteName;
      const text = document.createElement("span");
      text.textContent = siteName;
      label.append(checkbox, text);
      panelRefs.mainActivitySiteList.appendChild(label);
    }
    if (!siteNames.length) {
      panelRefs.mainActivitySiteList.innerHTML =
        '<div class="choice-empty">活动列表未返回可选择的真实站点</div>';
    }
    refreshMainActivitySiteCount();
    refreshMainActivitySitePresetOptions();
  }

  function filterMainActivityOptions() {
    const keyword = toText(panelRefs.mainActivitySearch.value).toLowerCase();
    for (const option of panelRefs.mainActivityList.querySelectorAll(
      ".main-activity-option"
    )) {
      option.hidden = Boolean(keyword) && !option.dataset.searchText.includes(keyword);
    }
    for (const group of panelRefs.mainActivityList.querySelectorAll(
      ".activity-group"
    )) {
      group.hidden = !group.querySelector(".main-activity-option:not([hidden])");
    }
  }

  function filterMainActivitySiteOptions() {
    const keyword = toText(panelRefs.mainActivitySiteSearch.value).toLowerCase();
    for (const option of panelRefs.mainActivitySiteList.querySelectorAll(
      ".main-site-option"
    )) {
      option.hidden = Boolean(keyword) && !option.dataset.searchText.includes(keyword);
    }
  }

  function readMainActivitySitePresets() {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(MAIN_ACTIVITY_SITE_PRESETS_KEY) || "{}"
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const presets = {};
      for (const [name, sites] of Object.entries(parsed)) {
        const presetName = toText(name);
        if (!presetName || !Array.isArray(sites)) continue;
        presets[presetName] = [...new Set(sites.map(toText).filter(Boolean))];
      }
      return presets;
    } catch (error) {
      console.warn("[活动列表采集] 站点方案记录无法解析", error);
      return {};
    }
  }

  function refreshMainActivitySitePresetOptions(selectedName = "") {
    const presets = readMainActivitySitePresets();
    panelRefs.mainActivitySitePresetSelect.textContent = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择已保存方案";
    panelRefs.mainActivitySitePresetSelect.appendChild(placeholder);
    for (const name of Object.keys(presets).sort((a, b) =>
      a.localeCompare(b, "zh-CN")
    )) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = `${name}（${presets[name].length}）`;
      panelRefs.mainActivitySitePresetSelect.appendChild(option);
    }
    panelRefs.mainActivitySitePresetSelect.value = presets[selectedName]
      ? selectedName
      : "";
  }

  function applyMainActivitySitePreset(name) {
    const sites = readMainActivitySitePresets()[name];
    if (!sites) return;
    const selected = new Set(sites);
    let matched = 0;
    const all = panelRefs.mainActivitySiteList.querySelectorAll(
      "[data-main-site-name]"
    );
    all.forEach((input) => {
      input.checked = selected.has(input.dataset.mainSiteName);
      if (input.checked) matched += 1;
    });
    panelRefs.mainActivitySitePresetName.value = name;
    refreshMainActivitySiteCount();
    setStatus(
      !all.length
        ? "请先加载活动列表，再应用站点方案"
        : matched
        ? `已应用站点方案“${name}”：命中 ${matched}/${sites.length} 个站点`
        : `站点方案“${name}”与当前活动没有相同站点`,
      all.length && matched ? "success" : "warning"
    );
  }

  function saveMainActivitySitePreset() {
    const name = toText(panelRefs.mainActivitySitePresetName.value);
    const selectedSites = [...getSelectedMainActivitySiteNames()];
    if (!name) {
      setStatus("请先填写站点方案名称", "warning");
      return;
    }
    if (!selectedSites.length) {
      setStatus("请至少选择一个站点后再保存方案", "warning");
      return;
    }
    const presets = readMainActivitySitePresets();
    presets[name] = selectedSites;
    localStorage.setItem(
      MAIN_ACTIVITY_SITE_PRESETS_KEY,
      JSON.stringify(presets)
    );
    refreshMainActivitySitePresetOptions(name);
    setStatus(`已保存站点方案“${name}”，共 ${selectedSites.length} 个站点`, "success");
  }

  function deleteMainActivitySitePreset() {
    const name = panelRefs.mainActivitySitePresetSelect.value;
    if (!name) {
      setStatus("请先选择要删除的站点方案", "warning");
      return;
    }
    const presets = readMainActivitySitePresets();
    delete presets[name];
    localStorage.setItem(
      MAIN_ACTIVITY_SITE_PRESETS_KEY,
      JSON.stringify(presets)
    );
    panelRefs.mainActivitySitePresetName.value = "";
    refreshMainActivitySitePresetOptions();
    setStatus(`已删除站点方案“${name}”`, "success");
  }

  function invalidateLoadedMainActivities(
    message = "店铺已变化，请重新加载活动列表"
  ) {
    loadedMainActivitySignature = "";
    loadedMainActivityJobs = [];
    failedMainActivityStoreLoads = [];
    if (!panelRefs?.mainActivityList) return;
    panelRefs.mainActivityList.innerHTML =
      '<div class="choice-empty">店铺选择已变化，请重新点击“加载活动列表”</div>';
    panelRefs.mainActivitySiteList.innerHTML =
      '<div class="choice-empty">加载活动列表后读取真实站点</div>';
    panelRefs.mainActivityCount.textContent = "0/0";
    panelRefs.mainActivitySiteCount.textContent = "0/0";
    refreshMainActivitySitePresetOptions();
    if (message) setStatus(message, "idle");
    renderControlState();
  }

  async function loadMainActivityOptions() {
    const selectedStores = getSelectedStores();
    if (!selectedStores.length) throw new Error("请至少选择一个店铺");
    loadingMainActivities = true;
    loadedMainActivitySignature = "";
    loadedMainActivityJobs = [];
    failedMainActivityStoreLoads = [];
    renderControlState();
    appendLog(`开始读取 ${selectedStores.length} 个所选店铺的活动列表`);
    try {
      for (let index = 0; index < selectedStores.length; index += 1) {
        const store = selectedStores[index];
        setStatus(
          `读取店铺 ${index + 1}/${selectedStores.length}：${store.name} 的活动列表`,
          "busy"
        );
        try {
          const flattened = await fetchMainActivities(store);
          loadedMainActivityJobs.push({
            store,
            activities: flattened.activities,
          });
          appendLog(
            `${store.name}：读取到 ${flattened.activities.length} 个活动列表项目，排除 ${flattened.excludedInviteCount} 个邀约专题`,
            "success"
          );
        } catch (error) {
          failedMainActivityStoreLoads.push({
            store,
            error: readableError(error),
          });
          appendLog(
            `${store.name}：活动列表读取失败，继续其他店铺：${readableError(error)}`,
            "error"
          );
        }
      }
      if (!loadedMainActivityJobs.length) {
        throw new Error("所选店铺的活动列表都读取失败");
      }
      loadedMainActivitySignature = currentStoreSignature();
      renderMainActivityOptions();
      renderMainActivitySiteOptions();
      const uniqueActivityCount = new Set(
        loadedMainActivityJobs.flatMap((job) =>
          job.activities.map((activity) => activity.key)
        )
      ).size;
      const siteCount = panelRefs.mainActivitySiteList.querySelectorAll(
        "[data-main-site-name]"
      ).length;
      setStatus(
        `活动列表已加载：${loadedMainActivityJobs.length}/${selectedStores.length} 个店铺、${uniqueActivityCount} 个活动、${siteCount} 个站点`,
        failedMainActivityStoreLoads.length ? "warning" : "success"
      );
    } finally {
      loadingMainActivities = false;
      renderControlState();
    }
  }

  async function fetchMainActivityProducts(
    store,
    activity,
    activityIndex,
    activityTotal,
    spuIds,
    selectedSiteNames
  ) {
    const products = [];
    let completedPages = 0;
    let pageReturnedSpuCount = 0;
    let lastStillCount = "";
    let currentPageNo = 0;
    const requestedSpuIds = [...spuIds];
    const productBatches = requestedSpuIds.length
      ? chunkList(requestedSpuIds, MAIN_ACTIVITY_PRODUCT_BATCH_SIZE)
      : [null];
    const throwWithProgress = (error) => {
      if (error && typeof error === "object") {
        error.activityProgress = {
          completedPages,
          failedPageNo: currentPageNo,
          pageReturnedSpuCount,
          filteredSpuCount: products.length,
          lastStillCount,
        };
      }
      throw error;
    };

    for (let batchIndex = 0; batchIndex < productBatches.length; batchIndex += 1) {
      const productBatch = productBatches[batchIndex];
      const directFilter = Array.isArray(productBatch);
      const batchSpuSet = directFilter ? new Set(productBatch) : null;
      let searchScrollContext = "";
      let hasMore = true;
      let batchPageNo = 0;
      const seenContexts = new Set();

      while (hasMore) {
        await waitUntilRunnable();
        batchPageNo += 1;
        currentPageNo = completedPages + 1;
        if (batchPageNo > MAX_PAGES_PER_ACTIVITY) {
          throwWithProgress(
            new Error(`分页超过 ${MAX_PAGES_PER_ACTIVITY} 页，已停止该活动以避免死循环`)
          );
        }
        const batchText = directFilter
          ? `SPU 批次 ${batchIndex + 1}/${productBatches.length} · 第 ${batchPageNo} 页`
          : `全量第 ${batchPageNo} 页`;
        setStatus(
          `${store.name} · 活动 ${activityIndex}/${activityTotal} · ${batchText} · 已保留 ${products.length} 个商品`,
          "busy"
        );
        const payload = {
          activityType: activity.activityType,
          rowCount: PAGE_SIZE,
          addSite: true,
        };
        if (activity.isThematic) {
          payload.activityThematicId = apiProductId(activity.activityThematicId);
        }
        if (directFilter) {
          payload.productIds = productBatch.map(apiProductId);
          payload.productSkcExtCodes = [];
        }
        if (searchScrollContext) payload.searchScrollContext = searchScrollContext;

        let result;
        try {
          result = await requestMainActivityWithRetry(
            store,
            API_MAIN_ACTIVITY_PRODUCTS,
            payload,
            `${store.name} · ${mainActivityLogName(activity)} · ${batchText}`,
            { store, activity, pageNo: currentPageNo }
          );
        } catch (error) {
          throwWithProgress(error);
        }
        const list = Array.isArray(result?.matchList) ? result.matchList : [];
        const exactSpuList = batchSpuSet
          ? list.filter((product) => batchSpuSet.has(toText(product?.productId)))
          : list;
        const selectedList = selectedSiteNames.size
          ? exactSpuList.filter((product) =>
              (Array.isArray(product?.activitySiteInfoList)
                ? product.activitySiteInfoList
                : []
              ).some((siteInfo) =>
                selectedSiteNames.has(toText(siteInfo?.siteName))
              )
            )
          : exactSpuList;
        products.push(...selectedList);
        completedPages += 1;
        pageReturnedSpuCount += list.length;
        lastStillCount =
          result?.stillCount == null || result.stillCount === ""
            ? ""
            : Number(result.stillCount);
        hasMore = result?.hasMore === true;
        if (hasMore) {
          const nextContext = toText(result?.searchScrollContext);
          if (!nextContext) {
            throwWithProgress(new Error("分页仍有更多商品，但没有返回下一页游标"));
          }
          if (seenContexts.has(nextContext)) {
            throwWithProgress(new Error("分页游标重复，已停止该活动以避免死循环"));
          }
          seenContexts.add(nextContext);
          searchScrollContext = nextContext;
        }
        appendMainActivityLog(
          `${store.name} · 活动 ${activityIndex}/${activityTotal} · ${batchText}：接口返回 SPU ${list.length} 个${
            directFilter ? `，前置查询 ${productBatch.length} 个指定 SPU` : ""
          }${
            selectedSiteNames.size ? `，命中所选站点 ${selectedList.length} 个` : ""
          }${hasMore && list.length === 0 ? "；本页无返回，继续游标" : ""}`,
          "info",
          { store, activity, pageNo: currentPageNo }
        );
      }
    }
    return {
      products,
      completedPages,
      failedPageNo: "",
      pageReturnedSpuCount,
      filteredSpuCount: products.length,
      lastStillCount,
      requestedSpuCount: requestedSpuIds.length,
      directFilter: requestedSpuIds.length > 0,
      batchCount: productBatches.length,
    };
  }

  function mainActivityExactProperty(properties, name) {
    if (!properties || typeof properties !== "object") return "";
    const value = properties[name];
    return Array.isArray(value) ? listText(value) : toText(value);
  }

  function buildMainActivityRows(store, activity, products, selectedSiteNames) {
    const currentPriceRows = [];
    const currentStockRows = [];
    const stockKeys = new Set();
    const siteNames = new Set();
    let missingPriceCount = 0;
    let missingStockCount = 0;
    let incompleteHierarchyCount = 0;
    const themeText = mainActivityThemeText(activity);

    for (const product of products) {
      const productId = toText(product?.productId);
      const allSiteInfos = Array.isArray(product?.activitySiteInfoList)
        ? product.activitySiteInfoList
        : [];
      const siteInfos = selectedSiteNames.size
        ? allSiteInfos.filter((siteInfo) =>
            selectedSiteNames.has(toText(siteInfo?.siteName))
          )
        : allSiteInfos;
      if (selectedSiteNames.size && !siteInfos.length) continue;

      const stockKey = `${store.mallId}|${activity.key}|${productId}`;
      if (productId && !stockKeys.has(stockKey)) {
        stockKeys.add(stockKey);
        const stockValue = product?.suggestActivityStock;
        if (stockValue == null || stockValue === "") missingStockCount += 1;
        currentStockRows.push({
          "活动类型(活动主题）": themeText,
          "SPU ID": productId,
          "活动库存": stockValue == null ? "" : stockValue,
        });
      }
      if (!siteInfos.length) incompleteHierarchyCount += 1;

      for (const siteInfo of siteInfos) {
        const siteName = toText(siteInfo?.siteName);
        if (siteName) siteNames.add(siteName);
        const skcList = Array.isArray(siteInfo?.skcList) ? siteInfo.skcList : [];
        if (!skcList.length) incompleteHierarchyCount += 1;
        for (const skc of skcList) {
          const skuList = Array.isArray(skc?.skuList) ? skc.skuList : [];
          if (!skuList.length) incompleteHierarchyCount += 1;
          for (const sku of skuList) {
            const suggestPrice = centsToNumber(sku?.suggestActivityPrice);
            if (suggestPrice === "") missingPriceCount += 1;
            currentPriceRows.push({
              "活动类型(活动主题）": themeText,
              "SPU ID": productId,
              "SKC ID": toText(skc?.skcId),
              "SKC货号": toText(skc?.extCode),
              "SKU ID": toText(sku?.skuId),
              "SKU货号": toText(sku?.extCode),
              "颜色属性":
                mainActivityExactProperty(sku?.properties, "颜色") ||
                mainActivityExactProperty(skc?.properties, "颜色") ||
                toText(skc?.color),
              "尺码属性":
                mainActivityExactProperty(sku?.properties, "尺码") ||
                mainActivityExactProperty(skc?.properties, "尺码"),
              "站点": siteName,
              "活动申报价格": suggestPrice,
              "币种": toText(
                sku?.currency || skc?.currency || product?.currency
              ),
              "店铺名称": store.name,
            });
          }
        }
      }
    }
    return {
      priceRows: currentPriceRows,
      stockRows: currentStockRows,
      missingPriceCount,
      missingStockCount,
      incompleteHierarchyCount,
      siteNames: [...siteNames],
    };
  }

  function appendMainActivityLog(message, type = "info", context = {}) {
    const now = new Date();
    const summary = context.summary || {};
    const row = {
      "时间": now.toLocaleString("zh-CN", { hour12: false }),
      "级别":
        type === "error"
          ? "错误"
          : type === "warning"
          ? "警告"
          : type === "success"
          ? "成功"
          : "信息",
      "店铺名称": toText(context.store?.name),
      "活动类型(活动主题）": context.activity
        ? mainActivityLogName(context.activity)
        : "",
      "任务状态": toText(summary.status),
      "需采集SPU数":
        summary.requiredSpuCount == null ? "" : summary.requiredSpuCount,
      "数量口径": toText(summary.countBasis),
      "页面实际返回SPU数":
        summary.pageReturnedSpuCount == null
          ? ""
          : summary.pageReturnedSpuCount,
      "筛选后实际采集SPU数":
        summary.filteredSpuCount == null ? "" : summary.filteredSpuCount,
      "完成页数":
        summary.completedPages == null ? "" : summary.completedPages,
      "失败页码":
        summary.failedPageNo == null ? "" : summary.failedPageNo,
      "候选池待扫描":
        summary.lastStillCount == null ? "" : summary.lastStillCount,
      "价格行数":
        summary.priceRowCount == null ? "" : summary.priceRowCount,
      "库存行数":
        summary.stockRowCount == null ? "" : summary.stockRowCount,
      "页码": context.pageNo == null ? "" : context.pageNo,
      "日志内容": message,
    };
    Object.defineProperty(row, "__activityTaskKey", {
      value: mainActivityTaskKey(context.store, context.activity),
      enumerable: false,
    });
    mainActivityLogRows.push(row);
    appendLog(message, type);
    if (type === "error" && panelRefs?.logDetails) {
      panelRefs.logDetails.open = true;
    }
  }

  function downloadMainActivityWorkbook(partial = false) {
    if (
      !mainActivityPriceRows.length &&
      !mainActivityStockRows.length &&
      !mainActivityLogRows.length
    ) {
      throw new Error("当前没有可下载的活动列表采集数据");
    }
    const xlsx = typeof XLSX !== "undefined" ? XLSX : PAGE_WIN.XLSX;
    if (!xlsx) throw new Error("Excel 组件未加载，请刷新页面后重试");
    const problemLogs = mainActivityLogRows.filter(
      (row) =>
        row.__activityTaskKey &&
        mainActivityProblemKeys.has(row.__activityTaskKey)
    );
    const priceSheet = xlsx.utils.json_to_sheet(mainActivityPriceRows, {
      header: MAIN_ACTIVITY_PRICE_HEADERS,
    });
    const stockSheet = xlsx.utils.json_to_sheet(mainActivityStockRows, {
      header: MAIN_ACTIVITY_STOCK_HEADERS,
    });
    const logSheet = xlsx.utils.json_to_sheet(problemLogs, {
      header: MAIN_ACTIVITY_LOG_HEADERS,
    });
    autosizeSheet(
      priceSheet,
      mainActivityPriceRows,
      MAIN_ACTIVITY_PRICE_HEADERS
    );
    autosizeSheet(
      stockSheet,
      mainActivityStockRows,
      MAIN_ACTIVITY_STOCK_HEADERS
    );
    autosizeSheet(logSheet, problemLogs, MAIN_ACTIVITY_LOG_HEADERS);
    forceIdentifierText(
      xlsx,
      priceSheet,
      MAIN_ACTIVITY_PRICE_HEADERS,
      mainActivityPriceRows.length,
      ["SPU ID", "SKC ID", "SKC货号", "SKU ID", "SKU货号"]
    );
    forceIdentifierText(
      xlsx,
      stockSheet,
      MAIN_ACTIVITY_STOCK_HEADERS,
      mainActivityStockRows.length,
      ["SPU ID"]
    );
    setNumberFormat(
      xlsx,
      priceSheet,
      MAIN_ACTIVITY_PRICE_HEADERS,
      mainActivityPriceRows.length,
      "活动申报价格",
      "0.00"
    );
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, priceSheet, "活动申报价格");
    xlsx.utils.book_append_sheet(workbook, stockSheet, "活动库存");
    xlsx.utils.book_append_sheet(workbook, logSheet, "采集日志");
    xlsx.writeFile(
      workbook,
      `Temu报名信息合并_${partial ? "部分结果_" : ""}${timestampForFile()}.xlsx`,
      { compression: true }
    );
  }

  async function runMainActivityCollection() {
    const selectedStores = getSelectedStores();
    if (!selectedStores.length) throw new Error("请至少选择一个店铺");
    if (
      !loadedMainActivityJobs.length ||
      loadedMainActivitySignature !== currentStoreSignature()
    ) {
      throw new Error("店铺选择已变化，请先重新加载活动列表");
    }
    const selectedKeys = getSelectedMainActivityKeys();
    if (!selectedKeys.size) throw new Error("请至少选择一个活动");
    const availableSiteCount =
      panelRefs.mainActivitySiteList.querySelectorAll(
        "[data-main-site-name]"
      ).length;
    const selectedSiteNames = getSelectedMainActivitySiteNames();
    if (availableSiteCount && !selectedSiteNames.size) {
      throw new Error("请至少选择一个站点");
    }
    const spuIds = new Set(parseSpuIds(panelRefs.mainActivitySpuInput.value));

    mainActivityPriceRows = [];
    mainActivityStockRows = [];
    mainActivityLogRows = [];
    mainActivityProblemKeys = new Set();
    mainActivityFailures = [];
    mainActivityMissingPriceCount = 0;
    mainActivityMissingStockCount = 0;
    stopRequested = false;
    paused = false;
    lastRequestAt = 0;
    renderControlState();

    const selectedStoreIds = new Set(
      selectedStores.map((store) => store.mallId)
    );
    const storeJobs = loadedMainActivityJobs
      .filter(({ store }) => selectedStoreIds.has(store.mallId))
      .map(({ store, activities }) => ({
        store,
        activities: activities.filter((activity) =>
          selectedKeys.has(activity.key)
        ),
      }))
      .filter((job) => job.activities.length);
    const activityTotal = storeJobs.reduce(
      (sum, job) => sum + job.activities.length,
      0
    );
    if (!activityTotal) {
      throw new Error("所选店铺没有对应的已选活动");
    }
    let completed = 0;
    updateProgress(0, activityTotal, 0);
    appendLog(
      `开始活动列表采集：${activityTotal} 个店铺活动任务；SPU ${
        spuIds.size
          ? `${spuIds.size} 个（接口前置筛选，每批最多 ${MAIN_ACTIVITY_PRODUCT_BATCH_SIZE} 个）`
          : "全部（完整游标）"
      }；站点 ${selectedSiteNames.size || "不限"}`
    );

    for (const { store, activities } of storeJobs) {
      for (let index = 0; index < activities.length; index += 1) {
        await waitUntilRunnable();
        const activity = activities[index];
        const label = mainActivityLogName(activity);
        appendMainActivityLog(
          `开始 ${store.name} · ${index + 1}/${activities.length}：${label}`,
          "info",
          { store, activity }
        );
        try {
          const result = await fetchMainActivityProducts(
            store,
            activity,
            index + 1,
            activities.length,
            spuIds,
            selectedSiteNames
          );
          const activityRows = buildMainActivityRows(
            store,
            activity,
            result.products,
            selectedSiteNames
          );
          mainActivityPriceRows.push(...activityRows.priceRows);
          mainActivityStockRows.push(...activityRows.stockRows);
          mainActivityMissingPriceCount += activityRows.missingPriceCount;
          mainActivityMissingStockCount += activityRows.missingStockCount;
          const hasIssue = Boolean(
            activityRows.missingPriceCount ||
              activityRows.missingStockCount ||
              activityRows.incompleteHierarchyCount
          );
          if (hasIssue) {
            mainActivityProblemKeys.add(mainActivityTaskKey(store, activity));
          }
          appendMainActivityLog(
            `活动汇总｜${
              hasIssue ? "全部采集完成（存在字段缺失）" : "全部采集完成"
            }｜${store.name} · ${label}：${
              result.directFilter
                ? `接口按 ${result.requestedSpuCount} 个指定 SPU 前置筛选，分 ${result.batchCount} 批；`
                : "完整读取接口游标；"
            }页面实际返回 SPU ${
              result.pageReturnedSpuCount
            } 个，筛选后实际采集 SPU ${result.filteredSpuCount} 个，完成 ${
              result.completedPages
            } 页，价格 ${activityRows.priceRows.length} 行，库存 ${
              activityRows.stockRows.length
            } 行`,
            hasIssue ? "warning" : "success",
            {
              store,
              activity,
              summary: {
                status: hasIssue
                  ? "全部采集完成（存在字段缺失）"
                  : "全部采集完成",
                requiredSpuCount: result.directFilter
                  ? result.requestedSpuCount
                  : result.pageReturnedSpuCount,
                countBasis: result.directFilter
                  ? `接口 productIds 前置筛选；每批最多 ${MAIN_ACTIVITY_PRODUCT_BATCH_SIZE} 个，全部批次到 hasMore=false`
                  : "完整游标到 hasMore=false 后按页面实际返回确认",
                pageReturnedSpuCount: result.pageReturnedSpuCount,
                filteredSpuCount: result.filteredSpuCount,
                completedPages: result.completedPages,
                failedPageNo: "",
                lastStillCount: result.lastStillCount,
                priceRowCount: activityRows.priceRows.length,
                stockRowCount: activityRows.stockRows.length,
              },
            }
          );
          if (hasIssue) {
            appendMainActivityLog(
              `${label}：价格缺失 ${activityRows.missingPriceCount} 行，库存缺失 ${activityRows.missingStockCount} 行，层级缺失 ${activityRows.incompleteHierarchyCount} 处；缺失值留空`,
              "error",
              { store, activity }
            );
          }
        } catch (error) {
          const stopped = stopRequested || error instanceof StopError;
          const progress = error?.activityProgress || {
            completedPages: 0,
            failedPageNo: "",
            pageReturnedSpuCount: 0,
            filteredSpuCount: 0,
            lastStillCount: "",
          };
          mainActivityFailures.push({
            store,
            activity,
            error: stopped ? "用户停止" : readableError(error),
            progress,
          });
          mainActivityProblemKeys.add(mainActivityTaskKey(store, activity));
          appendMainActivityLog(
            `活动汇总｜部分数据未采集｜${store.name} · ${label}：完成 ${
              progress.completedPages
            } 页，失败页 ${progress.failedPageNo || "-"}，页面已返回 SPU ${
              progress.pageReturnedSpuCount
            } 个，筛选后已读取 SPU ${
              progress.filteredSpuCount
            } 个，候选池待扫描 ${
              progress.lastStillCount === "" ? "未知" : progress.lastStillCount
            }；未完成原因：${
              stopped ? "用户停止" : readableError(error)
            }。该活动不写入价格和库存表，${
              stopped ? "任务按用户指令停止。" : "继续下一个活动。"
            }`,
            "error",
            {
              store,
              activity,
              summary: {
                status: "部分数据未采集",
                requiredSpuCount: spuIds.size || "",
                countBasis: spuIds.size
                  ? `接口 productIds 前置筛选；每批最多 ${MAIN_ACTIVITY_PRODUCT_BATCH_SIZE} 个，部分批次或游标未完成`
                  : "接口未提供且游标未完成，无法确认总数",
                pageReturnedSpuCount: progress.pageReturnedSpuCount,
                filteredSpuCount: progress.filteredSpuCount,
                completedPages: progress.completedPages,
                failedPageNo: progress.failedPageNo,
                lastStillCount: progress.lastStillCount,
                priceRowCount: 0,
                stockRowCount: 0,
              },
            }
          );
          if (stopped) throw new StopError();
        }
        completed += 1;
        updateProgress(completed, activityTotal, mainActivityPriceRows.length);
      }
    }
    const partial = mainActivityFailures.length > 0;
    downloadMainActivityWorkbook(partial);
    const successCount = activityTotal - mainActivityFailures.length;
    if (
      partial ||
      mainActivityMissingPriceCount ||
      mainActivityMissingStockCount
    ) {
      setStatus(
        `活动列表采集已下载：完整 ${successCount} 个，部分数据未采集 ${
          mainActivityFailures.length
        } 个；价格 ${mainActivityPriceRows.length} 行，库存 ${
          mainActivityStockRows.length
        } 行；详见采集日志`,
        "warning"
      );
    } else {
      setStatus(
        `活动列表采集完成并下载：价格 ${mainActivityPriceRows.length} 行，库存 ${mainActivityStockRows.length} 行`,
        "success"
      );
    }
  }

  function setStatus(text, type = "idle") {
    if (!panelRefs) return;
    panelRefs.status.textContent = text;
    panelRefs.status.dataset.type = type;
  }

  function updateProgress(current, total, rowCount) {
    if (!panelRefs) return;
    const percent = total > 0 ? Math.min(100, (current / total) * 100) : 0;
    panelRefs.progressBar.style.width = `${percent}%`;
    panelRefs.progressText.textContent = `${current}/${total}`;
    panelRefs.rowCount.textContent = `${rowCount} 行`;
  }

  function appendLog(message, type = "info") {
    if (!panelRefs) return;
    const item = document.createElement("div");
    item.className = "log-item";
    item.dataset.type = type;
    item.textContent = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${message}`;
    panelRefs.log.appendChild(item);
    while (panelRefs.log.childElementCount > 120) panelRefs.log.firstElementChild?.remove();
    panelRefs.log.scrollTop = panelRefs.log.scrollHeight;
  }

  function renderControlState() {
    if (!panelRefs) return;
    const dryRun = panelRefs.cancelDryRun.checked;
    const selectedStoreCount = getSelectedStores().length;
    const selectedActivityCount = getSelectedActivityKeys().size;
    const availableSiteCount = panelRefs.siteList.querySelectorAll("[data-site-name]").length;
    const selectedSiteCount = getSelectedSiteNames().size;
    const selectedMainActivityCount = getSelectedMainActivityKeys().size;
    const availableMainSiteCount =
      panelRefs.mainActivitySiteList.querySelectorAll("[data-main-site-name]").length;
    const selectedMainSiteCount = getSelectedMainActivitySiteNames().size;
    const loadingAny = loadingSelections || loadingMainActivities;
    const inviteReady =
      selectedStoreCount > 0 &&
      loadedInviteGroups.length > 0 &&
      loadedStoreSignature === currentStoreSignature() &&
      selectedActivityCount > 0 &&
      (!availableSiteCount || selectedSiteCount > 0);
    const mainActivityReady =
      selectedStoreCount > 0 &&
      loadedMainActivityJobs.length > 0 &&
      loadedMainActivitySignature === currentStoreSignature() &&
      selectedMainActivityCount > 0 &&
      (!availableMainSiteCount || selectedMainSiteCount > 0);
    const cancelReady =
      cancelCsvRows.length > 0 && (dryRun || Boolean(toText(panelRefs.cancelReason?.value)));
    panelRefs.loadMainActivities.disabled =
      running || loadingAny || selectedStoreCount === 0;
    panelRefs.startMainActivity.disabled =
      running || loadingAny || !mainActivityReady;
    panelRefs.loadInvite.disabled = running || loadingAny || selectedStoreCount === 0;
    panelRefs.start.disabled = running || loadingAny || !inviteReady;
    panelRefs.startActivity.disabled = running || loadingAny || selectedStoreCount === 0;
    panelRefs.executeCancel.disabled =
      running || loadingAny || !cancelReady || !stores.length;
    panelRefs.executeCancel.textContent = dryRun ? "试跑退出清单" : "提交批量退出";
    panelRefs.executeCancel.classList.toggle("primary", dryRun);
    panelRefs.executeCancel.classList.toggle("danger-fill", !dryRun);
    panelRefs.pause.disabled = !running;
    panelRefs.stop.disabled = !running;
    panelRefs.spuInput.disabled = running;
    panelRefs.mainActivitySpuInput.disabled = running || loadingAny;
    panelRefs.cancelFile.disabled = running || loadingAny || !stores.length;
    panelRefs.cancelDryRun.disabled = running;
    panelRefs.cancelReason.disabled = running || dryRun;
    panelRefs.cancelReason.placeholder = dryRun ? "试跑无需填写" : "例如：亏损";
    panelRefs.statusChecks.forEach((checkbox) => {
      checkbox.disabled = running;
    });
    panelRefs.storeList
      .querySelectorAll("[data-store-id]")
      .forEach((checkbox) => (checkbox.disabled = running || loadingAny));
    panelRefs.activityList
      .querySelectorAll("[data-activity-key]")
      .forEach((checkbox) => (checkbox.disabled = running || loadingAny));
    panelRefs.siteList
      .querySelectorAll("[data-site-name]")
      .forEach((checkbox) => (checkbox.disabled = running || loadingAny));
    panelRefs.mainActivityList
      .querySelectorAll("[data-main-activity-key]")
      .forEach((checkbox) => (checkbox.disabled = running || loadingAny));
    panelRefs.mainActivitySiteList
      .querySelectorAll("[data-main-site-name]")
      .forEach((checkbox) => (checkbox.disabled = running || loadingAny));
    for (const control of [
      panelRefs.storeSelectAll,
      panelRefs.storeClear,
      panelRefs.activitySearch,
      panelRefs.activitySelectVisible,
      panelRefs.activityClear,
      panelRefs.siteSearch,
      panelRefs.siteSelectVisible,
      panelRefs.siteClear,
      panelRefs.mainActivitySearch,
      panelRefs.mainActivitySelectVisible,
      panelRefs.mainActivityClear,
      panelRefs.mainActivitySiteSearch,
      panelRefs.mainActivitySiteSelectVisible,
      panelRefs.mainActivitySiteClear,
      panelRefs.mainActivitySitePresetSelect,
      panelRefs.mainActivitySitePresetName,
      panelRefs.mainActivitySitePresetSave,
      panelRefs.mainActivitySitePresetDelete,
    ]) {
      if (control) control.disabled = running || loadingAny;
    }
    panelRefs.pause.textContent = paused ? "继续" : "暂停";
    panelRefs.download.disabled = running || rows.length === 0;
    panelRefs.downloadMainActivity.disabled =
      running ||
      (!mainActivityPriceRows.length &&
        !mainActivityStockRows.length &&
        !mainActivityLogRows.length);
    panelRefs.downloadActivity.disabled = running || activityDetailRows.length === 0;
    panelRefs.downloadCancelResult.disabled = running || cancelResultRows.length === 0;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampRoot(host) {
    const rect = host.getBoundingClientRect();
    const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - rect.width - 8));
    const top = clamp(rect.top, 8, Math.max(8, window.innerHeight - rect.height - 8));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
    localStorage.setItem(POSITION_KEY, JSON.stringify({ left, top }));
  }

  function loadPosition() {
    try {
      const value = JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
      if (Number.isFinite(value?.left) && Number.isFinite(value?.top)) return value;
    } catch (error) {
      console.warn("[活动邀约采集] 面板位置记录无法解析", error);
    }
    return { left: 24, top: 120 };
  }

  function bindDrag(handle, host, options = {}) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (
        options.allowInteractive !== true &&
        event.target.closest("button, input, select, textarea, a")
      ) {
        return;
      }
      dragging = true;
      moved = false;
      const rect = host.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.hypot(dx, dy) > 5) moved = true;
      host.style.left = `${startLeft + dx}px`;
      host.style.top = `${startTop + dy}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      clampRoot(host);
      event.preventDefault();
    });

    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (error) {
        console.debug("[活动邀约采集] 指针已提前释放", error);
      }
      clampRoot(host);
      if (typeof options.onEnd === "function") options.onEnd(moved);
      event.preventDefault();
    };

    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  function createPanel() {
    const host = document.createElement("div");
    host.id = "tm-marketing-invite-export-host";
    const position = loadPosition();
    Object.assign(host.style, {
      position: "fixed",
      zIndex: "2147483647",
      left: `${position.left}px`,
      top: `${position.top}px`,
    });
    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        *, *::before, *::after { box-sizing: border-box; }
        button, textarea, input { font: inherit; }
        .shell {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif;
          color: #1d1d1f;
          font-size: 13px;
          line-height: 1.45;
        }
        .bubble {
          width: 64px;
          height: 64px;
          display: grid;
          place-items: center;
          border: 2px solid rgba(255,255,255,.9);
          border-radius: 999px;
          background: #0a66d9;
          color: #fff;
          box-shadow: 0 8px 24px rgba(0, 64, 160, .35), 0 0 0 1px rgba(0,0,0,.18);
          font-weight: 700;
          font-size: 12px;
          line-height: 1.15;
          letter-spacing: .02em;
          text-align: center;
          cursor: grab;
          user-select: none;
          touch-action: none;
        }
        .bubble:active { cursor: grabbing; transform: scale(.97); }
        .bubble:hover { background: #075abf; }
        .bubble:focus-visible,
        button:focus-visible {
          outline: 3px solid rgba(10, 102, 217, .28);
          outline-offset: 2px;
        }
        .panel {
          width: min(1160px, calc(100vw - 16px));
          height: min(800px, calc(100vh - 16px));
          overflow: hidden;
          display: flex;
          flex-direction: column;
          border: 1px solid rgba(0,0,0,.12);
          border-radius: 15px;
          background: #fff;
          box-shadow: 0 18px 44px rgba(0,0,0,.18);
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          min-height: 44px;
          padding: 7px 10px 7px 13px;
          border-bottom: 1px solid #ececef;
          background: #fbfbfc;
          cursor: grab;
          user-select: none;
          touch-action: none;
        }
        .header:active { cursor: grabbing; }
        .title { font-weight: 700; font-size: 14px; }
        .version { margin-left: 6px; color: #8a8a8f; font-size: 11px; font-weight: 500; }
        .icon-button {
          width: 28px;
          height: 28px;
          border: 1px solid #d9d9de;
          border-radius: 9px;
          background: #fff;
          color: #4a4a4f;
          cursor: pointer;
        }
        .icon-button:hover { background: #f1f2f4; }
        .body {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          padding: 10px;
          overflow: hidden;
        }
        .status {
          min-height: 32px;
          padding: 7px 9px;
          border: 1px solid #e1e6ed;
          border-radius: 10px;
          background: #f6f8fb;
          color: #4b5563;
          overflow-wrap: anywhere;
        }
        .status[data-type="busy"] { color: #075abf; background: #f0f6ff; border-color: #cfe2ff; }
        .status[data-type="success"] { color: #18753c; background: #f0faf4; border-color: #cdebd8; }
        .status[data-type="warning"] { color: #8a5300; background: #fff8ea; border-color: #f0ddaf; }
        .status[data-type="error"] { color: #b42318; background: #fff3f2; border-color: #f2c9c5; }
        .filters {
          display: grid;
          gap: 7px;
          padding: 10px;
          border: 1px solid #e3e5e8;
          border-radius: 10px;
          background: #fbfbfc;
        }
        .field-label { color: #4d5158; font-size: 12px; font-weight: 700; }
        .workspace {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(190px, .52fr) minmax(0, 2.48fr);
          gap: 10px;
          margin-top: 9px;
        }
        .store-field,
        .right-workspace {
          min-height: 0;
          display: flex;
          flex-direction: column;
          border: 1px solid #e3e5e8;
          border-radius: 11px;
          background: #fbfbfc;
          overflow: hidden;
        }
        .store-field { padding: 8px; }
        .field-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 7px;
        }
        .store-tools,
        .choice-tools {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
        }
        .choice-tools.search-tools { grid-template-columns: minmax(0, 1fr) auto auto; }
        .choice-list {
          flex: 1;
          min-height: 0;
          margin-top: 7px;
          padding: 7px;
          overflow: auto;
          border: 1px solid #e1e4e8;
          border-radius: 9px;
          background: #fff;
          scrollbar-width: thin;
        }
        .choice-option {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: start;
          gap: 8px;
          padding: 6px 5px;
          border-radius: 7px;
          cursor: pointer;
          user-select: none;
        }
        .choice-option:hover { background: #eef4fc; }
        .choice-option input { width: 15px; height: 15px; margin: 2px 0 0; accent-color: #0a66d9; }
        .choice-option span { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
        .choice-option strong { display: block; color: #303238; font-size: 12px; line-height: 1.45; }
        .choice-option small { display: block; margin-top: 3px; color: #85888f; font-size: 10px; line-height: 1.35; }
        .rule-badge {
          display: inline-flex;
          width: fit-content;
          margin-top: 5px;
          padding: 2px 7px;
          border: 1px solid;
          border-radius: 999px;
          font-style: normal;
          font-size: 10px;
          font-weight: 700;
          line-height: 1.4;
        }
        .rule-stack { border-color: #a9dfbf; background: #eefaf3; color: #18753c; }
        .rule-extra { border-color: #f0d59c; background: #fff8e8; color: #8a5300; }
        .rule-unknown { border-color: #d8dbe0; background: #f5f6f8; color: #62666d; }
        .choice-option .rule-note { color: #5f646c; }
        .activity-group + .activity-group { margin-top: 9px; }
        .activity-group-title {
          position: sticky;
          top: -7px;
          z-index: 1;
          padding: 5px;
          background: rgba(255,255,255,.96);
          color: #6b7078;
          font-size: 11px;
          font-weight: 750;
        }
        .choice-empty { padding: 16px 6px; color: #8a8d93; text-align: center; }
        .mini-button {
          min-height: 28px;
          padding: 4px 7px;
          border: 1px solid #d4d7dc;
          border-radius: 8px;
          background: #fff;
          color: #4a4d53;
          cursor: pointer;
        }
        .mini-button:hover:not(:disabled) { background: #f5f6f8; }
        .mini-button:disabled { opacity: .42; cursor: not-allowed; }
        .search-input {
          width: 100%;
          min-width: 0;
          min-height: 28px;
          padding: 4px 7px;
          border: 1px solid #d4d7dc;
          border-radius: 8px;
          background: #fff;
          color: #303238;
        }
        .tabs {
          flex: none;
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 5px;
          padding: 7px;
          border-bottom: 1px solid #e3e5e8;
          background: #f4f5f7;
        }
        .tab-button {
          min-height: 30px;
          border: 1px solid transparent;
          border-radius: 8px;
          background: transparent;
          color: #62666d;
          font-weight: 650;
          cursor: pointer;
        }
        .tab-button[aria-selected="true"] {
          border-color: #d9e6f7;
          background: #fff;
          color: #075abf;
          box-shadow: 0 1px 3px rgba(0,0,0,.06);
        }
        .tab-panel {
          flex: 1;
          min-height: 0;
          padding: 10px;
          overflow: hidden;
        }
        .invite-grid {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(0, 1.45fr) minmax(200px, .75fr);
          gap: 10px;
        }
        .main-activity-grid {
          grid-template-columns: minmax(0, 2.1fr) minmax(220px, .8fr);
        }
        .main-activity-option { padding-block: 7px; }
        .main-activity-option strong { font-size: 13px; line-height: 1.5; }
        .main-activity-option small { font-size: 11px; line-height: 1.45; }
        .invite-field {
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .tab-stack {
          height: 100%;
          display: flex;
          flex-direction: column;
          gap: 9px;
        }
        .tab-stack .filters { overflow: auto; }
        .activity-detail-grid,
        .cancel-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 10px;
          min-height: 0;
        }
        .activity-detail-grid { flex: 1; }
        .activity-detail-grid.main-activity-extra { flex: none; }
        .cancel-grid { flex: 1; }
        .status-options { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
        .check-option {
          display: flex;
          align-items: center;
          gap: 6px;
          min-height: 26px;
          color: #43464d;
          cursor: pointer;
          user-select: none;
        }
        .check-option input { width: 15px; height: 15px; margin: 0; accent-color: #0a66d9; }
        .mode-option {
          min-height: 36px;
          padding: 7px 9px;
          border: 1px solid #cfe2ff;
          border-radius: 8px;
          background: #f0f6ff;
          color: #075abf;
          font-weight: 650;
        }
        .spu-input {
          width: 100%;
          min-height: 54px;
          resize: vertical;
          padding: 7px 8px;
          border: 1px solid #d4d7dc;
          border-radius: 8px;
          background: #fff;
          color: #303238;
          line-height: 1.4;
        }
        .spu-input::placeholder { color: #9a9da3; }
        .main-activity-fast-filter {
          display: grid;
          grid-template-columns: auto minmax(260px, 1.5fr) minmax(220px, 1fr);
          align-items: center;
          gap: 8px;
          padding: 7px 8px;
          border: 1px solid #cfe0f6;
          border-radius: 9px;
          background: #f6f9fd;
        }
        .main-activity-fast-filter .spu-input {
          min-height: 40px;
          max-height: 72px;
          resize: vertical;
        }
        .main-activity-fast-filter .field-hint { line-height: 1.45; }
        .text-input,
        .file-input {
          width: 100%;
          min-height: 34px;
          padding: 7px 8px;
          border: 1px solid #d4d7dc;
          border-radius: 8px;
          background: #fff;
          color: #303238;
        }
        .file-input { padding: 5px 6px; font-size: 11px; }
        .file-input::file-selector-button {
          margin-right: 8px;
          padding: 5px 8px;
          border: 0;
          border-radius: 6px;
          background: #edf3fb;
          color: #075abf;
          font-weight: 650;
          cursor: pointer;
        }
        .cancel-preview {
          min-height: 54px;
          max-height: 138px;
          padding: 8px;
          overflow: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          border: 1px solid #dfe3e8;
          border-radius: 8px;
          background: #fff;
          color: #5b6068;
          font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .cancel-preview[data-type="success"] { border-color: #cdebd8; background: #f6fcf8; }
        .cancel-preview[data-type="error"] { border-color: #f2c9c5; background: #fff7f6; color: #9f2d23; }
        .spu-input:focus-visible,
        .text-input:focus-visible,
        .file-input:focus-visible,
        .check-option input:focus-visible {
          outline: 3px solid rgba(10, 102, 217, .22);
          outline-offset: 1px;
          border-color: #0a66d9;
        }
        .field-hint { color: #85888f; font-size: 10px; }
        .feature-title { color: #303238; font-size: 12px; font-weight: 750; }
        .task-actions {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 7px;
        }
        .preset-tools {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto;
          gap: 6px;
        }
        .preset-tools select,
        .preset-tools input {
          min-width: 0;
          min-height: 28px;
          padding: 4px 7px;
          border: 1px solid #d4d7dc;
          border-radius: 8px;
          background: #fff;
          color: #303238;
        }
        .progress-row {
          display: grid;
          grid-template-columns: 1fr auto auto;
          align-items: center;
          gap: 8px;
          margin: 8px 1px;
          color: #6b7280;
          font-size: 12px;
        }
        .progress-track { height: 6px; overflow: hidden; border-radius: 999px; background: #e7ebf0; }
        .progress-bar { width: 0; height: 100%; border-radius: inherit; background: #0a66d9; transition: width .18s ease; }
        .actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
        .secondary-actions { display: grid; grid-template-columns: 1fr; gap: 7px; }
        .button {
          min-height: 30px;
          padding: 5px 9px;
          border: 1px solid #d4d7dc;
          border-radius: 9px;
          background: #fff;
          color: #303238;
          font-weight: 600;
          cursor: pointer;
        }
        .button:hover:not(:disabled) { background: #f5f6f8; }
        .button:active:not(:disabled) { transform: translateY(1px); }
        .button.primary { border-color: #0a66d9; background: #0a66d9; color: #fff; }
        .button.primary:hover:not(:disabled) { background: #075abf; }
        .button.danger { color: #b42318; }
        .button.danger-fill { border-color: #d92d20; background: #d92d20; color: #fff; }
        .button.danger-fill:hover:not(:disabled) { background: #b42318; }
        .button:disabled { opacity: .42; cursor: not-allowed; }
        .log-wrap {
          flex: none;
          margin-top: 8px;
          overflow: hidden;
          border: 1px solid #e3e5e8;
          border-radius: 10px;
          background: #fafafa;
        }
        .log-wrap summary {
          padding: 7px 9px;
          color: #555960;
          font-weight: 650;
          cursor: pointer;
          user-select: none;
        }
        .log {
          height: 105px;
          padding: 8px 9px;
          overflow: auto;
          border-top: 1px solid #e3e5e8;
          background: #fff;
          color: #585b61;
          font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
          scrollbar-width: thin;
        }
        .log-item + .log-item { margin-top: 3px; }
        .log-item[data-type="success"] { color: #18753c; }
        .log-item[data-type="error"] { color: #b42318; }
        .note { margin-top: 6px; color: #777b82; font-size: 11px; }
        [hidden] { display: none !important; }
        @media (max-width: 720px) {
          .panel { width: calc(100vw - 16px); }
          .body { padding: 11px; }
          .workspace { grid-template-columns: minmax(170px, .7fr) minmax(0, 1.3fr); }
          .invite-grid, .main-activity-grid, .activity-detail-grid, .cancel-grid { grid-template-columns: 1fr; }
          .activity-detail-grid, .cancel-grid { overflow: auto; }
          .main-activity-fast-filter { grid-template-columns: 1fr; }
          .choice-tools.search-tools { grid-template-columns: 1fr auto; }
          .choice-tools.search-tools .mini-button:last-child { grid-column: 1 / -1; }
        }
        @media (max-width: 520px) {
          .workspace { display: flex; flex-direction: column; }
          .store-field { flex: .7 1 0; }
          .right-workspace { flex: 1.3 1 0; }
          .tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .tab-panel { overflow: auto; scrollbar-width: thin; }
          .tab-stack { height: auto; min-height: 100%; }
          .main-activity-grid {
            flex: none;
            min-height: 440px;
            grid-template-rows: minmax(260px, 1.4fr) minmax(170px, .8fr);
          }
          .main-activity-grid .invite-field { min-height: 0; }
          .actions { grid-template-columns: repeat(3, 1fr); }
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { transition: none !important; animation: none !important; }
        }
      </style>
      <div class="shell">
        <button class="bubble" type="button" aria-label="展开活动采集与退出">活动<br>工具</button>
        <section class="panel" hidden aria-label="活动邀约、明细与退出面板">
          <header class="header">
            <div class="title">活动采集与精确退出<span class="version">v${SCRIPT_VERSION}</span></div>
            <button class="icon-button" type="button" data-role="collapse" aria-label="收起面板">—</button>
          </header>
          <div class="body">
            <div class="status" data-role="status" data-type="busy">正在读取当前账号可用店铺…</div>
            <div class="workspace">
              <section class="store-field">
                <div class="field-head">
                  <span class="field-label">店铺选择（采集共用）</span>
                  <span data-role="store-count">0/0</span>
                </div>
                <div class="store-tools">
                  <button class="mini-button" type="button" data-role="select-all-stores">全选店铺</button>
                  <button class="mini-button" type="button" data-role="clear-stores">清空店铺</button>
                </div>
                <div class="choice-list" data-role="store-list">
                  <div class="choice-empty">正在读取真实店铺…</div>
                </div>
              </section>
              <section class="right-workspace">
                <div class="tabs" role="tablist" aria-label="功能选择">
                  <button class="tab-button" type="button" role="tab" aria-selected="true" data-tab="main-activity">活动列表采集</button>
                  <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab="invite">邀约采集</button>
                  <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab="activity">活动明细</button>
                  <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab="cancel">活动精确退出</button>
                </div>
                <div class="tab-panel" role="tabpanel" data-tab-panel="main-activity">
                  <div class="tab-stack">
                    <div class="invite-grid main-activity-grid">
                      <section class="invite-field">
                        <div class="field-head">
                          <span class="field-label">活动列表选择</span>
                          <span data-role="main-activity-count">0/0</span>
                        </div>
                        <div class="choice-tools search-tools">
                          <input class="search-input" type="search" data-role="main-activity-search" placeholder="搜索活动名称、ID、店铺或时间">
                          <button class="mini-button" type="button" data-role="select-visible-main-activities">选中可见</button>
                          <button class="mini-button" type="button" data-role="clear-main-activities">清空</button>
                        </div>
                        <div class="choice-list" data-role="main-activity-list">
                          <div class="choice-empty">选择店铺后点击“加载活动列表”</div>
                        </div>
                      </section>
                      <section class="invite-field">
                        <div class="field-head">
                          <span class="field-label">站点选择</span>
                          <span data-role="main-activity-site-count">0/0</span>
                        </div>
                        <div class="choice-tools search-tools">
                          <input class="search-input" type="search" data-role="main-activity-site-search" placeholder="搜索站点">
                          <button class="mini-button" type="button" data-role="select-visible-main-sites">选中可见</button>
                          <button class="mini-button" type="button" data-role="clear-main-sites">清空</button>
                        </div>
                        <div class="choice-list" data-role="main-activity-site-list">
                          <div class="choice-empty">加载活动列表后读取真实站点</div>
                        </div>
                      </section>
                    </div>
                    <div class="preset-tools">
                      <select data-role="main-site-preset-select" aria-label="站点方案">
                        <option value="">选择已保存方案</option>
                      </select>
                      <input type="text" data-role="main-site-preset-name" placeholder="站点方案名称">
                      <button class="mini-button" type="button" data-role="save-main-site-preset">保存/覆盖</button>
                      <button class="mini-button" type="button" data-role="delete-main-site-preset">删除</button>
                    </div>
                    <div class="main-activity-fast-filter">
                      <label class="field-label" for="tm-main-activity-spu-input">快速指定 SPU</label>
                      <textarea class="spu-input" id="tm-main-activity-spu-input" data-role="main-activity-spu-input" placeholder="多个 ID 可用换行、空格或逗号分隔；留空采集全部"></textarea>
                      <div class="field-hint">填写后按每批最多 50 个 SPU 直接查询所选活动，不再先读取活动全部商品；留空仍完整读取游标。</div>
                    </div>
                    <div class="task-actions">
                      <button class="button" type="button" data-role="load-main-activities">加载活动列表</button>
                      <button class="button primary" type="button" data-role="start-main-activity">采集所选活动</button>
                      <button class="button" type="button" data-role="download-main-activity" disabled>下载活动列表结果</button>
                    </div>
                  </div>
                </div>
                <div class="tab-panel" role="tabpanel" data-tab-panel="invite" hidden>
                  <div class="tab-stack">
                    <div class="invite-grid">
                      <section class="invite-field">
                        <div class="field-head">
                          <span class="field-label">邀约活动选择</span>
                          <span data-role="activity-count">0/0</span>
                        </div>
                        <div class="choice-tools search-tools">
                          <input class="search-input" type="search" data-role="activity-search" placeholder="搜索活动名称或 ID">
                          <button class="mini-button" type="button" data-role="select-visible-activities">选中可见</button>
                          <button class="mini-button" type="button" data-role="clear-activities">清空</button>
                        </div>
                        <div class="choice-list" data-role="activity-list">
                          <div class="choice-empty">选择店铺后点击“加载邀约活动”</div>
                        </div>
                      </section>
                      <section class="invite-field">
                        <div class="field-head">
                          <span class="field-label">站点选择</span>
                          <span data-role="site-count">0/0</span>
                        </div>
                        <div class="choice-tools search-tools">
                          <input class="search-input" type="search" data-role="site-search" placeholder="搜索站点">
                          <button class="mini-button" type="button" data-role="select-visible-sites">选中可见</button>
                          <button class="mini-button" type="button" data-role="clear-sites">清空</button>
                        </div>
                        <div class="choice-list" data-role="site-list">
                          <div class="choice-empty">加载活动后读取真实站点</div>
                        </div>
                      </section>
                    </div>
                    <div class="task-actions">
                      <button class="button" type="button" data-role="load-invite">加载邀约活动</button>
                      <button class="button primary" type="button" data-role="start">采集所选邀约</button>
                      <button class="button" type="button" data-role="download" disabled>下载邀约结果</button>
                    </div>
                    <div class="field-hint">活动名称显示真实持续天数及开始、结束时间；导出按所选店铺、活动和站点保留。</div>
                  </div>
                </div>
                <div class="tab-panel" role="tabpanel" data-tab-panel="activity" hidden>
                  <div class="tab-stack">
                    <div class="activity-detail-grid">
                      <div class="filters">
                        <div class="feature-title">活动状态</div>
                        <div class="status-options" data-role="status-options">
                          ${ACTIVITY_STATUS_OPTIONS.map(
                            (option) => `<label class="check-option"><input type="checkbox" value="${
                              option.value
                            }" ${option.defaultSelected ? "checked" : ""}>${option.label}</label>`
                          ).join("")}
                        </div>
                        <div class="field-hint">默认未开始和进行中；本功能只读取左侧勾选店铺。</div>
                      </div>
                      <div class="filters">
                        <label class="field-label" for="tm-invite-spu-input">SPU ID（可选）</label>
                        <textarea class="spu-input" id="tm-invite-spu-input" data-role="spu-input" placeholder="多个 ID 可用换行、空格或逗号分隔"></textarea>
                        <div class="field-hint">填写后只下载这些 SPU；留空下载所选店铺及状态的全部活动明细。</div>
                      </div>
                    </div>
                    <div class="task-actions">
                      <button class="button primary" type="button" data-role="start-activity">采集活动明细</button>
                      <button class="button" type="button" data-role="download-activity" disabled>下载活动明细</button>
                    </div>
                  </div>
                </div>
                <div class="tab-panel" role="tabpanel" data-tab-panel="cancel" hidden>
                  <div class="tab-stack">
                    <div class="cancel-grid">
                      <div class="filters">
                        <div class="feature-title">CSV 活动精确退出</div>
                        <div class="field-hint">匹配 CSV 的店铺、SPU、具体活动和申报价格；CSV 外的活动不会退出。</div>
                        <input class="file-input" type="file" accept=".csv,text/csv" data-role="cancel-file">
                        <button class="button" type="button" data-role="download-cancel-template">下载空白 CSV 模板</button>
                        <label class="check-option mode-option"><input type="checkbox" data-role="cancel-dry-run" checked>试跑（只核对，不提交）</label>
                        <label class="field-label" for="tm-cancel-reason">退出原因（默认：亏损）</label>
                        <input class="text-input" id="tm-cancel-reason" data-role="cancel-reason" value="${DEFAULT_CANCEL_REASON}" placeholder="试跑无需填写" autocomplete="off" disabled>
                      </div>
                      <div class="filters">
                        <div class="feature-title">核对结果</div>
                        <div class="cancel-preview" data-role="cancel-preview">上传 CSV 后先核对，不会自动退出。</div>
                        <button class="button primary" type="button" data-role="execute-cancel" disabled>试跑退出清单</button>
                        <button class="button" type="button" data-role="download-cancel-result" disabled>下载退出结果</button>
                        <div class="field-hint">取消试跑后按钮变红，只有点击红色按钮才提交；问题项自动跳过。</div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
            <div class="progress-row">
              <div class="progress-track" aria-label="采集进度"><div class="progress-bar" data-role="progress-bar"></div></div>
              <span data-role="progress-text">0/0</span>
              <span data-role="row-count">0 行</span>
            </div>
            <div class="actions">
              <button class="button" type="button" data-role="pause" disabled>暂停</button>
              <button class="button danger" type="button" data-role="stop" disabled>停止</button>
              <button class="button" type="button" data-role="clear-log">清空日志</button>
            </div>
            <details class="log-wrap" data-role="log-details">
              <summary>运行日志</summary>
              <div class="log" data-role="log" aria-live="polite"></div>
            </details>
            <div class="note">活动列表、邀约和活动明细只读；活动精确退出默认试跑，取消试跑后仍需用户点击红色提交按钮。</div>
          </div>
        </section>
      </div>
    `;

    document.documentElement.appendChild(host);
    const bubble = shadow.querySelector(".bubble");
    const panel = shadow.querySelector(".panel");
    const header = shadow.querySelector(".header");
    panelRefs = {
      host,
      shadow,
      bubble,
      panel,
      status: shadow.querySelector("[data-role='status']"),
      progressBar: shadow.querySelector("[data-role='progress-bar']"),
      progressText: shadow.querySelector("[data-role='progress-text']"),
      rowCount: shadow.querySelector("[data-role='row-count']"),
      loadMainActivities: shadow.querySelector("[data-role='load-main-activities']"),
      startMainActivity: shadow.querySelector("[data-role='start-main-activity']"),
      downloadMainActivity: shadow.querySelector("[data-role='download-main-activity']"),
      mainActivityList: shadow.querySelector("[data-role='main-activity-list']"),
      mainActivityCount: shadow.querySelector("[data-role='main-activity-count']"),
      mainActivitySearch: shadow.querySelector("[data-role='main-activity-search']"),
      mainActivitySelectVisible: shadow.querySelector(
        "[data-role='select-visible-main-activities']"
      ),
      mainActivityClear: shadow.querySelector("[data-role='clear-main-activities']"),
      mainActivitySiteList: shadow.querySelector(
        "[data-role='main-activity-site-list']"
      ),
      mainActivitySiteCount: shadow.querySelector(
        "[data-role='main-activity-site-count']"
      ),
      mainActivitySiteSearch: shadow.querySelector(
        "[data-role='main-activity-site-search']"
      ),
      mainActivitySiteSelectVisible: shadow.querySelector(
        "[data-role='select-visible-main-sites']"
      ),
      mainActivitySiteClear: shadow.querySelector(
        "[data-role='clear-main-sites']"
      ),
      mainActivitySpuInput: shadow.querySelector(
        "[data-role='main-activity-spu-input']"
      ),
      mainActivitySitePresetSelect: shadow.querySelector(
        "[data-role='main-site-preset-select']"
      ),
      mainActivitySitePresetName: shadow.querySelector(
        "[data-role='main-site-preset-name']"
      ),
      mainActivitySitePresetSave: shadow.querySelector(
        "[data-role='save-main-site-preset']"
      ),
      mainActivitySitePresetDelete: shadow.querySelector(
        "[data-role='delete-main-site-preset']"
      ),
      loadInvite: shadow.querySelector("[data-role='load-invite']"),
      start: shadow.querySelector("[data-role='start']"),
      startActivity: shadow.querySelector("[data-role='start-activity']"),
      executeCancel: shadow.querySelector("[data-role='execute-cancel']"),
      pause: shadow.querySelector("[data-role='pause']"),
      stop: shadow.querySelector("[data-role='stop']"),
      download: shadow.querySelector("[data-role='download']"),
      downloadActivity: shadow.querySelector("[data-role='download-activity']"),
      downloadCancelResult: shadow.querySelector("[data-role='download-cancel-result']"),
      log: shadow.querySelector("[data-role='log']"),
      spuInput: shadow.querySelector("[data-role='spu-input']"),
      cancelFile: shadow.querySelector("[data-role='cancel-file']"),
      cancelDryRun: shadow.querySelector("[data-role='cancel-dry-run']"),
      cancelReason: shadow.querySelector("[data-role='cancel-reason']"),
      cancelPreview: shadow.querySelector("[data-role='cancel-preview']"),
      statusChecks: shadow.querySelectorAll("[data-role='status-options'] input[type='checkbox']"),
      storeList: shadow.querySelector("[data-role='store-list']"),
      storeCount: shadow.querySelector("[data-role='store-count']"),
      storeSelectAll: shadow.querySelector("[data-role='select-all-stores']"),
      storeClear: shadow.querySelector("[data-role='clear-stores']"),
      activityList: shadow.querySelector("[data-role='activity-list']"),
      activityCount: shadow.querySelector("[data-role='activity-count']"),
      activitySearch: shadow.querySelector("[data-role='activity-search']"),
      activitySelectVisible: shadow.querySelector("[data-role='select-visible-activities']"),
      activityClear: shadow.querySelector("[data-role='clear-activities']"),
      siteList: shadow.querySelector("[data-role='site-list']"),
      siteCount: shadow.querySelector("[data-role='site-count']"),
      siteSearch: shadow.querySelector("[data-role='site-search']"),
      siteSelectVisible: shadow.querySelector("[data-role='select-visible-sites']"),
      siteClear: shadow.querySelector("[data-role='clear-sites']"),
      logDetails: shadow.querySelector("[data-role='log-details']"),
    };

    let bubbleMoved = false;
    const setCollapsed = (collapsed) => {
      bubble.hidden = !collapsed;
      panel.hidden = collapsed;
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
      requestAnimationFrame(() => clampRoot(host));
    };

    bindDrag(bubble, host, {
      allowInteractive: true,
      onEnd: (moved) => {
        bubbleMoved = moved;
        if (moved) setTimeout(() => (bubbleMoved = false), 0);
      },
    });
    bindDrag(header, host);

    bubble.addEventListener("click", () => {
      if (bubbleMoved) return;
      setCollapsed(false);
    });
    shadow.querySelector("[data-role='collapse']").addEventListener("click", () => {
      setCollapsed(true);
    });

    for (const tabButton of shadow.querySelectorAll("[data-tab]")) {
      tabButton.addEventListener("click", () => {
        const tabName = tabButton.dataset.tab;
        shadow.querySelectorAll("[data-tab]").forEach((button) => {
          button.setAttribute("aria-selected", button === tabButton ? "true" : "false");
        });
        shadow.querySelectorAll("[data-tab-panel]").forEach((panelItem) => {
          panelItem.hidden = panelItem.dataset.tabPanel !== tabName;
        });
      });
    }

    panelRefs.storeList.addEventListener("change", () => {
      saveSelectedStoreIds();
      refreshStoreCount();
      invalidateLoadedInviteOptions("");
      invalidateLoadedMainActivities();
    });
    panelRefs.storeSelectAll.addEventListener("click", () => {
      panelRefs.storeList
        .querySelectorAll("[data-store-id]")
        .forEach((input) => (input.checked = true));
      saveSelectedStoreIds();
      refreshStoreCount();
      invalidateLoadedInviteOptions("");
      invalidateLoadedMainActivities();
    });
    panelRefs.storeClear.addEventListener("click", () => {
      panelRefs.storeList
        .querySelectorAll("[data-store-id]")
        .forEach((input) => (input.checked = false));
      saveSelectedStoreIds();
      refreshStoreCount();
      invalidateLoadedInviteOptions("");
      invalidateLoadedMainActivities();
    });
    panelRefs.loadMainActivities.addEventListener("click", async () => {
      if (running || loadingSelections || loadingMainActivities) return;
      try {
        await loadMainActivityOptions();
      } catch (error) {
        setStatus(`活动列表加载失败：${readableError(error)}`, "error");
        appendLog(`活动列表加载失败：${readableError(error)}`, "error");
      }
    });
    panelRefs.mainActivitySearch.addEventListener(
      "input",
      filterMainActivityOptions
    );
    panelRefs.mainActivityList.addEventListener("change", () => {
      refreshMainActivityCount();
      renderControlState();
    });
    panelRefs.mainActivitySelectVisible.addEventListener("click", () => {
      panelRefs.mainActivityList
        .querySelectorAll(
          ".main-activity-option:not([hidden]) [data-main-activity-key]"
        )
        .forEach((input) => (input.checked = true));
      refreshMainActivityCount();
      renderControlState();
    });
    panelRefs.mainActivityClear.addEventListener("click", () => {
      panelRefs.mainActivityList
        .querySelectorAll("[data-main-activity-key]")
        .forEach((input) => (input.checked = false));
      refreshMainActivityCount();
      renderControlState();
    });
    panelRefs.mainActivitySiteSearch.addEventListener(
      "input",
      filterMainActivitySiteOptions
    );
    panelRefs.mainActivitySiteList.addEventListener("change", () => {
      refreshMainActivitySiteCount();
      renderControlState();
    });
    panelRefs.mainActivitySiteSelectVisible.addEventListener("click", () => {
      panelRefs.mainActivitySiteList
        .querySelectorAll(
          ".main-site-option:not([hidden]) [data-main-site-name]"
        )
        .forEach((input) => (input.checked = true));
      refreshMainActivitySiteCount();
      renderControlState();
    });
    panelRefs.mainActivitySiteClear.addEventListener("click", () => {
      panelRefs.mainActivitySiteList
        .querySelectorAll("[data-main-site-name]")
        .forEach((input) => (input.checked = false));
      refreshMainActivitySiteCount();
      renderControlState();
    });
    panelRefs.mainActivitySitePresetSelect.addEventListener("change", () => {
      const name = panelRefs.mainActivitySitePresetSelect.value;
      if (name) applyMainActivitySitePreset(name);
    });
    panelRefs.mainActivitySitePresetSave.addEventListener(
      "click",
      saveMainActivitySitePreset
    );
    panelRefs.mainActivitySitePresetDelete.addEventListener(
      "click",
      deleteMainActivitySitePreset
    );
    panelRefs.loadInvite.addEventListener("click", async () => {
      if (running || loadingSelections || loadingMainActivities) return;
      try {
        await loadInviteOptions();
      } catch (error) {
        setStatus(`活动加载失败：${readableError(error)}`, "error");
        appendLog(`活动加载失败：${readableError(error)}`, "error");
      }
    });

    panelRefs.activitySearch.addEventListener("input", () => {
      filterChoiceOptions(
        panelRefs.activityList,
        ".activity-option",
        panelRefs.activitySearch.value
      );
    });
    panelRefs.activityList.addEventListener("change", () => {
      refreshActivityCount();
      renderSiteOptions(false);
      renderControlState();
    });
    panelRefs.activitySelectVisible.addEventListener("click", () => {
      panelRefs.activityList
        .querySelectorAll(".activity-option:not([hidden]) [data-activity-key]")
        .forEach((input) => (input.checked = true));
      refreshActivityCount();
      renderSiteOptions(false);
      renderControlState();
    });
    panelRefs.activityClear.addEventListener("click", () => {
      panelRefs.activityList
        .querySelectorAll("[data-activity-key]")
        .forEach((input) => (input.checked = false));
      refreshActivityCount();
      renderSiteOptions(false);
      renderControlState();
    });

    panelRefs.siteSearch.addEventListener("input", () => {
      filterChoiceOptions(panelRefs.siteList, ".site-option", panelRefs.siteSearch.value);
    });
    panelRefs.siteList.addEventListener("change", () => {
      refreshSiteCount();
      renderControlState();
    });
    panelRefs.siteSelectVisible.addEventListener("click", () => {
      panelRefs.siteList
        .querySelectorAll(".site-option:not([hidden]) [data-site-name]")
        .forEach((input) => (input.checked = true));
      refreshSiteCount();
      renderControlState();
    });
    panelRefs.siteClear.addEventListener("click", () => {
      panelRefs.siteList
        .querySelectorAll("[data-site-name]")
        .forEach((input) => (input.checked = false));
      refreshSiteCount();
      renderControlState();
    });

    const executeTask = async (mode, task) => {
      if (running) return;
      running = true;
      runningMode = mode;
      renderControlState();
      try {
        await task();
      } catch (error) {
        if (stopRequested || error instanceof StopError) {
          const retainedText =
            mode === "cancel"
              ? `退出结果 ${cancelResultRows.length} 条`
              : mode === "activity"
              ? `活动明细 ${activityDetailRows.length} 行`
              : mode === "main-activity"
              ? `活动列表价格 ${mainActivityPriceRows.length} 行、库存 ${mainActivityStockRows.length} 行`
              : `邀约明细 ${rows.length} 行`;
          const retainedAction =
            mode === "cancel" && cancelResultsAutoDownloaded
              ? "，退出结果已自动下载"
              : "，可手动下载";
          setStatus(`已停止，保留${retainedText}${retainedAction}`, "warning");
          appendLog(`任务已停止，当前保留${retainedText}`, "error");
        } else {
          const actionLabel = mode === "cancel" ? "操作" : "采集";
          setStatus(`${actionLabel}失败：${readableError(error)}`, "error");
          appendLog(`${actionLabel}失败：${readableError(error)}`, "error");
        }
      } finally {
        running = false;
        runningMode = "";
        paused = false;
        currentController = null;
        renderControlState();
      }
    };

    panelRefs.startMainActivity.addEventListener("click", () => {
      void executeTask("main-activity", runMainActivityCollection);
    });
    panelRefs.start.addEventListener("click", () => {
      void executeTask("invite", runCollection);
    });
    panelRefs.startActivity.addEventListener("click", () => {
      void executeTask("activity", runActivityDetailCollection);
    });
    panelRefs.executeCancel.addEventListener("click", () => {
      void executeTask("cancel", runCancelFlow);
    });

    panelRefs.cancelFile.addEventListener("change", async () => {
      const file = panelRefs.cancelFile.files?.[0];
      cancelCsvRows = [];
      cancelPreviewRows = [];
      cancelExecutionRows = [];
      cancelResultRows = [];
      cancelResultsAutoDownloaded = false;
      panelRefs.cancelPreview.dataset.type = "";
      if (!file) {
        panelRefs.cancelPreview.textContent = "上传 CSV 后先核对，不会自动退出。";
        renderControlState();
        return;
      }
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("CSV 不能超过 20 MB");
        const decoded = await readCsvFile(file);
        const parsed = parseCancelCsv(decoded.text);
        cancelCsvRows = parsed.rows;
        const invalidCount = cancelCsvRows.filter((row) => row.validationError).length;
        panelRefs.cancelPreview.textContent = `编码：${decoded.encoding}\n已读取 ${cancelCsvRows.length} 条唯一活动，合并 ${
          parsed.duplicateCount
        } 条重复 SKU/站点行，CSV 格式错误 ${invalidCount} 条。\n点击当前模式按钮后会重新精确核对报名ID。`;
        panelRefs.cancelPreview.dataset.type = invalidCount ? "error" : "success";
        setStatus(`CSV 已读取：${cancelCsvRows.length} 条，尚未提交退出`, "idle");
        appendLog(
          `读取 CSV：编码 ${decoded.encoding}，唯一活动 ${cancelCsvRows.length} 条，重复行 ${parsed.duplicateCount} 条，格式错误 ${invalidCount} 条`
        );
      } catch (error) {
        panelRefs.cancelPreview.textContent = readableError(error);
        panelRefs.cancelPreview.dataset.type = "error";
        setStatus(`CSV 读取失败：${readableError(error)}`, "error");
      }
      renderControlState();
    });

    panelRefs.cancelReason.addEventListener("input", renderControlState);
    panelRefs.cancelDryRun.addEventListener("change", () => {
      renderControlState();
      setStatus(
        panelRefs.cancelDryRun.checked
          ? "已切换到试跑模式：只核对，不提交"
          : "已切换到提交模式：红色按钮点击后将提交退出",
        panelRefs.cancelDryRun.checked ? "idle" : "warning"
      );
    });
    shadow.querySelector("[data-role='download-cancel-template']").addEventListener("click", async () => {
      try {
        await downloadCancelTemplate();
        appendLog("已下载空白活动退出 CSV 模板", "success");
      } catch (error) {
        const message = readableError(error);
        setStatus(`空白模板下载失败：${message}`, "error");
        appendLog(`空白活动退出 CSV 模板下载失败：${message}`, "error");
      }
    });
    panelRefs.downloadCancelResult.addEventListener("click", async () => {
      try {
        await downloadCancelResults();
        appendLog(`已下载退出结果：${cancelResultRows.length} 条`, "success");
      } catch (error) {
        setStatus(readableError(error), "error");
      }
    });

    panelRefs.pause.addEventListener("click", () => {
      if (!running) return;
      paused = !paused;
      setStatus(paused ? "已暂停，当前请求完成后停住" : "继续采集…", paused ? "warning" : "busy");
      appendLog(paused ? "已暂停" : "继续采集");
      renderControlState();
    });

    panelRefs.stop.addEventListener("click", () => {
      if (!running) return;
      stopRequested = true;
      paused = false;
      currentController?.abort();
      setStatus("正在停止…", "warning");
      appendLog(
        `收到停止指令，正在结束${
          runningMode === "activity"
            ? "活动明细"
            : runningMode === "main-activity"
            ? "活动列表采集"
            : runningMode === "cancel"
            ? "活动退出"
            : "活动邀约"
        }任务`,
        "error"
      );
      renderControlState();
    });

    panelRefs.download.addEventListener("click", () => {
      try {
        downloadWorkbook(
          rows,
          templateRows,
          running || failedActivities.length > 0 || priceLookupFailures.length > 0 || stopRequested
        );
        appendLog(
          `已下载邀约结果：完整 ${rows.length} 行，提报 ${templateRows.length} 行`,
          "success"
        );
      } catch (error) {
        setStatus(readableError(error), "error");
      }
    });

    panelRefs.downloadMainActivity.addEventListener("click", () => {
      try {
        downloadMainActivityWorkbook(
          running || mainActivityFailures.length > 0 || stopRequested
        );
        appendLog(
          `已下载活动列表结果：价格 ${mainActivityPriceRows.length} 行，库存 ${mainActivityStockRows.length} 行`,
          "success"
        );
      } catch (error) {
        setStatus(readableError(error), "error");
      }
    });

    panelRefs.downloadActivity.addEventListener("click", () => {
      try {
        downloadActivityDetailWorkbook(
          activityDetailRows,
          running || activityDetailFailures.length > 0 || stopRequested
        );
        appendLog(`已下载活动明细：${activityDetailRows.length} 行`, "success");
      } catch (error) {
        setStatus(readableError(error), "error");
      }
    });

    shadow.querySelector("[data-role='clear-log']").addEventListener("click", () => {
      panelRefs.log.textContent = "";
    });

    // 项目规则要求刷新或重新进入页面后仍默认收起。
    setCollapsed(true);
    window.addEventListener("resize", () => clampRoot(host));
    requestAnimationFrame(() => clampRoot(host));
  }

  async function bootstrap() {
    createPanel();
    renderControlState();
    try {
      stores = await fetchMallList();
      if (!stores.length) throw new Error("当前账号没有返回可用店铺");
      const availableIds = new Set(stores.map((store) => store.mallId));
      const savedIds = loadSavedStoreIds().filter((mallId) => availableIds.has(mallId));
      const pageText = toText(document.body?.innerText);
      const currentStore =
        [...stores]
          .sort((left, right) => right.name.length - left.name.length)
          .find((store) => pageText.includes(store.name)) || stores[0];
      const initialIds = savedIds.length ? savedIds : [currentStore.mallId];
      renderStoreOptions(initialIds);
      saveSelectedStoreIds();
      setStatus(
        `已读取 ${stores.length} 个可用店铺；先选择店铺，再加载活动列表或邀约活动`,
        "success"
      );
      appendLog(`当前账号读取到 ${stores.length} 个可用店铺`, "success");
    } catch (error) {
      setStatus(`店铺读取失败：${readableError(error)}`, "error");
      appendLog(`店铺读取失败：${readableError(error)}`, "error");
    }
    renderControlState();
  }

  void bootstrap();
})();
