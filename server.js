const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3008);
const WEB_ROOT = __dirname;
const ROBOT_NAME = "小龙虾";

const STATUS_TIMEOUT_MS = Number(process.env.OPENCLAW_STATUS_TIMEOUT_MS || 12000);
const STATUS_POLL_INTERVAL_MS = Number(process.env.OPENCLAW_STATUS_POLL_INTERVAL_MS || 3500);
const STATUS_REFRESH_DEBOUNCE_MS = Number(process.env.OPENCLAW_STATUS_REFRESH_DEBOUNCE_MS || 150);
const STATUS_REFRESH_MIN_INTERVAL_MS = Number(process.env.OPENCLAW_STATUS_REFRESH_MIN_INTERVAL_MS || 600);
const TASK_STATS_URL = process.env.OPENCLAW_TASK_STATS_URL || "";
const TASK_RUNTIME_URL = process.env.OPENCLAW_TASK_RUNTIME_URL || "";
const TASK_STATS_TIMEOUT_MS = Number(process.env.OPENCLAW_TASK_STATS_TIMEOUT_MS || 5000);
const TASK_RUNTIME_TIMEOUT_MS = Number(process.env.OPENCLAW_TASK_RUNTIME_TIMEOUT_MS || TASK_STATS_TIMEOUT_MS);
const TASK_STATS_AUTH_TOKEN = process.env.OPENCLAW_TASK_STATS_AUTH_TOKEN || "";

const WS_PATH = process.env.OPENCLAW_WS_PATH || "/ws/openclaw/status";
const WS_PING_INTERVAL_MS = Number(process.env.OPENCLAW_WS_PING_INTERVAL_MS || 20000);
const EVENT_BUFFER_SIZE = Number(process.env.OPENCLAW_EVENT_BUFFER_SIZE || 300);

const CORS_ORIGIN = process.env.OPENCLAW_CORS_ORIGIN || "*";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const streamState = {
  latestPayload: null,
  latestError: null,
  latestUpdatedAtMs: 0,
  latestFetchDurationMs: 0,

  latestSignature: "",
  publishedPayload: null,

  latestEventId: 0,
  nextEventId: 1,
  events: [],

  fetchInFlight: null,

  // refresh throttle/debounce
  lastRefreshStartedAtMs: 0,
  refreshDebounceTimer: null,
  pendingRefreshReasons: new Set(),
  refreshQueued: false,
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = toFiniteNumber(value);
    if (numeric !== null) {
      return numeric;
    }
  }

  return null;
}

function countArray(value) {
  return Array.isArray(value) ? value.length : null;
}

function getTaskEndpointCandidates(explicitUrl, pathname) {
  const fromEnv = String(explicitUrl || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) {
    return fromEnv;
  }

  const selfHosts = new Set([
    `http://${HOST}:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
  ]);

  return [
    `http://localhost:3008${pathname}`,
    `http://127.0.0.1:3010${pathname}`,
    `http://localhost:3010${pathname}`,
    `http://127.0.0.1:3008${pathname}`,
  ].filter((value) => {
    try {
      const url = new URL(value);
      return !selfHosts.has(url.origin);
    } catch {
      return false;
    }
  });
}

function getTaskStatsCandidates() {
  return getTaskEndpointCandidates(TASK_STATS_URL, "/api/tasks/stats");
}

function getTaskRuntimeCandidates() {
  return getTaskEndpointCandidates(TASK_RUNTIME_URL, "/api/tasks/runtime");
}

function deriveTaskStatsFromPayload(payload) {
  const root = payload?.data || payload?.stats || payload;
  if (!root || typeof root !== "object") {
    return null;
  }

  const taskCounts = isPlainObject(root.taskCount) ? root.taskCount : null;
  const taskList = Array.isArray(root.taskList)
    ? root.taskList
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.tasks)
        ? root.tasks
        : Array.isArray(root.list)
          ? root.list
          : [];
  const groupedTaskCount =
    ["todo", "doing", "blocked", "inProgress", "pending"].some((key) => toFiniteNumber(taskCounts?.[key]) !== null || toFiniteNumber(root[key]) !== null)
      ? ["todo", "doing", "blocked", "inProgress", "pending"].reduce((sum, key) => {
        return sum + (toFiniteNumber(taskCounts?.[key]) || toFiniteNumber(root[key]) || 0);
      }, 0)
      : null;

  const itemsCount = taskList.length || null;
  const taskCount = firstFiniteNumber(
    taskCounts?.total,
    root.taskCount,
    root.activeTaskCount,
    root.openTaskCount,
    root.currentTaskCount,
    root.count,
    groupedTaskCount,
    itemsCount,
  );
  const totalTasks = firstFiniteNumber(
    taskCounts?.total,
    root.totalTasks,
    root.total,
    root.taskTotal,
    root.allTaskCount,
    itemsCount,
    taskCount,
  );

  if (taskCount === null && totalTasks === null) {
    return null;
  }

  const currentTask = taskList.find((task) => String(task?.status || "").toLowerCase() === "doing")
    || taskList.find((task) => String(task?.status || "").toLowerCase() === "blocked")
    || taskList[0]
    || null;

  return {
    taskCount: taskCount ?? totalTasks ?? 0,
    totalTasks: totalTasks ?? taskCount ?? 0,
    todo: firstFiniteNumber(taskCounts?.todo, root.todo),
    doing: firstFiniteNumber(taskCounts?.doing, root.doing, root.inProgress),
    blocked: firstFiniteNumber(taskCounts?.blocked, root.blocked),
    done: firstFiniteNumber(taskCounts?.done, root.done),
    projectId: root.projectId || "",
    projectName: root.projectName || "",
    currentTask: currentTask
      ? {
          taskId: currentTask.taskId || currentTask.id || "",
          title: currentTask.title || currentTask.name || "",
          status: String(currentTask.status || "").toLowerCase(),
          priority: currentTask.priority || "",
          assignee: currentTask.assignee?.name || currentTask.assignee || "",
          progress: toFiniteNumber(currentTask.progress),
          dueAt: currentTask.dueAt || "",
          updatedAt: currentTask.updatedAt || "",
        }
      : null,
    source: TASK_STATS_URL ? "task-stats-endpoint" : "task-stats-auto",
  };
}

