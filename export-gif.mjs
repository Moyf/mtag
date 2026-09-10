/**
 * export-gif.mjs — GIF 导出：gifenc 逐帧量化编码（纯 JS，无需 WebCodecs）
 * 每帧离屏渲染 → Wu 量化 256 色 → LZW 编码；体积与耗时随帧数线性增长，
 * 由调用方（app.mjs）保证范围不超过 GIF_MAX_DURATION_SEC。
 * opts: { imgs, analysis, fps, width, height, frameStart, frameEnd,
 *         bg: { color?, image? }, signal, onProgress }
 */
import { GIFEncoder, quantize, applyPalette } from "./vendor.gifenc.mjs";
import { renderFrame } from "./export-fast.mjs";
import { gifFrameDelays } from "./lip-sync-core.mjs";

export async function exportGif(opts) {
  const { imgs, analysis, bg, onProgress } = opts;
  const fps = opts.fps, W = opts.width, H = opts.height;
  const frameStart = Number.isInteger(opts.frameStart) ? opts.frameStart : 0;
  const frameEnd = Number.isInteger(opts.frameEnd) ? opts.frameEnd : analysis.nframes;
  const n = frameEnd - frameStart;
  if (!Number.isInteger(frameStart) || !Number.isInteger(frameEnd) || frameStart < 0 || frameEnd > analysis.nframes || n <= 0) {
    throw new RangeError("导出帧范围无效");
  }
  throwIfAborted(opts.signal);

  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("当前浏览器不支持 Canvas 2D，无法导出 GIF");

  const gif = GIFEncoder();
  const delays = gifFrameDelays(n, fps);

  for (let i = 0; i < n; i++) {
    throwIfAborted(opts.signal);
    renderFrame(ctx, imgs, analysis, frameStart + i, bg, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, W, H, { palette, delay: delays[i] });
    if (onProgress && (i % 5 === 0 || i === n - 1)) onProgress(i + 1, n);
    if (i % 3 === 0) await new Promise(r => setTimeout(r, 0)); // UI 喘息
  }

  throwIfAborted(opts.signal);
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("导出已停止");
  error.name = "AbortError";
  throw error;
}
