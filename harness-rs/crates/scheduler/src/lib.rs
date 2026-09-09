//! 定时任务：cron 表达式 + SQLite 持久化 + tokio 调度循环。
//!
//! 移动端语义降级（iOS 补跑）在宿主层处理；harness 保持完整 cron 语义。

use anyhow::{Context, Result};
use chrono::{DateTime, Local, LocalResult, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use worldbase_memory::Store;
pub use worldbase_protocol::types::{
    ScheduleEntry, ScheduledTaskRetryPolicy, ScheduledTaskSchedule,
};

/// 到期回调：由 core 注入（把 task 文本交给 agent 运行）。
pub type DueFuture = Pin<Box<dyn Future<Output = Result<()>> + Send>>;
pub type OnDue = Arc<dyn Fn(ScheduleEntry) -> DueFuture + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ScheduledTaskRequest {
    pub title: String,
    pub prompt: String,
    pub enabled: bool,
    pub schedule: ScheduledTaskSchedule,
    pub selected_skill_ids: Vec<String>,
    pub selected_mcp_server_ids: Vec<String>,
    pub retry_policy: ScheduledTaskRetryPolicy,
    pub created_by: String,
}

#[derive(Clone)]
pub struct Scheduler {
    store: Arc<Store>,
    running: Arc<Mutex<HashSet<String>>>,
}

impl Scheduler {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            running: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn create(&self, name: &str, cron_expr: &str, task: &str) -> Result<ScheduleEntry> {
        validate_cron(cron_expr)?;
        let now = Utc::now();
        let now_text = now.to_rfc3339();
        let entry = ScheduleEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            cron: cron_expr.into(),
            task: task.into(),
            enabled: true,
            last_run_at: None,
            next_run_at: next_run_after(cron_expr, now)?.map(|time| time.to_rfc3339()),
            schedule: None,
            selected_skill_ids: Vec::new(),
            selected_mcp_server_ids: Vec::new(),
            retry_policy: ScheduledTaskRetryPolicy::default(),
            retry_scheduled_at: None,
            retry_attempt: 0,
            created_by: "manual".into(),
            created_at: now_text.clone(),
            updated_at: now_text,
            last_status: "idle".into(),
        };
        self.store.create_schedule(&entry)?;
        Ok(entry)
    }

    pub fn create_task(&self, request: ScheduledTaskRequest) -> Result<ScheduleEntry> {
        self.create_task_at(request, Utc::now())
    }

    fn create_task_at(
        &self,
        mut request: ScheduledTaskRequest,
        now: DateTime<Utc>,
    ) -> Result<ScheduleEntry> {
        let title = request.title.trim();
        let prompt = request.prompt.trim();
        anyhow::ensure!(!title.is_empty(), "scheduled task title is required");
        anyhow::ensure!(!prompt.is_empty(), "scheduled task prompt is required");
        request.schedule = normalize_schedule(request.schedule)?;
        request.selected_skill_ids = normalized_ids(request.selected_skill_ids);
        request.selected_mcp_server_ids = normalized_ids(request.selected_mcp_server_ids);
        request.retry_policy.max_retries = request.retry_policy.max_retries.min(10);
        request.retry_policy.retry_delay_minutes = request
            .retry_policy
            .retry_delay_minutes
            .clamp(1, 7 * 24 * 60);
        let now_text = now.to_rfc3339();
        let mut entry = ScheduleEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name: title.to_string(),
            cron: legacy_cron_hint(&request.schedule),
            task: prompt.to_string(),
            enabled: request.enabled,
            last_run_at: None,
            next_run_at: None,
            schedule: Some(request.schedule),
            selected_skill_ids: request.selected_skill_ids,
            selected_mcp_server_ids: request.selected_mcp_server_ids,
            retry_policy: request.retry_policy,
            retry_scheduled_at: None,
            retry_attempt: 0,
            created_by: if request.created_by.trim().is_empty() {
                "ai".into()
            } else {
                request.created_by
            },
            created_at: now_text.clone(),
            updated_at: now_text,
            last_status: "idle".into(),
        };
        entry.next_run_at = initial_next_run(&entry, now)?.map(|time| time.to_rfc3339());
        self.store.create_schedule(&entry)?;
        Ok(entry)
    }

    pub fn list(&self) -> Result<Vec<ScheduleEntry>> {
        let mut entries = self.store.list_schedules()?;
        for e in &mut entries {
            if e.created_by.is_empty() {
                e.created_by = "manual".into();
            }
            if e.last_status.is_empty() {
                e.last_status = "idle".into();
            }
            let has_valid_next = e
                .next_run_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_some();
            let retry_is_valid = e
                .retry_scheduled_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_some();
            if e.retry_scheduled_at.is_some() && !retry_is_valid {
                e.retry_scheduled_at = None;
                e.retry_attempt = 0;
            }
            if e.enabled && !has_valid_next {
                e.next_run_at = initial_next_run(e, Utc::now())?.map(|time| time.to_rfc3339());
                if e.next_run_at.is_none() && is_finite_schedule(e) {
                    e.enabled = false;
                }
                e.updated_at = Utc::now().to_rfc3339();
                self.store.update_schedule(e)?;
            }
        }
        Ok(entries)
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        self.store.delete_schedule(id)
    }

    /// Validate and persist an edited schedule while retaining its durable ID.
    /// The dispatcher clears `next_run_at` when cadence changes or a disabled
    /// task is re-enabled; this method then derives the next deadline from the
    /// updated structured/legacy cadence.
    pub fn update(&self, mut entry: ScheduleEntry) -> Result<ScheduleEntry> {
        anyhow::ensure!(!entry.id.trim().is_empty(), "scheduled task id is required");
        anyhow::ensure!(
            !entry.name.trim().is_empty(),
            "scheduled task title is required"
        );
        anyhow::ensure!(
            !entry.task.trim().is_empty(),
            "scheduled task prompt is required"
        );
        entry.name = entry.name.trim().to_string();
        entry.task = entry.task.trim().to_string();
        if let Some(schedule) = entry.schedule.take() {
            let schedule = normalize_schedule(schedule)?;
            entry.cron = legacy_cron_hint(&schedule);
            entry.schedule = Some(schedule);
        } else {
            entry.cron = entry.cron.trim().to_string();
            validate_cron(&entry.cron)?;
        }
        entry.selected_skill_ids = normalized_ids(entry.selected_skill_ids);
        entry.selected_mcp_server_ids = normalized_ids(entry.selected_mcp_server_ids);
        entry.retry_policy.max_retries = entry.retry_policy.max_retries.min(10);
        entry.retry_policy.retry_delay_minutes =
            entry.retry_policy.retry_delay_minutes.clamp(1, 7 * 24 * 60);
        if entry.enabled && entry.next_run_at.is_none() {
            entry.next_run_at = initial_next_run(&entry, Utc::now())?.map(|time| time.to_rfc3339());
            if entry.next_run_at.is_none() && is_finite_schedule(&entry) {
                entry.enabled = false;
            }
        }
        if entry.created_by.trim().is_empty() {
            entry.created_by = "manual".into();
        }
        if entry.last_status.trim().is_empty() {
            entry.last_status = "idle".into();
        }
        entry.updated_at = Utc::now().to_rfc3339();
        anyhow::ensure!(
            self.store.update_schedule(&entry)?,
            "scheduled task not found"
        );
        Ok(entry)
    }

    /// 后台调度循环：每 30s 扫描到期任务并触发回调。
    pub async fn run_loop(&self, on_due: OnDue) -> Result<()> {
        loop {
            if let Err(e) = self.tick(&on_due).await {
                tracing::warn!(error = %e, "scheduler tick failed");
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    }

    async fn tick(&self, on_due: &OnDue) -> Result<()> {
        self.tick_at(Utc::now(), on_due).await
    }

    async fn tick_at(&self, now: DateTime<Utc>, on_due: &OnDue) -> Result<()> {
        let mut due = Vec::new();
        for entry in self.list()? {
            if !entry.enabled {
                continue;
            }
            let Some(next) = effective_deadline(&entry) else {
                continue;
            };
            if next > now {
                continue;
            }
            if self.running.lock().unwrap().insert(entry.id.clone()) {
                due.push(entry);
            }
        }

        let mut tasks = tokio::task::JoinSet::new();
        for entry in due {
            let scheduler = self.clone();
            let callback = on_due.clone();
            tasks.spawn(async move {
                let _guard = RunningGuard {
                    id: entry.id.clone(),
                    running: scheduler.running.clone(),
                };
                tracing::info!(schedule = %entry.name, attempt = entry.retry_attempt + 1, "schedule due");
                // Preserve the callback contract used by existing hosts: the
                // delivered snapshot describes the occurrence being run and
                // its provisional successor. Persistence still happens only
                // after the callback outcome is known, so retries do not
                // consume an occurrence.
                let occurrence = entry
                    .next_run_at
                    .as_deref()
                    .and_then(parse_datetime)
                    .unwrap_or(now);
                let mut callback_entry = entry.clone();
                callback_entry.last_run_at = Some(now.to_rfc3339());
                callback_entry.next_run_at = following_run(&entry, occurrence, now)?
                    .map(|time| time.to_rfc3339());
                if callback_entry.next_run_at.is_none() && is_finite_schedule(&callback_entry) {
                    callback_entry.enabled = false;
                }
                let outcome = callback(callback_entry).await;
                let completed_at = std::cmp::max(Utc::now(), now);
                scheduler.finish_attempt(entry, outcome, completed_at)
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.context("scheduled task worker panicked")??;
        }
        Ok(())
    }

    fn finish_attempt(
        &self,
        mut entry: ScheduleEntry,
        outcome: Result<()>,
        completed_at: DateTime<Utc>,
    ) -> Result<()> {
        if let Err(error) = outcome {
            if entry.retry_attempt < entry.retry_policy.max_retries {
                entry.retry_attempt += 1;
                entry.retry_scheduled_at = Some(
                    (completed_at
                        + chrono::Duration::minutes(entry.retry_policy.retry_delay_minutes as i64))
                    .to_rfc3339(),
                );
                entry.updated_at = completed_at.to_rfc3339();
                entry.last_status = "retrying".into();
                tracing::warn!(
                    schedule = %entry.name,
                    attempt = entry.retry_attempt,
                    error = %error,
                    "scheduled task failed; retry scheduled"
                );
                self.store.update_schedule(&entry)?;
                return Ok(());
            }
            tracing::warn!(schedule = %entry.name, error = %error, "scheduled task retries exhausted");
            entry.last_status = "failed".into();
        } else {
            entry.last_status = "completed".into();
        }

        let occurrence = entry
            .next_run_at
            .as_deref()
            .and_then(parse_datetime)
            .unwrap_or(completed_at);
        entry.last_run_at = Some(completed_at.to_rfc3339());
        entry.next_run_at =
            following_run(&entry, occurrence, completed_at)?.map(|time| time.to_rfc3339());
        entry.retry_scheduled_at = None;
        entry.retry_attempt = 0;
        if entry.next_run_at.is_none() && is_finite_schedule(&entry) {
            entry.enabled = false;
        }
        entry.updated_at = completed_at.to_rfc3339();
        self.store.update_schedule(&entry)?;
        Ok(())
    }
}

struct RunningGuard {
    id: String,
    running: Arc<Mutex<HashSet<String>>>,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.running.lock().unwrap().remove(&self.id);
    }
}

fn normalized_ids(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn parse_datetime(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(time) = DateTime::parse_from_rfc3339(value) {
        return Some(time.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        let Ok(naive) = NaiveDateTime::parse_from_str(value, format) else {
            continue;
        };
        let local = match Local.from_local_datetime(&naive) {
            LocalResult::Single(value) => value,
            LocalResult::Ambiguous(earlier, _) => earlier,
            LocalResult::None => continue,
        };
        return Some(local.with_timezone(&Utc));
    }
    None
}

fn normalized_time_of_day(value: &str) -> Result<String> {
    let (hour, minute) = value
        .trim()
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("time_of_day must use HH:mm format"))?;
    let hour = hour
        .parse::<u32>()
        .map_err(|_| anyhow::anyhow!("time_of_day must use HH:mm format"))?;
    let minute = minute
        .parse::<u32>()
        .map_err(|_| anyhow::anyhow!("time_of_day must use HH:mm format"))?;
    anyhow::ensure!(
        hour <= 23 && minute <= 59,
        "time_of_day must be a valid local time"
    );
    Ok(format!("{hour:02}:{minute:02}"))
}

fn normalize_schedule(schedule: ScheduledTaskSchedule) -> Result<ScheduledTaskSchedule> {
    match schedule {
        ScheduledTaskSchedule::Once { run_at } => {
            let run_at = parse_datetime(&run_at)
                .ok_or_else(|| anyhow::anyhow!("run_at must be a valid ISO datetime"))?;
            Ok(ScheduledTaskSchedule::Once {
                run_at: run_at.to_rfc3339(),
            })
        }
        ScheduledTaskSchedule::Interval {
            every_minutes,
            start_at,
        } => {
            anyhow::ensure!(every_minutes > 0, "every_minutes must be greater than zero");
            let start_at = start_at
                .map(|value| {
                    parse_datetime(&value)
                        .map(|time| time.to_rfc3339())
                        .ok_or_else(|| anyhow::anyhow!("start_at must be a valid ISO datetime"))
                })
                .transpose()?;
            Ok(ScheduledTaskSchedule::Interval {
                every_minutes,
                start_at,
            })
        }
        ScheduledTaskSchedule::Daily { time_of_day } => Ok(ScheduledTaskSchedule::Daily {
            time_of_day: normalized_time_of_day(&time_of_day)?,
        }),
        ScheduledTaskSchedule::Weekly {
            mut weekdays,
            time_of_day,
        } => {
            weekdays.sort_unstable();
            weekdays.dedup();
            anyhow::ensure!(
                !weekdays.is_empty() && weekdays.iter().all(|day| (1..=7).contains(day)),
                "weekdays must contain ISO weekday integers from 1 to 7"
            );
            Ok(ScheduledTaskSchedule::Weekly {
                weekdays,
                time_of_day: normalized_time_of_day(&time_of_day)?,
            })
        }
        ScheduledTaskSchedule::Dates { dates } => {
            anyhow::ensure!(
                !dates.is_empty(),
                "dates must contain at least one datetime"
            );
            let mut dates = dates
                .into_iter()
                .map(|value| {
                    parse_datetime(&value)
                        .map(|time| time.to_rfc3339())
                        .ok_or_else(|| anyhow::anyhow!("dates must contain valid ISO datetimes"))
                })
                .collect::<Result<Vec<_>>>()?;
            dates.sort();
            dates.dedup();
            Ok(ScheduledTaskSchedule::Dates { dates })
        }
    }
}

fn legacy_cron_hint(schedule: &ScheduledTaskSchedule) -> String {
    match schedule {
        ScheduledTaskSchedule::Daily { time_of_day } => {
            let (hour, minute) = time_of_day.split_once(':').unwrap_or(("0", "0"));
            format!("{minute} {hour} * * *")
        }
        ScheduledTaskSchedule::Weekly {
            weekdays,
            time_of_day,
        } => {
            let (hour, minute) = time_of_day.split_once(':').unwrap_or(("0", "0"));
            // Electron uses ISO weekdays (Monday=1, Sunday=7); five-field
            // cron accepts 7 as Sunday and is therefore the same representation.
            let days = weekdays
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",");
            format!("{minute} {hour} * * {days}")
        }
        _ => String::new(),
    }
}

fn local_time_after(
    reference: DateTime<Utc>,
    time_of_day: &str,
    weekdays: Option<&[u32]>,
) -> Result<Option<DateTime<Utc>>> {
    let normalized = normalized_time_of_day(time_of_day)?;
    let (hour, minute) = normalized
        .split_once(':')
        .expect("normalized time always contains a colon");
    let hour = hour.parse::<u32>()?;
    let minute = minute.parse::<u32>()?;
    let reference_local = reference.with_timezone(&Local);
    for offset in 0..=7 {
        let date = reference_local.date_naive() + chrono::Duration::days(offset);
        let Some(naive) = date.and_hms_opt(hour, minute, 0) else {
            continue;
        };
        let candidates = match Local.from_local_datetime(&naive) {
            LocalResult::Single(value) => vec![value],
            LocalResult::Ambiguous(first, second) => vec![first, second],
            LocalResult::None => Vec::new(),
        };
        for candidate in candidates {
            let candidate = candidate.with_timezone(&Utc);
            let iso_weekday =
                chrono::Datelike::weekday(&candidate.with_timezone(&Local)).number_from_monday();
            if candidate > reference
                && weekdays.is_none_or(|allowed| allowed.contains(&iso_weekday))
            {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}

fn initial_next_run(entry: &ScheduleEntry, now: DateTime<Utc>) -> Result<Option<DateTime<Utc>>> {
    let Some(schedule) = entry.schedule.as_ref() else {
        return next_run_after(&entry.cron, now);
    };
    match schedule {
        ScheduledTaskSchedule::Once { run_at } => {
            let run_at = parse_datetime(run_at)
                .ok_or_else(|| anyhow::anyhow!("invalid persisted once schedule"))?;
            let already_ran = entry
                .last_run_at
                .as_deref()
                .and_then(parse_datetime)
                .is_some_and(|last| last >= run_at);
            Ok((!already_ran).then_some(run_at))
        }
        ScheduledTaskSchedule::Dates { dates } => {
            let after = entry
                .last_run_at
                .as_deref()
                .and_then(parse_datetime)
                .unwrap_or(DateTime::<Utc>::MIN_UTC);
            Ok(dates
                .iter()
                .filter_map(|value| parse_datetime(value))
                .find(|date| *date > after))
        }
        ScheduledTaskSchedule::Interval {
            every_minutes,
            start_at,
        } => {
            if let Some(last) = entry.last_run_at.as_deref().and_then(parse_datetime) {
                return Ok(Some(
                    last + chrono::Duration::minutes(*every_minutes as i64),
                ));
            }
            Ok(start_at
                .as_deref()
                .and_then(parse_datetime)
                .filter(|start| *start > now)
                .or(Some(now)))
        }
        ScheduledTaskSchedule::Daily { time_of_day } => local_time_after(now, time_of_day, None),
        ScheduledTaskSchedule::Weekly {
            weekdays,
            time_of_day,
        } => local_time_after(now, time_of_day, Some(weekdays)),
    }
}

fn following_run(
    entry: &ScheduleEntry,
    occurrence: DateTime<Utc>,
    completed_at: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>> {
    let Some(schedule) = entry.schedule.as_ref() else {
        return next_run_after(&entry.cron, completed_at);
    };
    match schedule {
        ScheduledTaskSchedule::Once { .. } => Ok(None),
        ScheduledTaskSchedule::Dates { dates } => Ok(dates
            .iter()
            .filter_map(|value| parse_datetime(value))
            .find(|date| *date > occurrence)),
        ScheduledTaskSchedule::Interval { every_minutes, .. } => Ok(Some(
            occurrence + chrono::Duration::minutes(*every_minutes as i64),
        )),
        ScheduledTaskSchedule::Daily { time_of_day } => {
            local_time_after(std::cmp::max(occurrence, completed_at), time_of_day, None)
        }
        ScheduledTaskSchedule::Weekly {
            weekdays,
            time_of_day,
        } => local_time_after(
            std::cmp::max(occurrence, completed_at),
            time_of_day,
            Some(weekdays),
        ),
    }
}

fn effective_deadline(entry: &ScheduleEntry) -> Option<DateTime<Utc>> {
    entry
        .retry_scheduled_at
        .as_deref()
        .and_then(parse_datetime)
        .or_else(|| entry.next_run_at.as_deref().and_then(parse_datetime))
}

fn is_finite_schedule(entry: &ScheduleEntry) -> bool {
    matches!(
        entry.schedule,
        Some(ScheduledTaskSchedule::Once { .. } | ScheduledTaskSchedule::Dates { .. })
    )
}

pub fn electron_task_value(entry: &ScheduleEntry) -> Value {
    let schedule = entry.schedule.as_ref().map_or_else(
        || json!({ "kind": "cron", "expression": entry.cron }),
        |schedule| serde_json::to_value(schedule).unwrap_or(Value::Null),
    );
    json!({
        "id": entry.id,
        "title": entry.name,
        "enabled": entry.enabled,
        "createdBy": if entry.created_by.is_empty() { "manual" } else { &entry.created_by },
        "prompt": entry.task,
        "schedule": schedule,
        "selectedSkillIds": entry.selected_skill_ids,
        "selectedMcpServerIds": entry.selected_mcp_server_ids,
        "retryPolicy": entry.retry_policy,
        "createdAt": entry.created_at,
        "updatedAt": entry.updated_at,
        "nextRunAt": entry.next_run_at,
        "retryScheduledAt": entry.retry_scheduled_at,
        "lastRunAt": entry.last_run_at,
        "lastStatus": if entry.last_status.is_empty() { "idle" } else { &entry.last_status },
    })
}

pub fn validate_cron(expr: &str) -> Result<()> {
    cron::Schedule::from_str(&to_crate_cron(expr)?)
        .map(|_| ())
        .with_context(|| format!("invalid cron expression: {expr}"))
}

/// 标准 5 段 cron（分 时 日 月 周，0=周日）→ cron crate 的 6 段。
/// crate 的星期域 1=周日…7=周六，需做 +1 映射（支持 1-5/1,3/* 等形式）。
fn to_crate_cron(expr: &str) -> Result<String> {
    let expr = expr.trim();
    let fields: Vec<&str> = expr.split_whitespace().collect();
    let converted = match fields.len() {
        5 => {
            let dow = remap_dow(fields[4])?;
            format!(
                "0 {} {} {} {} {}",
                fields[0], fields[1], fields[2], fields[3], dow
            )
        }
        6 | 7 => expr.to_string(),
        n => anyhow::bail!("cron must have 5 fields, got {n}: {expr}"),
    };
    Ok(converted)
}

fn remap_dow(field: &str) -> Result<String> {
    // 仅映射纯数字/范围/列表；名称（Mon）跳过（crate 自身支持）
    let is_numeric = field
        .split([',', '-'])
        .all(|part| part.trim().parse::<u32>().is_ok());
    if !is_numeric {
        return Ok(field.to_string());
    }
    let mut out: Vec<String> = Vec::new();
    for part in field.split(',') {
        if let Some((a, b)) = part.split_once('-') {
            let a: u32 = a.trim().parse()?;
            let b: u32 = b.trim().parse()?;
            out.push(format!("{}-{}", a + 1, b + 1));
        } else {
            let v: u32 = part.trim().parse()?;
            // unix cron 7 = 周日，归一为 0
            let v = if v == 7 { 0 } else { v };
            out.push((v + 1).to_string());
        }
    }
    Ok(out.join(","))
}

/// 下一次运行时间。Cron fields use the host process's local timezone; the
/// persisted RFC 3339 value is converted back to an absolute UTC instant.
pub fn next_run(expr: &str) -> Result<Option<DateTime<Utc>>> {
    next_run_after(expr, Utc::now())
}

fn next_run_after(expr: &str, after: DateTime<Utc>) -> Result<Option<DateTime<Utc>>> {
    let schedule = cron::Schedule::from_str(&to_crate_cron(expr)?)
        .with_context(|| format!("invalid cron: {expr}"))?;
    let after_local = after.with_timezone(&Local);
    Ok(schedule
        .after(&after_local)
        .next()
        .map(|time| time.with_timezone(&Utc)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_cron() {
        assert!(validate_cron("0 9 * * 1-5").is_ok());
        assert!(validate_cron("*/20 * * * *").is_ok());
        assert!(validate_cron("not a cron").is_err());
    }

    #[test]
    fn computes_next_run() {
        let next = next_run("0 9 * * 1-5").unwrap().unwrap();
        assert!(next > Utc::now());
        // Cron weekdays and wall-clock hours are interpreted locally even
        // though persisted deadlines are absolute RFC 3339 timestamps.
        let local_next = next.with_timezone(&Local);
        let weekday = chrono::Datelike::weekday(&local_next);
        assert!(matches!(
            weekday,
            chrono::Weekday::Mon
                | chrono::Weekday::Tue
                | chrono::Weekday::Wed
                | chrono::Weekday::Thu
                | chrono::Weekday::Fri
        ));
        assert_eq!(chrono::Timelike::hour(&local_next), 9);
        assert_eq!(chrono::Timelike::minute(&local_next), 0);
    }

    #[test]
    fn create_and_list_via_store() {
        let dir = std::env::temp_dir().join(format!("ws-sched-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(&dir.join("db.sqlite")).unwrap());
        let sched = Scheduler::new(store);
        let entry = sched.create("早报", "0 9 * * 1-5", "汇总昨日对话").unwrap();
        let list = sched.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "早报");
        assert!(list[0].next_run_at.is_some());
        assert!(sched.delete(&entry.id).unwrap());
        assert!(sched.list().unwrap().is_empty());
    }

    #[tokio::test]
    async fn due_tick_uses_persisted_deadline_and_advances_it() {
        let dir = std::env::temp_dir().join(format!("ws-sched-due-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(&dir.join("db.sqlite")).unwrap());
        let now = DateTime::parse_from_rfc3339("2030-01-01T12:00:30Z")
            .unwrap()
            .with_timezone(&Utc);
        store
            .create_schedule(&ScheduleEntry {
                id: "due-task".into(),
                name: "Due task".into(),
                cron: "* * * * *".into(),
                task: "run".into(),
                enabled: true,
                last_run_at: None,
                next_run_at: Some("2030-01-01T12:00:00+00:00".into()),
                schedule: None,
                selected_skill_ids: Vec::new(),
                selected_mcp_server_ids: Vec::new(),
                retry_policy: ScheduledTaskRetryPolicy::default(),
                retry_scheduled_at: None,
                retry_attempt: 0,
                created_by: "manual".into(),
                created_at: "2030-01-01T00:00:00+00:00".into(),
                updated_at: "2030-01-01T00:00:00+00:00".into(),
                last_status: "idle".into(),
            })
            .unwrap();
        let scheduler = Scheduler::new(store.clone());
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = observed.clone();
        let on_due: OnDue = Arc::new(move |entry| {
            let captured = captured.clone();
            Box::pin(async move {
                captured.lock().unwrap().push(entry);
                Ok(())
            })
        });

        scheduler.tick_at(now, &on_due).await.unwrap();

        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].id, "due-task");
        assert_eq!(
            observed[0].last_run_at.as_deref(),
            Some("2030-01-01T12:00:30+00:00")
        );
        assert_eq!(
            observed[0].next_run_at.as_deref(),
            Some("2030-01-01T12:01:00+00:00")
        );
        drop(observed);

        let persisted = store.list_schedules().unwrap();
        assert_eq!(
            persisted[0].last_run_at.as_deref(),
            Some("2030-01-01T12:00:30+00:00")
        );
        assert_eq!(
            persisted[0].next_run_at.as_deref(),
            Some("2030-01-01T12:01:00+00:00")
        );
    }

    fn structured_request(schedule: ScheduledTaskSchedule, enabled: bool) -> ScheduledTaskRequest {
        ScheduledTaskRequest {
            title: "Structured task".into(),
            prompt: "Run the report".into(),
            enabled,
            schedule,
            selected_skill_ids: vec!["research".into(), "research".into(), " ".into()],
            selected_mcp_server_ids: vec!["docs".into()],
            retry_policy: ScheduledTaskRetryPolicy {
                max_retries: 2,
                retry_delay_minutes: 5,
            },
            created_by: "ai".into(),
        }
    }

    #[test]
    fn structured_schedule_metadata_survives_reopen_and_disabled_tasks_keep_deadline() {
        let dir = std::env::temp_dir().join(format!("ws-sched-v2-{}", uuid::Uuid::new_v4()));
        let path = dir.join("db.sqlite");
        let now = DateTime::parse_from_rfc3339("2030-01-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let scheduler = Scheduler::new(Arc::new(Store::open(&path).unwrap()));
        let entry = scheduler
            .create_task_at(
                structured_request(
                    ScheduledTaskSchedule::Interval {
                        every_minutes: 15,
                        start_at: Some("2030-01-01T13:00:00Z".into()),
                    },
                    false,
                ),
                now,
            )
            .unwrap();
        assert!(!entry.enabled);
        assert_eq!(
            entry.next_run_at.as_deref(),
            Some("2030-01-01T13:00:00+00:00")
        );
        drop(scheduler);

        let reopened = Scheduler::new(Arc::new(Store::open(&path).unwrap()));
        let persisted = reopened.list().unwrap();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].selected_skill_ids, vec!["research"]);
        assert_eq!(persisted[0].selected_mcp_server_ids, vec!["docs"]);
        assert_eq!(persisted[0].retry_policy.max_retries, 2);
        assert!(!persisted[0].enabled);
        assert_eq!(persisted[0].schedule, entry.schedule);
    }

    #[tokio::test]
    async fn dates_consume_one_occurrence_at_a_time_and_disable_when_exhausted() {
        let dir = std::env::temp_dir().join(format!("ws-sched-dates-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(&dir.join("db.sqlite")).unwrap());
        let scheduler = Scheduler::new(store.clone());
        let created_at = DateTime::parse_from_rfc3339("2030-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        scheduler
            .create_task_at(
                structured_request(
                    ScheduledTaskSchedule::Dates {
                        dates: vec!["2030-01-02T09:00:00Z".into(), "2030-01-01T09:00:00Z".into()],
                    },
                    true,
                ),
                created_at,
            )
            .unwrap();
        let calls = Arc::new(Mutex::new(0));
        let captured = calls.clone();
        let on_due: OnDue = Arc::new(move |_| {
            let captured = captured.clone();
            Box::pin(async move {
                *captured.lock().unwrap() += 1;
                Ok(())
            })
        });

        let first = DateTime::parse_from_rfc3339("2030-01-01T09:00:01Z")
            .unwrap()
            .with_timezone(&Utc);
        scheduler.tick_at(first, &on_due).await.unwrap();
        let after_first = store.list_schedules().unwrap().remove(0);
        assert!(after_first.enabled);
        assert_eq!(
            after_first.next_run_at.as_deref(),
            Some("2030-01-02T09:00:00+00:00")
        );

        let second = DateTime::parse_from_rfc3339("2030-01-02T09:00:01Z")
            .unwrap()
            .with_timezone(&Utc);
        scheduler.tick_at(second, &on_due).await.unwrap();
        let finished = store.list_schedules().unwrap().remove(0);
        assert!(!finished.enabled);
        assert!(finished.next_run_at.is_none());
        assert_eq!(*calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn failed_occurrence_retries_without_consuming_schedule() {
        let dir = std::env::temp_dir().join(format!("ws-sched-retry-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(Store::open(&dir.join("db.sqlite")).unwrap());
        let scheduler = Scheduler::new(store.clone());
        let created_at = DateTime::parse_from_rfc3339("2030-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        scheduler
            .create_task_at(
                structured_request(
                    ScheduledTaskSchedule::Once {
                        run_at: "2030-01-01T09:00:00Z".into(),
                    },
                    true,
                ),
                created_at,
            )
            .unwrap();
        let failures = Arc::new(Mutex::new(0));
        let captured = failures.clone();
        let on_due: OnDue = Arc::new(move |_| {
            let captured = captured.clone();
            Box::pin(async move {
                let mut calls = captured.lock().unwrap();
                *calls += 1;
                if *calls == 1 {
                    anyhow::bail!("temporary failure")
                }
                Ok(())
            })
        });

        let first = DateTime::parse_from_rfc3339("2030-01-01T09:00:01Z")
            .unwrap()
            .with_timezone(&Utc);
        scheduler.tick_at(first, &on_due).await.unwrap();
        let retrying = store.list_schedules().unwrap().remove(0);
        assert_eq!(retrying.retry_attempt, 1);
        assert_eq!(retrying.last_status, "retrying");
        assert_eq!(
            retrying.next_run_at.as_deref(),
            Some("2030-01-01T09:00:00+00:00")
        );
        assert_eq!(
            retrying.retry_scheduled_at.as_deref(),
            Some("2030-01-01T09:05:01+00:00")
        );

        let retry_at = DateTime::parse_from_rfc3339("2030-01-01T09:05:02Z")
            .unwrap()
            .with_timezone(&Utc);
        scheduler.tick_at(retry_at, &on_due).await.unwrap();
        let completed = store.list_schedules().unwrap().remove(0);
        assert!(!completed.enabled);
        assert_eq!(completed.last_status, "completed");
        assert!(completed.retry_scheduled_at.is_none());
        assert_eq!(*failures.lock().unwrap(), 2);
    }
}
