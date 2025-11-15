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
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener?: (event: string, id: number) => void;
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
const INVOKE_RETRY_BASE_DELAY_MS = 250;
const INVOKE_RETRY_MAX_DELAY_MS = 4000;

type PendingInvokeEntry = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cmd: string;
  args: Record<string, unknown>;
  attempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

type CallbackOperation = {
  op: "register" | "unregister";
  callbackId: number;
};

type CallbackStore = {
  get(id: number): unknown;
  set(id: number, value: unknown): void;
  delete(id: number): void;
};

const SHIM_FLAG = "__TAURI_PROXY_SHIM__";

const pendingInvokes = new Map<string, PendingInvokeEntry>();
const followerCallbacks = new Map<number, (...args: unknown[]) => void>();
const pendingCallbackOps: CallbackOperation[] = [];
const remoteCallbackOwners = new Map<number, string>();
const followerCallbackIndex = new Map<string, Set<number>>();
const remoteCallbackStubs = new Map<
  number,
  {
    stub: (payload: unknown) => void;
    previous?: (payload: unknown) => unknown;
  }
>();
let callbackIdCounter = 0;
let followerShimInstalled = false;

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

  becomeFollower();

  const started = Date.now();
  const interval = window.setInterval(() => {
    if (hasRealInternals()) {
      window.clearInterval(interval);
      becomeLeader();
      return;
    }

    if (Date.now() - started >= ROLE_DETECTION_WINDOW_MS) {
      window.clearInterval(interval);
    }
  }, ROLE_DETECTION_INTERVAL_MS);
}

function hasRealInternals() {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals || typeof internals !== "object") {
    return false;
  }
  if (internals?.[SHIM_FLAG]) {
    return false;
  }
  return typeof internals.invoke === "function";
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
  if (followerShimInstalled) {
    return;
  }
  if ((window as any).__TAURI_INTERNALS__) {
    // Avoid clobbering if something else attached after timeout.
    return;
  }

  const callbacks: Record<number, (...args: unknown[]) => void> = {};

  const removeCallback = (id: number, notify = true) => {
    if (callbacks[id]) {
      delete callbacks[id];
    }
    const hadEntry = followerCallbacks.delete(id);
    if (notify && hadEntry) {
      queueCallbackAnnouncement({ op: "unregister", callbackId: id });
    }
  };

  const internals = {
    [SHIM_FLAG]: true,
    invoke(cmd: string, args?: Record<string, unknown>) {
      return sendInvoke(cmd, args ?? {});
    },
    transformCallback(callback?: (...args: unknown[]) => void, once = false) {
      if (!callback) {
        return null;
      }
      const id = nextCallbackId();
      const wrapped = once
        ? (...eventArgs: unknown[]) => {
            removeCallback(id, true);
            callback(...eventArgs);
          }
        : (...eventArgs: unknown[]) => {
            callback(...eventArgs);
          };
      callbacks[id] = wrapped;
      followerCallbacks.set(id, wrapped);
      queueCallbackAnnouncement({ op: "register", callbackId: id });
      return id;
    },
    unregisterCallback(id: number) {
      removeCallback(id, true);
    },
    runCallback(id: number, payload: unknown) {
      const fn = followerCallbacks.get(id);
      if (fn) {
        fn(payload);
      }
    },
    callbacks,
    convertFileSrc(path: string) {
      return path;
    },
  };

  ensureEventInternals();

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: internals,
    configurable: true,
    writable: true,
  });
  followerShimInstalled = true;
}

function ensureEventInternals() {
  const existing = (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__;
  const unregister = (event: string, id: number) => {
    void event;
    const internals = (window as any).__TAURI_INTERNALS__;
    internals?.unregisterCallback?.(id);
  };
  if (existing && typeof existing === "object") {
    if (typeof existing.unregisterListener !== "function") {
      existing.unregisterListener = unregister;
    }
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = existing;
    return;
  }
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: unregister,
  };
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
    flushCallbackAnnouncements();
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
      return;
    }
    if (msg.type === "callback-run" && resolvedRole === "follower") {
      handleFollowerCallbackRun(msg.callbackId, msg.payload);
      return;
    }
    if (msg.type === "callback-register" && resolvedRole === "leader") {
      trackRemoteCallbackOwner(msg.from, msg.callbackId);
      return;
    }
    if (msg.type === "callback-unregister" && resolvedRole === "leader") {
      cleanupRemoteCallback(msg.callbackId);
      return;
    }
    if (msg.type === "follower-status" && resolvedRole === "leader") {
      if (msg.status === "disconnected") {
        dropFollowerCallbacks(msg.clientId);
      }
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

function handleFollowerCallbackRun(callbackId: number, payload: unknown) {
  const callback = followerCallbacks.get(callbackId);
  if (!callback) {
    return;
  }
  try {
    callback(payload);
  } catch (error) {
    log("Follower callback failed", error);
  }
}

function handleRpcResult(msg: { id: string; result: unknown; error: { message: string } | null }) {
  const entry = pendingInvokes.get(msg.id);
  if (!entry) {
    return;
  }
  if (msg.error?.message === "No leader connected" && resolvedRole === "follower") {
    scheduleInvokeRetry(msg.id);
    return;
  }
  pendingInvokes.delete(msg.id);
  clearInvokeRetry(entry);
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

function trackRemoteCallbackOwner(client: string, callbackId: number) {
  remoteCallbackOwners.set(callbackId, client);
  let set = followerCallbackIndex.get(client);
  if (!set) {
    set = new Set();
    followerCallbackIndex.set(client, set);
  }
  set.add(callbackId);
  installRemoteCallbackStub(callbackId);
}

function cleanupRemoteCallback(callbackId: number) {
  const owner = remoteCallbackOwners.get(callbackId);
  if (!owner) {
    return;
  }
  remoteCallbackOwners.delete(callbackId);
  removeRemoteCallbackStub(callbackId);
  const set = followerCallbackIndex.get(owner);
  if (set) {
    set.delete(callbackId);
    if (set.size === 0) {
      followerCallbackIndex.delete(owner);
    }
  }
}

function dropFollowerCallbacks(clientId: string) {
  const set = followerCallbackIndex.get(clientId);
  if (!set) {
    return;
  }
  set.forEach((callbackId) => {
    remoteCallbackOwners.delete(callbackId);
    removeRemoteCallbackStub(callbackId);
  });
  followerCallbackIndex.delete(clientId);
}

function sendInvoke(cmd: string, args: Record<string, unknown>) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(syncStatus.lastError ?? "tauri leader proxy disconnected"));
      return;
    }
    const id = createId();
    const entry: PendingInvokeEntry = {
      resolve,
      reject,
      cmd,
      args,
      attempt: 0,
      retryTimer: null,
    };
    pendingInvokes.set(id, entry);
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