function deriveTaskStatsFromStatus(status) {
  const hasTaskSignals =
    status?.taskCount !== undefined ||
    status?.activeTaskCount !== undefined ||
    status?.totalTasks !== undefined ||
    status?.taskTotal !== undefined ||
    status?.taskList !== undefined ||
    status?.activeTasks !== undefined ||
    status?.queuedTasks !== undefined ||
    (status?.tasks && typeof status.tasks === "object");

  if (!hasTaskSignals) {
    return null;
  }

  const groupedTaskCount =
    ["todo", "doing", "blocked", "inProgress", "pending"].some((key) => toFiniteNumber(status?.tasks?.[key]) !== null || toFiniteNumber(status?.[key]) !== null)
      ? ["todo", "doing", "blocked", "inProgress", "pending"].reduce((sum, key) => {
        return sum + (toFiniteNumber(status?.tasks?.[key]) || toFiniteNumber(status?.[key]) || 0);
      }, 0)
      : null;

  const listCount =
    countArray(status?.tasks?.items) ??
    countArray(status?.tasks) ??
    countArray(status?.taskList) ??
    countArray(status?.activeTasks) ??
    countArray(status?.queuedTasks);

  const taskCount = firstFiniteNumber(
    status?.taskCount,
    status?.activeTaskCount,
    status?.tasks?.count,
    status?.tasks?.active,
    status?.tasks?.activeCount,
    groupedTaskCount,
    listCount,
  );
  const totalTasks = firstFiniteNumber(
    status?.totalTasks,
    status?.tasks?.total,
    status?.taskTotal,
    listCount,
    taskCount,
  );

  if (taskCount === null && totalTasks === null) {
    return null;
  }

  return {
    taskCount: taskCount ?? totalTasks ?? 0,
    totalTasks: totalTasks ?? taskCount ?? 0,
    source: "status",
  };
}

function deriveTaskRuntimeFromPayload(payload) {
  const root = payload?.data || payload?.runtime || payload;
  if (!root || typeof root !== "object") {
    return null;
  }

  const currentTaskRoot = isPlainObject(root.currentTask) ? root.currentTask : null;
  const nextTaskRoot = isPlainObject(root.nextTask) ? root.nextTask : null;
  const queueSummaryRoot = isPlainObject(root.queueSummary) ? root.queueSummary : null;

  const queued = firstFiniteNumber(queueSummaryRoot?.queued, root.queued, root.queueCount);
  const running = firstFiniteNumber(
    queueSummaryRoot?.running,
    root.running,
    root.runningCount,
    currentTaskRoot ? 1 : null,
  );
  const failed = firstFiniteNumber(queueSummaryRoot?.failed, root.failed, root.failedCount);

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
          progress: toFiniteNumber(currentTaskRoot.progress),
          etaSeconds: firstFiniteNumber(currentTaskRoot.etaSeconds, currentTaskRoot.eta),
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
    source: TASK_RUNTIME_URL ? "task-runtime-endpoint" : "task-runtime-auto",
  };
}

function synthesizeTaskRuntimeFromTaskStats(taskStats) {
  if (!taskStats) {
    return null;
  }

  const queued = firstFiniteNumber(taskStats.todo, taskStats.pending, 0);
  const running = firstFiniteNumber(taskStats.doing, taskStats.inProgress, 0);
  const failed = firstFiniteNumber(taskStats.blocked, 0);

  if (!taskStats.currentTask && queued === null && running === null && failed === null) {
    return null;
  }

  return {
    currentTask: taskStats.currentTask
      ? {
          taskId: taskStats.currentTask.taskId || "",
          title: taskStats.currentTask.title || "",
          status: taskStats.currentTask.status || (running > 0 ? "running" : "queued"),
          startedAt: taskStats.currentTask.updatedAt || "",
          progress: taskStats.currentTask.progress ?? null,
          etaSeconds: null,
        }
      : null,
    nextTask: null,
    queueSummary: {
      queued: queued ?? 0,
      running: running ?? 0,
      failed: failed ?? 0,
    },
    source: "task-stats-fallback",
  };
}

