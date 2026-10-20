import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOrderListFinance } from '../src/utils/orderListFinance.ts';
import { getOrderTotalImportCost } from '../src/utils/orderImportCost.ts';

const systemFees = [
  { id: 'percent', name: 'Shopee', active: true, calculationType: 'percentage', value: 10 },
  { id: 'fixed', name: 'Packaging', active: true, calculationType: 'fixed', value: 2000 },
  { id: 'inactive', name: 'Disabled', active: false, calculationType: 'fixed', value: 90000 },
];
const base = {
  channel: 'shopee', totalAmount: 70000, item_amount: 70000,
  items: [{ price: 50000, originalPrice: 60000, quantity: 2, importPrice: 20000 }],
};

for (const status of ['unprocessed', 'processed']) {
  test(`${status}: estimated profit uses sales, not buyer payment`, () => {
    const order = { ...base, status, finance_source: 'estimated_default' };
    const finance = getOrderListFinance(order, systemFees);
    assert.equal(finance.pending, true);
    assert.equal(finance.itemAmount, 100000);
    assert.equal(finance.netRevenue - getOrderTotalImportCost(order), 48000);
    assert.equal(getOrderListFinance({ ...order, totalAmount: 1 }, systemFees).netRevenue, finance.netRevenue);
  });
  test(`${status}: reconciled profit uses sales minus actual fees, not escrow`, () => {
    const order = {
      ...base, status, finance_source: 'escrow', escrowAmount: 45000,
      shopee_fees: { item_amount: 70000, escrow_amount: 45000, commission_fee: 10000,
        service_fee: 3000, seller_transaction_fee: 2000, transaction_fee: 2000, total_tax: 1000 },
    };
    const finance = getOrderListFinance(order, systemFees);
    assert.equal(finance.pending, false);
    assert.equal(finance.itemAmount, 100000);
    assert.equal(finance.netRevenue - getOrderTotalImportCost(order), 44000);
  });
}

test('seller voucher and custom costs are deducted once', () => {
  const order = { ...base, seller_voucher: 10000, custom_costs: 3000,
    custom_cost_items: [{ id: 'cost', label: 'Extra', amount: 3000 }] };
  assert.equal(getOrderListFinance(order, systemFees).netRevenue, 76000);
});

test('zero priced gifts do not fall back to original listing price', () => {
  const order = { ...base, items: [{ price: 0, originalPrice: 50000, quantity: 1 }] };
  assert.equal(getOrderListFinance(order, systemFees).itemAmount, 0);
  assert.equal(getOrderListFinance(order, systemFees).netRevenue, -2000);
});

test('missing lines fall back to merchandise amount, not total payment', () => {
  const order = { ...base, items: [], item_amount: 100000 };
  assert.equal(getOrderListFinance(order, systemFees).netRevenue, 88000);
  assert.equal(getOrderListFinance({ ...order, item_amount: undefined }, systemFees).itemAmount, 0);
});

test('other channels keep their existing revenue calculation', () => {
  const order = { ...base, channel: 'manual', escrowAmount: 75000, custom_costs: 1000 };
  assert.equal(getOrderListFinance(order, systemFees).netRevenue, 74000);
});
