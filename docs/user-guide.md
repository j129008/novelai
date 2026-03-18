# User Guide

This guide covers every feature of the NovelAI Image Generator, from generating your first image to advanced style control.

---

## Table of Contents

1. [Generating Your First Image](#1-generating-your-first-image)
2. [Writing Prompts](#2-writing-prompts)
3. [Canvas Size](#3-canvas-size)
4. [Quality (Steps)](#4-quality-steps)
5. [Seed](#5-seed)
6. [Image to Image](#6-image-to-image)
7. [Style Reference (Vibe Transfer)](#7-style-reference-vibe-transfer)
8. [Fine-tuning](#8-fine-tuning)
9. [History](#9-history)
10. [Tag Browser](#10-tag-browser)
11. [Settings](#11-settings)
12. [Keyboard Shortcut](#12-keyboard-shortcut)

---

## 1. Generating Your First Image

1. Open http://localhost:8000 in your browser.
2. Type a description in the **Prompt** field. Example: `1girl, long white hair, blue eyes, garden, soft lighting`
3. Click **Generate** (or press Cmd/Ctrl + Enter).
4. The image appears on the right. It is automatically saved to your output folder.

That is the complete workflow. Everything else in this guide makes the image more precisely what you want.

---

## 2. Writing Prompts

### Prompt tab

Type what you want in the image. Tags work well (comma-separated), but natural language descriptions also work with the V4.5 model.

### Undesired tab

Type what you want to avoid. This field is pre-filled with a reasonable default when you switch to it.

### Quality toggle

The **Quality** pill above the prompt box appends quality-boosting tags to your prompt automatically:

```
, very aesthetic, masterpiece, no text
```

Leave it on unless you have a reason to turn it off. When you load settings from a History image, the app strips these tags from the displayed prompt to avoid duplication.

### Undesired presets

When the Undesired tab is active, a dropdown lets you choose a preset to fill the field:

| Preset | Best for |
|--------|----------|
| Human Focus | Human characters; adds anatomy and eye corrections |
| Heavy | Strong artifact and quality suppression |
| Light | Lighter suppression; fewer excluded tags |
| Furry Focus | Furry/animal-style content |
| None | Empty field; write your own |

Selecting a preset replaces whatever is currently in the Undesired field.

---

## 3. Canvas Size

The **Canvas Size** dropdown sets the output resolution. Choose based on the composition you want:

| Preset | Pixels | Use when |
|--------|--------|----------|
| Portrait (832x1216) | 1.01 MP | Default; single character, vertical compositions |
| Landscape (1216x832) | 1.01 MP | Scenes, multiple characters side by side |
| Square (1024x1024) | 1.05 MP | Centered subjects, icons |
| Small Portrait (512x768) | 0.39 MP | Faster generation, testing prompts |
| Small Landscape (768x512) | 0.39 MP | Faster generation, wide scenes |
| Wallpaper Portrait (1088x1920) | 2.09 MP | Phone wallpapers |
| Wallpaper Landscape (1920x1088) | 2.09 MP | Desktop wallpapers |

---

## 4. Quality (Steps)

The **Quality** slider (labeled "Draft" to "Best") controls how many diffusion steps the model runs.

- Range: 1–50. Default: 28.
- More steps generally produce sharper, more detailed images.
- More steps also mean longer generation time.
- Values above 30–35 offer diminishing returns for most prompts.

---

## 5. Seed

The **Seed** field controls the random starting point for image generation.

- **0 (default)** — a random seed is chosen each time. Every generation is different.
- **Any other number** — the same seed with the same prompt and settings produces the same image every time.

### Reuse Seed

After generating, click **Reuse Seed** to copy the seed from the last result into the Seed field. Use this to generate variations: change the prompt slightly while keeping the seed, and you will get a related composition.

### Iterate

Click **Iterate** to load the last generated image as the source for Image to Image mode. The Image to Image section opens automatically. This is the fastest way to refine a result you almost like.

---

## 6. Image to Image

Image to Image lets you provide a source image. The model reworks it according to your prompt.

### Setting a source image

Three ways to provide a source:

- Click **Upload source image** in the Image to Image section and choose a file.
- Drag an image file onto the canvas area.
- Click **Iterate** after a generation to use the last result.

### Crop tool

After selecting an image, a crop overlay appears. The crop frame matches the currently selected Canvas Size.

- **Drag** to pan the image inside the frame.
- **Scroll** to zoom in or out.
- **Fit** — scales the image so the entire image fits inside the frame (may leave borders).
- **Fill** — scales the image so the frame is fully covered (may crop edges).
- Click **Confirm Crop** to accept.

To change the source image, click **Change**. To remove it entirely, click **Remove**.

### Transformation slider

Controls how much the model changes the source image. Range 0–1, default 0.70.

- Low values (0.2–0.4): subtle changes, image stays close to the source.
- High values (0.7–1.0): dramatic changes, only rough structure from the source is preserved.

### Variation slider

Adds extra noise before the diffusion pass. Range 0–1, default 0.00.

- At 0: the output varies only by how the prompt differs from the source.
- Higher values introduce more randomness, producing more varied results from the same source.

---

## 7. Style Reference (Vibe Transfer)

Style Reference lets you upload an image whose visual style influences the output without being used as a structural source.

Open the **Style Reference** section and upload an image by dropping it in the upload zone or clicking it.

### Vibe Intensity (reference_strength)

How strongly the style reference pulls the output toward its look. Range 0–1, default 0.60.

- Low: a faint stylistic nod.
- High: the output strongly resembles the style of the reference.

### Style Influence (reference_information_extracted)

How much information is extracted from the reference image before applying it. Range 0–1, default 1.00.

- Lower values use only broad style cues (color palette, mood).
- Higher values extract more detail (lighting, texture, composition).

To remove the style reference, click **Remove image**.

---

## 8. Fine-tuning

Open the **Fine-tuning** section for additional controls.

### Style Engine (sampler)

The sampling algorithm. Each has a different character:

| Label | Sampler key | Character |
|-------|-------------|-----------|
| Creative | k_euler_ancestral | Default; varied, lively results |
| Fast | k_euler | Faster, slightly less varied |
| Balanced | k_dpmpp_2s_ancestral | Good quality-to-speed balance |
| High Quality | k_dpmpp_2m | Sharper at the same step count |
| High Quality (Smooth) | k_dpmpp_2m_sde | Smooth, detailed |
| Smooth | k_dpmpp_sde | Soft, painterly quality |

### Prompt Adherence (scale / CFG)

How literally the model follows your prompt. Range 0–10, default 5.0.

- Low (1–3): the model is creative and may deviate from the prompt.
- Middle (5–7): balanced between faithfulness and creativity.
- High (8–10): the model follows the prompt precisely, but results can look over-saturated.

---

## 9. History

Click the **History** tab (next to the Canvas tab) to see all saved images.

Each entry shows a thumbnail, prompt snippet, and seed. Click an entry to:

- See the full image.
- Click **Load Settings** to restore the prompt, seed, and parameters that produced it.
- Click the trash icon to permanently delete it from the output folder.

### Searching history

Type in the search box that appears when the History tab is open. The list filters by prompt text and seed.

---

## 10. Tag Browser

Click the **Tags** button (top-right of the canvas area) to open the Tag Browser drawer.

The browser shows tags grouped by category (Hair Color, Eye Color, Clothing, etc.). Click any tag to insert it at the cursor position in the Prompt field.

Use the **Filter tags** search box at the top of the drawer to find tags within a category.

The Tag Browser also provides autocomplete while you type in the Prompt field: type at least one character and a dropdown appears showing matching tags. Click any suggestion to insert it.

---

## 11. Settings

Click the gear icon (top-right of the header) to open Settings.

### Output folder

Displays the current path where generated images are saved. The default is `output/` inside the project folder.

- **Browse** (macOS only): opens a folder picker dialog.
- **Open in Finder** (macOS only): opens the output folder directly in Finder.

To change the output path on non-macOS systems, use the API directly:

```bash
curl -X PUT http://localhost:8000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"output_dir": "/your/preferred/path"}'
```

---

## 12. Keyboard Shortcut

**Cmd + Enter** (macOS) or **Ctrl + Enter** (Windows/Linux) submits the generation from anywhere on the page.