// RFC 7396-style merge patch: 返回“仅变更字段”
function createMergePatch(prev, next) {
  if (deepEqual(prev, next)) {
    return undefined;
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const patch = {};
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);

    for (const key of keys) {
      if (!(key in next)) {
        patch[key] = null;
        continue;
      }

      if (!(key in prev)) {
        patch[key] = deepClone(next[key]);
        continue;
      }

      const childPatch = createMergePatch(prev[key], next[key]);
      if (childPatch !== undefined) {
        patch[key] = childPatch;
      }
    }

    return Object.keys(patch).length > 0 ? patch : undefined;
  }

  return deepClone(next);
}

function countPatchLeaves(patch) {
  if (!isPlainObject(patch)) {
    return 1;
  }

  const values = Object.values(patch);
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((acc, value) => acc + countPatchLeaves(value), 0);
}

function nextEventId() {
  const id = streamState.nextEventId;
  streamState.nextEventId += 1;
  return id;
}

function appendEvent(event) {
  streamState.events.push(event);

  if (streamState.events.length > EVENT_BUFFER_SIZE) {
    streamState.events.splice(0, streamState.events.length - EVENT_BUFFER_SIZE);
  }

  streamState.latestEventId = event.eventId;
}

function sendWs(ws, payload) {
  if (ws.readyState !== 1) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function broadcastWs(payload) {
  const raw = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(raw);
    }
  }
}

function emitEvent(event) {
  appendEvent(event);
  broadcastWs(event);
}

function replayWindowMeta() {
  const first = streamState.events[0]?.eventId ?? null;
  const last = streamState.events[streamState.events.length - 1]?.eventId ?? streamState.latestEventId ?? null;

  return {
    from: first,
    to: last,
    count: streamState.events.length,
  };
}

function replayEventsFrom(ws, lastEventIdRaw) {
  const hasLastEventId =
    lastEventIdRaw !== null &&
    lastEventIdRaw !== undefined &&
    String(lastEventIdRaw).trim() !== "";

  // 无 lastEventId：直接给最新快照（非 replay）
  if (!hasLastEventId) {
    if (streamState.latestPayload) {
      sendWs(ws, {
        type: "status",
        mode: "snapshot",
        eventId: streamState.latestEventId,
        ts: new Date().toISOString(),
        replay: false,
        reason: "connect-snapshot",
        payload: streamState.latestPayload,
      });
    }
    return;
  }

  const lastEventId = Number(lastEventIdRaw);

  if (!Number.isInteger(lastEventId) || lastEventId < 0) {
    sendWs(ws, {
      type: "replay_reset",
      ts: new Date().toISOString(),
      reason: "invalid_last_event_id",
      replayWindow: replayWindowMeta(),
    });

    if (streamState.latestPayload) {
      sendWs(ws, {
        type: "status",
        mode: "snapshot",
        eventId: streamState.latestEventId,
        ts: new Date().toISOString(),
        replay: true,
        reason: "invalid-last-event-id-snapshot",
        payload: streamState.latestPayload,
      });
    }
    return;
  }

  if (streamState.events.length === 0) {
    if (streamState.latestPayload) {
      sendWs(ws, {
        type: "status",
        mode: "snapshot",
        eventId: streamState.latestEventId,
        ts: new Date().toISOString(),
        replay: true,
        reason: "snapshot-empty-buffer",
        payload: streamState.latestPayload,
      });
    }
    return;
  }

  const latestKnownEventId = streamState.events[streamState.events.length - 1]?.eventId ?? streamState.latestEventId ?? 0;

  // 客户端游标比服务端当前最新事件还大，通常说明服务端刚重启或事件流已重置。
  if (lastEventId > latestKnownEventId) {
    sendWs(ws, {
      type: "replay_reset",
      ts: new Date().toISOString(),
      reason: "cursor_ahead_of_server",
      replayWindow: replayWindowMeta(),
    });

    if (streamState.latestPayload) {
      sendWs(ws, {
        type: "status",
        mode: "snapshot",
        eventId: streamState.latestEventId,
        ts: new Date().toISOString(),
        replay: true,
        reason: "cursor-ahead-snapshot",
        payload: streamState.latestPayload,
      });
    }
    return;
  }

  const firstId = streamState.events[0].eventId;

  // 客户端太旧，历史已裁剪：通知重置并发全量快照
  if (lastEventId < firstId - 1) {
    sendWs(ws, {
      type: "replay_reset",
      ts: new Date().toISOString(),
      reason: "history_pruned",
      replayWindow: replayWindowMeta(),
    });

    if (streamState.latestPayload) {
      sendWs(ws, {
        type: "status",
        mode: "snapshot",
        eventId: streamState.latestEventId,
        ts: new Date().toISOString(),
        replay: true,
        reason: "replay-reset-snapshot",
        payload: streamState.latestPayload,
      });
    }
    return;
  }

  const missed = streamState.events.filter((event) => event.eventId > lastEventId);
  for (const event of missed) {
    sendWs(ws, { ...event, replay: true });
  }
}

