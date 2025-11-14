export {};

type RuntimeRole = "leader" | "follower";

type RuntimeConfig = {
  path: string;
  log: boolean;
};

declare const __TAURI_LEADER_PROXY_CONFIG__: RuntimeConfig;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: any;
    __TAURI_SYNC_STATUS__?: {
      clientId: string;
      role: "unknown" | RuntimeRole;
      hasLeader: boolean;
      lastError: string | null;
    };
  }
}

const config: RuntimeConfig =
  typeof __TAURI_LEADER_PROXY_CONFIG__ === "undefined"
    ? { path: "/__tauri-sync__", log: false }
    : __TAURI_LEADER_PROXY_CONFIG__;

const ROLE_DETECTION_WINDOW_MS = 1500;
const ROLE_DETECTION_INTERVAL_MS = 50;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5000;

const pendingInvokes = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();
const followerCallbacks = new Map<number, (...args: unknown[]) => void>();
let callbackIdCounter = 0;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_BASE_DELAY_MS;
let resolvedRole: RuntimeRole | null = null;
let announcedRole: RuntimeRole | null = null;
const clientId = createId();

const syncStatus = {
  clientId,
  role: "unknown" as "unknown" | RuntimeRole,
  hasLeader: false,
  lastError: null as string | null,
};

if (typeof window !== "undefined") {
  window.__TAURI_SYNC_STATUS__ = syncStatus;
}

if (typeof window !== "undefined") {
  boot();
}

function boot() {
  determineRole();
  connect();
  window.addEventListener("beforeunload", () => {
    ws?.close();
    ws = null;
  });
}

function determineRole() {
  if (hasRealInternals()) {
    becomeLeader();
    return;
  }

  const started = Date.now();
  const interval = window.setInterval(() => {
    if (hasRealInternals()) {
      window.clearInterval(interval);
      becomeLeader();
      return;
    }

    if (Date.now() - started >= ROLE_DETECTION_WINDOW_MS) {
      window.clearInterval(interval);
      becomeFollower();
    }
  }, ROLE_DETECTION_INTERVAL_MS);
}

function hasRealInternals() {
  const internals = (window as any).__TAURI_INTERNALS__;
  return typeof internals === "object" && typeof internals?.invoke === "function";
}

function becomeLeader() {
  resolvedRole = "leader";
  syncStatus.role = "leader";
  syncStatus.hasLeader = true;
  log("Identified as leader");
  tryIdentify();
}

function becomeFollower() {
  if (resolvedRole === "follower") {
    return;
  }
  resolvedRole = "follower";
  syncStatus.role = "follower";
  syncStatus.hasLeader = false;
  installFollowerShim();
  log("Identified as follower");
  tryIdentify();
}

function installFollowerShim() {
  if ((window as any).__TAURI_INTERNALS__) {
    // Avoid clobbering if something else attached after timeout.
    return;
  }

  const callbacks: Record<number, (...args: unknown[]) => void> = {};

  const internals = {
    invoke(cmd: string, args?: Record<string, unknown>) {
      return sendInvoke(cmd, args ?? {});
    },
    transformCallback(callback?: (...args: unknown[]) => void, once = false) {
      if (!callback) {
        return null;
      }
      const id = nextCallbackId();
      callbacks[id] = once
        ? (...eventArgs: unknown[]) => {
            delete callbacks[id];
            callback(...eventArgs);
          }
        : callback;
      followerCallbacks.set(id, callbacks[id]);
      return id;
    },
    callbacks,
    convertFileSrc(path: string) {
      return path;
    },
  };

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: internals,
    configurable: true,
  });
}

function connect() {
  if (typeof window === "undefined") {
    return;
  }

  const url = createSocketUrl(config.path);
  try {
    ws = new WebSocket(url);
  } catch (error) {
    setStatusError(`WebSocket init failed: ${String(error)}`);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    log("WebSocket connected", url);
    reconnectDelay = RECONNECT_BASE_DELAY_MS;
    setStatusError(null);
    tryIdentify();
  });

  ws.addEventListener("message", (event) => {
    handleMessage(String(event.data ?? ""));
  });

  ws.addEventListener("close", () => {
    if (syncStatus.role === "follower") {
      syncStatus.hasLeader = false;
    }
    log("WebSocket disconnected");
    ws = null;
    failAllPending(new Error("tauri leader proxy disconnected"));
    scheduleReconnect();
  });

  ws.addEventListener("error", (event) => {
    setStatusError("WebSocket error");
    log("WebSocket error", event);
  });
}

function handleMessage(raw: string) {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== "object") {
      return;
    }
    if (msg.type === "rpc-result") {
      handleRpcResult(msg);
      return;
    }
    if (msg.type === "rpc" && resolvedRole === "leader") {
      void handleLeaderRpc(msg);
    }
  } catch (error) {
    log("Invalid proxy payload", error);
  }
}

async function handleLeaderRpc(msg: { id: string; from: string; cmd: string; args?: Record<string, unknown>; kind: string }) {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  if (msg.kind !== "invoke") {
    return;
  }

  try {
    const result = await internals.invoke(msg.cmd, msg.args ?? {});
    ws.send(
      JSON.stringify({
        type: "rpc-result",
        id: msg.id,
        to: msg.from,
        result,
        error: null,
      })
    );
  } catch (error: any) {
    ws.send(
      JSON.stringify({
        type: "rpc-result",
        id: msg.id,
        to: msg.from,
        result: null,
        error: {
          message: error?.message ?? String(error),
          stack: error?.stack,
        },
      })
    );
  }
}

function handleRpcResult(msg: { id: string; result: unknown; error: { message: string } | null }) {
  const entry = pendingInvokes.get(msg.id);
  if (!entry) {
    return;
  }
  pendingInvokes.delete(msg.id);
  if (msg.error) {
    syncStatus.hasLeader = syncStatus.role === "leader";
    entry.reject(new Error(msg.error.message));
    return;
  }
  if (syncStatus.role === "follower") {
    syncStatus.hasLeader = true;
  }
  entry.resolve(msg.result);
}

function sendInvoke(cmd: string, args: Record<string, unknown>) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(syncStatus.lastError ?? "tauri leader proxy disconnected"));
      return;
    }
    const id = createId();
    pendingInvokes.set(id, { resolve, reject });
    try {
      ws.send(
        JSON.stringify({
          type: "rpc",
          id,
          from: clientId,
          kind: "invoke",
          cmd,
          args,
        })
      );
    } catch (error) {
      pendingInvokes.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function failAllPending(error: Error) {
  pendingInvokes.forEach((entry) => entry.reject(error));
  pendingInvokes.clear();
}

function tryIdentify() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !resolvedRole) {
    return;
  }
  if (announcedRole === resolvedRole) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "identify",
      role: resolvedRole,
      clientId,
    })
  );
  announcedRole = resolvedRole;
}

function createSocketUrl(path: string) {
  const { protocol, host } = window.location;
  const scheme = protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${host}${path}`;
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    connect();
  }, reconnectDelay);
}

function setStatusError(message: string | null) {
  syncStatus.lastError = message;
}

function createId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function nextCallbackId() {
  callbackIdCounter = (callbackIdCounter + 1) >>> 0;
  if (callbackIdCounter === 0) {
    callbackIdCounter = 1;
  }
  return callbackIdCounter;
}

function log(...args: unknown[]) {
  if (config.log) {
    console.log("[tauri-leader-proxy]", ...args);
  }
}
