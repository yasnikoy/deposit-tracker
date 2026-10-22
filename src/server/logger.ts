import "server-only";
import path from "node:path";
import pino from "pino";
import roll from "pino-roll";
import { getEnv } from "./env";

type LoggerState = { logger: pino.Logger; streams: pino.MultiStreamRes; fileLogging: boolean };
const globalForLogger = globalThis as unknown as { loggerState?: LoggerState };

// Streams run in-process (no worker-thread transports), so the standalone build needs no extra files.
function createState(): LoggerState {
  const env = getEnv();
  const level: pino.Level = env.NODE_ENV === "production" ? "info" : "debug";
  const streams = pino.multistream(
    env.NODE_ENV === "development" ? [{ level, stream: process.stdout }] : [],
  );
  const logger = pino(
    { level: env.NODE_ENV === "test" ? "silent" : level, timestamp: pino.stdTimeFunctions.isoTime },
    streams,
  );
  return { logger, streams, fileLogging: false };
}

const state = (globalForLogger.loggerState ??= createState());

export const logger: pino.Logger = state.logger;

/** Adds the daily rotating log file in the data folder (kept 30 days). Called once on server start. */
export async function enableFileLogging(): Promise<void> {
  if (state.fileLogging) return;
  const env = getEnv();
  const file = await roll({
    file: path.join(/*turbopackIgnore: true*/ env.dataDir, "logs", "app"),
    extension: ".log",
    frequency: "daily",
    dateFormat: "yyyy-MM-dd",
    mkdir: true,
    limit: { count: 29 }, // plus the current file = 30 days
  });
  state.streams.add({ level: state.logger.level as pino.Level, stream: file });
  state.fileLogging = true;
}
