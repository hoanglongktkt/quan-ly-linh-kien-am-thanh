import type { Order, OrderCustomCostItem, ShopeeFees } from '../types';

export function parseShopeeFees(raw: unknown): ShopeeFees | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const fees: ShopeeFees = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) fees[key] = n;
  }
  if (Object.keys(fees).length === 0) return undefined;
  return fees;
}

export function parseCustomCostItems(raw: unknown): OrderCustomCostItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      const row = (item || {}) as Record<string, unknown>;
      const amount = Math.max(0, Number(row.amount) || 0);
      const label = String(row.label || 'Chi phí khác').trim() || 'Chi phí khác';
      const id = String(row.id || `custom-cost-${index}-${Date.now()}`);
      return { id, label, amount };
    })
    .filter((item) => item.amount > 0);
}

export function sumCustomCostItems(items?: OrderCustomCostItem[]): number {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return Math.round(items.reduce((sum, item) => sum + Math.max(0, Number(item.amount) || 0), 0));
}

export function resolveOrderCustomCosts(order: Pick<Order, 'custom_costs' | 'custom_cost_items'>): number {
  const fromItems = sumCustomCostItems(order.custom_cost_items);
  if (fromItems > 0) return fromItems;
  return Math.max(0, Number(order.custom_costs) || 0);
}

export function isShopeeEscrowSynced(order: Pick<Order, 'channel' | 'escrow_synced' | 'escrowAmount' | 'shopee_fees' | 'finance_source'>): boolean {
  if (order.channel !== 'shopee') return true;
  if (order.finance_source === 'estimated_api' || order.finance_source === 'estimated_default') return false;
  if (order.finance_source === 'escrow') return true;
  if (order.escrow_synced) return true;
  if (order.escrowAmount != null && Number.isFinite(Number(order.escrowAmount))) return true;
  const fees = order.shopee_fees;
  return Boolean(
    fees &&
      (fees.escrow_amount != null ||
        fees.commission_fee != null ||
        fees.service_fee != null ||
        fees.transaction_fee != null ||
        fees.item_amount != null),
  );
}

export function getShopeeItemAmount(order: Pick<Order, 'item_amount' | 'shopee_fees' | 'totalAmount'>): number {
  const fromFees = Number(order.shopee_fees?.item_amount);
  if (Number.isFinite(fromFees) && fromFees > 0) return fromFees;
  const fromOrder = Number(order.item_amount);
  if (Number.isFinite(fromOrder) && fromOrder > 0) return fromOrder;
  return Math.max(0, Number(order.totalAmount) || 0);
}

export function getShopeeTransactionFee(fees?: ShopeeFees): number {
  if (!fees) return 0;
  return Math.max(
    0,
    Number(
      fees.seller_transaction_fee ??
        fees.transaction_fee ??
        fees.credit_card_transaction_fee,
    ) || 0,
  );
}

export function getShopeeFeeTaxTotal(fees?: ShopeeFees): number {
  if (!fees) return 0;
  const explicit = Math.max(0, Number(fees.total_tax) || 0);
  if (explicit > 0) return explicit;
  return (
    Math.max(0, Number(fees.commission_fee_tax) || 0) +
    Math.max(0, Number(fees.service_fee_tax) || 0) +
    Math.max(0, Number(fees.transaction_fee_tax) || 0)
  );
}

export function getShopeeWithholdingTaxTotal(
  fees?: ShopeeFees,
  order?: Pick<Order, 'withholdingCitTax' | 'withholding_cit_tax'>,
): number {
  const vat = Math.max(0, Number(fees?.withholding_vat_tax) || 0);
  const pit = Math.max(0, Number(fees?.withholding_pit_tax) || 0);
  const cit = Math.max(
    0,
    Number(fees?.withholding_cit_tax ?? order?.withholdingCitTax ?? order?.withholding_cit_tax) || 0,
  );
  return vat + pit + cit;
}

export function getShopeeTaxTotal(fees?: ShopeeFees, order?: Pick<Order, 'withholdingCitTax' | 'withholding_cit_tax'>): number {
  const feeTax = getShopeeFeeTaxTotal(fees);
  if (feeTax > 0) return feeTax;
  return getShopeeWithholdingTaxTotal(fees, order);
}

export function computeShopeeSurchargeTotal(fees?: ShopeeFees): number {
  if (fees?.total_surcharge != null && Number(fees.total_surcharge) > 0) {
    return Math.round(Number(fees.total_surcharge));
  }
  if (!fees) return 0;
  const commission = Math.max(0, Number(fees.commission_fee) || 0);
  const service = Math.max(0, Number(fees.service_fee) || 0);
  const transaction = getShopeeTransactionFee(fees);
  return Math.round(commission + service + transaction);
}

export function getShopeeEscrowAmount(order: Pick<Order, 'escrowAmount' | 'shopee_fees'>): number | undefined {
  const fromOrder = order.escrowAmount;
  if (fromOrder != null && Number.isFinite(Number(fromOrder))) return Math.round(Number(fromOrder));
  const fromFees = order.shopee_fees?.escrow_amount;
  if (fromFees != null && Number.isFinite(Number(fromFees))) return Math.round(Number(fromFees));
  return undefined;
}

export function getShopeeCustomCosts(order: Pick<Order, 'custom_costs' | 'custom_cost_items'>): number {
  return resolveOrderCustomCosts(order);
}

export function getShopeeNetRevenue(
  order: Pick<
    Order,
    'channel' | 'revenue' | 'escrowAmount' | 'shopee_fees' | 'custom_costs' | 'custom_cost_items' | 'item_amount' | 'totalAmount' | 'escrow_synced' | 'finance_source'
  >,
): number {
  const customCosts = getShopeeCustomCosts(order);
  if (isShopeeEscrowSynced(order)) {
    const escrow = getShopeeEscrowAmount(order);
    if (escrow != null) return Math.max(0, Math.round(escrow - customCosts));
  }
  const itemAmount = getShopeeItemAmount(order);
  return Math.max(0, Math.round(itemAmount - customCosts));
}

export function buildOrderWithCustomCosts(
  order: Order,
  items: OrderCustomCostItem[],
): Order {
  const custom_costs = sumCustomCostItems(items);
  const next: Order = { ...order, custom_cost_items: items, custom_costs };
  return { ...next, revenue: getShopeeNetRevenue(next) };
}
