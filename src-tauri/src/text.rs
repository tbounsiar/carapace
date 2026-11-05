//! User-facing texts sent to the interface: a stable key the frontend translates, the values it
//! interpolates, and the English text kept for logs and as a fallback.

use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Text {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<&'static str>,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    pub message: String,
}

impl Text {
    pub fn new(key: &'static str, message: String, params: Vec<(&'static str, Value)>) -> Self {
        Self {
            key: Some(key),
            params: params
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect(),
            message,
        }
    }

    /// A text without a translation key; the interface shows the English message.
    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            key: None,
            params: Map::new(),
            message: message.into(),
        }
    }
}

impl fmt::Display for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for Text {
    fn from(message: String) -> Self {
        Self::plain(message)
    }
}

impl From<&str> for Text {
    fn from(message: &str) -> Self {
        Self::plain(message)
    }
}

pub fn param<T: Serialize + ?Sized>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Error types whose variants carry a translated text. The default keeps the English `Display`.
pub trait Localized: fmt::Display {
    fn text(&self) -> Text {
        Text::plain(self.to_string())
    }
}

/// `text!("errors.area.name", "English with {arg}", arg = value)`. The English uses `format!`
/// syntax with named arguments only; every argument is also sent as a parameter under its name,
/// so the translations use the same names (`{arg}` in ICU). Never pass a secret.
#[macro_export]
macro_rules! text {
    ($key:literal, $english:literal $(, $name:ident = $value:expr)* $(,)?) => {{
        $(
            #[allow(clippy::redundant_locals)]
            let $name = $value;
        )*
        $crate::text::Text::new(
            $key,
            format!($english),
            vec![$((stringify!($name), $crate::text::param(&$name))),*],
        )
    }};
}

#[cfg(test)]
mod tests;
