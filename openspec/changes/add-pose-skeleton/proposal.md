# Change: Add Pose Skeleton System

## Why
NovelAI 的姿態標籤（如 `standing`, `sitting`, `arms raised`）和位置控制不可靠——模型對空間關係的解讀有偏差，使用者只能反覆生成碰運氣。需要一個直接、視覺化的姿態控制方式，讓人物精確出現在指定位置和姿勢。

## What Changes
- 在 Layer 系統中新增可選的 **2D 骨架姿態模式**，每個 layer 可獨立啟用
- 提供 18 個 OpenPose 關節點，使用者可用滑鼠拖拽調整姿勢
- 支援 Adult/Child 兩種體型預設（不同頭身比）
- 後端新增 `/api/render-pose` endpoint，將關節座標渲染為 OpenPose 格式黑底彩色骨架圖
- Generate 時自動將骨架圖作為 img2img 輸入（strength 0.85），引導人物姿態
- 多 layer 骨架合併為同一張 OpenPose 圖

## Impact
- Affected specs: pose-skeleton (new capability)
- Affected code:
  - `frontend/js/pose.js` (new) — 骨架 SVG 渲染 + 拖拽互動
  - `frontend/js/layers.js` — poseData 序列化、Layer Tab Panel 新增 Pose 控制
  - `frontend/js/generate.js` — 骨架圖作為 img2img 輸入
  - `frontend/index.html` — 新增 `#pose-skeleton-overlay` SVG 元素
  - `frontend/css/style.css` — 骨架 overlay 樣式
  - `backend/api/pose.py` (new) — Pillow 骨架渲染
  - `backend/api/routes.py` — 新增 `/api/render-pose` route
  - `backend/models/schemas.py` — 新增 PoseJoints / RenderPoseRequest schema
