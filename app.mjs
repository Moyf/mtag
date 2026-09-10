/**
 * app.mjs — MTAG（Moy's Talking Avatar Generator）主逻辑
 * 素材载入 → AudioContext 解码 → core 分析（RMS/阈值/眨眼/动效）→ canvas 逐帧渲染
 * 导出：默认 WebCodecs 快速编码，MediaRecorder 实时录制兜底；支持范围、进度与中止
 */
import { frameRMS, thresholdStates, alternateMouthStates, resolveExportRange, scheduleBlinks, mulberry32, talkBounce, talkWiggle, audioBufferToMono, mobileVideoSizeLimitMessage, mobileVideoDurationLimitMessage, GIF_MAX_DURATION_SEC } from "./lip-sync-core.mjs";
import { exportFast } from "./export-fast.mjs";
import { exportGif } from "./export-gif.mjs";

const $ = (id) => document.getElementById(id);

const state = {
  imgs: { a: null, b: null, c: null, d: null },   // 闭嘴/张嘴/闭眼/张眼
  audioBuf: null, audioName: "",
  audioUrl: null, currentTime: 0, exportRangeInitialized: false,
  assetRevision: 0, audioLoadId: 0,
  mono: null, sr: 44100,
  analysis: null,   // { rms, mouth, blink, bounce:{sx,sy}, wiggle, nframes, duration }
  playing: false,
  audioEl: null, rafId: 0,
  exporting: false, exportController: null,
  mediaProcessing: false, mediaController: null, mediaKind: null,
  pendingMediaFile: null,
  demo: false, demoClockStart: 0,   // 无音频时的演示预览（预生成说话节奏，可直接导出）
  bgImage: null, bgImageName: "",   // 自定义背景图片
};

const canvas = $("canvas"), ctx = canvas.getContext("2d");

function openFilePicker(target = "") {
  if (state.exporting || state.mediaProcessing || state.pendingMediaFile) return;
  const fileInput = target === "audio" ? $("audio-file-input") : $("file-input");
  if (!fileInput) return;
  fileInput.dataset.target = target;
  fileInput.click();
}

// 画布本身也是文件入口；键盘用户可用 Enter/Space 打开选择器
canvas.addEventListener("click", () => {
  openFilePicker();
});
canvas.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  e.stopPropagation();
  canvas.click();
});

// 占位提示区域仍是文件入口；仅复用按钮拦截点击，避免触发文件选择器。
const dropHint = $("drop-hint");
const reuseImageButton = $("reuse-image-btn");
dropHint?.addEventListener("click", (e) => {
  if (reuseImageButton?.contains(e.target)) return;
  openFilePicker();
});
reuseImageButton?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  reuseImageForMouth();
});

// ---------- 参数读取 ----------
function params() {
  return {
    fps: +$("p-fps").value,
    threshold: +$("p-threshold").value,
    attackMs: +$("p-attack").value,
    releaseMs: +$("p-release").value,
    alternateMouth: $("mouth-alternate").checked,
    alternateFreq: +$("p-alt-freq").value,
    blinkMin: +$("p-bmin").value,
    blinkMax: +$("p-bmax").value,
    blinkDur: +$("p-bdur").value,
    seed: +$("p-seed").value,
    fxBounce: $("fx-bounce").checked,
    bounceAmp: +$("p-bounce").value,
    bounceFreq: +$("p-bfreq").value,
    fxWiggle: $("fx-wiggle").checked,
    wiggleAmp: +$("p-wiggle").value,
    videoBitrateMbps: +$("p-vbitrate").value,
  };
}

// ---------- 文件载入 ----------
const dropZone = document.body;
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); });
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFiles(e.dataTransfer.files, null);
});
function handleFileInputChange(input, target = "") {
  const files = Array.from(input.files || []);
  // 在 change 回调里先清空并失焦，尽快释放 iOS 文件选择器；
  // File 对象已被复制到数组，不受清空 input.value 影响。
  input.value = "";
  input.blur();
  handleFiles(files, target);
}

$("file-input").addEventListener("change", (e) => {
  const target = e.target.dataset.target || "";
  e.target.dataset.target = "";
  handleFileInputChange(e.target, target);
});
$("audio-file-input").addEventListener("change", (e) => {
  handleFileInputChange(e.target, "audio");
});
// 点缩略图手动选
const dragTarget = (el, target) => {
  let depth = 0;
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  el.addEventListener("dragenter", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth++;
    el.classList.add("drag-over");
  });
  el.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", (e) => {
    if (!isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove("drag-over");
  });
  el.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    el.classList.remove("drag-over");
    handleFiles(e.dataTransfer.files, target);
  });
};

dragTarget($("stage"), null);
for (const slotEl of document.querySelectorAll(".slot-thumb")) {
  if (slotEl.id === "slot-audio") continue;
  dragTarget(slotEl, slotEl.dataset.slot || "audio");
  slotEl.addEventListener("click", () => {
    openFilePicker(slotEl.dataset.slot || "");
  });
}
const audioRow = document.querySelector(".audio-row");
dragTarget(audioRow, "audio");
audioRow.addEventListener("click", () => {
  openFilePicker("audio");
});
audioRow.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  e.stopPropagation();
  audioRow.click();
});

function handleFiles(files, explicitTarget = undefined) {
  if (state.exporting || state.mediaProcessing || state.pendingMediaFile) return;
  const target = explicitTarget === undefined ? $("file-input").dataset.target : explicitTarget;
  $("file-input").dataset.target = "";
  let imageTarget = target && target !== "audio" ? target : null;
  const reservedImageSlots = new Set(Object.keys(state.imgs).filter((slot) => state.imgs[slot]));
  for (const f of Array.from(files || [])) {
    if (isAudioFile(f)) {
      if (state.mediaProcessing) {
        setStatus("已有媒体正在处理，请等待完成", false);
        continue;
      }
      void loadAudio(f);
    }
    else if (isVideoFile(f)) {
      const message = "当前版本暂不支持视频，请选择 WAV / MP3 / M4A 音频文件";
      setMediaStatus(message, null, "error");
      setStatus(message, false);
    }
    else if (String(f?.type || "").toLowerCase().startsWith("image/") || /\.(png|webp|gif|jpe?g)$/i.test(String(f?.name || ""))) {
      const slot = imageTarget || nextEmptySlot(reservedImageSlots);
      if (slot) {
        reservedImageSlots.add(slot);
        loadImage(f, slot);
      } else {
        setStatus("4 张图已满，先点缩略图替换", false);
      }
      imageTarget = null;
    } else if (target === "audio" || !imageTarget) {
      setMediaStatus("不支持这个文件格式，请选择图片或 WAV / MP3 / M4A 音频文件", null, "error");
      setStatus("无法读取文件：格式不受支持", false);
    }
  }
}

function isAudioFile(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "");
  return type.startsWith("audio/") || /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(name);
}

function isVideoFile(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "");
  return type.startsWith("video/") || /\.(mov|mp4|m4v|webm)$/i.test(name);
}

function isMobileLikeBrowser() {
  const nav = typeof navigator === "object" ? navigator : null;
  const ua = nav?.userAgent || "";
  return nav?.userAgentData?.mobile === true
    || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)
    || (nav?.platform === "MacIntel" && nav?.maxTouchPoints > 1);
}

function getMobileVideoSizeLimitMessage(file) {
  return isMobileLikeBrowser() ? mobileVideoSizeLimitMessage(file?.size) : "";
}

function getMobileVideoDurationLimitMessage(durationSec) {
  return isMobileLikeBrowser() ? mobileVideoDurationLimitMessage(durationSec) : "";
}

function isIosLikeBrowser() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function videoPlaybackError(userGesture = false) {
  return new Error(userGesture
    ? "浏览器阻止了播放，请再次点击“开始提取音轨”重试"
    : "浏览器阻止了播放，请重新选择视频后重试");
}

function queueVideoAudio(file) {
  state.audioLoadId++;
  state.mediaKind = "video";
  state.pendingMediaFile = file;
  resetPlayback();
  state.audioBuf = null;
  state.mono = null;
  state.analysis = null;
  state.audioName = file.name;
  state.demo = false;
  state.exportRangeInitialized = false;
  $("audio-name").textContent = `${file.name}（已选择）`;
  $("slot-audio").classList.remove("loaded");
  setMediaStatus("视频已选择，请点击“开始提取音轨”", null, "pending");
  checkReady();
}

function nextEmptySlot(reserved = new Set()) {
  for (const k of ["a", "b", "c", "d"]) if (!state.imgs[k] && !reserved.has(k)) return k;
  return null;
}

let imageLoadingCount = 0;
let imageLoadingHadError = false;

function finishImageLoad(slot) {
  imageLoadingCount = Math.max(0, imageLoadingCount - 1);
  const el = $(`slot-${slot}`);
  el?.classList.remove("loading");
  el?.removeAttribute("aria-busy");
  if (imageLoadingCount === 0) {
    if (!imageLoadingHadError) {
      setStatus(state.demo ? "演示预览" : state.analysis ? "基于音频生成" : "待输入", true);
    }
    imageLoadingHadError = false;
  }
}

function loadImage(file, target) {
  const slot = target && state.imgs.hasOwnProperty(target) && target !== "audio" ? target : nextEmptySlot();
  if (!slot) { setStatus("4 张图已满，先点缩略图替换", false); return; }
  const assetRevision = state.assetRevision;
  const url = URL.createObjectURL(file);
  const img = new Image();
  const el = $(`slot-${slot}`);
  imageLoadingCount++;
  el.classList.add("loading");
  el.setAttribute("aria-busy", "true");
  setStatus(`正在读取图片 ${file.name}…`, true);
  img.onload = () => {
    if (assetRevision !== state.assetRevision) {
      URL.revokeObjectURL(url);
      finishImageLoad(slot);
      return;
    }
    const previous = state.imgs[slot];
    const stillUsedByAnotherSlot = previous && Object.entries(state.imgs)
      .some(([otherSlot, image]) => otherSlot !== slot && image === previous);
    if (previous?.src?.startsWith("blob:") && !stillUsedByAnotherSlot) URL.revokeObjectURL(previous.src);
    state.imgs[slot] = img;
    el.style.backgroundImage = `url(${url})`;
    el.classList.add("loaded");
    checkReady();
    if (state.analysis) renderPlaybackTime(state.currentTime);
    finishImageLoad(slot);
  };
  img.onerror = () => {
    imageLoadingHadError = true;
    setStatus(`图片读取失败：${file.name}`, false);
    URL.revokeObjectURL(url);
    finishImageLoad(slot);
  };
  img.src = url;
}

