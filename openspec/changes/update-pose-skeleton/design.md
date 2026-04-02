## Context

現有實作已完成骨架顯示、拖拽互動、資料持久化等功能，但在實際使用測試中發現三項根本性缺陷。本 design 文件記錄修正決策與技術方案。

所有三個問題都是可測試、可驗證的行為缺陷（非美觀偏好），需要在 V1 正式可用之前修復。

## Goals / Non-Goals

**Goals:**
- 滾輪縮放在骨架啟用時正常工作
- 底部關節（腳踝）在任何畫布縮放層級下都可拖拽
- img2img 輸入包含可識別的人體形狀（輪廓填色），而非純骨架線
- 體型支援性別維度影響輪廓渲染

**Non-Goals:**
- 不做 3D 旋轉或骨骼動畫
- 不做照片寫實肌肉紋理
- 不做手指/臉部精細關節（維持現有 18 點）
- 不做動態皮膚色混合（只提供 light/dark 兩個選項）

## Decisions

### Decision 1：SVG pointer-events 架構修正

**問題根源：** CSS 規則 `.pose-active { pointer-events: all }` 讓整個 SVG 矩形成為事件接收區，即使使用者點擊的是骨架線之間的空白位置，滾輪事件也被 SVG 消費而無法傳遞到畫布。

**解法：**
```css
/* 移除這條規則 */
#pose-skeleton-overlay.pose-active {
  pointer-events: all;  /* 刪除 */
}

/* SVG 本體永遠穿透 */
#pose-skeleton-overlay {
  pointer-events: none;
}

/* 只有關節圓點攔截事件 */
#pose-skeleton-overlay circle {
  pointer-events: all;
  cursor: grab;
}
```

**為什麼不在 JS 層處理：** CSS `pointer-events` 是最低層級的解法，不需要任何事件攔截邏輯。SVG 的 `<line>` 元素已明確設定 `pointer-events: none`（現有程式碼正確），只需修正 SVG 根元素的 CSS 規則即可。

### Decision 2：人體輪廓剪影渲染策略

**問題根源：** NovelAI V4.5 沒有 ControlNet API。img2img 的引導原理是「模型看到一張圖，在保留其結構的前提下重繪」。棍形骨架線（細線條 + 黑底）沒有足夠的視覺質量讓模型識別為人體結構，因此實際上不起作用。

**解法：渲染填色人體剪影（mannequin 模式）**

用 Pillow 在每個身體區段渲染粗填色形狀：

```
身體部位對應關節:
  頭部:        nose 位置橢圓 (r = 關節間距 × 0.45)
  頸部:        nose → neck 的細柱
  軀幹:        (left_shoulder, right_shoulder, right_hip, left_hip) 梯形多邊形
  上臂 (左/右): shoulder → elbow 粗橢圓，寬度 = 肩寬 × 0.18
  前臂 (左/右): elbow → wrist 橢圓，寬度 = 上臂 × 0.85
  大腿 (左/右): hip → knee 橢圓，寬度 = 肩寬 × 0.22
  小腿 (左/右): knee → ankle 橢圓，寬度 = 大腿 × 0.85
```

**皮膚色值（兩種色調）：**
- `light`: RGB(255, 219, 172) — 淡肉色
- `dark`:  RGB(141, 85, 36)  — 深肉色

**背景色：** `#e8e8e8`（淺灰）而非黑色。淺灰能讓模型在 img2img 時識別為「中性空間」，不會混淆為衣服或陰影。

**性別差異的輪廓修正：**
- Male：軀幹梯形肩寬/髖寬比 = 1.4（倒梯形）
- Female：軀幹梯形肩寬/髖寬比 = 0.95（接近等腰，腰部加內縮曲線）
- Child：維持現有等比縮放，不做性別區分

**輪廓渲染順序（防止遮蔽錯誤）：**
1. 背景填色
2. 軀幹（最大面積先畫）
3. 大腿 × 2
4. 小腿 × 2
5. 上臂 × 2
6. 前臂 × 2
7. 頸部
8. 頭部（最後畫，蓋在所有部位上方）

**橢圓繪製輔助函數：**
```python
def draw_limb(draw, p1, p2, width, color):
    """在兩點之間繪製填色膠囊形狀（兩個端點 + 矩形）。"""
    # 計算角度，沿垂直方向偏移生成矩形頂點，兩端加半圓
```

### Decision 3：Body Type 擴展至 Male / Female / Child

**舊方案問題：** "adult" 是性別中立的，但人體輪廓渲染需要性別資訊才有意義。如果使用者選 "adult" 後我們用任意一種輪廓，結果會讓一半使用者感到困惑。

**新方案：**
- 移除 "adult" 選項
- 新增 "male" 和 "female"
- 預設值改為 "male"（向後相容：舊的 "adult" 資料在載入時自動映射為 "male"）
- Child 維持不變（幼兒外觀無性別之分）

**向後相容映射：**
```javascript
// 載入舊資料時
if (poseData.bodyType === "adult") {
  poseData.bodyType = "male";
}
```

**預設 joint 座標：**
- Male 和 Female 使用相同的 18 個 joint 座標（骨架位置不變）
- 差異只在後端渲染時的輪廓寬度比例，不需要前端維護兩套 joint 預設值

## Risks / Trade-offs

- **風險：** 皮膚色剪影對於穿衣人物仍不夠精確（模型可能把膚色解讀為裸露）
  → **緩解：** 這是 img2img 引導的固有限制，比骨架線好很多。使用者的預期是「引導姿態」而非「精確控制穿著」。未來可考慮加入「衣服色」選項（V2）。

- **風險：** 移除 "adult" 選項是破壞性變更（localStorage 資料）
  → **緩解：** 載入時做自動映射（adult → male），不丟失資料，不報錯。

- **風險：** Female 軀幹的腰部曲線用 Pillow 難以實現平滑效果
  → **緩解：** 使用梯形多邊形近似（8頂點多邊形），視覺上足夠，不需要貝茲曲線。

## Open Questions
- 是否需要讓使用者在 UI 上選擇膚色（light/dark）？建議 P1，預設 light，後續加入。
- 軀幹渲染是否需要加入乳房形狀輔助 female 識別？建議不做，過於細節，prompt 標籤更有效。
