import { io, type Socket } from "socket.io-client";
import { logger } from "./logger.js";
import { errMsg } from "./utils.js";

/** Tag row as returned by getTags. */
export interface KumaTag {
  id: number;
  name: string;
  color: string;
}

/** Tag row attached to a monitor in monitorList JSON (tag definition joined with the per-monitor value). */
export interface KumaMonitorTag {
  tag_id: number;
  monitor_id: number;
  value: string | null;
  name: string;
  color: string;
}

/**
 * Monitor JSON as pushed via the `monitorList` event.
 * Kuma includes sensitive data (pushToken) for authenticated sockets, and `editMonitor` copies fields
 * from exactly this shape, so edits round-trip the full object with only the changed fields mutated.
 */
export interface KumaMonitor {
  id: number;
  name: string;
  type: string;
  active: boolean | number;
  interval: number;
  retryInterval: number;
  maxretries: number;
  url?: string | null;
  method?: string | null;
  keyword?: string | null;
  invertKeyword?: boolean | null;
  accepted_statuscodes: string[];
  proxyId?: number | null;
  pushToken?: string | null;
  tags: KumaMonitorTag[];
  [key: string]: unknown;
}

export interface KumaProxy {
  id: number;
  protocol: string;
  host: string;
  port: number;
  active: boolean | number;
}

export interface StatusPageConfig {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  icon: string;
  theme: string;
  published: boolean;
  showTags: boolean;
  customCSS: string;
  footerText: string | null;
  showPoweredBy: boolean;
  autoRefreshInterval: number;
  [key: string]: unknown;
}

/** One group on a status page; order in the array is the render order. */
export interface PublicGroup {
  id?: number;
  name: string;
  monitorList: Array<{ id: number }>;
}

interface Ack {
  ok?: boolean;
  msg?: string;
  [key: string]: unknown;
}

const CALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Thin promise wrapper over Uptime Kuma's internal socket.io API (the same API its own web UI uses;
 * there is no REST write API). One authenticated connection per worker process.
 *
 * The server pushes full state after login (`monitorList`, `proxyList`, plus a multi-MB `heartbeatList`
 * blast for every monitor); we cache the lists we need and deliberately register no heartbeat listeners.
 */
export class KumaClient {
  private socket: Socket | undefined;
  private jwt: string | undefined;
  private monitors = new Map<number, KumaMonitor>();
  private proxies: KumaProxy[] = [];
  private monitorWaiters: Array<(monitors: Map<number, KumaMonitor>) => void> = [];

  constructor(private readonly opts: { url: string; username: string; password: string }) {}

  /** Connect and authenticate, creating the admin account on a fresh instance. Throws on failure (caller retries). */
  async start(): Promise<void> {
    const socket = io(this.opts.url, {
      transports: ["websocket"],
      reconnectionDelayMax: 30_000,
      timeout: CONNECT_TIMEOUT_MS,
    });
    this.socket = socket;

    socket.on("monitorList", (list: Record<string, KumaMonitor>) => {
      this.monitors = new Map(Object.values(list).map((m) => [m.id, m]));
      const waiters = this.monitorWaiters;
      this.monitorWaiters = [];
      for (const resolve of waiters) resolve(this.monitors);
    });
    socket.on("proxyList", (list: KumaProxy[]) => {
      this.proxies = list;
    });
    socket.on("disconnect", (reason) => logger.warn({ reason }, "kuma socket disconnected"));
    // socket.io reconnects on its own; auth is per-connection, so re-authenticate on every reconnect.
    socket.io.on("reconnect", () => void this.reauth());

    try {
      await this.waitForConnect(socket);
      if (await this.call<boolean>("needSetup")) {
        logger.info("kuma reports first-run setup needed; creating admin user");
        await this.call("setup", this.opts.username, this.opts.password);
      }
      await this.login();
    } catch (e) {
      socket.close();
      this.socket = undefined;
      throw e;
    }
  }

