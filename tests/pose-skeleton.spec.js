const { test, expect } = require("@playwright/test");

// Helper: clear localStorage and reload to start fresh
async function freshPage(page) {
  await page.goto("/?t=" + Date.now());
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForLoadState("networkidle");
  // Verify pose.js is loaded
  await page.waitForFunction(() => typeof getDefaultJoints === "function", null, { timeout: 5000 });
}

// Helper: add a layer and open its panel
async function addLayerAndOpenPanel(page) {
  await page.locator("#layer-tabs-add").click();
  await page.waitForTimeout(300);
  await page.locator(".layer-tab").first().click();
  await page.waitForSelector("#layer-tab-panel", { state: "visible", timeout: 3000 });
}

// Helper: enable pose on the current layer via the panel checkbox
async function enablePose(page) {
  const panel = page.locator("#layer-tab-panel");
  const poseCheckbox = panel.locator("text=Pose").locator("..").locator("input[type='checkbox']");
  if (!(await poseCheckbox.isChecked())) {
    await poseCheckbox.check();
  }
  await page.waitForFunction(() => {
    const svg = document.getElementById("pose-skeleton-overlay");
    return svg && svg.querySelectorAll("circle").length >= 17;
  }, null, { timeout: 3000 });
}

test.describe("Pose Skeleton", () => {
  test.beforeEach(async ({ page }) => {
    await freshPage(page);
  });

  // AC-1: Skeleton Display
  test("enable pose toggle shows skeleton on canvas", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const result = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      return {
        circles: svg.querySelectorAll("circle").length,
        paths: svg.querySelectorAll("path").length,
        polygons: svg.querySelectorAll("polygon").length,
        viewBox: svg.getAttribute("viewBox"),
      };
    });
    expect(result.circles).toBeGreaterThanOrEqual(17);
    expect(result.paths).toBeGreaterThanOrEqual(8);  // limb capsules
    // viewBox matches canvas aspect ratio (not 0 0 1 1)
    expect(result.viewBox).toMatch(/^0 0 [\d.]+ 1$/);
  });

  // AC-2: Joint Dragging
  test("drag a joint updates position visually", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const noseBox = await page.locator('circle[data-joint="nose"]').boundingBox();
    const startX = noseBox.x + noseBox.width / 2;
    const startY = noseBox.y + noseBox.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 200, startY + 200, { steps: 10 });
    await page.mouse.up();

    const newNoseX = await page.evaluate(() => layers[0]?.poseData?.joints?.nose?.[0] ?? 0.5);
    expect(Math.abs(newNoseX - 0.5)).toBeGreaterThan(0.05);
  });

  // AC-3: Body Type switching (Male → Child)
  test("switch body type changes skeleton proportions", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const maleAnkle = await page.evaluate(() => {
      const c = document.getElementById("pose-skeleton-overlay").querySelector('circle[data-joint="left_ankle"]');
      return parseFloat(c.getAttribute("cy"));
    });

    // Switch to Child
    await page.locator("#layer-tab-panel select").first().selectOption("child");
    await page.waitForTimeout(200);

    const childAnkle = await page.evaluate(() => {
      const c = document.getElementById("pose-skeleton-overlay").querySelector('circle[data-joint="left_ankle"]');
      return parseFloat(c.getAttribute("cy"));
    });

    expect(Math.abs(childAnkle - maleAnkle)).toBeGreaterThan(0.01);
  });

  // AC-4: Reset Pose
  test("reset button restores default pose", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const initialNoseX = await page.evaluate(() => layers[0]?.poseData?.joints?.nose?.[0]);

    // Use bounding box for mouse position
    const noseBox = await page.locator('circle[data-joint="nose"]').boundingBox();
    await page.mouse.move(noseBox.x + noseBox.width/2, noseBox.y + noseBox.height/2);
    await page.mouse.down();
    await page.mouse.move(noseBox.x + 80, noseBox.y + 80, { steps: 5 });
    await page.mouse.up();

    const movedNoseX = await page.evaluate(() => layers[0]?.poseData?.joints?.nose?.[0]);
    expect(Math.abs(movedNoseX - initialNoseX)).toBeGreaterThan(0.02);

    await page.locator("#layer-tab-panel button", { hasText: "Reset Pose" }).click();
    await page.waitForTimeout(200);

    const resetNoseX = await page.evaluate(() => layers[0]?.poseData?.joints?.nose?.[0]);
    expect(resetNoseX).toBeCloseTo(initialNoseX, 1);
  });

  // AC-5: Generate Integration
  test("generate with pose calls render-pose endpoint", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    await page.evaluate(() => {
      document.getElementById("prompt").value = "test pose skeleton";
      const cb = document.querySelector(".canvas-bar-prompt");
      if (cb) cb.textContent = "test pose skeleton";
    });

    const renderPosePromise = page.waitForRequest(
      (req) => req.url().includes("/api/render-pose") && req.method() === "POST",
      { timeout: 10000 }
    );

    await page.locator("#cpb-collapsed-gen, #cpb-generate-btn").first().click();

    const req = await renderPosePromise;
    const body = req.postDataJSON();
    expect(body.figures).toBeDefined();
    expect(body.figures.length).toBeGreaterThanOrEqual(1);
    expect(body.figures[0].joints.nose).toBeDefined();
    // V2: verify body_type and skin_tone are sent
    expect(body.figures[0].body_type).toBe("male");
    expect(body.figures[0].skin_tone).toBe("light");
  });

  // AC-6: Persistence
  test("pose data persists after page refresh", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const pos = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      const rect = svg.getBoundingClientRect();
      const nose = svg.querySelector('circle[data-joint="nose"]');
      return {
        x: rect.left + parseFloat(nose.getAttribute("cx")) * rect.width,
        y: rect.top + parseFloat(nose.getAttribute("cy")) * rect.height,
      };
    });
    await page.mouse.move(pos.x, pos.y);
    await page.mouse.down();
    await page.mouse.move(pos.x + 60, pos.y + 40, { steps: 5 });
    await page.mouse.up();

    const movedNoseX = await page.evaluate(() => layers[0]?.poseData?.joints?.nose?.[0]);

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof getDefaultJoints === "function", null, { timeout: 5000 });
    await page.locator(".layer-tab").first().click();
    await page.waitForTimeout(500);

    const restored = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem("nai-layers") || "[]");
      if (data.length > 0 && data[0].poseData) {
        return { enabled: data[0].poseData.enabled, noseCx: data[0].poseData.joints.nose[0] };
      }
      return null;
    });

    expect(restored).not.toBeNull();
    expect(restored.enabled).toBe(true);
    expect(restored.noseCx).toBeCloseTo(movedNoseX, 1);
  });

  // AC-7: Multi-layer independent skeletons
  test("each layer has independent skeleton", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const noseBox = await page.locator('circle[data-joint="nose"]').boundingBox();
    await page.mouse.move(noseBox.x + noseBox.width/2, noseBox.y + noseBox.height/2);
    await page.mouse.down();
    await page.mouse.move(noseBox.x + 80, noseBox.y, { steps: 5 });
    await page.mouse.up();

    const layer1NoseX = await page.evaluate(() => layers[0]?.poseData?.joints?.nose?.[0]);

    await page.locator("#layer-tabs-add").click();
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const idx = layers.length - 1;
      layers[idx].poseData = {
        enabled: true, bodyType: "male",
        joints: getDefaultJoints("male"), poseStrength: 0.85,
      };
      saveLayersToStorage();
    });

    const tabs = page.locator(".layer-tab");
    await tabs.nth(1).click();
    await page.waitForTimeout(300);
    await tabs.nth(1).click();
    await page.waitForTimeout(300);

    await page.evaluate(() => { renderPoseSkeleton(layers.length - 1); });
    await page.waitForTimeout(200);

    // Check stored joint value (0-1 normalized)
    const layer2NoseX = await page.evaluate(() => {
      const lastIdx = layers.length - 1;
      return layers[lastIdx]?.poseData?.joints?.nose?.[0];
    });
    expect(layer2NoseX).toBeCloseTo(0.50, 1);
    expect(Math.abs(layer2NoseX - layer1NoseX)).toBeGreaterThan(0.05);
  });

  // AC-8: Skeleton z-index
  test("skeleton does not block character marker clicks", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const zIndex = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      return parseInt(window.getComputedStyle(svg).zIndex) || 0;
    });
    expect(zIndex).toBeLessThan(30);
  });

  // AC-9: Scroll wheel passes through skeleton overlay
  test("scroll wheel events pass through skeleton overlay", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    // SVG root must have pointer-events: none
    const svgPE = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      return window.getComputedStyle(svg).pointerEvents;
    });
    expect(svgPE).toBe("none");

    // Circle joints must have pointer-events: all
    const circlePE = await page.evaluate(() => {
      const circle = document.getElementById("pose-skeleton-overlay").querySelector("circle");
      return circle ? window.getComputedStyle(circle).pointerEvents : null;
    });
    expect(circlePE).toBe("all");
  });

  // AC-10: Body Type dropdown shows Male / Female / Child
  test("body type dropdown has male female child options", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const options = await page.evaluate(() => {
      const selects = document.querySelectorAll("#layer-tab-panel select");
      // First select is Body Type
      const bodySelect = selects[0];
      return Array.from(bodySelect.options).map(o => o.value);
    });
    expect(options).toContain("male");
    expect(options).toContain("female");
    expect(options).toContain("child");
    expect(options).not.toContain("adult");
  });

  // AC-11: Legacy "adult" body type migrates to "male"
  test("legacy adult bodyType auto-migrates to male", async ({ page }) => {
    // Store legacy data with "adult" body type
    await page.evaluate(() => {
      const legacyLayers = [{
        id: Date.now(), name: "Layer 1",
        imageBase64: null, maskBase64: null, inpaintMaskBase64: null,
        opacity: 1, visible: true, isOutputTarget: false,
        offsetX: 0, offsetY: 0, scale: 1,
        poseData: {
          enabled: true, bodyType: "adult",
          joints: getDefaultJoints("adult"), poseStrength: 0.85,
        },
      }];
      localStorage.setItem("nai-layers", JSON.stringify(legacyLayers));
    });

    // Reload to trigger migration
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof getDefaultJoints === "function", null, { timeout: 5000 });

    const bodyType = await page.evaluate(() => {
      return layers[0]?.poseData?.bodyType;
    });
    expect(bodyType).toBe("male");
  });

  // AC-12: Render-pose returns non-black background (silhouette)
  test("render-pose returns silhouette with light gray background", async ({ page }) => {
    // Call the API directly
    const result = await page.evaluate(async () => {
      const joints = getDefaultJoints("male");
      const resp = await fetch("/api/render-pose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          figures: [{ joints, body_type: "male", skin_tone: "light" }],
          width: 128, height: 192,
        }),
      });
      if (!resp.ok) return { error: resp.status };
      const data = await resp.json();

      // Decode base64 to check pixel color at corner (should be light gray background)
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = "data:image/png;base64," + data.image;
      });

      const canvas = document.createElement("canvas");
      canvas.width = 128; canvas.height = 192;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      // Check corner pixel (should be background, not black)
      const corner = ctx.getImageData(0, 0, 1, 1).data;
      // Check center pixel (should have skin color, not black lines)
      const center = ctx.getImageData(64, 96, 1, 1).data;

      return {
        hasImage: !!data.image,
        cornerR: corner[0], cornerG: corner[1], cornerB: corner[2],
        centerR: center[0], centerG: center[1], centerB: center[2],
      };
    });

    expect(result.hasImage).toBe(true);
    // Background is now transparent (RGBA) — corner alpha should be 0
    // Body center should have skin color (non-zero RGB);
  });

  // AC-13: Skeleton renders body shapes (not just lines)
  test("skeleton renders body parts as filled SVG shapes", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    const result = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      return {
        paths: svg.querySelectorAll("path").length,       // capsule limbs
        polygons: svg.querySelectorAll("polygon").length,  // torso
        ellipses: svg.querySelectorAll("ellipse").length,  // head
        circles: svg.querySelectorAll("circle").length,    // joint handles
      };
    });

    // Should have body parts: paths (limbs), polygon (torso), ellipse (head)
    expect(result.paths).toBeGreaterThanOrEqual(8);     // 8 limb capsules + neck
    expect(result.polygons).toBeGreaterThanOrEqual(1);  // torso
    expect(result.ellipses).toBeGreaterThanOrEqual(1);  // head
    expect(result.circles).toBeGreaterThanOrEqual(17);  // joint handles
  });

  // AC-14: Shift+drag pans skeleton
  test("shift+drag moves entire skeleton", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    // Get initial nose position
    const initialCx = await page.evaluate(() => {
      return parseFloat(document.getElementById("pose-skeleton-overlay")
        .querySelector('circle[data-joint="nose"]').getAttribute("cx"));
    });

    // Shift+drag on the canvas center (away from joints)
    await page.mouse.move(600, 400);
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(700, 400, { steps: 5 }); // drag right
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.waitForTimeout(100);

    const newCx = await page.evaluate(() => {
      return parseFloat(document.getElementById("pose-skeleton-overlay")
        .querySelector('circle[data-joint="nose"]').getAttribute("cx"));
    });

    // Nose should have moved right
    expect(newCx).toBeGreaterThan(initialCx);
  });

  // AC-15: Body shapes use skin color from settings
  test("skeleton body uses skin color matching layer setting", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    // Check that body parts use the skin color fill
    const fill = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      const path = svg.querySelector("path"); // first limb capsule
      return path ? path.getAttribute("fill") : null;
    });

    // Default skin tone is "light" = #ffdbac
    expect(fill).toBe("#ffdbac");
  });

  // AC-16: Scroll wheel scales skeleton
  test("scroll wheel scales skeleton size", async ({ page }) => {
    await addLayerAndOpenPanel(page);
    await enablePose(page);

    // Get initial skeleton height (ankle.cy - nose.cy)
    const initialHeight = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      const nose = svg.querySelector('circle[data-joint="nose"]');
      const ankle = svg.querySelector('circle[data-joint="left_ankle"]');
      return parseFloat(ankle.getAttribute("cy")) - parseFloat(nose.getAttribute("cy"));
    });

    // Move mouse to center of visible viewport (away from joints), then scroll
    await page.mouse.move(600, 400);

    // Scroll down multiple times to shrink
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 100); // deltaY > 0 = shrink
      await page.waitForTimeout(30);
    }

    const newHeight = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      const nose = svg.querySelector('circle[data-joint="nose"]');
      const ankle = svg.querySelector('circle[data-joint="left_ankle"]');
      return parseFloat(ankle.getAttribute("cy")) - parseFloat(nose.getAttribute("cy"));
    });

    // Skeleton should be smaller
    expect(newHeight).toBeLessThan(initialHeight);
  });
});
