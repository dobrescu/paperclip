# Installed agent resources on Runner

An execution driver can set `persistentAgentHome: true`. This mode uses the
runtime and files installed on the Runner host. It does not copy a home from
Core. Existing execution drivers keep their current behavior when they omit
this setting.

## Host configuration

Set `AGENT_HOME` to the installed agent directory. Set
`PAPERCLIP_WORKSPACE_CWD` to the task workspace. The Runner can also read these
locations from `PAPERCLIP_LAUNCHER_CONTEXT_PATH`:

```json
{
  "schema": "paperclip.launcher.context.v2",
  "resourcesRoot": "<installed agent directory>",
  "workspace": "<task workspace>"
}
```

The paths must exist on Runner. Core does not need those paths to exist.
Codex uses its installed executable and account. OpenCode and ACPX use their
installed launch profiles. Keep profile qualification gates in place.

## PRP inputs

For `run.prepare` and `run.attach`, the transport sets
`provider.runtimeOwnership` to `agent_home`. Instruction and skill references
are relative to the installed home. Runner resolves the workspace, instruction
entry, skill roots, and executable profile before it starts the provider.

Runner rejects a controller-supplied command, arguments, or runtime directory
in this mode. It rejects resource paths that escape the installed home. It
checks project authentication overrides before provider startup and recovery.
Ambient environment variables alone do not enable this mode.

For an explicit skill input, `turn.start` carries `runtimeOwnership: agent_home`
and the assigned entry `skills/<name>/SKILL.md`. Runner resolves the local path.
OpenCode receives the selected permission mode. Provider bridges preserve the
Core names for assigned-tool search and invocation.

## Session recovery

Installed instructions can change between runs. Runner can attach a retained
provider session to the next run with the new instructions. It rejects a change
to pinned provider policy, runtime ownership, or instructions within one run.

`runner.suspend` can request `includeStateReceipt: true`. Runner returns a state
receipt only after it saves the suspended state. A later `run.attach` can use
`paperclipNextAuthority.connection.mode: retain` to retain its installed
connection settings while it changes run authority.

A process owner can return `restart: null` to prohibit an implicit replacement.
An external connection requires an explicit process owner. The structured
`nativeRunner` launch fields supply the ticket, identity, artifact, and limits
without parsing command arguments.

The process owner must still prove termination before it replaces a task or
reuses execution authority. Installed files do not prove that a prior process
has stopped.

This change does not enable a Core plugin execution path. That integration
requires the lease-scoped task API and a separate native execution change.
