/// Longer than any version the app publishes; bounds what goes into a URL or the settings file.
const MAX_VERSION_LEN: usize = 64;

/// `MAJOR.MINOR.PATCH` with an optional `-pre.release` part, as semver writes them, without
/// build metadata: only ASCII letters, digits, `.` and `-`, so the text is safe in a URL path.
pub fn is_plain_version(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > MAX_VERSION_LEN {
        return false;
    }
    let (core, pre) = match raw.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (raw, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 || !parts.iter().all(|p| numeric(p)) {
        return false;
    }
    pre.is_none_or(|pre| {
        pre.split('.').all(|id| {
            !id.is_empty()
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && (!id.bytes().all(|b| b.is_ascii_digit()) || numeric(id))
        })
    })
}

/// Digits without a leading zero, as semver requires for numeric identifiers.
fn numeric(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && (id == "0" || !id.starts_with('0'))
}
