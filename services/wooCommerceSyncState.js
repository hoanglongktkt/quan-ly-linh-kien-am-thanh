import mongoose from "mongoose";

const LEASE_MS = 5 * 60_000;

// Reuses the existing Mongo connection and the built-in unique _id index.
// A lease prevents duplicate work across Passenger processes and manual requests.
export function createWooCommerceSyncState(getCollection = () => mongoose.connection.db.collection("woocommerce_sync_state")) {
  const options = { timeoutMS: 15_000 };
  async function ownedUpdate(key, token, patch) {
    const result = await getCollection().updateOne(
      { _id: key, owner: token, leaseUntil: { $gt: new Date() } },
      { $set: patch }, options);
    if (result.matchedCount !== 1) throw new Error("woo_sync_lease_lost");
  }
  return {
    async claim(key, token, { incremental, intervalMs }) {
      const collection = getCollection();
      try {
        await collection.updateOne({ _id: key }, { $setOnInsert: { cursorAt: null, leaseUntil: new Date(0) } }, { ...options, upsert: true });
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
      const now = new Date();
      const filter = { _id: key, leaseUntil: { $lte: now }, ...(incremental
        ? { $or: [{ lastAutoStartedAt: { $exists: false } }, { lastAutoStartedAt: { $lte: new Date(now.getTime() - intervalMs) } }] }
        : {}) };
      return collection.findOneAndUpdate(filter, {
        $set: { owner: token, leaseUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now,
          ...(incremental ? { lastAutoStartedAt: now } : {}) },
      }, { ...options, returnDocument: "after", includeResultMetadata: false });
    },
    renew: (key, token) => ownedUpdate(key, token, { leaseUntil: new Date(Date.now() + LEASE_MS) }),
    save: (key, token, patch) => ownedUpdate(key, token, patch),
    async release(key, token) {
      await getCollection().updateOne({ _id: key, owner: token },
        { $set: { leaseUntil: new Date(0) }, $unset: { owner: "" } }, options);
    },
  };
}
