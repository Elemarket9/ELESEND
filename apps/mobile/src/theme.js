/**
 * ELESEND Official Brand Identity Design Tokens
 * 
 * Consistent color palette, typography, spacing, and styling primitives
 * for both Customer and Rider mobile applications.
 */

export const colors = Object.freeze({
  bg: '#101827',          // Midnight Navy (Screen Background)
  surface: '#1A2438',     // Surface Navy (Cards & Navigation)
  card: '#1F2C44',        // Elevated Card Background
  cardBorder: '#2C3E5E',  // Card & Input Border
  primary: '#18C6A5',     // Electric Teal (Primary Actions)
  primaryDark: '#087F69', // Deep Teal (Pressed / Secondary State)
  accent: '#18C6A5',      // Accent Highlights
  warn: '#FFB547',        // Warm Amber (Warnings & Timers)
  text: '#FFFFFF',        // Pure White (Headings & High-contrast Text)
  textMuted: '#94A3B8',   // Slate (Secondary Labels & Placeholders)
  light: '#F8FAFC',       // Cloud White
  line: '#283750',        // Dividers
  danger: '#EF4444',      // Danger Red (Errors, Cancellations, Overdue)
  info: '#38BDF8',        // Information Blue
  success: '#10B981',     // Success Green (Verified OTP, Online)
  chipBg: '#24324B'       // Chip & Badge Background
});

export const typography = Object.freeze({
  h1: { fontSize: 24, fontWeight: '700', color: colors.text },
  h2: { fontSize: 18, fontWeight: '700', color: colors.text },
  h3: { fontSize: 15, fontWeight: '600', color: colors.text },
  body: { fontSize: 14, fontWeight: '400', color: colors.text },
  bodySmall: { fontSize: 12, fontWeight: '400', color: colors.textMuted },
  caption: { fontSize: 11, fontWeight: '500', color: colors.textMuted }
});

export const spacing = Object.freeze({
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24
});

export const radii = Object.freeze({
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  full: 999
});
