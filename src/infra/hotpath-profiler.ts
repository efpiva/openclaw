import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export type JsonSafePrimitive = string | number | boolean | null | undefined;

type HotpathProfileFields = Record<string, JsonSafePrimitive>;

type HotpathProfileEvent = Record<string, string | number | boolean | null>;

type PendingProfileLine = {
  filePath: string;
  line: string;
  bytes: number;
};

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_CONTROL_FILE_CHECK_MS = 2_000;
const DEFAULT_FLUSH_DELAY_MS = 100;
const DEFAULT_EVENT_LOOP_INTERVAL_MS = 10_000;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const METRIC_MAX_CHARS = 160;
const FIELD_NAME_MAX_CHARS = 80;
const FIELD_STRING_MAX_CHARS = 240;
const ERROR_NAME_MAX_CHARS = 80;

let cachedControlFilePath: string | undefined;
let cachedControlFileEnabled = false;
let nextControlFileCheckAt = 0;
let sampleCounter = 0;
let profileFileDate = "";
let profileFileIndex = 0;
let profileFileBytes = 0;
let pendingLines: PendingProfileLine[] = [];
let pendingBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushPromise: Promise<void> | undefined;
let eventLoopTimer: ReturnType<typeof setInterval> | undefined;
let eventLoopMonitor: ReturnType<typeof monitorEventLoopDelay> | undefined;
let lastEventLoopUtilization = performance.eventLoopUtilization();
let droppedPendingEvents = 0;

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveProfileDir(): string {
  const explicit = process.env.OPENCLAW_HOTPATH_PROFILE_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(stateDir, "profiles", "hotpath");
  }
  return path.join(os.tmpdir(), "openclaw-hotpath-profile");
}

function resolveMaxBytes(): number {
  return parsePositiveInt(process.env.OPENCLAW_HOTPATH_PROFILE_MAX_BYTES, DEFAULT_MAX_BYTES);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveProfileFilePath(nextLineBytes: number): string {
  const date = todayUtc();
  const maxBytes = resolveMaxBytes();
  if (profileFileDate !== date) {
    profileFileDate = date;
    profileFileIndex = 0;
    profileFileBytes = 0;
  }
  if (profileFileBytes > 0 && profileFileBytes + nextLineBytes > maxBytes) {
    profileFileIndex += 1;
    profileFileBytes = 0;
  }
  profileFileBytes += nextLineBytes;
  return path.join(resolveProfileDir(), `hotpath-${date}-${process.pid}-${profileFileIndex}.jsonl`);
}

function shouldControlFileAllowProfiling(now = Date.now()): boolean {
  const controlFile = process.env.OPENCLAW_HOTPATH_PROFILE_CONTROL_FILE?.trim();
  if (!controlFile) {
    cachedControlFilePath = undefined;
    cachedControlFileEnabled = true;
    nextControlFileCheckAt = 0;
    return true;
  }
  if (cachedControlFilePath !== controlFile) {
    cachedControlFilePath = controlFile;
    cachedControlFileEnabled = false;
    nextControlFileCheckAt = 0;
  }
  if (now < nextControlFileCheckAt) {
    return cachedControlFileEnabled;
  }
  nextControlFileCheckAt = now + DEFAULT_CONTROL_FILE_CHECK_MS;
  try {
    cachedControlFileEnabled = fs.existsSync(controlFile);
  } catch {
    cachedControlFileEnabled = false;
  }
  return cachedControlFileEnabled;
}

export function isHotpathProfilingEnabled(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_HOTPATH_PROFILE) && shouldControlFileAllowProfiling()
  );
}

function shouldSample(): boolean {
  const sampleRate = parsePositiveInt(process.env.OPENCLAW_HOTPATH_PROFILE_SAMPLE_RATE, 1);
  if (sampleRate <= 1) {
    return true;
  }
  sampleCounter = (sampleCounter + 1) % sampleRate;
  return sampleCounter === 0;
}

