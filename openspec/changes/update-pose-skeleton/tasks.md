## 1. Fix 1 — SVG pointer-events 修正（前端 CSS）

- [ ] 1.1 在 `frontend/css/style.css` 移除 `#pose-skeleton-overlay.pose-active { pointer-events: all }` 規則
- [ ] 1.2 確認 `#pose-skeleton-overlay` 保持 `pointer-events: none`
- [ ] 1.3 確認 `#pose-skeleton-overlay circle` 有 `pointer-events: all`（應已存在，驗證即可）
- [ ] 1.4 手動測試：骨架啟用時，在關節之間空白區域使用滾輪縮放畫布 → 應正常縮放
- [ ] 1.5 手動測試：拖拽關節到畫布底部（腳踝位置）→ 應可成功拖拽

## 2. Fix 2 — 後端輪廓剪影渲染（後端 Python）

- [ ] 2.1 在 `backend/models/schemas.py` 更新 `PoseFigure` schema：
  - `body_type` 可接受值改為 `Literal["male", "female", "child"]`（移除 "adult"）
  - 新增 `skin_tone: Literal["light", "dark"] = "light"` 欄位
- [ ] 2.2 在 `backend/api/pose.py` 新增 `draw_limb(draw, p1, p2, width_px, color)` 輔助函數，繪製膠囊形狀（兩端半圓 + 中間矩形填色）
- [ ] 2.3 實作 `render_silhouette_figure(draw, joints_px, body_type, skin_color, width, height)` 函數，依照 design.md 中定義的部位順序渲染填色輪廓
  - 背景改為 `(232, 232, 232)`（淺灰 #e8e8e8）
  - Male 軀幹肩寬/髖寬比 1.4（倒梯形）
  - Female 軀幹使用 8 頂點多邊形近似腰部曲線
  - Child 維持等比縮放，不做性別區分
- [ ] 2.4 替換 `render_pose_image()` 主函數，將原本的骨架線渲染替換為輪廓剪影渲染
- [ ] 2.5 移除或改為選用的骨架線覆蓋（`debug=False` 時不畫線）
- [ ] 2.6 手動測試：curl POST `/api/render-pose`，驗證回傳圖為淺灰底膚色人形，非黑底彩色線

## 3. Fix 3 — 性別體型擴展（前端 JS + 後端）

- [ ] 3.1 在 `frontend/js/pose.js` 的 `getDefaultJoints()` 函數：
  - 將 `bodyType === "child"` 維持不變
  - 新增 `"male"` 和 `"female"` 都回傳相同的成人站立姿態 joint 座標（與原 "adult" 相同）
  - "adult" 作為舊值也回傳相同預設值（向後相容）
- [ ] 3.2 在 `frontend/js/layers.js` 的 Body Type 下拉選單：
  - 選項從 `["adult", "child"]` 改為 `["male", "female", "child"]`
  - 顯示文字：Male / Female / Child
  - 預設值改為 `"male"`
- [ ] 3.3 在 `frontend/js/layers.js` 的 `loadLayersFromStorage()` 或 poseData 初始化處：
  - 新增向後相容映射：若 `poseData.bodyType === "adult"` → 自動改為 `"male"`
- [ ] 3.4 在 `frontend/js/layers.js` 的 pose 初始化程式碼：
  - `poseData` 初始預設值從 `bodyType: "adult"` 改為 `bodyType: "male"`
- [ ] 3.5 確認 `collectPosePayload()` 的 `body_type` 欄位正確傳送新的體型值到後端

## 4. 整合測試

- [ ] 4.1 測試完整流程：啟用 Pose → 拖拽腳踝 → 骨架外滾輪縮放 → 點擊 Generate → 驗證 `/api/render-pose` 回傳膚色輪廓圖
- [ ] 4.2 測試 Male 體型：產生的輪廓圖肩寬明顯大於髖寬
- [ ] 4.3 測試 Female 體型：產生的輪廓圖有腰部內縮
- [ ] 4.4 測試 Child 體型：產生的輪廓圖高度約為 60% 畫布，頭部比例較大
- [ ] 4.5 測試舊資料向後相容：localStorage 中有 `bodyType: "adult"` 的資料 → 載入後顯示 "Male" 且不報錯
- [ ] 4.6 測試多 layer 各自 pose：Layer 1 (male) + Layer 2 (female) → render-pose 回傳圖包含兩個獨立輪廓

## 5. 剪影預覽（前端）

- [ ] 5.1 在 `#canvas-drop-target` 中新增 `<img id="pose-silhouette-preview">` 元素，z-index 在 skeleton overlay 之下
- [ ] 5.2 在 `pose.js` 新增 `updateSilhouettePreview(layerIdx)` 函數：呼叫 `/api/render-pose` 取得剪影圖，顯示為預覽
- [ ] 5.3 在 `renderPoseSkeleton()` 結束後（mouseup、bodyType 變更、skinTone 變更）呼叫 `updateSilhouettePreview()`
- [ ] 5.4 Pose 關閉時移除預覽圖
- [ ] 5.5 使用 debounce（300ms）避免拖拽過程中過度呼叫 API

## 6. 滾輪縮放骨架（前端）

- [ ] 6.1 在 `pose.js` 新增 `scalePoseSkeleton(layerIdx, delta)` 函數：以骨架中心為基準等比縮放所有 joints
- [ ] 6.2 在 canvas-drop-target 上監聽 `wheel` 事件（只在 pose active 且非關節上時觸發）
- [ ] 6.3 縮放範圍限制：最小 20% 畫布高度，最大 100%，joints 不超出 [0, 1]
- [ ] 6.4 縮放後更新骨架 SVG + 剪影預覽
- [ ] 6.5 縮放後儲存 joints 到 localStorage

## 7. Playwright E2E 測試更新

- [ ] 7.1 測試「骨架外空白區域 pointer-events 穿透」
- [ ] 7.2 測試「Body Type 下拉選項包含 Male / Female / Child」
- [ ] 7.3 測試「舊 adult bodyType 資料載入後自動轉為 male」
- [ ] 7.4 測試「render-pose 回傳圖為非黑色背景（淺灰）」
- [ ] 7.5 測試「啟用 pose 後 canvas 出現剪影預覽圖」
- [ ] 7.6 測試「滾輪縮放改變骨架大小」
