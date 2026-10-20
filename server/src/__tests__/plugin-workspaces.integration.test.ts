import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  plugins,
  projects,
  projectWorkspaces,
  pluginCompanySettings,
} from "@paperclipai/db";
import {
  preparePluginWorkspace,
  inspectPluginWorkspace,
  removePluginWorkspace,
  type WorkspaceWorkers,
} from "../services/plugin-workspaces.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { projectService } from "../services/projects.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "plugin workspace ownership",
  () => {
    let db: ReturnType<typeof createDb>,
      stopDb: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      const started =
        await startEmbeddedPostgresTestDatabase("plugin-workspaces");
      db = createDb(started.connectionString);
      stopDb = started.stop;
    });
    afterAll(async () => {
      await db?.$client.end();
      await stopDb?.();
    });
    async function fixture(existingCompanyId?: string) {
      const companyId = existingCompanyId ?? randomUUID(),
        agentId = randomUUID(),
        projectId = randomUUID(),
        sourceId = randomUUID(),
        pluginId = randomUUID(),
        issueId = randomUUID(),
        runId = randomUUID();
      if (!existingCompanyId)
        await db.insert(companies).values({
          id: companyId,
          name: "Storage fixture",
          issuePrefix: companyId.slice(0, 8).toUpperCase(),
        });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Worker",
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
      });
      await db.insert(plugins).values({
        id: pluginId,
        pluginKey: `test.${pluginId}`,
        packageName: "test-storage",
        version: "1.0.0",
        apiVersion: 1,
        status: "ready",
        categories: ["workspace"],
        manifestJson: {
          id: `test.${pluginId}`,
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Storage",
          description: "Storage",
          author: "Test",
          categories: ["workspace"],
          capabilities: ["workspaces.manage", "events.subscribe"],
          resourceLifecycle: ["project"],
          workspaceProvider: {
            modes: ["isolated_workspace", "operator_branch"],
            strategies: ["git_worktree"],
          },
          entrypoints: { worker: "./worker.js" },
        },
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Project",
        status: "in_progress",
        executionWorkspacePolicy: {
          enabled: true,
          storageProviderPluginId: pluginId,
        },
      });
      await db.insert(projectWorkspaces).values({
        id: sourceId,
        companyId,
        projectId,
        name: "Repository",
        sourceType: "remote_managed",
        repoUrl: "https://github.com/example/repo.git",
        cwd: null,
        isPrimary: true,
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        projectId,
        projectWorkspaceId: sourceId,
        title: "Task",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        issueId,
        invocationSource: "manual",
        status: "running",
      });
      const calls: any[] = [];
      let loseResponse = false,
        dirty = false,
        removed = false,
        loseRemovalResponse = false;
      const workers = {
        getWorker: () => ({ supportedMethods: ["workspaceOperation"] }),
        call: async (_id: string, method: string, params: any) => {
          expect(method).toBe("workspaceOperation");
          expect(params).not.toHaveProperty("lease");
          calls.push(params);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("lost result");
          }
          if (params.operation.kind === "prepare") {
            removed = false;
            return {
              kind: "prepared",
              binding: {
                pluginId,
                projectId,
                executionWorkspaceId: params.executionWorkspaceId,
                projectWorkspaceId: sourceId,
                sourceRevision: params.operation.source.revision,
                workspaceRef: `checkout:${params.executionWorkspaceId}`,
              },
              branchName: params.operation.branchName,
              baseSha: "a".repeat(40),
              created: true,
              branchCreatedByRuntime: true,
            };
          }
          if (params.operation.kind === "inspect") {
            if (removed) throw new Error("checkout missing");
            return {
              kind: "inspection",
              headSha: "a".repeat(40),
              branchName: "work",
              hasDirtyTrackedFiles: dirty,
              hasUntrackedFiles: false,
              hasLocalOnlyData: false,
              isMergedIntoBase: true,
              remotelyRecoverable: true,
            };
          }
          removed = true;
          if (loseRemovalResponse) {
            loseRemovalResponse = false;
            throw new Error("lost removal response");
          }
          return { kind: "removed" };
        },
      } as unknown as WorkspaceWorkers;
      const input = {
        companyId,
        projectId,
        projectWorkspaceId: sourceId,
        issueId,
        runId,
        agentId,
        responsibleUserId: null,
        existingWorkspaceId: null as string | null,
        mode: "isolated_workspace",
        strategy: "git_worktree",
        branchName: "work",
      };
      return {
        companyId,
        pluginId,
        issueId,
        runId,
        input,
        calls,
        workers,
        loseRemoval: () => {
          loseRemovalResponse = true;
        },
        lose: () => {
          loseResponse = true;
        },
        dirty: () => {
          dirty = true;
        },
      };
    }
    it("prepares a durable reference without a local checkout or agent allocation", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      expect(workspace).toMatchObject({
        providerType: "plugin",
        cwd: null,
        status: "active",
      });
      expect(f.calls[0].operation.source).not.toHaveProperty("cwd");
      const [task] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issueId));
      expect(task.executionWorkspaceId).toBe(workspace!.id);
      expect(
        await inspectPluginWorkspace(db, f.workers, workspace!),
      ).toMatchObject({ remotelyRecoverable: true });
    });
    it("retains the reservation and retries the same operation after a lost response", async () => {
      const f = await fixture();
      f.lose();
      await expect(
        preparePluginWorkspace(db, f.workers, f.input),
      ).rejects.toThrow("incomplete");
      const [task] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issueId));
      const result = await preparePluginWorkspace(db, f.workers, {
        ...f.input,
        existingWorkspaceId: task.executionWorkspaceId,
      });
      expect(result!.id).toBe(task.executionWorkspaceId);
      expect(f.calls[1].operationId).toBe(f.calls[0].operationId);
    });
    it("reconciles a lost preparation result after the task run stops", async () => {
      const f = await fixture();
      f.lose();
      await expect(
        preparePluginWorkspace(db, f.workers, f.input),
      ).rejects.toThrow("incomplete");
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled" })
        .where(eq(heartbeatRuns.id, f.runId));
      const [task] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issueId));
      const [reservation] = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
      expect(reservation.providerRef).toBeNull();
      await expect(
        inspectPluginWorkspace(db, f.workers, reservation),
      ).resolves.toMatchObject({ remotelyRecoverable: true });
      expect(f.calls[1]).toMatchObject({
        runId: null,
        agentId: null,
        operation: { kind: "prepare" },
      });
      expect(f.calls[1].operationId).toBe(f.calls[0].operationId);
      const [recorded] = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, reservation.id));
      expect(recorded.providerRef).not.toBeNull();
    });
    it("fails closed for a disabled plugin, stopped run, and cross-company source", async () => {
      const f = await fixture();
      await db.insert(pluginCompanySettings).values({
        pluginId: f.pluginId,
        companyId: f.companyId,
        enabled: false,
      });
      await expect(
        preparePluginWorkspace(db, f.workers, f.input),
      ).rejects.toThrow("unavailable");
      await db
        .update(pluginCompanySettings)
        .set({ enabled: true })
        .where(eq(pluginCompanySettings.pluginId, f.pluginId));
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled" })
        .where(eq(heartbeatRuns.id, f.runId));
      await expect(
        preparePluginWorkspace(db, f.workers, f.input),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
      await expect(
        preparePluginWorkspace(db, f.workers, {
          ...f.input,
          companyId: randomUUID(),
        }),
      ).resolves.toBeNull();
    });
    it("keeps source ownership immutable and preserves bindings through metadata edits", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      const svc = projectService(db);
      await expect(
        svc.update(f.input.projectId, { executionWorkspacePolicy: {} }),
      ).rejects.toThrow("storage owner");
      await expect(
        svc.updateWorkspace(f.input.projectId, f.input.projectWorkspaceId, {
          repoUrl: "https://github.com/example/other.git",
        }),
      ).rejects.toThrow("repository source");
      await expect(
        svc.removeWorkspace(f.input.projectId, f.input.projectWorkspaceId),
      ).rejects.toThrow("repository source");
      const execution = executionWorkspaceService(db);
      const updated = await execution.update(workspace!.id, {
        metadata: {
          note: "caller edit",
          workspaceProvider: { workspaceRef: "foreign" },
        },
      });
      expect(updated!.metadata?.workspaceProvider).toEqual(
        workspace!.metadata?.workspaceProvider,
      );
      await expect(
        execution.update(workspace!.id, { providerType: "local_fs" }),
      ).rejects.toThrow("storage plugin");
    });
    it("describes provider removal without promising host cleanup commands", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      await db
        .update(issues)
        .set({ status: "done" })
        .where(eq(issues.id, f.issueId));
      const readiness = await executionWorkspaceService(db, {
        pluginWorkerManager: f.workers,
      }).getCloseReadiness(workspace!.id);
      expect(readiness!.plannedActions).toContainEqual(
        expect.objectContaining({
          kind: "remove_provider_workspace",
          command: null,
        }),
      );
      expect(
        readiness!.plannedActions.some(
          (action) => action.kind === "git_branch_delete",
        ),
      ).toBe(false);
    });
    it("reopens through the same provider without requiring a live run or a host checkout", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, f.runId));
      await db
        .update(executionWorkspaces)
        .set({ status: "archived", closedAt: new Date() })
        .where(eq(executionWorkspaces.id, workspace!.id));
      const result = await executionWorkspaceService(db, {
        pluginWorkerManager: f.workers,
      }).reopenClosedIsolatedExecutionWorkspaceForIssue({
        workspaceId: workspace!.id,
        issue: {
          id: f.issueId,
          companyId: f.companyId,
          projectId: f.input.projectId,
        },
        actor: { actorType: "user", agentId: null },
        authorizationActor: {
          type: "board",
          source: "local_implicit",
          isInstanceAdmin: true,
        },
      });
      expect(result).toMatchObject({
        ok: true,
        reopened: true,
        generation: 1,
        workspace: { cwd: null, providerType: "plugin" },
      });
      expect(f.calls.at(-1)).toMatchObject({
        runId: null,
        agentId: null,
        operation: { kind: "prepare", branchMode: "existing" },
      });
      expect(f.calls.at(-1).operation.existing.workspaceRef).toBe(
        workspace!.providerRef,
      );
    });
    it("replays a durable removal after a lost result without inspecting the missing checkout", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      f.loseRemoval();
      await expect(
        removePluginWorkspace(db, f.workers, workspace!, "a".repeat(40)),
      ).rejects.toThrow("incomplete");
      const inspections = f.calls.filter(
        (call) => call.operation.kind === "inspect",
      ).length;
      await removePluginWorkspace(db, f.workers, workspace!, null);
      expect(
        f.calls.filter((call) => call.operation.kind === "inspect"),
      ).toHaveLength(inspections);
      const removals = f.calls.filter(
        (call) => call.operation.kind === "remove",
      );
      expect(removals).toHaveLength(2);
      expect(removals[0].operationId).toBe(removals[1].operationId);
      const [row] = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, workspace!.id));
      expect(row.metadata).toMatchObject({
        workspaceProviderRemoved: true,
        workspaceProviderRemoval: null,
      });
    });
    it("retires cleaned historical bindings when the storage source changes and refuses later reopen", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      await db
        .update(executionWorkspaces)
        .set({ status: "archived", closedAt: new Date() })
        .where(eq(executionWorkspaces.id, workspace!.id));
      await removePluginWorkspace(db, f.workers, workspace!, "a".repeat(40));
      await expect(
        projectService(db).updateWorkspace(
          f.input.projectId,
          f.input.projectWorkspaceId,
          { repoUrl: "https://github.com/example/new.git" },
        ),
      ).resolves.not.toBeNull();
      const before = f.calls.length;
      const result = await executionWorkspaceService(db, {
        pluginWorkerManager: f.workers,
      }).reopenClosedIsolatedExecutionWorkspaceForIssue({
        workspaceId: workspace!.id,
        issue: {
          id: f.issueId,
          companyId: f.companyId,
          projectId: f.input.projectId,
        },
        actor: { actorType: "user", agentId: null },
        authorizationActor: {
          type: "board",
          source: "local_implicit",
          isInstanceAdmin: true,
        },
      });
      expect(result).toMatchObject({ ok: false, code: "not_reopenable" });
      expect(f.calls).toHaveLength(before);
      await expect(
        projectService(db).update(f.input.projectId, {
          executionWorkspacePolicy: {},
        }),
      ).resolves.not.toBeNull();
      await expect(
        projectService(db).removeWorkspace(
          f.input.projectId,
          f.input.projectWorkspaceId,
        ),
      ).resolves.not.toBeNull();
    });
    it("keeps sweeping later workspaces when one storage plugin is unavailable", async () => {
      const first = await fixture(),
        second = await fixture();
      await preparePluginWorkspace(db, first.workers, first.input);
      await preparePluginWorkspace(db, second.workers, second.input);
      await db.insert(pluginCompanySettings).values({
        pluginId: first.pluginId,
        companyId: first.companyId,
        enabled: false,
      });
      for (const f of [first, second])
        await db
          .update(issues)
          .set({ status: "done", completedAt: new Date() })
          .where(eq(issues.id, f.issueId));
      const workers = {
        getWorker: (id: string) =>
          [first.pluginId, second.pluginId].includes(id)
            ? { supportedMethods: ["workspaceOperation"] }
            : undefined,
        call: (id: string, ...args: unknown[]) =>
          (id === first.pluginId ? first.workers : second.workers).call(
            id,
            ...(args as [any, any, any]),
          ),
      } as unknown as WorkspaceWorkers;
      await expect(
        executionWorkspaceService(db, {
          pluginWorkerManager: workers,
          workspaceReaperCooldownDays: 0,
        }).sweepTerminalWorkspaces(100),
      ).resolves.toBeDefined();
      expect(
        second.calls.some((call) => call.operation.kind === "inspect"),
      ).toBe(true);
    });
    it("retries an ambiguous deletion through the existing terminal sweep", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      f.loseRemoval();
      await db
        .update(executionWorkspaces)
        .set({ status: "cleanup_failed", closedAt: new Date() })
        .where(eq(executionWorkspaces.id, workspace!.id));
      await db
        .update(issues)
        .set({ status: "done", completedAt: new Date() })
        .where(eq(issues.id, f.issueId));
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled" })
        .where(eq(heartbeatRuns.id, f.runId));
      await expect(
        removePluginWorkspace(db, f.workers, workspace!, "a".repeat(40)),
      ).rejects.toThrow("incomplete");
      const workers = {
        getWorker: (id: string) =>
          id === f.pluginId
            ? { supportedMethods: ["workspaceOperation"] }
            : undefined,
        call: f.workers.call.bind(f.workers),
      } as unknown as WorkspaceWorkers;
      await executionWorkspaceService(db, {
        pluginWorkerManager: workers,
        workspaceReaperCooldownDays: 0,
      }).sweepTerminalWorkspaces(100);
      const [row] = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, workspace!.id));
      expect(row).toMatchObject({
        status: "archived",
        metadata: {
          workspaceProviderRemoved: true,
          workspaceProviderRemoval: null,
        },
      });
      expect(
        f.calls.filter((call) => call.operation.kind === "remove"),
      ).toHaveLength(2);
    });
    it("keeps restoration intent durable when reopening loses the provider response", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      await db
        .update(executionWorkspaces)
        .set({ status: "archived", closedAt: new Date() })
        .where(eq(executionWorkspaces.id, workspace!.id));
      await removePluginWorkspace(db, f.workers, workspace!, "a".repeat(40));
      f.lose();
      const request = {
        workspaceId: workspace!.id,
        issue: {
          id: f.issueId,
          companyId: f.companyId,
          projectId: f.input.projectId,
        },
        actor: { actorType: "user", agentId: null },
        authorizationActor: {
          type: "board" as const,
          source: "local_implicit" as const,
          isInstanceAdmin: true,
        },
      };
      const svc = executionWorkspaceService(db, {
        pluginWorkerManager: f.workers,
      });
      expect(
        await svc.reopenClosedIsolatedExecutionWorkspaceForIssue(request),
      ).toMatchObject({ ok: false, code: "rebuild_failed" });
      const [pending] = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, workspace!.id));
      expect(pending.metadata).toMatchObject({
        workspaceProviderRemoved: false,
        workspaceProviderRestoration: { generation: 1 },
      });
      await expect(
        projectService(db).updateWorkspace(
          f.input.projectId,
          f.input.projectWorkspaceId,
          { repoRef: "new" },
        ),
      ).rejects.toThrow("storage owner");
      expect(
        await svc.reopenClosedIsolatedExecutionWorkspaceForIssue(request),
      ).toMatchObject({ ok: true, generation: 1 });
    });
    it("rejects unsupported provider modes before making a reservation", async () => {
      const f = await fixture();
      await expect(
        preparePluginWorkspace(db, f.workers, {
          ...f.input,
          mode: "shared_workspace",
          strategy: "project_primary",
        }),
      ).rejects.toThrow("does not support");
      const [task] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issueId));
      expect(task.executionWorkspaceId).toBeNull();
      expect(f.calls).toHaveLength(0);
    });
    it("checks the saved mode when project defaults change on a reused workspace", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      const reused = await preparePluginWorkspace(db, f.workers, {
        ...f.input,
        existingWorkspaceId: workspace!.id,
        mode: "shared_workspace",
        strategy: "project_primary",
      });
      expect(reused!.id).toBe(workspace!.id);
      expect(f.calls.at(-1).operation).toMatchObject({
        mode: "isolated_workspace",
        strategy: "git_worktree",
      });
    });
    it("preserves a saved null branch when reuse defaults change", async () => {
      const f = await fixture();
      const [plugin] = await db
        .select()
        .from(plugins)
        .where(eq(plugins.id, f.pluginId));
      await db
        .update(plugins)
        .set({
          manifestJson: {
            ...plugin.manifestJson,
            workspaceProvider: {
              modes: ["shared_workspace", "isolated_workspace"],
              strategies: ["project_primary", "git_worktree"],
            },
          },
        })
        .where(eq(plugins.id, f.pluginId));
      const workspace = await preparePluginWorkspace(db, f.workers, {
        ...f.input,
        mode: "shared_workspace",
        strategy: "project_primary",
        branchName: null,
      });
      expect(workspace!.branchName).toBeNull();
      await preparePluginWorkspace(db, f.workers, {
        ...f.input,
        existingWorkspaceId: workspace!.id,
        branchName: "new-default",
      });
      expect(f.calls.at(-1).operation).toMatchObject({
        mode: "shared_workspace",
        strategy: "project_primary",
        branchName: null,
      });
    });
    it("does not share inspection results across opaque references owned by different providers", async () => {
      const first = await fixture(),
        second = await fixture(first.companyId);
      for (const f of [first, second]) {
        const workers = {
          getWorker: f.workers.getWorker.bind(f.workers),
          call: async (...args: any[]) => {
            const result = await (f.workers.call as any)(...args);
            return result.kind === "prepared"
              ? {
                  ...result,
                  binding: { ...result.binding, workspaceRef: "opaque" },
                }
              : result;
          },
        } as unknown as WorkspaceWorkers;
        await preparePluginWorkspace(db, workers, f.input);
        await db
          .update(issues)
          .set({ status: "done", completedAt: new Date() })
          .where(eq(issues.id, f.issueId));
        await db
          .update(heartbeatRuns)
          .set({ status: "cancelled" })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      second.dirty();
      const workers = {
        getWorker: (id: string) =>
          [first.pluginId, second.pluginId].includes(id)
            ? { supportedMethods: ["workspaceOperation"] }
            : undefined,
        call: (id: string, ...args: any[]) =>
          (
            (id === first.pluginId ? first.workers : second.workers).call as any
          )(id, ...args),
      } as unknown as WorkspaceWorkers;
      await executionWorkspaceService(db, {
        pluginWorkerManager: workers,
        workspaceReaperCooldownDays: 0,
      }).sweepTerminalWorkspaces(100);
      const [task] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, second.issueId));
      const [retained] = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
      expect(retained.status).toBe("active");
      expect(
        second.calls.some((call) => call.operation.kind === "inspect"),
      ).toBe(true);
    });
    it("never removes a checkout with local-only changes", async () => {
      const f = await fixture();
      const workspace = await preparePluginWorkspace(db, f.workers, f.input);
      f.dirty();
      await expect(
        removePluginWorkspace(db, f.workers, workspace!, "a".repeat(40)),
      ).rejects.toThrow("local changes");
      expect(f.calls.some((call) => call.operation.kind === "remove")).toBe(
        false,
      );
    });
  },
);
