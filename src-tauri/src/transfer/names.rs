use crate::files::FsError;

const TEMP_SUFFIX: &str = ".carapace-part";
/// Left by a replace on servers without `posix-rename` (see `sftp` `rename_replace`).
const BACKUP_SUFFIX: &str = ".carapace-old";

/// Sibling a file is written to before it is renamed onto `name`: `.{name}.carapace-part`, or
/// `.{name}.{n}.carapace-part` when earlier ones are taken.
pub fn temp_name(name: &str, n: u32) -> Result<String, FsError> {
    let temp = if n == 0 {
        format!(".{name}{TEMP_SUFFIX}")
    } else {
        format!(".{name}.{n}{TEMP_SUFFIX}")
    };
    if temp.len() > 255 {
        return Err(FsError::invalid(crate::text!(
            "errors.transfer.tempNameTooLong",
            "{name} is too long to be written through a temporary file",
            name = name
        )));
    }
    Ok(temp)
}

/// Our own temporary and backup files, never transferred.
pub fn is_temp(name: &str) -> bool {
    name.starts_with('.') && (name.ends_with(TEMP_SUFFIX) || name.ends_with(BACKUP_SUFFIX))
}

/// `name (n).ext` for files, `name (n)` for directories. A leading dot is not an extension
/// separator (`.bashrc (1)`).
pub fn numbered(name: &str, n: u32, is_dir: bool) -> String {
    let split = if is_dir {
        None
    } else {
        name.rfind('.').filter(|&i| i > 0)
    };
    match split {
        Some(i) => format!("{} ({n}){}", &name[..i], &name[i..]),
        None => format!("{name} ({n})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_before_the_extension() {
        assert_eq!(numbered("a.txt", 1, false), "a (1).txt");
        assert_eq!(numbered("a.tar.gz", 2, false), "a.tar (2).gz");
        assert_eq!(numbered(".bashrc", 1, false), ".bashrc (1)");
        assert_eq!(numbered("noext", 3, false), "noext (3)");
        assert_eq!(numbered("my.dir", 1, true), "my.dir (1)");
    }

    #[test]
    fn temp_names_are_hidden_siblings() {
        assert_eq!(temp_name("a.txt", 0).unwrap(), ".a.txt.carapace-part");
        assert_eq!(temp_name("a.txt", 2).unwrap(), ".a.txt.2.carapace-part");
        assert!(is_temp(".a.txt.carapace-part"));
        assert!(is_temp(".a.txt.1.carapace-part"));
        assert!(is_temp(".a.txt.carapace-old"));
        assert!(!is_temp("a.txt"));
        assert_eq!(
            temp_name(&"x".repeat(250), 0).unwrap_err().code(),
            "invalid_input"
        );
    }
}
