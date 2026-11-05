//! Texts of the native OS dialogs (quit confirmation, file pickers), which the page cannot
//! translate. They follow the `language` setting, read when the dialog opens; the OS still
//! draws its own standard buttons.

use std::sync::atomic::{AtomicU8, Ordering};

use crate::config::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Fr,
}

/// The data pickers are replaced by fixed paths in the `e2e-pickers` build.
#[cfg_attr(feature = "e2e-pickers", allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeText {
    QuitTitle,
    QuitMessage,
    QuitConfirm,
    QuitCancel,
    PickEditorApp,
    PickKeyFolder,
    PickKeyFile,
    ExportData,
    ImportData,
    DataFilter,
    AllFilesFilter,
}

impl NativeText {
    #[cfg(test)]
    pub const ALL: [NativeText; 11] = [
        Self::QuitTitle,
        Self::QuitMessage,
        Self::QuitConfirm,
        Self::QuitCancel,
        Self::PickEditorApp,
        Self::PickKeyFolder,
        Self::PickKeyFile,
        Self::ExportData,
        Self::ImportData,
        Self::DataFilter,
        Self::AllFilesFilter,
    ];

    pub fn in_lang(self, lang: Lang) -> &'static str {
        let (en, fr) = match self {
            Self::QuitTitle => ("Quit Carapace", "Quitter Carapace"),
            Self::QuitMessage => (
                "Quit anyway? Unsaved changes will be lost.",
                "Quitter quand même\u{202f}? Les modifications non enregistrées seront perdues.",
            ),
            Self::QuitConfirm => ("Quit", "Quitter"),
            Self::QuitCancel => ("Cancel", "Annuler"),
            Self::PickEditorApp => ("Choose the editor app", "Choisir l’application d’édition"),
            Self::PickKeyFolder => (
                "Choose a folder for the key pair",
                "Choisir un dossier pour la paire de clés",
            ),
            Self::PickKeyFile => (
                "Choose a private key file",
                "Choisir un fichier de clé privée",
            ),
            Self::ExportData => ("Export Carapace data", "Exporter les données Carapace"),
            Self::ImportData => ("Import Carapace data", "Importer des données Carapace"),
            Self::DataFilter => ("Carapace data", "Données Carapace"),
            Self::AllFilesFilter => ("All files", "Tous les fichiers"),
        };
        match lang {
            Lang::En => en,
            Lang::Fr => fr,
        }
    }
}

/// `system` follows the OS locale: French when it starts with `fr`, English otherwise.
pub fn resolve(language: Language, os_locale: Option<&str>) -> Lang {
    match language {
        Language::En => Lang::En,
        Language::Fr => Lang::Fr,
        Language::System => match os_locale {
            Some(l) if l.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("fr")) => Lang::Fr,
            _ => Lang::En,
        },
    }
}

/// The saved choice, kept in memory: the quit dialog opens on the event loop and must not wait
/// on the store's locks. Updated at startup and whenever the settings are read or saved.
static CHOICE: AtomicU8 = AtomicU8::new(0);

pub fn remember(language: Option<Language>) {
    let code = match language.unwrap_or_default() {
        Language::System => 0,
        Language::En => 1,
        Language::Fr => 2,
    };
    CHOICE.store(code, Ordering::Relaxed);
}

fn remembered() -> Language {
    match CHOICE.load(Ordering::Relaxed) {
        1 => Language::En,
        2 => Language::Fr,
        _ => Language::System,
    }
}

pub fn get(text: NativeText) -> &'static str {
    text.in_lang(resolve(remembered(), sys_locale::get_locale().as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_follows_a_french_os_locale_only() {
        for (locale, lang) in [
            (Some("fr"), Lang::Fr),
            (Some("fr-FR"), Lang::Fr),
            (Some("FR-ca"), Lang::Fr),
            (Some("fr_BE"), Lang::Fr),
            (Some("en-US"), Lang::En),
            (Some("de-DE"), Lang::En),
            (Some("f"), Lang::En),
            (Some(""), Lang::En),
            (None, Lang::En),
        ] {
            assert_eq!(resolve(Language::System, locale), lang, "{locale:?}");
        }
    }

    #[test]
    fn an_explicit_language_wins_over_the_os() {
        assert_eq!(resolve(Language::En, Some("fr-FR")), Lang::En);
        assert_eq!(resolve(Language::Fr, Some("en-US")), Lang::Fr);
        assert_eq!(resolve(Language::Fr, None), Lang::Fr);
    }

    #[test]
    fn every_text_has_both_languages() {
        for text in NativeText::ALL {
            let (en, fr) = (text.in_lang(Lang::En), text.in_lang(Lang::Fr));
            assert!(!en.is_empty() && !fr.is_empty(), "{text:?}");
            assert_ne!(en, fr, "{text:?}");
        }
        assert_eq!(NativeText::QuitTitle.in_lang(Lang::En), "Quit Carapace");
        assert_eq!(
            NativeText::QuitMessage.in_lang(Lang::Fr),
            "Quitter quand même\u{202f}? Les modifications non enregistrées seront perdues."
        );
    }

    #[test]
    fn the_remembered_choice_wins_over_the_os() {
        remember(Some(Language::Fr));
        assert_eq!(remembered(), Language::Fr);
        assert_eq!(get(NativeText::DataFilter), "Données Carapace");
        remember(Some(Language::En));
        assert_eq!(get(NativeText::DataFilter), "Carapace data");
        remember(None);
        assert_eq!(remembered(), Language::System);
    }
}
