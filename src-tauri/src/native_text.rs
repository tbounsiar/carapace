//! Texts of the native OS dialogs (quit confirmation, file pickers), which the page cannot
//! translate. They follow the `language` setting, read when the dialog opens; the OS still
//! draws its own standard buttons.

use std::sync::atomic::{AtomicU8, Ordering};

use crate::config::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Fr,
    De,
    Es,
    PtBr,
    ZhCn,
}

impl Lang {
    #[cfg(test)]
    const ALL: [Lang; 6] = [
        Self::En,
        Self::Fr,
        Self::De,
        Self::Es,
        Self::PtBr,
        Self::ZhCn,
    ];
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
        let [en, fr, de, es, pt_br, zh_cn] = match self {
            Self::QuitTitle => [
                "Quit Carapace",
                "Quitter Carapace",
                "Carapace beenden",
                "Salir de Carapace",
                "Sair do Carapace",
                "退出 Carapace",
            ],
            Self::QuitMessage => [
                "Quit anyway? Unsaved changes will be lost.",
                "Quitter quand même\u{202f}? Les modifications non enregistrées seront perdues.",
                "Trotzdem beenden? Nicht gespeicherte Änderungen gehen verloren.",
                "¿Salir de todos modos? Se perderán los cambios no guardados.",
                "Sair mesmo assim? As alterações não salvas serão perdidas.",
                "仍要退出吗？未保存的更改将会丢失。",
            ],
            Self::QuitConfirm => ["Quit", "Quitter", "Beenden", "Salir", "Sair", "退出"],
            Self::QuitCancel => [
                "Cancel",
                "Annuler",
                "Abbrechen",
                "Cancelar",
                "Cancelar",
                "取消",
            ],
            Self::PickEditorApp => [
                "Choose the editor app",
                "Choisir l’application d’édition",
                "Editor-App auswählen",
                "Elegir la aplicación de edición",
                "Escolher o aplicativo de edição",
                "选择编辑器应用",
            ],
            Self::PickKeyFolder => [
                "Choose a folder for the key pair",
                "Choisir un dossier pour la paire de clés",
                "Ordner für das Schlüsselpaar auswählen",
                "Elegir una carpeta para el par de claves",
                "Escolher uma pasta para o par de chaves",
                "选择密钥对的文件夹",
            ],
            Self::PickKeyFile => [
                "Choose a private key file",
                "Choisir un fichier de clé privée",
                "Datei mit privatem Schlüssel auswählen",
                "Elegir un archivo de clave privada",
                "Escolher um arquivo de chave privada",
                "选择私钥文件",
            ],
            Self::ExportData => [
                "Export Carapace data",
                "Exporter les données Carapace",
                "Carapace-Daten exportieren",
                "Exportar datos de Carapace",
                "Exportar dados do Carapace",
                "导出 Carapace 数据",
            ],
            Self::ImportData => [
                "Import Carapace data",
                "Importer des données Carapace",
                "Carapace-Daten importieren",
                "Importar datos de Carapace",
                "Importar dados do Carapace",
                "导入 Carapace 数据",
            ],
            Self::DataFilter => [
                "Carapace data",
                "Données Carapace",
                "Carapace-Daten",
                "Datos de Carapace",
                "Dados do Carapace",
                "Carapace 数据",
            ],
            Self::AllFilesFilter => [
                "All files",
                "Tous les fichiers",
                "Alle Dateien",
                "Todos los archivos",
                "Todos os arquivos",
                "所有文件",
            ],
        };
        match lang {
            Lang::En => en,
            Lang::Fr => fr,
            Lang::De => de,
            Lang::Es => es,
            Lang::PtBr => pt_br,
            Lang::ZhCn => zh_cn,
        }
    }
}

pub fn resolve(language: Language, os_locale: Option<&str>) -> Lang {
    match language {
        Language::En => Lang::En,
        Language::Fr => Lang::Fr,
        Language::De => Lang::De,
        Language::Es => Lang::Es,
        Language::PtBr => Lang::PtBr,
        Language::ZhCn => Lang::ZhCn,
        Language::System => os_locale.map_or(Lang::En, from_locale),
    }
}

/// The UX spec's `system` rule, shared with the page: only the primary subtag counts, compared
/// whole (`frr` is North Frisian, `zha` Zhuang). Traditional Chinese gets English, not Simplified.
fn from_locale(locale: &str) -> Lang {
    let tag = locale.split(['.', '@']).next().unwrap_or_default();
    let lower = tag.to_ascii_lowercase();
    let mut subtags = lower.split(['-', '_']);
    match subtags.next().unwrap_or_default() {
        "fr" => Lang::Fr,
        "de" => Lang::De,
        "es" => Lang::Es,
        "pt" => Lang::PtBr,
        "zh" => match subtags.next() {
            Some("hans" | "chs") => Lang::ZhCn,
            Some("hant" | "cht" | "tw" | "hk" | "mo") => Lang::En,
            _ => Lang::ZhCn,
        },
        _ => Lang::En,
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
        Language::De => 3,
        Language::Es => 4,
        Language::PtBr => 5,
        Language::ZhCn => 6,
    };
    CHOICE.store(code, Ordering::Relaxed);
}

