import mongoose from "mongoose";

/**
 * Hàng đợi webhook Shopee bền trên Mongo.
 * jobId = shopId_orderSn_status_updateTime — unique, retry cùng push thì bỏ qua.
 */
const WebhookJobSchema = new mongoose.Schema(
  {
    jobId: {
      type: String,
      required: true,
      trim: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // Đồng bộ thủ công và cron dùng chung hàng đợi bền với webhook.
    kind: { type: String, enum: ["webhook", "sync"], default: "webhook" },
    priority: { type: Number, default: 0 },
    orderKey: { type: String, default: "" },
    claim_token: { type: String, default: "" },
    // Chỉ một job cron cùng loại đang chờ/chạy/retry; không tạo backlog trùng.
    active_key: { type: String },
    state: {
      type: String,
      enum: ["pending", "running", "succeeded", "failed", "dead-letter"],
      default: "pending",
      required: true,
    },
    retry_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    error_log: {
      type: String,
      default: "",
    },
    next_run_at: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    collection: "webhook_jobs",
    versionKey: false,
    timestamps: true,
  },
);

WebhookJobSchema.index({ jobId: 1 }, { unique: true, name: "webhook_jobs_jobId_unique" });
WebhookJobSchema.index({ active_key: 1 }, { unique: true, sparse: true, name: "webhook_jobs_active_key_unique" });
WebhookJobSchema.index({ state: 1, next_run_at: 1 }, { name: "webhook_jobs_state_next_run" });

const WebhookJob =
  mongoose.models.WebhookJob || mongoose.model("WebhookJob", WebhookJobSchema);

export default WebhookJob;
