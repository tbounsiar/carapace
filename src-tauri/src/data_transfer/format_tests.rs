use serde_json::json;

use super::*;

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn base() -> Value {
    json!({
        "format": "carapace-data",
        "version": 1,
        "exportedAt": "2026-11-05T10:12:00Z",
        "appVersion": "0.2.0",
        "scope": {"kind": "all"},
        "variables": [
            {"name": "user", "kind": "plain", "value": "deploy"},
            {"name": "db_pw", "kind": "secret"}
        ],
        "projects": [
            {"id": id(1), "name": "Payments",
             "variables": [{"name": "db_host", "kind": "plain", "value": "10.0.1.9"}]}
        ],
        "nodes": [
            {"kind": "collection", "id": id(2), "name": "Backend", "projectId": id(1), "parentId": null},
            {"kind": "host", "id": id(3), "name": "api-1", "projectId": id(1), "parentId": id(2),
             "hostname": "${db_host}", "port": "22", "username": "${user}",
             "auth": {"kind": "password", "password": "${db_pw}"}}
        ],
        "keys": [
            {"id": id(4), "name": "Work laptop", "path": "~/.ssh/id_ed25519", "algorithm": "ed25519", "bits": null}
        ]
    })
}

fn parse_value(v: &Value) -> Result<DataFile, ParseError> {
    parse(&serde_json::to_vec(v).unwrap())
}

fn err(v: &Value) -> ParseError {
    parse_value(v).unwrap_err()
}

fn edit(f: impl FnOnce(&mut Value)) -> Value {
    let mut v = base();
    f(&mut v);
    v
}

fn invalid_messages(v: &Value) -> Vec<String> {
    match err(v) {
        ParseError::Invalid(m) => m.into_iter().map(|t| t.message).collect(),
        other => panic!("expected invalid, got {other:?}"),
    }
}

#[test]
fn the_spec_example_parses_and_writes_back_the_same() {
    let file = parse_value(&base()).unwrap();
    assert_eq!(
        file.projects[0].variables[0].value.as_deref(),
        Some("10.0.1.9")
    );
    assert_eq!(file.variables[1].value, None);
    let bytes = to_bytes(&file);
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(
        text.starts_with("{\n  \"format\""),
        "pretty-printed with two spaces"
    );
    assert_eq!(parse(&bytes).unwrap(), file);
    let written: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        written["variables"][1].get("value").is_none(),
        "a secret has no value key"
    );
    assert_eq!(written["keys"][0], base()["keys"][0]);
}

#[test]
fn unknown_keys_and_a_bom_are_accepted() {
    let v = edit(|v| {
        v["future"] = json!({"x": 1});
        v["nodes"][1]["color"] = json!("red");
    });
    let mut raw = "\u{feff}".as_bytes().to_vec();
    raw.extend(serde_json::to_vec(&v).unwrap());
    assert!(parse(&raw).is_ok());
}

#[test]
fn encoding_syntax_format_and_version_errors() {
    assert_eq!(parse(&[0xff, 0xfe, 0x00]).unwrap_err(), ParseError::NotUtf8);
    let syntax = parse(b"{\n  \"format\": \"carapace-data\",\n  oops\n}").unwrap_err();
    assert_eq!(syntax, ParseError::Syntax { line: 3, column: 3 });
    assert!(syntax.text().message.contains("line 3, column 3"));
    assert_eq!(syntax.code(), "import_malformed");

    for v in [
        json!([1, 2]),
        json!({"version": 1}),
        json!({"format": "other", "version": 1}),
        json!({"format": "carapace-data"}),
        json!({"format": "carapace-data", "version": 0}),
        json!({"format": "carapace-data", "version": "1"}),
        json!({"format": "carapace-data", "version": 1.5}),
        json!({"format": "carapace-data", "version": -1}),
    ] {
        assert_eq!(err(&v), ParseError::Format, "{v}");
    }
    assert_eq!(ParseError::Format.code(), "import_format");
    let newer = err(&edit(|v| v["version"] = json!(2)));
    assert_eq!(newer, ParseError::Version(2));
    assert_eq!(newer.code(), "import_version");
    assert!(newer.text().message.contains("format version 2"));
    let t = newer.text();
    assert_eq!(t.key, Some("errors.dataTransfer.newerVersion"));
    assert_eq!(t.params["version"], 2);
    assert_eq!(t.params["supported"], VERSION);
    let t = syntax.text();
    assert_eq!(
        (t.params["line"].as_u64(), t.params["column"].as_u64()),
        (Some(3), Some(3))
    );
}

