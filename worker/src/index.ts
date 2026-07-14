import { config } from "./config.js";
import { fetchAllAddons } from "./api.js";
import { KumaClient } from "./kuma-client.js";
import { reconcile, pushResult, type Binding } from "./kuma.js";
import { probe } from "./probe.js";
import { resetCycle } from "./idsources.js";
import { mapLimit } from "./concurrency.js";
import { errMsg, sleep } from "./utils.js";
import { logger } from "./logger.js";
import type { ProbeResult } from "./types.js";

const kuma = new KumaClient({
  url: config.kumaUrl,
  username: config.kumaUsername,
  password: config.kumaPassword,
});

let bindings: Binding[] = [];

async function refreshList(): Promise<void> {
  const addons = await fetchAllAddons();
  bindings = await reconcile(kuma, addons);
  logger.info({ addons: addons.length, monitors: bindings.length }, "list refreshed");
}

async function runCycle(): Promise<void> {
  if (bindings.length === 0) return;
  resetCycle(); // rotate/refresh cached ID-source content each cycle
  const started = Date.now();
  let up = 0;
  let down = 0;
  let pushErrors = 0;

  await mapLimit(bindings, config.concurrency, async (binding) => {
    const log = logger.child({ addon: binding.addon.slug });
    let r: ProbeResult;
    try {
      r = await probe(binding.addon);
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
      const status = await pushResult(binding, r);
      if (status >= 400) {
        pushErrors++;
        log.error({ monitorID: binding.monitorID, status }, "push failed");
      } else {
        log.debug({ monitorID: binding.monitorID, status }, "pushed verdict to Uptime Kuma");
      }
    } catch (e) {
      pushErrors++;
      log.error({ monitorID: binding.monitorID, err: errMsg(e) }, "push error");
    }
  });

  logger.info(
    { checked: bindings.length, up, down, pushErrors, durationMs: Date.now() - started },
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
  if (!config.kumaPassword) {
    logger.fatal("KUMA_PASSWORD is required");
    process.exit(1);
  }
  logger.info(
    {
      proxy: config.proxyUrl || "none",
      concurrency: config.concurrency,
      probeInterval: config.probeInterval,
      listRefresh: config.listRefresh,
      pushWatchdog: config.pushWatchdog,
    },
    "starting worker",
  );

  // Retry until Kuma is reachable and authenticated (first boot also creates the admin account).
  for (;;) {
    try {
      await kuma.start();
      break;
    } catch (e) {
      logger.error({ err: errMsg(e) }, "kuma connect failed, retrying in 30s");
      await sleep(30_000);
    }
  }

  // Retry initial list load + reconcile until the API is reachable.
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