function mapAlertLevel(status) {
  const reachable = Boolean(status?.gateway?.reachable);
  const critical = Number(status?.securityAudit?.summary?.critical || 0);
  const warn = Number(status?.securityAudit?.summary?.warn || 0);

  if (!reachable || critical > 0) {
    return "RED";
  }
  if (warn > 0) {
    return "AMBER";
  }
  return "GREEN";
}

function mapZone(status, alertLevel, taskStats, taskRuntime) {
  if (alertLevel === "RED") {
    return "alarm";
  }

  const taskCount = toFiniteNumber(taskStats?.taskCount);
  const doingCount = toFiniteNumber(taskStats?.doing);
  const blockedCount = toFiniteNumber(taskStats?.blocked);
  const runningCount = toFiniteNumber(taskRuntime?.queueSummary?.running);
  const failedCount = toFiniteNumber(taskRuntime?.queueSummary?.failed);
  if (doingCount !== null || blockedCount !== null || taskCount !== null || runningCount !== null || failedCount !== null) {
    if ((failedCount || blockedCount || 0) > 0) {
      return "alarm";
    }
    if ((runningCount || doingCount || 0) > 0) {
      return "work";
    }
    return "rest";
  }

  const sessionCount = Number(status?.sessions?.count || 0);
  if (sessionCount > 0) {
    return "work";
  }

  return "rest";
}

