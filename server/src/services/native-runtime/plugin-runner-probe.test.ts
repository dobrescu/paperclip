import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import WebSocket from "ws";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RunnerProcessHandle, RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import * as runnerRuntime from "../../vendor/paperclip-runner/index.js";
const { spawnRunner } = await import(new URL("../../../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts", import.meta.url).href) as {
  spawnRunner: (options: any) => RunnerProcessHandle;
};
import { readRunnerdArtifactBinding, createRunnerdCodexTransport, canonicalNativeRuntimeContextDigest, type NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";
import type { PluginEnvironmentTaskOperation, PluginEnvironmentTaskResult } from "@paperclipai/plugin-sdk";
import { createPluginRunnerTaskOwner } from "./plugin-runner-task.js";
import { probePluginRunnerEnvironment } from "./plugin-runner-probe.js";

// Provider ingress TLS/reconnect is tested separately. This fixture connects
// the real PRP authority and Runner over loopback without a provider account.
vi.mock("../../realtime/runner-prp-outbound.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../realtime/runner-prp-outbound.js")>();
  return { ...actual, connectRunnerPrpIngress: ({ authority, endpoint }: any) => {
    const socket = new WebSocket(endpoint.websocketUrl.replace("wss:", "ws:"), { perMessageDeflate: false });
    const wire = new actual.WsJsonWireConnection(socket);
    const attachment = authority.attachWireConnection(wire);
    const ready = new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => { if (attachment.isAuthenticated()) { clearInterval(interval); resolve(); } }, 10);
      socket.once("error", error => { clearInterval(interval); reject(error); });
      socket.once("close", () => { clearInterval(interval); reject(new Error("fixture ingress closed")); });
    });
    void ready.catch(() => {});
    return { ready, failure: new Promise(() => {}), close: async () => { wire.close(); } };
  } };
});

