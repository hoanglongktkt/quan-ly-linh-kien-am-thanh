import mongoose from "mongoose";

/**
 * Đối soát tiền ví Shopee — collection `escrows`.
 * Chỉ module finance ghi collection này. Không đụng orders / in đơn / kho.
 */
const EscrowSchema = new mongoose.Schema(
  {
    ordersn: { type: String, required: true, trim: true },
    shop_id: { type: String, required: true, trim: true },
    shop_name: { type: String, default: "", trim: true },
    order_date: { type: Date, default: null },
    total_amount: { type: Number, default: 0 },
    shopee_commission: { type: Number, default: 0 },
    service_fee: { type: Number, default: 0 },
    shipping_fee: { type: Number, default: 0 },
    withholding_tax: { type: Number, default: 0 },
    payout_amount: { type: Number, default: 0 },
    expected_payout: { type: Number, default: 0 },
    delta: { type: Number, default: 0 },
    actual_cost: { type: Number, default: 0 },
    net_profit: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Đã đối soát", "Lệch tiền", "Chưa về ví"],
      default: "Chưa về ví",
    },
    is_disputed: { type: Boolean, default: false },
    dispute_reason: { type: String, default: "" },
    synced_at: { type: Date, default: Date.now },
  },
  {
    collection: "escrows",
    versionKey: false,
    timestamps: true,
  },
);

EscrowSchema.index({ ordersn: 1, shop_id: 1 }, { unique: true, name: "escrow_ordersn_shop" });
EscrowSchema.index({ shop_id: 1, order_date: -1 }, { name: "escrow_shop_date" });
EscrowSchema.index({ is_disputed: 1, order_date: -1 }, { name: "escrow_disputed_date" });
EscrowSchema.index({ status: 1, order_date: -1 }, { name: "escrow_status_date" });
EscrowSchema.index({ order_date: -1 }, { name: "escrow_order_date" });

const Escrow = mongoose.models.Escrow || mongoose.model("Escrow", EscrowSchema);

export default Escrow;
