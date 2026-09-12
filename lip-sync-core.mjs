/**
 * lip-sync-core.mjs — 音频驱动角色说话动画：核心纯函数模块
 *
 * 移植自 ai-playground/projects/lip-sync-fusion/scripts/lip_sync_gen.py
 * 逻辑保持一致：RMS 按帧分块 → 阈值 + attack/release 平滑 → 随机眨眼调度
 * 无 DOM 依赖，浏览器与 Node 共用（Node 侧用于验证）。
 */

// ---------- 移动端视频限制 ----------

/** 移动端视频允许的最长时长；超过后必须先在设备上裁剪。 */
export const MOBILE_VIDEO_MAX_DURATION_SEC = 10 * 60;

/** 移动端视频允许的最大文件大小（500 MiB）。 */
export const MOBILE_VIDEO_MAX_SIZE_BYTES = 500 * 1024 * 1024;

export function mobileVideoSizeLimitMessage(sizeBytes) {
  const size = Number(sizeBytes);
  return Number.isFinite(size) && size > MOBILE_VIDEO_MAX_SIZE_BYTES
    ? "视频文件超过 500MB，请先裁剪视频后再处理"
    : "";
}

export function mobileVideoDurationLimitMessage(durationSec) {
  const duration = Number(durationSec);
  return Number.isFinite(duration) && duration > MOBILE_VIDEO_MAX_DURATION_SEC
    ? "视频超过 10 分钟，请先裁剪视频后再处理"
    : "";
}

// ---------- GIF 导出 ----------

/** GIF 允许导出的最长时长（秒）；GIF 逐帧量化体积与耗时随帧数线性增长。 */
export const GIF_MAX_DURATION_SEC = 10;

/**
 * 计算每帧 GIF 延迟（毫秒）。GIF 延迟以 10ms 为粒度，直接对 1000/fps 取整
 * 会让总时长漂移；这里按累计时间取整再相减，保证总时长与 1/fps 序列一致。
 */
export function gifFrameDelays(count, fps) {
  const n = Number(count);
  const rate = Number(fps);
  if (!Number.isInteger(n) || n <= 0 || !Number.isFinite(rate) || rate <= 0) {
    throw new RangeError("GIF 帧数或帧率无效");
  }
  const delays = new Array(n);
  let previous = 0;
  for (let i = 0; i < n; i++) {
    const cumulative = Math.round((i + 1) * 1000 / rate);
    delays[i] = Math.max(2, cumulative - previous);
    previous = cumulative;
  }
  return delays;
}

// ---------- 画布布局 ----------

/**
 * 计算图片与画布的安全边距。
 * 图片四周至少预留图片高度 10% 的空间，并按当前控件上限为弹跳/摇摆留足余量。
 */
export function canvasLayout(img, targetH) {
  const naturalWidth = Number(img?.naturalWidth);
  const naturalHeight = Number(img?.naturalHeight);
  if (!(naturalWidth > 0 && naturalHeight > 0)) {
    throw new RangeError("图片尺寸无效");
  }
  const imageHeight = Math.max(1, Math.round(Number(targetH) || 0));
  const imageWidth = Math.max(1, Math.round(naturalWidth * imageHeight / naturalHeight));
  const maxBounce = 0.2;
  const maxWiggle = 3 * Math.PI / 180;
  const halfWidth = imageWidth / 2;
  const maxHeight = imageHeight * (1 + maxBounce);
  const topOverflow = halfWidth * Math.sin(maxWiggle) + maxHeight * Math.cos(maxWiggle) - imageHeight;
  const sideOverflow = halfWidth * Math.cos(maxWiggle) + maxHeight * Math.sin(maxWiggle) - halfWidth;
  // 弹跳只从底部锚点向上拉伸，图片底边无需留白；仅向上/左右拓展安全边距，
  // 摇摆旋转的底角下沉（半宽×sin3°，约十几像素）维持画布底边裁切，与旧版行为一致。
  const motionPadding = Math.max(0, topOverflow, sideOverflow);
  const padding = Math.max(1, Math.ceil(Math.max(imageHeight * 0.1, motionPadding)));
  return {
    width: imageWidth + padding * 2,
    height: imageHeight + padding,
    imageWidth,
    imageHeight,
    padding,
  };
}

// ---------- 振幅分析 ----------

/** 按视频帧分块求 RMS。samples: Float32Array(-1..1)，返回每帧 RMS 数组 */
export function frameRMS(samples, sr, fps) {
  const block = Math.max(1, Math.floor(sr / fps));
  const nframes = Math.ceil(samples.length / block);
  const rms = new Float32Array(nframes);
  for (let i = 0; i < nframes; i++) {
    const start = i * block;
    const end = Math.min(samples.length, start + block);
    let acc = 0;
    for (let j = start; j < end; j++) acc += samples[j] * samples[j];
    rms[i] = end > start ? Math.sqrt(acc / (end - start)) : 0;
  }
  return rms;
}

/**
 * 阈值判断 + attack/release 平滑 → 0/1 嘴巴状态
 * attack 立即响应（张嘴要快）；release 保持 releaseFrames 帧再闭（防闪烁）
 */
export function thresholdStates(rms, threshold, attackFrames, releaseFrames) {
  const states = new Uint8Array(rms.length);
  let cur = 0;
  let hold = 0;
  for (let i = 0; i < rms.length; i++) {
    const v = rms[i];
    if (v > threshold) {
      cur = 1; // attack 立即响应
      hold = releaseFrames;
      states[i] = 1;
    } else {
      if (cur === 1) {
        if (hold > 0) { hold--; states[i] = 1; }
        else { cur = 0; states[i] = 0; }
      } else {
        states[i] = 0;
      }
    }
  }
  return states;
}

