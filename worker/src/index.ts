import { config } from "./config.js";
import { fetchAllAddons } from "./api.js";
import {
  buildMonitors,
  reconcile,
  reconcileStaticMonitors,
  pushVerdict,
  type MonitorDescriptor,
} from "./kuvasz.js";
import { probe } from "./probe.js";
import { resetCycle } from "./idsources.js";
import { mapLimit } from "./concurrency.js";
import { errMsg, sleep } from "./utils.js";
import { logger } from "./logger.js";
import type { ProbeResult } from "./types.js";

let monitors: MonitorDescriptor[] = [];

async function refreshList(): Promise<void> {
  const addons = await fetchAllAddons();
  monitors = buildMonitors(addons);
  await reconcile(monitors);
  await reconcileStaticMonitors();
  logger.info(
    { addons: addons.length, monitors: monitors.length },
    "list refreshed; monitors reconciled",
  );
}

async function runCycle(): Promise<void> {
  if (monitors.length === 0) return;
  resetCycle(); // rotate/refresh cached ID-source content each cycle
  const started = Date.now();
  let up = 0;
  let down = 0;
  let pushErrors = 0;

  await mapLimit(monitors, config.concurrency, async (m) => {
    const log = logger.child({ addon: m.addon.slug });
    let r: ProbeResult;
    try {
      r = await probe(m.addon);
    } catch (e) {
      r = {
        success: false,
        durationMs: 0,
        message: `probe error: ${errMsg(e)}`,
        error: "probe",
        detail: { live: false, mode: "content", perResource: [] },
      };
    }
    if (r.success) up++;
    else down++;

    // Per-addon verdict: the final UP/DOWN plus the resource breakdown behind it.
    log[r.success ? "info" : "warn"](
      {
        verdict: r.success ? "UP" : "DOWN",
        mode: r.detail.mode,
        durationMs: r.durationMs,
        error: r.error,
        streamCounts: r.detail.streamCounts,
        resources: r.detail.perResource.map((p) => `${p.resource}:${p.ok ? "ok" : "fail"}`),
        message: r.message,
      },
      `verdict ${r.success ? "UP" : "DOWN"} (${r.detail.mode})`,
    );

    try {
      const status = await pushVerdict(m, r);
      if (status >= 400) {
        pushErrors++;
        log.error({ monitor: m.name, status }, "push failed");
      } else {
        log.debug({ monitor: m.name, status }, "pushed verdict to Kuvasz");
      }
    } catch (e) {
      pushErrors++;
      log.error({ monitor: m.name, err: errMsg(e) }, "push error");
    }
  });

  logger.info(
    { checked: monitors.length, up, down, pushErrors, durationMs: Date.now() - started },
    "cycle complete",
  );
}

async function probeLoop(): Promise<void> {
  for (;;) {
    const started = Date.now();
    try {
      await runCycle();
    } catch (e) {
      logger.error({ err: errMsg(e) }, "cycle error");
    }
    await sleep(Math.max(0, config.probeInterval - (Date.now() - started)));
  }
}

async function listLoop(): Promise<void> {
  for (;;) {
    await sleep(config.listRefresh);
    try {
      await refreshList();
    } catch (e) {
      logger.error({ err: errMsg(e) }, "list refresh error");
    }
  }
}

async function main(): Promise<void> {
  if (!config.kuvaszApiKey || !config.pushSecretSeed) {
    logger.fatal("KUVASZ_API_KEY and PUSH_SECRET_SEED are required");
    process.exit(1);
  }
  logger.info(
    {
      proxy: config.proxyUrl || "none",
      concurrency: config.concurrency,
      probeInterval: config.probeInterval,
      listRefresh: config.listRefresh,
    },
    "starting worker",
  );

  // Retry initial list load until the API is reachable.
  for (;;) {
    try {
      await refreshList();
      break;
    } catch (e) {
      logger.error({ err: errMsg(e) }, "initial list refresh failed, retrying in 30s");
      await sleep(30_000);
    }
  }

  void listLoop();
  await probeLoop();
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main().catch((e) => {
  logger.fatal({ err: errMsg(e) }, "fatal");
  process.exit(1);
});
