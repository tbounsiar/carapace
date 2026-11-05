use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::*;

#[test]
fn macro_formats_english_and_sends_parameters() {
    let name = "web";
    let t = crate::text!(
        "errors.test.sample",
        "{name} has {count} hosts",
        name = name,
        count = 3
    );
    assert_eq!(t.message, "web has 3 hosts");
    assert_eq!(t.key, Some("errors.test.sample"));
    let json = serde_json::to_value(&t).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "key": "errors.test.sample",
            "params": { "name": "web", "count": 3 },
            "message": "web has 3 hosts",
        })
    );
}

#[test]
fn plain_text_serializes_the_message_only() {
    let json = serde_json::to_value(Text::plain("x")).unwrap();
    assert_eq!(json, serde_json::json!({ "message": "x" }));
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Keys passed to `text!` in the backend sources, test files and this module excepted.
fn used_keys() -> BTreeSet<String> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut keys = BTreeSet::new();
    for file in files {
        let name = file.file_name().unwrap().to_string_lossy();
        if name == "tests.rs"
            || name.ends_with("_tests.rs")
            || file.starts_with(src.join("text"))
            || file == src.join("text.rs")
        {
            continue;
        }
        let code = std::fs::read_to_string(&file).unwrap();
        let mut rest = code.as_str();
        while let Some(at) = rest.find("text!(") {
            rest = rest[at + 6..].trim_start();
            if let Some(body) = rest.strip_prefix('"') {
                let end = body.find('"').unwrap();
                keys.insert(body[..end].to_owned());
            }
        }
    }
    keys
}

fn leaf_keys(value: &serde_json::Value, prefix: &str, out: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                leaf_keys(v, &format!("{prefix}.{k}"), out);
            }
        }
        _ => {
            out.insert(prefix.to_owned());
        }
    }
}

/// `src/app/i18n/<lang>/errors/<area>.json` holds the `errors.<area>.*` texts.
fn translated_keys(lang: &str) -> BTreeSet<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/app/i18n")
        .join(lang)
        .join("errors");
    let mut keys = BTreeSet::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "json") {
            let area = path.file_stem().unwrap().to_string_lossy().into_owned();
            let json: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let camel = camel_case(&area);
            leaf_keys(&json, &format!("errors.{camel}"), &mut keys);
        }
    }
    keys
}

fn camel_case(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[test]
fn every_key_is_translated_and_every_translation_is_used() {
    let used = used_keys();
    for lang in ["en", "fr"] {
        let translated = translated_keys(lang);
        let missing: Vec<_> = used.difference(&translated).collect();
        assert!(
            missing.is_empty(),
            "{lang}: keys without a translation: {missing:?}"
        );
        let unused: Vec<_> = translated.difference(&used).collect();
        assert!(
            unused.is_empty(),
            "{lang}: translations no code sends: {unused:?}"
        );
    }
}
