import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import {
  addTestHook,
  createMockPluginRegistry,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-helpers.js";

const EVENT = {
  runId: "run-1",
  sessionKey: "agent:pr-review:acp:session-1",
  agentId: "pr-review",
  outcome: "ok" as const,
  terminalReply: {
    disposition: "visible" as const,
    text: '{"kind":"DIRECT_ACP_REVIEW_RESULT_V1"}',
  },
};

const DEFAULT_ACP_TERMINAL_TIMEOUT_MS = 15_000;

describe("acp_terminal hook runner", () => {
  it("awaits handlers in priority order before returning", async () => {
    const calls: string[] = [];
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "low-priority",
      hookName: "acp_terminal",
      handler: async () => {
        calls.push("low");
      },
      priority: 0,
    });
    addTestHook({
      registry,
      pluginId: "high-priority",
      hookName: "acp_terminal",
      handler: async () => {
        calls.push("high");
      },
      priority: 10,
    });
    const runner = createHookRunner(registry);

    await runner.runAcpTerminal(EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(calls).toEqual(["high", "low"]);
  });

  it("fails open when a handler times out", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "acp_terminal",
            handler: () => new Promise(() => {}),
          },
        ]),
        { logger },
      );

      const run = runner.runAcpTerminal(EVENT, TEST_PLUGIN_AGENT_CTX);
      await vi.advanceTimersByTimeAsync(DEFAULT_ACP_TERMINAL_TIMEOUT_MS);

      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] acp_terminal handler from test-plugin failed: timed out after 15000ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
