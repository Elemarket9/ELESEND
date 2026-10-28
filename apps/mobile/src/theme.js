/**
 * ELESEND Official Brand Identity Design Tokens
 * 
 * Consistent color palette, typography, spacing, and styling primitives
 * for both Customer and Rider mobile applications.
 * 
 * Supports both high-contrast modern light theme (inspired by top-tier transit/delivery UX)
 * and deep midnight contrast tokens while preserving all existing token invariants.
 */

export const colors = Object.freeze({
  // Preserved Core Invariants (Tested in mobile-apps-contract.test.mjs)
  bg: '#101827',          // Midnight Navy (Legacy / Contrast Screen Background)
  surface: '#1A2438',     // Surface Navy (Legacy Cards & Navigation)
  card: '#1F2C44',        // Elevated Card Background
  cardBorder: '#2C3E5E',  // Card & Input Border
  primary: '#18C6A5',     // Electric Teal (ELESEND Primary Brand)
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
  chipBg: '#24324B',      // Chip & Badge Background

  // Modern Light Theme Tokens (Yango-Class UI/UX Transformation)
  canvas: '#F8FAFC',          // Soft Off-White Clean Canvas
  sheetBg: '#FFFFFF',         // Crisp White Floating Bottom Sheets
  sheetHandle: '#CBD5E1',     // Subtle Grab Bar Pill
  surfaceLight: '#FFFFFF',    // Pure White Card Surfaces
  surfaceSubtle: '#F1F5F9',   // Light Gray Action Badges & Input Backgrounds
  borderLight: '#E2E8F0',     // Hairline Card & Input Dividers
  borderSubtle: '#F1F5F9',    // Soft Inner Dividers
  textDark: '#0F172A',        // Deep Charcoal / Near Black for Maximum Legibility
  textSecondary: '#475569',   // Slate Secondary Body Text
  textTertiary: '#64748B',    // Muted Captions & Microcopy
  textPlaceholder: '#94A3B8', // Neutral Form Placeholder
  
  // Vibrant Brand & Action Colors
  brandCoral: '#FF5A36',      // Yango/ELESEND Primary Action CTA (Order, Book, Submit)
  brandCoralDark: '#E04826',  // Pressed Coral State
  brandTeal: '#18C6A5',       // ELESEND Signature Teal Accent
  brandTealDark: '#087F69',   // Deep Signature Teal
  brandDark: '#0B132B',       // Deep Blue-Black Brand Header
  cashGreen: '#22C55E',       // Cash Icon Green Accent
  cashGreenBg: '#DCFCE7',     // Cash Badge Background
  ratingGreen: '#10B981',     // High Rating Indicator
  badgeYellow: '#FEF08A',     // Promotional / Highlight Badge
  badgeYellowText: '#854D0E', // Promotional Text

  // Input & Interactive States
  inputBg: '#F8FAFC',
  inputBorderFocused: '#0F172A',
  actionGrey: '#E2E8F0',
  actionGreyHover: '#CBD5E1'
});

export const typography = Object.freeze({
  // Headings
  hero: { fontSize: 28, fontWeight: '800', color: colors.textDark, letterSpacing: -0.5 },
  h1: { fontSize: 24, fontWeight: '800', color: colors.textDark, letterSpacing: -0.3 },
  h2: { fontSize: 19, fontWeight: '700', color: colors.textDark, letterSpacing: -0.2 },
  h3: { fontSize: 16, fontWeight: '700', color: colors.textDark },
  h4: { fontSize: 14, fontWeight: '600', color: colors.textDark },
  
  // Body & Inputs
  bodyLarge: { fontSize: 15, fontWeight: '400', color: colors.textDark, lineHeight: 22 },
  body: { fontSize: 14, fontWeight: '400', color: colors.textDark, lineHeight: 20 },
  bodyMedium: { fontSize: 14, fontWeight: '500', color: colors.textDark },
  bodySemiBold: { fontSize: 14, fontWeight: '600', color: colors.textDark },
  bodySmall: { fontSize: 12, fontWeight: '400', color: colors.textSecondary, lineHeight: 17 },
  bodySmallMedium: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  caption: { fontSize: 11, fontWeight: '500', color: colors.textTertiary },
  
  // Brand Condensed & Display (Yango-Style Headers)
  displayBold: { fontSize: 22, fontWeight: '900', color: colors.textDark, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionTitle: { fontSize: 17, fontWeight: '800', color: colors.textDark },
  priceBig: { fontSize: 22, fontWeight: '800', color: colors.textDark, letterSpacing: -0.5 },
  priceMedium: { fontSize: 16, fontWeight: '800', color: colors.textDark }
});

export const spacing = Object.freeze({
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32
});

export const radii = Object.freeze({
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  sheet: 24,
  card: 18,
  pill: 999,
  full: 999
});

export const shadows = Object.freeze({
  card: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3
  },
  floating: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8
  },
  bottomSheet: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 12
  }
});
