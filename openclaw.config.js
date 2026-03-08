window.OPENCLAW_CONFIG = {
  // 默认走同源代理，这样页面开在哪个端口，就用哪个端口的状态聚合与任务数代理。
  endpoint: "/api/openclaw/status",
  wsEndpoint: "/ws/openclaw/status",
  taskStatsEndpoint: "/api/tasks/stats",
  taskRuntimeEndpoint: "/api/tasks/runtime",
  pollIntervalMs: 3000,
  requestTimeoutMs: 12000,
  wsReconnectDelayMs: 3500,
  authToken: "",
  headers: {},
  mockEndpoint: "./mock-status.json",
};
