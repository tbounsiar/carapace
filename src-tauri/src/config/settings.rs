//! App preferences kept in `settings.toml`. Parsing is lenient per field: anything missing or
//! malformed reads as "not set", so a hand edit can neither turn analytics on nor make the file
//! unusable. Only text that is not TOML at all is refused. Writes change only the values that
//! changed, in the existing document.

use toml_edit::{DocumentMut, Item, Table, TableLike, Value};

use super::model::{
    AnalyticsSettings, Category, CategoryChoice, CategoryChoices, Consent, EditorMode,
    ExternalEditor,
};
use super::store::ConfigError;
use super::validate::is_local_absolute;

pub const FONT_SIZE_MIN: u8 = 10;
pub const FONT_SIZE_MAX: u8 = 24;
pub const DEFAULT_FONT_SIZE: u8 = 13;
pub const KEY_FOLDER_MAX_CHARS: usize = 4096;
/// Far beyond the two levels the app writes. The parser recurses once per nested array or
/// inline table without a limit of its own: a hand-made file of nested brackets well under the
/// size cap overflows the stack, which aborts the whole app.
pub(super) const MAX_NESTING: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemeMode {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "system" => Some(Self::System),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    System,
    En,
    Fr,
}

impl Language {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "system" => Some(Self::System),
            "en" => Some(Self::En),
            "fr" => Some(Self::Fr),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::En => "en",
            Self::Fr => "fr",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyType {
    #[default]
    Ed25519,
    Rsa4096,
}

impl KeyType {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "ed25519" => Some(Self::Ed25519),
            "rsa4096" => Some(Self::Rsa4096),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Ed25519 => "ed25519",
            Self::Rsa4096 => "rsa4096",
        }
    }
}

/// What `settings.toml` holds; `None` is "not in the file", and the default applies.
/// `legacy_imported` records that the preferences the webview kept were imported once.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Settings {
    pub theme: Option<ThemeMode>,
    pub language: Option<Language>,
    pub default_key_type: Option<KeyType>,
    pub terminal_font_size: Option<u8>,
    pub key_folder: Option<String>,
    pub legacy_imported: bool,
    pub external_editor: Option<ExternalEditor>,
    pub analytics: Option<AnalyticsSettings>,
}

/// A change to the user preferences; `key_folder: Some(None)` clears the folder.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SettingsPatch {
    pub theme: Option<ThemeMode>,
    pub language: Option<Language>,
    pub default_key_type: Option<KeyType>,
    pub terminal_font_size: Option<u8>,
    pub key_folder: Option<Option<String>>,
}

pub fn is_font_size(size: i64) -> bool {
    (i64::from(FONT_SIZE_MIN)..=i64::from(FONT_SIZE_MAX)).contains(&size)
}

/// The folder of the last generated key: what the key generation accepts as a folder, checked
/// on the text only (it may no longer exist when it is used again). Messages never quote it.
pub fn check_key_folder(raw: &str) -> Result<(), ConfigError> {
    let invalid = |t| Err(ConfigError::InvalidInput(t));
    if raw.is_empty() || raw.trim() != raw {
        return invalid(crate::text!(
            "errors.settings.keyFolderSpaces",
            "the key folder must be a path without surrounding spaces"
        ));
    }
    if raw.chars().count() > KEY_FOLDER_MAX_CHARS || raw.chars().any(char::is_control) {
        return invalid(crate::text!(
            "errors.settings.keyFolderInvalid",
            "the key folder path is invalid"
        ));
    }
    let rooted = raw.starts_with('/')
        || raw.starts_with("~/")
        || matches!(raw.as_bytes(), [d, b':', b'\\' | b'/', ..] if d.is_ascii_alphabetic());
    if !rooted || !(raw.starts_with("~/") || is_local_absolute(raw)) {
        return invalid(crate::text!(
            "errors.settings.keyFolderNotLocal",
            "the key folder must be a full local path, or one starting with ~/"
        ));
    }
    Ok(())
}

impl Settings {
    pub fn apply(&mut self, patch: &SettingsPatch) {
        if let Some(theme) = patch.theme {
            self.theme = Some(theme);
        }
        if let Some(language) = patch.language {
            self.language = Some(language);
        }
        if let Some(kind) = patch.default_key_type {
            self.default_key_type = Some(kind);
        }
        if let Some(size) = patch.terminal_font_size {
            self.terminal_font_size = Some(size);
        }
        if let Some(folder) = &patch.key_folder {
            self.key_folder = folder.clone();
        }
    }

