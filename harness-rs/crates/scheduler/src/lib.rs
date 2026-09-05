//! 定时任务：cron 表达式 + SQLite 持久化 + tokio 调度循环。
//!
//! 移动端语义降级（iOS 补跑）在宿主层处理；harness 保持完整 cron 语义。

use anyhow::{Context, Result};
use chrono::{DateTime, Local, Utc};
use std::str::FromStr;
use std::sync::Arc;
use worldbase_memory::Store;
use worldbase_protocol::types::ScheduleEntry;

/// 到期回调：由 core 注入（把 task 文本交给 agent 运行）。
pub type OnDue = Arc<dyn Fn(ScheduleEntry) + Send + Sync>;

pub struct Scheduler {
    store: Arc<Store>,
}

impl Scheduler {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }

    pub fn create(&self, name: &str, cron_expr: &str, task: &str) -> Result<ScheduleEntry> {
        validate_cron(cron_expr)?;
        let entry = ScheduleEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            cron: cron_expr.into(),
            task: task.into(),
            enabled: true,
            last_run_at: None,
            next_run_at: next_run(cron_expr).ok().flatten().map(|t| t.to_rfc3339()),
        };
        self.store.create_schedule(&entry)?;
        Ok(entry)
    }

    pub fn list(&self) -> Result<Vec<ScheduleEntry>> {
        let mut entries = self.store.list_schedules()?;
        for e in &mut entries {
            let has_valid_next = e
                .next_run_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_some();
            if !has_valid_next {
                e.next_run_at = next_run(&e.cron)?.map(|time| time.to_rfc3339());
                self.store
                    .set_schedule_next_run(&e.id, e.next_run_at.as_deref())?;
            }
        }
        Ok(entries)
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        self.store.delete_schedule(id)
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
        for mut entry in self.list()? {
            if !entry.enabled {
                continue;
            }
            let Some(next) = entry
                .next_run_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc))
            else {
                continue;
            };
            if next > now {
                continue;
            }

            let last_run_at = now.to_rfc3339();
            let following = next_run_after(&entry.cron, now)?.map(|time| time.to_rfc3339());
            self.store
                .advance_schedule(&entry.id, &last_run_at, following.as_deref())?;
            entry.last_run_at = Some(last_run_at);
            entry.next_run_at = following;
            tracing::info!(schedule = %entry.name, "schedule due");
            on_due(entry);
        }
        Ok(())
    }
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
            })
            .unwrap();
        let scheduler = Scheduler::new(store.clone());
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = observed.clone();
        let on_due: OnDue = Arc::new(move |entry| captured.lock().unwrap().push(entry));

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
}