function reuseImageForMouth() {
  if (!state.imgs.a || state.imgs.b || state.exporting || state.mediaProcessing || state.pendingMediaFile) return;
  state.imgs.b = state.imgs.a;
  const slot = $("slot-b");
  if (slot) {
    slot.style.backgroundImage = `url(${state.imgs.b.src})`;
    slot.classList.add("loaded");
  }
  checkReady();
  if (state.analysis) renderPlaybackTime(state.currentTime);
  setStatus("已复用图片 A 作为张嘴图片", true);
}

function beginAudioLoad(file, loadingText, mediaKind = "audio") {
  const controller = new AbortController();
  const load = {
    audioLoadId: ++state.audioLoadId,
    assetRevision: state.assetRevision,
    controller,
    signal: controller.signal,
  };
  state.mediaController = controller;
  state.mediaKind = mediaKind;
  state.mediaProcessing = true;
  state.pendingMediaFile = null;
  resetPlayback();
  state.audioBuf = null;
  state.mono = null;
  state.analysis = null;
  state.audioName = file.name;
  state.demo = false;
  state.exportRangeInitialized = false;
  $("audio-name").textContent = `${file.name}（${loadingText}…）`;
  $("slot-audio").classList.remove("loaded");
  setMediaStatus(`正在${loadingText}…`, null, "busy");
  checkReady();
  return load;
}

function isCurrentAudioLoad(load) {
  return load.audioLoadId === state.audioLoadId && load.assetRevision === state.assetRevision;
}

function commitAudioBuffer(file, audioBuf, load, sourceLabel) {
  if (!isCurrentAudioLoad(load)) return false;
  state.mediaProcessing = false;
  state.audioBuf = audioBuf;
  state.mono = audioBufferToMono(audioBuf);
  state.sr = audioBuf.sampleRate;
  state.audioName = file.name;
  $("audio-name").textContent = `${file.name}（${sourceLabel} · ${audioBuf.duration.toFixed(1)}s / ${audioBuf.sampleRate}Hz）`;
  $("slot-audio").classList.add("loaded");
  setMediaStatus(`已载入${sourceLabel}：${file.name}`, 1, "ok");
  analyze();
  return true;
}

function readFileAsArrayBuffer(file, onProgress, signal = null) {
  throwIfMediaStopped(signal);
  if (typeof FileReader === "undefined") {
    return waitForMediaPromise(file.arrayBuffer(), signal, 0, "");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      try { reader.abort(); } catch (_) { /* 已完成或尚未开始读取 */ }
      finish(reject, mediaStoppedError());
    };
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    reader.onload = () => finish(resolve, reader.result);
    reader.onerror = () => finish(reject, reader.error || new Error("文件读取失败"));
    reader.onabort = () => finish(reject, signal?.aborted ? mediaStoppedError() : new Error("文件读取已取消"));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      reader.readAsArrayBuffer(file);
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function loadAudio(file) {
  const load = beginAudioLoad(file, "读取音频", "audio");
  let ac = null;
  try {
    const buf = await readFileAsArrayBuffer(file, (ratio) => {
      if (!isCurrentAudioLoad(load)) return;
      setMediaStatus(`正在读取音频… ${file.name}`, Math.min(.45, Math.max(.03, ratio * .45)), "busy");
    }, load.signal);
    if (!isCurrentAudioLoad(load)) return;
    throwIfMediaStopped(load.signal);
    setMediaStatus("文件读取完成，正在解码音频…", null, "busy");
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("当前浏览器不支持音频解码");
    ac = new AudioContextCtor();
    const audioBuf = await ac.decodeAudioData(buf);
    throwIfMediaStopped(load.signal);
    commitAudioBuffer(file, audioBuf, load, "音频");
  } catch (e) {
    if (!isCurrentAudioLoad(load)) return;
    state.mediaProcessing = false;
    if (isMediaStopped(e)) {
      state.audioName = "";
      $("audio-name").textContent = "拖入或点击选择音频文件";
      $("slot-audio").classList.remove("loaded");
      setMediaStatus("已取消音频读取", null, "pending");
      setStatus("已取消音频读取", false);
      checkReady();
      return;
    }
    $("audio-name").textContent = "音频解码失败，请换一个文件";
    $("slot-audio").classList.remove("loaded");
    setMediaStatus(`音频加载失败：${errorMessage(e)}`, null, "error");
    setStatus(`音频加载失败：${errorMessage(e)}`, false);
    checkReady();
  } finally {
    await ac?.close?.();
    if (isCurrentAudioLoad(load)) {
      state.mediaProcessing = false;
      if (state.mediaController === load.controller) state.mediaController = null;
      checkReady();
    }
  }
}

function mediaStoppedError() {
  const error = new Error("媒体处理已取消");
  error.name = "AbortError";
  return error;
}

function isMediaStopped(error) {
  return error?.name === "AbortError";
}

function throwIfMediaStopped(signal) {
  if (signal?.aborted) throw mediaStoppedError();
}

function waitForMediaPromise(promise, signal, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, mediaStoppedError());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (timeoutMs > 0) {
      timer = window.setTimeout(() => finish(reject, new Error(timeoutMessage)), timeoutMs);
    }
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function waitForVideoMetadata(video, signal, timeoutMs = 30000, onLoadedMetadata = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onLoaded = () => {
      if (settled) return;
      try {
        onLoadedMetadata?.(video);
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("视频无法解码，请换用 H.264/AAC 编码的 MOV 或 MP4"));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(mediaStoppedError());
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("读取视频信息超时，请确认文件可正常播放或换用 H.264/AAC 编码"));
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    if (video.readyState >= 1) onLoaded();
  });
}

function tryCreateVideoAudioGraph(video) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor || typeof MediaStream !== "function") return null;
  let audioContext = null;
  try {
    audioContext = new AudioContextCtor();
    const source = audioContext.createMediaElementSource(video);
    const destination = audioContext.createMediaStreamDestination();
    // 不连接到 audioContext.destination，提取时不会把视频声音外放到手机扬声器。
    source.connect(destination);
    // 在用户点击“开始提取音轨”的同步调用中提前 resume，避免 iOS 后续异步阶段被拦截。
    const resumePromise = audioContext.resume();
    resumePromise.catch(() => {});
    return { stream: destination.stream, audioContext, captureStream: null, resumePromise };
  } catch (_) {
    audioContext?.close?.().catch?.(() => {});
    return null;
  }
}

function createVideoAudioStream(video) {
  const audioGraph = tryCreateVideoAudioGraph(video);
  if (audioGraph) return audioGraph;

  const captureFactory = video.captureStream || video.mozCaptureStream;
  if (typeof captureFactory !== "function" || typeof MediaStream !== "function") {
    throw new Error("当前浏览器不支持视频音轨提取，请先从视频中导出音频文件");
  }
  const captureStream = captureFactory.call(video);
  const audioTracks = captureStream.getAudioTracks();
  if (!audioTracks.length) {
    captureStream.getTracks().forEach((track) => track.stop());
    throw new Error("这个视频没有可用音轨");
  }
  return { stream: new MediaStream(audioTracks), audioContext: null, captureStream };
}

function createAudioRecorder(stream) {
  const mimeCandidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  const mime = typeof MediaRecorder.isTypeSupported === "function"
    ? mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type)) || ""
    : "";
  return new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
}

