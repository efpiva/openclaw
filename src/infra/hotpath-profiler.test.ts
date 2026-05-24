import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isHotpathProfilingEnabled,
  profileHotpathAsync,
  profileHotpathSync,
  recordHotpathProfileEvent,
  testing,
} from "./hotpath-profiler.js";

const ENV_KEYS = [
  "OPENCLAW_HOTPATH_PROFILE",
  "OPENCLAW_HOTPATH_PROFILE_DIR",
  "OPENCLAW_HOTPATH_PROFILE_CONTROL_FILE",
  "OPENCLAW_HOTPATH_PROFILE_SAMPLE_RATE",
  "OPENCLAW_HOTPATH_PROFILE_SLOW_MS",
  "OPENCLAW_HOTPATH_PROFILE_MAX_BYTES",
];

const savedEnv = new Map<string, string | undefined>();
let tempDir: string;

async function readJsonl(dir: string): Promise<Array<Record<string, unknown>>> {
  const entries = await fs.readdir(dir).catch(() => []);
  const jsonl = entries.filter((entry) => entry.endsWith(".jsonl"));
  const out: Array<Record<string, unknown>> = [];
  for (const entry of jsonl) {
    const raw = await fs.readFile(path.join(dir, entry), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim()) {
        out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return out;
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hotpath-profiler-test-"));
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  testing.resetHotpathProfilerForTests();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
  testing.resetHotpathProfilerForTests();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("hotpath profiler", () => {
  it("is disabled by default and does not create profile files", async () => {
    process.env.OPENCLAW_HOTPATH_PROFILE_DIR = tempDir;

    expect(isHotpathProfilingEnabled()).toBe(false);
    recordHotpathProfileEvent("test.disabled", { count: 1 });
    await testing.flushHotpathProfilerForTests();

    await expect(fs.readdir(tempDir)).resolves.toEqual([]);
  });

  it("writes JSONL metadata when enabled", async () => {
    process.env.OPENCLAW_HOTPATH_PROFILE = "1";
    process.env.OPENCLAW_HOTPATH_PROFILE_DIR = tempDir;

    recordHotpathProfileEvent("test.enabled", {
      count: 2,
      ok: true,
      note: "safe-metadata",
    });
    await testing.flushHotpathProfilerForTests();

    const events = await readJsonl(tempDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      pid: process.pid,
      metric: "test.enabled",
      count: 2,
      ok: true,
      note: "safe-metadata",
    });
    expect(typeof events[0]?.ts).toBe("string");
  });

  it("honors an optional control file", async () => {
    const controlFile = path.join(tempDir, "enabled.flag");
    process.env.OPENCLAW_HOTPATH_PROFILE = "1";
    process.env.OPENCLAW_HOTPATH_PROFILE_DIR = tempDir;
    process.env.OPENCLAW_HOTPATH_PROFILE_CONTROL_FILE = controlFile;

    recordHotpathProfileEvent("test.gated", { step: 1 });
    await testing.flushHotpathProfilerForTests();
    expect(await readJsonl(tempDir)).toHaveLength(0);

    await fs.writeFile(controlFile, "enabled\n");
    testing.resetHotpathProfilerForTests();
    recordHotpathProfileEvent("test.gated", { step: 2 });
    await testing.flushHotpathProfilerForTests();

    const events = await readJsonl(tempDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ metric: "test.gated", step: 2 });
  });

  it("returns wrapper results and records duration/status", async () => {
    process.env.OPENCLAW_HOTPATH_PROFILE = "1";
    process.env.OPENCLAW_HOTPATH_PROFILE_DIR = tempDir;

    const syncResult = profileHotpathSync("test.sync", { kind: "sync" }, () => 42);
    const asyncResult = await profileHotpathAsync("test.async", { kind: "async" }, async () => 7);

    expect(syncResult).toBe(42);
    expect(asyncResult).toBe(7);
    await testing.flushHotpathProfilerForTests();
    const events = await readJsonl(tempDir);
    expect(events.map((event) => event.metric)).toEqual(["test.sync", "test.async"]);
    expect(events.every((event) => event.status === "ok")).toBe(true);
    expect(events.every((event) => typeof event.durationMs === "number")).toBe(true);
  });

  it("rethrows wrapper errors while logging failure metadata", async () => {
    process.env.OPENCLAW_HOTPATH_PROFILE = "1";
    process.env.OPENCLAW_HOTPATH_PROFILE_DIR = tempDir;

    expect(() =>
      profileHotpathSync("test.sync.error", undefined, () => {
        throw new Error("boom secret-ish details should not be logged");
      }),
    ).toThrow("boom");
    await expect(
      profileHotpathAsync("test.async.error", undefined, async () => {
        throw new TypeError("bad");
      }),
    ).rejects.toThrow("bad");
    await testing.flushHotpathProfilerForTests();

    const events = await readJsonl(tempDir);
    expect(events).toHaveLength(2);
    expect(events).toMatchObject([
      { metric: "test.sync.error", status: "error", errorName: "Error" },
      { metric: "test.async.error", status: "error", errorName: "TypeError" },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-ish");
  });

  it("drops unsafe field values", async () => {
    process.env.OPENCLAW_HOTPATH_PROFILE = "1";
    process.env.OPENCLAW_HOTPATH_PROFILE_DIR = tempDir;

    recordHotpathProfileEvent("test.sanitize", {
      safeNumber: 1,
      safeString: "ok",
      unsafeObject: { nested: true } as unknown as string,
      unsafeArray: ["x"] as unknown as string,
      unsafeUndefined: undefined,
      unsafeNan: Number.NaN,
    });
    await testing.flushHotpathProfilerForTests();

    const [event] = await readJsonl(tempDir);
    expect(event).toMatchObject({ safeNumber: 1, safeString: "ok" });
    expect(event).not.toHaveProperty("unsafeObject");
    expect(event).not.toHaveProperty("unsafeArray");
    expect(event).not.toHaveProperty("unsafeUndefined");
    expect(event).not.toHaveProperty("unsafeNan");
  });
});