    /// Only the values the file does not hold yet; a cleared folder imports nothing.
    pub fn fill(&mut self, patch: &SettingsPatch) {
        self.theme = self.theme.or(patch.theme);
        self.language = self.language.or(patch.language);
        self.default_key_type = self.default_key_type.or(patch.default_key_type);
        self.terminal_font_size = self.terminal_font_size.or(patch.terminal_font_size);
        if self.key_folder.is_none() {
            self.key_folder = patch.key_folder.clone().flatten();
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Lex {
    Code,
    Comment,
    Text { quote: u8, multi: bool },
}

/// Deepest `[`/`{` nesting outside strings and comments, lexed as TOML does: basic strings with
/// escapes, literal strings, and multi-line forms whose closing run may hold up to five quotes
/// (a string seen where the parser sees code would hide brackets from the count). Stops past
/// `MAX_NESTING`.
pub(super) fn nesting(text: &str) -> usize {
    let b = text.as_bytes();
    let run = |i: usize, q: u8| b[i..].iter().take_while(|&&c| c == q).count();
    let (mut lex, mut depth, mut max, mut i) = (Lex::Code, 0usize, 0usize, 0usize);
    while i < b.len() && max <= MAX_NESTING {
        let c = b[i];
        match lex {
            Lex::Code => match c {
                b'#' => lex = Lex::Comment,
                b'"' | b'\'' => {
                    let n = run(i, c);
                    if n >= 3 {
                        lex = Lex::Text {
                            quote: c,
                            multi: true,
                        };
                        i += 2;
                    } else if n == 2 {
                        i += 1;
                    } else {
                        lex = Lex::Text {
                            quote: c,
                            multi: false,
                        };
                    }
                }
                b'[' | b'{' => {
                    depth += 1;
                    max = max.max(depth);
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            },
            Lex::Comment => {
                if c == b'\n' {
                    lex = Lex::Code;
                }
            }
            Lex::Text { quote, multi } => {
                if quote == b'"' && c == b'\\' {
                    i += 1;
                } else if c == quote {
                    let n = run(i, quote);
                    if !multi || n >= 3 {
                        lex = Lex::Code;
                    }
                    if multi {
                        i += n - 1;
                    }
                } else if c == b'\n' && !multi {
                    lex = Lex::Code;
                }
            }
        }
        i += 1;
    }
    max
}

/// `Err` when the text is not a TOML document, or nests deeper than anything the app writes.
pub(super) fn parse_document(text: &str) -> Result<DocumentMut, ()> {
    if nesting(text) > MAX_NESTING {
        return Err(());
    }
    text.parse().map_err(|_| ())
}

#[cfg(test)]
pub(super) fn parse(text: &str) -> Result<Settings, ()> {
    parse_document(text).map(|doc| read(&doc))
}

pub(super) fn read(doc: &DocumentMut) -> Settings {
    let root = doc.as_table();
    let text_of = |key: &str| root.get(key).and_then(Item::as_str);
    Settings {
        theme: text_of("theme").and_then(ThemeMode::from_name),
        language: text_of("language").and_then(Language::from_name),
        default_key_type: text_of("default_key_type").and_then(KeyType::from_name),
        terminal_font_size: root
            .get("terminal_font_size")
            .and_then(Item::as_integer)
            .filter(|&n| is_font_size(n))
            .and_then(|n| u8::try_from(n).ok()),
        key_folder: text_of("key_folder")
            .filter(|f| check_key_folder(f).is_ok())
            .map(str::to_owned),
        legacy_imported: root.get("legacy_imported").and_then(Item::as_bool) == Some(true),
        external_editor: root
            .get("external_editor")
            .and_then(Item::as_table_like)
            .and_then(editor_of),
        analytics: root
            .get("analytics")
            .and_then(Item::as_table_like)
            .map(analytics_of),
    }
}

/// Malformed means unset as a whole, as in the JSON file it came from. `app_path` is not
/// checked here (`config.json` did not either): `check_app` runs before every launch.
fn editor_of(t: &dyn TableLike) -> Option<ExternalEditor> {
    let mode = match t.get("mode")?.as_str()? {
        "system" => EditorMode::System,
        "custom" => EditorMode::Custom,
        _ => return None,
    };
    let app_path = match t.get("app_path") {
        None => None,
        Some(v) => Some(v.as_str()?.to_owned()),
    };
    let notice_seen = match t.get("notice_seen") {
        None => false,
        Some(v) => v.as_bool()?,
    };
    Some(ExternalEditor {
        mode,
        app_path,
        notice_seen,
    })
}

fn analytics_of(t: &dyn TableLike) -> AnalyticsSettings {
    let mut categories = CategoryChoices::default();
    for category in Category::ALL {
        let choice = t
            .get(category.name())
            .and_then(Item::as_table_like)
            .and_then(choice_of)
            .unwrap_or_default();
        categories.set(category, choice);
    }
    AnalyticsSettings { categories }
}

fn choice_of(t: &dyn TableLike) -> Option<CategoryChoice> {
    let consent = match t.get("consent")?.as_str()? {
        "unset" => Consent::Unset,
        "granted" => Consent::Granted,
        "denied" => Consent::Denied,
        _ => return None,
    };
    let version = u32::try_from(t.get("version")?.as_integer()?).ok()?;
    Some(CategoryChoice { consent, version })
}

/// Sets or removes `key`; an existing key keeps its place, its comments and the old value's
/// trailing comment.
fn put(t: &mut dyn TableLike, key: &str, new: Option<Value>) {
    let Some(mut new) = new else {
        t.remove(key);
        return;
    };
    match t.get_mut(key) {
        Some(item) => {
            if let Some(old) = item.as_value() {
                *new.decor_mut() = old.decor().clone();
            }
            *item = Item::Value(new);
        }
        None => {
            t.insert(key, Item::Value(new));
        }
    }
}

/// The table at `key`, created (or replacing a value that is not a table) when needed.
fn table_at<'a>(
    t: &'a mut dyn TableLike,
    key: &str,
    implicit: bool,
) -> Option<&'a mut dyn TableLike> {
    if !t.get(key).is_some_and(Item::is_table_like) {
        let mut table = Table::new();
        table.set_implicit(implicit);
        t.insert(key, Item::Table(table));
    }
    t.get_mut(key).and_then(Item::as_table_like_mut)
}

/// Writes into `doc` only what differs between `before` (what `doc` reads as) and `after`, so
/// comments, key order, unknown keys and values the app could not read stay as they are.
pub(super) fn write(doc: &mut DocumentMut, before: &Settings, after: &Settings) {
    let root = doc.as_table_mut();
    if before.theme != after.theme {
        put(root, "theme", after.theme.map(|t| t.name().into()));
    }
    if before.language != after.language {
        put(root, "language", after.language.map(|l| l.name().into()));
    }
    if before.default_key_type != after.default_key_type {
        let v = after.default_key_type.map(|k| k.name().into());
        put(root, "default_key_type", v);
    }
    if before.terminal_font_size != after.terminal_font_size {
        let v = after.terminal_font_size.map(|n| i64::from(n).into());
        put(root, "terminal_font_size", v);
    }
    if before.key_folder != after.key_folder {
        put(
            root,
            "key_folder",
            after.key_folder.as_deref().map(Value::from),
        );
    }
    if before.legacy_imported != after.legacy_imported {
        put(
            root,
            "legacy_imported",
            after.legacy_imported.then(|| true.into()),
        );
    }
    if before.external_editor != after.external_editor {
        match &after.external_editor {
            None => {
                root.remove("external_editor");
            }
            Some(e) => {
                if let Some(t) = table_at(root, "external_editor", false) {
                    let mode = match e.mode {
                        EditorMode::System => "system",
                        EditorMode::Custom => "custom",
                    };
                    put(t, "mode", Some(mode.into()));
                    put(t, "app_path", e.app_path.as_deref().map(Value::from));
                    put(t, "notice_seen", Some(e.notice_seen.into()));
                }
            }
        }
    }
    let old = before.analytics.unwrap_or_default().categories;
    let new = after.analytics.unwrap_or_default().categories;
    for category in Category::ALL {
        let choice = new.get(category);
        if old.get(category) == choice {
            continue;
        }
        let name = category.name();
        let consent = match choice.consent {
            Consent::Unset => {
                if let Some(t) = root.get_mut("analytics").and_then(Item::as_table_like_mut) {
                    t.remove(name);
                }
                continue;
            }
            Consent::Granted => "granted",
            Consent::Denied => "denied",
        };
        if let Some(t) = table_at(root, "analytics", true).and_then(|a| table_at(a, name, false)) {
            put(t, "consent", Some(consent.into()));
            put(t, "version", Some(i64::from(choice.version).into()));
        }
    }
    if root
        .get("analytics")
        .and_then(Item::as_table_like)
        .is_some_and(|t| t.is_empty())
    {
        root.remove("analytics");
    }
}

/// A new document holding only what is set.
pub(super) fn to_toml(s: &Settings) -> String {
    let mut doc = DocumentMut::new();
    write(&mut doc, &Settings::default(), s);
    doc.to_string()
}

#[cfg(test)]
mod tests;
