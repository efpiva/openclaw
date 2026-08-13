// ACP runtime facade binds every child task operation to one requester session.
import { isSpawnAcpAcceptedResult, spawnAcpPluginRun } from "../../agents/acp-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { cancelDetachedTaskRunById } from "../../tasks/task-executor.js";
import { findTaskByRunIdForOwner, getTaskByIdForOwner } from "../../tasks/task-owner-access.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";

export type PluginAcpRequester = {
  requesterAgentId: string;
  requesterSessionKey: string;
};

export type PluginAcpSpawnRequest = {
  targetAgentId: string;
  task: string;
  cwd: string;
  label: string;
  mode: "run";
};

export type PluginAcpSpawnResult = {
  childSessionKey: string;
  runId: string;
  taskId: string;
  status: "accepted";
};

export type AcpTaskStatus = {
  taskId: string;
  status: TaskStatus;
  childSessionKey?: string;
  runId?: string;
};

export type PluginAcpFacade = {
  bind: (requester: PluginAcpRequester) => {
    spawn: (request: PluginAcpSpawnRequest) => Promise<PluginAcpSpawnResult>;
    status: (input: { taskId: string }) => Promise<AcpTaskStatus>;
    cancel: (input: { taskId: string; reason: string }) => Promise<void>;
  };
};

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Plugin ACP ${label} requires a non-empty string.`);
  }
  return value.trim();
}

function requireRequester(requester: PluginAcpRequester): PluginAcpRequester {
  const requesterAgentId = requireNonEmptyString(requester.requesterAgentId, "requesterAgentId");
  const requesterSessionKey = requireNonEmptyString(
    requester.requesterSessionKey,
    "requesterSessionKey",
  );
  const sessionOwner = parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (!sessionOwner || normalizeAgentId(sessionOwner) !== normalizeAgentId(requesterAgentId)) {
    throw new Error(
      `Plugin ACP requester agent "${requesterAgentId}" does not match session owner "${sessionOwner ?? "unknown"}".`,
    );
  }
  return { requesterAgentId: normalizeAgentId(requesterAgentId), requesterSessionKey };
}

function requireSpawnString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Plugin ACP spawn requires a non-empty ${label}.`);
  }
  return value.trim();
}

function requireSpawnRequest(request: PluginAcpSpawnRequest): PluginAcpSpawnRequest {
  if (request.mode !== "run") {
    throw new Error('Plugin ACP spawn requires mode "run".');
  }
  return {
    targetAgentId: requireSpawnString(request.targetAgentId, "targetAgentId"),
    task: requireSpawnString(request.task, "task"),
    cwd: requireSpawnString(request.cwd, "cwd"),
    label: requireSpawnString(request.label, "label"),
    mode: "run",
  };
}

function taskStatus(task: TaskRecord): AcpTaskStatus {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ...(task.runId ? { runId: task.runId } : {}),
  };
}

function getOwnedAcpTask(params: { taskId: string; requesterSessionKey: string }): TaskRecord {
  const taskId = requireNonEmptyString(params.taskId, "taskId");
  const task = getTaskByIdForOwner({
    taskId,
    callerOwnerKey: params.requesterSessionKey,
  });
  if (!task || task.runtime !== "acp") {
    throw new Error("ACP task not found.");
  }
  return task;
}

export function createRuntimeAcp(): PluginAcpFacade {
  return {
    bind: (requester) => {
      const boundRequester = requireRequester(requester);
      return {
        spawn: async (request) => {
          const normalizedRequest = requireSpawnRequest(request);
          const spawned = await spawnAcpPluginRun(
            {
              agentId: normalizedRequest.targetAgentId,
              cwd: normalizedRequest.cwd,
              label: normalizedRequest.label,
              mode: "run",
              task: normalizedRequest.task,
            },
            {
              agentSessionKey: boundRequester.requesterSessionKey,
              requesterAgentIdOverride: boundRequester.requesterAgentId,
            },
          );
          if (!isSpawnAcpAcceptedResult(spawned)) {
            throw new Error(spawned.error);
          }

          const task = findTaskByRunIdForOwner({
            runId: spawned.runId,
            callerOwnerKey: boundRequester.requesterSessionKey,
          });
          if (!task || task.runtime !== "acp" || task.childSessionKey !== spawned.childSessionKey) {
            throw new Error(
              `ACP task registry entry unavailable for accepted run ${spawned.runId}.`,
            );
          }
          return {
            childSessionKey: spawned.childSessionKey,
            runId: spawned.runId,
            taskId: task.taskId,
            status: "accepted",
          };
        },
        status: async ({ taskId }) =>
          taskStatus(
            getOwnedAcpTask({
              taskId,
              requesterSessionKey: boundRequester.requesterSessionKey,
            }),
          ),
        cancel: async ({ taskId, reason }) => {
          const task = getOwnedAcpTask({
            taskId,
            requesterSessionKey: boundRequester.requesterSessionKey,
          });
          const cancellationReason = requireNonEmptyString(reason, "cancellation reason");
          const result = await cancelDetachedTaskRunById({
            cfg: getRuntimeConfig(),
            taskId: task.taskId,
            reason: cancellationReason,
          });
          if (!result.found || !result.cancelled) {
            throw new Error(result.reason ?? `Failed to cancel ACP task: ${cancellationReason}`);
          }
        },
      };
    },
  };
}
