import { describe, expect, it, vi } from "vitest";
import type { RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { createPluginRunnerTaskOwner } from "./plugin-runner-task.js";

const ingress = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingress.connect }));

function launchSpec(): RunnerProcessLaunchSpec {
  return { command: "unused", args: [], cwd: "/unused", environment: {}, nativeRunner: {
    identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
      normalizedSessionId: "session", turnId: "turn", itemId: "item" }, ticket: "synthetic-ticket",
    diagnosticsDirectory: "/controller/private/diagnostics",
    stateDirectory: "/state", runnerVersion: "fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
    maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  } };
}

function provider() {
  let stopped = false;
  const task = vi.fn(async (operation: any): Promise<unknown> => {
    if (operation.kind === "stop") stopped = true;
    if (operation.kind === "status") return { kind: "status", taskId: "task", phase: stopped ? "cancelled" : "running", executionStopped: stopped, sessionStateAvailable: stopped };
    if (operation.kind === "connection") return { kind: "connection", taskId: "task", endpoint: {
      kind: "authenticated_websocket", websocketUrl: "wss://fixture.example.test/connect", generation: "fixture", secretHeaders: [],
    } };
    return { kind: "accepted", taskId: "task" };
  });
  return { task };
}

describe("plugin native Runner ownership", () => {
  it("collects refreshed credentials after process termination and before releasing task grants", async () => {
    const { task } = provider();
    const perform = task.getMockImplementation()!;
    const credential = { type: "codex-auth-json" as const, authJson: '{"OPENAI_API_KEY":"fixture-key"}' };
    let copied = false;
    task.mockImplementation(async operation => {
      if (operation.kind === "credentials") {
        expect(task.mock.calls.some(([op]) => op.kind === "stop")).toBe(true);
        return { kind: "credentials", taskId: "task", credential };
      }
      if (operation.kind === "complete") expect(copied).toBe(true);
      return perform(operation);
    });
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", credential,
      credentialIdentity: "revision", accountIdentity: "stable-account", pollMs: 1,
      onCredentials: async value => { expect(value).toEqual(credential); copied = true; } });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec()); registration.activate(); await registration.ready();
    expect(task.mock.calls.find(([op]) => op.kind === "submit")?.[0]).toMatchObject({ credential, credentialIdentity: "revision", accountIdentity: "stable-account" });
    await registration.release(); await registration.checkpoint("settled"); await process.completion;
    expect(copied).toBe(true);
  });
  it("retains grants when the credential handoff fails", async () => {
    const { task } = provider();
    const perform = task.getMockImplementation()!;
    task.mockImplementation(async op => op.kind === "credentials" ? { kind: "credentials", taskId: "task", credential: { type: "codex-auth-json", authJson: "{}" } } : perform(op));
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", accountIdentity: "account", pollMs: 1,
      onCredentials: async () => { throw new Error("credential handoff failed"); } });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec()); registration.activate(); await registration.ready(); await registration.release();
    await expect(registration.checkpoint("settled")).rejects.toThrow("credential handoff failed");
    await process.completion;
    expect(task.mock.calls.some(([op]) => op.kind === "complete")).toBe(false);
  });

  it.each([false, true])("records retained sessions after status failures (retry exhausted: %s)", async exhausted => {
    const { task } = provider();
    const perform = task.getMockImplementation()!;
    let failStatus = false;
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    task.mockImplementation(async operation => {
      if (operation.kind === "stop") failStatus = false;
      if (operation.kind === "status" && failStatus) {
        failStatus = exhausted;
        if (exhausted) clock += 16_000;
        throw new Error("status connection lost");
      }
      return perform(operation);
    });
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const checkpoint = vi.fn(async () => {});
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", onSessionRetained: checkpoint, pollMs: 1,
      });
    const registration = await owner.registration({} as never, "run");
    const handle = owner.launcher(launchSpec());
    const completed = vi.fn(); void handle.completion.then(completed);
    try {
      registration.activate(); await registration.ready();
      expect(handle.restart).toBeNull();
      failStatus = true;
      if (exhausted) await expect(registration.failure).rejects.toThrow("reconcile the saved task");
      else await vi.waitFor(() => expect(failStatus).toBe(false));
      expect(completed).not.toHaveBeenCalled();
      await registration.release(); await registration.checkpoint("settled");
      await expect(handle.completion).resolves.toMatchObject({ code: 1 });
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(task.mock.calls.filter(([op]) => op.kind === "submit")).toHaveLength(1);
      expect(task.mock.calls.filter(([op]) => op.kind === "complete")).toHaveLength(1);
    } finally { now.mockRestore(); handle.child.kill(); }
  });
  it("exposes connection failure before activation and forwards late recovery exhaustion", async () => {
    const { task } = provider();
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), failure, close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",  pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const observed = registration.failure.catch(error => error);
    const handle = owner.launcher(launchSpec());
    registration.activate(); await registration.ready();
    const error = new Error("runner ingress recovery exhausted"); fail(error);
    expect(await observed).toBe(error);
    expect(task.mock.calls.find(([op]) => op.kind === "stop")).toBeUndefined();
    await registration.release(); await registration.checkpoint("settled"); await handle.completion;
  });
  it("reconciles a lost submit reply without launching another attempt", async () => {
    const { task } = provider();
    task.mockRejectedValueOnce(new Error("lost submit reply")).mockRejectedValueOnce(new Error("status temporarily unavailable"));
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
       pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec());
    try {
      registration.activate(); await registration.ready();
      expect(task.mock.calls.filter(([operation]) => operation.kind === "submit")).toHaveLength(1);
      expect(task.mock.calls.find(([operation]) => operation.kind === "submit")?.[0].launch).not.toHaveProperty("diagnosticsDirectory");
      expect(() => owner.launcher(launchSpec())).toThrow("new task lease");
      await registration.release(); await registration.checkpoint("settled"); await process.completion;
      expect(task.mock.calls.filter(([operation]) => operation.kind === "complete")).toHaveLength(1);
    } finally { process.child.kill(); await process.completion.catch(() => {}); }
  });

  it("retains task grants when retention recording fails after route release", async () => {
    const { task } = provider();
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", onSessionRetained: async () => { throw new Error("retention write failed"); }, pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec());
    registration.activate(); await registration.ready(); await registration.release();
    expect(task.mock.calls.some(([operation]) => operation.kind === "complete")).toBe(false);
    await expect(registration.checkpoint("settled")).rejects.toThrow("retention write failed");
    await process.completion;
    expect(task.mock.calls.some(([operation]) => operation.kind === "complete")).toBe(false);
  });

  it("detaches a controller without stopping its durable task", async () => {
    const { task } = provider();
    const close = vi.fn(async () => {});
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close });
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
       pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    owner.launcher(launchSpec());
    registration.activate(); await registration.ready(); await registration.release("detach");
    expect(close).toHaveBeenCalledOnce();
    expect(task.mock.calls.some(([operation]) => operation.kind === "stop" || operation.kind === "complete")).toBe(false);
  });

  it("prevents a late submission after cancellation during dispatch recording", async () => {
    let finish!: () => void;
    const prepared = new Promise<void>(resolve => { finish = resolve; });
    const { task } = provider();
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
      onDispatched: () => prepared, pollMs: 1 });
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec());
    registration.activate();
    process.child.kill(); await registration.release(); finish();
    await expect(process.completion).resolves.toMatchObject({ code: 1 });
    await expect(registration.ready()).rejects.toThrow("cancelled");
    expect(task).not.toHaveBeenCalled();
  });

  it("does not connect a released or aborted startup to the PRP authority", async () => {
    const { task } = provider();
    ingress.connect.mockClear();
    const controller = new AbortController(); controller.abort();
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
       pollMs: 1 });
    const registration = await owner.registration({} as never, "run", controller.signal);
    const process = owner.launcher(launchSpec());
    try {
      registration.activate();
      await expect(registration.ready()).rejects.toThrow("cancelled");
      expect(task.mock.calls.filter(([operation]) => operation.kind === "connection")).toHaveLength(0);
      expect(ingress.connect).not.toHaveBeenCalled();
      await registration.release(); await registration.checkpoint("settled"); await process.completion;
    } finally { process.child.kill(); await process.completion.catch(() => {}); }
  });
});
