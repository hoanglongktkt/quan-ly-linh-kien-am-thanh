#!/usr/bin/env bash
# Deploy: git add → commit → push nhánh hiện tại
# Cách dùng: ./deploy.sh "Nội dung commit"
set -euo pipefail

COMMIT_MSG="${1:-}"

if [[ -z "${COMMIT_MSG// /}" ]]; then
  echo "Thieu message commit."
  echo "Cach dung: ./deploy.sh \"Noi dung commit\""
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "Khong xac dinh duoc nhanh git."
  exit 1
fi

echo "git add ."
git add .

if git diff --cached --quiet; then
  echo "Khong co thay doi de commit."
  exit 0
fi

echo "git commit -m \"$COMMIT_MSG\""
git commit -m "$COMMIT_MSG"

echo "git push origin $BRANCH"
git push origin "$BRANCH"

echo "Da push len origin/$BRANCH"