async function loadVideoAudio(file, userGesture = false) {
  const load = beginAudioLoad(file, "准备视频音轨", "video");
  const signal = load.signal;
  let video = null;
  let videoUrl = null;
  let stream = null;
  let captureStream = null;
  let audioContext = null;
  let decodeContext = null;
  let recorder = null;
  let recorderDone = null;
  let recorderStarted = false;
  let staleTimer = 0;
  let progressTimer = 0;
  let updateVideoProgress = null;
  let earlyAudioCapture = null;
  let stopWaiting = () => {};
  const stopVideoProgress = () => {
    if (progressTimer) {
      window.clearInterval(progressTimer);
      progressTimer = 0;
    }
    if (video && updateVideoProgress) {
      video.removeEventListener("timeupdate", updateVideoProgress);
      updateVideoProgress = null;
    }
  };
  try {
    if (typeof MediaRecorder !== "function") {
      throw new Error("当前浏览器不支持视频音轨提取，请先从视频中导出音频文件");
    }
    video = document.createElement("video");
    // 移动端先只读取 metadata；通过时长校验后才允许进入完整音轨提取。
    video.preload = isMobileLikeBrowser() ? "metadata" : "auto";
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    // iOS 只可靠接受用户点击回调内的首次播放；非用户手势路径仍先静音启动。
    video.muted = !userGesture;
    video.volume = 0;
    if (video.muted) video.setAttribute("muted", "");
    video.setAttribute("aria-hidden", "true");
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);
    videoUrl = URL.createObjectURL(file);
    video.src = videoUrl;
    video.load();
    setMediaStatus("正在读取视频信息…", null, "busy");
    // 播放调用和 AudioContext 初始化都必须发生在首次 await 之前。
    try {
      const metadataReady = waitForVideoMetadata(video, signal, 30000, (loadedVideo) => {
        const limitMessage = getMobileVideoDurationLimitMessage(loadedVideo.duration);
        if (!limitMessage) return;
        // loadedmetadata 已经拿到准确时长；在创建 recorder 前立刻停止播放，
        // 避免超长视频进入完整音轨录制和后续音频解码。
        try { loadedVideo.pause(); } catch (_) { /* 清理阶段会再次暂停 */ }
        const error = new Error(limitMessage);
        error.name = "VideoLimitError";
        throw error;
      });
      let initialPlay;
      let playbackError = null;
      try {
        initialPlay = video.play();
      } catch (error) {
        // 极少数旧浏览器会同步抛出播放错误；仍先完成 metadata 限制判断。
        playbackError = error;
      }
      earlyAudioCapture = tryCreateVideoAudioGraph(video);
      // 先等待 metadata，确保移动端超长视频不会被 autoplay 错误遮蔽；
      // 播放失败先收集，metadata 通过后再按原逻辑提示重试。
      const playbackReady = playbackError
        ? Promise.resolve()
        : waitForMediaPromise(initialPlay, signal, 30000, "视频播放启动超时，请再次点击“开始提取音轨”")
          .catch((error) => { playbackError = error; });
      await metadataReady;
      await playbackReady;
      if (playbackError) throw playbackError;
    } catch (error) {
      if (signal.aborted) throw mediaStoppedError();
      if (error?.name === "VideoLimitError" || error?.message?.includes("超时") || error?.message?.includes("无法解码")) throw error;
      throw videoPlaybackError(userGesture);
    }
    if (!isCurrentAudioLoad(load)) return;
    throwIfMediaStopped(signal);
    const duration = Number(video.duration);
    if (!(duration > 0 && Number.isFinite(duration))) {
      throw new Error("无法读取视频时长");
    }

    const audioCapture = earlyAudioCapture || createVideoAudioStream(video);
    stream = audioCapture.stream;
    audioContext = audioCapture.audioContext;
    captureStream = audioCapture.captureStream;
    if (!stream.getAudioTracks().length) throw new Error("这个视频没有可用音轨");
    if (audioCapture.resumePromise) {
      await waitForMediaPromise(audioCapture.resumePromise, signal, 10000, "音频处理初始化超时，请重试");
    }
    if (audioContext) {
      // 音频已接入 MediaStreamDestination，不会外放；恢复源音量以保证录到真实音轨。
      video.muted = false;
      video.removeAttribute("muted");
      video.volume = 1;
    } else if (userGesture) {
      // captureStream 不接入 Web Audio，保持静音外放，但不静音捕获轨道。
      video.muted = false;
      video.removeAttribute("muted");
      video.volume = 0;
    }
    recorder = createAudioRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorderDone = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = () => reject(recorder.error || new Error("视频音轨录制失败"));
    });

    const videoFinished = new Promise((resolve, reject) => {
      const onEnded = () => {
        stopWaiting();
        resolve("ended");
      };
      const onError = () => {
        stopWaiting();
        reject(new Error("视频播放失败，无法提取音轨"));
      };
      stopWaiting = () => {
        video.removeEventListener("ended", onEnded);
        video.removeEventListener("error", onError);
      };
      video.addEventListener("ended", onEnded);
      video.addEventListener("error", onError);
    });
    const stale = new Promise((resolve) => {
      staleTimer = window.setInterval(() => {
        if (!isCurrentAudioLoad(load)) {
          window.clearInterval(staleTimer);
          staleTimer = 0;
          resolve("stale");
        }
      }, 150);
    });
    updateVideoProgress = () => {
      if (!isCurrentAudioLoad(load)) return;
      const ratio = Math.min(1, Math.max(0, video.currentTime / duration));
      setMediaStatus(`正在提取视频音轨… ${fmtTime(video.currentTime)} / ${fmtTime(duration)}`, ratio * .9, "busy");
    };
    video.addEventListener("timeupdate", updateVideoProgress);
    progressTimer = window.setInterval(updateVideoProgress, 150);

    setMediaStatus("正在提取视频音轨… 00:00.0 / " + fmtTime(duration), 0, "busy");
    recorder.start(100);
    recorderStarted = true;
    video.currentTime = 0;
    if (video.paused) throw new Error("视频播放在准备阶段被系统暂停，请再次点击“开始提取音轨”");
    const extractionTimeoutMs = Math.max(30000, (duration + 30) * 1000);
    const outcome = await waitForMediaPromise(Promise.race([
      videoFinished,
      stale,
      recorderDone.then(() => "recorder-stopped"),
    ]), signal, extractionTimeoutMs, "视频音轨提取超时，请确认视频可持续正常播放");
    if (outcome === "stale") return;
    if (outcome === "recorder-stopped" && video.currentTime < duration - 0.2) {
      throw new Error("视频音轨录制提前结束");
    }
    if (recorder.state !== "inactive") recorder.stop();
    await waitForMediaPromise(recorderDone, signal, 5000, "音轨录制结束超时");
    if (!isCurrentAudioLoad(load)) return;
    throwIfMediaStopped(signal);
    const extractedBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    if (!extractedBlob.size) throw new Error("没有提取到音轨数据");
    stopVideoProgress();
    setMediaStatus("视频播放完成，正在解析提取出的音轨…", null, "busy");
    const DecodeAudioContext = window.AudioContext || window.webkitAudioContext;
    if (!DecodeAudioContext) throw new Error("当前浏览器不支持音频解码");
    decodeContext = new DecodeAudioContext();
    const audioBuf = await decodeContext.decodeAudioData(await extractedBlob.arrayBuffer());
    throwIfMediaStopped(signal);
    commitAudioBuffer(file, audioBuf, load, "视频音轨");
  } catch (e) {
    if (!isCurrentAudioLoad(load)) return;
    state.mediaProcessing = false;
    const message = errorMessage(e);
    if (isMediaStopped(e)) {
      state.pendingMediaFile = file;
      $("audio-name").textContent = file.name + "（已选择）";
      $("slot-audio").classList.remove("loaded");
      setMediaStatus("已取消视频音轨提取，可重新开始", null, "pending");
      setStatus("已取消视频音轨提取", false);
      checkReady();
      return;
    }
    const retryPlayback = userGesture && message.includes("再次点击“开始提取音轨”");
    if (e?.name === "VideoLimitError") {
      $("audio-name").textContent = "视频超出移动端限制，请先裁剪视频";
      $("slot-audio").classList.remove("loaded");
      setMediaStatus(message, null, "error");
      setStatus(message, false);
    } else if (retryPlayback) {
      state.pendingMediaFile = file;
      $("audio-name").textContent = `${file.name}（已选择）`;
      $("slot-audio").classList.remove("loaded");
      setMediaStatus("视频已选择，请再次点击“开始提取音轨”", null, "pending");
      setStatus("视频播放未启动，请再次点击“开始提取音轨”", false);
    } else {
      $("audio-name").textContent = "视频音轨提取失败，请换一个文件";
      $("slot-audio").classList.remove("loaded");
      setMediaStatus(`视频处理失败：${message}`, null, "error");
      setStatus(`视频音轨提取失败：${message}`, false);
    }
    checkReady();
  } finally {
    stopWaiting();
    if (staleTimer) window.clearInterval(staleTimer);
    stopVideoProgress();
    if (recorderStarted && recorder && recorder.state !== "inactive") recorder.stop();
    if (recorderStarted && recorderDone) {
      await waitForMediaPromise(recorderDone, null, 2000, "").catch(() => {});
    }
    video?.pause();
    if (video) {
      video.removeAttribute("src");
      video.load();
      video.remove();
    }
    stream?.getTracks().forEach((track) => track.stop());
    captureStream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close?.();
    await decodeContext?.close?.();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (isCurrentAudioLoad(load)) {
      state.mediaProcessing = false;
      if (state.mediaController === load.controller) state.mediaController = null;
      checkReady();
    }
  }
}

// ---------- 分析 ----------
function analyze() {
  const p = params();
  if (!state.mono) return;
  state.demo = false;
  const rms = frameRMS(state.mono, state.sr, p.fps);
  const speaking = thresholdStates(rms, p.threshold,
    Math.max(1, Math.round(p.attackMs * p.fps / 1000)),
    Math.max(1, Math.round(p.releaseMs * p.fps / 1000)));
  const mouth = p.alternateMouth
    ? alternateMouthStates(speaking, p.fps, p.alternateFreq)
    : speaking.slice();
  const rng = mulberry32(p.seed);
  const blink = scheduleBlinks(mouth.length, p.fps, p.blinkMin, p.blinkMax, p.blinkDur, rng);
  const bounce = p.fxBounce ? talkBounce(speaking, p.fps, p.bounceAmp, p.bounceFreq) : null;
  const wiggle = p.fxWiggle ? talkWiggle(speaking, p.fps, p.wiggleAmp) : null;
  state.analysis = { rms, speaking, mouth, blink, bounce, wiggle, nframes: mouth.length, duration: state.mono.length / state.sr };
  $("t-total").textContent = fmtTime(state.analysis.duration);
  if (!state.exportRangeInitialized) {
    $("export-start").value = "0";
    $("export-end").value = formatDurationInput(state.analysis.duration);
    state.exportRangeInitialized = true;
  }
  setStatus("基于音频生成", true);
  checkReady();
  setPlaybackTime(state.currentTime, false);
}

function checkReady() {
  const hasImgs = Boolean(state.imgs.a && state.imgs.b);
  // 无音频时自动生成演示动画，让用户不开口也能直接导出预览视频/GIF。
  const hasAudioActivity = Boolean(state.audioName || state.audioBuf || state.mono || state.pendingMediaFile);
  if (hasImgs && !hasAudioActivity && !state.analysis) ensureDemoAnalysis();
  const ready = Boolean(hasImgs && state.analysis);   // 可导出（正式分析或演示动画）
  const playable = hasImgs && Boolean(state.analysis || !state.mono); // 可播放（无音频走演示）
  const mediaPending = Boolean(state.pendingMediaFile);
  const busy = state.exporting || state.mediaProcessing || mediaPending;
  const rangeReady = Boolean(updateExportRangeUi());
  $("btn-play").disabled = !playable || busy;
  $("btn-seek-play").disabled = !playable || busy;
  // 播放时也允许导出；exportVideo() 会先保存预览位置并暂停播放。
  $("btn-export").disabled = !ready || busy || !rangeReady;
  const hasMaterials = Object.values(state.imgs).some(Boolean) || Boolean(state.audioBuf || state.audioName || state.analysis);
  // 媒体读取卡住时仍必须能重置；重置会先中止当前处理再清空素材。
  $("btn-reanalyze").disabled = !hasMaterials || state.exporting;
  $("btn-export-toggle").disabled = !hasMaterials || busy;
  $("seek").disabled = !state.analysis || busy;
  const fileSelectionDisabled = state.exporting || state.mediaProcessing || mediaPending;
  $("canvas").setAttribute("aria-disabled", String(fileSelectionDisabled));
  $(".audio-row")?.setAttribute("aria-disabled", String(fileSelectionDisabled));
  for (const slot of document.querySelectorAll(".slots-grid .slot-thumb")) {
    slot.setAttribute("aria-disabled", String(fileSelectionDisabled));
  }
  updateCanvasHints(hasImgs);
  if (hasImgs && !state.analysis) drawFrame(0);   // 只装了立绘时也先展示 A 面
  updateBusyUi();
  updatePlaybackUi();
  updateAlternateUi();
  updateClearButtonsUi();
  updateMediaStartButton();
}

