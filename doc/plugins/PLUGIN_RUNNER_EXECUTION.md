# Plugin-provided Runner execution

## Contract sources

- [Operations, results, and validation](../../packages/plugins/sdk/src/environment-tasks.ts)
- [Lease and worker types](../../packages/plugins/sdk/src/protocol.ts)
- [Shared execution driver](../../packages/paperclip-runner/src/control-plane/runner-execution-driver.ts)

```ts
import type {
  PluginEnvironmentTaskParams as Params,
} from "@paperclipai/plugin-sdk";

```

| Owner | Responsibility |
| --- | --- |
| Core | Company and project authorization; execution identity; tool authority; PRP journal |
| Plugin | Task identity; installed runtime and account; process lifecycle; authenticated WSS endpoint |
| Runner | Provider execution; local resource paths; PRP session state |
| Separate storage workflow | Resource installation; file upload and download; backup |

The task API has no shell, file-copy, path-discovery, or resource-sync operation.
The plugin can use an HTTP Launcher API, a process API, or another implementation.
Core uses the same task contract in each case.

## Enable the driver

1. Add these declarations to the plugin manifest.

```json
{
  "capabilities": ["environment.drivers.register"],
  "environmentDrivers": [{ "driverKey": "runner", "supportsTasks": true }]
}
```

2. Implement these worker hooks.

```ts
onEnvironmentAcquireLease
onEnvironmentTask
onEnvironmentReleaseLease
onEnvironmentDestroyLease

// Task execution does not require these hooks:
onEnvironmentExecute
onEnvironmentRealizeWorkspace
```

3. Select the saved environment for an agent with `adapterType: "paperclip_runner"`.

```ts
const support = {
  lifecycle: "per_turn",
  providers: ["codex", "opencode", "acpx"],
  setupVerification: "Runner hello probe",
  warmProcessRetention: false,
  workspaceFreeDot: false,
};
```

OpenCode and ACPX require qualified launch profiles on the Runner host.
Use a Runner build that supports the following PRP inputs.

```ts
const requiredRunnerInputs = {
  "provider.runtimeOwnership": "agent_home",
  "provider.opencodePermissionMode": "allow | ask | deny",
  "runner.suspend.includeStateReceipt": true,
  "run.attach.paperclipNextAuthority.connection.mode": "retain",
};
```

## Prepare the environment

1. Install the Runner and the selected provider runtime.
2. Prepare the agent home, project workspace, and selected account before task submission.
3. Keep file transfer outside `onEnvironmentTask`.
4. Keep credential refresh and backup outside the per-run execution workflow.

```ts
// Runner-local configuration. Core does not supply these paths.
const environment = {
  AGENT_HOME: "<installed agent home>",
  PAPERCLIP_WORKSPACE_CWD: "<installed project workspace>",
};

// Alternative: a Launcher-owned context file on the Runner host.
const launcherEnvironment = {
  PAPERCLIP_LAUNCHER_CONTEXT_PATH: "<local context file>",
};
```

```json
{
  "schema": "paperclip.launcher.context.v2",
  "resourcesRoot": "<installed agent home>",
  "workspace": "<installed project workspace>"
}
```

The Runner resolves instruction entries and assigned skill paths inside the installed agent home. It resolves `codex` through its local `PATH`. The installed launch profiles supply other provider executables.

```ts
const executionAuthority = {
  permissions: "Core -> PRP -> provider",
  assignedMcpTools: "provider -> PRP -> Core gateway",
  installedInstructions: "Runner reads on each new run",
  installedSkills: "Runner resolves -> provider",
  installedCodexAccount: "CODEX_HOME/auth.json or HOME/.codex/auth.json",
};
```

ACPX uses its existing private credential isolation for an installed Codex account. It reads the local account file when no explicit API key is configured. It does not send the account file to Core. Credential refresh remains part of the separate account workflow.

Keep Runner state and credential stores outside the writable agent home. Keep the selected model, permission policy, and assigned resource identities unchanged when you resume a provider session. Installed instruction text can change between runs.