function scheduleInvokeRetry(id: string) {
  const entry = pendingInvokes.get(id);
  if (!entry || entry.retryTimer) {
    return;
  }
  const delay = Math.min(INVOKE_RETRY_MAX_DELAY_MS, INVOKE_RETRY_BASE_DELAY_MS * Math.pow(2, entry.attempt));
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN || resolvedRole !== "follower") {
      entry.attempt += 1;
      scheduleInvokeRetry(id);
      return;
    }
    try {
      ws.send(
        JSON.stringify({
          type: "rpc",
          id,
          from: clientId,
          kind: "invoke",
          cmd: entry.cmd,
          args: entry.args,
        })
      );
      entry.attempt += 1;
    } catch (error) {
      pendingInvokes.delete(id);
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }, delay);
}

function clearInvokeRetry(entry: PendingInvokeEntry) {
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
  entry.attempt = 0;
}

function failAllPending(error: Error) {
  pendingInvokes.forEach((entry) => {
    clearInvokeRetry(entry);
    entry.reject(error);
  });
  pendingInvokes.clear();
}

function queueCallbackAnnouncement(operation: CallbackOperation) {
  pendingCallbackOps.push(operation);
  flushCallbackAnnouncements();
}

function flushCallbackAnnouncements() {
  if (!ws || ws.readyState !== WebSocket.OPEN || resolvedRole !== "follower") {
    return;
  }
  while (pendingCallbackOps.length > 0) {
    const op = pendingCallbackOps.shift();
    if (!op) {
      continue;
    }
    try {
      ws.send(
        JSON.stringify({
          type: op.op === "register" ? "callback-register" : "callback-unregister",
          from: clientId,
          callbackId: op.callbackId,
        })
      );
    } catch (error) {
      pendingCallbackOps.unshift(op);
      log("Failed announcing callback", error);
      break;
    }
  }
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

function installRemoteCallbackStub(callbackId: number) {
  const store = getCallbackStore();
  if (!store || remoteCallbackStubs.has(callbackId)) {
    return;
  }
  const previousValue = store.get(callbackId);
  const previous = typeof previousValue === "function" ? (previousValue as (payload: unknown) => unknown) : undefined;
  const stub = (payload: unknown) => {
    if (forwardRemoteCallback(callbackId, payload)) {
      return;
    }
    if (previous) {
      try {
        previous(payload);
      } catch (error) {
        log("Leader fallback callback failed", error);
      }
    }
  };
  remoteCallbackStubs.set(callbackId, {
    stub,
    previous,
  });
  store.set(callbackId, stub);
}

function removeRemoteCallbackStub(callbackId: number) {
  const stub = remoteCallbackStubs.get(callbackId);
  if (!stub) {
    return;
  }
  remoteCallbackStubs.delete(callbackId);
  const store = getCallbackStore();
  if (!store) {
    return;
  }
  const current = store.get(callbackId);
  if (current === stub.stub) {
    if (stub.previous) {
      store.set(callbackId, stub.previous);
    } else {
      store.delete(callbackId);
    }
  }
}

function forwardRemoteCallback(callbackId: number, payload: unknown) {
  const target = remoteCallbackOwners.get(callbackId);
  if (!target) {
    return false;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("Dropped remote callback (socket closed)");
    return true;
  }
  ws.send(
    JSON.stringify({
      type: "callback-run",
      to: target,
      callbackId,
      payload,
    })
  );
  return true;
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
  try {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const buffer = new Uint32Array(1);
      crypto.getRandomValues(buffer);
      if (buffer[0] !== 0) {
        return buffer[0];
      }
    }
  } catch {
    // fall back to counter below
  }
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

function getCallbackStore(): CallbackStore | null {
  if (typeof window === "undefined") {
    return null;
  }
  const internals = (window as any).__TAURI_INTERNALS__;
  const store = internals?.callbacks;
  if (!store) {
    return null;
  }
  if (typeof store.get === "function" && typeof store.set === "function") {
    return {
      get: (id: number) => store.get(id),
      set: (id: number, value: unknown) => {
        store.set(id, value);
      },
      delete: (id: number) => {
        if (typeof store.delete === "function") {
          store.delete(id);
        } else if (typeof store.set === "function") {
          store.set(id, undefined);
        }
      },
    };
  }
  if (typeof store === "object") {
    return {
      get: (id: number) => store[id],
      set: (id: number, value: unknown) => {
        store[id] = value;
      },
      delete: (id: number) => {
        delete store[id];
      },
    };
  }
  return null;
}