function sanitizeString(value: string, maxChars = FIELD_STRING_MAX_CHARS): string {
  const singleLine = value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}…`;
}

function sanitizeMetric(metric: string): string | undefined {
  const sanitized = sanitizeString(metric, METRIC_MAX_CHARS);
  return sanitized ? sanitized : undefined;
}

function sanitizeFieldName(name: string): string | undefined {
  const sanitized = sanitizeString(name, FIELD_NAME_MAX_CHARS);
  if (!sanitized || sanitized === "ts" || sanitized === "pid" || sanitized === "metric") {
    return undefined;
  }
  return sanitized;
}

function sanitizeFieldValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  return undefined;
}

function buildEvent(
  metric: string,
  fields?: HotpathProfileFields,
): HotpathProfileEvent | undefined {
  const sanitizedMetric = sanitizeMetric(metric);
  if (!sanitizedMetric) {
    return undefined;
  }
  const event: HotpathProfileEvent = {
    ts: new Date().toISOString(),
    pid: process.pid,
    metric: sanitizedMetric,
  };
  if (!fields) {
    return event;
  }
  for (const [name, value] of Object.entries(fields)) {
    const safeName = sanitizeFieldName(name);
    if (!safeName) {
      continue;
    }
    const safeValue = sanitizeFieldValue(value);
    if (safeValue !== undefined) {
      event[safeName] = safeValue;
    }
  }
  return event;
}

function scheduleFlush(): void {
  if (flushTimer || flushPromise) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushPendingLines();
  }, DEFAULT_FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

function enqueueEvent(event: HotpathProfileEvent): void {
  let line: string;
  try {
    line = `${JSON.stringify(event)}\n`;
  } catch {
    return;
  }
  const bytes = Buffer.byteLength(line);
  if (pendingBytes + bytes > MAX_PENDING_BYTES) {
    droppedPendingEvents += 1;
    return;
  }
  pendingLines.push({ filePath: resolveProfileFilePath(bytes), line, bytes });
  pendingBytes += bytes;
  scheduleFlush();
}

async function flushPendingLines(): Promise<void> {
  if (flushPromise) {
    await flushPromise;
    return;
  }
  const lines = pendingLines;
  pendingLines = [];
  pendingBytes = 0;
  if (lines.length === 0) {
    return;
  }
  flushPromise = (async () => {
    const byFile = new Map<string, string[]>();
    for (const { filePath, line } of lines) {
      const current = byFile.get(filePath);
      if (current) {
        current.push(line);
      } else {
        byFile.set(filePath, [line]);
      }
    }
    for (const [filePath, fileLines] of byFile.entries()) {
      try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.appendFile(filePath, fileLines.join(""), "utf8");
      } catch {
        // Profiling is best-effort and must not affect production behavior.
      }
    }
  })().finally(() => {
    flushPromise = undefined;
    if (pendingLines.length > 0) {
      scheduleFlush();
    }
  });
  await flushPromise;
}

function roundMetric(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function maybeEmitDroppedEventCount(): void {
  if (droppedPendingEvents <= 0) {
    return;
  }
  const dropped = droppedPendingEvents;
  droppedPendingEvents = 0;
  const event = buildEvent("hotpath.profiler.dropped", { dropped });
  if (event) {
    enqueueEvent(event);
  }
}

function emitEventLoopProfile(): void {
  if (!isHotpathProfilingEnabled()) {
    return;
  }
  const monitor = eventLoopMonitor;
  if (!monitor) {
    return;
  }
  const memory = process.memoryUsage();
  const utilization = performance.eventLoopUtilization(lastEventLoopUtilization);
  lastEventLoopUtilization = performance.eventLoopUtilization();
  const event = buildEvent("process.eventLoop", {
    delayP99Ms: roundMetric(monitor.percentile(99) / 1_000_000),
    delayMaxMs: roundMetric(monitor.max / 1_000_000),
    elu: roundMetric(utilization.utilization, 4),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
  });
  monitor.reset();
  if (event) {
    enqueueEvent(event);
  }
  maybeEmitDroppedEventCount();
}

function ensureEventLoopMonitorStarted(): void {
  if (eventLoopTimer) {
    return;
  }
  try {
    eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
    eventLoopMonitor.enable();
    lastEventLoopUtilization = performance.eventLoopUtilization();
    const intervalMs = parsePositiveInt(
      process.env.OPENCLAW_HOTPATH_PROFILE_EVENT_LOOP_INTERVAL_MS,
      DEFAULT_EVENT_LOOP_INTERVAL_MS,
    );
    eventLoopTimer = setInterval(emitEventLoopProfile, intervalMs);
    eventLoopTimer.unref?.();
  } catch {
    eventLoopMonitor = undefined;
  }
}

function recordHotpathProfileEventInternal(
  metric: string,
  fields?: HotpathProfileFields,
  opts?: { sampled?: boolean },
): void {
  if (!isHotpathProfilingEnabled()) {
    return;
  }
  if (opts?.sampled !== true && !shouldSample()) {
    return;
  }
  const event = buildEvent(metric, fields);
  if (!event) {
    return;
  }
  enqueueEvent(event);
  ensureEventLoopMonitorStarted();
}

export function recordHotpathProfileEvent(metric: string, fields?: HotpathProfileFields): void {
  recordHotpathProfileEventInternal(metric, fields);
}

function shouldRecordDuration(durationMs: number): boolean {
  return durationMs >= parseNonNegativeNumber(process.env.OPENCLAW_HOTPATH_PROFILE_SLOW_MS, 0);
}

function safeErrorName(error: unknown): string {
  const raw = error instanceof Error ? error.name : typeof error;
  return sanitizeString(raw || "Error", ERROR_NAME_MAX_CHARS) || "Error";
}

export function profileHotpathSync<T>(
  metric: string,
  fields: HotpathProfileFields | undefined,
  fn: () => T,
): T {
  if (!isHotpathProfilingEnabled() || !shouldSample()) {
    return fn();
  }
  const startedAt = performance.now();
  try {
    const result = fn();
    const durationMs = roundMetric(performance.now() - startedAt);
    if (shouldRecordDuration(durationMs)) {
      recordHotpathProfileEventInternal(
        metric,
        { ...fields, durationMs, status: "ok" },
        { sampled: true },
      );
    }
    return result;
  } catch (error) {
    const durationMs = roundMetric(performance.now() - startedAt);
    if (shouldRecordDuration(durationMs)) {
      recordHotpathProfileEventInternal(
        metric,
        {
          ...fields,
          durationMs,
          status: "error",
          errorName: safeErrorName(error),
        },
        { sampled: true },
      );
    }
    throw error;
  }
}

export async function profileHotpathAsync<T>(
  metric: string,
  fields: HotpathProfileFields | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isHotpathProfilingEnabled() || !shouldSample()) {
    return await fn();
  }
  const startedAt = performance.now();
  try {
    const result = await fn();
    const durationMs = roundMetric(performance.now() - startedAt);
    if (shouldRecordDuration(durationMs)) {
      recordHotpathProfileEventInternal(
        metric,
        { ...fields, durationMs, status: "ok" },
        { sampled: true },
      );
    }
    return result;
  } catch (error) {
    const durationMs = roundMetric(performance.now() - startedAt);
    if (shouldRecordDuration(durationMs)) {
      recordHotpathProfileEventInternal(
        metric,
        {
          ...fields,
          durationMs,
          status: "error",
          errorName: safeErrorName(error),
        },
        { sampled: true },
      );
    }
    throw error;
  }
}

function stopEventLoopMonitor(): void {
  if (eventLoopTimer) {
    clearInterval(eventLoopTimer);
    eventLoopTimer = undefined;
  }
  if (eventLoopMonitor) {
    eventLoopMonitor.disable();
    eventLoopMonitor = undefined;
  }
  lastEventLoopUtilization = performance.eventLoopUtilization();
}

export const testing = {
  resetHotpathProfilerForTests(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    pendingLines = [];
    pendingBytes = 0;
    flushPromise = undefined;
    cachedControlFilePath = undefined;
    cachedControlFileEnabled = false;
    nextControlFileCheckAt = 0;
    sampleCounter = 0;
    profileFileDate = "";
    profileFileIndex = 0;
    profileFileBytes = 0;
    droppedPendingEvents = 0;
    stopEventLoopMonitor();
  },
  async flushHotpathProfilerForTests(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    await flushPendingLines();
  },
} as const;
