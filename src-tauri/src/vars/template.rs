use thiserror::Error;

pub const MAX_TEMPLATE_CHARS: usize = 1024;
pub const MAX_NAME_CHARS: usize = 64;

/// `[A-Za-z_][A-Za-z0-9_.-]{0,63}`: never contains `/`, so it is safe inside a keychain account.
pub fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && name.len() <= MAX_NAME_CHARS
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment<'a> {
    Literal(String),
    Reference(&'a str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum TemplateError {
    #[error("is longer than 1024 characters")]
    TooLong,
    #[error("has a malformed ${{...}} reference (write $$ for a literal $)")]
    Malformed,
}

/// `${name}` is a reference and `$$` a literal `$`. Any other `$` is literal, except `${`,
/// which must open a valid reference: a typo such as `${user` is reported instead of being
/// sent to the server as text.
pub fn parse(template: &str) -> Result<Vec<Segment<'_>>, TemplateError> {
    if template.chars().count() > MAX_TEMPLATE_CHARS {
        return Err(TemplateError::TooLong);
    }
    let mut out = Vec::new();
    let mut literal = String::new();
    let mut rest = template;
    while let Some(i) = rest.find('$') {
        literal.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        if let Some(r) = after.strip_prefix('$') {
            literal.push('$');
            rest = r;
        } else if let Some(r) = after.strip_prefix('{') {
            let end = r.find('}').ok_or(TemplateError::Malformed)?;
            let name = &r[..end];
            if !is_valid_name(name) {
                return Err(TemplateError::Malformed);
            }
            if !literal.is_empty() {
                out.push(Segment::Literal(std::mem::take(&mut literal)));
            }
            out.push(Segment::Reference(name));
            rest = &r[end + 1..];
        } else {
            literal.push('$');
            rest = after;
        }
    }
    literal.push_str(rest);
    if !literal.is_empty() {
        out.push(Segment::Literal(literal));
    }
    Ok(out)
}

pub fn has_references(segments: &[Segment<'_>]) -> bool {
    segments.iter().any(|s| matches!(s, Segment::Reference(_)))
}

/// The name if `template` is exactly one `${name}` and nothing else.
pub fn single_reference(template: &str) -> Option<&str> {
    match parse(template).ok()?.as_slice() {
        [Segment::Reference(name)] => Some(name),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Segment::*;

    fn lit(s: &str) -> Segment<'_> {
        Literal(s.into())
    }

    #[test]
    fn names() {
        for good in ["a", "_", "A_b.c-d9", "host", "x.y", &"a".repeat(64)] {
            assert!(is_valid_name(good), "{good}");
        }
        for bad in [
            "",
            "9a",
            ".a",
            "-a",
            "a b",
            "a/b",
            "a}",
            "a$",
            "é",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn plain_text_is_one_literal() {
        assert_eq!(parse("example.com").unwrap(), vec![lit("example.com")]);
        assert_eq!(parse("").unwrap(), vec![]);
    }

    #[test]
    fn references_and_literals_interleave() {
        assert_eq!(
            parse("${user}@${host}:22").unwrap(),
            vec![Reference("user"), lit("@"), Reference("host"), lit(":22")]
        );
        assert_eq!(
            parse("${a}${b}").unwrap(),
            vec![Reference("a"), Reference("b")]
        );
    }

    #[test]
    fn dollar_escapes() {
        assert_eq!(parse("$$").unwrap(), vec![lit("$")]);
        assert_eq!(parse("$${x}").unwrap(), vec![lit("${x}")]);
        assert_eq!(parse("a$$$${x}").unwrap(), vec![lit("a$${x}")]);
        assert_eq!(parse("$$${x}").unwrap(), vec![lit("$"), Reference("x")]);
    }

    #[test]
    fn other_dollars_are_literal() {
        assert_eq!(parse("$").unwrap(), vec![lit("$")]);
        assert_eq!(parse("a$b").unwrap(), vec![lit("a$b")]);
        assert_eq!(parse("pc$").unwrap(), vec![lit("pc$")]);
        assert_eq!(parse("$(x)").unwrap(), vec![lit("$(x)")]);
    }

    #[test]
    fn malformed_references_are_errors() {
        for bad in ["${", "${x", "${}", "${a b}", "${9}", "a${x/y}b", "${x${y}}"] {
            assert_eq!(parse(bad), Err(TemplateError::Malformed), "{bad}");
        }
    }

    #[test]
    fn length_limit_counts_characters() {
        assert!(parse(&"é".repeat(MAX_TEMPLATE_CHARS)).is_ok());
        assert_eq!(
            parse(&"a".repeat(MAX_TEMPLATE_CHARS + 1)),
            Err(TemplateError::TooLong)
        );
    }

    #[test]
    fn single_reference_only_matches_a_bare_reference() {
        assert_eq!(single_reference("${pw}"), Some("pw"));
        for no in ["", "pw", " ${pw}", "${pw} ", "${a}${b}", "$${pw}", "${pw"] {
            assert_eq!(single_reference(no), None, "{no}");
        }
    }

    #[test]
    fn has_references_detects_any() {
        assert!(has_references(&parse("a${b}").unwrap()));
        assert!(!has_references(&parse("a$${b}").unwrap()));
    }
}
