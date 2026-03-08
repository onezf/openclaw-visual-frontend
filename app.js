const LOGICAL_MAP_WIDTH = 24;
const LOGICAL_MAP_HEIGHT = 18;
const MAP_RENDER_SCALE = 4;
const MAP_WIDTH = LOGICAL_MAP_WIDTH * MAP_RENDER_SCALE;
const MAP_HEIGHT = LOGICAL_MAP_HEIGHT * MAP_RENDER_SCALE;
const MAX_FEED_ITEMS = 12;
const ROBOT_DISPLAY_NAME = "小龙虾";
const urlParams = new URLSearchParams(window.location.search);
const externalConfig = window.OPENCLAW_CONFIG || {};
const useMock = urlParams.get("mock") === "1";
const useDemo = urlParams.get("demo") === "1";
const demoAlertEnabled = urlParams.get("demoAlert") === "1";
const endpointOverride = urlParams.get("endpoint");
const wsOverride = urlParams.get("ws");
const tasksEndpointOverride = urlParams.get("tasksEndpoint");
const runtimeEndpointOverride = urlParams.get("runtimeEndpoint");
const DEMO_STEP_DURATION_MS = Math.max(Number(urlParams.get("demoStepMs") || 5200), 2500);
const REST_ANIMATION_CYCLE_MS = 10 * 60 * 1000;
const REST_ROOM_PHASE_MS = 6 * 60 * 1000;

const CONFIG = {
  endpoint: endpointOverride || (useMock ? externalConfig.mockEndpoint || "./mock-status.json" : externalConfig.endpoint || "/api/openclaw/status"),
  wsEndpoint: (useMock || useDemo) ? "" : wsOverride || externalConfig.wsEndpoint || "",
  taskStatsEndpoint: useDemo ? "" : tasksEndpointOverride || externalConfig.taskStatsEndpoint || "",
  taskRuntimeEndpoint: useDemo ? "" : runtimeEndpointOverride || externalConfig.taskRuntimeEndpoint || "/api/tasks/runtime",
  pollIntervalMs: Math.max(Number(urlParams.get("poll") || externalConfig.pollIntervalMs || 3000), 1500),
  requestTimeoutMs: Math.max(Number(urlParams.get("timeout") || externalConfig.requestTimeoutMs || 12000), 2000),
  wsReconnectDelayMs: Math.max(Number(urlParams.get("wsReconnect") || externalConfig.wsReconnectDelayMs || 3500), 1000),
  headers: { ...(externalConfig.headers || {}) },
  apiKey: externalConfig.apiKey || "",
  authToken: externalConfig.authToken || "",
};

if (CONFIG.apiKey && !CONFIG.headers["x-api-key"] && !CONFIG.headers["X-API-Key"]) {
  CONFIG.headers["x-api-key"] = CONFIG.apiKey;
}

if (CONFIG.authToken && !CONFIG.headers.Authorization) {
  CONFIG.headers.Authorization = `Bearer ${CONFIG.authToken}`;
}

document.documentElement.style.setProperty("--map-width", String(MAP_WIDTH));
document.documentElement.style.setProperty("--map-height", String(MAP_HEIGHT));
document.documentElement.style.setProperty("--zone-rest-top", String(6 * MAP_RENDER_SCALE));
document.documentElement.style.setProperty("--zone-side-offset", String(1 * MAP_RENDER_SCALE));
document.documentElement.style.setProperty("--zone-alarm-bottom", String(2 * MAP_RENDER_SCALE));

const zoneLabels = {
  rest: "休息区",
  work: "工作区",
  alarm: "警报区",
  system: "系统",
};

const syncBadgeLabels = {
  offline: "离线",
  online: "在线",
  syncing: "同步中",
};

const modeLabels = {
  RUNNING: "运行中",
  ACTIVE: "运行中",
  IDLE: "待机中",
  STANDBY: "待命中",
  SLEEP: "休眠中",
  OFFLINE: "离线",
  ERROR: "异常",
};

const alertLabels = {
  GREEN: "正常",
  BLUE: "作业中",
  AMBER: "注意",
  RED: "警报",
  OFFLINE: "离线",
};

const sceneLabels = {
  room: "室内",
  outdoor: "室外",
};

const idleActivityLabels = {
  stay_home: "在家休息",
  walk_dog: "遛狗中",
  supermarket: "逛超市",
  walk: "外出散步",
  stroll: "外出放风",
  town: "城里闲逛",
  park: "公园散步",
  coffee: "喝咖啡",
};

const zoneAnchors = {
  rest: { x: 5, y: 11 },
  work: { x: 13, y: 7 },
  alarm: { x: 20, y: 11 },
};

const zoneRenderBounds = {
  rest: { minX: 6, maxX: 13, minY: 8, maxY: 12 },
  work: { minX: 8, maxX: 14, minY: 8, maxY: 11 },
  alarm: { minX: 7, maxX: 13, minY: 8, maxY: 12 },
};

const refs = {
  mapHome: document.getElementById("mapHome"),
  mapScreen: document.querySelector(".map-screen"),
  mapScroller: document.querySelector(".map-scroller"),
  mapWorld: document.querySelector(".map-world"),
  mapBottom: document.querySelector(".map-bottom"),
  mapGrid: document.getElementById("mapGrid"),
  mapBanner: document.getElementById("mapBanner"),
  zoneName: document.getElementById("zoneName"),
  taskName: document.getElementById("taskName"),
  taskSummary: document.getElementById("taskSummary"),
  taskActions: document.getElementById("taskActions"),
  retryTaskButton: document.getElementById("retryTaskButton"),
  resolveTaskButton: document.getElementById("resolveTaskButton"),
  taskActionNote: document.getElementById("taskActionNote"),
  modeValue: document.getElementById("modeValue"),
  alertValue: document.getElementById("alertValue"),
  loadValue: document.getElementById("loadValue"),
  batteryValue: document.getElementById("batteryValue"),
  temperatureValue: document.getElementById("temperatureValue"),
  queueValue: document.getElementById("queueValue"),
  coordValue: document.getElementById("coordValue"),
  lastSeenValue: document.getElementById("lastSeenValue"),
  interfaceStatus: document.getElementById("interfaceStatus"),
  interfaceStatusValue: document.getElementById("interfaceStatusValue"),
  feedList: document.getElementById("feedList"),
  clock: document.getElementById("clock"),
  syncBadge: document.getElementById("syncBadge"),
  zonePills: [...document.querySelectorAll(".zone-pill")],
};

let tileRefs = [];
let robotTile = null;
let alertLightTiles = [];
let lastStateSignature = "";
let lastSuccessfulState = null;
let lastRenderedState = null;
let connectionState = "offline";
let websocket = null;
let reconnectTimer = 0;
let pollTimer = 0;
let pollActive = false;
let lastRobotSignature = "";
let lastFeedSignature = "";
let taskActionInFlight = "";
let taskActionMessage = "";
let rawStatusCache = null;
let lastEventId = "";
let wsCloseHint = "";
let mapViewportRaf = 0;
let latestTaskStats = null;
let lastTaskStatsSignature = "";
let taskStatsRefreshPromise = null;
let latestTaskRuntime = null;
let lastTaskRuntimeSignature = "";
let taskRuntimeRefreshPromise = null;
let demoTimer = 0;
let restAnimationTimer = 0;
let feedItems = [
  {
    zone: "system",
    time: new Date().toISOString(),
    message: `等待后端返回 ${ROBOT_DISPLAY_NAME} 当前 zone、position、task 和 alertLevel。`,
  },
];

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function isMergeObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function applyMergePatch(target, patch) {
  if (!isMergeObject(patch)) {
    return cloneJson(patch);
  }

  const base = isMergeObject(target) ? { ...target } : {};

  Object.entries(patch).forEach(([key, value]) => {
    if (value === null) {
      delete base[key];
      return;
    }

    base[key] = applyMergePatch(base[key], value);
  });

  return base;
}

function normalizeEventCursor(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  return String(value);
}

function buildHttpUrl(forceRefresh = false) {
  const url = new URL(CONFIG.endpoint, window.location.href);

  if (forceRefresh) {
    url.searchParams.set("refresh", "1");
  }

  return url.toString();
}

function buildWsUrl() {
  if (!CONFIG.wsEndpoint) {
    return "";
  }

  let url;

  if (/^wss?:\/\//i.test(CONFIG.wsEndpoint)) {
    url = new URL(CONFIG.wsEndpoint);
  } else {
    const wsOrigin = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
    url = new URL(CONFIG.wsEndpoint, wsOrigin);
  }

  if (lastEventId) {
    url.searchParams.set("lastEventId", lastEventId);
  }

  if (CONFIG.apiKey && !url.searchParams.has("apiKey")) {
    url.searchParams.set("apiKey", CONFIG.apiKey);
  }

  return url.toString();
}

function buildTaskStatsUrls() {
  const urls = [];
  const pushUrl = (value) => {
    if (!value) {
      return;
    }

    const normalized = String(value).trim();
    if (normalized && !urls.includes(normalized)) {
      urls.push(normalized);
    }
  };

  if (CONFIG.taskStatsEndpoint) {
    String(CONFIG.taskStatsEndpoint)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach(pushUrl);
  }

  try {
    const statusUrl = new URL(CONFIG.endpoint, window.location.href);
    pushUrl(new URL("/api/tasks/stats", statusUrl.origin).toString());
  } catch {
    // ignore malformed endpoint
  }

  [
    "http://127.0.0.1:3008/api/tasks/stats",
    "http://localhost:3008/api/tasks/stats",
    "http://127.0.0.1:3010/api/tasks/stats",
    "http://localhost:3010/api/tasks/stats",
  ].forEach(pushUrl);

  return urls;
}

