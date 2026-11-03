use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Sent with every event, and shown in the recent events view. Nothing else about the machine
/// is read: no hostname, username or machine id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProps {
    pub app_version: String,
    pub os: String,
    pub os_version: String,
    pub locale: String,
}

impl SystemProps {
    pub fn detect(app_version: &str) -> Self {
        let info = os_info::get();
        let os = match info.os_type() {
            os_info::Type::Macos => "macOS".to_owned(),
            other => other.to_string(),
        };
        Self {
            app_version: clean(app_version, 50),
            os: clean(&os, 30),
            os_version: os_version(&info.version().to_string()),
            locale: locale(sys_locale::get_locale().as_deref().unwrap_or("")),
        }
    }
}

/// Printable ASCII only, bounded to what the ingestion API accepts.
fn clean(raw: &str, max: usize) -> String {
    let s: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '+'))
        .take(max)
        .collect();
    let s = s.trim();
    if s.is_empty() {
        "unknown".to_owned()
    } else {
        s.to_owned()
    }
}

/// Numbers only (`10.0.26300`, `14.4`) or `rolling`: distribution release text (codenames,
/// custom `os-release` fields) is never sent.
pub(super) fn os_version(raw: &str) -> String {
    let raw = raw.trim();
    if raw.starts_with("Rolling") {
        return "rolling".to_owned();
    }
    let parts: Vec<&str> = raw.split('.').collect();
    let numeric = raw.len() <= 32
        && parts.len() <= 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 10 && p.chars().all(|c| c.is_ascii_digit()));
    if numeric {
        raw.to_owned()
    } else {
        "unknown".to_owned()
    }
}

/// `language[-Script][-REGION]` (`fr-FR`, `zh-Hans-CN`, `es-419`), case normalised; POSIX forms
/// (`fr_FR.UTF-8@euro`) are reduced to it. Anything else (`C`, `POSIX`, a user name in `LANG`) is
/// dropped. The script is left out when the tag would exceed the ingestion limit of 10.
pub(super) fn locale(raw: &str) -> String {
    let tag = raw.split(['.', '@']).next().unwrap_or("").replace('_', "-");
    let mut parts = tag.split('-');
    let alpha = |p: &str, n: std::ops::RangeInclusive<usize>| {
        n.contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic())
    };
    let Some(lang) = parts.next().filter(|p| alpha(p, 2..=3)) else {
        return String::new();
    };
    let mut out = lang.to_ascii_lowercase();
    let mut script = None;
    let mut region = None;
    let mut rest: Vec<&str> = parts.collect();
    if rest.first().is_some_and(|p| alpha(p, 4..=4)) {
        let p = rest.remove(0);
        script = Some(format!(
            "{}{}",
            p[..1].to_ascii_uppercase(),
            p[1..].to_ascii_lowercase()
        ));
    }
    if let Some(p) = rest.first() {
        if alpha(p, 2..=2) {
            region = Some(p.to_ascii_uppercase());
        } else if p.len() == 3 && p.chars().all(|c| c.is_ascii_digit()) {
            region = Some((*p).to_owned());
        } else {
            return String::new();
        }
        rest.remove(0);
    }
    if !rest.is_empty() {
        return String::new();
    }
    let full = [Some(&out), script.as_ref(), region.as_ref()]
        .into_iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>()
        .join("-");
    if full.len() <= 10 {
        return full;
    }
    if let Some(r) = region {
        out = format!("{out}-{r}");
    }
    out
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso_utc(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, m, day) = civil(days as i64);
    format!(
        "{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (H. Hinnant's `civil_from_days`).
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn formats_utc_timestamps() {
        let at = |s: u64, ms: u64| iso_utc(UNIX_EPOCH + Duration::from_millis(s * 1000 + ms));
        assert_eq!(at(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(at(951_782_400, 5), "2000-02-29T00:00:00.005Z");
        assert_eq!(at(1_793_714_645, 999), "2026-11-03T14:04:05.999Z");
        assert_eq!(at(4_107_542_399, 0), "2100-02-28T23:59:59.000Z");
    }

    #[test]
    fn keeps_only_language_region_tags() {
        assert_eq!(locale("fr-FR"), "fr-FR");
        assert_eq!(locale("en_US.UTF-8"), "en-US");
        assert_eq!(locale("de_DE@euro"), "de-DE");
        assert_eq!(locale("FR_fr"), "fr-FR");
        assert_eq!(locale("en"), "en");
        assert_eq!(locale("es-419"), "es-419");
        assert_eq!(locale("zh-hans-cn"), "zh-Hans-CN");
        assert_eq!(locale("yue-Hant-HK"), "yue-HK");
        assert_eq!(locale("sr-Latn"), "sr-Latn");
        for bad in [
            "C",
            "POSIX",
            "",
            "jdoe",
            "srv01",
            "jdoe@srv01",
            "zh-Hans-CN-x-private",
            "en US",
            "-x",
            "en-",
            "en-USA",
            "en-1234",
            "e1-US",
            "fr-FR-FR",
        ] {
            assert_eq!(locale(bad), "", "{bad}");
        }
    }

    #[test]
    fn os_versions_are_numbers_or_rolling() {
        assert_eq!(os_version("10.0.26300"), "10.0.26300");
        assert_eq!(os_version("14.4.1"), "14.4.1");
        assert_eq!(os_version("24"), "24");
        assert_eq!(os_version("Rolling Release"), "rolling");
        assert_eq!(os_version("Rolling Release (20261103)"), "rolling");
        for bad in [
            "Unknown",
            "",
            "22.04 LTS (Jammy Jellyfish)",
            "srv01",
            "1.2.3.4.5",
            "1..2",
            ".1",
            "jdoe-workstation 3.1",
            "12345678901.1",
        ] {
            assert_eq!(os_version(bad), "unknown", "{bad}");
        }
    }

    #[test]
    fn cleans_system_strings() {
        assert_eq!(clean("Windows", 30), "Windows");
        assert_eq!(clean("10.0.26300", 100), "10.0.26300");
        assert_eq!(clean("a\u{1}b/c\\d", 30), "abcd");
        assert_eq!(clean("\u{e9}", 30), "unknown");
        assert_eq!(clean(&"x".repeat(40), 30).len(), 30);
    }

    #[test]
    fn detects_without_identifying_fields() {
        let p = SystemProps::detect("0.1.0");
        let json = serde_json::to_value(&p).unwrap();
        let keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys.len(), 4);
        for k in ["appVersion", "os", "osVersion", "locale"] {
            assert!(keys.contains(&k));
        }
        assert_eq!(p.app_version, "0.1.0");
    }
}
