/**
 * Delivery rate = delivered / sent, served beside the two counts it divides.
 *
 * A displayed rate belongs to the producer of its counts: when each consumer
 * derives it, two surfaces disagree on one figure (they did — one served null,
 * another recomputed it). So every stats object this gateway serves that carries
 * numeric `sent` and `delivered` (recipientStats, emailStats, each stepStats
 * entry, at every grain: flat, grouped, family sum, byCampaign, per-operation)
 * gets `deliveryRate` here, on the FINAL counts.
 *
 * Never more than 1, never a division by zero, nothing invented:
 * - `sent` is 0 → null (nothing was sent; there is no rate to state);
 * - `delivered` > `sent` → null (the counts contradict each other; picking
 *   which one is wrong would be inventing a figure).
 *
 * Applied AFTER any summing: a rate does not add, so it must never travel
 * through `sumDeep`. Any `deliveryRate` already on an object is recomputed.
 */
export function deliveryRate(sent: number, delivered: number): number | null {
  if (sent <= 0 || delivered < 0 || delivered > sent) return null;
  return delivered / sent;
}

export function withDeliveryRates<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => withDeliveryRates(entry)) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "deliveryRate") out[key] = withDeliveryRates(entry);
  }
  if (typeof out.sent === "number" && typeof out.delivered === "number") {
    // First key: readers (LLMs especially) weigh the first fields most, and the
    // owner rule is that stats lead with success, failures last.
    return { deliveryRate: deliveryRate(out.sent, out.delivered), ...out } as T;
  }
  return out as T;
}