#[test]
fn invalid_files_list_each_message_as_a_text() {
    let v = edit(|v| {
        v["nodes"][1]["port"] = json!("0");
        v["projects"][0]["id"] = json!("not-an-id");
    });
    let e = err(&v);
    let t = e.text();
    assert_eq!(t.key, Some("errors.dataTransfer.invalidFile"));
    let list = t.params["errors"].as_array().unwrap();
    assert_eq!(list.len(), t.message.lines().count());
    let invalid_id = list
        .iter()
        .find(|l| l["key"] == "errors.dataTransfer.invalidId")
        .unwrap();
    assert_eq!(
        invalid_id["params"]["who"]["key"],
        "errors.dataTransfer.itemNamed"
    );
    assert_eq!(invalid_id["params"]["who"]["params"]["kind"], "project");
    let host = err(&edit(|v| {
        v["nodes"][1]["auth"]["password"] = json!("hunter2")
    }))
    .text();
    assert_eq!(host.key, Some("errors.dataTransfer.authHasSecret"));
    assert_eq!(host.params["field"], "password");
    assert_eq!(host.params["host"]["params"]["kind"], "host");
    assert!(!serde_json::to_string(&host).unwrap().contains("hunter2"));
}

#[test]
fn secret_values_are_refused_without_being_echoed() {
    let cases = [
        edit(|v| v["variables"][1]["value"] = json!("hunter2")),
        edit(|v| {
            v["projects"][0]["variables"] =
                json!([{"name": "db_pw", "kind": "secret", "value": "hunter2"}])
        }),
    ];
    for v in &cases {
        let e = err(v);
        assert_eq!(e.code(), "import_secret_value");
        assert!(
            e.text()
                .message
                .contains("secret variable “db_pw” has a value"),
            "{}",
            e.text().message
        );
        assert!(!e.text().message.contains("hunter2"));
    }
    let host = err(&edit(|v| {
        v["nodes"][1]["auth"]["password"] = json!("hunter2")
    }));
    assert_eq!(host.code(), "import_secret_value");
    assert!(host.text().message.starts_with("host “api-1”"));
    assert!(!host.text().message.contains("hunter2"));
    let pass = edit(|v| {
        v["nodes"][1]["auth"] = json!({"kind": "key", "keyPath": "~/k", "passphrase": 42});
    });
    assert_eq!(err(&pass).code(), "import_secret_value");
    let mixed = err(&edit(|v| {
        v["nodes"][1]["auth"]["password"] = json!("x${db_pw}")
    }));
    assert_eq!(mixed.code(), "import_secret_value");
    let null_ok = edit(|v| v["variables"][1]["value"] = Value::Null);
    assert!(parse_value(&null_ok).is_ok());
}

#[test]
fn shape_errors_never_quote_values() {
    let v = edit(|v| v["nodes"][1]["port"] = json!({"secret": "hunter2"}));
    let m = invalid_messages(&v);
    assert_eq!(m.len(), 1);
    assert!(!m[0].contains("hunter2"));
    let unknown_kind = edit(|v| v["nodes"][0]["kind"] = json!("folder"));
    assert_eq!(err(&unknown_kind).code(), "import_invalid");
}

#[test]
fn every_rule_of_the_data_file_applies() {
    let cases: Vec<(Value, &str)> = vec![
        (
            edit(|v| v["nodes"][1]["port"] = json!("70000")),
            "host “api-1”: port must be between 1 and 65535.",
        ),
        (
            edit(|v| v["nodes"][1]["hostname"] = json!("a b")),
            "host “api-1”: hostname must not contain whitespace or control characters.",
        ),
        (
            edit(|v| v["nodes"][1]["username"] = json!("${user")),
            "host “api-1”: username has a malformed",
        ),
        (
            edit(|v| v["nodes"][1]["id"] = json!("ABC")),
            "host “api-1”: the id is not valid.",
        ),
        (
            edit(|v| v["nodes"][1]["id"] = json!(id(2))),
            "host “api-1”: the id is used twice.",
        ),
        (
            edit(|v| v["nodes"][1]["parentId"] = json!(id(9))),
            "host “api-1”: its parent collection is not in the file.",
        ),
        (
            edit(|v| v["nodes"][0]["parentId"] = json!(id(2))),
            "collection “Backend” is its own parent.",
        ),
        (
            edit(|v| v["nodes"][0]["projectId"] = json!(id(9))),
            "collection “Backend”: its project is not in the file.",
        ),
        (
            edit(|v| v["nodes"][0]["name"] = json!(" ")),
            "a collection has an invalid name",
        ),
        (
            edit(|v| v["projects"][0]["id"] = json!("x")),
            "project “Payments”: the id is not valid.",
        ),
        (
            edit(|v| {
                v["projects"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id": id(8), "name": "PAYMENTS"}))
            }),
            "project “PAYMENTS” is in the file twice.",
        ),
        (
            edit(|v| {
                v["variables"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"name": "USER", "kind": "plain", "value": ""}))
            }),
            "global variables: variable USER is defined twice.",
        ),
        (
            edit(|v| v["variables"][0]["name"] = json!("1bad")),
            "global variables: variable names start with",
        ),
        (
            edit(|v| v["keys"][0]["path"] = json!("relative/k")),
            "SSH key “Work laptop”: the path must be absolute or start with ~/.",
        ),
        (
            edit(|v| v["keys"][0]["bits"] = json!(0)),
            "SSH key “Work laptop”: the key size is not valid.",
        ),
        (
            edit(|v| v["scope"] = json!({"kind": "home"})),
            "A Home export cannot hold projects.",
        ),
        (
            edit(|v| {
                v["scope"] = json!({"kind": "project", "projectId": id(7), "includeShared": true})
            }),
            "A project export must hold exactly its project.",
        ),
    ];
    for (v, expected) in cases {
        let m = invalid_messages(&v);
        assert!(
            m.iter().any(|x| x.starts_with(expected)),
            "{expected:?} not in {m:?}"
        );
    }
    let dup = edit(|v| {
        let mut other = v["nodes"][1].clone();
        other["id"] = json!(id(5));
        other["name"] = json!("API-1");
        v["nodes"].as_array_mut().unwrap().push(other);
    });
    assert!(
        invalid_messages(&dup).contains(&"host “API-1” is twice in the same scope.".to_string())
    );
}