/** 素材卡片内的「清空」按钮：图片 / 音频各自独立显示与清空 */
function updateClearButtonsUi() {
  const hasImages = Object.values(state.imgs).some(Boolean);
  const hasAudioActivity = Boolean(
    state.audioName || state.audioBuf || state.mono || state.pendingMediaFile || state.mediaProcessing
  );
  const imagesButton = $("btn-clear-images");
  const audioButton = $("btn-clear-audio");
  imagesButton.hidden = !hasImages;
  imagesButton.disabled = state.exporting;
  audioButton.hidden = !hasAudioActivity;
  audioButton.disabled = state.exporting;
}

/** 只清空图片：有音频时保留口型分析，重选图片后直接复用 */
function clearImages() {
  if (state.exporting) return;
  state.assetRevision++;   // 使仍在加载中的图片失效
  const revoked = new Set();
  for (const slot of Object.keys(state.imgs)) {
    const img = state.imgs[slot];
    if (img?.src?.startsWith("blob:") && !revoked.has(img.src)) {
      URL.revokeObjectURL(img.src);
      revoked.add(img.src);
    }
    state.imgs[slot] = null;
    const el = $(`slot-${slot}`);
    el.style.backgroundImage = "";
    el.classList.remove("loaded");
    el.classList.remove("loading");
    el.removeAttribute("aria-busy");
  }
  const fileInput = $("file-input");
  fileInput.value = "";
  fileInput.dataset.target = "";
  canvas.width = 640;
  canvas.height = 480;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.audioBuf && !state.audioName && !state.mono) {
    state.analysis = null;   // 演示分析随图片一起清掉，重选后自动重建
    state.demo = false;
    resetPlayback();
  }
  checkReady();
  setStatus("已清空图片，可重新选择", true);
}

/** 只清空音频：进行中的读取/提取一并取消，图片与图片相关的设置保留 */
function clearAudio() {
  if (state.exporting) return;
  state.mediaController?.abort();
  state.mediaController = null;
  state.mediaKind = null;
  state.mediaProcessing = false;
  state.pendingMediaFile = null;
  state.audioLoadId++;
  resetPlayback();
  state.audioBuf = null;
  state.audioName = "";
  state.mono = null;
  state.sr = 44100;
  state.analysis = null;
  state.demo = false;
  state.exportRangeInitialized = false;
  $("slot-audio").classList.remove("loaded");
  $("audio-name").textContent = "拖入或点击选择音频文件";
  clearMediaStatus();
  $("export-start").value = "0";
  $("export-end").value = "0";
  $("audio-file-input").value = "";
  checkReady();
  setStatus("已清空音频，可重新选择", true);
}

$("btn-clear-images").addEventListener("click", clearImages);
$("btn-clear-audio").addEventListener("click", clearAudio);

function updateCanvasHints(hasImgs) {
  const dropHint = $("drop-hint");
  const previewHint = $("preview-hint");
  const reuseButton = $("reuse-image-btn");
  const imageCount = Object.values(state.imgs).filter(Boolean).length;
  const hasAudio = Boolean(state.mono || state.audioBuf || state.audioName);
  const missingMouthImage = state.imgs.a && !state.imgs.b;
  const missingClosedImage = !state.imgs.a && state.imgs.b;

  dropHint.style.display = hasImgs ? "none" : "flex";
  if (missingMouthImage) {
    $("drop-hint-title").textContent = "请再选择一张「张嘴」图片";
    if (reuseButton) reuseButton.hidden = false;
    $("drop-hint-details").hidden = true;
    $("drop-hint-extra").hidden = true;
  } else if (missingClosedImage && imageCount === 1) {
    $("drop-hint-title").textContent = "请再选择一张「闭嘴」图片";
    if (reuseButton) reuseButton.hidden = true;
    $("drop-hint-details").hidden = true;
    $("drop-hint-extra").hidden = true;
  } else {
    $("drop-hint-title").textContent = "添加2张角色立绘，开始预览";
    if (reuseButton) reuseButton.hidden = true;
    $("drop-hint-details").hidden = false;
    $("drop-hint-extra").hidden = false;
  }
  previewHint.hidden = !(hasImgs && !hasAudio);
}

// ---------- 渲染 ----------
function currentImage(f) {
  const A = state.analysis;
  if (!A) return state.imgs.a;
  const talking = A.mouth[f] === 1;
  const blinking = A.blink[f] === 1;
  if (blinking) {
    if (talking && state.imgs.d) return state.imgs.d;
    if (!talking && state.imgs.c) return state.imgs.c;
  }
  return talking ? state.imgs.b : state.imgs.a;
}

/** 读取「自定义背景」开关与背景类型，返回绘制描述；关闭或图片未就绪时返回 null（透明） */
function backgroundStyle() {
  if (!$("bg-enabled").checked) return null;
  const type = document.querySelector('input[name="bg-type"]:checked')?.value || "green";
  if (type === "white") return { color: "#ffffff" };
  if (type === "green") return { color: "#00b140" };
  if (type === "color") return { color: $("bg-color").value || "#ce6a5a" };
  if (type === "image") return state.bgImage ? { image: state.bgImage } : null;
  return null;
}

/** 绘制背景：纯色填充或图片按 cover 方式铺满画布 */
function paintBackground(bg, w, h) {
  if (bg?.color) {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, w, h);
  } else if (bg?.image && bg.image.naturalWidth > 0) {
    const s = Math.max(w / bg.image.naturalWidth, h / bg.image.naturalHeight);
    const w2 = bg.image.naturalWidth * s, h2 = bg.image.naturalHeight * s;
    ctx.drawImage(bg.image, (w - w2) / 2, (h - h2) / 2, w2, h2);
  }
}

/** 用当前设置重绘预览帧（导出、载入等场景共用） */
function refreshPreviewFrame() {
  if (state.analysis) renderPlaybackTime(state.currentTime);
  else if (state.imgs.a && state.imgs.b) drawFrame(0);
}

function drawFrame(f) {
  const A = state.analysis;
  const img = currentImage(f) || state.imgs.a;
  if (!img) return;
  // 画布尺寸跟随图片与导出高度
  const targetH = +$("p-exp-h").value;
  const scale = targetH / img.naturalHeight;
  const w = Math.round(img.naturalWidth * scale), h = targetH;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  ctx.clearRect(0, 0, w, h);
  paintBackground(backgroundStyle(), w, h);

  let sx = 1, sy = 1, rot = 0;
  if (A) {
    if (A.bounce) { sx = A.bounce.sx[f] || 1; sy = A.bounce.sy[f] || 1; }
    if (A.wiggle) { rot = A.wiggle[f] || 0; }
  }
  ctx.save();
  ctx.translate(w / 2, h);
  ctx.rotate(rot * Math.PI / 180);
  ctx.scale(sx, sy);
  ctx.drawImage(img, -w / 2, -h, w, h);
  ctx.restore();
}

function fmtTime(s) {
  const m = Math.floor(s / 60), ss = (s % 60).toFixed(1).padStart(4, "0");
  return String(m).padStart(2, "0") + ":" + ss;
}

function formatSecondsInput(seconds) {
  // 最多保留两位小数，避免 198.44066666666666 这类超长浮点
  return String(Math.round(Number(seconds) * 100) / 100);
}

function formatDurationInput(seconds) {
  // 自动填充结束时间用向下取整，保证不会超出实际时长（四舍五入可能多出几毫秒被判范围无效）
  return String(Math.floor(Number(seconds) * 100) / 100);
}

function formatExportRange(range) {
  return fmtTime(range.start) + " ~ " + fmtTime(range.end);
}

function errorMessage(error) {
  return String(error?.message || error || "未知错误").replace(/\s+/g, " ").slice(0, 160);
}

function exportStoppedError() {
  const error = new Error("导出已停止");
  error.name = "AbortError";
  return error;
}

function throwIfExportStopped(signal) {
  if (signal?.aborted) throw exportStoppedError();
}

function isExportStopped(error) {
  return error?.name === "AbortError";
}

function setExportInputValidity(input, valid, message = "") {
  input.classList.toggle("invalid", !valid);
  input.setAttribute("aria-invalid", String(!valid));
  input.setCustomValidity(valid ? "" : message);
}

