/**
 * Normalises a Rwandan mobile number to E.164 (+2507xxxxxxxx).
 * Accepts 07xxxxxxxx, 2507xxxxxxxx, +2507xxxxxxxx, or 7xxxxxxxx.
 * Africa's Talking (SMS) and payment providers both require E.164 - a bare
 * "0788..." gets rejected with an opaque "To is invalid" style error.
 */
export function normalisePhone(input: string): string | null {
  const digits = String(input).replace(/[^\d]/g, '');
  if (/^07\d{8}$/.test(digits)) return `+25${digits}`;
  if (/^2507\d{8}$/.test(digits)) return `+${digits}`;
  if (/^7\d{8}$/.test(digits)) return `+250${digits}`;
  return null;
}
