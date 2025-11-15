export type ClientRole = "leader" | "follower";

export interface IdentifyMessage {
  type: "identify";
  role: ClientRole;
  clientId: string;
}

export type RpcKind = "invoke";

export interface RpcRequest {
  type: "rpc";
  id: string;
  from: string;
  kind: RpcKind;
  cmd: string;
  args?: Record<string, unknown>;
}

export interface RpcErrorPayload {
  message: string;
  stack?: string;
}

export interface RpcResult {
  type: "rpc-result";
  id: string;
  to: string;
  result: unknown;
  error: RpcErrorPayload | null;
}

export interface CallbackRegisterMessage {
  type: "callback-register";
  from: string;
  callbackId: number;
}

export interface CallbackUnregisterMessage {
  type: "callback-unregister";
  from: string;
  callbackId: number;
}

export interface CallbackRunMessage {
  type: "callback-run";
  to: string;
  callbackId: number;
  payload: unknown;
}

export interface FollowerStatusMessage {
  type: "follower-status";
  clientId: string;
  status: "disconnected";
}

export type ProxyMessage =
  | IdentifyMessage
  | RpcRequest
  | RpcResult
  | CallbackRegisterMessage
  | CallbackUnregisterMessage
  | CallbackRunMessage
  | FollowerStatusMessage;

export const MESSAGE_TYPES = new Set<ProxyMessage["type"]>([
  "identify",
  "rpc",
  "rpc-result",
  "callback-register",
  "callback-unregister",
  "callback-run",
  "follower-status",
]);

export function parseMessage(raw: string): ProxyMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !MESSAGE_TYPES.has(parsed.type)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
