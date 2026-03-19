import numpy as np
from PIL import Image, ImageFilter
orig_img = Image.new("RGB", (100, 100), (255, 0, 0))
result_img = Image.new("RGB", (100, 100), (0, 255, 0))
mask_img = Image.new("L", (100, 100), 255)
# mask_img.paste(255, (25, 25, 75, 75))
orig_arr = np.array(orig_img)
result_arr = np.array(result_img)
mask_arr = np.array(mask_img)

expanded_mask_img = Image.fromarray(mask_arr).filter(ImageFilter.MaxFilter(11))
blurred_mask = np.array(
    expanded_mask_img.filter(ImageFilter.GaussianBlur(15))
).astype(np.float32) / 255.0

sharp_bool = mask_arr > 128
blend_mask = np.where(sharp_bool, 1.0, blurred_mask)
print(orig_arr.shape, result_arr.shape, blend_mask.shape)
blended = (orig_arr.astype(np.float32) * (1 - blend_mask[:, :, np.newaxis]) +
           result_arr.astype(np.float32) * blend_mask[:, :, np.newaxis])
final = np.clip(blended, 0, 255).astype(np.uint8)
out = Image.fromarray(final, mode="RGB")
out.save("/tmp/test_out.png")
