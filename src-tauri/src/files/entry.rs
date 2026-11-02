use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    /// Unix seconds.
    pub modified: Option<i64>,
    /// `rwxr-xr-x` form; `None` where the platform has no Unix mode.
    pub permissions: Option<String>,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

pub fn mode_string(mode: u32) -> String {
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    bits.iter()
        .map(|&(bit, c)| if mode & bit != 0 { c } else { '-' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_modes() {
        assert_eq!(mode_string(0o40755), "rwxr-xr-x");
        assert_eq!(mode_string(0o100640), "rw-r-----");
        assert_eq!(mode_string(0), "---------");
    }

    #[test]
    fn serializes_camel_case() {
        let entry = FileEntry {
            name: "a".into(),
            path: "/a".into(),
            kind: EntryKind::Symlink,
            size: None,
            modified: Some(1),
            permissions: None,
            hidden: false,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["kind"], "symlink");
        assert_eq!(json["modified"], 1);
        assert!(json["size"].is_null());
    }
}