function buildTaskRuntimeUrls() {
  const urls = [];
  const pushUrl = (value) => {
    if (!value) {
      return;
    }

    const normalized = String(value).trim();
    if (normalized && !urls.includes(normalized)) {
      urls.push(normalized);
    }
  };

  if (CONFIG.taskRuntimeEndpoint) {
    String(CONFIG.taskRuntimeEndpoint)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach(pushUrl);
  }

  try {
    const statusUrl = new URL(CONFIG.endpoint, window.location.href);
    pushUrl(new URL("/api/tasks/runtime", statusUrl.origin).toString());
  } catch {
    // ignore malformed endpoint
  }

  [
    "http://127.0.0.1:3008/api/tasks/runtime",
    "http://localhost:3008/api/tasks/runtime",
    "http://127.0.0.1:3010/api/tasks/runtime",
    "http://localhost:3010/api/tasks/runtime",
  ].forEach(pushUrl);

  return urls;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatClock(date) {
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function formatShortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }

  return formatClock(date);
}

function formatPercent(value) {
  if (typeof value === "string" && value.includes("%")) {
    return value;
  }

  const numeric = safeNumber(value);
  return numeric === null ? "--" : `${Math.round(numeric)}%`;
}

function formatTemperature(value) {
  if (typeof value === "string" && value.includes("°")) {
    return value;
  }

  const numeric = safeNumber(value);
  return numeric === null ? "--" : `${Math.round(numeric)}°C`;
}

function formatTaskCount(value) {
  if (typeof value === "string") {
    return value;
  }

  const numeric = safeNumber(value);
  return numeric === null ? "--" : `${Math.round(numeric)} 项`;
}

function formatEtaLabel(value) {
  const numeric = safeNumber(value);
  if (numeric === null || numeric < 0) {
    return "";
  }

  if (numeric < 60) {
    return `${Math.round(numeric)} 秒`;
  }

  const minutes = Math.floor(numeric / 60);
  const remainSeconds = Math.round(numeric % 60);
  return remainSeconds > 0 ? `${minutes} 分 ${remainSeconds} 秒` : `${minutes} 分钟`;
}

function normalizeTaskStatsPayload(payload) {
  const root = payload?.data || payload?.stats || payload;
  if (!root || typeof root !== "object") {
    return null;
  }

  const counts = root.taskCount && typeof root.taskCount === "object" ? root.taskCount : root;
  const taskList = Array.isArray(root.taskList)
    ? root.taskList
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.tasks)
        ? root.tasks
        : [];
  const total = safeNumber(firstDefined(counts.total, root.total, root.taskCount, taskList.length));
  const todo = safeNumber(firstDefined(counts.todo, root.todo));
  const doing = safeNumber(firstDefined(counts.doing, root.doing, root.inProgress));
  const blocked = safeNumber(firstDefined(counts.blocked, root.blocked));
  const done = safeNumber(firstDefined(counts.done, root.done));
  const currentTask = taskList.find((item) => String(item?.status || "").toLowerCase() === "doing")
    || taskList.find((item) => String(item?.status || "").toLowerCase() === "blocked")
    || taskList[0]
    || null;

  if (total === null && todo === null && doing === null && blocked === null && done === null) {
    return null;
  }

  return {
    total: total ?? Math.max((todo || 0) + (doing || 0) + (blocked || 0) + (done || 0), 0),
    todo: todo ?? 0,
    doing: doing ?? 0,
    blocked: blocked ?? 0,
    done: done ?? 0,
    currentTask: currentTask
      ? {
          taskId: currentTask.taskId || currentTask.id || "",
          title: currentTask.title || currentTask.name || "",
          status: String(currentTask.status || "").toLowerCase(),
          progress: safeNumber(currentTask.progress),
          updatedAt: currentTask.updatedAt || "",
          failureReason: String(currentTask.failureReason || "").trim(),
          lastError: String(currentTask.lastError || "").trim(),
          availableActions: Array.isArray(currentTask.availableActions)
            ? currentTask.availableActions.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
            : [],
        }
      : null,
  };
}

function normalizeTaskRuntimePayload(payload) {
  const root = payload?.data || payload?.runtime || payload;
  if (!root || typeof root !== "object") {
    return null;
  }

  const currentTaskRoot = root.currentTask && typeof root.currentTask === "object" ? root.currentTask : null;
  const nextTaskRoot = root.nextTask && typeof root.nextTask === "object" ? root.nextTask : null;
  const queueSummaryRoot = root.queueSummary && typeof root.queueSummary === "object" ? root.queueSummary : null;

  const queued = safeNumber(firstDefined(queueSummaryRoot?.queued, root.queued, root.queueCount));
  const running = safeNumber(firstDefined(queueSummaryRoot?.running, root.running, root.runningCount, currentTaskRoot ? 1 : null));
  const failed = safeNumber(firstDefined(queueSummaryRoot?.failed, root.failed, root.failedCount));

  if (!currentTaskRoot && !nextTaskRoot && queued === null && running === null && failed === null) {
    return null;
  }

  return {
    currentTask: currentTaskRoot
      ? {
          taskId: currentTaskRoot.taskId || currentTaskRoot.id || "",
          title: currentTaskRoot.title || currentTaskRoot.name || "",
          status: String(currentTaskRoot.status || "").toLowerCase(),
          startedAt: currentTaskRoot.startedAt || currentTaskRoot.updatedAt || "",
          progress: safeNumber(currentTaskRoot.progress),
          etaSeconds: safeNumber(firstDefined(currentTaskRoot.etaSeconds, currentTaskRoot.eta)),
          failureReason: String(currentTaskRoot.failureReason || "").trim(),
          lastError: String(currentTaskRoot.lastError || "").trim(),
          availableActions: Array.isArray(currentTaskRoot.availableActions)
            ? currentTaskRoot.availableActions.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
            : [],
        }
      : null,
    nextTask: nextTaskRoot
      ? {
          taskId: nextTaskRoot.taskId || nextTaskRoot.id || "",
          title: nextTaskRoot.title || nextTaskRoot.name || "",
          status: String(nextTaskRoot.status || "").toLowerCase(),
          scheduledAt: nextTaskRoot.scheduledAt || nextTaskRoot.dueAt || "",
        }
      : null,
    queueSummary: {
      queued: queued ?? 0,
      running: running ?? 0,
      failed: failed ?? 0,
    },
  };
}

async function fetchTaskStats() {
  if (useMock || useDemo) {
    return null;
  }

  const urls = buildTaskStatsUrls();

  for (const url of urls) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), Math.min(CONFIG.requestTimeoutMs, 6000));

    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...CONFIG.headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const stats = normalizeTaskStatsPayload(payload);
      if (stats) {
        return stats;
      }
    } catch {
      // try next candidate
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  return null;
}

async function fetchTaskRuntime() {
  if (useMock || useDemo) {
    return null;
  }

  const urls = buildTaskRuntimeUrls();

  for (const url of urls) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), Math.min(CONFIG.requestTimeoutMs, 6000));

    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...CONFIG.headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const runtime = normalizeTaskRuntimePayload(payload);
      if (runtime) {
        return runtime;
      }
    } catch {
      // try next candidate
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  return null;
}

async function refreshTaskStats(forceRender = false) {
  if (taskStatsRefreshPromise) {
    return taskStatsRefreshPromise;
  }

  taskStatsRefreshPromise = (async () => {
    const nextStats = await fetchTaskStats();
    const nextSignature = nextStats ? JSON.stringify(nextStats) : "";

    if (nextSignature && nextSignature !== lastTaskStatsSignature) {
      latestTaskStats = nextStats;
      lastTaskStatsSignature = nextSignature;

      if (rawStatusCache) {
        const state = normalizeStatus(rawStatusCache);
        lastSuccessfulState = state;
        renderState(state, { source: "task-stats" });
      }
    } else if (!nextSignature && !forceRender) {
      return null;
    }

    return latestTaskStats;
  })();

  try {
    return await taskStatsRefreshPromise;
  } finally {
    taskStatsRefreshPromise = null;
  }
}

async function refreshTaskRuntime(forceRender = false) {
  if (taskRuntimeRefreshPromise) {
    return taskRuntimeRefreshPromise;
  }

  taskRuntimeRefreshPromise = (async () => {
    const nextRuntime = await fetchTaskRuntime();
    const nextSignature = nextRuntime ? JSON.stringify(nextRuntime) : "";

    if (nextSignature && nextSignature !== lastTaskRuntimeSignature) {
      latestTaskRuntime = nextRuntime;
      lastTaskRuntimeSignature = nextSignature;

      if (rawStatusCache) {
        const state = normalizeStatus(rawStatusCache);
        lastSuccessfulState = state;
        renderState(state, { source: "task-runtime" });
      }
    } else if (!nextSignature && !forceRender) {
      return null;
    }

    return latestTaskRuntime;
  })();

  try {
    return await taskRuntimeRefreshPromise;
  } finally {
    taskRuntimeRefreshPromise = null;
  }
}

function countRunningTasks(list) {
  if (!Array.isArray(list)) {
    return null;
  }

  return list.filter((item) => {
    const status = String(item?.status || "").trim().toLowerCase();
    return status === "doing" || status === "running" || status === "in_progress";
  }).length;
}

function resolveTaskCount(root, payload) {
  const rootTaskCount = root.taskCount && typeof root.taskCount === "object" ? root.taskCount : null;
  const payloadTaskCount = payload.taskCount && typeof payload.taskCount === "object" ? payload.taskCount : null;

  return firstDefined(
    latestTaskRuntime?.queueSummary?.running,
    latestTaskStats?.doing,
    root.runtime?.queueSummary?.running,
    payload.runtime?.queueSummary?.running,
    rootTaskCount?.running,
    rootTaskCount?.doing,
    rootTaskCount?.inProgress,
    payloadTaskCount?.running,
    payloadTaskCount?.doing,
    payloadTaskCount?.inProgress,
    root.running,
    root.runningCount,
    root.doing,
    root.inProgress,
    root.metrics?.running,
    payload.running,
    payload.runningCount,
    payload.doing,
    payload.inProgress,
    countRunningTasks(root.tasks),
    countRunningTasks(payload.tasks),
  );
}

function translateMode(value) {
  const raw = String(value || "").trim().toUpperCase();
  return modeLabels[raw] || raw || "未知";
}

function translateAlert(value) {
  const raw = String(value || "").trim().toUpperCase();
  return alertLabels[raw] || raw || "未知";
}