function zonePosition(zone) {
  if (zone === "work") {
    return { x: 17, y: 7 };
  }
  if (zone === "alarm") {
    return { x: 18, y: 13 };
  }
  return { x: 4, y: 6 };
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildTaskSummary(taskStats) {
  if (!taskStats) {
    return null;
  }

  const total = toFiniteNumber(taskStats.totalTasks ?? taskStats.taskCount);
  const doing = toFiniteNumber(taskStats.doing);
  const blocked = toFiniteNumber(taskStats.blocked);
  const projectName = taskStats.projectName || "OpenClaw任务中心";

  if ((total ?? 0) <= 0) {
    return `${projectName} · 当前无任务`;
  }

  return `${projectName} · 共 ${total ?? 0} 项 · 进行中 ${doing ?? 0} 项${(blocked || 0) > 0 ? ` · 阻塞 ${blocked} 项` : ""}`;
}

function translateTaskStatus(status) {
  const raw = String(status || "").trim().toLowerCase();
  const labels = {
    todo: "待开始",
    doing: "进行中",
    running: "运行中",
    queued: "排队中",
    blocked: "已阻塞",
    failed: "执行失败",
    done: "已完成",
    archived: "已归档",
  };

  return labels[raw] || raw || "待开始";
}

function formatEtaLabel(seconds) {
  const numeric = toFiniteNumber(seconds);
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

function buildRuntimeSummary(taskRuntime) {
  if (!taskRuntime) {
    return null;
  }

  const parts = [];
  const currentTask = taskRuntime.currentTask;
  const nextTask = taskRuntime.nextTask;
  const queueSummary = taskRuntime.queueSummary || {};

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

function resolveScene(taskStats, taskRuntime, zone) {
  if (zone !== "rest") {
    return "room";
  }

  const running = toFiniteNumber(taskRuntime?.queueSummary?.running);
  const failed = toFiniteNumber(taskRuntime?.queueSummary?.failed);
  if ((running || 0) > 0 || (failed || 0) > 0 || taskRuntime?.currentTask?.title) {
    return "room";
  }

  return "outdoor";
}

function resolveIdleActivity(taskStats, taskRuntime, scene) {
  if (scene !== "outdoor") {
    return "";
  }

  const queued = toFiniteNumber(taskRuntime?.queueSummary?.queued);
  if ((queued || 0) > 0) {
    return "stroll";
  }

  return "walk_dog";
}

function idleActivityTaskLabel(idleActivity) {
  const labels = {
    walk_dog: "遛狗中",
    stroll: "外出遛弯",
    walk: "外出散步",
    supermarket: "逛超市",
    town: "城里闲逛",
    park: "公园散步",
    coffee: "喝咖啡",
  };

  return labels[idleActivity] || "外出放风";
}

async function fetchTaskStatsAsync() {
  const candidates = getTaskStatsCandidates();
  for (const url of candidates) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TASK_STATS_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(TASK_STATS_AUTH_TOKEN ? { Authorization: `Bearer ${TASK_STATS_AUTH_TOKEN}` } : {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const derived = deriveTaskStatsFromPayload(payload);
      if (derived) {
        return {
          ...derived,
          source: TASK_STATS_URL ? "task-stats-endpoint" : `task-stats-auto:${url}`,
        };
      }
    } catch {
      // ignore and try next candidate
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return null;
}

async function fetchTaskRuntimeAsync() {
  const candidates = getTaskRuntimeCandidates();
  for (const url of candidates) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TASK_RUNTIME_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(TASK_STATS_AUTH_TOKEN ? { Authorization: `Bearer ${TASK_STATS_AUTH_TOKEN}` } : {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const derived = deriveTaskRuntimeFromPayload(payload);
      if (derived) {
        return {
          ...derived,
          source: TASK_RUNTIME_URL ? "task-runtime-endpoint" : `task-runtime-auto:${url}`,
        };
      }
    } catch {
      // ignore and try next candidate
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return null;
}

function toDashboardPayload(status, taskStats, taskRuntime) {
  const alertLevel = mapAlertLevel(status);
  const resolvedTaskStats = taskStats || deriveTaskStatsFromStatus(status) || {
    taskCount: Number(status?.sessions?.count || 0),
    totalTasks: Number(status?.sessions?.count || 0),
    source: "sessions-fallback",
  };
  const resolvedTaskRuntime = taskRuntime || synthesizeTaskRuntimeFromTaskStats(resolvedTaskStats);
  const zone = mapZone(status, alertLevel, resolvedTaskStats, resolvedTaskRuntime);
  const scene = resolveScene(resolvedTaskStats, resolvedTaskRuntime, zone);
  const idleActivity = resolveIdleActivity(resolvedTaskStats, resolvedTaskRuntime, scene);
  const position = zonePosition(zone);
  const recent = status?.sessions?.recent?.[0] || null;
  const now = new Date().toISOString();
  const reachable = Boolean(status?.gateway?.reachable);
  const queued = Array.isArray(status?.queuedSystemEvents) ? status.queuedSystemEvents.length : 0;
  const currentTask = resolvedTaskRuntime?.currentTask || resolvedTaskStats?.currentTask || null;
  const nextTask = resolvedTaskRuntime?.nextTask || null;
  const runtimeSummary = buildRuntimeSummary(resolvedTaskRuntime);
  const taskSummary = buildTaskSummary(resolvedTaskStats);
  const taskCount = toFiniteNumber(resolvedTaskStats?.taskCount);
  const totalTasks = toFiniteNumber(resolvedTaskStats?.totalTasks ?? resolvedTaskStats?.taskCount);
  const doingCount = toFiniteNumber(resolvedTaskStats?.doing);
  const blockedCount = toFiniteNumber(resolvedTaskStats?.blocked);
  const runningCount = toFiniteNumber(resolvedTaskRuntime?.queueSummary?.running);
  const queuedCount = toFiniteNumber(resolvedTaskRuntime?.queueSummary?.queued);
  const failedCount = toFiniteNumber(resolvedTaskRuntime?.queueSummary?.failed);
  const mode = !reachable
    ? "OFFLINE"
    : (runningCount || doingCount || 0) > 0
      ? "RUNNING"
      : (failedCount || blockedCount || 0) > 0
        ? "ERROR"
        : "IDLE";

  const contextTokens = Number(recent?.contextTokens || 0);
  const inputTokens = Number(recent?.inputTokens || 0);
  const outputTokens = Number(recent?.outputTokens || 0);
  const computedLoad = contextTokens > 0 ? ((inputTokens + outputTokens) / contextTokens) * 100 : NaN;

  let task = "Gateway unreachable";
  if (reachable) {
    if (currentTask?.title) {
      task = currentTask.title;
    } else if (scene === "outdoor") {
      task = idleActivityTaskLabel(idleActivity);
    } else if ((failedCount || blockedCount || 0) > 0) {
      task = "警报处理中";
    } else if ((runningCount || doingCount || 0) > 0) {
      task = `进行中任务 ${runningCount || doingCount || 0} 项`;
    } else if ((taskCount || totalTasks || 0) > 0) {
      task = nextTask?.title || "等待任务安排";
    } else if (recent?.key) {
      task = `Active: ${recent.key}`;
    } else {
      task = "Idle";
    }
  }

  const description = reachable
    ? currentTask?.title
      ? runtimeSummary || taskSummary || `Gateway online · sessions=${status?.sessions?.count || 0} · node=${status?.nodeService?.runtimeShort || "unknown"}`
      : scene === "outdoor"
        ? `${ROBOT_NAME}当前没有运行任务，正在室外活动。`
        : runtimeSummary || taskSummary || `Gateway online · sessions=${status?.sessions?.count || 0} · node=${status?.nodeService?.runtimeShort || "unknown"}`
    : "Gateway offline. Check token / service / CORS settings.";

  const logs = [
    {
      zone: "system",
      time: now,
      message: reachable ? "OpenClaw status pulled successfully." : "OpenClaw status request failed.",
    },
  ];

  if (recent?.key) {
    logs.unshift({
      zone,
      time: now,
      message: `Latest session: ${recent.key}`,
    });
  }

  if (currentTask?.title) {
    logs.unshift({
      zone,
      time: currentTask.updatedAt || currentTask.startedAt || now,
      message: `${currentTask.title} · ${translateTaskStatus(currentTask.status)} · ${(currentTask.progress ?? 0)}%${currentTask.etaSeconds ? ` · 预计 ${formatEtaLabel(currentTask.etaSeconds)}` : ""}`,
    });
  } else if (scene === "outdoor") {
    logs.unshift({
      zone,
      time: now,
      message: "当前无任务，小龙虾正在室外闲逛。",
    });
  }

  if (nextTask?.title) {
    logs.unshift({
      zone,
      time: nextTask.scheduledAt || now,
      message: `下一任务：${nextTask.title} · ${translateTaskStatus(nextTask.status)}${nextTask.scheduledAt ? ` · 计划 ${nextTask.scheduledAt}` : ""}`,
    });
  }

  if (resolvedTaskRuntime?.queueSummary) {
    logs.unshift({
      zone: "system",
      time: now,
      message: `任务队列：排队 ${queuedCount ?? 0} 项 · 运行中 ${runningCount ?? 0} 项 · 失败 ${failedCount ?? 0} 项`,
    });
  }

  return {
    zone,
    scene,
    idleActivity,
    position,
    task,
    description,
    mode,
    alertLevel,
    load: clampPercent(computedLoad),
    battery: reachable ? 100 : 15,
    temperature: alertLevel === "RED" ? 70 : alertLevel === "AMBER" ? 58 : 45,
    taskCount: resolvedTaskStats.taskCount,
    queue: queued,
    updatedAt: now,
    logs,
    openclaw: {
      tasks: resolvedTaskStats,
      runtime: resolvedTaskRuntime,
      gateway: status?.gateway || null,
      sessions: {
        count: status?.sessions?.count || 0,
        latest: recent
          ? {
              key: recent.key,
              updatedAt: recent.updatedAt,
              inputTokens: recent.inputTokens,
              outputTokens: recent.outputTokens,
              contextTokens: recent.contextTokens,
            }
          : null,
      },
      securityAudit: status?.securityAudit?.summary || null,
      nodeService: status?.nodeService || null,
    },
  };
}

function fetchOpenclawStatus(callback) {
  execFile(
    "/bin/zsh",
    ["-lc", "openclaw --no-color status --json"],
    {
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    },
    (error, stdout, stderr) => {
      if (error) {
        callback(error, null, stderr || stdout);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        callback(null, parsed, stderr);
      } catch (parseError) {
        parseError.message = `Failed to parse JSON from 'openclaw status --json': ${parseError.message}`;
        callback(parseError, null, stderr || stdout);
      }
    },
  );
}

function fetchOpenclawStatusAsync() {
  return new Promise((resolve, reject) => {
    fetchOpenclawStatus((error, status, stderr) => {
      if (error) {
        const wrapped = new Error(error.message);
        wrapped.stderr = (stderr || "").trim();
        reject(wrapped);
        return;
      }
      resolve(status);
    });
  });
}

function buildStatusSnapshotEvent(payload, reason, fetchDurationMs) {
  return {
    type: "status",
    mode: "snapshot",
    eventId: nextEventId(),
    ts: new Date().toISOString(),
    reason,
    fetchDurationMs,
    payload,
  };
}

function buildStatusPatchEvent(patch, reason, fetchDurationMs, baseEventId) {
  return {
    type: "status",
    mode: "patch",
    eventId: nextEventId(),
    baseEventId,
    ts: new Date().toISOString(),
    reason,
    fetchDurationMs,
    patch,
    patchLeafCount: countPatchLeaves(patch),
  };
}

async function refreshStatus(reason = "poll", options = {}) {
  const { force = false } = options;

  if (streamState.fetchInFlight) {
    if (force) {
      streamState.refreshQueued = true;
    }
    return streamState.fetchInFlight;
  }

  const run = (async () => {
    const startedAt = Date.now();

    try {
      const [rawStatus, externalTaskStats, externalTaskRuntime] = await Promise.all([
        fetchOpenclawStatusAsync(),
        fetchTaskStatsAsync().catch(() => null),
        fetchTaskRuntimeAsync().catch(() => null),
      ]);
      const payload = toDashboardPayload(rawStatus, externalTaskStats, externalTaskRuntime);
      const signature = JSON.stringify(payload);

      streamState.latestPayload = payload;
      streamState.latestError = null;
      streamState.latestUpdatedAtMs = Date.now();
      streamState.latestFetchDurationMs = Date.now() - startedAt;

      if (!streamState.publishedPayload) {
        emitEvent(buildStatusSnapshotEvent(payload, reason, streamState.latestFetchDurationMs));
      } else {
        const patch = createMergePatch(streamState.publishedPayload, payload);
        if (patch !== undefined) {
          emitEvent(
            buildStatusPatchEvent(
              patch,
              reason,
              streamState.latestFetchDurationMs,
              streamState.latestEventId,
            ),
          );
        }
      }

      streamState.publishedPayload = deepClone(payload);
      streamState.latestSignature = signature;

      return payload;
    } catch (error) {
      streamState.latestError = error.message;
      streamState.latestFetchDurationMs = Date.now() - startedAt;

      emitEvent({
        type: "error",
        eventId: nextEventId(),
        ts: new Date().toISOString(),
        reason,
        error: error.message,
      });

      throw error;
    } finally {
      streamState.fetchInFlight = null;

      if (streamState.refreshQueued) {
        streamState.refreshQueued = false;
        scheduleRefresh("queued");
      }
    }
  })();

  streamState.fetchInFlight = run;
  return run;
}

function scheduleRefresh(reason = "manual") {
  streamState.pendingRefreshReasons.add(reason);

  if (streamState.refreshDebounceTimer) {
    clearTimeout(streamState.refreshDebounceTimer);
  }

  streamState.refreshDebounceTimer = setTimeout(async () => {
    streamState.refreshDebounceTimer = null;

    if (streamState.fetchInFlight) {
      streamState.refreshQueued = true;
      return;
    }

    const elapsed = Date.now() - streamState.lastRefreshStartedAtMs;
    if (elapsed < STATUS_REFRESH_MIN_INTERVAL_MS) {
      streamState.refreshDebounceTimer = setTimeout(() => {
        scheduleRefresh("throttled");
      }, STATUS_REFRESH_MIN_INTERVAL_MS - elapsed);
      return;
    }

    const mergedReason = Array.from(streamState.pendingRefreshReasons).join("+") || reason;
    streamState.pendingRefreshReasons.clear();
    streamState.lastRefreshStartedAtMs = Date.now();

    try {
      await refreshStatus(mergedReason);
    } catch {
      // 错误事件已通过 WS 广播，HTTP 端会读 latestError。
    }
  }, STATUS_REFRESH_DEBOUNCE_MS);
}

function statusResponseBody() {
  if (!streamState.latestPayload) {
    return null;
  }

  return {
    ...streamState.latestPayload,
    _meta: {
      source: "cache",
      ageMs: Math.max(0, Date.now() - streamState.latestUpdatedAtMs),
      fetchDurationMs: streamState.latestFetchDurationMs,
      pollIntervalMs: STATUS_POLL_INTERVAL_MS,
      requestDebounceMs: STATUS_REFRESH_DEBOUNCE_MS,
      requestMinIntervalMs: STATUS_REFRESH_MIN_INTERVAL_MS,
      wsPath: WS_PATH,
      lastEventId: streamState.latestEventId,
      replayWindow: replayWindowMeta(),
    },
  };
}

function taskStatsResponseBody(taskStats) {
  if (!taskStats) {
    return null;
  }

  return {
    code: 0,
    message: "ok",
    data: {
      total: taskStats.totalTasks ?? taskStats.taskCount ?? 0,
      todo: taskStats.todo ?? 0,
      doing: taskStats.doing ?? 0,
      blocked: taskStats.blocked ?? 0,
      done: taskStats.done ?? 0,
      taskList: taskStats.currentTask ? [taskStats.currentTask] : [],
      page: 1,
      pageSize: taskStats.currentTask ? 1 : 0,
    },
  };
}

function taskRuntimeResponseBody(taskRuntime) {
  if (!taskRuntime) {
    return null;
  }

  return {
    code: 0,
    message: "ok",
    data: {
      currentTask: taskRuntime.currentTask
        ? {
            taskId: taskRuntime.currentTask.taskId || "",
            title: taskRuntime.currentTask.title || "",
            status: taskRuntime.currentTask.status || "",
            startedAt: taskRuntime.currentTask.startedAt || "",
            progress: taskRuntime.currentTask.progress ?? 0,
            etaSeconds: taskRuntime.currentTask.etaSeconds ?? null,
          }
        : null,
      nextTask: taskRuntime.nextTask
        ? {
            taskId: taskRuntime.nextTask.taskId || "",
            title: taskRuntime.nextTask.title || "",
            status: taskRuntime.nextTask.status || "",
            scheduledAt: taskRuntime.nextTask.scheduledAt || "",
          }
        : null,
      queueSummary: {
        queued: taskRuntime.queueSummary?.queued ?? 0,
        running: taskRuntime.queueSummary?.running ?? 0,
        failed: taskRuntime.queueSummary?.failed ?? 0,
      },
    },
  };
}

function serveStaticFile(reqPath, res) {
  const cleanPath = reqPath === "/" ? "/index.html" : reqPath;
  const absolutePath = path.join(WEB_ROOT, path.normalize(cleanPath));

  if (!absolutePath.startsWith(WEB_ROOT)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(absolutePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      sendJson(res, 500, { error: "Failed to read static file" });
      return;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/api/tasks/stats") {
    fetchTaskStatsAsync()
      .then((taskStats) => {
        const fallbackTaskStats = taskStats || streamState.latestPayload?.openclaw?.tasks || null;
        const body = taskStatsResponseBody(fallbackTaskStats);
        if (body) {
          sendJson(res, 200, body);
          return;
        }

        sendJson(res, 502, {
          error: "Failed to query task stats",
          detail: "No upstream task stats source is currently available.",
        });
      })
      .catch((error) => {
        sendJson(res, 502, {
          error: "Failed to query task stats",
          detail: error?.message || "Unknown error",
        });
      });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tasks/runtime") {
    fetchTaskRuntimeAsync()
      .then(async (taskRuntime) => {
        const fallbackTaskStats = await fetchTaskStatsAsync().catch(() => null);
        const resolvedTaskRuntime =
          taskRuntime
          || streamState.latestPayload?.openclaw?.runtime
          || synthesizeTaskRuntimeFromTaskStats(fallbackTaskStats);
        const body = taskRuntimeResponseBody(resolvedTaskRuntime);
        if (body) {
          sendJson(res, 200, body);
          return;
        }

        sendJson(res, 502, {
          error: "Failed to query task runtime",
          detail: "No upstream task runtime source is currently available.",
        });
      })
      .catch((error) => {
        sendJson(res, 502, {
          error: "Failed to query task runtime",
          detail: error?.message || "Unknown error",
        });
      });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/openclaw/status") {
    const forceRefresh = url.searchParams.get("refresh") === "1";

    const reply = () => {
      const body = statusResponseBody();
      if (body) {
        sendJson(res, 200, body);
        return;
      }

      if (streamState.latestError) {
        sendJson(res, 502, {
          error: "Failed to query OpenClaw status",
          detail: streamState.latestError,
          hint: "Run 'openclaw --no-color status --json' in terminal to verify CLI access.",
        });
        return;
      }

      sendJson(res, 202, {
        status: "warming_up",
        message: "Status poller is starting, retry shortly.",
      });
    };

    if (forceRefresh || !streamState.latestPayload) {
      refreshStatus(forceRefresh ? "http-refresh" : "http-warm", { force: forceRefresh })
        .catch(() => null)
        .finally(reply);
      return;
    }

    reply();
    return;
  }

  if (req.method === "GET") {
    serveStaticFile(url.pathname, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let url;

  try {
    url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    socket.destroy();
    return;
  }

  if (url.pathname !== WS_PATH) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  req._openclawParsedUrl = url;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message?.type === "refresh") {
        scheduleRefresh("ws-client-refresh");
      }
    } catch {
      // ignore malformed frames
    }
  });

  const url = req._openclawParsedUrl || new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const lastEventId = url.searchParams.get("lastEventId");

  sendWs(ws, {
    type: "hello",
    ts: new Date().toISOString(),
    wsPath: WS_PATH,
    pollIntervalMs: STATUS_POLL_INTERVAL_MS,
    refreshDebounceMs: STATUS_REFRESH_DEBOUNCE_MS,
    refreshMinIntervalMs: STATUS_REFRESH_MIN_INTERVAL_MS,
    latestEventId: streamState.latestEventId,
    replayWindow: replayWindowMeta(),
  });

  replayEventsFrom(ws, lastEventId);

  if (!streamState.latestPayload) {
    scheduleRefresh("ws-connect-warm");
  }
});

const pollTimer = setInterval(() => {
  scheduleRefresh("poll");
}, STATUS_POLL_INTERVAL_MS);

const wsPingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, WS_PING_INTERVAL_MS);

pollTimer.unref?.();
wsPingTimer.unref?.();

scheduleRefresh("startup");

server.listen(PORT, HOST, () => {
  console.log(`[openclaw_show] server running at http://${HOST}:${PORT}`);
  console.log(`[openclaw_show] status endpoint: http://${HOST}:${PORT}/api/openclaw/status`);
  console.log(`[openclaw_show] websocket endpoint: ws://${HOST}:${PORT}${WS_PATH}`);
  console.log(`[openclaw_show] poll interval: ${STATUS_POLL_INTERVAL_MS}ms`);
  console.log(`[openclaw_show] debounce/min interval: ${STATUS_REFRESH_DEBOUNCE_MS}/${STATUS_REFRESH_MIN_INTERVAL_MS}ms`);
  console.log(`[openclaw_show] event replay buffer: ${EVENT_BUFFER_SIZE}`);
  console.log(`[openclaw_show] CORS origin: ${CORS_ORIGIN}`);
});
