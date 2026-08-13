import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../../tasks/task-registry.types.js";

const hoisted = vi.hoisted(() => ({
  tasks: new Map<string, TaskRecord>(),
  spawnAcpPluginRunMock: vi.fn(),
  cancelDetachedTaskRunByIdMock: vi.fn(),
}));

vi.mock("../../agents/acp-spawn.js", () => ({
  spawnAcpPluginRun: (...args: unknown[]) => hoisted.spawnAcpPluginRunMock(...args),
  isSpawnAcpAcceptedResult: (result: { status?: unknown }) => result.status === "accepted",
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ gateway: { port: 18789 } }),
}));

vi.mock("../../tasks/task-owner-access.js", () => ({
  findTaskByRunIdForOwner: ({ runId, callerOwnerKey }: { runId: string; callerOwnerKey: string }) =>
    [...hoisted.tasks.values()].find(
      (task) =>
        task.runId === runId && task.ownerKey === callerOwnerKey && task.scopeKind === "session",
    ),
  getTaskByIdForOwner: ({ taskId, callerOwnerKey }: { taskId: string; callerOwnerKey: string }) => {
    const task = hoisted.tasks.get(taskId);
    return task?.ownerKey === callerOwnerKey && task.scopeKind === "session" ? task : undefined;
  },
}));

vi.mock("../../tasks/task-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tasks/task-executor.js")>()),
  cancelDetachedTaskRunById: (...args: unknown[]) => hoisted.cancelDetachedTaskRunByIdMock(...args),
}));

const { createPluginRuntime } = await import("./index.js");

const requester = {
  requesterAgentId: "clanker",
  requesterSessionKey: "agent:clanker:clankyard:workcell:pr-7982",
};
const targetAgentId = "pr-review";
const childSessionKey = "agent:pr-review:acp:child-1";
const runId = "acp-run-1";
const taskId = "task-1";

function createAcpTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    runtime: "acp",
    requesterSessionKey: requester.requesterSessionKey,
    ownerKey: requester.requesterSessionKey,
    scopeKind: "session",
    childSessionKey,
    agentId: targetAgentId,
    requesterAgentId: requester.requesterAgentId,
    runId,
    label: "Review PR #7982",
    task: "Review the exact PR worktree",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1,
    ...overrides,
  };
}

function createBoundAcp() {
  return createPluginRuntime().acp.bind(requester);
}

function createSpawnRequest() {
  return {
    targetAgentId,
    task: "Review the exact PR worktree",
    cwd: "/reviews/pr-7982",
    label: "Review PR #7982",
    mode: "run" as const,
  };
}

describe("plugin ACP runtime", () => {
  beforeEach(() => {
    hoisted.tasks.clear();
    hoisted.spawnAcpPluginRunMock.mockReset().mockImplementation(async () => {
      const task = createAcpTask();
      hoisted.tasks.set(task.taskId, task);
      return {
        status: "accepted",
        childSessionKey,
        runId,
        mode: "run",
      };
    });
    hoisted.cancelDetachedTaskRunByIdMock.mockReset().mockImplementation(async () => ({
      found: true,
      cancelled: true,
      task: createAcpTask({ status: "cancelled" }),
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("spawns a configured silent ACP run bound to the canonical requester", async () => {
    const result = await createBoundAcp().spawn(createSpawnRequest());

    expect(result).toEqual({ childSessionKey, runId, taskId, status: "accepted" });
    expect(hoisted.spawnAcpPluginRunMock).toHaveBeenCalledWith(
      {
        agentId: targetAgentId,
        cwd: "/reviews/pr-7982",
        label: "Review PR #7982",
        mode: "run",
        task: "Review the exact PR worktree",
      },
      {
        agentSessionKey: requester.requesterSessionKey,
        requesterAgentIdOverride: requester.requesterAgentId,
      },
    );
  });

  it("rejects a spoofed requester agent that does not own the bound session", () => {
    expect(() =>
      createPluginRuntime().acp.bind({
        requesterAgentId: "main",
        requesterSessionKey: requester.requesterSessionKey,
      }),
    ).toThrow('Plugin ACP requester agent "main" does not match session owner "clanker".');
  });

  it("preserves target policy rejection from ACP spawn", async () => {
    hoisted.spawnAcpPluginRunMock.mockResolvedValueOnce({
      status: "forbidden",
      errorCode: "agent_forbidden",
      error: 'ACP agent "pr-review" is not allowed by policy.',
    });

    await expect(createBoundAcp().spawn(createSpawnRequest())).rejects.toThrow(
      'ACP agent "pr-review" is not allowed by policy.',
    );
  });

  it("rejects status and cancellation for a task owned by a different requester", async () => {
    hoisted.tasks.set(taskId, createAcpTask());
    const other = createPluginRuntime().acp.bind({
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:telegram:direct:1",
    });

    await expect(other.status({ taskId })).rejects.toThrow("ACP task not found.");
    await expect(other.cancel({ taskId, reason: "stop" })).rejects.toThrow("ACP task not found.");
    expect(hoisted.cancelDetachedTaskRunByIdMock).not.toHaveBeenCalled();
  });

  it("returns terminal status for the requester-owned task", async () => {
    hoisted.tasks.set(taskId, createAcpTask({ status: "succeeded" }));

    await expect(createBoundAcp().status({ taskId })).resolves.toEqual({
      taskId,
      status: "succeeded",
      childSessionKey,
      runId,
    });
  });

  it("cancels an owner-authorized ACP task with its reason", async () => {
    hoisted.tasks.set(taskId, createAcpTask());

    await createBoundAcp().cancel({ taskId, reason: "review superseded" });

    expect(hoisted.cancelDetachedTaskRunByIdMock).toHaveBeenCalledWith({
      cfg: { gateway: { port: 18789 } },
      taskId,
      reason: "review superseded",
    });
  });

  it("rejects a run accepted without a durable owner task", async () => {
    hoisted.spawnAcpPluginRunMock.mockImplementationOnce(async () => ({
      status: "accepted",
      childSessionKey,
      runId,
      mode: "run",
    }));

    await expect(createBoundAcp().spawn(createSpawnRequest())).rejects.toThrow(
      `ACP task registry entry unavailable for accepted run ${runId}.`,
    );
  });
});
