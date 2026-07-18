import type { Order, ShopeeFees } from '../types';

export function parseShopeeFees(raw: unknown): ShopeeFees | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const fees: ShopeeFees = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) fees[key] = n;
  }
  return Object.keys(fees).length ? fees : undefined;
}

export function getShopeeTransactionFee(fees?: ShopeeFees): number {
  if (!fees) return 0;
  return Math.max(0, Number(fees.seller_transaction_fee ?? fees.transaction_fee) || 0);
}

export function getShopeeTaxTotal(fees?: ShopeeFees, order?: Pick<Order, 'withholdingCitTax' | 'withholding_cit_tax'>): number {
  const vat = Math.max(0, Number(fees?.withholding_vat_tax) || 0);
  const pit = Math.max(0, Number(fees?.withholding_pit_tax) || 0);
  const cit = Math.max(
    0,
    Number(fees?.withholding_cit_tax ?? order?.withholdingCitTax ?? order?.withholding_cit_tax) || 0,
  );
  return vat + pit + cit;
}

export function computeShopeeSurchargeTotal(
  fees?: ShopeeFees,
  order?: Pick<Order, 'withholdingCitTax' | 'withholding_cit_tax' | 'totalAmount' | 'revenue'>,
): number {
  if (fees?.total_surcharge != null && Number(fees.total_surcharge) > 0) {
    return Math.round(Number(fees.total_surcharge));
  }
  if (fees && Object.keys(fees).some((k) => k !== 'total_surcharge')) {
    const commission = Math.max(0, Number(fees.commission_fee) || 0);
    const service = Math.max(0, Number(fees.service_fee) || 0);
    const transaction = getShopeeTransactionFee(fees);
    const tax = getShopeeTaxTotal(fees, order);
    return Math.round(commission + service + transaction + tax);
  }
  if (order) {
    return Math.max(0, Math.round(Number(order.totalAmount) - Number(order.revenue)));
  }
  return 0;
}
