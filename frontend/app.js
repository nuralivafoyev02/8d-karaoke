"use strict";

/* ============================================================
   8D Karaoke — frontend logikasi
   - Web Audio API bilan jonli 8D effekti (aylanuvchi pan + aks-sado)
   - player (play/pause/seek/volume)
   - karaoke: so'z-darajali vaqt belgilariga sinxron animatsiya
   ============================================================ */

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);

const tabUrl = $("tabUrl"), tabFile = $("tabFile");
const urlPanel = $("urlPanel"), filePanel = $("filePanel");
const urlInput = $("urlInput"), urlBtn = $("urlBtn");
const dropZone = $("dropZone"), fileInput = $("fileInput");
const progress = $("progress"), progressText = $("progressText");
const errorBox = $("errorBox");
const playerSection = $("playerSection"), lyricsSection = $("lyricsSection");
const songTitle = $("songTitle"), songMeta = $("songMeta");
const playBtn = $("playBtn"), seek = $("seek"), volume = $("volume");
const curTime = $("curTime"), totalTime = $("totalTime");
const lyricsScroll = $("lyricsScroll"), lyricsEl = $("lyrics"), noLyrics = $("noLyrics");
const speed = $("speed"), depth = $("depth"), reverb = $("reverb");
const speedVal = $("speedVal"), depthVal = $("depthVal"), reverbVal = $("reverbVal");
const resetBtn = $("resetBtn");

// ---------------- Audio graf ----------------
let ctx = null;
let master = null, convolver = null, wetGain = null, dryGain = null;
let pan = null, lfo = null, lfoDepth = null;

let audioBuffer = null;
let source = null;
let playing = false;
let startedAt = 0;   // ctx.currentTime — o'ynash boshlanganda
let offset = 0;      // bufer ichidagi pozitsiya (sekund)

// ---------------- Karaoke holati ----------------
let words = [];       // [{start, end, text}]
let wordEls = [];     // [{el, start, end, lineEl}]
let activeIdx = -1;
let wordPtr = 0;
let currentJob = null;

// ============================================================
//  8D audio grafini qurish
// ============================================================
function ensureCtx() {
  if (ctx) {
    if (ctx.state === "suspended") ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = volume.value / 100;
  master.connect(ctx.destination);

  // Kompressor — baland va barqaror ovoz
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  comp.connect(master);

  // Aks-sado (reverb) — protsedural yaratilgan impuls javobi
  convolver = ctx.createConvolver();
  convolver.connect(comp);
  wetGain = ctx.createGain();
  wetGain.connect(comp);
  dryGain = ctx.createGain();
  dryGain.connect(comp);

  // Stereo pan — 8D aylanish shu yerda
  pan = ctx.createStereoPanner();
  pan.connect(dryGain);
  pan.connect(convolver);

  // LFO: sinus to'lqin pan.pan'ni boshqaradi → tovush bosh atrofida aylanadi
  lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = speed.value / 100;
  lfoDepth = ctx.createGain();
  lfoDepth.gain.value = depth.value / 100;
  lfo.connect(lfoDepth);
  lfoDepth.connect(pan.pan);
  lfo.start();

  buildIR(3.2);
  applyReverbMix();
}

// Impuls javob (aks-sado "xonasi") — shovqin + eksponensial so'nish
function buildIR(seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
  }
  convolver.buffer = buf;
}

function applyReverbMix() {
  if (!wetGain) return;
  const r = reverb.value / 100;
  wetGain.gain.value = r * 0.9;        // aks-sado miqdori
  dryGain.gain.value = 1 - r * 0.55;   // asl ovoz (to'liq o'chmaydi)
}

// ============================================================
//  Player
// ============================================================
function play() {
  if (!audioBuffer) return;
  ensureCtx();
  if (source) { source.stop(); source.disconnect(); source = null; }
  source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(pan);
  source.onended = () => {
    // Tabiiy tugash — boshiga qaytamiz
    if (playing && currentPos() >= audioBuffer.duration - 0.05) {
      playing = false;
      offset = 0;
      wordPtr = 0;
      activeIdx = -1;
      playBtn.textContent = "▶";
      source = null;
    }
  };
  startedAt = ctx.currentTime;
  offset = Math.min(offset, Math.max(0, audioBuffer.duration - 0.05));
  source.start(0, offset);
  playing = true;
  playBtn.textContent = "⏸";
  playBtn.setAttribute("aria-label", "Pauza");
}

function pause() {
  if (!playing) return;
  offset = currentPos();
  if (source) { source.stop(); source.disconnect(); source = null; }
  playing = false;
  playBtn.textContent = "▶";
  playBtn.setAttribute("aria-label", "O'ynatish");
}

