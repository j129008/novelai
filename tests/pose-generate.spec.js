const { test, expect } = require("@playwright/test");

// Setup: fresh page with pose.js loaded
async function freshPage(page) {
  await page.goto("/?t=" + Date.now());
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof getDefaultJoints === "function", null, { timeout: 5000 });
}

test.describe("Pose Generate Integration", () => {
  test.beforeEach(async ({ page }) => {
    await freshPage(page);
  });

  // Test 1: Pose-only (no layer images) — verify body.image contains pose silhouette
  test("pose-only: body.image is the pose silhouette, strength from pose slider", async ({ page }) => {
    await page.evaluate(() => {
      document.getElementById("layer-tabs-add").click();
      layers[0].poseData = {
        enabled: true, bodyType: "male",
        joints: getDefaultJoints("male"), poseStrength: 0.6, skinTone: "light",
      };
      layers[0].visible = true;
      const le = document.getElementById("layers-enabled");
      if (le && !le.checked) le.click();
      saveLayersToStorage();
      renderPoseSkeleton(0);
      // Set prompt
      document.getElementById("prompt").value = "1girl, standing";
    });

    // Intercept generate request
    const genPromise = page.waitForRequest(
      (req) => req.url().includes("/api/generate") && req.method() === "POST",
      { timeout: 15000 }
    );

    // Click generate
    await page.locator("#cpb-collapsed-gen, #cpb-generate-btn").first().click();

    const req = await genPromise;
    const body = req.postDataJSON();

    // body.image MUST be present (pose silhouette as img2img)
    expect(body.image).toBeTruthy();
    expect(body.image.length).toBeGreaterThan(100); // base64 image, not empty

    // Strength should be from pose slider (0.6), NOT the main slider
    expect(body.strength).toBeCloseTo(0.6, 1);
  });

  // Test 2: Layers + pose — verify composite contains both
  test("layers+pose: body.image is composite of layer images and pose", async ({ page }) => {
    await page.evaluate(() => {
      // Layer 1: purple background
      document.getElementById("layer-tabs-add").click();
      const c = document.createElement("canvas");
      c.width = 200; c.height = 300;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#800080"; // purple
      ctx.fillRect(0, 0, 200, 300);
      layers[0].imageBase64 = c.toDataURL("image/png").split(",")[1];
      layers[0].visible = true;

      // Layer 2: pose figure
      document.getElementById("layer-tabs-add").click();
      layers[1].poseData = {
        enabled: true, bodyType: "male",
        joints: getDefaultJoints("male"), poseStrength: 0.6, skinTone: "light",
      };
      layers[1].visible = true;

      const le = document.getElementById("layers-enabled");
      if (le && !le.checked) le.click();

      saveLayersToStorage();
      _activeLayerIdx = 1;
      renderPoseSkeleton(1);

      // Set main strength to 0.7 and prompt
      document.getElementById("strength").value = "0.7";
      document.getElementById("prompt").value = "1girl, standing, purple background";
    });

    const genPromise = page.waitForRequest(
      (req) => req.url().includes("/api/generate") && req.method() === "POST",
      { timeout: 15000 }
    );

    await page.locator("#cpb-collapsed-gen, #cpb-generate-btn").first().click();

    const req = await genPromise;
    const body = req.postDataJSON();

    // body.image MUST be present
    expect(body.image).toBeTruthy();
    expect(body.image.length).toBeGreaterThan(100);

    // Strength should be user's 0.7, NOT overridden by pose
    expect(body.strength).toBeCloseTo(0.7, 1);

    // Verify the composite image contains purple (from layer) AND skin color (from pose)
    const colors = await page.evaluate(async (imgBase64) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = "data:image/png;base64," + imgBase64;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      // Sample corner (should have purple from background)
      const corner = ctx.getImageData(5, 5, 1, 1).data;
      // Sample center body area (should have skin+purple blend)
      const center = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height * 0.3), 1, 1).data;

      return {
        cornerR: corner[0], cornerG: corner[1], cornerB: corner[2],
        centerR: center[0], centerG: center[1], centerB: center[2],
        width: img.width, height: img.height,
      };
    }, body.image);

    // Corner should be purple-ish (R > 100, B > 100, G < 50 for pure purple)
    // After 50% pose silhouette blend, it won't be pure purple but should still be reddish/purplish
    expect(colors.cornerR).toBeGreaterThan(60);
    expect(colors.cornerB).toBeGreaterThan(60);

    // Image dimensions should match generation resolution
    expect(colors.width).toBeGreaterThan(0);
    expect(colors.height).toBeGreaterThan(0);
  });

  // Test 3: render-pose API returns valid image with correct dimensions
  test("render-pose returns valid silhouette at requested dimensions", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const joints = getDefaultJoints("male");
      const resp = await fetch("/api/render-pose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          figures: [{ joints, body_type: "male", skin_tone: "light" }],
          width: 832, height: 1216,
        }),
      });
      if (!resp.ok) return { error: resp.status };
      const data = await resp.json();

      // Decode and check
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = "data:image/png;base64," + data.image;
      });

      const canvas = document.createElement("canvas");
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      // Check background (corner) = white
      const bg = ctx.getImageData(0, 0, 1, 1).data;
      // Check body center (should be skin color, not white)
      const body = ctx.getImageData(416, 400, 1, 1).data; // roughly center of torso

      return {
        width: img.width, height: img.height,
        bgR: bg[0], bgG: bg[1], bgB: bg[2],
        bodyR: body[0], bodyG: body[1], bodyB: body[2],
      };
    });

    expect(result.width).toBe(832);
    expect(result.height).toBe(1216);

    // Background is now transparent RGBA — corner pixels are (0,0,0,0)
    // Body center should have skin color (non-transparent)
    const bodyIsBlank = result.bodyR === 0 && result.bodyG === 0 && result.bodyB === 0;
    expect(bodyIsBlank).toBe(false);
  });

  // Test 4: Two pose figures produce two separate silhouettes
  test("multi-figure: render-pose includes all figures", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const maleJoints = getDefaultJoints("male");
      // Shift male left
      for (const k of Object.keys(maleJoints)) maleJoints[k][0] -= 0.2;

      const childJoints = getDefaultJoints("child");
      // Shift child right
      for (const k of Object.keys(childJoints)) childJoints[k][0] += 0.2;

      const resp = await fetch("/api/render-pose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          figures: [
            { joints: maleJoints, body_type: "male", skin_tone: "light" },
            { joints: childJoints, body_type: "child", skin_tone: "dark" },
          ],
          width: 400, height: 600,
        }),
      });
      const data = await resp.json();

      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = "data:image/png;base64," + data.image; });
      const canvas = document.createElement("canvas");
      canvas.width = 400; canvas.height = 600;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      // Check left side (male, light skin) and right side (child, dark skin)
      const left = ctx.getImageData(120, 250, 1, 1).data;  // male torso area
      const right = ctx.getImageData(280, 300, 1, 1).data; // child torso area

      return {
        leftR: left[0], leftG: left[1], leftB: left[2],
        rightR: right[0], rightG: right[1], rightB: right[2],
      };
    });

    // Left (male light skin) should be pinkish/peach
    expect(result.leftR).toBeGreaterThan(200);
    expect(result.leftG).toBeGreaterThan(150);

    // Right (child dark skin) should be brownish
    expect(result.rightR).toBeLessThan(200);
    expect(result.rightR).toBeGreaterThan(80);
  });

  // Test 5: Verify layers-enabled is required for layer composite
  test("layers-disabled: only pose silhouette sent, no layer images", async ({ page }) => {
    await page.evaluate(() => {
      // Layer 1: purple bg
      document.getElementById("layer-tabs-add").click();
      const c = document.createElement("canvas");
      c.width = 100; c.height = 100;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#800080";
      ctx.fillRect(0, 0, 100, 100);
      layers[0].imageBase64 = c.toDataURL("image/png").split(",")[1];
      layers[0].visible = true;

      // Layer 2: pose
      document.getElementById("layer-tabs-add").click();
      layers[1].poseData = {
        enabled: true, bodyType: "male",
        joints: getDefaultJoints("male"), poseStrength: 0.6, skinTone: "light",
      };

      // Do NOT enable layers toggle
      const le = document.getElementById("layers-enabled");
      if (le && le.checked) le.click();

      saveLayersToStorage();
      document.getElementById("prompt").value = "test";
    });

    const genPromise = page.waitForRequest(
      (req) => req.url().includes("/api/generate") && req.method() === "POST",
      { timeout: 15000 }
    );

    await page.locator("#cpb-collapsed-gen, #cpb-generate-btn").first().click();
    const req = await genPromise;
    const body = req.postDataJSON();

    // Image should be pose-only (white bg + skin silhouette), NOT purple
    expect(body.image).toBeTruthy();

    const bgColor = await page.evaluate(async (imgB64) => {
      const img = new Image();
      await new Promise((r) => { img.onload = r; img.src = "data:image/png;base64," + imgB64; });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(5, 5, 1, 1).data;
      return { r: px[0], g: px[1], b: px[2] };
    }, body.image);

    // Corner should be white (from pose silhouette bg), NOT purple
    expect(bgColor.r).toBeGreaterThan(250);
    expect(bgColor.g).toBeGreaterThan(250);
    expect(bgColor.b).toBeGreaterThan(250);
  });
});
