import pino, { type DestinationStream, type Logger } from "pino";
import { maskSecrets } from "./trace/mask.ts";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type { Logger };

const SECRET_KEYS = ["authorization", "api_key", "apiKey", "token", "secret", "password"];
const REDACT_PATHS = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
  "headers.authorization",
  "*.headers.authorization",
];

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Error をふつうのオブジェクトにする（message・stack は列挙されないので明示的に取り出す） */
function serializeError(error: Error): Record<string, unknown> {
  return {
    ...error,
    type: error.constructor.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  };
}

/**
 * ログに付けたオブジェクトを再帰的にたどり、文字列に maskSecrets をかける。
 * pino の formatters.log はシリアライザーより前に呼ばれるので、Error はここで直列化してから伏せる。
 * pino.stdSerializers.err の戻り値は独自のプロトタイプを持ち、ふつうのオブジェクトとして扱えないので使わない。
 */
function deepMask(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) return deepMask(serializeError(value), seen);
  if (Array.isArray(value)) return value.map((item) => deepMask(item, seen));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, deepMask(child, seen)]),
  );
}

/** 1行1件の JSON ログ。秘密情報は項目名（redact）と値の形（maskSecrets）の両方で伏せる */
export function createLogger(
  options: { level: LogLevel },
  destination?: DestinationStream,
): Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    // Error は formatters.log（deepMask）で直列化・マスク済み。標準の err シリアライザーを通すと type が上書きされる
    serializers: { err: (err: unknown) => err },
    formatters: {
      log: (object) => deepMask(object, new WeakSet()) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const masked = args.map((arg) => (typeof arg === "string" ? maskSecrets(arg) : arg));
        method.apply(this, masked as Parameters<typeof method>);
      },
    },
  };
  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}