function normalizeScene(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) {
    return "";
  }

  if (["outdoor", "outside", "town", "street", "park", "square", "city"].some((token) => raw.includes(token))) {
    return "outdoor";
  }

  if (["room", "indoor", "inside", "home", "bedroom", "office", "control"].some((token) => raw.includes(token))) {
    return "room";
  }

  return "";
}

function normalizeIdleActivity(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }

  const compact = raw.replace(/[\s-]+/g, "_");
  const aliases = {
    stayhome: "stay_home",
    stay_home: "stay_home",
    home: "stay_home",
    walkdog: "walk_dog",
    walk_dog: "walk_dog",
    dog: "walk_dog",
    supermarket: "supermarket",
    grocery: "supermarket",
    shopping: "supermarket",
    walk: "walk",
    stroll: "stroll",
    town: "town",
    park: "park",
    coffee: "coffee",
    cafe: "coffee",
  };

  return aliases[compact] || compact;
}

function translateIdleActivity(value) {
  const key = normalizeIdleActivity(value);
  if (!key) {
    return "";
  }

  return idleActivityLabels[key] || translateIncomingText(key) || key;
}

function formatIdleActivitySentence(label) {
  if (!label) {
    return "正在外出放风";
  }

  if (label.endsWith("中") || label.startsWith("在")) {
    return label;
  }

  return `正在${label}`;
}

function resolveFrontEndRestAnimation(runtime) {
  const queued = safeNumber(runtime?.queueSummary?.queued) || 0;
  if (queued > 0) {
    return {
      scene: "room",
      idleActivity: "stay_home",
      position: { x: 4, y: 6 },
      taskLabel: "等待任务安排",
      description: `${ROBOT_DISPLAY_NAME} 当前没有运行任务，正在休息区待命。`,
      nextChangeMs: 0,
    };
  }

  const now = Date.now();
  const phase = now % REST_ANIMATION_CYCLE_MS;
  if (phase < REST_ROOM_PHASE_MS) {
    return {
      scene: "room",
      idleActivity: "stay_home",
      position: { x: 4, y: 6 },
      taskLabel: "休息中",
      description: `${ROBOT_DISPLAY_NAME} 当前没有运行任务，正在休息区待命。`,
      nextChangeMs: REST_ROOM_PHASE_MS - phase,
    };
  }

  return {
    scene: "outdoor",
    idleActivity: "walk_dog",
    position: { x: 5, y: 11 },
    taskLabel: "遛狗中",
    description: `${ROBOT_DISPLAY_NAME} 当前没有运行任务，正在室外活动。`,
    nextChangeMs: REST_ANIMATION_CYCLE_MS - phase,
  };
}

function translateSessionKey(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "控制指令";
  }

  return "控制指令";
}

function translateIncomingText(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const exactMap = {
    snapshot: "快照同步",
    "ws-connect": "实时连接建立",
    status: "状态更新",
    hello: "握手成功",
    running: "运行中",
    active: "活跃",
    offline: "离线",
  };

  if (exactMap[raw.toLowerCase()]) {
    return exactMap[raw.toLowerCase()];
  }

  const activeMatch = raw.match(/^Active:\s*(.+)$/i);
  if (activeMatch) {
    return "远程控制进行中";
  }

  const latestMatch = raw.match(/^Latest session:\s*(.+)$/i);
  if (latestMatch) {
    return `刚收到新的${translateSessionKey(latestMatch[1])}`;
  }

  if (/^OpenClaw status pulled successfully\.?$/i.test(raw)) {
    return `${ROBOT_DISPLAY_NAME} 状态同步完成。`;
  }

  const gatewayMatch = raw.match(/^Gateway online\s*[·|]\s*sessions=(\d+)\s*[·|]\s*node=([^(]+)\(pid\s*(\d+),\s*state\s*([^)]+)\)$/i);
  if (gatewayMatch) {
    const [, sessions, nodeMode] = gatewayMatch;
    const nodeModeText = translateMode(nodeMode);
    return `后台已连通，当前正在处理 ${sessions} 路控制，主节点${nodeModeText}。`;
  }

  if (/^[a-z]+(?::[a-z0-9_-]+){2,}$/i.test(raw)) {
    return "远程控制链路活跃";
  }

  const compactGateway = raw
    .replace(/Gateway online/gi, "后台在线")
    .replace(/sessions=/gi, "控制通道 ")
    .replace(/node=running/gi, "主节点运行中")
    .replace(/node=idle/gi, "主节点待机中")
    .replace(/state active/gi, "状态运行中")
    .replace(/state idle/gi, "状态待机中")
    .replace(/state running/gi, "状态运行中")
    .replace(/state offline/gi, "状态离线")
    .replace(/pid/gi, "PID");

  if (compactGateway !== raw) {
    return compactGateway;
  }

  return raw
    .replace(/\bGateway\b/gi, "网关")
    .replace(/\bonline\b/gi, "在线")
    .replace(/\brunning\b/gi, "运行中")
    .replace(/\bactive\b/gi, "活跃")
    .replace(/\boffline\b/gi, "离线")
    .replace(/\bsnapshot\b/gi, "快照同步")
    .replace(/\bstatus update\b/gi, "状态更新")
    .replace(/\bws-connect\b/gi, "实时连接建立");
}

function compactTaskLabel(task) {
  const raw = translateIncomingText(task);

  if (!raw) {
    return "等待后台状态";
  }

  const parts = raw.split(":").map((part) => part.trim()).filter(Boolean);

  if (parts.length >= 4) {
    return `${parts[0]} / ${parts[parts.length - 2]} / ${parts[parts.length - 1]}`;
  }

  if (raw.length > 42) {
    return `${raw.slice(0, 39)}...`;
  }

  return raw;
}

function looksLikeEmptyTask(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return true;
  }

  return [
    "暂无任务",
    "无任务",
    "no task",
    "none",
    "idle",
    "rest",
    "待机",
    "空闲",
  ].some((token) => raw.includes(token));
}

function resolveDisplayTask(state) {
  if (state.scene === "outdoor") {
    return state.idleActivityLabel || state.task || "外出放风";
  }

  return state.task;
}

function resolveBannerArea(state) {
  if (state.scene === "outdoor") {
    return "室外总览";
  }

  return state.zoneName;
}

function setText(node, value) {
  const normalized = String(value ?? "");
  if (node.textContent !== normalized) {
    node.textContent = normalized;
  }
}

function setTitle(node, value) {
  const normalized = String(value ?? "");
  if (node.title !== normalized) {
    node.title = normalized;
  }
}

function stateSignature(state) {
  return [
    state.zone,
    state.scene,
    state.idleActivity,
    state.position.x,
    state.position.y,
    state.task,
    state.description,
    state.mode,
    state.alertLevel,
    state.load,
    state.battery,
    state.temperature,
    state.taskCount,
  ].join("||");
}

function feedSignature(items) {
  return items
    .slice(0, MAX_FEED_ITEMS)
    .map((item) => `${item.zone}|${item.time}|${item.message}`)
    .join("||");
}

function normalizeZone(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) {
    return "";
  }

  if (["rest", "idle", "charging", "standby", "sleep", "bedroom", "room", "home", "house", "休息", "休息区", "卧室", "家里", "房间", "待机", "充电"].some((token) => raw.includes(token))) {
    return "rest";
  }

  if (["work", "task", "job", "running", "operate", "生产", "工作", "执行", "搬运", "抓取"].some((token) => raw.includes(token))) {
    return "work";
  }

  if (["alarm", "alert", "warning", "danger", "emergency", "警报", "告警", "异常", "风险"].some((token) => raw.includes(token))) {
    return "alarm";
  }

  return "";
}

function normalizeAlert(value) {
  const raw = String(value || "GREEN").trim().toUpperCase();

  if (["RED", "CRITICAL", "ALARM", "DANGER", "ERROR"].some((token) => raw.includes(token))) {
    return "RED";
  }

  if (["AMBER", "YELLOW", "WARN"].some((token) => raw.includes(token))) {
    return "AMBER";
  }

  if (["BLUE", "RUNNING", "ACTIVE"].some((token) => raw.includes(token))) {
    return "BLUE";
  }

  if (["OFFLINE", "DISCONNECTED"].some((token) => raw.includes(token))) {
    return "OFFLINE";
  }

  return "GREEN";
}

function detectZoneFromPosition(position) {
  if (position.x >= 19) {
    return "alarm";
  }

  if (position.x >= 9 && position.x <= 18) {
    return "work";
  }

  return "rest";
}

function normalizePosition(rawPosition, zone) {
  let x = null;
  let y = null;

  if (Array.isArray(rawPosition) && rawPosition.length >= 2) {
    [x, y] = rawPosition;
  } else if (typeof rawPosition === "string" && rawPosition.includes(",")) {
    const [rawX, rawY] = rawPosition.split(",");
    x = rawX;
    y = rawY;
  } else if (rawPosition && typeof rawPosition === "object") {
    x = firstDefined(rawPosition.x, rawPosition.col, rawPosition.tileX);
    y = firstDefined(rawPosition.y, rawPosition.row, rawPosition.tileY);
  }

  const safeX = safeNumber(x);
  const safeY = safeNumber(y);
  const anchor = zoneAnchors[zone] || zoneAnchors.rest;

  return {
    x: safeX === null ? anchor.x : Math.min(Math.max(Math.round(safeX), 1), LOGICAL_MAP_WIDTH - 2),
    y: safeY === null ? anchor.y : Math.min(Math.max(Math.round(safeY), 1), LOGICAL_MAP_HEIGHT - 2),
  };
}

function projectPositionIntoZone(position, zone) {
  const bounds = zoneRenderBounds[zone];
  if (!bounds) {
    return position;
  }

  const xRatio = clamp((position.x - 1) / Math.max(LOGICAL_MAP_WIDTH - 3, 1), 0, 1);
  const yRatio = clamp((position.y - 1) / Math.max(LOGICAL_MAP_HEIGHT - 3, 1), 0, 1);

  return {
    x: Math.round(bounds.minX + (bounds.maxX - bounds.minX) * xRatio),
    y: Math.round(bounds.minY + (bounds.maxY - bounds.minY) * yRatio),
  };
}

