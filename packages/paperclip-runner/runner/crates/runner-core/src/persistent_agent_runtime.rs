//! Resolve installed runtime resources on the Runner. Core never supplies guest paths.
use crate::durable::{Command, DurableRunnerConfig, DurableRunnerError};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

fn invalid() -> DurableRunnerError {
    DurableRunnerError::invalid("persistent agent runtime is unavailable or invalid")
}

fn read_json(path: &Path) -> Result<Value, DurableRunnerError> {
    let bytes = read_bounded(path)?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, DurableRunnerError> {
    use std::io::Read;
    #[cfg(unix)]
    let file = std::fs::File::from(
        rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    #[cfg(not(unix))]
    let file = std::fs::File::open(path).map_err(|_| invalid())?;
    let info = file.metadata().map_err(|_| invalid())?;
    if !info.is_file() || info.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > 1024 * 1024 {
        return Err(invalid());
    }
    Ok(bytes)
}

fn beneath(root: &Path, relative: &str) -> Result<PathBuf, DurableRunnerError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(invalid());
    }
    let resolved = root.join(path).canonicalize().map_err(|_| invalid())?;
    if !resolved.starts_with(root) {
        return Err(invalid());
    }
    Ok(resolved)
}

pub(crate) fn resolve_command(
    command: &Command,
    config: &DurableRunnerConfig,
) -> Result<Command, DurableRunnerError> {
    let installed = command
        .payload
        .pointer("/provider/runtimeOwnership")
        .or_else(|| command.payload.get("runtimeOwnership"));
    if installed.and_then(Value::as_str) != Some("agent_home") {
        return Ok(command.clone());
    }
    let (home, workspace) = installed_paths()?;
    let resolved = resolve(command, config, &home, &workspace)?;
    if matches!(command.command_type.as_str(), "run.prepare" | "run.attach") {
        retain_runtime(config, &home, &workspace)?;
    }
    Ok(resolved)
}

// Only an authenticated agent-home command enables this mode. Ambient env is insufficient.
fn retain_runtime(
    config: &DurableRunnerConfig,
    home: &Path,
    workspace: &Path,
) -> Result<(), DurableRunnerError> {
    use std::io::Write;
    let path = config.state_dir.join("agent-home-runtime.json");
    let value =
        json!({"schema": "paperclip.runner.agent-home.v1", "home": home, "workspace": workspace});
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            return if read_json(&path)? == value {
                Ok(())
            } else {
                Err(invalid())
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(invalid()),
    }
    let (temporary, mut file) = crate::durable::create_private_temporary_file(&path)?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(value.to_string().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)?;
        #[cfg(unix)]
        std::fs::File::open(&config.state_dir)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
        return Err(invalid());
    }
    Ok(())
}

// Check before recovery can restore a provider from its retained state.
pub(crate) fn check_installed_environment(
    config: &DurableRunnerConfig,
) -> Result<(), DurableRunnerError> {
    let path = config.state_dir.join("agent-home-runtime.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(invalid()),
        Ok(_) => {}
    }
    let (home, workspace) = installed_paths()?;
    retain_runtime(config, &home, &workspace)?;
    check_project_auth(&workspace, &home)
}

