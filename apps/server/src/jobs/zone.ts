// An IANA time zone as Philobiblos accepts it (PHILOBIBLOS_TZ, Settings' cycle): no imports, so config.ts can read it.
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