describe("plugin Runner setup", () => {
  beforeAll(() => {
    execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", "packages/paperclip-runner/runner/Cargo.toml",
      "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd", "--bin", "fake-codex-app-server"], { stdio: "pipe" });
  }, 600_000);
  it.each([
    { acpxAgent: "pi", model: "fixture-model", piThinkingLevel: "high", options: { piThinkingLevel: "high" } },
    { acpxAgent: "claude", model: "claude-opus-5-5", effort: "high", options: { claudeEffort: "high" } },
  ])("passes saved $acpxAgent settings to the setup transport", async ({ options, ...config }) => {
    const probe = vi.spyOn(runnerRuntime, "probeNativeRunnerEnvironment").mockImplementation(async input => {
      expect(input.transportOptions).toMatchObject({ acpxAgent: config.acpxAgent, ...options });
      await input.onCleanupConfirmed?.();
      return { provider: "acpx", providerDriver: "acpx_runtime", effectiveModel: config.model, helloProbePassed: true };
    });
    try {
      const result = await probePluginRunnerEnvironment({ companyId: "fixture-company", adapterType: "paperclip_runner",
        config: { provider: "acpx", ...config },
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: "probe-lease",
          runnerTaskProbe: { runId: "probe-run", sessionId: "probe-session" },
          runnerTask: async () => ({ kind: "description", taskId: "probe-task", runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } }),
        } } as Parameters<typeof probePluginRunnerEnvironment>[0]);
      expect(result.status).toBe("pass");
      expect(probe).toHaveBeenCalledOnce();
    } finally { probe.mockRestore(); }
  });
  it.each(["hello", "wrong-model", "resume"])("requires the actual Runner/provider hello through the task API (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "plugin-probe-fixture-"));
    const workspace = join(root, "workspace");
    // Provider-selected locations share no prescribed runtime root or directory names.
    const resources: Record<string, string> = { runner_state: join(root, "records"), provider_state: join(root, "account"), runtime_context: join(root, "input.json") };
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const runnerBinary = resolve("packages/paperclip-runner/runner/target/release/paperclip-runnerd");
    const fakeCodex = resolve("packages/paperclip-runner/runner/target/release/fake-codex-app-server");
    const codexCommand = join(root, "codex");
    await writeFile(codexCommand, `#!/bin/sh\nexec '${fakeCodex.replace(/'/g, "'\\''")}' "$@" --state-file '${join(root, "fake-state.json")}' ${mode === "wrong-model" ? "--returned-model wrong-model" : ""}\n`);
    await chmod(codexCommand, 0o700);
    const artifact = readRunnerdArtifactBinding(runnerBinary);
    const probeRunId = randomUUID();
    let listenPath = `/api/runner/v1/connect/${probeRunId}`;
    const operations: PluginEnvironmentTaskOperation[] = [];
    let handle: ReturnType<typeof spawnRunner> | undefined;
    let stopped = false;
    const task = async (operation: unknown): Promise<PluginEnvironmentTaskResult> => {
      const op = operation as PluginEnvironmentTaskOperation;
      operations.push(op);
      switch (op.kind) {
        case "describe": return { kind: "description", taskId: "task", runner: artifact };
        case "submit": {
          // Core must not require the provider's workspace to exist locally before dispatch.
          stopped = false;
          listenPath = `/api/runner/v1/connect/${op.runner.runId}`;
          await mkdir(workspace, { recursive: true });
          const launch = op.launch!;
          await mkdir(resources.provider_state!, { recursive: true });
          await writeFile(resources.runtime_context!, JSON.stringify({ schema: "paperclip.launcher.context.v2",
            resourcesRoot: resources.provider_state, workspace }));
          handle = spawnRunner({ ...launch, runnerBinaryPath: runnerBinary, stateDirectory: resources.runner_state,
            connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: port, listenPath }, ticket: op.bootstrapTicket,
            identity: { runnerInstanceId: op.runner.runnerId, environmentLeaseId: op.runner.leaseId, runId: op.runner.runId,
              normalizedSessionId: op.runner.sessionId, turnId: op.runner.turnId, itemId: op.runner.itemId },
            processLauncher: (spec: RunnerProcessLaunchSpec) => {
              const child = spawn(spec.command, [...spec.args], { env: { ...spec.environment, PAPERCLIP_LAUNCHER_CONTEXT_PATH: resources.runtime_context } });
              let stderr = "";
              child.stderr.on("data", value => { stderr += value; });
              return { child, completion: new Promise((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code, signal) => resolve({ code, signal, stdout: "", stderr }));
              }) };
            },
            environment: { ...process.env, PATH: `${root}:${process.env.PATH}`, HOME: resources.provider_state, CODEX_HOME: resources.provider_state, PAPERCLIP_LAUNCHER_CONTEXT_PATH: resources.runtime_context },
          });
          void handle.completion.then(() => { stopped = true; });
          const deadline = Date.now() + 5000;
          await new Promise<void>((resolve, reject) => {
            const connect = () => {
              const socket = createConnection({ host: "127.0.0.1", port });
              socket.once("connect", () => { socket.destroy(); resolve(); });
              socket.once("error", () => { socket.destroy();
                if (Date.now() >= deadline) reject(new Error("Fixture Runner did not listen"));
                else setTimeout(connect, 10);
              });
            };
            connect();
          });
          return { kind: "accepted", taskId: "task" };
        }
        case "connection": return { kind: "connection", taskId: "task", endpoint: {
          kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${port}${listenPath}`,
          generation: "fixture", secretHeaders: [],
        } };
        case "status": return { kind: "status", taskId: "task", phase: stopped ? "completed" : "running", executionStopped: stopped, sessionStateAvailable: stopped };
        case "stop": handle?.child.kill("SIGTERM"); return { kind: "accepted", taskId: "task" };
        case "complete": return { kind: "accepted", taskId: "task" };
        default: throw new Error("Unexpected task operation");
      }
    };
    try {
      if (mode === "resume") {
        const identity = { runnerInstanceId: "runner", environmentLeaseId: "logical-lease", runId: "run-first",
          normalizedSessionId: "session", turnId: "turn-first", itemId: "item-first" };
        const stateDirectory = join(root, "controller-journal");
        const context = (bindingId: string): NativeRuntimeContextSnapshot => {
          const digest = "0".repeat(64);
          const value = { prompt: { revision: "fixture", text: "Task policy", digest },
            instructions: { entryPath: "AGENTS.md", bundle: { schema: "paperclip.runtime-asset.v1" as const,
              rootPath: "/controller-only/instructions", digest, manifestDigest: digest, fileCount: 1, totalBytes: 1 } },
            skills: [], mcp: { assignmentSetId: "fixture", digest, bindingId } };
          return { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
        };
        await mkdir(resources.provider_state!, { recursive: true });
        await writeFile(join(resources.provider_state!, "AGENTS.md"), "Installed persistent instructions");
        const retained = vi.fn(async () => {});
        const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", onSessionRetained: retained, pollMs: 1 });
        const first = createRunnerdCodexTransport({ ...owner.driver, stateDirectory, runnerArtifact: artifact,
          runtimeContext: context("first"), prpIdentity: identity, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } });
        let thread: Record<string, unknown>;
        try { thread = (await first.transport.request("thread/start", { cwd: "/controller-unused", model: "gpt-6.1-sol" })).thread as Record<string, unknown>; }
        finally { await first.transport.close(); }
        expect(retained).toHaveBeenCalledOnce();
        await writeFile(join(resources.provider_state!, "persistent-file"), "keep across runs");
        for (const run of ["same", "next", "third"]) {
          if (run !== "same") await writeFile(join(resources.provider_state!, "AGENTS.md"), `Installed persistent instructions ${run}`);
          const nextOwner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex", resumeFrom: "task", pollMs: 1 });
          const second = createRunnerdCodexTransport({ ...nextOwner.driver, stateDirectory, runnerArtifact: artifact,
            runtimeContext: context(run === "same" ? "first" : run),
            prpIdentity: run === "same" ? identity : { ...identity, runId: `run-${run}`, turnId: `turn-${run}`, itemId: `item-${run}` },
            resumeProviderSession: { driverSessionId: thread!.id, providerSessionId: thread!.sessionId } as never,
            lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } });
          try {
            const resumed = await second.transport.request("thread/read", {});
            expect(resumed.thread).toMatchObject({ id: thread!.id, sessionId: thread!.sessionId });
          } finally { await second.transport.close(); }
        }
        expect(await readFile(join(resources.provider_state!, "persistent-file"), "utf8")).toBe("keep across runs");
        const saved = JSON.parse(await readFile(join(resources.runner_state!, "codex-provider-state.json"), "utf8"));
        expect(saved.config.instructions).toContain("Installed persistent instructions third");
        const journal = JSON.parse(await readFile(join(stateDirectory, "control-plane/control-plane-state.json"), "utf8"));
        expect(journal.runAttachTemplate.provider.runtimeContext.mcp.bindingId).toBeNull();
        expect(journal.runAttachTemplate.provider.runtimeContext.instructions.bundle.rootPath).toBe(".");
        await expect(readFile(join(stateDirectory, "runner/runner-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(operations.filter(op => op.kind === "submit")).toHaveLength(4);
        expect(operations.filter(op => op.kind === "submit")[1]).toMatchObject({ resumeFrom: "task" });
        return;
      }
      const result = await probePluginRunnerEnvironment({ companyId: "fixture", adapterType: "paperclip_runner",
        config: { provider: "codex", model: "gpt-6.1-sol", env: { OPENAI_API_KEY: "core-secret-not-transferred" } },
        executionTarget: { kind: "remote", transport: "sandbox", providerKey: "plugin", leaseId: randomUUID(), remoteCwd: "/runner-only/project-does-not-exist-on-core",
          runnerTaskProbe: { runId: probeRunId, sessionId: randomUUID() }, runnerTask: task },
      });
      const submission = operations.find(op => op.kind === "submit");
      expect(submission?.launch).not.toHaveProperty("environment");
      expect(submission?.launch).not.toHaveProperty("assets");
      expect(JSON.stringify(operations)).not.toContain(root);
      expect(JSON.stringify(operations)).not.toContain("core-secret-not-transferred");
      expect(result.status).toBe(mode === "hello" ? "pass" : "fail");
      expect(operations.some(op => op.kind === "submit")).toBe(true);
      expect(operations.some(op => op.kind === "stop")).toBe(true);
      expect(stopped).toBe(true);
      expect(operations.some(op => op.kind === "complete")).toBe(true);
    } finally { handle?.child.kill("SIGTERM"); await handle?.completion; await rm(root, { recursive: true, force: true }); }
  }, 65_000);
});