#[test]
fn cycles_depth_and_size_are_checked() {
    let cycle = edit(|v| {
        v["nodes"] = json!([
            {"kind": "collection", "id": id(2), "name": "A", "projectId": null, "parentId": id(3)},
            {"kind": "collection", "id": id(3), "name": "B", "projectId": null, "parentId": id(2)}
        ]);
        v["projects"] = json!([]);
    });
    assert!(
        invalid_messages(&cycle)
            .iter()
            .any(|m| m.contains("inside itself"))
    );

    let deep = edit(|v| {
        let chain: Vec<Value> = (0..33)
            .map(|i| json!({"kind": "collection", "id": id(100 + i), "name": format!("c{i}"),
                "projectId": null, "parentId": if i == 0 { Value::Null } else { json!(id(99 + i)) }}))
            .collect();
        v["nodes"] = Value::Array(chain);
        v["projects"] = json!([]);
    });
    assert!(
        invalid_messages(&deep)
            .iter()
            .any(|m| m.contains("nested deeper than 32"))
    );

    let many = edit(|v| {
        let hosts: Vec<Value> = (0..5001)
            .map(|i| json!({"kind": "host", "id": id(1000 + i), "name": format!("h{i}"), "projectId": null,
                "parentId": null, "hostname": "h", "port": "22", "username": "u", "auth": {"kind": "agent"}}))
            .collect();
        v["nodes"] = Value::Array(hosts);
    });
    assert!(
        invalid_messages(&many)
            .iter()
            .any(|m| m.contains("5001 hosts and collections"))
    );
}

#[test]
fn at_most_five_messages() {
    let v = edit(|v| {
        let hosts: Vec<Value> = (0..20)
            .map(|i| json!({"kind": "host", "id": format!("bad{i}"), "name": format!("h{i}"), "projectId": null,
                "parentId": null, "hostname": "h", "port": "0", "username": "u", "auth": {"kind": "agent"}}))
            .collect();
        v["nodes"] = Value::Array(hosts);
    });
    let e = err(&v);
    assert_eq!(invalid_messages(&v).len(), 5);
    assert_eq!(e.text().message.lines().count(), 5);
}

#[test]
fn counts_are_capped_before_any_per_item_check() {
    let projects = edit(|v| {
        let list: Vec<Value> = (0..1001)
            .map(|i| json!({"id": id(10_000 + i), "name": format!("p{i}")}))
            .collect();
        v["projects"] = Value::Array(list);
        v["nodes"] = json!([]);
    });
    assert_eq!(
        invalid_messages(&projects),
        vec!["The file holds 1001 projects (max 1000).".to_string()]
    );
    let keys = edit(|v| {
        let list: Vec<Value> = (0..501)
            .map(|i| json!({"name": format!("k{i}"), "path": "~/k", "algorithm": "ed25519"}))
            .collect();
        v["keys"] = Value::Array(list);
    });
    assert_eq!(
        invalid_messages(&keys),
        vec!["The file holds 501 SSH keys (max 500).".to_string()]
    );
    let vars = edit(|v| {
        let list: Vec<Value> = (0..201)
            .map(|i| json!({"name": format!("v{i}"), "kind": "plain", "value": ""}))
            .collect();
        v["projects"][0]["variables"] = Value::Array(list);
    });
    assert_eq!(
        invalid_messages(&vars),
        vec!["A scope of the file holds more than 200 variables.".to_string()]
    );
}
