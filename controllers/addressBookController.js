import {
  listAddressBookEntries,
  listAddressBookRanking,
  saveAddressBookEntry,
} from "../services/addressBook.js";

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

/**
 * GET /api/address-book/ranking
 * Query: month, year, limit — sort total_spent DESC.
 */
export async function rankingAddressBook(req, res) {
  try {
    const month = req.query?.month;
    const year = req.query?.year;
    const limit = req.query?.limit;
    const entries = await listAddressBookRanking({ month, year, limit });
    return res.json({
      success: true,
      entries,
      filter: {
        month: month != null && month !== "" ? Number(month) : null,
        year: year != null && year !== "" ? Number(year) : null,
      },
    });
  } catch (error) {
    console.error("[AddressBook ranking]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Không tải được xếp hạng VIP",
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
