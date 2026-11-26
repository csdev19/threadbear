// The colour maths behind Settings > General > Appearance's custom accent and
// the text drawn on an accent fill (docs/specs/custom-theme.md). Plain numbers,
// so it tests without a window.

/// Contrast below which an accent is hard to see as a tick or an outline.
pub const VISIBLE_CONTRAST: f64 = 3.0;
/// White text on an accent needs this much contrast (WCAG's large text and
/// graphics bar), or 4.5 with Increase Contrast on.
pub const WHITE_TEXT_CONTRAST: f64 = 3.0;
pub const WHITE_TEXT_CONTRAST_INCREASED: f64 = 4.5;
/// The text on an accent too light for white: near-black, not pure black.
pub const DARK_TEXT: u32 = 0x1a1a1a;

/// Which colour reads on an accent fill.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnAccent {
    White,
    Dark,
}

impl OnAccent {
    pub fn rgb(self) -> u32 {
        match self {
            OnAccent::White => 0xffffff,
            OnAccent::Dark => DARK_TEXT,
        }
    }
}

/// `#rrggbb` or `rrggbb`, any case, as 0xrrggbb. Anything else (short forms,
/// alpha, signs, spaces inside) is None; spaces around it are ignored.
pub fn parse_hex(text: &str) -> Option<u32> {
    let text = text.trim();
    let digits = text.strip_prefix('#').unwrap_or(text);
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(digits, 16).ok()
}

/// 0xe8006a as "#e8006a", the form the settings file keeps.
pub fn format_hex(rgb: u32) -> String {
    format!("#{:06x}", rgb & 0x00ff_ffff)
}

/// WCAG 2's relative luminance of an sRGB colour, 0 (black) to 1 (white).
pub fn relative_luminance(rgb: u32) -> f64 {
    let channel = |shift: u32| {
        let c = f64::from((rgb >> shift) & 0xff) / 255.;
        if c <= 0.039_28 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

/// WCAG 2's contrast ratio between two colours, 1 to 21.
pub fn contrast_ratio(a: u32, b: u32) -> f64 {
    let (la, lb) = (relative_luminance(a), relative_luminance(b));
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// White when its contrast with the accent reaches 3:1 (4.5:1 with Increase
/// Contrast), else near-black.
pub fn text_on_accent(accent: u32, increase_contrast: bool) -> OnAccent {
    let needed = if increase_contrast {
        WHITE_TEXT_CONTRAST_INCREASED
    } else {
        WHITE_TEXT_CONTRAST
    };
    if contrast_ratio(0xffffff, accent) >= needed {
        OnAccent::White
    } else {
        OnAccent::Dark
    }
}

/// Whether the accent is under 3:1 against the window's background, so ticks
/// and outlines in it are hard to see.
pub fn hard_to_see(accent: u32, background: u32) -> bool {
    contrast_ratio(accent, background) < VISIBLE_CONTRAST
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_takes_six_digits_with_or_without_the_hash() {
        assert_eq!(parse_hex("#E8006A"), Some(0xe8006a));
        assert_eq!(parse_hex("e8006a"), Some(0xe8006a));
        assert_eq!(parse_hex("  #e8006A "), Some(0xe8006a));
        assert_eq!(parse_hex("#000000"), Some(0));
    }

    #[test]
    fn hex_refuses_everything_else() {
        for bad in [
            "",
            "#",
            "#fff",
            "#e8006",
            "#e8006aa",
            "#e8006a80",
            "e8006g",
            "##e8006a",
            "+e8006a",
            "#e8 006a",
            "0xe8006a",
            "#é8006a",
        ] {
            assert_eq!(parse_hex(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn hex_is_written_lowercase_with_a_hash() {
        assert_eq!(format_hex(0xe8006a), "#e8006a");
        assert_eq!(format_hex(0x0000ff), "#0000ff");
        assert_eq!(parse_hex(&format_hex(0x123456)), Some(0x123456));
    }

    #[test]
    fn contrast_matches_the_wcag_figures() {
        assert!((contrast_ratio(0x000000, 0xffffff) - 21.).abs() < 1e-9);
        assert!((contrast_ratio(0x777777, 0x777777) - 1.).abs() < 1e-9);
        // #e8006a: 4.53:1 with white and 4.64:1 on black (the spec says 4.54 and
        // 4.62, rounded a little differently); both clear 4.5.
        assert!((contrast_ratio(0xffffff, 0xe8006a) - 4.53).abs() < 0.01);
        assert!((contrast_ratio(0x000000, 0xe8006a) - 4.64).abs() < 0.01);
        // Honey and Fur already fail with white (2.2 and 2.6).
        assert!((contrast_ratio(0xffffff, 0xe0a33a) - 2.2).abs() < 0.1);
        assert!((contrast_ratio(0xffffff, 0xd69454) - 2.6).abs() < 0.1);
    }

    #[test]
    fn text_on_the_presets_and_the_custom_pink() {
        for dark in [0xe0a33a, 0xd69454] {
            assert_eq!(text_on_accent(dark, false), OnAccent::Dark, "{dark:06x}");
        }
        for white in [0x3e8ed0, 0x8a5cc2, 0xe8006a] {
            assert_eq!(text_on_accent(white, false), OnAccent::White, "{white:06x}");
        }
    }

    #[test]
    fn increase_contrast_asks_for_4_5_to_one_before_white() {
        // 4.53:1 passes both; Sky (3.5:1) loses white once contrast is up.
        assert_eq!(text_on_accent(0xe8006a, true), OnAccent::White);
        assert_eq!(text_on_accent(0x3e8ed0, true), OnAccent::Dark);
        assert_eq!(text_on_accent(0x8a5cc2, true), OnAccent::White);
    }

    #[test]
    fn the_chosen_text_always_reads_on_its_accent() {
        for accent in [0x000000, 0xffffff, 0x777777, 0xe0a33a, 0x1a1aff, 0x00ff00] {
            let text = text_on_accent(accent, false).rgb();
            assert!(contrast_ratio(text, accent) >= 3.0, "{accent:06x}");
        }
    }

    #[test]
    fn a_dark_accent_is_hard_to_see_on_pure_black() {
        assert!(hard_to_see(0x222222, 0x000000));
        assert!(!hard_to_see(0xe8006a, 0x000000));
        // Slate (4.6:1) is fine on the dark grey; a pale yellow is lost on white.
        assert!(!hard_to_see(0x6b7280, 0x1e1e1e));
        assert!(hard_to_see(0xffeeaa, 0xffffff));
    }
}
