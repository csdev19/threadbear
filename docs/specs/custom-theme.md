# Custom accent and pure black (desktop Appearance)

## In one minute

Settings > General > Appearance gets two additions, keeping its current shape:
a **Custom** accent the user sets by hex, and a **Pure black** switch for the dark
look. Text drawn on the accent picks white or black by contrast, so a light accent
never leaves an unreadable button. Both are per device, desktop app only.

| Decision | Why | ADR |
| --- | --- | --- |
| A tenth dot, Custom, at the end of the accent row, opening the vendored `gpui-component` ColorPicker (hex field and palette) | One control in a row that stays clean; the picker already ships in `desktop/vendor`; works on every OS | none |
| The custom hex is kept on its own (`accentCustom`), apart from `accent: "custom"` | Switching to a preset and back keeps the colour | none |
| Pure black is a switch under the three look pictures, applied whenever dark shows (Dark, or Same as the Mac at night) | A fourth picture would lose "follow the system" | none |
| Text on the accent is white when it reaches 3:1 against the accent, black otherwise; 4.5:1 with Increase Contrast on | Honey (2.2:1) and Fur (2.6:1) already fail with white today; blue-ish accents keep white | none |
| A non-blocking line under the picker when the accent is under 3:1 against the window background in use | A dark hex on pure black hides ticks and outlines | none |
| Per device, desktop only (`desktop-settings.json`) | Same as the rest of Appearance; the website has its own light and dark, Android none | none |
| No experiment flag | Both are off until the user turns them on, and change nothing else | none |

Out of scope: named theme presets, syncing through Convex, the website and the
phone apps, the frozen Swift app (`app/`).

Open questions: none. Cristian picked #E8006A (his logo pink #FF2689 deepened to
4.53:1 with white text, 4.64:1 on pure black) as his custom value.

## Detail

### Custom accent

- `style::Accent` gains `Custom`. Its colour is the saved hex; with none saved yet
  it opens the picker on the current accent's colour.
- The dot shows the custom colour once one is set, and a neutral "+" ring before.
  Tooltip: "Pick your own accent colour".
- The picker's hex field accepts `#rrggbb` and `rrggbb`. Anything else leaves the
  previous accent in place. Each valid pick applies at once and is saved.
- Everything `style::accent` and `style::control_accent` paint follows, as a preset
  does today: buttons, ticks, the needs-you outline, the tint behind your own
  messages (`bubble_background`), focus rings and the kit's `primary` colours.
- Settings file: `accent: "custom"`, `accentCustom: "#e8006a"`. An older build reads
  `"custom"` as unknown and falls back to the system accent.

### Text on the accent

- One function decides it from WCAG relative luminance: white when white's contrast
  with the accent is at least 3:1 (4.5:1 with Increase Contrast), else near-black.
- It replaces the white drawn on accent fills (the send button, the kit's
  `primary_foreground`), for presets and the custom colour alike.

### Pure black

- Saved as `pureBlack: true`. With it on, the dark theme's background and sidebar
  are #000000 and popovers #111111, the values in t3code's dark theme
  (`apps/web/src/index.css`, read 26 Nov 2026). Light is unchanged.
- Card and hover fills are translucent white, and the selected sidebar row is a
  translucent accent, so all of them darken with the background without new values.
- The dark look picture in Settings previews black when the switch is on.
- Increase Contrast keeps strengthening text and borders on top of it.

### Acceptance criteria

- AC1: picking Custom and entering `#E8006A` paints buttons, ticks, the needs-you
  outline and the message tint pink, and survives a relaunch.
- AC2: switching to Plum and back to Custom brings back `#E8006A`.
- AC3: an invalid hex changes nothing.
- AC4: Honey and Fur draw dark text on accent buttons; Sky, Plum and #E8006A white.
- AC5: Pure black on, Dark look: window and sidebar are #000000; off, they are the
  system dark grey again. In Same as the Mac, it applies only while the system is dark.
- AC6: a custom accent under 3:1 on the current background shows the warning line.
- AC7: `features/settings.feature` covers AC1, AC2 and AC5; `docs/guide.md`
  describes both.
