"use strict";

const { createTelegramHandler } = require("./lib/telegram-kie");

const VALID_ASPECTS = new Set([
  "auto", "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1",
  "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"
]);

function normalizeAspect(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (VALID_ASPECTS.has(raw)) return raw;
  const named = {
    square: "1:1",
    portrait_3_4: "3:4",
    portrait_9_16: "9:16",
    landscape_4_3: "4:3",
    landscape_16_9: "16:9"
  };
  if (named[raw]) return named[raw];
  const coerced = raw.replace(/(\d)[_-](\d)/g, "$1:$2");
  return VALID_ASPECTS.has(coerced) ? coerced : "auto";
}

exports.handler = createTelegramHandler({
  version: "nano_banana_2_lite_tg_v1",
  runPrefix: "nano2lite",
  kind: "image",
  modelLabel: "Nano Banana 2 Lite",
  cost: () => 0.5,
  build(body, { prompt }) {
    const sourceUrls = Array.isArray(body.image_urls)
      ? body.image_urls
      : (Array.isArray(body.urls) ? body.urls : []);
    const imageUrls = sourceUrls.map((url) => encodeURI(String(url))).filter(Boolean).slice(0, 10);
    const input = {
      prompt,
      aspect_ratio: normalizeAspect(body.aspect_ratio || body.aspectRatio || body.size)
    };
    if (imageUrls.length) input.image_urls = imageUrls;
    return {
      model: "nano-banana-2-lite",
      input,
      response: { model: "nano-banana-2-lite", resolution: "1K" }
    };
  }
});