/**
 * 在连续说话区间内交替输出张嘴/闭嘴状态。
 * frequencyHz 表示完整的“张嘴+闭嘴”循环次数/秒；每次说话重新从张嘴开始。
 */
export function alternateMouthStates(speakingStates, fps, frequencyHz = 6) {
  const states = new Uint8Array(speakingStates.length);
  const frequency = Number(frequencyHz);
  if (!Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(fps) || fps <= 0) {
    states.set(speakingStates);
    return states;
  }

  let phase = 0;
  let wasSpeaking = false;
  const phaseStep = 2 * frequency / fps;
  for (let i = 0; i < speakingStates.length; i++) {
    if (speakingStates[i]) {
      if (!wasSpeaking) phase = 0;
      states[i] = Math.floor(phase) % 2 === 0 ? 1 : 0;
      phase += phaseStep;
      wasSpeaking = true;
    } else {
      phase = 0;
      wasSpeaking = false;
      states[i] = 0;
    }
  }
  return states;
}

/**
 * 把用户输入的秒数范围转换成导出使用的帧区间（左闭右开）。
 * 起止时间保持音频精度，视频帧按 fps 向下/向上取整，确保短范围也至少导出一帧。
 */
export function resolveExportRange(duration, start, end, fps, nframes) {
  const totalDuration = Number(duration);
  let from = Number(start);
  let to = Number(end);
  const rate = Number(fps);
  const totalFrames = Number(nframes);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new RangeError("音频时长必须大于 0");
  }
  // 两位小数四舍五入可能让结束时间比实际时长多出几毫秒；容差内截断回实际时长
  if (to > totalDuration && to - totalDuration <= 0.01 + 1e-9) to = totalDuration;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > totalDuration || to <= from) {
    throw new RangeError(`导出范围必须在 0~${totalDuration.toFixed(3)} 秒内，且结束时间大于开始时间`);
  }
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isInteger(totalFrames) || totalFrames <= 0) {
    throw new RangeError("导出帧率或帧数无效");
  }

  const startFrame = Math.min(totalFrames - 1, Math.max(0, Math.floor(from * rate)));
  const endFrame = Math.min(totalFrames, Math.max(startFrame + 1, Math.ceil(to * rate)));
  return {
    start: from,
    end: to,
    duration: to - from,
    startFrame,
    endFrame,
  };
}

/** 把逐帧 0/1 压缩成变化点关键帧 [[frame, value], ...] */
export function compactKeys(states) {
  const keys = [];
  let prev = null;
  for (let i = 0; i < states.length; i++) {
    if (states[i] !== prev) { keys.push([i, states[i]]); prev = states[i]; }
  }
  return keys;
}

// ---------- 眨眼调度 ----------

/** 随机眨眼：返回 0/1 序列（1=闭眼）。rng: () => [0,1) 均匀随机 */
export function scheduleBlinks(totalFrames, fps, minS, maxS, durationS, rng = Math.random) {
  const blink = new Uint8Array(totalFrames);
  const dur = Math.max(1, Math.round(durationS * fps));
  let t = randRange(rng, minS, maxS) * fps;
  while (t < totalFrames) {
    const start = Math.round(t);
    const end = Math.min(totalFrames, start + dur);
    for (let f = start; f < end; f++) blink[f] = 1;
    t += randRange(rng, minS, maxS) * fps + dur;
  }
  return blink;
}

function randRange(rng, a, b) { return a + rng() * (b - a); }

// ---------- 可复现随机数（mulberry32，同 Python seed 语义）----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 动效（Veadotube 风格附加动效）----------

/**
 * 说话弹跳：张嘴时角色轻微 squash-stretch。
 * 返回每帧缩放系数 [scaleX, scaleY]（1=原样）。
 * intensity: 0~1 强度；talkStates: 0/1 嘴巴状态
 */
export function talkBounce(talkStates, fps, intensity = 0.06, freq = 3.0) {
  const n = talkStates.length;
  const sx = new Float32Array(n), sy = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    if (talkStates[i]) {
      phase += (2 * Math.PI * freq) / fps;
      const bounce = Math.abs(Math.sin(phase)) * intensity;
      sy[i] = 1 + bounce;        // 说话时纵向拉伸
      sx[i] = 1 - bounce * 0.6;  // 横向压缩（squash）
    } else {
      phase = 0;
      // 平滑回落
      const prevY = i > 0 ? sy[i - 1] : 1;
      const prevX = i > 0 ? sx[i - 1] : 1;
      sy[i] = prevY + (1 - prevY) * 0.25;
      sx[i] = prevX + (1 - prevX) * 0.25;
    }
  }
  return { sx, sy };
}

/**
 * 说话摇摆（idle sway + talk wiggle，Veadotube 常见参数）
 * 返回每帧旋转角度（度）
 */
export function talkWiggle(talkStates, fps, intensity = 2.5, freq = 6.0) {
  const n = talkStates.length;
  const rot = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    if (talkStates[i]) {
      phase += (2 * Math.PI * freq) / fps;
      rot[i] = Math.sin(phase) * intensity;
    } else {
      phase = 0;
      const prev = i > 0 ? rot[i - 1] : 0;
      rot[i] = prev * 0.85;
    }
  }
  return rot;
}

// ---------- 音频解码（浏览器端，AudioBuffer → mono Float32）----------

export function audioBufferToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const a = buffer.getChannelData(0), b = buffer.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}