/** 按 码率×时长 估算导出文件大小（含 96kbps 音轨），展示在「视频码率」下方 */
function updateSizeEstimate(durationSec) {
  const el = $("export-size-est");
  if (!el) return;
  if ($("export-mode").value === "gif") {
    el.textContent = "GIF 大小取决于画面复杂度与帧数，与码率无关";
    return;
  }
  if (!Number.isFinite(durationSec)) {
    el.textContent = state.analysis ? "范围有效后显示预估大小" : "加载音频后显示预估大小";
    return;
  }
  const mbps = +$("p-vbitrate").value;
  const mb = (mbps * 1e6 + 96e3) * durationSec / 8 / 1048576;
  el.textContent = "预估 ≈ " + (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + " MB";
}

/** 把数值输入框里的范围同步到双滑块与高亮区间 */
function syncExportRangeSliders(range) {
  const sliderStart = $("export-range-slider-start");
  const sliderEnd = $("export-range-slider-end");
  const fill = $("export-range-fill");
  if (!sliderStart || !sliderEnd || !fill) return;
  const duration = state.analysis?.duration || 0;
  const max = duration > 0 ? formatSecondsInput(duration) : "1";
  for (const slider of [sliderStart, sliderEnd]) {
    slider.min = "0";
    slider.max = max;
    slider.step = "0.1";
  }
  const startValue = range ? range.start : Number(sliderStart.value) || 0;
  const endValue = range ? range.end : Number(sliderEnd.value) || duration;
  sliderStart.value = formatSecondsInput(startValue);
  sliderEnd.value = formatSecondsInput(Math.max(startValue, endValue));
  updateExportRangeFill(startValue, endValue, duration);
}

function updateExportRangeFill(startValue, endValue, duration) {
  const fill = $("export-range-fill");
  if (!fill) return;
  if (!(duration > 0)) {
    fill.style.left = "0%";
    fill.style.width = "0%";
    return;
  }
  const left = Math.min(100, Math.max(0, startValue / duration * 100));
  const right = Math.min(100, Math.max(0, endValue / duration * 100));
  fill.style.left = left + "%";
  fill.style.width = Math.max(0, right - left) + "%";
}

function updateExportRangeUi() {
  const start = $("export-start");
  const end = $("export-end");
  const full = $("export-full");
  const durationEl = $("export-duration");
  const duration = state.analysis?.duration || 0;
  const hasRange = Boolean(state.analysis && duration > 0);   // 正式分析或演示动画都算可导出
  start.disabled = !hasRange || state.exporting;
  end.disabled = !hasRange || state.exporting;
  full.disabled = !hasRange || state.exporting;
  for (const id of ["export-range-slider-start", "export-range-slider-end"]) {
    const slider = $(id);
    if (slider) slider.disabled = !hasRange || state.exporting;
  }
  if (!hasRange) {
    durationEl.textContent = "未加载音频";
    setExportInputValidity(start, true);
    setExportInputValidity(end, true);
    updateSizeEstimate(null);
    return null;
  }

  const max = formatSecondsInput(duration);
  start.min = "0";
  start.max = max;
  end.min = "0";
  end.max = max;
  const startValue = Number(start.value);
  const endValue = Number(end.value);
  const startValid = start.value.trim() !== "" && Number.isFinite(startValue) && startValue >= 0 && startValue < duration;
  // 结束时间允许最多 10ms 的舍入超出，resolveExportRange 会截断回实际时长
  const endValid = end.value.trim() !== "" && Number.isFinite(endValue) && endValue > 0 && endValue <= duration + 0.011;
  const orderValid = startValid && endValid && endValue > startValue;
  setExportInputValidity(start, startValid && (orderValid || !endValid), "开始时间必须在 0~" + max + " 秒内且小于结束时间");
  setExportInputValidity(end, endValid && (orderValid || !startValid), "结束时间必须在 0~" + max + " 秒内且大于开始时间");
  if (startValid && endValid && !orderValid) {
    setExportInputValidity(end, false, "结束时间必须大于开始时间");
  }
  if (!orderValid) {
    durationEl.textContent = "范围无效";
    updateSizeEstimate(null);
    return null;
  }

  try {
    const range = resolveExportRange(duration, startValue, endValue, params().fps, state.analysis.nframes);
    const gifLimited = $("export-mode").value === "gif" && range.duration > GIF_MAX_DURATION_SEC;
    durationEl.textContent = "时长 " + fmtTime(range.duration) + (gifLimited ? "（GIF 上限 " + GIF_MAX_DURATION_SEC + " 秒）" : "");
    syncExportRangeSliders(range);
    if (gifLimited) {
      updateSizeEstimate(null);
      return null;
    }
    updateSizeEstimate(range.duration);
    return range;
  } catch (_) {
    durationEl.textContent = "范围无效";
    updateSizeEstimate(null);
    return null;
  }
}

function setExportProgress(done, total) {
  const numerator = Number(done), denominator = Number(total);
  const value = Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? Math.min(1, Math.max(0, numerator / denominator))
    : 0;
  $("export-progress").value = value;
  $("export-progress-percent").textContent = Math.round(value * 100) + "%";
}

function updateBusyUi() {
  const progressWrap = $("export-progress-wrap");
  progressWrap.hidden = !state.exporting;
  progressWrap.setAttribute("aria-hidden", String(!state.exporting));
  const busy = state.exporting || state.mediaProcessing || Boolean(state.pendingMediaFile);
  const stopping = Boolean(state.exportController?.signal?.aborted);
  $("btn-stop-export").disabled = !state.exporting || stopping;
  $("btn-stop-export").textContent = stopping ? "正在停止…" : "停止导出";
  for (const id of [
    "export-mode", "export-fast", "bg-enabled", "bg-color", "bg-image-btn",
    "export-range-slider-start", "export-range-slider-end",
    "p-threshold", "n-threshold",
    "p-attack", "n-attack", "p-release", "n-release", "mouth-alternate",
    "p-alt-freq", "n-alt-freq", "p-bmin", "n-bmin", "p-bmax", "n-bmax",
    "p-bdur", "n-bdur", "p-seed", "n-seed", "fx-bounce", "p-bounce",
    "n-bounce", "p-bfreq", "n-bfreq", "fx-wiggle", "p-wiggle", "n-wiggle",
    "p-fps", "n-fps", "p-exp-h", "n-exp-h", "p-vbitrate", "n-vbitrate",
  ]) {
    const element = $(id);
    if (element) element.disabled = busy;
  }
  for (const radio of document.querySelectorAll('input[name="bg-type"]')) radio.disabled = busy;
  for (const button of document.querySelectorAll(".param-reset")) button.disabled = busy;
}

// ---------- 播放 ----------
$("btn-play").addEventListener("click", () => { void togglePlay(); });
$("btn-seek-play").addEventListener("click", () => { void togglePlay(); });

/** 无音频时的演示模式：预生成一段说话节奏数据，预览口型/眨眼/动效（不可导出） */
function ensureDemoAnalysis() {
  if (state.analysis || state.mono || !state.imgs.a || !state.imgs.b) return Boolean(state.analysis);
  const p = params();
  const fps = p.fps, duration = 6;
  const n = Math.max(1, Math.round(fps * duration));
  const rng = mulberry32(p.seed + 7);
  const speaking = new Array(n).fill(0);
  let f = 0;
  while (f < n) {
    const talk = Math.max(1, Math.round(fps * (0.4 + rng() * 0.9)));    // 说 0.4~1.3s
    const pause = Math.max(1, Math.round(fps * (0.15 + rng() * 0.45))); // 停 0.15~0.6s
    for (let i = 0; i < talk && f < n; i++, f++) speaking[f] = 1;
    for (let i = 0; i < pause && f < n; i++, f++) speaking[f] = 0;
  }
  const mouth = p.alternateMouth ? alternateMouthStates(speaking, fps, p.alternateFreq) : speaking.slice();
  const blink = scheduleBlinks(n, fps, p.blinkMin, p.blinkMax, p.blinkDur, mulberry32(p.seed));
  state.analysis = {
    rms: null, speaking, mouth, blink,
    bounce: p.fxBounce ? talkBounce(speaking, fps, p.bounceAmp, p.bounceFreq) : null,
    wiggle: p.fxWiggle ? talkWiggle(speaking, fps, p.wiggleAmp) : null,
    nframes: n, duration,
  };
  state.demo = true;
  $("t-total").textContent = fmtTime(duration);
  $("state-badge").textContent = "演示预览";
  if (!state.exportRangeInitialized) {
    $("export-start").value = "0";
    $("export-end").value = formatDurationInput(duration);
    state.exportRangeInitialized = true;
  }
  setStatus("演示预览：可直接导出视频/GIF，拖入音频生成正式口型", true);
  checkReady();
  setPlaybackTime(state.currentTime, false);
  return true;
}

/** 演示模式下调整参数：暂停后用新参数重建演示数据 */
function rebuildDemo() {
  if (!state.demo) return;
  if (state.playing) pausePlayback();
  state.analysis = null;
  state.demo = false;
  ensureDemoAnalysis();
}

function getAudioUrl() {
  if (!state.audioUrl) state.audioUrl = monoToWavUrl(state.mono, state.sr);
  return state.audioUrl;
}

function ensureAudioElement() {
  if (!state.audioEl) {
    state.audioEl = new Audio(getAudioUrl());
    state.audioEl.preload = "auto";
    state.audioEl.addEventListener("ended", finishPlayback);
  } else if (state.audioEl.src !== getAudioUrl()) {
    state.audioEl.src = getAudioUrl();
  }
  return state.audioEl;
}

async function togglePlay() {
  if (state.exporting) return;
  if (!state.analysis && !ensureDemoAnalysis()) return;
  const A = state.analysis;
  if (state.playing) {
    pausePlayback();
    return;
  }
  if (state.currentTime >= A.duration - 0.02) setPlaybackTime(0, true);

  if (state.demo) {
    // 无音频，用性能时钟驱动
    state.demoClockStart = performance.now() / 1000 - state.currentTime;
    state.playing = true;
    updatePlaybackUi();
    setStatus("预览中", true);
    state.rafId = requestAnimationFrame(playbackTick);
    return;
  }

  const audio = ensureAudioElement();
  try {
    audio.currentTime = state.currentTime;
    state.playing = true;
    updatePlaybackUi();
    await audio.play();
  } catch (e) {
    state.playing = false;
    updatePlaybackUi();
    setStatus(`播放失败：${e.message?.slice(0, 100) || "浏览器拒绝播放"}`, false);
    return;
  }
  state.rafId = requestAnimationFrame(playbackTick);
  setStatus("预览中", true);
}

function playbackTick() {
  if (!state.playing || !state.analysis) return;
  const raw = state.demo
    ? performance.now() / 1000 - state.demoClockStart
    : (state.audioEl ? state.audioEl.currentTime : state.currentTime);
  const t = Math.min(state.analysis.duration, Math.max(0, raw));
  if (t >= state.analysis.duration - 0.02) {
    finishPlayback();
    return;
  }
  setPlaybackTime(t, false);
  state.rafId = requestAnimationFrame(playbackTick);
}

function pausePlayback() {
  if (state.audioEl) state.currentTime = getAudioTime();
  state.playing = false;
  cancelAnimationFrame(state.rafId);
  if (state.audioEl) state.audioEl.pause();
  updatePlaybackUi();
  setStatus(state.demo ? "演示预览" : state.analysis ? "基于音频生成" : "待输入", true);
}

function finishPlayback() {
  cancelAnimationFrame(state.rafId);
  if (state.audioEl) state.audioEl.pause();
  state.playing = false;
  state.currentTime = state.analysis?.duration || 0;
  renderPlaybackTime(state.currentTime);
  updatePlaybackUi();
  setStatus(state.demo ? "演示预览" : state.analysis ? "基于音频生成" : "待输入", true);
}

function resetPlayback() {
  cancelAnimationFrame(state.rafId);
  if (state.audioEl) {
    state.audioEl.pause();
    state.audioEl.removeAttribute("src");
    state.audioEl.load();
  }
  state.playing = false;
  state.audioEl = null;
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = null;
  state.currentTime = 0;
  updatePlaybackUi();
}

function clearMaterials() {
  if (state.exporting) return;
  state.mediaController?.abort();
  state.mediaController = null;
  state.mediaKind = null;
  state.assetRevision++;
  state.audioLoadId++;
  state.mediaProcessing = false;
  state.pendingMediaFile = null;
  resetPlayback();

  const revokedImageUrls = new Set();
  for (const slot of Object.keys(state.imgs)) {
    const img = state.imgs[slot];
    if (img?.src?.startsWith("blob:") && !revokedImageUrls.has(img.src)) {
      URL.revokeObjectURL(img.src);
      revokedImageUrls.add(img.src);
    }
    state.imgs[slot] = null;
    const el = $(`slot-${slot}`);
    el.style.backgroundImage = "";
    el.classList.remove("loaded");
  }

  state.audioBuf = null;
  state.audioName = "";
  state.mono = null;
  state.sr = 44100;
  state.analysis = null;
  state.demo = false;
  state.exportRangeInitialized = false;
  $("slot-audio").classList.remove("loaded");
  $("audio-name").textContent = "拖入或点击选择音频文件";
  clearMediaStatus();
  $("export-start").value = "0";
  $("export-end").value = "0";
  const fileInput = $("file-input");
  fileInput.value = "";
  fileInput.dataset.target = "";
  const audioFileInput = $("audio-file-input");
  audioFileInput.value = "";
  audioFileInput.dataset.target = "";
  canvas.width = 640;
  canvas.height = 480;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  checkReady();
  setStatus("已重置当前素材", true);
}

function getAudioTime() {
  const duration = state.analysis?.duration || 0;
  const t = state.audioEl?.currentTime;
  return Number.isFinite(t) ? Math.min(duration, Math.max(0, t)) : state.currentTime;
}

function renderPlaybackTime(time) {
  if (!state.analysis) return;
  const duration = state.analysis.duration;
  const t = Math.min(duration, Math.max(0, Number(time) || 0));
  const f = Math.min(state.analysis.nframes - 1, Math.floor(t * params().fps));
  state.currentTime = t;
  drawFrame(f);
  $("t-cur").textContent = fmtTime(t);
  $("seek").value = duration ? String(Math.round(1000 * t / duration)) : "0";
}

function setPlaybackTime(time, syncAudio = true) {
  if (!state.analysis) return;
  const t = Math.min(state.analysis.duration, Math.max(0, Number(time) || 0));
  if (state.demo) {
    if (syncAudio) state.demoClockStart = performance.now() / 1000 - t;
  } else if (syncAudio && state.audioEl) {
    try { state.audioEl.currentTime = t; } catch (_) { /* 音频元数据尚未就绪，下一帧会同步 */ }
  }
  renderPlaybackTime(t);
}

function updatePlaybackUi() {
  const label = state.playing ? "暂停" : "播放";
  const barLabel = state.playing ? "⏸" : "▶";
  $("btn-play").textContent = label;
  $("btn-seek-play").textContent = barLabel;
  $("btn-seek-play").classList.toggle("is-playing", state.playing);
  $("btn-seek-play").setAttribute("aria-label", state.playing ? "暂停" : "播放");
  $("btn-seek-play").title = state.playing ? "暂停" : "播放";
  $("btn-seek-play").setAttribute("aria-pressed", String(state.playing));
  $("state-badge").textContent = state.playing
    ? "预览中"
    : state.analysis && !state.demo
      ? "基于音频生成"
      : state.demo
        ? "演示预览"
        : "待输入";
}

function monoToWavUrl(mono, sr) {
  const n = mono.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

// seek
$("seek").addEventListener("input", (e) => {
  if (!state.analysis) return;
  const t = Number(e.target.value) / 1000 * state.analysis.duration;
  setPlaybackTime(t, true);
});

// 空格键播放/暂停（焦点在表单控件或按钮上时不劫持，避免和输入、按钮默认行为冲突）
window.addEventListener("keydown", (e) => {
  if (e.key !== " " && e.code !== "Space") return;
  if (e.repeat) return;
  const t = e.target;
  const tag = t?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON" || t?.isContentEditable) return;
  if ($("btn-play").disabled) return;
  e.preventDefault();
  void togglePlay();
});

// ---------- 导出 ----------
$("btn-export").addEventListener("click", () => { void exportVideo(); });
$("btn-stop-export").addEventListener("click", stopExport);

function stopExport() {
  if (!state.exporting || !state.exportController) return;
  state.exportController.abort();
  updateBusyUi();
  setStatus("正在停止导出…");
}

async function exportVideo() {
  const A = state.analysis;
  if (!A || state.exporting) return;
  let exportRange;
  try {
    exportRange = resolveExportRange(
      A.duration,
      $("export-start").value,
      $("export-end").value,
      params().fps,
      A.nframes,
    );
  } catch (e) {
    updateExportRangeUi();
    setStatus("导出范围无效：" + errorMessage(e), false);
    return;
  }
  const format = $("export-mode").value;   // webm | mp4 | gif
  if (format === "gif" && exportRange.duration > GIF_MAX_DURATION_SEC) {
    setStatus("GIF 仅支持导出 " + GIF_MAX_DURATION_SEC + " 秒以内的内容，请调整导出范围", false);
    return;
  }
  // 导出和实时播放都会绘制 canvas，先暂停播放避免两套渲染互相覆盖。
  if (state.playing) pausePlayback();
  const previewTime = state.currentTime;
  const controller = new AbortController();
  const signal = controller.signal;
  state.exportController = controller;
  state.exporting = true;
  setExportProgress(0, 1);
  checkReady();
  const useFast = $("export-fast").checked && typeof OffscreenCanvas !== "undefined" && typeof VideoEncoder !== "undefined";

  try {
    if (format === "gif") {
      await exportVideoGif(exportRange, signal);
    } else if (useFast) {
      try {
        await exportVideoFast(format, exportRange, signal);
      } catch (e) {
        if (isExportStopped(e) || signal.aborted) throw e;
        setStatus("快速导出不可用：" + errorMessage(e) + "，正在切换实时录制…", false);
        setExportProgress(0, 1);
        setStatus("实时导出准备中…", false);
        await exportVideoRealtime(format, exportRange, signal);
      }
    } else {
      await exportVideoRealtime(format, exportRange, signal);
    }
  } catch (e) {
    setStatus(isExportStopped(e) || signal.aborted ? "已停止导出" : "导出失败：" + errorMessage(e), false);
  } finally {
    state.exporting = false;
    if (state.exportController === controller) state.exportController = null;
    checkReady();
    setPlaybackTime(previewTime, false);
  }
}

/** 导出格式 + 背景设置的中文标签（用于状态栏） */
function formatLabel(format, bg) {
  if (format === "gif") return "GIF";
  const container = format === "mp4" ? "MP4" : "WebM";
  return bg ? container + "（含背景）" : container + (format === "mp4" ? "（透明区域为黑色）" : " 透明");
}

/** 快速导出：WebCodecs 离屏逐帧编码，速度=编码速度（≈5-20× 实时） */
async function exportVideoFast(format, exportRange, signal) {
  const A = state.analysis;
  const p = params();
  const targetH = +$("p-exp-h").value;
  const imgA = state.imgs.a;
  const scale = targetH / imgA.naturalHeight;
  const W = Math.round(imgA.naturalWidth * scale), H = targetH;
  const frameCount = exportRange.endFrame - exportRange.startFrame;
  const bg = backgroundStyle();
  throwIfExportStopped(signal);
  setStatus("快速导出中（" + formatLabel(format, bg) + "，" + formatExportRange(exportRange) + "，" + frameCount + " 帧离屏编码）…");
  setExportProgress(0, 1);
  const t0 = performance.now();
  try {
    const blob = await exportFast({
      imgs: state.imgs, analysis: A, fps: p.fps, width: W, height: H,
      audioBuffer: state.audioBuf,
      audioStart: exportRange.start, audioEnd: exportRange.end,
      frameStart: exportRange.startFrame, frameEnd: exportRange.endFrame,
      videoBitrate: Math.round(p.videoBitrateMbps * 1e6),
      format,
      bg,
      signal,
      onProgress: (f, n) => {
        setExportProgress(f, n);
        setStatus("快速导出中 " + f + "/" + n + " 帧…");
      },
    });
    throwIfExportStopped(signal);
    downloadBlob(blob, format);
    const secs = Math.max(0.001, (performance.now() - t0) / 1000);
    setExportProgress(1, 1);
    setStatus("导出完成：" + (blob.size / 1048576).toFixed(1) + " MB，" + formatExportRange(exportRange) + "，" + secs.toFixed(1) + "s（" + (exportRange.duration / secs).toFixed(1) + "× 实时）", true);
  } catch (e) {
    if (isExportStopped(e)) throw e;
    throw new Error(`快速导出失败（${e.message?.slice(0, 80) || "未知错误"}）`);
  }
}

/** GIF 导出：逐帧量化编码（纯 JS，无需 WebCodecs，也无需实时录制兜底） */
async function exportVideoGif(exportRange, signal) {
  const A = state.analysis;
  const p = params();
  const targetH = +$("p-exp-h").value;
  const imgA = state.imgs.a;
  const scale = targetH / imgA.naturalHeight;
  const W = Math.round(imgA.naturalWidth * scale), H = targetH;
  const frameCount = exportRange.endFrame - exportRange.startFrame;
  // GIF 只有 1 位透明，抗锯齿边缘会出毛边；未开启背景时统一用白底。
  const bg = backgroundStyle() || { color: "#ffffff" };
  throwIfExportStopped(signal);
  setStatus("GIF 导出中（" + formatExportRange(exportRange) + "，" + frameCount + " 帧逐帧量化）…");
  setExportProgress(0, 1);
  const t0 = performance.now();
  try {
    const blob = await exportGif({
      imgs: state.imgs, analysis: A, fps: p.fps, width: W, height: H,
      frameStart: exportRange.startFrame, frameEnd: exportRange.endFrame,
      bg,
      signal,
      onProgress: (f, n) => {
        setExportProgress(f, n);
        setStatus("GIF 导出中 " + f + "/" + n + " 帧…");
      },
    });
    throwIfExportStopped(signal);
    downloadBlob(blob, "gif");
    const secs = Math.max(0.001, (performance.now() - t0) / 1000);
    setExportProgress(1, 1);
    setStatus("GIF 导出完成：" + (blob.size / 1048576).toFixed(1) + " MB，" + formatExportRange(exportRange) + "，" + secs.toFixed(1) + "s", true);
  } catch (e) {
    if (isExportStopped(e)) throw e;
    throw new Error(`GIF 导出失败（${e.message?.slice(0, 80) || "未知错误"}）`);
  }
}

/** 实时导出：MediaRecorder 录 canvas 流（兼容兜底） */
async function exportVideoRealtime(format, exportRange, signal) {
  const A = state.analysis;
  let stream = null;
  let audioContext = null;
  let audioSource = null;
  let rec = null;
  let rafId = 0;
  let resolveCancelled = null;
  const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
  const stopOnAbort = () => {
    resolveCancelled?.();
    if (rec && rec.state !== "inactive") rec.stop();
  };
  try {
    throwIfExportStopped(signal);
    const bg = backgroundStyle();
    setStatus("导出中（" + formatLabel(format, bg) + "，" + formatExportRange(exportRange) + "，实时录制）…");

    if (!canvas.captureStream || typeof MediaRecorder === "undefined") {
      throw new Error("当前浏览器不支持实时录制，请使用最新版 Chrome 或 Edge");
    }
    signal?.addEventListener("abort", stopOnAbort, { once: true });
    const p = params();
    drawFrame(exportRange.startFrame);
    stream = canvas.captureStream(p.fps);
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (state.audioBuf && AudioContextCtor) {
      audioContext = new AudioContextCtor();
      const destination = audioContext.createMediaStreamDestination();
      audioSource = audioContext.createBufferSource();
      audioSource.buffer = state.audioBuf;
      audioSource.connect(destination);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    }
    const mimeCandidates = format === "mp4"
      ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mime = mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || "";
    const chunks = [];
    const videoBitsPerSecond = Math.round(params().videoBitrateMbps * 1e6) || 8_000_000;
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond } : { videoBitsPerSecond });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const done = new Promise((resolve, reject) => {
      rec.onstop = resolve;
      rec.onerror = () => reject(rec.error || new Error("MediaRecorder 发生错误"));
    });
    throwIfExportStopped(signal);
    rec.start(100);
    let clockStart;
    if (audioSource) {
      await audioContext.resume();
      throwIfExportStopped(signal);
      clockStart = audioContext.currentTime;
      const clipDuration = Math.min(exportRange.duration, Math.max(0, state.audioBuf.duration - exportRange.start));
      if (clipDuration > 0) audioSource.start(clockStart, exportRange.start, clipDuration);
    } else {
      clockStart = performance.now() / 1000;
    }
    const renderLoop = new Promise((resolve) => {
      const tick = () => {
        if (signal?.aborted) { resolve(); return; }
        const elapsed = audioContext
          ? audioContext.currentTime - clockStart
          : performance.now() / 1000 - clockStart;
        const t = Math.min(exportRange.duration, Math.max(0, elapsed));
        const f = Math.min(exportRange.endFrame - 1, exportRange.startFrame + Math.floor(t * p.fps));
        drawFrame(f);
        setExportProgress(t, exportRange.duration);
        if (t >= exportRange.duration - 1 / p.fps / 2) { resolve(); return; }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });
    await Promise.race([renderLoop, cancelled]);
    if (signal?.aborted) {
      if (rec.state !== "inactive") rec.stop();
      await done.catch(() => {});
      throw exportStoppedError();
    }
    cancelAnimationFrame(rafId);
    await Promise.race([new Promise(r => setTimeout(r, 150)), cancelled]);
    throwIfExportStopped(signal);
    if (rec.state !== "inactive") rec.stop();
    await done;
    throwIfExportStopped(signal);

    const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
    downloadBlob(blob, format);
    setExportProgress(1, 1);
    setStatus("导出完成：" + (blob.size / 1048576).toFixed(1) + " MB " + (blob.type.includes("mp4") ? "MP4" : "WebM") + "，" + formatExportRange(exportRange) + (bg ? "（含背景）" : "（VP9 透明，达芬奇/PR 直用）"), true);
  } finally {
    signal?.removeEventListener("abort", stopOnAbort);
    cancelAnimationFrame(rafId);
    if (rec && rec.state !== "inactive") rec.stop();
    try { audioSource?.stop(); } catch (_) { /* 已自然结束 */ }
    await audioContext?.close?.();
    stream?.getTracks().forEach(track => track.stop());
  }
}

function downloadBlob(blob, exportFormat) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  const base = (state.audioName || (state.demo ? "mtag-demo" : "lipsync")).replace(/\.[^.]+$/, "");
  const isGif = blob.type.includes("gif");
  const ext = isGif ? "gif" : blob.type.includes("mp4") ? "mp4" : "webm";
  const tag = isGif ? "gif" : exportFormat === "mp4" ? "video" : "alpha";
  a.download = `${base}-${tag}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- 参数联动 ----------
const rangeBindings = [
  ["p-threshold", "n-threshold"], ["p-attack", "n-attack"], ["p-release", "n-release"],
  ["p-alt-freq", "n-alt-freq"], ["p-bmin", "n-bmin"], ["p-bmax", "n-bmax"],
  ["p-bdur", "n-bdur"], ["p-seed", "n-seed"], ["p-bounce", "n-bounce"],
  ["p-bfreq", "n-bfreq"], ["p-wiggle", "n-wiggle"], ["p-fps", "n-fps"],
  ["p-exp-h", "n-exp-h"], ["p-vbitrate", "n-vbitrate"],
];
const rangeNumberIds = new Map(rangeBindings);
const reanalyzeParams = new Set([
  "p-threshold", "p-attack", "p-release", "p-alt-freq", "p-bmin", "p-bmax", "p-bdur",
  "p-seed", "p-bounce", "p-bfreq", "p-wiggle", "p-fps", "mouth-alternate", "fx-bounce", "fx-wiggle",
]);

const defaultRangeValues = Object.freeze({
  "p-threshold": 0.025,
  "p-attack": 20,
  "p-release": 120,
  "p-alt-freq": 4.5,
  "p-bmin": 2,
  "p-bmax": 5,
  "p-bdur": 0.18,
  "p-seed": 42,
  "p-bounce": 0.03,
  "p-bfreq": 3,
  "p-wiggle": 1,
  "p-fps": 30,
  "p-exp-h": 720,
  "p-vbitrate": 8,
});

function normalizeRangeValue(range, raw) {
  const min = Number(range.min), max = Number(range.max), step = Number(range.step);
  if (!Number.isFinite(raw)) return null;
  let value = Math.min(max, Math.max(min, raw));
  if (Number.isFinite(step) && step > 0) {
    const base = Number.isFinite(min) ? min : 0;
    value = base + Math.round((value - base) / step) * step;
    value = Math.min(max, Math.max(min, value));
    const decimals = String(step).includes(".") ? String(step).split(".")[1].length : 0;
    value = Number(value.toFixed(decimals));
  }
  return value;
}

function markNumberValidity(number, valid) {
  number.classList.toggle("invalid", !valid);
  number.setAttribute("aria-invalid", String(!valid));
  const stepHint = number.step && number.step !== "any" ? `，步长为 ${number.step}` : "";
  number.setCustomValidity(valid ? "" : `请输入 ${number.min} 到 ${number.max} 之间的有效数值${stepHint}`);
}

function syncNumberFromRange(range, number) {
  number.value = range.value;
  markNumberValidity(number, true);
}

function syncRangeFromNumber(range, number, commit = false) {
  const raw = number.value.trim();
  const parsed = Number(raw);
  const min = Number(range.min), max = Number(range.max);
  const step = Number(range.step);
  const stepBase = Number.isFinite(min) ? min : 0;
  const stepOffset = step > 0 ? (parsed - stepBase) / step : 0;
  const stepValid = step > 0 ? Math.abs(stepOffset - Math.round(stepOffset)) < 1e-9 : true;
  const valid = raw !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max && stepValid;
  if (!valid) {
    markNumberValidity(number, false);
    if (commit) syncNumberFromRange(range, number);
    return false;
  }
  range.value = String(normalizeRangeValue(range, parsed));
  if (commit) number.value = range.value;
  markNumberValidity(number, true);
  return true;
}

function updateResetVisibility(rangeId) {
  const button = document.querySelector(`[data-reset-for="${rangeId}"]`);
  const number = $(rangeNumberIds.get(rangeId));
  const range = $(rangeId);
  if (!button || !number || !range) return;
  const defaultValue = defaultRangeValues[rangeId];
  const numberValue = number.value.trim();
  const atDefault = !number.classList.contains("invalid")
    && numberValue !== ""
    && Number(range.value) === defaultValue
    && Number(numberValue) === defaultValue;
  button.hidden = atDefault;
}

function updateAllResetVisibility() {
  for (const [rangeId] of rangeBindings) updateResetVisibility(rangeId);
}

function setRangeValue(rangeId, value) {
  const range = $(rangeId);
  const number = $(rangeNumberIds.get(rangeId));
  range.value = String(normalizeRangeValue(range, value));
  syncNumberFromRange(range, number);
  updateResetVisibility(rangeId);
}

function enforceBlinkBounds(changedId) {
  const min = Number($("p-bmin").value), max = Number($("p-bmax").value);
  if (min <= max) return;
  if (changedId === "p-bmin") setRangeValue("p-bmax", min);
  else setRangeValue("p-bmin", max);
}

function commitParameter(id) {
  if (id === "p-bmin" || id === "p-bmax") enforceBlinkBounds(id);
  if (reanalyzeParams.has(id)) {
    if (state.mono) analyze();
    else if (state.demo) rebuildDemo();   // 演示模式下用新参数重建演示数据
  } else if (id === "p-exp-h") {
    if (state.analysis) renderPlaybackTime(state.currentTime);
  } else if (id === "p-vbitrate") {
    updateExportRangeUi();   // 码率变化只影响文件大小预估，无需重分析
  }
}

function resetControl(rangeId) {
  if (!(rangeId in defaultRangeValues)) return;
  setRangeValue(rangeId, defaultRangeValues[rangeId]);
  $(rangeId).dispatchEvent(new Event("change"));
  updateAllResetVisibility();
}

for (const [rangeId, numberId] of rangeBindings) {
  const range = $(rangeId), number = $(numberId);
  let committedValue = range.value;
  range.addEventListener("input", () => {
    syncNumberFromRange(range, number);
    updateResetVisibility(rangeId);
  });
  range.addEventListener("change", () => {
    syncNumberFromRange(range, number);
    if (range.value !== committedValue) {
      committedValue = range.value;
      commitParameter(rangeId);
    }
    updateAllResetVisibility();
  });
  number.addEventListener("input", () => {
    syncRangeFromNumber(range, number);
    updateResetVisibility(rangeId);
  });
  const commitNumber = () => {
    if (!syncRangeFromNumber(range, number, true)) {
      updateResetVisibility(rangeId);
      return;
    }
    if (range.value !== committedValue) {
      committedValue = range.value;
      commitParameter(rangeId);
    }
    updateAllResetVisibility();
  };
  number.addEventListener("change", commitNumber);
  number.addEventListener("blur", commitNumber);
}
updateAllResetVisibility();

for (const id of ["export-start", "export-end"]) {
  $(id).addEventListener("input", () => {
    updateExportRangeUi();
    checkReady();
  });
  $(id).addEventListener("change", () => {
    if (!updateExportRangeUi()) setStatus("导出范围无效，请检查开始和结束时间", false);
    checkReady();
  });
}
$("export-full").addEventListener("click", () => {
  if (!state.analysis) return;
  $("export-start").value = "0";
  $("export-end").value = formatDurationInput(state.analysis.duration);
  updateExportRangeUi();
  checkReady();
});

// 导出范围双滑块：左拇指=开始位置，右拇指=结束位置，与数值输入框双向同步
function onExportRangeSliderInput(which) {
  if (!state.analysis || state.exporting) return;
  const duration = state.analysis.duration;
  const step = 0.1;
  const sliderStart = $("export-range-slider-start");
  const sliderEnd = $("export-range-slider-end");
  let startValue = Number(sliderStart.value);
  let endValue = Number(sliderEnd.value);
  if (!Number.isFinite(startValue)) startValue = 0;
  if (!Number.isFinite(endValue)) endValue = duration;
  startValue = Math.min(duration, Math.max(0, startValue));
  endValue = Math.min(duration, Math.max(0, endValue));
  if (endValue - startValue < step) {
    // 两个拇指至少保留一步（0.1s）的间隔，避免贴合后无法分开
    if (which === "start") startValue = Math.max(0, endValue - step);
    else endValue = Math.min(duration, startValue + step);
    (which === "start" ? sliderStart : sliderEnd).value = formatSecondsInput(which === "start" ? startValue : endValue);
  }
  // 抬高当前拖动的拇指，两拇指贴近时也总能抓到想动的那一个
  sliderStart.style.zIndex = which === "start" ? "3" : "1";
  sliderEnd.style.zIndex = which === "end" ? "3" : "1";
  $("export-start").value = formatSecondsInput(startValue);
  $("export-end").value = formatSecondsInput(endValue);
  updateExportRangeFill(startValue, endValue, duration);
  updateExportRangeUi();
  checkReady();
}
$("export-range-slider-start")?.addEventListener("input", () => onExportRangeSliderInput("start"));
$("export-range-slider-end")?.addEventListener("input", () => onExportRangeSliderInput("end"));

// 导出格式切换会改变范围/大小校验口径（如 GIF 10 秒上限）
$("export-mode").addEventListener("change", () => {
  updateExportRangeUi();
  checkReady();
});

function updateAlternateUi() {
  const enabled = $("mouth-alternate").checked;
  $("mouth-alternate-param").classList.toggle("disabled", !enabled);
  $("p-alt-freq").disabled = !enabled || state.exporting;
  $("n-alt-freq").disabled = !enabled || state.exporting;
}

$("mouth-alternate").addEventListener("change", () => {
  updateAlternateUi();
  commitParameter("mouth-alternate");
});
for (const id of ["fx-bounce", "fx-wiggle"]) {
  $(id).addEventListener("change", () => commitParameter(id));
}
for (const button of document.querySelectorAll(".param-reset")) {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    resetControl(button.dataset.resetFor);
  });
}
$("btn-reanalyze").addEventListener("click", clearMaterials);

// ---------- 自定义背景 ----------
function updateBackgroundUi() {
  const type = document.querySelector('input[name="bg-type"]:checked')?.value || "green";
  $("bg-color-row").hidden = type !== "color";
  $("bg-image-row").hidden = type !== "image";
  refreshPreviewFrame();
}

$("bg-enabled").addEventListener("change", () => {
  $("bg-options").hidden = !$("bg-enabled").checked;
  refreshPreviewFrame();
});
for (const radio of document.querySelectorAll('input[name="bg-type"]')) {
  radio.addEventListener("change", () => {
    if (radio.checked && radio.value === "image" && !state.bgImage) {
      setStatus("已选择图片背景，请点击「选择背景图片」上传一张图", true);
    }
    updateBackgroundUi();
  });
}
$("bg-color").addEventListener("input", () => refreshPreviewFrame());
$("bg-image-btn").addEventListener("click", () => {
  if (state.exporting || state.mediaProcessing || state.pendingMediaFile) return;
  $("bg-image-input").click();
});
$("bg-image-input").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (state.bgImage?.src?.startsWith("blob:")) URL.revokeObjectURL(state.bgImage.src);
    state.bgImage = img;
    state.bgImageName = file.name;
    $("bg-image-name").textContent = file.name;
    refreshPreviewFrame();
    setStatus("背景图片已更新", true);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus("背景图片读取失败，请换一张图片", false);
  };
  img.src = url;
});

function updateMediaStartButton() {
  const button = $("btn-start-media");
  const cancelButton = $("btn-cancel-media");
  if (!button || !cancelButton) return;
  const isVideo = state.mediaKind === "video";
  const pending = isVideo && Boolean(state.pendingMediaFile);
  const processing = isVideo && state.mediaProcessing;
  button.hidden = !pending;
  button.disabled = !pending || state.exporting || state.mediaProcessing;
  cancelButton.hidden = !processing;
  cancelButton.disabled = !processing || !state.mediaController || state.mediaController.signal.aborted;
  cancelButton.textContent = state.mediaController?.signal?.aborted ? "正在取消…" : "取消提取";
}

function startPendingMedia() {
  const file = state.pendingMediaFile;
  if (!file || state.exporting || state.mediaProcessing) return;
  state.pendingMediaFile = null;
  updateMediaStartButton();
  // 该调用发生在按钮点击回调中，loadVideoAudio 会在首次 await 前调用 video.play()。
  void loadVideoAudio(file, true);
}

$("btn-start-media")?.addEventListener("click", startPendingMedia);

function cancelMediaProcessing() {
  if (state.mediaKind !== "video" || !state.mediaProcessing || !state.mediaController || state.mediaController.signal.aborted) return;
  state.mediaController.abort();
  updateMediaStartButton();
  setMediaStatus("正在取消媒体处理…", null, "busy");
  setStatus("正在取消媒体处理…", false);
}

$("btn-cancel-media")?.addEventListener("click", cancelMediaProcessing);

function setMediaStatus(message, progress = null, statusState = "busy") {
  const wrap = $("media-status");
  if (!wrap) return;
  const label = $("media-status-text");
  const percent = $("media-status-percent");
  const bar = $("media-progress");
  wrap.hidden = false;
  wrap.dataset.state = statusState;
  label.textContent = message;
  const showProgress = statusState === "busy";
  bar.hidden = !showProgress;
  percent.hidden = !showProgress;
  if (!showProgress) {
    bar.value = statusState === "ok" ? 1 : 0;
    percent.textContent = statusState === "ok" ? "完成" : "";
    return;
  }
  if (Number.isFinite(progress)) {
    const ratio = Math.min(1, Math.max(0, progress));
    bar.value = ratio;
    percent.textContent = `${Math.round(ratio * 100)}%`;
  } else {
    bar.removeAttribute("value");
    percent.textContent = "处理中";
  }
}

function clearMediaStatus() {
  const wrap = $("media-status");
  if (!wrap) return;
  wrap.hidden = true;
  wrap.dataset.state = "busy";
  $("media-status-text").textContent = "";
  $("media-status-percent").textContent = "";
  $("media-status-percent").hidden = false;
  $("media-progress").hidden = false;
  $("media-progress").value = 0;
  $("btn-start-media")?.setAttribute("hidden", "");
  $("btn-cancel-media")?.setAttribute("hidden", "");
}

function setStatus(msg, ok = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = ok ? "ok" : "";
}
checkReady();