  stop(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Emit an event and await its ack. Rejects on timeout, disconnect, or an explicit `ok: false` ack.
   * Events like `needSetup` ack a bare value instead of an object; those pass through unchanged.
   */
  async call<T = unknown>(event: string, ...args: unknown[]): Promise<T> {
    if (!this.socket) throw new Error("kuma socket not started");
    const res = (await this.socket.timeout(CALL_TIMEOUT_MS).emitWithAck(event, ...args)) as Ack | T;
    if (res && typeof res === "object" && "ok" in res && (res as Ack).ok === false) {
      throw new Error(`kuma ${event} failed: ${(res as Ack).msg ?? "unknown error"}`);
    }
    return res as T;
  }

  /** Request a fresh monitor list and wait for the resulting `monitorList` push. */
  async getMonitors(): Promise<Map<number, KumaMonitor>> {
    const next = new Promise<Map<number, KumaMonitor>>((resolve, reject) => {
      this.monitorWaiters.push(resolve);
      setTimeout(() => reject(new Error("timed out waiting for monitorList")), CALL_TIMEOUT_MS);
    });
    await this.call("getMonitorList");
    return next;
  }

  async addMonitor(monitor: Record<string, unknown>): Promise<number> {
    const res = await this.call<{ monitorID: number }>("add", monitor);
    return res.monitorID;
  }

  async editMonitor(monitor: KumaMonitor): Promise<void> {
    await this.call("editMonitor", monitor);
  }

  async pauseMonitor(id: number): Promise<void> {
    await this.call("pauseMonitor", id);
  }

  async resumeMonitor(id: number): Promise<void> {
    await this.call("resumeMonitor", id);
  }

  async getTags(): Promise<KumaTag[]> {
    const res = await this.call<{ tags: KumaTag[] }>("getTags");
    return res.tags;
  }

  async addTag(tag: { name: string; color: string }): Promise<KumaTag> {
    const res = await this.call<{ tag: KumaTag }>("addTag", tag);
    return res.tag;
  }

  async addMonitorTag(tagId: number, monitorId: number, value: string): Promise<void> {
    await this.call("addMonitorTag", tagId, monitorId, value);
  }

  /** Proxies come from the `proxyList` push (sent after login and after every addProxy). */
  getProxies(): KumaProxy[] {
    return this.proxies;
  }

  async addProxy(proxy: Record<string, unknown>): Promise<number> {
    const res = await this.call<{ id: number }>("addProxy", proxy, undefined);
    return res.id;
  }

  async addStatusPage(title: string, slug: string): Promise<void> {
    await this.call("addStatusPage", title, slug);
  }

  async getStatusPage(slug: string): Promise<StatusPageConfig> {
    const res = await this.call<{ config: StatusPageConfig }>("getStatusPage", slug);
    return res.config;
  }

  async saveStatusPage(
    slug: string,
    config: StatusPageConfig,
    imgDataUrl: string,
    publicGroupList: PublicGroup[],
  ): Promise<void> {
    await this.call("saveStatusPage", slug, config, imgDataUrl, publicGroupList);
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const res = await this.call<{ data: Record<string, unknown> }>("getSettings");
    return res.data;
  }

  async setSettings(data: Record<string, unknown>): Promise<void> {
    await this.call("setSettings", data, this.opts.password);
  }

  private waitForConnect(socket: Socket): Promise<void> {
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out connecting to kuma")),
        CONNECT_TIMEOUT_MS,
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private async login(): Promise<void> {
    const res = await this.call<{ token?: string }>("login", {
      username: this.opts.username,
      password: this.opts.password,
      token: "",
    });
    this.jwt = res.token;
  }

  /** Prefer the JWT on reconnect: loginByToken is not behind the login rate limiter. */
  private async reauth(): Promise<void> {
    try {
      await this.call("loginByToken", this.jwt);
      logger.info("kuma socket reconnected and re-authenticated");
    } catch (e) {
      logger.warn({ err: errMsg(e) }, "loginByToken failed after reconnect; retrying full login");
      try {
        await this.login();
      } catch (e2) {
        // Leave the connection unauthenticated; reconcile calls will fail and the next cycle retries.
        logger.error({ err: errMsg(e2) }, "kuma re-login failed");
      }
    }
  }
}
