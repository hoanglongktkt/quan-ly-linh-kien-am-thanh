import mongoose from "mongoose";

/**
 * Collection `address_book` — sổ địa chỉ khách (đơn ngoại sàn + Mini POS / VIP loyalty).
 */
const AddressBookSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true, index: true },
    name: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true, index: true },
    street: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    province: { type: String, default: "", trim: true },
    provinceName: { type: String, default: "", trim: true },
    provinceCode: { type: String, default: "", trim: true },
    district: { type: String, default: "", trim: true },
    districtName: { type: String, default: "", trim: true },
    districtCode: { type: String, default: "", trim: true },
    ward: { type: String, default: "", trim: true },
    wardName: { type: String, default: "", trim: true },
    wardCode: { type: String, default: "", trim: true },
    fullAddress: { type: String, default: "", trim: true },
    addressMode: { type: String, default: "new2", trim: true },
    savedAt: { type: Date, default: Date.now },
    /** Loyalty — tích lũy từ Mini POS (và có thể mở rộng sau). */
    total_orders: {
      type: Number,
      default: 0,
      min: 0,
      required: false,
    },
    total_spent: {
      type: Number,
      default: 0,
      min: 0,
      required: false,
    },
    last_purchase_date: { type: Date, default: null },
  },
  {
    collection: "address_book",
    versionKey: false,
    strict: false,
  },
);

AddressBookSchema.index({ phone: 1, street: 1, wardCode: 1 }, { name: "address_book_dedup" });
AddressBookSchema.index({ savedAt: -1 }, { name: "address_book_savedAt" });
AddressBookSchema.index({ total_spent: -1 }, { name: "address_book_total_spent" });
AddressBookSchema.index({ last_purchase_date: -1 }, { name: "address_book_last_purchase" });

const AddressBook =
  mongoose.models.AddressBook || mongoose.model("AddressBook", AddressBookSchema);

export default AddressBook;