function hasPhaserMap() {
  return Boolean(window.OpenClawPhaserTownMap);
}

function syncPhaserMapState(state) {
  if (!hasPhaserMap()) {
    return;
  }

  window.OpenClawPhaserTownMap.apply(
    state
      ? {
          zone: state.zone,
          scene: state.scene,
          idleActivity: state.idleActivity,
          idleActivityLabel: state.idleActivityLabel,
          alertLevel: state.alertLevel,
          position: state.position,
          townPosition: state.position,
          roomPosition: state.mapPosition || state.position,
        }
      : {
          zone: "",
          alertLevel: "OFFLINE",
          position: null,
        },
  );
}

function normalizeLogs(rawLogs) {
  if (!Array.isArray(rawLogs)) {
    return [];
  }

  return rawLogs
    .map((entry) => {
      if (!entry) {
        return null;
      }

      const zone = normalizeZone(entry.zone || entry.area || entry.level) || "system";
      const message = firstDefined(entry.message, entry.text, entry.summary, entry.event);

      if (!message) {
        return null;
      }

      return {
        zone,
        time: firstDefined(entry.time, entry.timestamp, entry.updatedAt, new Date().toISOString()),
        message: translateIncomingText(message),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_FEED_ITEMS);
}

function translateTaskWorkflowStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  const labels = {
    todo: "待开始",
    doing: "进行中",
    running: "运行中",
    queued: "排队中",
    blocked: "已阻塞",
    failed: "失败",
    done: "已完成",
    archived: "已归档",
  };

  return labels[raw] || raw || "待开始";
}

function setTaskActionVisibility(visible) {
  if (!refs.taskActions) {
    return;
  }

  refs.taskActions.hidden = !visible;
}

function buildTaskActionUrl(taskId, action) {
  return `/api/tasks/${encodeURIComponent(taskId)}/${action}`;
}

function updateTaskActions(state) {
  if (!refs.taskActions) {
    return;
  }

  const task = state?.actionableTask || null;
  const actions = Array.isArray(task?.availableActions) ? task.availableActions : [];
  const showRetry = actions.includes("retry");
  const showResolve = actions.includes("resolve");
  const visible = !useMock && !useDemo && Boolean(task?.taskId) && (showRetry || showResolve);

  setTaskActionVisibility(visible);
  if (!visible) {
    refs.retryTaskButton.hidden = true;
    refs.resolveTaskButton.hidden = true;
    refs.taskActionNote.textContent = "";
    return;
  }

  refs.retryTaskButton.hidden = !showRetry;
  refs.resolveTaskButton.hidden = !showResolve;
  refs.retryTaskButton.disabled = Boolean(taskActionInFlight);
  refs.resolveTaskButton.disabled = Boolean(taskActionInFlight);

  if (taskActionInFlight === "retry") {
    refs.retryTaskButton.textContent = "重试中...";
  } else {
    refs.retryTaskButton.textContent = "重试任务";
  }

  if (taskActionInFlight === "resolve") {
    refs.resolveTaskButton.textContent = "处理中...";
  } else {
    refs.resolveTaskButton.textContent = "处理完成";
  }

  const note = taskActionMessage
    || task.failureReason
    || task.lastError
    || (showRetry ? "当前失败任务可直接重试或标记处理完成。" : "当前任务可标记处理完成。");
  refs.taskActionNote.textContent = translateIncomingText(note);
}

async function performTaskAction(action) {
  const state = lastRenderedState;
  const task = state?.actionableTask;

  if (!task?.taskId || !Array.isArray(task.availableActions) || !task.availableActions.includes(action)) {
    return;
  }

  taskActionInFlight = action;
  taskActionMessage = action === "retry" ? "正在发起重试..." : "正在更新处理结果...";
  updateTaskActions(state);

  try {
    const response = await fetch(buildTaskActionUrl(task.taskId, action), {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...CONFIG.headers,
      },
      body: "{}",
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.detail || payload?.error || payload?.message || `HTTP ${response.status}`);
    }

    taskActionMessage = action === "retry" ? "已发起重试，正在同步最新状态。" : "已标记处理完成，正在同步最新状态。";
    pushFeedItem({
      zone: "system",
      time: new Date().toISOString(),
      message: taskActionMessage,
    });

    const result = await fetchStatus(true);
    await Promise.all([refreshTaskStats(true), refreshTaskRuntime(true)]);
    commitOnlineState(result.raw, {
      source: "http",
      recoveryMessage: "任务动作已同步到页面。",
    });
  } catch (error) {
    taskActionMessage = `任务动作失败：${translateIncomingText(error?.message || "未知错误")}`;
    pushFeedItem({
      zone: "system",
      time: new Date().toISOString(),
      message: taskActionMessage,
    });
  } finally {
    taskActionInFlight = "";
    updateTaskActions(lastRenderedState);
  }
}

function buildRuntimeSummary(runtime) {
  if (!runtime) {
    return "";
  }

  const parts = [];
  const currentTask = runtime.currentTask;
  const nextTask = runtime.nextTask;
  const queueSummary = runtime.queueSummary || {};

  if (currentTask?.title) {
    const currentBits = [`当前执行《${currentTask.title}》`];
    if (currentTask.progress !== null && currentTask.progress !== undefined) {
      currentBits.push(`${Math.round(currentTask.progress)}%`);
    }
    const etaLabel = formatEtaLabel(currentTask.etaSeconds);
    if (etaLabel) {
      currentBits.push(`预计 ${etaLabel}`);
    }
    parts.push(currentBits.join(" · "));
  }

  if (nextTask?.title) {
    parts.push(`下一项《${nextTask.title}》`);
  }

  if (
    queueSummary.queued !== undefined ||
    queueSummary.running !== undefined ||
    queueSummary.failed !== undefined
  ) {
    parts.push(`队列：排队 ${queueSummary.queued ?? 0} 项 · 运行中 ${queueSummary.running ?? 0} 项 · 失败 ${queueSummary.failed ?? 0} 项`);
  }

  return parts.join(" ｜ ");
}

function buildRuntimeLogEntries(runtime, zone, fallbackTime) {
  if (!runtime) {
    return [];
  }

  const entries = [];
  const currentTask = runtime.currentTask;
  const nextTask = runtime.nextTask;
  const queueSummary = runtime.queueSummary || {};

  if (
    queueSummary.queued !== undefined ||
    queueSummary.running !== undefined ||
    queueSummary.failed !== undefined
  ) {
    entries.push({
      zone: "system",
      time: fallbackTime,
      message: `任务队列：排队 ${queueSummary.queued ?? 0} 项 · 运行中 ${queueSummary.running ?? 0} 项 · 失败 ${queueSummary.failed ?? 0} 项`,
    });
  }

  if (nextTask?.title) {
    entries.push({
      zone,
      time: nextTask.scheduledAt || fallbackTime,
      message: `下一任务：${nextTask.title} · ${translateTaskWorkflowStatus(nextTask.status)}${nextTask.scheduledAt ? ` · 计划 ${formatDateTime(nextTask.scheduledAt)}` : ""}`,
    });
  }

  if (currentTask?.title) {
    entries.push({
      zone,
      time: currentTask.startedAt || fallbackTime,
      message: `当前任务：${currentTask.title} · ${translateTaskWorkflowStatus(currentTask.status)} · ${Math.round(currentTask.progress ?? 0)}%${currentTask.etaSeconds ? ` · 预计 ${formatEtaLabel(currentTask.etaSeconds)}` : ""}`,
    });
  }

  return entries;
}

