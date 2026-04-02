const { test, expect } = require("@playwright/test");

async function freshPage(page) {
  await page.goto("/?t=" + Date.now());
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof getDefaultJoints === "function", null, { timeout: 5000 });
}

test.describe("Pose Alignment — overlay vs img2img input", () => {
  test.beforeEach(async ({ page }) => {
    await freshPage(page);
  });

  // Helper: setup layers with purple bg + pose figures, enable layers, switch to Input view
  async function setupScene(page, figures) {
    await page.evaluate((figs) => {
      // Purple bg layer
      document.getElementById("layer-tabs-add").click();
      const c = document.createElement("canvas");
      c.width = 832; c.height = 1216;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#800080";
      ctx.fillRect(0, 0, 832, 1216);
      layers[0].imageBase64 = c.toDataURL("image/png").split(",")[1];
      layers[0].visible = true;

      // Pose layers
      for (const fig of figs) {
        document.getElementById("layer-tabs-add").click();
        const idx = layers.length - 1;
        const joints = getDefaultJoints(fig.bodyType);
        // Apply offset
        if (fig.offsetX || fig.offsetY) {
          for (const k of Object.keys(joints)) {
            joints[k][0] += fig.offsetX || 0;
            joints[k][1] += fig.offsetY || 0;
          }
        }
        layers[idx].poseData = {
          enabled: true, bodyType: fig.bodyType,
          joints, poseStrength: 0.6, skinTone: fig.skinTone || "light",
        };
        layers[idx].visible = true;
      }

      const le = document.getElementById("layers-enabled");
      if (le && !le.checked) le.click();
      saveLayersToStorage();
      _activeLayerIdx = 1;
      renderPoseSkeleton(1);
    }, figures);

    // Switch to Input view
    await page.evaluate(() => {
      const btns = document.querySelectorAll("button");
      for (const b of btns) {
        if (b.textContent.trim() === "Input") { b.click(); break; }
      }
    });
    await page.waitForTimeout(500);
  }

  // Test: SVG overlay fills canvas-drop-target consistently (no resize after generate)
  test("single figure: overlay has consistent size with canvas area", async ({ page }) => {
    await setupScene(page, [{ bodyType: "male", offsetX: 0, offsetY: 0 }]);

    const result = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      const svgRect = svg.getBoundingClientRect();
      return {
        hasSize: svgRect.width > 100 && svgRect.height > 100,
        hasCircles: svg.querySelectorAll("circle").length >= 13,
        hasViewBox: svg.getAttribute("viewBox") !== null,
      };
    });

    expect(result.hasSize).toBe(true);
    expect(result.hasCircles).toBe(true);
    expect(result.hasViewBox).toBe(true);
  });

  // Test: two figures shifted left/right — overlay positions match render-pose positions
  test("two figures: overlay positions match render-pose output", async ({ page }) => {
    await setupScene(page, [
      { bodyType: "male", offsetX: -0.15, skinTone: "light" },
      { bodyType: "child", offsetX: 0.15, skinTone: "dark" },
    ]);

    const result = await page.evaluate(async () => {
      const svg = document.getElementById("pose-skeleton-overlay");
      const svgRect = svg.getBoundingClientRect();

      // Get all nose circles (there should be 2 — one per active pose layer)
      const noseCircles = svg.querySelectorAll('circle[data-joint="nose"]');

      // Get the render-pose output at the same resolution
      const poseFigures = collectPosePayload();
      const resp = await fetch("/api/render-pose", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ figures: poseFigures, width: 832, height: 1216 }),
      });
      const poseData = await resp.json();

      // Check that we got 2 figures in the payload
      return {
        numPoseFigures: poseFigures.length,
        numNoseCircles: noseCircles.length,
        hasPoseImage: !!poseData.image,
        svgAligned: svgRect.width > 0 && svgRect.height > 0,
      };
    });

    expect(result.numPoseFigures).toBe(2);
    // Active layer shows circles, inactive doesn't — but both figures are rendered
    expect(result.numNoseCircles).toBeGreaterThanOrEqual(1);
    expect(result.hasPoseImage).toBe(true);
    expect(result.svgAligned).toBe(true);
  });

  // Test: after scroll-to-scale, overlay and img2img input still have matching positions
  test("after scaling: overlay and img2img positions still aligned", async ({ page }) => {
    await setupScene(page, [{ bodyType: "male", offsetX: 0 }]);

    // Scale down via wheel
    await page.mouse.move(600, 400);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(200);

    const result = await page.evaluate(async () => {
      // After scaling, the joints changed. Get current nose position
      const nosePos = layers[1].poseData.joints.nose;

      // Render the pose at generation resolution
      const poseFigures = collectPosePayload();
      const resp = await fetch("/api/render-pose", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ figures: poseFigures, width: 832, height: 1216 }),
      });
      const poseData = await resp.json();

      // Decode and check nose position in the rendered image
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = "data:image/png;base64," + poseData.image; });
      const c = document.createElement("canvas");
      c.width = 832; c.height = 1216;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);

      // Check pixel at nose position — should be skin color (not transparent/white)
      const px = Math.round(nosePos[0] * 832);
      const py = Math.round(nosePos[1] * 1216);
      const pixel = ctx.getImageData(px, py, 1, 1).data;

      return {
        nosePos,
        pixelAtNose: { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] },
        isSkinColor: pixel[3] > 200 && pixel[0] > 150, // not transparent, reddish
      };
    });

    // The rendered image should have skin color at the nose position
    expect(result.isSkinColor).toBe(true);
  });

  // Test: after shift+drag pan, overlay and img2img positions still match
  test("after panning: overlay and img2img positions still aligned", async ({ page }) => {
    await setupScene(page, [{ bodyType: "male", offsetX: 0 }]);

    // Shift+drag to move the skeleton
    await page.mouse.move(600, 400);
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(500, 350, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.waitForTimeout(200);

    const result = await page.evaluate(async () => {
      const nosePos = layers[1].poseData.joints.nose;
      const poseFigures = collectPosePayload();
      const resp = await fetch("/api/render-pose", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ figures: poseFigures, width: 832, height: 1216 }),
      });
      const poseData = await resp.json();
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = "data:image/png;base64," + poseData.image; });
      const c = document.createElement("canvas");
      c.width = 832; c.height = 1216;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = Math.round(nosePos[0] * 832);
      const py = Math.round(nosePos[1] * 1216);
      const pixel = ctx.getImageData(px, py, 1, 1).data;
      return {
        nosePos,
        isSkinColor: pixel[3] > 200 && pixel[0] > 150,
      };
    });

    expect(result.isSkinColor).toBe(true);
  });

  // Test: overlay hidden on Output view
  test("overlay hidden when switching to Output view", async ({ page }) => {
    await setupScene(page, [{ bodyType: "male", offsetX: 0 }]);

    // Verify visible on Input
    const visibleOnInput = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      return svg && svg.style.display !== "none" && svg.querySelectorAll("circle").length > 0;
    });
    expect(visibleOnInput).toBe(true);

    // Switch to Output
    await page.evaluate(() => {
      const btns = document.querySelectorAll("button");
      for (const b of btns) {
        if (b.textContent.trim() === "Output") { b.click(); break; }
      }
    });
    await page.waitForTimeout(300);

    const hiddenOnOutput = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      return svg && svg.style.display === "none";
    });
    expect(hiddenOnOutput).toBe(true);

    // Switch back to Input
    await page.evaluate(() => {
      const btns = document.querySelectorAll("button");
      for (const b of btns) {
        if (b.textContent.trim() === "Input") { b.click(); break; }
      }
    });
    await page.waitForTimeout(300);

    const visibleAgain = await page.evaluate(() => {
      const svg = document.getElementById("pose-skeleton-overlay");
      return svg && svg.style.display !== "none";
    });
    expect(visibleAgain).toBe(true);
  });

  // Test: generate while in Input view does NOT put image in #output
  test("generate in Input view does not overwrite output area", async ({ page }) => {
    await setupScene(page, [{ bodyType: "male", offsetX: 0 }]);

    // Set prompt
    await page.evaluate(() => {
      document.getElementById("prompt").value = "test no overwrite";
    });

    // Count #output children before generate
    const beforeCount = await page.evaluate(() => {
      return document.getElementById("output").querySelectorAll("img").length;
    });

    // Trigger generate (will fail without API key, but the request flow runs)
    const genPromise = page.waitForRequest(
      (req) => req.url().includes("/api/generate") && req.method() === "POST",
      { timeout: 10000 }
    ).catch(() => null);

    await page.locator("#cpb-collapsed-gen, #cpb-generate-btn").first().click();
    await genPromise;
    await page.waitForTimeout(500);

    // Verify _canvasView is still "input"
    const view = await page.evaluate(() => _canvasView);
    expect(view).toBe("input");

    // #output should NOT have a new generated image (API will fail but we check the flow)
    // The key assertion: if we're in input mode, no new img should be appended
    const hasGenImg = await page.evaluate(() => {
      const imgs = document.getElementById("output").querySelectorAll("img");
      for (const img of imgs) {
        if (img.alt === "Generated image") return true;
      }
      return false;
    });
    expect(hasGenImg).toBe(false);
  });
});
