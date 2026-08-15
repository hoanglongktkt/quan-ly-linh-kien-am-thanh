import React from 'react';
import type { Order } from '../types';
import { isWarehouseReturnReceived } from '../utils/orderLocalStatus';
import { shouldShowWarehouseReturnActions } from '../utils/shopeeCancelReturnClassify';

export function ReturnWarehouseStatusBlock({
  order,
  confirming,
  onConfirm,
  compact,
}: {
  order: Order;
  confirming: boolean;
  onConfirm: (order: Order) => void;
  compact?: boolean;
}) {
  const showReturnActions = shouldShowWarehouseReturnActions(order);
  if (!showReturnActions) {
    return (
      <div className={`flex flex-col ${compact ? 'items-end' : 'items-center'} gap-1.5`}>
        <span className="inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border bg-rose-50 text-rose-600 border-rose-200">
          Đơn Hủy
        </span>
      </div>
    );
  }

  const received = isWarehouseReturnReceived(order);
  return (
    <div className={`flex flex-col ${compact ? 'items-end' : 'items-center'} gap-1.5`}>
      <span className="inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border bg-violet-50 text-violet-600 border-cyan-200/80">
        Đang hoàn về
      </span>
      {received ? (
        <span className="inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
          Đã nhận hàng hoàn
        </span>
      ) : (
        <>
          <span className="inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border-2 border-orange-400 bg-transparent text-orange-700">
            Chưa nhận được hàng hoàn
          </span>
          <button
            type="button"
            disabled={confirming}
            onClick={() => onConfirm(order)}
            className="px-2.5 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-60"
          >
            {confirming ? 'Đang xác nhận...' : 'Xác nhận đã nhận hoàn'}
          </button>
        </>
      )}
    </div>
  );
}