fn installed_paths() -> Result<(PathBuf, PathBuf), DurableRunnerError> {
    let context = std::env::var_os("PAPERCLIP_LAUNCHER_CONTEXT_PATH")
        .map(|path| read_json(Path::new(&path)))
        .transpose()?
        .unwrap_or(Value::Null);
    if !context.is_null()
        && context.get("schema").and_then(Value::as_str) != Some("paperclip.launcher.context.v2")
    {
        return Err(invalid());
    }
    let home = std::env::var_os("AGENT_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            context
                .get("resourcesRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .ok_or_else(invalid)?
        .canonicalize()
        .map_err(|_| invalid())?;
    let workspace = context
        .get("workspace")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("PAPERCLIP_WORKSPACE_CWD").map(PathBuf::from))
        .ok_or_else(invalid)?
        .canonicalize()
        .map_err(|_| invalid())?;
    Ok((home, workspace))
}

// Project files must not replace the account installed for this task.
fn check_project_auth(workspace: &Path, home: &Path) -> Result<(), DurableRunnerError> {
    for parent in workspace.ancestors() {
        if parent == home {
            break;
        }
        for relative in [
            ".codex/config.toml",
            ".claude/settings.json",
            ".claude/settings.local.json",
        ] {
            let path = parent.join(relative);
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(invalid()),
                Ok(_) => {}
            }
            let bytes = read_bounded(&path)?;
            let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
            if [
                "apiKeyHelper",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "OPENAI_API_KEY",
                "model_provider",
                "env_key",
                "experimental_bearer_token",
                "cli_auth_credentials_store",
            ]
            .iter()
            .any(|key| text.contains(key))
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

pub(crate) fn resolve(
    command: &Command,
    config: &DurableRunnerConfig,
    home: &Path,
    workspace: &Path,
) -> Result<Command, DurableRunnerError> {
    if !home.is_dir() || !workspace.is_dir() {
        return Err(invalid());
    }
    check_project_auth(workspace, home)?;
    let mut command = command.clone();
    if command.command_type == "turn.start" {
        command
            .payload
            .as_object_mut()
            .ok_or_else(invalid)?
            .remove("runtimeOwnership");
        if let Some(skills) = command
            .payload
            .get_mut("skills")
            .and_then(Value::as_array_mut)
        {
            for skill in skills {
                let name = skill
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?;
                if name.is_empty()
                    || !name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                {
                    return Err(invalid());
                }
                let relative = format!("skills/{name}/SKILL.md");
                if skill.get("path").and_then(Value::as_str) != Some(&relative) {
                    return Err(invalid());
                }
                skill["path"] = json!(beneath(home, &relative)?);
            }
        }
        return Ok(command);
    }
    let provider = command
        .payload
        .get_mut("provider")
        .and_then(Value::as_object_mut)
        .ok_or_else(invalid)?;
    // Commands and runtime locations are installed authority, never controller overrides.
    if [
        "command",
        "args",
        "sidecarCommand",
        "sidecarArgs",
        "runtimeDirectory",
        "cwd",
    ]
    .iter()
    .any(|key| provider.contains_key(*key))
    {
        return Err(invalid());
    }
    provider.insert("cwd".into(), json!(workspace));
    let mut instructions = provider
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if let Some(context) = provider
        .get_mut("runtimeContext")
        .filter(|value| !value.is_null())
    {
        let entry = context
            .pointer("/instructions/entryPath")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .to_owned();
        let content = read_bounded(&beneath(home, &entry)?)?;
        instructions.push_str("\n\n");
        instructions.push_str(std::str::from_utf8(&content).map_err(|_| invalid())?);
        instructions.push_str("\n\nYour persistent agent directory is available through AGENT_HOME. Changes remain on this computer. Write task deliverables in the task workspace.");
        context["instructions"]["bundle"]["rootPath"] = json!(home);
        context["instructions"]["workingCopy"] =
            json!({"kind": "agent_files", "rootPath": home, "entryPath": entry});
        if let Some(skills) = context.get_mut("skills").and_then(Value::as_array_mut) {
            for skill in skills {
                let relative = skill
                    .pointer("/bundle/rootPath")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?;
                skill["bundle"]["rootPath"] = json!(beneath(home, relative)?);
            }
        }
    }
    provider.insert("instructions".into(), json!(instructions));
    match provider.get("kind").and_then(Value::as_str) {
        Some("codex") => {
            provider.insert("command".into(), json!("codex"));
            provider.insert(
                "args".into(),
                json!([
                    "app-server",
                    "-c",
                    format!("shell_environment_policy.set.AGENT_HOME={}", json!(home))
                ]),
            );
        }
        Some("opencode") => {
            let profile = config
                .opencode_launch_profile
                .as_ref()
                .ok_or_else(invalid)?;
            provider.insert("command".into(), json!(profile.command.path));
            provider.insert("args".into(), json!([profile.proxy_script.path]));
            provider.insert(
                "runtimeDirectory".into(),
                json!(config.state_dir.join("opencode")),
            );
        }
        Some("acpx") => {
            let profile = config.acpx_launch_profile.as_ref().ok_or_else(invalid)?;
            provider.insert("sidecarCommand".into(), json!(profile.command));
            provider.insert("sidecarArgs".into(), json!(profile.args));
            provider.insert(
                "runtimeDirectory".into(),
                json!(config.state_dir.join("acpx")),
            );
        }
        _ => return Err(invalid()),
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn config(home: &Path) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "listen://0.0.0.0:9000/connect".into(),
            ca_bundle_path: None,
            state_dir: home.join("state"),
            runner_instance_id: "runner".into(),
            environment_lease_id: "lease".into(),
            run_id: "run".into(),
            normalized_session_id: "session".into(),
            turn_id: "turn".into(),
            item_id: "item".into(),
            runner_version: "fixture".into(),
            runner_digest: format!("sha256:{}", "a".repeat(64)),
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            max_outbox_bytes: 262144,
            p0_reserve_bytes: 65536,
            max_frame_bytes: 65536,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::from_secs(1),
        }
    }
    fn command(payload: Value) -> Command {
        Command {
            schema: "paperclip.prp.command.v3".into(),
            command_id: "command".into(),
            controller_seq: 1,
            command_type: "run.prepare".into(),
            issued_at: "2026-01-01T00:00:00Z".into(),
            deadline_at: None,
            precondition: None,
            payload,
        }
    }
    #[test]
    fn installed_home_supplies_instructions_and_paths_without_materialization() {
        let root =
            std::env::temp_dir().join(format!("persistent-runtime-{}", uuid::Uuid::new_v4()));
        let home = root.join("arbitrary-agent-home");
        let workspace = root.join("separate-project");
        std::fs::create_dir_all(home.join("skills/example")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(home.join("AGENTS.md"), "Installed instructions").unwrap();
        std::fs::write(home.join("skills/example/SKILL.md"), "Installed skill").unwrap();
        let home = home.canonicalize().unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let payload = json!({"provider": {"kind": "codex", "runtimeOwnership": "agent_home", "instructions": "Task policy",
            "runtimeContext": {"instructions": {"entryPath": "AGENTS.md", "bundle": {"rootPath": "."}},
                "skills": [{"bundle": {"rootPath": "skills/example"}}]}}});
        let resolved =
            resolve(&command(payload.clone()), &config(&home), &home, &workspace).unwrap();
        assert_eq!(resolved.payload["provider"]["command"], "codex");
        assert_eq!(resolved.payload["provider"]["cwd"], json!(workspace));
        assert!(resolved.payload["provider"]["instructions"]
            .as_str()
            .unwrap()
            .contains("Installed instructions"));
        assert_eq!(
            std::fs::read_to_string(home.join("AGENTS.md")).unwrap(),
            "Installed instructions"
        );
        assert!(!home.join("state").exists());
        let runtime = config(&home);
        assert!(check_installed_environment(&runtime).is_ok());
        std::fs::create_dir_all(&runtime.state_dir).unwrap();
        retain_runtime(&runtime, &home, &workspace).unwrap();
        retain_runtime(&runtime, &home, &workspace).unwrap();
        assert!(retain_runtime(&runtime, &home, &home).is_err());
        for field in [
            "command",
            "args",
            "sidecarCommand",
            "runtimeDirectory",
            "cwd",
        ] {
            let mut invalid = payload.clone();
            invalid["provider"][field] = json!("controller-value");
            assert!(resolve(&command(invalid), &config(&home), &home, &workspace).is_err());
        }
        let mut skill = command(
            json!({"runtimeOwnership": "agent_home", "skills": [{"type": "skill", "name": "example", "path": "skills/example/SKILL.md"}]}),
        );
        skill.command_type = "turn.start".into();
        assert_eq!(
            resolve(&skill, &config(&home), &home, &workspace)
                .unwrap()
                .payload["skills"][0]["path"],
            json!(home.join("skills/example/SKILL.md"))
        );
        skill.payload["skills"][0]["path"] = json!("../private");
        assert!(resolve(&skill, &config(&home), &home, &workspace).is_err());
        assert!(beneath(&home, "../separate-project").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&workspace, home.join("outside")).unwrap();
            assert!(beneath(&home, "outside").is_err());
            std::os::unix::fs::symlink(home.join("AGENTS.md"), home.join("linked")).unwrap();
            assert!(read_bounded(&home.join("linked")).is_err());
        }
        std::fs::create_dir_all(workspace.join(".codex")).unwrap();
        std::fs::write(
            workspace.join(".codex/config.toml"),
            "model_provider = 'another-account'",
        )
        .unwrap();
        assert!(resolve(&command(payload), &config(&home), &home, &workspace).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