A persistent computer keeps its agent home between runs. Core does not create a per-run copy or collect it after execution. Existing built-in ephemeral sandbox drivers keep their materialization and synchronization behavior.

## Acquire the task lease

1. Create an opaque task ID before submission.
2. Return that ID as `providerLeaseId`.
3. Keep the same ID after an ambiguous submission result.

```ts
const lease = {
  providerLeaseId: "attempt-opaque-id",
  metadata: {}, // No credentials.
};
```

```ts
// Core supplies this scope from saved records.
const params: Pick<Params,
  "companyId" | "environmentId" | "runId" | "agentId" | "projectIds" | "taskId"
> = {
  companyId: "<authorized company>",
  environmentId: "<saved environment>",
  runId: "<active run>",
  agentId: "<agent>",
  projectIds: ["<authorized project UUID>"],
  taskId: lease.providerLeaseId,
};
```

During setup, Core uses a private, expiring probe identity. During cleanup, `environmentId`, `runId`, and `agentId` can be `null` after record deletion. The saved lease retains the plugin identity.

## Native launch and completion

Use the [task API reference](PLUGIN_ENVIRONMENT_TASKS.md) for the operation
schemas, response rules, credential transfer, and cleanup behavior. Use the
[installed-home contract](../runner-installed-agent-home.md) for Runner path
resolution and provider session rules.

Core reads `describe` before launch. It binds the bootstrap ticket to the
reported Runner version and digest. PRP verifies the running artifact.

Core sends the PRP identity, launch limits, authorized projects, and selected
account through `submit`. An accepted result confirms submission. Core then
connects to the authenticated WSS endpoint and verifies PRP readiness and provider
authentication. The plugin owns endpoint acquisition and the internal address.

Core supports direct Codex and Claude account transfer. Other managed providers
need a dedicated credential projection. Do not save transient credentials in
lease metadata, task journals, logs, or errors.

Core stops the task and checks `executionStopped` before it saves credential
results and completes the task. A terminal phase alone does not prove that all
processes stopped. Keep retained session files when task grants are released.

## Session continuity

```text
Core journal                         Provider storage
------------                         ----------------
PRP identity and command results     Runner state and provider session files
        |                                      |
        +---- authenticated runner.suspend ----+
        +---- status.executionStopped ---------+
        +---- status.sessionStateAvailable ----+
        |
        +---- next submit.resumeFrom = prior task ID
        +---- PRP session identity verification
        +---- run.attach to the new run authority
```

1. Resume only the task named by `resumeFrom`.
2. Verify the retained account, session, and workspace before launch.
3. Fail closed if retained state is missing or incompatible.
4. Keep the retained files on the provider.

Core checks the prior run, agent, workspace, environment, pinned driver, and termination evidence before it authorizes reuse.
For recovery on the same run, Core first stops and releases the old tasks.
It checks each old lease's termination receipt before it allocates a replacement.
The new task uses `resumeFrom` to retain the saved PRP identity.
A failed stop prevents replacement. The Runner keeps the provider connection during the authenticated run-authority change. A pending, unproved transition blocks ordinary execution.

## Setup verification

```text
expiring probe lease
  -> describe
  -> submit with a bounded lifetime
  -> authenticated WSS + PRP
  -> provider hello + selected model
  -> suspension + confirmed process stop
  -> complete
```

The Runner checks local project authentication overrides before provider startup. Core does not run a shell probe or inspect guest configuration files.

## Verification

- [Lease, RPC, and cleanup integration](../../server/src/__tests__/plugin-runner-task.integration.test.ts)
- [Real Runner setup and retained-home tests](../../server/src/services/native-runtime/plugin-runner-probe.test.ts)
- [Durable credential transfer](../../server/src/__tests__/plugin-task-credential-writeback.test.ts)
- [Task ownership and cancellation](../../server/src/services/native-runtime/plugin-runner-task.test.ts)
- [Persistent runtime resource resolution](../../packages/paperclip-runner/runner/crates/runner-core/src/persistent_agent_runtime.rs)

The real Runner fixture uses a synthetic provider and local sockets. It does not certify a deployed plugin, live provider credentials, or a production WSS proxy.
