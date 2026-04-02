# Change: 修正姿態骨架系統三項關鍵缺陷

## Why

David 在測試現有 pose skeleton 功能時發現三個阻塞性問題：

1. **滾輪縮放被封鎖**：SVG overlay 在 `pose-active` 狀態下設定 `pointer-events: all`，導致整個 SVG 區域吸收所有滑鼠事件，使用者無法用滾輪縮放畫布，底部關節（腳踝）也因此無法用滾輪捲動到可視範圍內。

2. **骨架線對 img2img 無效**：NovelAI 不是 ControlNet。將黑底彩色棍形骨架圖送入 img2img，模型無法識別為人體——產生的結果與骨架姿態無關。img2img 需要的是一張包含「人體輪廓填色形狀」的參考圖，讓模型知道「這個位置有一個人，姿勢是這樣」。

3. **體型缺少性別維度**：目前只有 Adult/Child，但不同性別有顯著不同的身體比例（肩寬、腰臀比、胸型），這直接影響輪廓渲染的視覺語義。

## What Changes

### Fix 1：SVG pointer-events 修正（前端）
- `#pose-skeleton-overlay` SVG 本體永遠保持 `pointer-events: none`
- 只有 `<circle>` 元素設定 `pointer-events: all`（僅關節點攔截事件）
- 移除 `.pose-active { pointer-events: all }` CSS 規則
- 確保骨架外任何位置的滾輪/點擊事件穿透到畫布

### Fix 2：後端改為渲染人體輪廓剪影（後端）
- `/api/render-pose` 不再輸出黑底彩色骨架線
- 改為渲染填色人體剪影（mannequin 風格）：
  - 頭部：在 nose 位置渲染皮膚色橢圓
  - 軀幹：肩膀到髖部的四邊形填色多邊形
  - 上臂／前臂：關節之間的粗橢圓/圓角矩形
  - 大腿／小腿：同上，比例更粗
  - 皮膚色（light/dark 兩種色調，可設定）
  - 背景改為淺灰（#e8e8e8）而非黑色，避免 img2img 混淆
- 骨架線改為**選用覆蓋層**（debug 模式下可疊加顯示）

### Fix 3：新增 Male/Female 性別體型（前端 + 後端）
- Body Type 選項從 `["adult", "child"]` 擴展為 `["male", "female", "child"]`
- Male：較寬肩距、較窄髖部、軀幹長方形比例
- Female：較窄肩距、較寬髖部、腰部明顯內縮
- Child：維持現有邏輯（60% 身高、頭身比 5:1），不區分性別
- 預設體型由 "adult" 改為 "male"

## Impact

- Affected specs: `pose-skeleton`（修改現有 capability）
- Affected code:
  - `frontend/css/style.css` — 修改 `#pose-skeleton-overlay.pose-active` 規則
  - `frontend/js/pose.js` — 擴展 `getDefaultJoints()` 加入 male/female 預設
  - `backend/api/pose.py` — 全面改寫渲染邏輯為人體輪廓剪影
  - `backend/models/schemas.py` — 更新 `PoseFigure.body_type` 可接受值、新增 `skin_tone` 欄位
  - `frontend/js/layers.js` — Body Type 下拉選項更新，預設值改為 "male"