function currentPos() {
  return playing ? offset + (ctx.currentTime - startedAt) : offset;
}

function seekTo(t) {
  if (!audioBuffer) return;
  offset = Math.max(0, Math.min(t, audioBuffer.duration));
  wordPtr = 0;
  activeIdx = -1;
  if (playing) {
    if (source) { source.stop(); source.disconnect(); source = null; }
    play();
  }
  updateUI();
}

function resetPlayback() {
  pause();
  if (source) { source.disconnect(); source = null; }
  audioBuffer = null;
  words = [];
  wordEls = [];
  activeIdx = -1;
  wordPtr = 0;
  currentJob = null;
  seek.value = 0;
  curTime.textContent = "0:00";
  totalTime.textContent = "0:00";
}

// ============================================================
//  UI yangilash (rAF sikli)
// ============================================================
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateUI() {
  if (!audioBuffer) return;
  const t = currentPos();
  seek.value = (t / audioBuffer.duration) * 1000;
  curTime.textContent = fmt(t);
  totalTime.textContent = fmt(audioBuffer.duration);
}

function tick() {
  if (audioBuffer && !scrubbing) {
    const t = currentPos();
    seek.value = (t / audioBuffer.duration) * 1000;
    curTime.textContent = fmt(t);
    updateKaraoke(t);
  }
  requestAnimationFrame(tick);
}

