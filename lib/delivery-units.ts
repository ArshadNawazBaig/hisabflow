/** Compare reviewed labels without changing the source text retained on a record. */
export function normalizeDeliveryLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * These aliases name the same unit. This function never converts quantities:
 * kilograms stay distinct from tonnes, and an unspecified "ton" stays ambiguous.
 */
export function canonicalDeliveryUnit(value: string): string {
  const unit = normalizeDeliveryLabel(value);
  if (/^(?:t|tonnes?|metric tonnes?|metric tons?)$/.test(unit)) return 't';
  if (/^(?:kg|kilograms?)$/.test(unit)) return 'kg';
  if (/^units?$/.test(unit)) return 'units';
  return unit;
}
