use super::*;
use crate::{audit, commands::update_cache};
use chrono::{Duration, Local};
use std::{fs, path::PathBuf, time::SystemTime};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("cc-bridge-storage-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn paths(&self) -> StoragePaths {
        StoragePaths {
            data: self.0.clone(),
            webview: None,
            backup: self.0.join("backups"),
            version: semver::Version::new(3, 4, 0),
            generation: Uuid::new_v4(),
            audit_days: 30,
            journal_days: 30,
        }
    }

    fn write(&self, name: &str, body: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    fn old(&self, name: &str) -> PathBuf {
        let path = self.write(name, b"old data");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - std::time::Duration::from_secs(8 * 86_400))
            .unwrap();
        path
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn audit_line(timestamp: chrono::DateTime<Local>) -> String {
    let mut line = audit::new_entry(
        "storage-test",
        "{}",
        true,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    line.timestamp = timestamp.to_rfc3339();
    format!("{}\n", serde_json::to_string(&line).unwrap())
}

#[test]
fn manual_plan_counts_bytes_and_only_removes_selected_expired_files() {
    let workspace = Workspace::new();
    let paths = workspace.paths();
    let expired = audit_line(Local::now() - Duration::days(45));
    let recent = audit_line(Local::now());
    let audit = workspace.write(
        "audit.log",
        format!("{expired}{recent}unparseable\r\n").as_bytes(),
    );
    let journal = workspace.write("journal/changes-20200101.jsonl", b"old journal");
    let relay = workspace.write("relay/relay-20200101.jsonl", b"old relay");
    let backup = workspace.write("backups/important.bak", b"restore point");
    let resume = workspace.write("update-package.part", b"pending download");
    let inventory = inspect(&paths);
    let plan = plan_cleanup(&paths);
    assert_eq!(
        inventory
            .groups
            .iter()
            .find(|group| group.group == StorageGroup::Backup)
            .unwrap()
            .used_bytes,
        13
    );
    assert_eq!(plan.items().len(), 3);
    assert!(!plan.accepts(Uuid::new_v4(), &[CleanupKind::Audit]));
    assert!(!plan.accepts(plan.token, &[CleanupKind::Temp]));
    assert!(plan.accepts(plan.token, &[CleanupKind::Audit, CleanupKind::Relay]));
    let run = plan.execute(
        &paths,
        CleanupSource::Manual,
        &[CleanupKind::Audit, CleanupKind::Relay],
    );
    assert_eq!(run.removed_count, 2);
    assert_eq!(run.freed_bytes, expired.len() as u64 + 9);
    assert_eq!(
        fs::read_to_string(audit).unwrap(),
        format!("{recent}unparseable\r\n")
    );
    assert!(!relay.exists());
    assert!(journal.exists() && backup.exists() && resume.exists());
}

#[test]
fn app_data_root_used_as_backup_directory_is_counted_once() {
    let workspace = Workspace::new();
    let mut paths = workspace.paths();
    paths.backup = paths.data.join(".");
    workspace.write("manual.bak", b"backup");
    workspace.write("config.json", b"settings");

    let groups = inspect(&paths).groups;
    assert_eq!(
        groups
            .iter()
            .find(|row| row.group == StorageGroup::Backup)
            .unwrap()
            .used_bytes,
        6
    );
    assert_eq!(
        groups
            .iter()
            .find(|row| row.group == StorageGroup::Data)
            .unwrap()
            .used_bytes,
        8
    );
}

#[test]
fn plan_preserves_a_replaced_file_and_current_process_scratch() {
    let workspace = Workspace::new();
    let paths = workspace.paths();
    let relay = workspace.write("relay/relay-20200312.jsonl", b"old");
    let old_scratch = workspace.old(&format!(
        "{SCRATCH_FOLDER}/{}",
        scratch_name(Uuid::new_v4(), "png")
    ));
    let active_scratch = workspace.old(&format!(
        "{SCRATCH_FOLDER}/{}",
        scratch_name(paths.generation, "png")
    ));
    let unknown_scratch = workspace.old(&format!("{SCRATCH_FOLDER}/unsaved.png"));
    let part = workspace.old("update-package.part");
    let plan = plan_cleanup(&paths);
    fs::write(&relay, b"this copy was replaced after preview").unwrap();
    let run = plan.execute(
        &paths,
        CleanupSource::Manual,
        &[CleanupKind::Relay, CleanupKind::Temp],
    );
    assert_eq!(run.removed_count, 1);
    assert_eq!(run.skipped[0].kind, CleanupKind::Relay);
    assert_eq!(run.skipped[0].count, 1);
    assert!(relay.exists() && active_scratch.exists() && unknown_scratch.exists() && part.exists());
    assert!(!old_scratch.exists());
}

#[test]
fn audit_preview_rejects_replacement_with_equal_length() {
    let workspace = Workspace::new();
    let paths = workspace.paths();
    let expired = audit_line(Local::now() - Duration::days(45));
    let log = workspace.write("audit.log", expired.as_bytes());
    let plan = plan_cleanup(&paths);
    let replaced = expired.replace("storage-test", "another-tool");
    assert_ne!(expired, replaced);
    assert_eq!(expired.len(), replaced.len());
    fs::write(&log, &replaced).unwrap();

    let run = plan.execute(&paths, CleanupSource::Manual, &[CleanupKind::Audit]);
    assert_eq!(run.removed_count, 0);
    assert_eq!(run.skipped[0].kind, CleanupKind::Audit);
    assert_eq!(fs::read_to_string(log).unwrap(), replaced);
}

#[test]
fn audit_preview_still_allows_recent_appends() {
    let workspace = Workspace::new();
    let paths = workspace.paths();
    let expired = audit_line(Local::now() - Duration::days(45));
    let log = workspace.write("audit.log", expired.as_bytes());
    let plan = plan_cleanup(&paths);
    let recent = audit_line(Local::now());
    std::io::Write::write_all(
        &mut fs::OpenOptions::new().append(true).open(&log).unwrap(),
        recent.as_bytes(),
    )
    .unwrap();

    let run = plan.execute(&paths, CleanupSource::Manual, &[CleanupKind::Audit]);
    assert_eq!(run.removed_count, 1);
    assert!(run.skipped.is_empty());
    assert_eq!(fs::read_to_string(log).unwrap(), recent);
}

#[test]
fn changing_audit_to_forever_after_preview_preserves_records() {
    let workspace = Workspace::new();
    let mut paths = workspace.paths();
    let log = workspace.write(
        "audit.log",
        audit_line(Local::now() - Duration::days(45)).as_bytes(),
    );
    let plan = plan_cleanup(&paths);
    paths.audit_days = 0;
    let result = plan.execute(&paths, CleanupSource::Manual, &[CleanupKind::Audit]);
    assert_eq!(result.removed_count, 0);
    assert_eq!(result.skipped[0].kind, CleanupKind::Audit);
    assert!(fs::metadata(log).unwrap().len() > 0);
    assert!(plan_cleanup(&paths).items().is_empty());
}

#[test]
fn installer_cache_requires_a_matching_obsolete_version_and_leaves_resume_data() {
    let workspace = Workspace::new();
    let paths = workspace.paths();
    let package = update_cache::package_path(&paths.data);
    update_cache::persist_package(&package, "3.4.1", "signature", b"download").unwrap();
    let manifest = workspace.write(
        "update-package.manifest.json",
        br#"{"version":"3.4.0","signature":"signature"}"#,
    );
    let part = workspace.old("update-package.part");
    assert!(
        plan_cleanup(&paths).items().is_empty(),
        "wrong sidecar must not make a newer package eligible"
    );
    update_cache::persist_package(&package, "3.4.0", "signature", b"download").unwrap();
    let plan = plan_cleanup(&paths);
    assert_eq!(plan.items()[0].kind, CleanupKind::Update);
    let run = plan.execute(&paths, CleanupSource::Scheduled, &[CleanupKind::Update]);
    assert_eq!(run.removed_count, 2);
    assert!(part.exists());
    assert!(!package.exists() && !manifest.exists());
}

#[test]
fn policy_and_history_survive_restart_and_keep_only_recent_results() {
    let workspace = Workspace::new();
    let db = crate::db::init_database(&workspace.0).unwrap();
    let mut record = Persisted::load(&db).unwrap();
    assert!(record.policy.auto_clean);
    record.policy.daily_time = "03:15".into();
    record.disk_alert_at = Some(42);
    for i in 0..40 {
        let mut run = CleanupRun::new(CleanupSource::Scheduled);
        run.freed_bytes = i;
        record.record(run);
    }
    record.save(&db).unwrap();
    drop(db);
    let db = crate::db::init_database(&workspace.0).unwrap();
    let record = Persisted::load(&db).unwrap();
    assert_eq!(record.policy.daily_time, "03:15");
    assert_eq!(record.history.len(), 30);
    assert_eq!(record.history[0].freed_bytes, 39);
    assert!(!alert_due(record.disk_alert_at, 42 + 86_399));
    assert!(alert_due(record.disk_alert_at, 42 + 86_400));
}

#[test]
fn schedule_catches_up_to_one_latest_slot_and_honors_disable() {
    use chrono::{TimeZone, Timelike};
    let time = Local
        .with_ymd_and_hms(2026, 11, 27, 8, 59, 0)
        .single()
        .unwrap();
    let mut policy = StoragePolicy::default();
    let previous = policy.scheduled_slot(time).unwrap();
    assert_eq!(previous.date(), time.date_naive().pred_opt().unwrap());
    let current = policy.scheduled_slot(time + Duration::minutes(2)).unwrap();
    assert_eq!(current.date(), time.date_naive());
    assert_eq!(current.hour(), 9);
    policy.auto_clean = false;
    assert!(policy.scheduled_slot(time).is_none());
    policy.daily_time = "29:00".into();
    assert!(policy.validate().is_err());
}

#[cfg(unix)]
#[test]
fn linked_dated_logs_and_replaced_directories_are_never_cleanup_targets() {
    use std::os::unix::fs::symlink;
    let workspace = Workspace::new();
    let separate = Workspace::new();
    let paths = workspace.paths();
    let data = separate.write("relay-20200101.jsonl", b"unmanaged file");
    let managed = workspace.write("relay/relay-20200101.jsonl", b"old log");
    let plan = plan_cleanup(&paths);
    fs::remove_file(managed).unwrap();
    fs::remove_dir(paths.data.join("relay")).unwrap();
    symlink(&separate.0, paths.data.join("relay")).unwrap();
    let run = plan.execute(&paths, CleanupSource::Manual, &[CleanupKind::Relay]);
    assert_eq!(run.removed_count, 0);
    assert!(data.exists());
}
