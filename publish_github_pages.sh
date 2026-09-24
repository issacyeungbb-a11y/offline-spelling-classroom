#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_NAME="offline-spelling-classroom"

if ! command -v gh >/dev/null 2>&1; then
  echo "找不到 GitHub 命令列工具 gh。請先在 Mac 安裝 GitHub CLI，再重新執行本程式。" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "找不到 Git。請先安裝 Xcode Command Line Tools，再重新執行本程式。" >&2
  exit 1
fi

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "即將開啟 GitHub 瀏覽器授權。請在瀏覽器完成登入及授權；毋須把密碼或驗證碼貼到聊天。"
  gh auth login --hostname github.com --git-protocol https --web
fi

gh auth setup-git

if [ ! -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" init -b main
fi
if git -C "$APP_DIR" remote get-url origin >/dev/null 2>&1; then
  echo "此資料夾已有 origin 遠端儲存庫。為免推送到錯誤位置，請先移除或更改此遠端，再重新執行。" >&2
  exit 1
fi

GH_LOGIN="$(gh api user --jq .login)"
GH_USER_ID="$(gh api user --jq .id)"
git -C "$APP_DIR" config user.name "$GH_LOGIN"
git -C "$APP_DIR" config user.email "${GH_USER_ID}+${GH_LOGIN}@users.noreply.github.com"
git -C "$APP_DIR" add --all
if ! git -C "$APP_DIR" diff --cached --quiet; then
  git -C "$APP_DIR" commit -m "Publish offline English spelling app"
fi

if gh repo view "$GH_LOGIN/$REPO_NAME" >/dev/null 2>&1; then
  echo "GitHub 已有 $GH_LOGIN/$REPO_NAME。請先確認該儲存庫用途，或在本程式中更改 REPO_NAME。" >&2
  exit 1
fi

gh repo create "$REPO_NAME" --public --source="$APP_DIR" --remote=origin --push

if ! gh api --method POST "repos/$GH_LOGIN/$REPO_NAME/pages" \
  -f build_type=legacy \
  -f 'source[branch]=main' \
  -f 'source[path]=/' >/dev/null; then
  echo "程式已推送到公開儲存庫，但 GitHub Pages 設定未能自動完成。請檢查儲存庫的 Settings > Pages。" >&2
  exit 2
fi

SITE_URL="https://${GH_LOGIN}.github.io/${REPO_NAME}/"
echo "已建立公開儲存庫並提交 GitHub Pages 發布。首次網站建置可能需要幾分鐘。"
echo "網站網址：$SITE_URL"
echo "請先連線開啟網址一次，待畫面顯示離線資料已準備，再加入 iPad 主畫面。"
