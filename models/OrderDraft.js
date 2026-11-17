import mongoose from "mongoose";

// Separate collection: quotations never enter order, revenue, stock or shipping queries.
const schema = new mongoose.Schema({
  _id: String,
  number: { type: String, required: true },
  kind: { type: String, enum: ["pos", "manual"], required: true },
  state: { type: String, enum: ["draft", "converting", "converted"], default: "draft" },
  version: { type: Number, default: 1 },
  payload: mongoose.Schema.Types.Mixed,
  formState: mongoose.Schema.Types.Mixed,
  storeInfo: mongoose.Schema.Types.Mixed,
  result: mongoose.Schema.Types.Mixed,
}, { timestamps: true, bufferCommands: false, autoIndex: false, collection: "order_drafts" });

export default mongoose.models.OrderDraft || mongoose.model("OrderDraft", schema);
