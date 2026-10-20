import type { Order, SystemFee } from '../types';
import {
  computeShopeeSurchargeTotal,
  getShopeeCustomCosts,
  getShopeeItemAmount,
  getShopeeNetRevenue,
  getShopeeTaxTotal,
  isShopeeEscrowSynced,
} from './shopeeFees';

/** Finance shown in order lists uses merchandise sales, never buyer payment or escrow. */
export function getOrderListFinance(order: Order, systemFees: SystemFee[] = []) {
  const pending = order.channel === 'shopee' && !isShopeeEscrowSynced(order);
  let itemAmount = getShopeeItemAmount(order);
  if (order.channel === 'shopee' && Array.isArray(order.items) && order.items.length > 0) {
    const sales = order.items.reduce((sum, item) => {
      const price = Number(item.price ?? item.originalPrice);
      return sum + (Number.isFinite(price) ? Math.max(0, price) : 0)
        * Math.max(0, Number(item.quantity) || 0);
    }, 0);
    const sellerVoucher = Math.max(0, Number(order.seller_voucher ?? order.shopee_fees?.voucher_from_seller) || 0);
    itemAmount = Math.max(0, Math.round(sales - sellerVoucher));
  }
  const dynamicFeeItems = systemFees
    .filter((fee) => fee.active && fee.name.trim() && Number(fee.value) > 0)
    .map((fee) => ({
      ...fee,
      amount: Math.round(fee.calculationType === 'percentage'
        ? itemAmount * Number(fee.value) / 100
        : Number(fee.value)),
    }));
  const dynamicFeeTotal = dynamicFeeItems.reduce((sum, fee) => sum + fee.amount, 0);
  const surchargeTotal = computeShopeeSurchargeTotal(order.shopee_fees);
  const taxTotal = getShopeeTaxTotal(order.shopee_fees, order);
  const customCosts = getShopeeCustomCosts(order);
  const netRevenue = order.channel === 'shopee'
    ? Math.round(itemAmount - (pending ? dynamicFeeTotal : surchargeTotal + taxTotal) - customCosts)
    : getShopeeNetRevenue(order);
  return { pending, itemAmount, dynamicFeeItems, dynamicFeeTotal, surchargeTotal, taxTotal, customCosts, netRevenue };
}
