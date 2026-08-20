import { listAddressBookEntries, saveAddressBookEntry } from "../services/addressBook.js";

/** GET /api/address-book */
export async function listAddressBook(_req, res) {
  try {
    const entries = await listAddressBookEntries();
    return res.json({ success: true, entries });
  } catch (error) {
    console.error("[AddressBook list]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Không tải được sổ địa chỉ",
      entries: [],
    });
  }
}

/** POST /api/address-book */
export async function createAddressBookEntry(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const phone = String(body.phone || "").replace(/\D/g, "");
    if (!name && !phone) {
      return res.status(400).json({
        success: false,
        error: "Cần tên hoặc số điện thoại để lưu sổ địa chỉ.",
      });
    }
    const entry = await saveAddressBookEntry(body);
    return res.json({ success: true, entry, message: "Đã lưu vào sổ địa chỉ" });
  } catch (error) {
    console.error("[AddressBook save]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Lưu sổ địa chỉ thất bại",
    });
  }
}
