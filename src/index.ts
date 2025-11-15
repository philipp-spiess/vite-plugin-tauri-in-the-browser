import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  parseMessage,
  type ClientRole,
  type ProxyMessage,
  type RpcRequest,
} from "./protocol.js";

export interface TauriLeaderProxyOptions {
  path?: string;
  devOnly?: boolean;
  log?: boolean;
}

interface ConnectedFollower {
  clientId: string;
  socket: WebSocket;
}

interface LeaderConnection {
  clientId: string;
  socket: WebSocket;
}

const VIRTUAL_MODULE_ID = "@tauri-leader/runtime";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

export default function tauriLeaderProxy(options: TauriLeaderProxyOptions = {}): Plugin {
  const wsPath = options.path ?? "/__tauri-sync__";
  const devOnly = options.devOnly ?? true;
  const enableLog = options.log ?? false;

  const runtimeFile = fileURLToPath(new URL("./runtime.js", import.meta.url));
  const runtimeSource = () => fs.readFileSync(runtimeFile, "utf8");

  const log = (...args: unknown[]) => {
    if (enableLog) {
      console.log("[tauri-leader-proxy]", ...args);
    }
  };

  let leader: LeaderConnection | null = null;
  const followers = new Map<string, ConnectedFollower>();

  const notifyLeaderFollowerStatus = (clientId: string, status: "disconnected") => {
    if (!leader) {
      return;
    }
    try {
      leader.socket.send(
        JSON.stringify({
          type: "follower-status",
          clientId,
          status,
        })
      );
    } catch (error) {
      log("failed notifying leader of follower status", error);
    }
  };

  const sendNoLeader = (socket: WebSocket, msg: RpcRequest) => {
    socket.send(
      JSON.stringify({
        type: "rpc-result",
        id: msg.id,
        to: msg.from,
        result: null,
        error: { message: "No leader connected" },
      })
    );
  };

  const serverMiddleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url === wsPath) {
      res.statusCode = 426;
      res.end("Expected WebSocket");
      return;
    }
    next();
  };

  return {
    name: "vite-plugin-tauri-leader-proxy",
    enforce: "pre",
    apply: devOnly ? "serve" : undefined,
    configureServer(server) {
      server.middlewares.use(serverMiddleware);
      const httpServer = server.httpServer;
      if (!httpServer) {
        throw new Error("Vite HTTP server missing");
      }

      const wss = new WebSocketServer({ noServer: true });

      httpServer.on("upgrade", (req, socket, head) => {
        const { url } = req;
        if (!url) {
          return;
        }
        const target = new URL(url, "http://localhost");
        if (target.pathname !== wsPath) {
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      });

      wss.on("connection", (socket) => {
        let role: ClientRole | null = null;
        let clientId: string | null = null;

        log("client connected");

        socket.on("message", (raw: RawData) => {
          const msg = parseMessage(raw.toString());
          if (!msg) {
            log("ignored malformed payload");
            return;
          }
          handleMessage({ msg, socket });
        });

        socket.on("close", () => {
          log("client disconnected", role, clientId ?? "?");
          if (role === "leader" && leader?.socket === socket) {
            leader = null;
          }
          if (role === "follower" && clientId) {
            followers.delete(clientId);
            notifyLeaderFollowerStatus(clientId, "disconnected");
          }
        });

        const handleMessage = ({ msg, socket: ws }: { msg: ProxyMessage; socket: WebSocket }) => {
          if (msg.type === "identify") {
            role = msg.role;
            clientId = msg.clientId;
            if (msg.role === "leader") {
              if (clientId) {
                followers.delete(clientId);
              }
              leader?.socket.close();
              leader = { clientId: msg.clientId, socket: ws };
              log("leader registered", msg.clientId);
            } else {
              followers.set(msg.clientId, { clientId: msg.clientId, socket: ws });
              log("follower registered", msg.clientId);
            }
            return;
          }

          if (msg.type === "rpc" && role === "follower") {
            if (!leader) {
              sendNoLeader(ws, msg);
              return;
            }
            try {
              leader.socket.send(JSON.stringify(msg));
            } catch (error) {
              log("failed forwarding to leader", error);
              sendNoLeader(ws, msg);
            }
            return;
          }

          if (msg.type === "rpc-result" && role === "leader") {
            const target = followers.get(msg.to);
            if (!target) {
              log("follower not found", msg.to);
              return;
            }
            target.socket.send(JSON.stringify(msg));
            return;
          }

          if (msg.type === "callback-register" && role === "follower") {
            if (!leader) {
              return;
            }
            tryForwardToLeader(msg);
            return;
          }

          if (msg.type === "callback-unregister" && role === "follower") {
            if (!leader) {
              return;
            }
            tryForwardToLeader(msg);
            return;
          }

          if (msg.type === "callback-run" && role === "leader") {
            const target = followers.get(msg.to);
            if (!target) {
              log("callback target missing", msg.to);
              return;
            }
            target.socket.send(JSON.stringify(msg));
          }
        };

        const tryForwardToLeader = (payload: ProxyMessage) => {
          if (!leader) {
            return;
          }
          try {
            leader.socket.send(JSON.stringify(payload));
          } catch (error) {
            log("failed forwarding payload to leader", error);
          }
        };
      });

      httpServer.once("close", () => {
        wss.close();
      });
    },
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              type: "module",
              src: `/@tauri-leader/runtime`,
            },
            injectTo: "head-prepend",
          },
        ],
      };
    },
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID || id === `/@tauri-leader/runtime`) {
        return RESOLVED_VIRTUAL_MODULE_ID;
      }
      return null;
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_MODULE_ID) {
        const baseSource = runtimeSource();
        const clientConfig = JSON.stringify({ path: wsPath, log: enableLog });
        return baseSource.split("__TAURI_LEADER_PROXY_CONFIG__").join(clientConfig);
      }
      return null;
    },
  };
}
