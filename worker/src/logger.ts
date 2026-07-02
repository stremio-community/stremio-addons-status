import pino from "pino";
import pretty from "pino-pretty";

/**
 * Central pino logger.
 * Always renders through pino-pretty regardless of environment (deliberate project choice for now).
 * Level comes from LOG_LEVEL, defaulting to `debug` so the per-addon probe step trace is visible out of the box.
 */
export const logger = pino(
  { level: process.env.LOG_LEVEL || "debug" },
  pretty({
    colorize: true,
    translateTime: "SYS:standard",
    // `addon` is surfaced as a prefix via messageFormat, so drop it (and process noise) from the trailing object.
    ignore: "pid,hostname,addon",
    messageFormat: "{if addon}[{addon}] {end}{msg}",
  }),
);

export type Logger = typeof logger;
