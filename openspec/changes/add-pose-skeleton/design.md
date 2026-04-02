## Context

NovelAI API 不直接暴露 ControlNet 控制項，因此無法透過 API 參數指定 OpenPose 引導。
現有 Layer 系統已支援 img2img 合成（`compositeLayersToBase64` → `body.image`），可利用此路徑注入骨架圖。
前端使用 vanilla JS，canvas 區域為 `#canvas-drop-target`，已有 character markers 和 inpaint mask overlay 作為疊加層。

## Goals / Non-Goals

**Goals:**
- 使用者能在 canvas 上直觀地擺設人物姿態
- 骨架資料作為 img2img 輸入，實際影響生成結果
- 支援多人物（不同 layer）各自獨立姿態
- 互動方式足夠簡單——只有「拖拽關節」一種操作

**Non-Goals:**
- 不做 3D 旋轉或透視變換
- 不做物理模擬或關節約束（肘不能反折等）
- 不做手指/臉部細節關節
- 不做預設姿態庫（V2 再考慮）
- 不做骨架匯入/匯出
- 不做自動姿態偵測

## Decisions

### 1. SVG overlay vs Canvas 2D
- **Decision:** 使用 SVG overlay
- **Why:** SVG 的 `<circle>` 元素天然支援 pointer event hit-test，不需手寫距離計算。`viewBox="0 0 1 1"` 直接對應正規化座標。
- **Alternative:** Canvas 2D — 需要手動計算滑鼠位置與關節距離，程式碼更複雜。

### 2. 座標系統
- **Decision:** 0.0~1.0 正規化座標（相對畫布）
- **Why:** 與現有 `offsetX`/`offsetY` 體系一致，與解析度無關。後端接收後乘以實際寬高即可。

### 3. img2img 作為 ControlNet 替代
- **Decision:** 將 OpenPose 格式骨架圖作為 img2img 輸入，strength 預設 0.85
- **Why:** NovelAI API 不暴露 ControlNet 控制項，但 V4.5 模型對 OpenPose 格式有訓練資料識別。img2img 是唯一可用的引導機制。
- **Alternative:** 等 NovelAI 開放 ControlNet API — 不可行，時間不確定。

### 4. 骨架圖渲染位置
- **Decision:** 後端 Pillow 渲染
- **Why:** 前端 Canvas 2D 也可以畫，但後端渲染可確保輸出格式與 NovelAI 預期一致（精確 pixel 尺寸、顏色值），且不增加前端複雜度。

### 5. 骨架與現有 img2img 衝突處理
- **Decision:** 骨架圖疊加在 layer 合成圖上（骨架層 alpha 0.7）
- **Why:** 使用者可能同時有參考圖和骨架。合成而非替換，確保不丟棄使用者的參考圖。
- **Edge case:** 若只有骨架、無 layer 圖像，則純骨架圖作為 img2img 輸入。

### 6. 前端檔案結構
- **Decision:** 新增獨立的 `frontend/js/pose.js`
- **Why:** 骨架邏輯（渲染、拖拽、預設座標）與 layers.js 職責不同，分離更清晰。layers.js 只負責 poseData 序列化和 Panel UI 整合。

## Risks / Trade-offs

- **風險：** img2img + OpenPose 骨架圖的引導效果可能不如 ControlNet 精確
  → **緩解：** 這是 NovelAI API 限制，無法迴避。strength 參數可調整。使用者預期是「比純 tag 好」，不是「完美精確」。

- **風險：** SVG overlay 的 pointer-events 可能與現有 canvas 互動衝突（character marker 拖拽、canvas move）
  → **緩解：** 骨架 SVG 的 z-index 在 character markers 之下。只有 enabled 狀態才開啟 pointer-events。拖拽判定只在關節圓點 20px 範圍內。

## Open Questions
- 骨架 strength 是否需要獨立於一般 img2img strength slider？（PM 建議是，放在 Pose 控制旁邊）