function mergeFeedEntries(primary, secondary) {
  const merged = [];
  const seen = new Set();

  [...primary, ...secondary].forEach((entry) => {
    if (!entry?.message) {
      return;
    }

    const key = `${entry.zone || "system"}|${entry.time || ""}|${entry.message}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(entry);
  });

  return merged.slice(0, MAX_FEED_ITEMS);
}

function normalizeStatus(payload) {
  const root = payload.robot || payload.openclaw || payload.data || payload;
  const runtime = normalizeTaskRuntimePayload(firstDefined(root.runtime, payload.runtime)) || latestTaskRuntime;
  const explicitZone = normalizeZone(firstDefined(root.zone, root.currentZone, root.area, payload.zone, payload.currentZone));
  const runtimeZone = runtime
    ? (runtime.queueSummary?.failed || 0) > 0
      ? "alarm"
      : (runtime.queueSummary?.running || 0) > 0 || runtime.currentTask?.title
        ? "work"
        : ""
    : "";
  const statsZone = latestTaskStats
    ? latestTaskStats.blocked > 0
      ? "alarm"
      : latestTaskStats.doing > 0
        ? "work"
      : latestTaskStats.total === 0
          ? "rest"
          : ""
    : "";
  const guessedZone = explicitZone || statsZone || runtimeZone;
  let idleActivity = normalizeIdleActivity(firstDefined(
    root.idleActivity,
    root.activity,
    payload.idleActivity,
    payload.activity,
  ));
  const rawScene = normalizeScene(firstDefined(root.scene, root.view, payload.scene, payload.view, idleActivity ? "outdoor" : ""));
  let scene = rawScene || (idleActivity ? "outdoor" : "room");
  let rawPosition = normalizePosition(
    firstDefined(root.position, root.coords, root.coordinate, root.tile, { x: root.x, y: root.y }),
    guessedZone || "rest",
  );
  const zone = guessedZone || detectZoneFromPosition(rawPosition);
  const frontEndRestAnimation = !useDemo && zone === "rest"
    ? resolveFrontEndRestAnimation(runtime)
    : null;

  if (frontEndRestAnimation) {
    scene = frontEndRestAnimation.scene;
    idleActivity = frontEndRestAnimation.idleActivity;
    rawPosition = frontEndRestAnimation.position;
  }

  const mapPosition = projectPositionIntoZone(rawPosition, zone);
  const logs = normalizeLogs(firstDefined(payload.logs, payload.feed, payload.events, root.logs));
  const runtimeLogs = buildRuntimeLogEntries(runtime, zone, firstDefined(payload.updatedAt, payload.timestamp, new Date().toISOString()));

  const rawMode = String(firstDefined(root.mode, root.status, payload.mode, "RUNNING")).toUpperCase();
  const resolvedMode = runtime
    ? (runtime.queueSummary?.failed || 0) > 0
      ? "ERROR"
      : (runtime.queueSummary?.running || 0) > 0
        ? rawMode
        : "IDLE"
    : latestTaskStats
      ? latestTaskStats.blocked > 0
        ? "ERROR"
        : latestTaskStats.doing > 0
          ? rawMode
          : "IDLE"
      : rawMode;
  const rawAlert = normalizeAlert(firstDefined(root.alertLevel, root.alert, root.riskLevel, payload.alertLevel, "GREEN"));
  const idleActivityLabel = translateIdleActivity(idleActivity);
  const fallbackTask = scene === "outdoor" ? (idleActivityLabel || "外出放风") : "状态同步中";
  const runtimeTaskTitle = runtime?.currentTask?.title || "";
  const statsTaskTitle = latestTaskStats?.currentTask?.title || "";
  const explicitTask = firstDefined(root.task, root.taskName, root.action, root.job, payload.task, "");
  const runtimeFallbackTask = runtime
    ? runtime.currentTask?.title
      ? runtime.currentTask.title
      : (runtime.queueSummary?.running || 0) > 0
        ? `进行中任务 ${runtime.queueSummary?.running || 0} 项`
        : runtime.nextTask?.title || ""
    : "";
  const statsFallbackTask = latestTaskStats
    ? latestTaskStats.blocked > 0
      ? "警报处理中"
      : latestTaskStats.doing > 0
        ? (statsTaskTitle || `进行中任务 ${latestTaskStats.doing} 项`)
      : latestTaskStats.total === 0
          ? "休息中"
          : "等待任务安排"
    : "";
  const rawTask = translateIncomingText(firstDefined(runtimeFallbackTask, explicitTask, statsFallbackTask, runtimeTaskTitle, fallbackTask));
  let task = scene === "outdoor" && looksLikeEmptyTask(rawTask) ? fallbackTask : rawTask;
  const fallbackDescription = scene === "outdoor"
    ? `${ROBOT_DISPLAY_NAME} 当前暂无任务，${formatIdleActivitySentence(idleActivityLabel)}。`
    : `${ROBOT_DISPLAY_NAME} 已同步到像素地图。`;
  const runtimeDescription = buildRuntimeSummary(runtime);
  const explicitDescription = firstDefined(root.description, root.statusText, root.message, payload.description, "");
  const statsDescription = latestTaskStats
    ? latestTaskStats.total === 0
      ? `${ROBOT_DISPLAY_NAME} 当前没有任务，正在休息区待命。`
      : `任务总数 ${latestTaskStats.total} 项 · 进行中 ${latestTaskStats.doing} 项${latestTaskStats.blocked > 0 ? ` · 阻塞 ${latestTaskStats.blocked} 项` : ""}`
    : "";
  let description = translateIncomingText(firstDefined(runtimeDescription, explicitDescription, statsDescription, fallbackDescription));
  const actionableTask = runtime?.currentTask?.taskId
    ? runtime.currentTask
    : latestTaskStats?.currentTask?.taskId
      ? latestTaskStats.currentTask
      : null;

  if (frontEndRestAnimation) {
    task = frontEndRestAnimation.taskLabel;
    description = frontEndRestAnimation.description;
  }

  return {
    zone,
    zoneName: zoneLabels[zone],
    scene,
    sceneLabel: sceneLabels[scene] || "室内",
    idleActivity,
    idleActivityLabel,
    position: rawPosition,
    mapPosition,
    task,
    description,
    modeRaw: resolvedMode,
    mode: translateMode(resolvedMode),
    alertLevel: rawAlert,
    alertText: translateAlert(rawAlert),
    load: formatPercent(firstDefined(root.load, root.metrics?.load, payload.load)),
    battery: formatPercent(firstDefined(root.battery, root.metrics?.battery, payload.battery)),
    temperature: formatTemperature(firstDefined(root.temperature, root.metrics?.temperature, payload.temperature)),
    taskCount: formatTaskCount(resolveTaskCount(root, payload)),
    updatedAt: firstDefined(root.updatedAt, root.lastUpdate, payload.updatedAt, payload.timestamp, new Date().toISOString()),
    logs: mergeFeedEntries(runtimeLogs, logs),
    runtime,
    actionableTask,
    restAnimationNextMs: frontEndRestAnimation?.nextChangeMs || 0,
  };
}

function setTile(grid, x, y, type) {
  const height = grid.length;
  const width = grid[0]?.length || 0;

  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }

  grid[y][x] = type;
}

function fillRect(grid, x, y, width, height, type) {
  for (let row = y; row < y + height; row += 1) {
    for (let col = x; col < x + width; col += 1) {
      setTile(grid, col, row, type);
    }
  }
}

function drawHorizontal(grid, y, x1, x2, type) {
  for (let col = x1; col <= x2; col += 1) {
    setTile(grid, col, y, type);
  }
}

function drawVertical(grid, x, y1, y2, type) {
  for (let row = y1; row <= y2; row += 1) {
    setTile(grid, x, row, type);
  }
}

function setRowPattern(grid, y, x, pattern) {
  pattern.forEach((type, index) => {
    setTile(grid, x + index, y, type);
  });
}

function drawFenceRect(grid, x, y, width, height, type = "fence-white") {
  for (let row = y; row < y + height; row += 1) {
    for (let col = x; col < x + width; col += 1) {
      const isEdge = row === y || row === y + height - 1 || col === x || col === x + width - 1;
      if (isEdge) {
        setTile(grid, col, row, type);
      }
    }
  }
}

function buildMapData() {
  const grid = Array.from({ length: LOGICAL_MAP_HEIGHT }, (_, y) =>
    Array.from({ length: LOGICAL_MAP_WIDTH }, (_, x) => {
      return (x + y) % 2 === 0 ? "grass" : "grass-alt";
    }),
  );

  fillRect(grid, 0, 0, LOGICAL_MAP_WIDTH, 1, "tree");
  fillRect(grid, 0, LOGICAL_MAP_HEIGHT - 1, LOGICAL_MAP_WIDTH, 1, "tree");
  fillRect(grid, 0, 1, 1, LOGICAL_MAP_HEIGHT - 2, "tree");
  fillRect(grid, LOGICAL_MAP_WIDTH - 1, 1, 1, LOGICAL_MAP_HEIGHT - 2, "tree");
  fillRect(grid, 1, 1, 3, 2, "tree");
  fillRect(grid, 7, 1, 2, 2, "tree");
  fillRect(grid, 17, 1, 2, 2, "tree");
  fillRect(grid, 20, 1, 3, 2, "tree");
  fillRect(grid, 1, 13, 1, 3, "tree");
  fillRect(grid, 22, 12, 1, 4, "tree");

  fillRect(grid, 3, 10, 19, 2, "path");
  fillRect(grid, 4, 7, 2, 3, "path");
  fillRect(grid, 12, 7, 2, 3, "path");
  fillRect(grid, 19, 8, 2, 2, "path");

  fillRect(grid, 2, 2, 6, 1, "roof-rest");
  fillRect(grid, 2, 3, 6, 2, "roof-rest");
  fillRect(grid, 2, 5, 6, 2, "wall");
  setRowPattern(grid, 5, 3, ["window", "window", "window", "window"]);
  setRowPattern(grid, 6, 4, ["door", "door"]);
  drawFenceRect(grid, 1, 1, 8, 8);
  setTile(grid, 4, 8, "gate");
  setTile(grid, 5, 8, "gate");
  setTile(grid, 1, 9, "mailbox");
  setTile(grid, 7, 9, "bench");
  setTile(grid, 8, 9, "sign");
  setTile(grid, 2, 8, "flower");
  setTile(grid, 7, 8, "flower");
  setTile(grid, 8, 5, "shadow-grass");

  fillRect(grid, 10, 2, 7, 1, "roof-work");
  fillRect(grid, 10, 3, 7, 2, "roof-work");
  fillRect(grid, 10, 5, 7, 1, "work-facade-shadow");
  setRowPattern(grid, 6, 10, ["work-wall-side", "work-window-frame", "work-window-frame", "work-signboard", "work-window-frame", "work-window-frame", "work-wall-side"]);
  setRowPattern(grid, 7, 10, ["work-wall-side", "work-awning", "work-awning", "work-awning", "work-awning", "work-awning", "work-wall-side"]);
  setRowPattern(grid, 8, 10, ["work-wall-side", "window", "work-door-shadow", "work-door-shadow", "work-door-shadow", "window", "work-wall-side"]);
  fillRect(grid, 10, 13, 7, 3, "grass");
  drawFenceRect(grid, 10, 13, 7, 3);
  fillRect(grid, 12, 14, 3, 1, "path");
  setTile(grid, 11, 14, "bench");
  setTile(grid, 15, 14, "bench");
  setTile(grid, 12, 13, "flower");
  setTile(grid, 14, 13, "flower");
  setTile(grid, 16, 13, "status-light");
  setTile(grid, 17, 5, "shadow-grass");
  setTile(grid, 17, 6, "shadow-grass");
  setTile(grid, 9, 9, "sign");
  setTile(grid, 10, 9, "flower");
  setTile(grid, 13, 9, "sign");

  fillRect(grid, 19, 3, 4, 1, "roof-grey");
  fillRect(grid, 19, 4, 4, 1, "roof-alert");
  fillRect(grid, 19, 5, 4, 2, "wall");
  setRowPattern(grid, 6, 20, ["door", "door"]);
  drawFenceRect(grid, 18, 8, 5, 8);
  setTile(grid, 18, 10, "gate");
  setTile(grid, 18, 11, "gate");
  fillRect(grid, 19, 12, 3, 2, "hazard");
  fillRect(grid, 19, 9, 3, 1, "alarm-floor");
  fillRect(grid, 19, 10, 3, 1, "alert-console");
  fillRect(grid, 19, 11, 3, 1, "alert-screen");
  fillRect(grid, 20, 14, 2, 1, "alarm-cabinet");
  setTile(grid, 19, 8, "alert-light");
  setTile(grid, 21, 8, "alert-light");
  setTile(grid, 22, 9, "beacon");
  setTile(grid, 22, 13, "beacon");
  setTile(grid, 22, 6, "shadow-grass");

  fillRect(grid, 1, 13, 4, 4, "pond");
  setTile(grid, 2, 14, "rock");
  setTile(grid, 3, 15, "rock");

  setTile(grid, 9, 10, "lamp");
  setTile(grid, 17, 10, "lamp");
  setTile(grid, 6, 12, "flower");
  setTile(grid, 8, 12, "flower");
  setTile(grid, 18, 12, "flower");

  return upscaleMapData(grid);
}

function resolveScaledTile(type, dx, dy, sourceX, sourceY) {
  const center = Math.floor(MAP_RENDER_SCALE / 2);

  if (type === "grass") {
    return "grass";
  }

  if (type === "grass-alt") {
    return "grass-alt";
  }

  if (type === "flower") {
    return dx === center && dy === center ? "flower" : "grass";
  }

  if (type === "path") {
    return "path";
  }

  if (type === "lamp") {
    if (dx !== center) {
      return "path";
    }

    if (dy === 0) {
      return "lamp-top";
    }

    if (dy < MAP_RENDER_SCALE - 1) {
      return "lamp-post";
    }

    return "lamp-base";
  }

  if (type.startsWith("npc-")) {
    if (dx !== center) {
      return "path";
    }

    if (dy === 0) {
      return `${type}-head`;
    }

    if (dy < MAP_RENDER_SCALE - 1) {
      return `${type}-body`;
    }

    return `${type}-shadow`;
  }

  return type;
}

function upscaleMapData(logicalGrid) {
  return Array.from({ length: MAP_HEIGHT }, (_, renderY) =>
    Array.from({ length: MAP_WIDTH }, (_, renderX) => {
      const sourceX = Math.floor(renderX / MAP_RENDER_SCALE);
      const sourceY = Math.floor(renderY / MAP_RENDER_SCALE);
      const dx = renderX % MAP_RENDER_SCALE;
      const dy = renderY % MAP_RENDER_SCALE;
      const sourceType = logicalGrid[sourceY]?.[sourceX] || "grass";

      return resolveScaledTile(sourceType, dx, dy, sourceX, sourceY);
    }),
  );
}

function toRenderedPosition(position) {
  return {
    x: Math.min((position.x * MAP_RENDER_SCALE) + Math.floor(MAP_RENDER_SCALE / 2), MAP_WIDTH - 2),
    y: Math.min((position.y * MAP_RENDER_SCALE) + Math.floor(MAP_RENDER_SCALE / 2), MAP_HEIGHT - 2),
  };
}

function syncMapViewport() {
  if (hasPhaserMap()) {
    window.OpenClawPhaserTownMap.resize();
    return;
  }

  mapViewportRaf = 0;

  if (!refs.mapScroller || !refs.mapGrid || !refs.mapBottom) {
    return;
  }

  const bottomPadding = refs.mapBottom.offsetHeight + 14;
  refs.mapScroller.style.paddingBottom = `${bottomPadding}px`;

  const scrollerStyle = window.getComputedStyle(refs.mapScroller);
  const gridStyle = window.getComputedStyle(refs.mapGrid);
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tile-gap")) || 1;
  const scrollerWidth = refs.mapScroller.clientWidth
    - parseFloat(scrollerStyle.paddingLeft || "0")
    - parseFloat(scrollerStyle.paddingRight || "0");
  const scrollerHeight = refs.mapScroller.clientHeight
    - parseFloat(scrollerStyle.paddingTop || "0")
    - parseFloat(scrollerStyle.paddingBottom || "0");
  const gridExtraWidth = parseFloat(gridStyle.paddingLeft || "0")
    + parseFloat(gridStyle.paddingRight || "0")
    + parseFloat(gridStyle.borderLeftWidth || "0")
    + parseFloat(gridStyle.borderRightWidth || "0");
  const gridExtraHeight = parseFloat(gridStyle.paddingTop || "0")
    + parseFloat(gridStyle.paddingBottom || "0")
    + parseFloat(gridStyle.borderTopWidth || "0")
    + parseFloat(gridStyle.borderBottomWidth || "0");
  const maxTileWidth = (scrollerWidth - gridExtraWidth - (gap * (MAP_WIDTH - 1))) / MAP_WIDTH;
  const maxTileHeight = (scrollerHeight - gridExtraHeight - (gap * (MAP_HEIGHT - 1))) / MAP_HEIGHT;
  const nextTileSize = Math.floor(Math.min(maxTileWidth, maxTileHeight));

  if (!Number.isFinite(nextTileSize) || nextTileSize <= 0) {
    return;
  }

  document.documentElement.style.setProperty("--tile-size", `${clamp(nextTileSize, 4, 22)}px`);
}

function queueMapViewportSync() {
  if (mapViewportRaf) {
    window.cancelAnimationFrame(mapViewportRaf);
  }

  mapViewportRaf = window.requestAnimationFrame(syncMapViewport);
}

function createMap() {
  if (hasPhaserMap()) {
    refs.mapGrid.innerHTML = "";
    window.OpenClawPhaserTownMap.init(refs.mapGrid);
    queueMapViewportSync();
    return;
  }

  const mapData = buildMapData();
  refs.mapGrid.innerHTML = "";
  alertLightTiles = [];
  tileRefs = mapData.map((row, y) =>
    row.map((type, x) => {
      const tile = document.createElement("div");
      tile.className = `tile tile--${type}`;
      tile.dataset.x = String(x);
      tile.dataset.y = String(y);
      if (type === "alert-light") {
        alertLightTiles.push(tile);
      }
      refs.mapGrid.appendChild(tile);
      return tile;
    }),
  );
  setAlertLights("OFFLINE");
  queueMapViewportSync();
}

function clearRobot() {
  if (!robotTile) {
    return;
  }

  robotTile.classList.remove("tile--robot", "tile--robot-active");
  robotTile.style.removeProperty("--robot-glow");
  robotTile.querySelectorAll(".robot-sprite, .robot-label").forEach((node) => node.remove());
  robotTile = null;
  lastRobotSignature = "";
}

function robotGlow(alertLevel) {
  if (alertLevel === "RED") {
    return "rgba(255, 122, 92, 0.95)";
  }

  if (alertLevel === "AMBER") {
    return "rgba(255, 209, 115, 0.92)";
  }

  if (alertLevel === "BLUE") {
    return "rgba(140, 203, 227, 0.92)";
  }

  return "rgba(214, 239, 115, 0.9)";
}

function setAlertLights(alertLevel) {
  const active = alertLevel === "RED" || alertLevel === "AMBER";

  alertLightTiles.forEach((tile) => {
    tile.classList.toggle("is-active", active);
    tile.dataset.alert = active ? alertLevel : "OFFLINE";
  });
}

function placeRobot(position, alertLevel) {
  const signature = `${position.x}:${position.y}:${alertLevel}`;
  if (signature === lastRobotSignature) {
    return;
  }

  clearRobot();
  const renderPosition = toRenderedPosition(position);
  const tile = tileRefs[renderPosition.y]?.[renderPosition.x];

  if (!tile) {
    return;
  }

  tile.classList.add("tile--robot", "tile--robot-active");
  tile.style.setProperty("--robot-glow", robotGlow(alertLevel));
  const sprite = document.createElement("span");
  sprite.className = "robot-sprite";
  sprite.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "robot-label";
  label.textContent = ROBOT_DISPLAY_NAME;

  tile.append(sprite, label);
  robotTile = tile;
  lastRobotSignature = signature;
}

function setActiveZone(zone) {
  refs.mapHome.dataset.zone = zone || "none";
  refs.zonePills.forEach((pill) => {
    pill.classList.toggle("is-active", pill.dataset.zone === zone);
  });
}

function renderFeed(items) {
  lastFeedSignature = feedSignature(items);
  refs.feedList.innerHTML = "";

  items.slice(0, MAX_FEED_ITEMS).forEach((item) => {
    const zone = item.zone || "system";
    const zoneName = zoneLabels[zone] || zoneLabels.system;
    const entry = document.createElement("li");
    entry.className = "feed-item";

    const meta = document.createElement("div");
    meta.className = "feed-item__meta";

    const zoneTag = document.createElement("span");
    zoneTag.className = "feed-item__zone";
    zoneTag.dataset.tone = zone;
    zoneTag.textContent = zoneName;

    const time = document.createElement("span");
    time.className = "feed-item__time";
    time.textContent = formatShortTime(item.time);

    meta.append(zoneTag, time);

    const message = document.createElement("p");
    message.className = "feed-item__message";
    message.textContent = item.message;

    entry.append(meta, message);
    refs.feedList.appendChild(entry);
  });
}

function updateFeed(items, force = false) {
  const nextItems = items.slice(0, MAX_FEED_ITEMS);
  const nextSignature = feedSignature(nextItems);

  if (!force && nextSignature === lastFeedSignature) {
    feedItems = nextItems;
    return;
  }

  feedItems = nextItems;
  renderFeed(feedItems);
}

function pushFeedItem(item) {
  const normalizedItem = {
    zone: item.zone || "system",
    time: item.time || new Date().toISOString(),
    message: translateIncomingText(item.message),
  };

  const head = feedItems[0];
  if (head && head.message === normalizedItem.message && head.zone === normalizedItem.zone) {
    return;
  }

  updateFeed([normalizedItem, ...feedItems].slice(0, MAX_FEED_ITEMS), true);
}

function setConnectionBadge(state) {
  refs.syncBadge.className = `sync-badge sync-badge--${state}`;
  setText(refs.syncBadge, syncBadgeLabels[state] || state);
}

function setInterfaceStatus(state) {
  refs.interfaceStatus.dataset.state = state;
  const labels = {
    online: "已连接",
    offline: "未连接",
    syncing: "连接中",
  };

  setText(refs.interfaceStatusValue, labels[state] || state);
}

function renderNoSignal(message) {
  if (restAnimationTimer) {
    clearTimeout(restAnimationTimer);
    restAnimationTimer = 0;
  }
  setText(refs.zoneName, "未连接");
  setText(refs.taskName, "等待后台状态");
  setTitle(refs.taskName, "等待后台状态");
  setText(refs.taskSummary, message);
  setText(refs.modeValue, "离线");
  setText(refs.alertValue, "离线");
  refs.alertValue.dataset.alert = "OFFLINE";
  setText(refs.loadValue, "--");
  setText(refs.batteryValue, "--");
  setText(refs.temperatureValue, "--");
  setText(refs.queueValue, "--");
  setText(refs.coordValue, "--, --");
  setText(refs.lastSeenValue, "--");
  setText(refs.mapBanner, message);
  queueMapViewportSync();
  setInterfaceStatus("offline");
  setActiveZone("");
  syncPhaserMapState(null);
  if (!hasPhaserMap()) {
    setAlertLights("OFFLINE");
    clearRobot();
  }
  lastRenderedState = null;
  updateTaskActions(null);
  lastStateSignature = "";
}

function renderState(state, options = {}) {
  if (restAnimationTimer) {
    clearTimeout(restAnimationTimer);
    restAnimationTimer = 0;
  }
  const nextSignature = stateSignature(state);
  const changed = nextSignature !== lastStateSignature;
  const previousTaskId = lastRenderedState?.actionableTask?.taskId || "";
  const nextTaskId = state?.actionableTask?.taskId || "";
  const displayTask = resolveDisplayTask(state);
  const bannerArea = resolveBannerArea(state);

  if (changed) {
    setText(refs.zoneName, state.zoneName);
    setText(refs.taskName, compactTaskLabel(displayTask));
    setTitle(refs.taskName, displayTask);
    setText(refs.taskSummary, state.description);
    setText(refs.modeValue, state.mode);
    setText(refs.alertValue, state.alertText);
    setText(refs.loadValue, state.load);
    setText(refs.batteryValue, state.battery);
    setText(refs.temperatureValue, state.temperature);
    setText(refs.queueValue, state.taskCount);
    setText(refs.coordValue, `${pad2(state.position.x)}, ${pad2(state.position.y)}`);
    setText(refs.mapBanner, `${bannerArea} | ${ROBOT_DISPLAY_NAME} | ${displayTask} | 坐标 ${pad2(state.position.x)}, ${pad2(state.position.y)} | ${state.alertText}`);
    queueMapViewportSync();
    refs.alertValue.dataset.alert = state.alertLevel;
    setActiveZone(state.zone);
    if (hasPhaserMap()) {
      syncPhaserMapState(state);
    } else {
      setAlertLights(state.alertLevel);
      placeRobot(state.mapPosition || state.position, state.alertLevel);
    }
    lastStateSignature = nextSignature;
  }

  if (!taskActionInFlight && (changed || previousTaskId !== nextTaskId)) {
    taskActionMessage = "";
  }

  lastRenderedState = state;
  updateTaskActions(state);

  setText(refs.lastSeenValue, formatDateTime(state.updatedAt));
  refs.alertValue.dataset.alert = state.alertLevel;
  if (!hasPhaserMap()) {
    setAlertLights(state.alertLevel);
  }

  if (state.logs.length > 0) {
    updateFeed(state.logs);
  } else {
    if (changed) {
      pushFeedItem({
        zone: state.zone,
        time: state.updatedAt,
        message: `${bannerArea} 执行 ${displayTask}，坐标落点 (${pad2(state.position.x)}, ${pad2(state.position.y)})。`,
      });
    }
  }

  if (!useDemo && rawStatusCache && state.zone === "rest" && Number(state.restAnimationNextMs) > 0) {
    restAnimationTimer = window.setTimeout(() => {
      restAnimationTimer = 0;
      if (!rawStatusCache) {
        return;
      }
      const nextState = normalizeStatus(rawStatusCache);
      lastSuccessfulState = nextState;
      renderState(nextState, { source: "rest-animation" });
    }, Math.max(Number(state.restAnimationNextMs), 1000));
  }
}

function updateClock() {
  refs.clock.textContent = `${formatClock(new Date())} 北京时间`;
}

function describeConnectionError(error) {
  if (error?.name === "AbortError") {
    return `请求 ${CONFIG.endpoint} 超时，请确认后台服务是否已启动。`;
  }

  if (error?.status === 404) {
    return `${CONFIG.endpoint} 返回 404，说明地址能访问，但后端没有这个路由。`;
  }

  if (error?.status) {
    return `${CONFIG.endpoint} 返回 HTTP ${error.status}，请检查接口路径和鉴权。`;
  }

  if (String(error?.message || "").toLowerCase().includes("failed to fetch")) {
    return `无法访问 ${CONFIG.endpoint}，通常是服务没启动、地址不对，或跨域 CORS 未放行。`;
  }

  return `无法连接 ${CONFIG.endpoint}，请检查接口地址和 CORS。`;
}

async function fetchStatus(forceRefresh = false) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  const requestUrl = buildHttpUrl(forceRefresh);

  try {
    const [response] = await Promise.all([
      fetch(requestUrl, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...CONFIG.headers,
        },
        signal: controller.signal,
      }),
      refreshTaskStats(),
      refreshTaskRuntime(),
    ]);

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const payload = await response.json();
    return {
      raw: payload,
      state: normalizeStatus(payload),
      requestUrl,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function normalizeWsEnvelope(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "ignore" };
  }

  const type = String(parsed?.type || "").toLowerCase();

  if (type === "hello") {
    return {
      type: "hello",
      latestEventId: normalizeEventCursor(parsed.latestEventId),
      payload: parsed,
    };
  }

  if (type === "replay_reset") {
    return {
      type: "replay_reset",
      latestEventId: normalizeEventCursor(firstDefined(parsed.latestEventId, parsed.eventId)),
      reason: firstDefined(parsed.reason, "replay_reset"),
      payload: firstDefined(parsed.payload, parsed.data, null),
    };
  }

  if (type === "status" || parsed?.patch !== undefined || parsed?.payload !== undefined || parsed?.data !== undefined || parsed?.zone || parsed?.robot || parsed?.openclaw) {
    const mode = String(firstDefined(parsed.mode, parsed.patch !== undefined ? "patch" : "snapshot")).toLowerCase();
    const payload = mode === "patch"
      ? firstDefined(parsed.patch, parsed.payload, parsed.data, {})
      : firstDefined(parsed.payload, parsed.data, parsed);

    return {
      type: "status",
      mode,
      reason: firstDefined(parsed.reason, parsed.event, "status"),
      eventId: normalizeEventCursor(parsed.eventId),
      baseEventId: normalizeEventCursor(parsed.baseEventId),
      replay: Boolean(parsed.replay),
      ts: firstDefined(parsed.ts, parsed.timestamp, new Date().toISOString()),
      payload,
    };
  }

  if (["ping", "pong", "heartbeat"].includes(type)) {
    return { type: "ignore" };
  }

  return { type: "ignore" };
}

function commitOnlineState(rawState, options = {}) {
  rawStatusCache = cloneJson(rawState);
  const state = normalizeStatus(rawStatusCache);
  const recovered = connectionState !== "online";

  connectionState = "online";
  lastSuccessfulState = state;

  if (options.stopFallbackPolling) {
    stopPolling();
  }

  setConnectionBadge("online");
  setInterfaceStatus("online");
  renderState(state, { source: options.source || "http" });

  if (recovered && options.recoveryMessage) {
    pushFeedItem({
      zone: "system",
      time: state.updatedAt,
      message: options.recoveryMessage,
    });
  }

  void refreshTaskStats();
  void refreshTaskRuntime();

  return state;
}

function stopPolling() {
  pollActive = false;
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }
}

function scheduleNextPoll() {
  if (!pollActive) {
    return;
  }

  if (pollTimer) {
    window.clearTimeout(pollTimer);
  }

  pollTimer = window.setTimeout(runPollCycle, CONFIG.pollIntervalMs);
}

async function runPollCycle() {
  if (!pollActive) {
    return;
  }

  setConnectionBadge("syncing");
  setInterfaceStatus("syncing");

  try {
    const result = await fetchStatus();
    commitOnlineState(result.raw, {
      source: "http",
      recoveryMessage: "HTTP 兜底已接管状态同步。",
    });
  } catch (error) {
    const message = describeConnectionError(error);
    const wasOnline = connectionState === "online";
    connectionState = "offline";
    setConnectionBadge("offline");
    setInterfaceStatus("offline");

    if (lastSuccessfulState) {
      renderState(lastSuccessfulState, { source: "http" });
      setText(refs.mapBanner, `${lastSuccessfulState.zoneName} | 保留最近一次有效位置 | ${message}`);
    } else {
      renderNoSignal(message);
    }

    if (wasOnline || feedItems.length === 0) {
      pushFeedItem({
        zone: "system",
        time: new Date().toISOString(),
        message,
      });
    }
  } finally {
    scheduleNextPoll();
  }
}

function startPolling(reason = "") {
  if (pollActive) {
    return;
  }

  pollActive = true;
  if (reason) {
    pushFeedItem({
      zone: "system",
      time: new Date().toISOString(),
      message: reason,
    });
  }
  runPollCycle();
}

function scheduleWsReconnect() {
  if (!CONFIG.wsEndpoint || useMock) {
    return;
  }

  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
  }

  reconnectTimer = window.setTimeout(() => {
    connectWebSocket();
  }, CONFIG.wsReconnectDelayMs);
}

function handleReplayReset(message) {
  if (message.latestEventId) {
    lastEventId = message.latestEventId;
  }

  rawStatusCache = null;
  setConnectionBadge("syncing");
  setInterfaceStatus("syncing");
  pushFeedItem({
    zone: "system",
    time: new Date().toISOString(),
    message: "回放窗口已重置，正在等待最新快照。",
  });

  if (message.payload) {
    commitOnlineState(message.payload, {
      source: "ws",
      stopFallbackPolling: true,
      recoveryMessage: "最新快照已收到，实时订阅恢复。",
    });
  }
}

function requestWsResync(reason) {
  wsCloseHint = reason;
  connectionState = "syncing";
  setConnectionBadge("syncing");
  setInterfaceStatus("syncing");

  if (websocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(websocket.readyState)) {
    websocket.close();
    return;
  }

  startPolling(reason);
  scheduleWsReconnect();
  wsCloseHint = "";
}

function handleWsStatus(message) {
  const mode = String(message.mode || "snapshot").toLowerCase();
  const eventCursor = normalizeEventCursor(message.eventId);
  const baseCursor = normalizeEventCursor(message.baseEventId);

  if (mode === "patch") {
    if (!rawStatusCache) {
      requestWsResync("实时流收到增量更新，但本地没有快照，正在重新同步。");
      return;
    }

    if (baseCursor && lastEventId && baseCursor !== lastEventId) {
      requestWsResync("实时流事件序号不连续，正在重新同步最新状态。");
      return;
    }

    if (eventCursor) {
      lastEventId = eventCursor;
    }

    commitOnlineState(applyMergePatch(rawStatusCache, message.payload || {}), {
      source: "ws",
      stopFallbackPolling: true,
      recoveryMessage: "WebSocket 实时订阅已恢复，页面按增量状态刷新。",
    });
    return;
  }

  if (eventCursor) {
    lastEventId = eventCursor;
  }

  commitOnlineState(message.payload || {}, {
    source: "ws",
    stopFallbackPolling: true,
    recoveryMessage: message.replay ? "WebSocket 回放完成，实时状态已恢复。" : "WebSocket 实时订阅已恢复，页面按增量状态刷新。",
  });
}

function connectWebSocket() {
  if (!CONFIG.wsEndpoint || useMock || useDemo) {
    return;
  }

  if (websocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(websocket.readyState)) {
    return;
  }

  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }

  try {
    websocket = new WebSocket(buildWsUrl());
  } catch (error) {
    setInterfaceStatus("offline");
    startPolling("WebSocket 初始化失败，已回退 HTTP 轮询。");
    scheduleWsReconnect();
    return;
  }

  setConnectionBadge("syncing");
  setInterfaceStatus("syncing");
  connectionState = "syncing";

  websocket.addEventListener("open", () => {
    setConnectionBadge("syncing");
    setInterfaceStatus("syncing");
    connectionState = "syncing";
  });

  websocket.addEventListener("message", (event) => {
    const message = normalizeWsEnvelope(event.data);

    if (message.type === "hello") {
      return;
    }

    if (message.type === "replay_reset") {
      handleReplayReset(message);
      return;
    }

    if (message.type === "status") {
      handleWsStatus(message);
    }
  });

  websocket.addEventListener("close", () => {
    websocket = null;
    const reason = wsCloseHint || "WebSocket 已断开，自动回退 HTTP，并按上次事件序号恢复实时流。";
    wsCloseHint = "";
    connectionState = "syncing";

    if (lastSuccessfulState) {
      renderState(lastSuccessfulState, { source: "http" });
      setText(refs.mapBanner, `${lastSuccessfulState.zoneName} | 保留最近一次有效位置 | ${reason}`);
    } else {
      renderNoSignal(reason);
    }

    setConnectionBadge("syncing");
    setInterfaceStatus("syncing");
    startPolling(reason);
    scheduleWsReconnect();
  });

  websocket.addEventListener("error", () => {
    setConnectionBadge("syncing");
    setInterfaceStatus("syncing");
  });
}

function buildDemoPayloads() {
  const now = Date.now();
  const isoAt = (offsetMs) => new Date(now + offsetMs).toISOString();

  const payloads = [
    {
      zone: "rest",
      scene: "room",
      idleActivity: "",
      position: { x: 4, y: 6 },
      task: "卧室休息",
      description: `${ROBOT_DISPLAY_NAME} 正在休息区整理状态，准备出门巡场。`,
      mode: "IDLE",
      alertLevel: "GREEN",
      load: 8,
      battery: 98,
      temperature: 31,
      updatedAt: isoAt(0),
      runtime: {
        currentTask: null,
        nextTask: null,
        queueSummary: { queued: 0, running: 0, failed: 0 },
      },
      logs: [
        { zone: "rest", time: isoAt(0), message: "休息区待命，准备出门巡场。" },
      ],
    },
    {
      zone: "rest",
      scene: "outdoor",
      idleActivity: "walk_dog",
      position: { x: 5, y: 10 },
      task: "室外遛弯",
      description: `${ROBOT_DISPLAY_NAME} 已从休息区出门，正在门外放风。`,
      mode: "IDLE",
      alertLevel: "GREEN",
      load: 12,
      battery: 97,
      temperature: 32,
      updatedAt: isoAt(5000),
      runtime: {
        currentTask: null,
        nextTask: {
          taskId: "demo_task_work",
          title: "去工作区整理文档",
          status: "queued",
          scheduledAt: isoAt(12000),
        },
        queueSummary: { queued: 1, running: 0, failed: 0 },
      },
      logs: [
        { zone: "rest", time: isoAt(5000), message: "小龙虾从休息区门口出门，开始外出放风。" },
      ],
    },
    {
      zone: "work",
      scene: "room",
      idleActivity: "",
      position: { x: 13, y: 7 },
      task: "整理项目文档",
      description: `${ROBOT_DISPLAY_NAME} 已进入工作区，正在工位处理文档整理任务。`,
      mode: "RUNNING",
      alertLevel: "BLUE",
      load: 56,
      battery: 95,
      temperature: 37,
      updatedAt: isoAt(10000),
      runtime: {
        currentTask: {
          taskId: "demo_task_work",
          title: "整理项目文档",
          status: "running",
          startedAt: isoAt(9000),
          progress: 42,
          etaSeconds: 160,
        },
        nextTask: {
          taskId: "demo_task_alarm",
          title: "检查警报控制台",
          status: "queued",
          scheduledAt: isoAt(18000),
        },
        queueSummary: { queued: 1, running: 1, failed: 0 },
      },
      logs: [
        { zone: "work", time: isoAt(10000), message: "小龙虾到达工作区门口并进入工位。" },
      ],
    },
    {
      zone: "rest",
      scene: "outdoor",
      idleActivity: "supermarket",
      position: { x: 13, y: 11 },
      task: "逛超市补给",
      description: `${ROBOT_DISPLAY_NAME} 当前没有新的运行任务，正在室外补给后返程。`,
      mode: "IDLE",
      alertLevel: "GREEN",
      load: 10,
      battery: 92,
      temperature: 33,
      updatedAt: isoAt(15000),
      runtime: {
        currentTask: null,
        nextTask: null,
        queueSummary: { queued: 0, running: 0, failed: 0 },
      },
      logs: [
        { zone: "system", time: isoAt(15000), message: "演示模式：已完成休息区与工作区巡场，返回室外闲逛。" },
      ],
    },
  ];

  if (demoAlertEnabled) {
    payloads.splice(3, 0, {
      zone: "alarm",
      scene: "room",
      idleActivity: "",
      position: { x: 20, y: 10 },
      task: "检查警报控制台",
      description: `${ROBOT_DISPLAY_NAME} 已收到警报，进入警报区核对控制台与告警灯状态。`,
      mode: "RUNNING",
      alertLevel: "AMBER",
      load: 48,
      battery: 93,
      temperature: 39,
      updatedAt: isoAt(15000),
      runtime: {
        currentTask: {
          taskId: "demo_task_alarm",
          title: "检查警报控制台",
          status: "running",
          startedAt: isoAt(14500),
          progress: 78,
          etaSeconds: 60,
        },
        nextTask: null,
        queueSummary: { queued: 0, running: 1, failed: 0 },
      },
      logs: [
        { zone: "alarm", time: isoAt(15000), message: "警报区亮灯，小龙虾已进入控制室检查。" },
      ],
    });
  }

  return payloads;
}

function stopDemoLoop() {
  if (demoTimer) {
    window.clearTimeout(demoTimer);
    demoTimer = 0;
  }
}

function startDemoLoop() {
  stopDemoLoop();
  const demoPayloads = buildDemoPayloads();
  let demoIndex = 0;

  const applyDemoStep = () => {
    const payload = cloneJson(demoPayloads[demoIndex]);
    commitOnlineState(payload, {
      source: "demo",
      stopFallbackPolling: true,
      recoveryMessage: "",
    });

    demoIndex = (demoIndex + 1) % demoPayloads.length;
    demoTimer = window.setTimeout(applyDemoStep, DEMO_STEP_DURATION_MS);
  };

  pushFeedItem({
    zone: "system",
    time: new Date().toISOString(),
    message: demoAlertEnabled
      ? "演示模式已启动，将按流程展示休息区、室外、工作区，并在触发告警演示时进入警报区。"
      : "演示模式已启动，将自动展示休息区、室外和工作区的活动过程；警报区只在出现告警时进入。",
  });
  applyDemoStep();
}

async function bootstrapSync() {
  if (useDemo) {
    connectionState = "online";
    setConnectionBadge("online");
    setInterfaceStatus("online");
    startDemoLoop();
    return;
  }

  if (useMock || !CONFIG.wsEndpoint) {
    startPolling("当前未启用 WebSocket，使用 HTTP 轮询。");
    return;
  }

  setConnectionBadge("syncing");
  setInterfaceStatus("syncing");

  try {
    const result = await fetchStatus();
    commitOnlineState(result.raw, { source: "http" });
  } catch (error) {
    const message = describeConnectionError(error);
    renderNoSignal(message);
    setConnectionBadge("syncing");
    setInterfaceStatus("syncing");
  }

  connectWebSocket();
}

createMap();
renderFeed(feedItems);
updateClock();
renderNoSignal("等待后端状态。需要返回 zone、position.x、position.y、task、alertLevel。");
window.setInterval(updateClock, 1000);
window.addEventListener("resize", queueMapViewportSync);
refs.retryTaskButton?.addEventListener("click", () => {
  void performTaskAction("retry");
});
refs.resolveTaskButton?.addEventListener("click", () => {
  void performTaskAction("resolve");
});
if (typeof ResizeObserver === "function") {
  const mapResizeObserver = new ResizeObserver(() => {
    queueMapViewportSync();
  });
  mapResizeObserver.observe(refs.mapScreen);
  mapResizeObserver.observe(refs.mapBottom);
}
bootstrapSync();