// ============================================================
//  Karaoke
// ============================================================
// So'zlarni qatorlarga guruhlash: katta tanaffus yoki uzun qator bo'lsa yangi qator
function buildLines(wordList) {
  const lines = [];
  let cur = [];
  let lastEnd = null;
  for (const w of wordList) {
    const gap = lastEnd === null ? 0 : w.start - lastEnd;
    if (cur.length && (gap > 0.45 || cur.length >= 14)) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
    lastEnd = w.end;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function renderLyrics() {
  lyricsEl.innerHTML = "";
  wordEls = [];
  for (const line of buildLines(words)) {
    const lineEl = document.createElement("div");
    lineEl.className = "line";
    for (const w of line) {
      const span = document.createElement("span");
      span.className = "word";
      span.textContent = w.text;
      span.title = "Bosish — shu joyga o'tish / Click to seek";
      span.addEventListener("click", () => seekTo(w.start));
      lineEl.appendChild(span);
      wordEls.push({ el: span, start: w.start, end: w.end, lineEl });
    }
    lyricsEl.appendChild(lineEl);
  }
}

function applyClasses() {
  wordEls.forEach((w, i) => {
    w.el.classList.toggle("done", i < activeIdx);
    w.el.classList.toggle("todo", i > activeIdx);
    w.el.classList.toggle("active", i === activeIdx);
  });
  // faol qatorni ajratib ko'rsatish
  wordEls.forEach((w) => w.lineEl.classList.remove("active-line"));
  if (activeIdx >= 0) wordEls[activeIdx].lineEl.classList.add("active-line");
}

function updateKaraoke(t) {
  if (!wordEls.length) return;

  // oldinga siljish (wordPtr — o'tgan so'zlarni qayta tekshirmaymiz)
  while (wordPtr < wordEls.length && t > wordEls[wordPtr].end) wordPtr++;

  let idx = -1;
  for (let i = wordPtr; i < wordEls.length; i++) {
    if (t >= wordEls[i].start && t < wordEls[i].end) { idx = i; break; }
    if (t < wordEls[i].start) break;
  }

  if (idx !== activeIdx) {
    activeIdx = idx;
    applyClasses();
    if (idx >= 0) {
      // faol qatorni ko'rinadigan joyga olib kelish
      const lineRect = wordEls[idx].lineEl.getBoundingClientRect();
      const contRect = lyricsScroll.getBoundingClientRect();
      if (lineRect.top < contRect.top || lineRect.bottom > contRect.bottom) {
        wordEls[idx].lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }
}

// ============================================================
//  Job oqimi (backend bilan ishlash)
// ============================================================
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function showProgress(msg) {
  progress.classList.remove("hidden");
  progressText.textContent = msg;
}

function showError(msg) {
  progress.classList.add("hidden");
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
}

async function pollJob(id) {
  const t0 = Date.now();
  for (;;) {
    await sleep(800);
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) throw new Error("Server bilan bog'lanishda xatolik");
    const job = await res.json();
    const sec = Math.round((Date.now() - t0) / 1000);
    if (job.status === "ready") return job;
    if (job.status === "error") throw new Error(job.error || "Noma'lum xatolik");
    showProgress(
      `Yuklab olinmoqda va tahlil qilinmoqda... (${sec}s) — bu bir necha daqiqa olishi mumkin. ` +
      `(Downloading & analyzing... (${sec}s) — this may take a few minutes.)`
    );
  }
}

async function onReady(job) {
  resetPlayback();
  currentJob = job;
  songTitle.textContent = job.title || "Audio";
  const lang = job.language ? ` · ${job.language.toUpperCase()}` : "";
  songMeta.textContent = `Davomiyligi: ${fmt(job.duration || 0)}${lang}`;

  // Audioni yuklab, buferga dekod qilamiz
  const resp = await fetch(`/api/audio/${job.id}`);
  if (!resp.ok) throw new Error("Audio yuklab bo'lmadi");
  const arr = await resp.arrayBuffer();
  ensureCtx();
  audioBuffer = await ctx.decodeAudioData(arr);

  words = Array.isArray(job.words) ? job.words : [];
  renderLyrics();
  totalTime.textContent = fmt(audioBuffer.duration);

  noLyrics.classList.toggle("hidden", words.length > 0);
  playerSection.classList.remove("hidden");
  lyricsSection.classList.remove("hidden");
  progress.classList.add("hidden");
  errorBox.classList.add("hidden");
  urlBtn.disabled = false;
  urlBtn.textContent = "Yuklash va tahlil qilish";

  playerSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function startYoutube() {
  const url = urlInput.value.trim();
  if (!url) { showError("Iltimos, YouTube havolasini kiriting"); return; }
  urlBtn.disabled = true;
  urlBtn.textContent = "Ishlanmoqda...";
  showProgress("Yuklab olinmoqda va tahlil qilinmoqda...");
  try {
    const res = await fetch("/api/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Xatolik yuz berdi");
    const job = await pollJob(data.id);
    await onReady(job);
  } catch (e) {
    showError(e.message || String(e));
    urlBtn.disabled = false;
    urlBtn.textContent = "Yuklash va tahlil qilish";
  }
}

async function uploadFile(file) {
  if (!file) return;
  showProgress("Fayl yuklanmoqda va tahlil qilinmoqda...");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Xatolik yuz berdi");
    const job = await pollJob(data.id);
    await onReady(job);
  } catch (e) {
    showError(e.message || String(e));
  }
}

// ============================================================
//  Hodisalar (events)
// ============================================================
playBtn.addEventListener("click", () => {
  if (!audioBuffer) return;
  if (playing) pause(); else play();
});

// Seek bar: tortish paytida faqat vaqtni ko'rsatamiz, qo'yib yuborilganda o'tamiz
let scrubbing = false;
seek.addEventListener("input", () => {
  if (!audioBuffer) return;
  scrubbing = true;
  const t = (seek.value / 1000) * audioBuffer.duration;
  offset = t;
  curTime.textContent = fmt(t);
});
seek.addEventListener("change", () => {
  scrubbing = false;
  if (!audioBuffer) return;
  seekTo((seek.value / 1000) * audioBuffer.duration);
});

volume.addEventListener("input", () => {
  if (master) master.gain.value = volume.value / 100;
});

speed.addEventListener("input", () => {
  speedVal.textContent = (speed.value / 100).toFixed(2) + " Hz";
  if (lfo) lfo.frequency.value = speed.value / 100;
});

depth.addEventListener("input", () => {
  depthVal.textContent = depth.value + "%";
  if (lfoDepth) lfoDepth.gain.value = depth.value / 100;
});

reverb.addEventListener("input", () => {
  reverbVal.textContent = reverb.value + "%";
  applyReverbMix();
});

resetBtn.addEventListener("click", () => {
  speed.value = 12; depth.value = 90; reverb.value = 35;
  speedVal.textContent = "0.12 Hz";
  depthVal.textContent = "90%";
  reverbVal.textContent = "35%";
  if (lfo) lfo.frequency.value = 0.12;
  if (lfoDepth) lfoDepth.gain.value = 0.9;
  applyReverbMix();
});

// Tablar
function setTab(which) {
  const isUrl = which === "url";
  tabUrl.classList.toggle("active", isUrl);
  tabFile.classList.toggle("active", !isUrl);
  urlPanel.classList.toggle("hidden", !isUrl);
  filePanel.classList.toggle("hidden", isUrl);
  errorBox.classList.add("hidden");
}
tabUrl.addEventListener("click", () => setTab("url"));
tabFile.addEventListener("click", () => setTab("file"));

urlBtn.addEventListener("click", startYoutube);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") startYoutube(); });

// Fayl yuklash
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  fileInput.value = "";
});
["dragover", "dragenter"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); })
);
dropZone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

// ============================================================
//  Ishga tushirish
// ============================================================
requestAnimationFrame(tick);
