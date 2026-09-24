離線英文拼字程式：GitHub Pages 本機發布包

此資料夾內含完整的靜態網站、離線服務工作程序和一鍵發布腳本。

在 Mac 上發布

1. 解壓縮此發布包。
2. 在終端機切換至解壓縮後的資料夾。亦可在本機 Codex 開啟此資料夾。
3. 確認已安裝 GitHub CLI（命令名稱為 gh）和 Git。
4. 執行：
   ./publish_github_pages.sh
5. 如尚未授權，腳本會打開 GitHub 瀏覽器授權。使用你平時登入 GitHub 的方式完成授權；不要把密碼、驗證碼或存取令牌貼到對話或交給腳本。
6. 腳本會建立公開的 offline-spelling-classroom 儲存庫、上載網站檔案、開啟 GitHub Pages，並輸出網站網址。

若儲存庫名稱已被使用，可先編輯 publish_github_pages.sh，修改 REPO_NAME。
若 GitHub Pages API 權限不足，網站檔案仍已推送；到新儲存庫的 Settings > Pages，選擇從 main 分支根目錄發布。

首次離線使用

在 iPad Safari 連線開啟腳本輸出的網址，等待程式顯示「離線資料已準備」，再選擇分享 > 加入主畫面。完成快取後可關閉網絡測試。

限制

GitHub Pages 的免費發布需要公開儲存庫，因此程式原始檔、圖示和詞庫也會公開。此程式不含登入資料、學生資料、雲端語音服務或個人資料。
離線語音使用 iPad 本機語音合成；可用聲線取決於裝置已安裝的英文語音。
