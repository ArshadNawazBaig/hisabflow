import type { Shipment, Workspace } from './types';
import { compare, quantityAdd, quantityCompare, quantitySubtract, validMoney } from './accounting.ts';
import { canonicalDeliveryUnit, normalizeDeliveryLabel } from './delivery-units.ts';

export type PurchaseSourceReview = {
  available: { shipment: Shipment; available: string }[];
  excluded: { shipment: Shipment; reasons: string[] }[];
  receiptsCount: number;
};

/** The same nonnegative quantity syntax accepted by financial record validation. */
export function isAllocationQuantity(value: string): boolean {
  return /^\d{1,12}(?:\.\d{1,6})?$/.test(value);
}

/** Draft allocations reserve stock too; the current sale may replace its own picks. */
export function purchaseSourceAvailable(data: Workspace, source: Shipment, saleId: string): string {
  if (!isAllocationQuantity(source.weight)) return '0.000000';
  let reserved = '0.000000';
  for (const other of data.shipments) {
    if (other.direction !== 'Dispatch' || other.id === saleId) continue;
    for (const allocation of other.costAllocations ?? []) {
      if (allocation.shipmentId !== source.id) continue;
      // An unresolved reservation cannot safely be offered to another sale.
      if (!isAllocationQuantity(allocation.weight)) return '0.000000';
      reserved = quantityAdd(reserved, allocation.weight);
    }
    if (other.matchConfirmed && other.matchedId === source.id && source.matchConfirmed && source.matchedId === other.id) {
      if (!isAllocationQuantity(other.weight)) return '0.000000';
      reserved = quantityAdd(reserved, other.weight);
    }
  }
  return quantitySubtract(source.weight, reserved);
}

/** Show why an actual receipt cannot supply this sale without guessing missing costs. */
export function reviewPurchaseSources(data: Workspace, sale: Shipment): PurchaseSourceReview {
  const result: PurchaseSourceReview = { available: [], excluded: [], receiptsCount: 0 };
  const product = normalizeDeliveryLabel(sale.product);
  const unit = canonicalDeliveryUnit(sale.unit);
  const grade = normalizeDeliveryLabel(sale.grade ?? '');
  for (const shipment of data.shipments) {
    if (shipment.direction !== 'Receipt') continue;
    result.receiptsCount++;
    const reasons: string[] = [];
    const sourceProduct = normalizeDeliveryLabel(shipment.product);
    const sourceUnit = canonicalDeliveryUnit(shipment.unit);
    const sourceGrade = normalizeDeliveryLabel(shipment.grade ?? '');
    if (!product || !sourceProduct || sourceProduct !== product) reasons.push('Different product');
    if (!unit || !sourceUnit || sourceUnit !== unit) reasons.push('Different unit');
    if (grade && sourceGrade && grade !== sourceGrade) reasons.push('Different grade');
    const knownQuantity = isAllocationQuantity(shipment.weight) && quantityCompare(shipment.weight, '0') > 0;
    if (!knownQuantity) reasons.push('Missing or invalid purchase quantity');
    if (!validMoney(shipment.rate) || compare(shipment.rate, '0') <= 0) reasons.push('Missing or invalid purchase rate');
    const available = purchaseSourceAvailable(data, shipment, sale.id);
    if (knownQuantity && quantityCompare(available, '0') <= 0) reasons.push('Quantity already allocated');
    if (reasons.length) result.excluded.push({ shipment, reasons });
    else result.available.push({ shipment, available });
  }
  return result;
}
