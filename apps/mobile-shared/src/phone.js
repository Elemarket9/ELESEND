/**
 * ELESEND Ghanaian Mobile Phone Utility
 * 
 * Normalizes local and international phone input to standard E.164 (+233...).
 * Supports MTN (024, 054, 055, 059), Telecel (020, 050), and AT (027, 057, 026).
 */

export function normalizeGhanaPhone(input) {
  if (!input || typeof input !== 'string') return '';
  const digits = input.replace(/[\s()-]/g, '');
  if (digits.startsWith('+233')) return digits;
  if (digits.startsWith('233')) return `+${digits}`;
  if (digits.startsWith('0')) return `+233${digits.slice(1)}`;
  return digits;
}

export function isValidGhanaPhone(input) {
  const normalized = normalizeGhanaPhone(input);
  return /^\+233[25]\d{8}$/.test(normalized);
}

export function formatGhanaDisplayPhone(input) {
  const normalized = normalizeGhanaPhone(input);
  if (!/^\+233[25]\d{8}$/.test(normalized)) return input || '';
  // Format as: +233 24 123 4567
  return `${normalized.slice(0, 4)} ${normalized.slice(4, 6)} ${normalized.slice(6, 9)} ${normalized.slice(9)}`;
}
