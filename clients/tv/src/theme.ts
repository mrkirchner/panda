/**
 * Design tokens. Colors are 0xRRGGBBAA numbers, the Lightning renderer's native format.
 *
 * Palette rules: backgrounds are near-neutral so artwork keeps its true colors; scrims over
 * images are black (never tinted); focus is a white fill with dark text (readable on any
 * artwork); one accent color, used sparingly (primary action, progress, selection).
 */
export interface Palette {
  /** App background. */
  background: number;
  /** Cards, rows, inputs. */
  surface: number;
  /** Raised sheets (keyboard, menus), a step lighter than surface. */
  raised: number;
  /** Glass panels over content (menus), slightly translucent. */
  panel: number;
  /** Hairlines and the grooves between keyboard keys. */
  line: number;
  text: number;
  /** Secondary text: metadata, captions. */
  textMuted: number;
  focusFill: number;
  focusText: number;
  /** The one accent: primary actions, progress bars, selection marks. */
  accent: number;
  /** Text on the accent. */
  accentText: number;
  error: number;
  /** Something needs attention but nothing broke (e.g. a library offline). */
  warning: number;
  success: number;
}

/**
 * The palette ("Onyx gold"): near-black with warm whites and a soft champagne-gold accent.
 * Quiet and premium, and it leaves the color to the artwork.
 */
const p: Palette = {
  background: 0x0d0d0fff,
  surface: 0x1a1a1dff,
  raised: 0x242427ff,
  panel: 0x1a1a1df2,
  line: 0x08080aff,
  text: 0xf4f1eaff,
  textMuted: 0xa39e95ff,
  focusFill: 0xf4f1eaff,
  focusText: 0x141210ff,
  accent: 0xd4ae6aff,
  accentText: 0x141210ff,
  error: 0xff6b5bff,
  warning: 0xf5a524ff,
  success: 0x4cc38aff,
};

export const theme = {
  screen: { width: 1920, height: 1080, gutter: 80 },
  color: {
    ...p,
    /** Unfocused buttons on top of artwork: neutral white glass, works on any image. */
    chip: 0xffffff29,
    /** Kept for older call sites: the accent. */
    surfaceFocus: p.accent,
    /** Scrims over artwork are always black so images keep their colors. */
    shadow: 0x000000ff,
  },
  /**
   * Glass (tvOS style, without blur: the renderer has none and TVs couldn't afford it).
   * Translucent white over the dark base, a hairline light edge, and a dark glass for overlays.
   */
  glass: {
    /** Resting rows, fields, keys. */
    thin: 0xffffff14,
    /** Buttons and chips over artwork. */
    regular: 0xffffff29,
    /** Selected (not focused) tabs and items. */
    thick: 0xffffff3d,
    /** Hairline edge that makes glass read as a pane. */
    edge: 0xffffff26,
    /** Overlays above content (menus, keyboard sheet): dark and mostly opaque. */
    panel: ((p.surface & 0xffffff00) | 0xeb) >>> 0,
  },
  /** Gap between a page's tab bar and the tab's content (room for a focused item's ring). */
  tabContentTop: 26,
  /** Corner radii: one scale for everything (pills use height / 2). */
  radius: { xs: 4, sm: 12, md: 16, lg: 24, xl: 32 },
  /** Focus feedback shared by every focusable: ring outside the shape, grow, ease. */
  focus: {
    ringWidth: 4,
    ringWidthRound: 6,
    offset: 6,
    scale: 1.08,
    scaleWide: 1.04,
    duration: 160,
    expandDuration: 240,
  },
  /** Spacing, the same everywhere: `item` between things side by side (buttons, chips, tabs,
   * cards: room for a focused one's grow and ring), `block` between a page's stacked parts and
   * in grids (cards grow every way), `list` between rows of a settings list or form. Text inside a block keeps its own line spacing. */
  space: { item: 40, block: 48, list: 24 },
  tile: { width: 240, height: 360, gap: 40, radius: 16 },
  font: { title: 56, heading: 36, body: 28, caption: 24, subtitle: 46 },
} as const;

/**
 * Home's genre tiles: each genre's artwork is washed in its own color (multiplied into the
 * image, like a duotone), so the row reads as a set of distinct moods. Unlisted genres take the
 * accent.
 */
const GENRE_TINTS: Record<string, number> = {
  Action: 0xff9a6aff,
  "Action & Adventure": 0xff9a6aff,
  Adventure: 0xffc078ff,
  Animation: 0xffd970ff,
  Comedy: 0x8ff0c8ff,
  Crime: 0xb9a0ffff,
  Documentary: 0xd9c2a8ff,
  Drama: 0x84aef5ff,
  Family: 0xffb0d0ff,
  Fantasy: 0xc6a8ffff,
  History: 0xe0c89aff,
  Horror: 0xffa040ff,
  Kids: 0xffd0a0ff,
  Music: 0xff8fc0ff,
  Mystery: 0x8f9bffff,
  Reality: 0xffe08aff,
  Romance: 0xff9fb8ff,
  "Science Fiction": 0x7fd8ffff,
  "Sci-Fi & Fantasy": 0x7fd8ffff,
  Thriller: 0xff8080ff,
  War: 0xc8c890ff,
  Western: 0xe8b080ff,
};
export const genreTint = (genre: string) => GENRE_TINTS[genre] ?? theme.color.accent;

/** `c` with its alpha replaced (0-255). */
export const withAlpha = (c: number, a: number) => ((c & 0xffffff00) | a) >>> 0;

/** The glass hairline edge while resting; none while focused (the focus ring takes over). */
export const glassEdge = (show: boolean) =>
  show ? { width: 2, color: theme.glass.edge } : { width: 0, color: 0x00000000 };
