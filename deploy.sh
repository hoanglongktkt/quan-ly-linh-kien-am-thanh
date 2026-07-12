#!/usr/bin/env bash
# Deploy lên Vercel qua GitHub: add → commit → push nhánh hiện tại.
# Cách dùng: ./deploy.sh "Nội dung commit"
set -euo pipefail

COMMIT_MSG="${1:-}"

if [[ -z "${COMMIT_MSG// /}" ]]; then
  echo "❌ Thiếu message commit."
  echo "   Cách dùng: ./deploy.sh \"Nội dung commit\""
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "❌ Không phải thư mục git."
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "❌ Không xác định được nhánh (detached HEAD?). Checkout nhánh trước khi deploy."
  exit 1
fi

if [[ -f .env ]]; then
  if git check-ignore -q .env 2>/dev/null; then
    :
  else
    echo "❌ File .env không nằm trong .gitignore — dừng để tránh lộ secret."
    exit 1
  fi
fi

echo "📦 git add ."
git add .

if git diff --cached --quiet; then
  echo "⚠️  Không có thay đổi để commit. Bỏ qua commit/push."
  exit 0
fi

echo "📝 git commit -m \"$COMMIT_MSG\""
git commit -m "$COMMIT_MSG"

echo "🚀 git push origin $BRANCH"
git push origin "$BRANCH"

echo "✅ Đã push lên origin/$BRANCH — Vercel sẽ tự deploy nếu repo đã liên kết."