fn remembered() -> Language {
    match CHOICE.load(Ordering::Relaxed) {
        1 => Language::En,
        2 => Language::Fr,
        3 => Language::De,
        4 => Language::Es,
        5 => Language::PtBr,
        6 => Language::ZhCn,
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
    fn system_follows_the_os_locale_by_its_primary_subtag() {
        for (locale, lang) in [
            (Some("fr"), Lang::Fr),
            (Some("fr-FR"), Lang::Fr),
            (Some("FR-ca"), Lang::Fr),
            (Some("fr_BE"), Lang::Fr),
            (Some("fr_FR.UTF-8@euro"), Lang::Fr),
            (Some("frr"), Lang::En),
            (Some("frr-DE"), Lang::En),
            (Some("f"), Lang::En),
            (Some("de"), Lang::De),
            (Some("de-DE"), Lang::De),
            (Some("de-AT"), Lang::De),
            (Some("de-CH"), Lang::De),
            (Some("de_DE@euro"), Lang::De),
            (Some("del"), Lang::En),
            (Some("es"), Lang::Es),
            (Some("es-ES"), Lang::Es),
            (Some("es-419"), Lang::Es),
            (Some("es_MX.UTF-8"), Lang::Es),
            (Some("est"), Lang::En),
            (Some("pt"), Lang::PtBr),
            (Some("pt-BR"), Lang::PtBr),
            (Some("pt-PT"), Lang::PtBr),
            (Some("pt_BR.utf8"), Lang::PtBr),
            (Some("zh"), Lang::ZhCn),
            (Some("zh-CN"), Lang::ZhCn),
            (Some("zh_CN.UTF-8"), Lang::ZhCn),
            (Some("zh-SG"), Lang::ZhCn),
            (Some("zh-MY"), Lang::ZhCn),
            (Some("zh-US"), Lang::ZhCn),
            (Some("zh-Hans"), Lang::ZhCn),
            (Some("zh-Hans-CN"), Lang::ZhCn),
            (Some("zh-Hans-HK"), Lang::ZhCn),
            (Some("zh-CHS"), Lang::ZhCn),
            (Some("zh-TW"), Lang::En),
            (Some("zh_TW.UTF-8"), Lang::En),
            (Some("zh-HK"), Lang::En),
            (Some("zh-MO"), Lang::En),
            (Some("zh-Hant"), Lang::En),
            (Some("zh-Hant-TW"), Lang::En),
            (Some("zh-Hant-HK"), Lang::En),
            (Some("ZH-hant-cn"), Lang::En),
            (Some("zh-CHT"), Lang::En),
            (Some("zha"), Lang::En),
            (Some("en-US"), Lang::En),
            (Some("en_GB.UTF-8"), Lang::En),
            (Some("nl-NL"), Lang::En),
            (Some("ja-JP"), Lang::En),
            (Some("C"), Lang::En),
            (Some("C.UTF-8"), Lang::En),
            (Some("POSIX"), Lang::En),
            (Some(""), Lang::En),
            (Some("-"), Lang::En),
            (None, Lang::En),
        ] {
            assert_eq!(resolve(Language::System, locale), lang, "{locale:?}");
        }
    }

    #[test]
    fn an_explicit_language_wins_over_the_os() {
        for (language, lang) in [
            (Language::En, Lang::En),
            (Language::Fr, Lang::Fr),
            (Language::De, Lang::De),
            (Language::Es, Lang::Es),
            (Language::PtBr, Lang::PtBr),
            (Language::ZhCn, Lang::ZhCn),
        ] {
            for os in [Some("fr-FR"), Some("zh-TW"), Some("en-US"), None] {
                assert_eq!(resolve(language, os), lang, "{language:?} {os:?}");
            }
        }
    }

    #[test]
    fn every_text_has_all_six_languages() {
        for text in NativeText::ALL {
            let en = text.in_lang(Lang::En);
            for lang in Lang::ALL {
                let s = text.in_lang(lang);
                assert!(!s.is_empty(), "{text:?} {lang:?}");
                assert_eq!(s.trim(), s, "{text:?} {lang:?}");
                if lang != Lang::En {
                    assert_ne!(s, en, "{text:?} {lang:?}");
                }
            }
        }
        assert_eq!(NativeText::QuitTitle.in_lang(Lang::En), "Quit Carapace");
        assert_eq!(
            NativeText::QuitMessage.in_lang(Lang::Fr),
            "Quitter quand même\u{202f}? Les modifications non enregistrées seront perdues."
        );
        assert_eq!(NativeText::QuitConfirm.in_lang(Lang::De), "Beenden");
        assert_eq!(NativeText::QuitCancel.in_lang(Lang::ZhCn), "取消");
    }

    #[test]
    fn chinese_texts_use_full_width_punctuation_and_spaces_around_latin_words() {
        for text in NativeText::ALL {
            let s = text.in_lang(Lang::ZhCn);
            assert!(!s.contains(['?', ',', ':', '!', '(', ')']), "{text:?}");
            if let Some(i) = s.find("Carapace") {
                let after = &s[i + "Carapace".len()..];
                assert!(after.is_empty() || after.starts_with(' '), "{text:?}");
                assert!(i == 0 || s[..i].ends_with(' '), "{text:?}");
            }
        }
    }

    #[test]
    fn the_remembered_choice_wins_over_the_os() {
        for language in Language::ALL {
            remember(Some(language));
            assert_eq!(remembered(), language);
        }
        remember(Some(Language::Fr));
        assert_eq!(get(NativeText::DataFilter), "Données Carapace");
        remember(Some(Language::De));
        assert_eq!(get(NativeText::DataFilter), "Carapace-Daten");
        remember(Some(Language::ZhCn));
        assert_eq!(get(NativeText::DataFilter), "Carapace 数据");
        remember(Some(Language::En));
        assert_eq!(get(NativeText::DataFilter), "Carapace data");
        remember(None);
        assert_eq!(remembered(), Language::System);
    }
}
