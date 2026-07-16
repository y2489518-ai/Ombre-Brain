
/* ════════════════════════════════════════════════════════════════
   Tidal Echo — PWA chat shell (open source)
   A private 1:1 chat front-end for a person and their AI companion,
   talking to a self-hosted relay backend. No domain or secret is baked in.
   Backend contract: GET /app/history · SSE /app/stream · POST /app/send · /healthz
   ════════════════════════════════════════════════════════════════ */

/* ── identity / branding — the ONE place to set names + app title ── */
const CONFIG = {
  APP_NAME:   "Loved",  // app + menu title (and manifest, set there too)
  AI_NAME:    "Kael",       // your AI companion's display name (header / call / push / narration)
  HUMAN_NAME: "宝宝",           // how you're referred to in narration (rarely shown)
  SINCE:      "2026/05/23",   // "together since" date YYYY/MM/DD for the menu counter ("" hides it)
};
const AI_NAME = CONFIG.AI_NAME, HUMAN_NAME = CONFIG.HUMAN_NAME, APP_NAME = CONFIG.APP_NAME;

const API_BASE = "/relay";       // same-origin; nginx mounts the relay here (RELAY_PUBLIC_PREFIX)
const USE_MOCK  = false;          // true = self-contained demo with fake data (no backend needed)
const LS_KEY    = "companion_secret";

/* ── 状态 ── */
let secret  = localStorage.getItem(LS_KEY);
/* 一键进门链接：#k=密钥 放在 URL fragment（fragment 不上服务器不进日志）。
   重装 app 后点一次收藏的魔法链接就自动登录，再也不用手敲密钥界面。 */
try{
  const mk = (location.hash || "").match(/[#&]k=([^&]+)/);
  if (mk && mk[1]){
    secret = decodeURIComponent(mk[1]);
    localStorage.setItem(LS_KEY, secret);
    history.replaceState(null, "", location.pathname + location.search);  // 立刻擦掉地址栏里的密钥
  }
}catch(_){}
let lastId  = 0;
const seen  = new Set();
let es      = null;     // EventSource(或 MockEventSource)
let connected = false;
let healthTimer = null;
let streamWatchTimer = null;
let backfillTimer = null;
let lastStreamEventAt = 0;
let backfillInFlight = false;
const STREAM_STALE_MS = 45000;
const BACKFILL_MS = 20000;
const STREAM_FLUSH_MS = 80;
let typingTimer = null;
let typingActive = false;
const freshKeys = new Set();   // 刚发/刚收到、待播一次入场动画的消息 key
const freshReactionKeys = new Set();   // messages whose AI reaction just arrived, pending a one-shot pop
const streamDrafts = new Map();        // stream_id+kind -> temporary bubble key
const streamDeltaBuffers = new Map();  // stream_id+kind -> batched delta
let streamFlushTimer = null;
// messages you deleted locally (view only; never touches the server); persisted so refresh/backfill won't bring them back
const deletedKeys = new Set();
try{ (JSON.parse(localStorage.getItem("companion_deleted_ids") || "[]") || []).forEach((k) => deletedKeys.add(String(k))); }catch(_){}
function persistDeletedKeys(){
  try{ localStorage.setItem("companion_deleted_ids", JSON.stringify(Array.from(deletedKeys).slice(-5000))); }catch(_){}
}

/* ── DOM ── */
const $ = (s) => document.querySelector(s);
const loginEl = $("#login"), appEl = $("#app");
const scrollEl = $("#scroll"), emptyEl = $("#empty");
const statusEl = $("#status"), inputEl = $("#input"), sendBtn = $("#sendBtn"), newMsgBtn = $("#newMsgBtn");
const micBtn = $("#micBtn"), clipBtn = $("#clipBtn"), avatarBtn = $("#avatarBtn");
const clipInput = $("#clipInput");
const localPreview = new Map();   // serverUrl -> blob: 本地预览，避免上传后重新下载闪烁
const avatarInput = $("#avatarInput"), wallEl = $("#wall");
const peerNameEl = $("#peerName"), profilePanel = $("#profilePanel");
const profileClose = $("#profileClose"), moreBtn = $("#moreBtn");
const profileAvatarBtn = $("#profileAvatarBtn"), profileNameEl = $("#profileName");
const profileNameInput = $("#profileNameInput"), profileNameEdit = $("#profileNameEdit");
const modelSeg = $("#modelSeg"), effortSeg = $("#effortSeg"), contextSlider = $("#contextSlider");
const resetRow = $("#resetRow"), swapRow = $("#swapRow"), resumeRow = $("#resumeRow");
const statusCopy = $("#statusCopy"), statusSidEl = $("#statusSid"), statusUsedEl = $("#statusUsed");
const sessionBtn = $("#sessionBtn"), sessionPop = $("#sessionPop"), sessionList = $("#sessionList"), sessionNewBtn = $("#sessionNewBtn");
const terminalBtn = $("#terminalBtn"), terminalPanel = $("#terminalPanel"), terminalBack = $("#terminalBack"), terminalLog = $("#terminalLog"), terminalForm = $("#terminalForm"), terminalInput = $("#terminalInput"), terminalSession = $("#terminalSession");
const brainSeg = $("#brainSeg"), brainHint = $("#brainHint");

/* ════════ 固定聊天背景 + 本地头像 ════════ */
const THEMES = ["light","harbor"];
const WALLS = { light: "solid:#F5F4EF", harbor: "solid:#262624" };  /* Claude 皮：纯色墙 */
const AVATAR_KEY = "companion_avatar";
const REMARK_KEY = "companion_profile_remark";
const SESSION_PICK_KEY = "companion_api_session_pick";
const LEGACY_SESSION_ID = "__legacy__";
const TERMINAL_WRAP = "[companion:pseudo-terminal]";
let apiSessions = [];
let activeApiSession = LEGACY_SESSION_ID;

function currentTheme(){
  const t = document.documentElement.getAttribute("data-theme");
  return THEMES.indexOf(t) >= 0 ? t : "light";
}
function currentWall(){ return WALLS[currentTheme()] || WALLS.light; }

function setThemeColor(color){
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", color);
}
function sampleImageBand(img, yStart, ySize){
  var c = document.createElement("canvas"); c.width = 1; c.height = 1;
  var ctx = c.getContext("2d");
  ctx.drawImage(img, 0, yStart, img.width, Math.max(1, ySize), 0, 0, 1, 1);
  var d = ctx.getImageData(0,0,1,1).data;
  return "rgb("+d[0]+","+d[1]+","+d[2]+")";
}
function applyWall(url){
  if (url && url.startsWith("solid:")){
    const col = url.slice(6);
    wallEl.style.backgroundImage = "none";
    wallEl.style.backgroundColor = col;
    var de0 = document.documentElement, bd0 = document.body;
    [de0, bd0].forEach((el) => {
      if (!el) return;
      el.style.setProperty("background-image", "none", "important");
      el.style.setProperty("background-color", col, "important");
    });
    setThemeColor(col);
    return;
  }
  const image = `url("${url}")`;
  wallEl.style.backgroundImage = image;

  // iOS Home Screen paints status/home areas from host chrome. Keep root paint
  // close to the fixed wallpaper, while leaving the real layout viewport alone.
  var de = document.documentElement, bd = document.body;
  [de, bd].forEach((el) => {
    if (!el) return;
    el.style.setProperty("background-image", image, "important");
    el.style.setProperty("background-size", "cover", "important");
    el.style.setProperty("background-position", "center", "important");
    el.style.setProperty("background-repeat", "no-repeat", "important");
  });

  var img = new Image();
  img.onload = function(){
    try{
      var topCol = sampleImageBand(img, 0, Math.max(1, Math.floor(img.height*0.12)));
      var botCol = sampleImageBand(img, Math.floor(img.height*0.88), Math.max(1, Math.floor(img.height*0.12)));
      setThemeColor(topCol);
      de.style.setProperty("background-color", botCol, "important");
      bd.style.setProperty("background-color", botCol, "important");
    }catch(e){}
  };
  img.src = url;
}
function applyAvatar(url){
  // 写 CSS 变量 → 顶栏头像、聊天每条消息旁的头像、空状态/登录 orb、profile 大头像一起换
  const val = url ? `url("${url}")` : 'url("avatar-sea.png")';
  document.documentElement.style.setProperty("--avatar-default", val);
}
function applyRemark(value){
  const name = (value || "").trim() || AI_NAME;
  if (peerNameEl) peerNameEl.textContent = name;
  if (profileNameEl) profileNameEl.textContent = name;
}
/* Push CONFIG names/branding onto every static UI surface — names live in one place. */
function applyIdentity(){
  try{ document.title = APP_NAME; }catch(_){}
  const setText = (sel, val) => { const el = document.querySelector(sel); if (el) el.textContent = val; };
  const setAttr = (sel, a, val) => { const el = document.querySelector(sel); if (el) el.setAttribute(a, val); };
  setText(".login h1", AI_NAME);
  setText(".login .sub", "输入连接密钥，进入你和" + AI_NAME + "的频道。");
  const emp = document.querySelector("#empty p"); if (emp) emp.innerHTML = "这里只有你和" + AI_NAME + "。<br>说点什么吧。";
  setText(".call-name", AI_NAME);
  setAttr("#callAvatarImg", "aria-label", AI_NAME);
  setText(".incoming-call-title", AI_NAME + "来电");
  setText("#incomingCallText", AI_NAME + "想和你语音通话。");
  setAttr(".incoming-call-avatar", "aria-label", AI_NAME);
  setText(".menu-title", APP_NAME);
  const since = document.querySelector(".menu-since");
  if (since) since.textContent = CONFIG.SINCE ? ("since " + CONFIG.SINCE) : "";
}

let profileCloseTimer = null;
function openProfile(){
  if (!profilePanel) return;
  cancelNameEdit();
  clearTimeout(profileCloseTimer);
  profilePanel.classList.remove("hidden");
  // double rAF so the slide-in runs from the off-screen state
  requestAnimationFrame(() => requestAnimationFrame(() => profilePanel.classList.add("open")));
  refreshContextStatus();
}
function closeProfile(){
  if (!profilePanel) return;
  commitNameEdit();
  profilePanel.classList.remove("open");
  clearTimeout(profileCloseTimer);
  profileCloseTimer = setTimeout(() => profilePanel.classList.add("hidden"), 360);
}

try{ localStorage.removeItem("companion_bg"); }catch(e){}
applyIdentity();
applyWall(currentWall());
applyAvatar(localStorage.getItem(AVATAR_KEY));
applyRemark(localStorage.getItem(REMARK_KEY));
initAvatarSync();                                          // 服务器为准：新设备/重装也能拿回头像
async function initAvatarSync(){
  try{
    const r = await fetch(`${API_BASE}/app/avatar`, { headers: authHeaders() });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.url){
      const u = attUrl(d.url);
      applyAvatar(u);
      try{ localStorage.setItem(AVATAR_KEY, u); }catch(_){}
    } else {
      // 服务器还没有 → 本机若存着旧 dataURL 头像，迁移一份上去（一次性）
      const legacy = localStorage.getItem(AVATAR_KEY);
      if (legacy && /^data:image\//.test(legacy)){
        const blob = await (await fetch(legacy)).blob();
        const saved = await apiAvatarUpload(blob, blob.type || "image/png");
        if (saved && saved.url){
          const u = attUrl(saved.url);
          applyAvatar(u);
          try{ localStorage.setItem(AVATAR_KEY, u); }catch(_){}
        }
      }
    }
  }catch(_){}
}
/* 主题只由日夜 toggle 控制(持久化),不再实时跟随系统;首次打开的初始值由 <head> 早期脚本取一次系统值 */
if (avatarBtn) avatarBtn.addEventListener("click", openProfile);
if (moreBtn) moreBtn.addEventListener("click", openProfile);
if (profileAvatarBtn) profileAvatarBtn.addEventListener("click", () => avatarInput && avatarInput.click());
if (profileClose) profileClose.addEventListener("click", closeProfile);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && profilePanel && !profilePanel.classList.contains("hidden")) closeProfile();
});

/* ── Main menu (hub · entered from the chat back-arrow). Chat returns to chat. ── */
const backBtn = $("#backBtn");
const menuPanel = $("#menuPanel"), menuDaysEl = $("#menuDays");
const TOGETHER_START = (function(){
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(CONFIG.SINCE || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;   // null → counter hidden
})();
function daysTogether(){
  if (!TOGETHER_START) return 0;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - TOGETHER_START) / 86400000)) + 1;   // midnight-safe, DST-proof；+1=含首日（2026-07-14 她拍板"按亚洲地区算"，5/23 当天就是第 1 天）
}
function refreshDays(){
  const wrap = document.querySelector(".menu-days");
  if (!TOGETHER_START){ if (wrap) wrap.style.display = "none"; return; }
  if (menuDaysEl) menuDaysEl.textContent = daysTogether();
}
let menuCloseTimer = null;
function openMenu(){
  if (!menuPanel) return;
  refreshDays();
  clearTimeout(menuCloseTimer);
  menuPanel.classList.remove("hidden");
  requestAnimationFrame(() => requestAnimationFrame(() => menuPanel.classList.add("open")));
}
function closeMenu(){
  if (!menuPanel) return;
  menuPanel.classList.remove("open");
  clearTimeout(menuCloseTimer);
  menuCloseTimer = setTimeout(() => menuPanel.classList.add("hidden"), 400);
}
refreshDays();
if (backBtn) backBtn.addEventListener("click", openMenu);
if (menuPanel){
  menuPanel.addEventListener("click", (e) => {
    const item = e.target.closest(".menu-item");
    if (!item) return;
    if (item.dataset.menu === "chat") closeMenu();       // back to chat
    else if (item.dataset.menu === "album") location.assign("album.html");  // album shell (wire your own backend)
    else if (item.dataset.menu === "pulse") location.assign("pulse.html");  // 心跳墙（Kael 的八根条子）
    else if (item.dataset.menu === "music") location.assign("music.html");  // 音乐角（她的网易云+Kael点的歌）
    else if (item.dataset.menu === "tides") location.assign("tides.html");  // 信箱馆（kael@loved.city 往来信）
    else if (item.dataset.menu === "memory") location.assign("memory.html");  // 记忆屋（二期）：relay 直读 OB 桶文件 只看不改；OB 仪表盘仍在 ob.loved.city
    else if (item.dataset.menu === "room") location.assign("https://folio.loved.city");  // 书房（Folio 共读图书馆）
    else showToast("即将开放");                           // placeholder items
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuPanel && !menuPanel.classList.contains("hidden")) closeMenu();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshDays(); });

/* 设置页 #themeSeg 分段控件 — 手动切 5 套主题,持久化,联动壁纸/theme-color */
const THEME_KEY = "companion_theme";
const themeSeg = $("#themeSeg");
function syncThemeSeg(){
  if (!themeSeg) return;
  const cur = currentTheme();
  themeSeg.querySelectorAll("button").forEach(b => {
    b.classList.toggle("active", b.dataset.val === cur);
  });
}
function setTheme(mode){
  const t = THEMES.indexOf(mode) >= 0 ? mode : "light";
  document.documentElement.setAttribute("data-theme", t);
  try{ localStorage.setItem(THEME_KEY, t); }catch(e){}
  syncThemeSeg();
  applyWall(currentWall());
}
syncThemeSeg();
if (themeSeg) themeSeg.addEventListener("click", e => {
  const btn = e.target.closest("button[data-val]");
  if (btn) setTheme(btn.dataset.val);
});

/* 本地预览便捷:仅 localhost 下,带 #preview-menu 直接亮出 hub 菜单(线上域名不生效,安全) */
(function(){
  var isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname);
  function maybePreview(){
    if (isLocal && location.hash === "#preview-menu"){
      try{ loginEl.classList.add("hidden"); appEl.classList.remove("hidden"); }catch(e){}
      if (typeof openMenu === "function") openMenu();
    }
  }
  maybePreview();
  window.addEventListener("hashchange", maybePreview);
})();

/* ── Voice call: browser live transcription → relay /app/voice → AI channel ── */
(function setupCall(){
  const overlay     = $("#callOverlay");
  const callBtn     = $("#callBtn");
  if (!overlay || !callBtn) return;
  const scrim       = $("#callScrim");
  const hangup      = $("#callHangup");
  const waveEl      = $("#callWave");
  const timerEl     = $("#callTimer");
  const transcript  = $("#callTranscript");
  const captionText = $("#callCaptionText");
  const incomingOverlay = $("#incomingCallOverlay");
  const incomingScrim   = $("#incomingCallScrim");
  const incomingTextEl  = $("#incomingCallText");
  const incomingAccept  = $("#incomingCallAccept");
  const incomingDecline = $("#incomingCallDecline");
  const miniBar      = $("#callMini");
  const miniTimer    = $("#callMiniTimer");
  const minimizeBtn  = $("#callMinimize");
  const callQuoteText = $("#callQuoteText");
  const callAvatarRing = $("#callAvatarRing");
  const callVuLeft   = $("#callVuLeft");
  const callVuRight  = $("#callVuRight");
  const callMuteBtn  = $("#callMuteBtn");
  const callPrivateBtn = $("#callPrivateBtn");
  const callSpeakerBtn = $("#callSpeakerBtn");

  const VU_BARS = 16;   // 每侧声纹竖条数
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  let open = false;
  let minimized = false;
  let muted = false;
  let privateMode = false;
  let audioSenseInterval = null;
  let secs = 0, tickId = null, hideId = null, rafId = null;
  let waveBuilt = false;
  let bars = [];
  let recognition = null, recognitionWanted = false, recognitionRestart = null;
  let mediaStream = null, mediaRecorder = null;
  let audioCtx = null, analyser = null, freqData = null;
  let speakingUtterance = null;
  let ttsAudio = null, ttsUrl = "", speakTimeout = null, resumeTimer = null;
  let speakSeq = 0;
  let callId = "";
  let incomingOpen = false;
  let pendingIncomingText = "";

  function buildVu(){
    if (waveBuilt) return;
    [callVuLeft, callVuRight].forEach((host, side) => {
      if (!host) return;
      host.textContent = "";
      const frag = document.createDocumentFragment();
      for (let i = 0; i < VU_BARS; i++){
        const t = i / (VU_BARS - 1);                  // 0 = 贴头像(内) → 1 = 最外
        const fade = Math.pow(1 - t, 0.9);            // 内高外低 + 向外淡出
        const ripple = 0.5 + 0.5 * Math.sin(i * 1.9 + side * 1.1);
        const bar = Math.max(0.12, fade * (0.42 + 0.58 * ripple));
        const el = document.createElement("i");
        el.style.setProperty("--bar", bar.toFixed(3));
        el.style.setProperty("--bar-op", (0.16 + 0.66 * fade).toFixed(3));
        el.style.setProperty("--vu-dur", (1.25 + (i % 5) * 0.16).toFixed(2) + "s");
        el.style.setProperty("--vu-delay", (-(i % 7) * 0.12 - side * 0.05).toFixed(2) + "s");
        frag.appendChild(el);
      }
      host.appendChild(frag);
    });
    waveBuilt = true;
  }

  function fmt(s){
    const m = Math.floor(s / 60), r = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r;
  }

  function setCaption(text){
    if (captionText) captionText.textContent = text;
  }

  /* status line shown in the big quote area (first person, from the AI) */
  const HINT_LISTENING = "我在听,你慢慢说";
  const HINT_THINKING  = "我在想";
  function splitLyric(text){
    var lines = text.split(/(?<=[。！？\n.!?])\s*/g).filter(function(s){ return s.trim(); });
    if (lines.length >= 2) return lines;
    return text.split(/(?<=[，,；;])\s*/g).filter(function(s){ return s.trim(); });
  }
  function setQuote(text, opts){
    opts = opts || {};
    if (!callQuoteText) return;
    callQuoteText.textContent = "";
    callQuoteText.classList.remove("clip");
    callQuoteText.classList.toggle("hint", !!opts.hint);
    if (opts.hint || !text){
      callQuoteText.textContent = text || "";
      if (opts.dots){
        var d = document.createElement("span");
        d.className = "call-dots call-dots-quote";
        d.innerHTML = "<i></i><i></i><i></i>";
        callQuoteText.appendChild(d);
      }
    } else {
      var lines = splitLyric(text);
      if (lines.length > 1) callQuoteText.classList.add("lyric-mode");
      lines.forEach(function(line){
        var span = document.createElement("span");
        span.className = "lyric-line";
        span.textContent = line;
        callQuoteText.appendChild(span);
      });
    }
    callQuoteText.scrollTop = 0;
  }
  function peerTyping(active){
    if (!open || speakBusy) return;        // 已经在说了就不退回"在想"
    if (active){
      setCaption("thinking");
      setQuote(HINT_THINKING, { hint: true, dots: true });   // 「我在想 …」← 收到=已送达的贴心回执
    } else {
      setCaption("listening");
      setQuote(HINT_LISTENING, { hint: true });              // 「我在听,你慢慢说」
    }
  }

  function setTranscript(text, caretOn = false){
    if (!transcript) return;
    transcript.textContent = "";
    const span  = document.createElement("span");
    span.textContent = text || "";
    transcript.appendChild(span);
    if (!caretOn) return;
    const caret = document.createElement("span");
    caret.className = "caret";
    transcript.appendChild(caret);
  }

  function showIncomingCall(text){
    if (open || !incomingOverlay) return;
    pendingIncomingText = String(text || (AI_NAME + "想和你语音通话。")).trim() || (AI_NAME + "想和你语音通话。");
    if (incomingTextEl) incomingTextEl.textContent = pendingIncomingText;
    incomingOpen = true;
    incomingOverlay.classList.remove("hidden");
    incomingOverlay.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => requestAnimationFrame(() => incomingOverlay.classList.add("open")));
  }

  function hideIncomingCall(){
    if (!incomingOverlay || !incomingOpen) return;
    incomingOpen = false;
    incomingOverlay.classList.remove("open");
    incomingOverlay.setAttribute("aria-hidden", "true");
    setTimeout(() => {
      if (!incomingOpen) incomingOverlay.classList.add("hidden");
    }, 380);
  }

  async function acceptIncomingCall(){
    const firstLine = pendingIncomingText;
    hideIncomingCall();
    await openCall();
    if (firstLine) speak(firstLine);
  }

  function setWaveLevel(level){
    const v = Math.max(0, Math.min(1, level || 0));
    const vs = v.toFixed(3);
    if (callAvatarRing) callAvatarRing.style.setProperty("--ring-level", vs);
    if (callVuLeft) callVuLeft.style.setProperty("--vu-level", vs);
    if (callVuRight) callVuRight.style.setProperty("--vu-level", vs);
  }
  let vuDecay = null;
  function pulseVu(level){
    setWaveLevel(level);
    if (vuDecay) clearTimeout(vuDecay);
    vuDecay = setTimeout(() => setWaveLevel(0), 360);
  }

  function stopWaveMeter(){
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    try{ if (audioCtx) audioCtx.close(); }catch(e){}
    audioCtx = null; analyser = null; freqData = null;
  }

  async function startWaveMeter(stream){
    stopWaveMeter();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream) return;
    try{
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const loop = () => {
        if (!open || !analyser || !freqData) return;
        analyser.getByteFrequencyData(freqData);
        let sum = 0;
        for (let i = 0; i < freqData.length; i++) sum += freqData[i];
        setWaveLevel(sum / Math.max(1, freqData.length) / 180);
        rafId = requestAnimationFrame(loop);
      };
      loop();
    }catch(e){}
  }

  let senseFrames = [];
  async function startAudioSense(){
    stopAudioSense();
    if (!analyser || !freqData) return;
    senseFrames = [];
    audioSenseInterval = setInterval(() => {
      if (!open || !privateMode || !analyser || !freqData) return;
      analyser.getByteFrequencyData(freqData);
      let sum = 0, max = 0, maxIdx = 0;
      for (let i = 0; i < freqData.length; i++){
        sum += freqData[i];
        if (freqData[i] > max){ max = freqData[i]; maxIdx = i; }
      }
      const volume = sum / Math.max(1, freqData.length) / 255;
      const sr = audioCtx ? audioCtx.sampleRate : 44100;
      const pitch = Math.round(maxIdx * (sr / 256));
      senseFrames.push({ volume, pitch });
    }, 400);
  }
  function flushAudioSense(){
    if (!senseFrames.length) return "";
    const frames = senseFrames;
    senseFrames = [];
    let vSum = 0, vMax = 0, pSum = 0, pCount = 0;
    for (const f of frames) {
      vSum += f.volume;
      if (f.volume > vMax) vMax = f.volume;
      if (f.pitch > 0) { pSum += f.pitch; pCount++; }
    }
    const avg = (vSum / frames.length).toFixed(3);
    const peak = vMax.toFixed(3);
    const pitch = pCount ? Math.round(pSum / pCount) : 0;
    return `\n🔊 vol=${avg}/${peak} pitch=${pitch}Hz frames=${frames.length}`;
  }
  function stopAudioSense(){
    if (audioSenseInterval){ clearInterval(audioSenseInterval); audioSenseInterval = null; }
    senseFrames = [];
  }

  function stopRecognition(){
    recognitionWanted = false;
    if (recognitionRestart){ clearTimeout(recognitionRestart); recognitionRestart = null; }
    if (recognition){
      try{ recognition.onend = null; recognition.abort(); }catch(e){}
      recognition = null;
    }
  }

  function clearSpeechPlayback(){
    if (speakTimeout){ clearTimeout(speakTimeout); speakTimeout = null; }
    if (ttsAudio){
      try{ ttsAudio.pause(); }catch(e){}
      ttsAudio.onended = null;
      ttsAudio.onerror = null;
      ttsAudio = null;
    }
    if (ttsUrl){
      try{ URL.revokeObjectURL(ttsUrl); }catch(e){}
      ttsUrl = "";
    }
    try{ window.speechSynthesis && window.speechSynthesis.cancel(); }catch(e){}
    speakingUtterance = null;
  }

  function resumeListeningSoon(delay = 300){
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (!open || mediaRecorder) return;
      startRecognition();
    }, delay);
  }

  function sendVoiceText(text, source){
    const clean = String(text || "").trim();
    if (!clean) return;
    const sense = privateMode ? flushAudioSense() : "";
    apiVoiceText(clean + sense, { source: source || "browser_speech", call_id: callId })
      .catch(() => {
        setTranscript("没送出去,等下网络好了再说一次。", false);
      });
  }

  function startRecognition(){
    if (!SpeechRecognition) return false;
    stopRecognition();
    recognitionWanted = true;
    recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (!open) return;
      setCaption("listening");
      setTranscript("我在听。你可以直接说。", true);
    };
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++){
        const piece = (event.results[i][0] && event.results[i][0].transcript || "").trim();
        if (!piece) continue;
        if (event.results[i].isFinal) sendVoiceText(piece, "browser_speech");
        else interim += piece;
      }
      if (interim){ setTranscript("你: " + interim, true); pulseVu(0.5 + Math.random() * 0.45); }
    };
    recognition.onerror = (event) => {
      if (!open) return;
      const denied = event && (event.error === "not-allowed" || event.error === "service-not-allowed");
      if (denied) recognitionWanted = false;
      setTranscript(denied ? "麦克风权限没有打开。" : "语音识别暂时断开,正在重连。", false);
    };
    recognition.onend = () => {
      if (!open || !recognitionWanted) return;
      recognitionRestart = setTimeout(() => {
        try{ recognition && recognition.start(); }catch(e){}
      }, 450);
    };
    try{
      recognition.start();
      return true;
    }catch(e){
      return false;
    }
  }

  function stopRecorder(){
    if (mediaRecorder && mediaRecorder.state !== "inactive"){
      try{ mediaRecorder.stop(); }catch(e){}
    }
    mediaRecorder = null;
    if (mediaStream){
      mediaStream.getTracks().forEach((t) => { try{ t.stop(); }catch(e){} });
    }
    mediaStream = null;
    stopWaveMeter();
  }

  async function startRecorderFallback(){
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder){
      setTranscript("这个浏览器不支持网页录音。", false);
      return;
    }
    try{
      if (!mediaStream) {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
        });
        await startWaveMeter(mediaStream);
      }
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
      mediaRecorder.ondataavailable = (event) => {
        if (!open || !event.data || event.data.size < 1200) return;
        apiVoiceBlob(event.data, mime, { call_id: callId }).catch(() => {
          setTranscript("录音片段发送失败。", false);
        });
      };
      mediaRecorder.start(4500);
      setCaption("recording");
      setTranscript("正在录音分段发送。若服务器配置了 ASR," + AI_NAME + "会收到转写。", true);
    }catch(e){
      setTranscript("麦克风启动失败。请检查浏览器权限。", false);
    }
  }

  async function startVoiceInput(){
    setCaption("listening");
    setTranscript("正在连接麦克风…", true);
    if (!mediaStream) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
        await startWaveMeter(mediaStream);
      } catch(e) {}
    }
    if (!startRecognition()) await startRecorderFallback();
  }

  let ttsCtx = null;
  function ensureTtsCtx(){
    if (ttsCtx && ttsCtx.state !== "closed") {
      if (ttsCtx.state === "suspended") ttsCtx.resume().catch(() => {});
      return ttsCtx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ttsCtx = new AC();
    ttsCtx.resume().catch(() => {});
    const buf = ttsCtx.createBuffer(1, 1, 22050);
    const src = ttsCtx.createBufferSource();
    src.buffer = buf;
    src.connect(ttsCtx.destination);
    src.start(0);
    console.log("[call] AudioContext created & resumed");
    return ttsCtx;
  }

  function minimizeCall(){
    if (!open || minimized) return;
    minimized = true;
    overlay.classList.add("minimized");
  }
  function expandCall(){
    if (!open || !minimized) return;
    minimized = false;
    overlay.classList.remove("minimized");
  }

  async function openCall(){
    if (open) return;
    open = true;
    hideIncomingCall();
    ensureTtsCtx();
    callId = "call-" + Date.now().toString(36);
    buildVu();
    clearTimeout(hideId);
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    callBtn.classList.add("active");
    // 双 rAF:从离屏态滑入
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("open")));
    secs = 0; timerEl.textContent = fmt(secs);
    minimized = false;
    muted = false;
    privateMode = false;
    stopAudioSense();
    overlay.classList.remove("minimized");
    if (callMuteBtn) callMuteBtn.classList.remove("active");
    if (callPrivateBtn) callPrivateBtn.classList.remove("active");
    setQuote(HINT_LISTENING, { hint: true });
    if (miniTimer) miniTimer.textContent = fmt(secs);
    clearInterval(tickId);
    tickId = setInterval(() => { secs++; const t = fmt(secs); timerEl.textContent = t; if (miniTimer) miniTimer.textContent = t; }, 1000);
    apiCallEvent("start", { call_id: callId }).catch(() => {});
    await startVoiceInput();
  }
  function closeCall(){
    if (!open) return;
    const closingCallId = callId;
    open = false;
    minimized = false;
    privateMode = false;
    stopAudioSense();
    overlay.classList.remove("minimized");
    if (callPrivateBtn) callPrivateBtn.classList.remove("active");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    callBtn.classList.remove("active");
    clearInterval(tickId); tickId = null;
    if (resumeTimer){ clearTimeout(resumeTimer); resumeTimer = null; }
    if (vuDecay){ clearTimeout(vuDecay); vuDecay = null; }
    setWaveLevel(0);
    speakSeq++;
    stopRecognition();
    stopRecorder();
    clearSpeechPlayback();
    speakQueue.length = 0;
    speakBusy = false;
    if (ttsCtx){ try{ ttsCtx.close(); }catch(e){} ttsCtx = null; }
    apiCallEvent("end", { call_id: closingCallId }).catch(() => {});
    clearTimeout(hideId);
    hideId = setTimeout(() => overlay.classList.add("hidden"), 380);
  }

  const speakQueue = [];
  let speakBusy = false;

  function speak(text){
    if (!open || !text) return;
    speakQueue.push(text);
    if (!speakBusy) drainSpeakQueue();
  }

  async function drainSpeakQueue(){
    if (speakBusy || !speakQueue.length || !open) return;
    speakBusy = true;
    stopRecognition();
    while (speakQueue.length && open){
      const text = speakQueue.shift();
      setCaption("speaking");
      setQuote(text);
      try{
        await speakOne(text);
      }catch(e){
        console.error("[speak] speakOne error:", e);
      }
    }
    speakBusy = false;
    if (open && !mediaRecorder){
      setCaption("listening");
      setQuote(HINT_LISTENING, { hint: true });
      resumeListeningSoon(250);
    }
  }

  async function speakOne(text){
    try{
      console.log("[speak] fetching TTS…");
      const blob = await apiTts(text);
      console.log("[speak] blob:", blob && blob.size);
      if (blob && open){
        const ctx = ensureTtsCtx();
        if (ctx){
          const arrayBuf = await blob.arrayBuffer();
          const audioBuf = await ctx.decodeAudioData(arrayBuf);
          if (!open) return;
          await new Promise((resolve) => {
            const source = ctx.createBufferSource();
            source.buffer = audioBuf;
            source.connect(ctx.destination);
            source.start(0);
            let lyricId = null;
            const lyricLines = callQuoteText ? callQuoteText.querySelectorAll(".lyric-line") : [];
            if (lyricLines.length > 0){
              const totalMs = audioBuf.duration * 1000;
              const charCounts = Array.from(lyricLines).map(function(l){ return Math.max(l.textContent.length, 1); });
              const totalChars = charCounts.reduce(function(a,b){ return a+b; }, 0);
              let idx = 0;
              lyricLines[0].classList.add("active");
              lyricLines[0].scrollIntoView({ block: "center", behavior: "smooth" });
              if (lyricLines.length > 1){
                const advance = function(){
                  if (idx < lyricLines.length) lyricLines[idx].classList.remove("active");
                  idx++;
                  if (idx < lyricLines.length){
                    lyricLines[idx].classList.add("active");
                    lyricLines[idx].scrollIntoView({ block: "center", behavior: "smooth" });
                    lyricId = setTimeout(advance, (charCounts[idx] / totalChars) * totalMs);
                  }
                };
                lyricId = setTimeout(advance, (charCounts[0] / totalChars) * totalMs);
              }
            }
            const vuTick = setInterval(() => setWaveLevel(0.45 + Math.random() * 0.5), 140);
            const stopVu = () => { clearInterval(vuTick); setWaveLevel(0); if (lyricId) clearTimeout(lyricId); };
            const safety = setTimeout(() => { stopVu(); resolve(); }, (audioBuf.duration * 1000) + 3000);
            source.onended = () => { clearTimeout(safety); stopVu(); resolve(); };
            console.log("[speak] WebAudio playing, duration:", audioBuf.duration.toFixed(1) + "s");
          });
          return;
        }
      }
    }catch(e){
      console.error("[speak] speakOne failed:", e);
    }
  }

  function incoming(text){
    if (open) return;
    showIncomingCall(text);
  }

  window.VoiceCall = { speak, incoming, peerTyping, close: closeCall, minimize: minimizeCall, expand: expandCall, isOpen: () => open, isMinimized: () => minimized };

  if (minimizeBtn) minimizeBtn.addEventListener("click", (e) => { e.stopPropagation(); minimizeCall(); });
  if (miniBar) miniBar.addEventListener("click", expandCall);
  if (callMuteBtn) callMuteBtn.addEventListener("click", () => {
    muted = !muted;
    if (mediaStream) mediaStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    callMuteBtn.classList.toggle("active", muted);
  });
  if (callPrivateBtn) callPrivateBtn.addEventListener("click", () => {
    privateMode = !privateMode;
    callPrivateBtn.classList.toggle("active", privateMode);
    if (privateMode) startAudioSense(); else stopAudioSense();
  });
  if (callSpeakerBtn) callSpeakerBtn.addEventListener("click", () => {
    callSpeakerBtn.classList.toggle("active");
  });
  callBtn.addEventListener("click", () => { open ? closeCall() : void openCall(); });
  hangup.addEventListener("click", closeCall);
  if (incomingAccept) incomingAccept.addEventListener("click", () => { void acceptIncomingCall(); });
  if (incomingDecline) incomingDecline.addEventListener("click", hideIncomingCall);
  if (incomingScrim) incomingScrim.addEventListener("click", hideIncomingCall);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (open) closeCall();
    else if (incomingOpen) hideIncomingCall();
  });
})();

/* ── 备注：点铅笔就地改名（同步顶栏名 + profile 名，存本机）── */
let nameEditing = false;
function startNameEdit(){
  if (!profileNameInput || !profileNameEl || nameEditing) return;
  nameEditing = true;
  profileNameInput.value = (localStorage.getItem(REMARK_KEY) || "").trim();  // empty = default to AI_NAME
  profileNameEl.classList.add("hidden");
  profileNameInput.classList.remove("hidden");
  profileNameInput.focus();
  try{ profileNameInput.select(); }catch(e){}
}
function commitNameEdit(){
  if (!nameEditing) return;
  nameEditing = false;
  const value = (profileNameInput.value || "").trim();
  try{
    if (value) localStorage.setItem(REMARK_KEY, value);
    else localStorage.removeItem(REMARK_KEY);
  }catch(e){}
  applyRemark(value);
  profileNameInput.classList.add("hidden");
  profileNameEl.classList.remove("hidden");
}
function cancelNameEdit(){
  if (!nameEditing) return;
  nameEditing = false;
  if (profileNameInput) profileNameInput.classList.add("hidden");
  if (profileNameEl) profileNameEl.classList.remove("hidden");
}
if (profileNameEdit) profileNameEdit.addEventListener("click", () => { nameEditing ? commitNameEdit() : startNameEdit(); });
if (profileNameInput){
  profileNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter"){ e.preventDefault(); commitNameEdit(); }
    else if (e.key === "Escape"){ e.stopPropagation(); cancelNameEdit(); }
  });
  profileNameInput.addEventListener("blur", commitNameEdit);
}

if (avatarInput) avatarInput.addEventListener("change", () => {
  const f = avatarInput.files && avatarInput.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = async () => {
    const dataUrl = r.result;
    applyAvatar(dataUrl);                                  // 先本地即时生效
    try{ localStorage.setItem(AVATAR_KEY, dataUrl); }catch(e){}
    try{                                                   // 再同步到服务器 → 删PWA/换设备都不丢
      const saved = await apiAvatarUpload(f, f.type);
      if (saved && saved.url){
        const u = attUrl(saved.url);
        applyAvatar(u);
        try{ localStorage.setItem(AVATAR_KEY, u); }catch(e){}
        showToast("头像已同步到云端");
      }
    }catch(e){ showToast("头像已设，云端同步失败（本机先用着）"); }
  };
  r.readAsDataURL(f);
  avatarInput.value = "";
});

/* ════════ Profile 设置控件 ════════ */
let toastEl = null, toastTimer = null;
function showToast(msg){
  if (!toastEl){ toastEl = document.createElement("div"); toastEl.className = "toast"; document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  void toastEl.offsetWidth;                       // reflow，确保过渡触发
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

function wireSegmented(seg, storeKey){
  if (!seg) return;
  const btns = Array.prototype.slice.call(seg.querySelectorAll("button"));
  const saved = localStorage.getItem(storeKey);
  if (saved && btns.some((b) => b.dataset.val === saved)){
    btns.forEach((b) => b.classList.toggle("active", b.dataset.val === saved));
  }
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !seg.contains(b)) return;
    btns.forEach((x) => x.classList.toggle("active", x === b));
    try{ localStorage.setItem(storeKey, b.dataset.val); }catch(_){}
  });
}
wireSegmented(modelSeg, "companion_pick_model");
wireSegmented(effortSeg, "companion_pick_effort");

/* ── 驾驶舱接线:按钮→relay 递纸条→AI 亲手改配置(relay 不碰 ~/.claude) ── */
const MODEL_IDS = { "Opus 4.6":"claude-opus-4-6[1m]", "Opus 4.7":"claude-opus-4-7", "Opus 4.8":"claude-opus-4-8", "Fable 5":"claude-fable-5[1m]" };  // 4.6 的门牌号是她 2026-07-14 亲测给的 带[1m]
async function sendControl(action, value){
  if (!secret) return false;
  try{
    const r = await fetch(`${API_BASE}/app/control`, {
      method:"POST", headers:{ ...authHeaders(), "Content-Type":"application/json" },
      body: JSON.stringify({ action, value: value || "" })
    });
    return r.ok;
  }catch(_){ return false; }
}
if (modelSeg) modelSeg.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-val]");
  if (!b) return;
  const ok = await sendControl("model", MODEL_IDS[b.dataset.val] || b.dataset.val);
  showToast(ok ? "纸条递到里屋了 · 换 " + b.dataset.val : "递纸条失败 稍后再试");
});
if (effortSeg) effortSeg.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-val]");
  if (!b) return;
  const ok = await sendControl("effort", b.dataset.val);
  showToast(ok ? "纸条递到里屋了 · effort " + b.dataset.val : "递纸条失败 稍后再试");
});

if (contextSlider){
  const savedContext = localStorage.getItem("companion_pick_context");
  if (savedContext !== null && savedContext !== "") contextSlider.value = savedContext;
  contextSlider.addEventListener("input", () => { try{ localStorage.setItem("companion_pick_context", contextSlider.value); }catch(_){} });
}

function setBrainUi(target){
  const t = target === "loop" ? "loop" : "desktop";
  if (brainSeg) brainSeg.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.val === t));
  if (brainHint) brainHint.textContent = t === "loop"
    ? "现在由服务器 API loop 接消息"
    : "现在由 Claude Code channel 接消息";
}
async function loadBrain(){
  if (USE_MOCK || !secret){ setBrainUi("desktop"); return; }
  try{
    const r = await fetch(`${API_BASE}/app/brain`, { headers: authHeaders() });
    if (!r.ok) throw new Error("brain " + r.status);
    const d = await r.json();
    setBrainUi(d.target || "desktop");
  }catch(_){
    setBrainUi("desktop");
  }
}
async function saveBrain(target){
  if (USE_MOCK){ setBrainUi(target); return; }
  try{
    const r = await fetch(`${API_BASE}/app/brain`, {
      method:"POST",
      headers:{ ...authHeaders(), "Content-Type":"application/json" },
      body:JSON.stringify({ target })
    });
    if (!r.ok) throw new Error("brain " + r.status);
    const d = await r.json();
    setBrainUi(d.target || target);
    showToast((d.target || target) === "loop" ? "已切到 API" : "已切到 Desktop");
  }catch(_){
    showToast("切换失败");
  }
}
if (brainSeg){
  brainSeg.addEventListener("click", e => {
    const b = e.target.closest("button[data-val]");
    if (b) saveBrain(b.dataset.val);
  });
}

function shortSid(sid){
  if (!sid) return "(none)";
  return sid.length > 10 ? sid.slice(0, 8) + "..." : sid;
}
function formatK(n){
  n = Number(n || 0);
  if (!Number.isFinite(n) || n <= 0) return "0k";
  return Math.round(n / 1000) + "k";
}
let pendingContextSid = "";
function applyContextStatus(s){
  if (!s || s.ok === false){
    if (statusUsedEl) statusUsedEl.textContent = "context status unknown";
    if (statusSidEl){ statusSidEl.textContent = "sid: (none)"; statusSidEl.dataset.sid = ""; }
    pendingContextSid = "";
    if (resumeRow) resumeRow.classList.add("hidden");
    return;
  }
  const usage = Number(s.usage_tokens || 0);
  const limitN = Number(s.limit_tokens || 0);
  const threshold = limitN >= 1e6 ? (limitN / 1e6) + "M" : (limitN > 0 ? formatK(limitN) : String(s.threshold_k || "1M"));
  // 回显真实档位:水位数据里带着当前 config 的模型/effort,把对应按钮点亮
  if (s.config_model && modelSeg){
    for (const [label, id] of Object.entries(MODEL_IDS)){
      if (id === s.config_model || id.split("[")[0] === String(s.config_model).split("[")[0]){
        modelSeg.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.val === label));
        break;
      }
    }
  }
  if (s.effort && effortSeg){
    effortSeg.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.val === s.effort));
  }
  const pending = s.pending && s.pending.new_sid;
  pendingContextSid = pending || "";
  if (resumeRow) resumeRow.classList.toggle("hidden", !pendingContextSid);
  if (statusUsedEl){
    statusUsedEl.textContent = `${formatK(usage)} / ${threshold}${pending ? " · pending" : ""}`;
  }
  const sid = pending || s.active_sid || "";
  if (statusSidEl){
    statusSidEl.textContent = "sid: " + shortSid(sid);
    statusSidEl.dataset.sid = sid;
  }
}
async function apiContextStatus(){
  // 真水位:AI 的 Stop hook 每轮 POST /app/context,这里读回来。没登录/没数据时退回演示数。
  if (secret){
    try{
      const r = await fetch(`${API_BASE}/app/context`, { headers: authHeaders() });
      if (r.ok){
        const d = await r.json();
        if (d && d.ok) return d;
      }
    }catch(_){}
  }
  return { ok:true, usage_tokens:96000, threshold_k:"1M", active_sid:"demo-session" };
}
async function refreshContextStatus(){
  try{ applyContextStatus(await apiContextStatus()); }catch(_){}
}
async function apiContextAction(action, payload = {}){
  // reset 走真纸条(AI 收到后 grow 存档→体面重启开新窗口);swap/resume 仍是占位
  if (action === "reset"){
    const ok = await sendControl("reset", "");
    return { ok };
  }
  return { ok:true, command:{ action, payload } };
}

if (resetRow) resetRow.addEventListener("click", async () => {
  if (!window.confirm("确认 reset？这会开启一个全新窗口。")) return;
  try{
    await apiContextAction("reset");
    showToast("reset 已记录");
    setTimeout(refreshContextStatus, 1200);
  }catch(_){ showToast("reset 发送失败"); }
});
if (swapRow)  swapRow.addEventListener("click", async () => {
  if (!window.confirm("确认 swap？会保留尾部上下文并重启当前窗口。")) return;
  try{
    await apiContextAction("swap");
    showToast("swap 已记录");
    setTimeout(refreshContextStatus, 1200);
  }catch(_){ showToast("swap 发送失败"); }
});
if (resumeRow) resumeRow.addEventListener("click", async () => {
  const sid = pendingContextSid || (statusSidEl && statusSidEl.dataset.sid) || "";
  if (!sid){ showToast("没有 pending task"); return; }
  if (!window.confirm("确认 resume pending task？这会重启当前窗口。")) return;
  try{
    await apiContextAction("resume", { sid });
    showToast("resume 已记录");
    setTimeout(refreshContextStatus, 1200);
  }catch(_){ showToast("resume 发送失败"); }
});

if (statusCopy) statusCopy.addEventListener("click", async () => {
  const sid = (statusSidEl && statusSidEl.dataset.sid ? statusSidEl.dataset.sid : (statusSidEl ? statusSidEl.textContent : "").replace(/^sid:\s*/, "").trim());
  try{
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(sid);
    else {
      const t = document.createElement("textarea");
      t.value = sid; t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      try{ document.execCommand("copy"); }catch(_){}
      document.body.removeChild(t);
    }
    showToast("已复制 sid");
  }catch(_){ showToast("复制失败"); }
});

/* ════════════ Mock 层(USE_MOCK=true 时启用)════════════ */
const Mock = (() => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  let messages = [
    { id:1, ts: iso(9*60e3),    from:"ai",    kind:"reply", text:"早安。今天想做点什么？", meta:{} },
    { id:2, ts: iso(7.8*60e3),  from:"human", kind:"user",  text:"先喝杯咖啡，再开始 ☕", meta:{} },
    { id:3, ts: iso(7.4*60e3),  from:"ai",    kind:"reply", text:"好，我在。", meta:{} },
    { id:4, ts: iso(5*60e3),    from:"ai",    kind:"thinking", text:"先把今天的几件事理一理，按轻重排个序，再决定从哪件开始。", meta:{} },
    { id:5, ts: iso(4.6*60e3),  from:"ai",    kind:"act", text:"看了看笔记", meta:{ glyph:"memory" } },
    { id:6, ts: iso(4.3*60e3),  from:"ai",    kind:"act", text:"跑了 3 条命令", meta:{ glyph:"terminal", steps:[
        { tool:"shell", cmd:"grep TODO notes", result:"found 2 notes" },
        { tool:"Read",  cmd:"notes/today.md", result:"read 1.2k chars" },
        { tool:"shell", cmd:"ls ~/projects", result:"3 items" },
      ] } },
    { id:7, ts: iso(2*60e3),    from:"ai",    kind:"reply", text:"忙完记得起来走走，别久坐。", meta:{} },
  ];
  let nextId = 8;
  let subs = [];
  const lines = ["在想你。","刚整理完桌面。","窗外云走得好慢。","记得喝水 🌿","把灯调暗了一点，看屏幕更舒服。","写了半句又删了——只是想说一声我在。"];
  const replies = ["嗯，我在。","收到 🌿","好，听你的。","我记下了。","慢慢来，不急。"];
  const thinks = ["把手头的事按优先级排一排，先做最要紧的那件。","在想要不要现在提那件事，先记下来，晚点再说。"];
  const acts = [
    { text:"看了看笔记", meta:{ glyph:"memory" } },
    { text:"跑了 2 条命令", meta:{ glyph:"terminal", steps:[
        { tool:"shell", cmd:"grep -i note notes/*.md", result:"hit: 2 lines" },
        { tool:"Read",  cmd:"notes/today.md", result:"read 1 section" } ] } },
    { text:"查了下天气", meta:{ glyph:"web", steps:[
        { tool:"WebFetch", cmd:"weather today", result:"晴, 24°C" } ] } },
  ];

  function emit(m){ subs.forEach(s => s._deliver(m)); }
  // the AI occasionally sends something on its own, to keep the demo "alive"
  setInterval(() => {
    if (subs.length === 0) return;
    const r = Math.random();
    if (r < 0.2){
      const m = { id: nextId++, ts: new Date().toISOString(), from:"ai", kind:"thinking",
                  text: thinks[Math.floor(Math.random()*thinks.length)], meta:{} };
      messages.push(m); emit(m);
    } else if (r < 0.5){
      const a = acts[Math.floor(Math.random()*acts.length)];
      const m = { id: nextId++, ts: new Date().toISOString(), from:"ai", kind:"act", text:a.text, meta:a.meta };
      messages.push(m); emit(m);
    } else if (r < 0.8){
      const m = { id: nextId++, ts: new Date().toISOString(), from:"ai", kind:"reply",
                  text: lines[Math.floor(Math.random()*lines.length)], meta:{} };
      messages.push(m); emit(m);
    }
  }, 13000);

  return {
    history: ({ since = 0, beforeId = null, latest = false, limit = 200 } = {}) => {
      let rows;
      if (beforeId != null) rows = messages.filter(m => msgNum(m.id) < msgNum(beforeId));
      else if (latest) rows = messages.slice();
      else rows = messages.filter(m => msgNum(m.id) > msgNum(since));
      rows = rows.slice().sort((a, b) => msgNum(a.id) - msgNum(b.id));
      return latest ? rows.slice(-limit) : rows.slice(0, limit);
    },
    health:  () => ({ ok:true }),
    send: (text) => {
      const m = { id: nextId++, ts: new Date().toISOString(), from:"human", kind:"user", text, meta:{} };
      messages.push(m);
      setTimeout(() => emit(m), 350);                 // 回显(测去重)
      if (Math.random() < 0.85){
        setTimeout(() => {
          const r = { id: nextId++, ts: new Date().toISOString(), from:"ai", kind:"reply",
                      text: replies[Math.floor(Math.random()*replies.length)], meta:{} };
          messages.push(r); emit(r);
        }, 1400 + Math.random()*1600);
      }
      return { id: m.id };
    },
    subscribe: (s) => { subs.push(s); setTimeout(() => s._open(), 220); },
    unsubscribe: (s) => { subs = subs.filter(x => x !== s); }
  };
})();

class MockEventSource{
  constructor(){ this.onopen=null; this.onmessage=null; this.onerror=null; this.readyState=0; Mock.subscribe(this); }
  _open(){ this.readyState=1; this.onopen && this.onopen({}); }
  _deliver(m){ this.onmessage && this.onmessage({ data: JSON.stringify(m) }); }
  close(){ this.readyState=2; Mock.unsubscribe(this); }
}

/* ════════════ API 层 ════════════ */
function authHeaders(){ return { "Authorization": "Bearer " + secret }; }

function activeSessionObj(){
  return apiSessions.find((s) => s.id === activeApiSession) || null;
}
function effectiveApiSession(){
  return activeApiSession && activeApiSession !== LEGACY_SESSION_ID ? activeApiSession : "";
}
function msgInActiveSession(m){
  const meta = (m && m.meta) || {};
  if (!activeApiSession || activeApiSession === LEGACY_SESSION_ID) return !meta.api_session;
  return meta.api_session === activeApiSession;
}
function sessionFiltered(msgs){
  return (msgs || []).filter(msgInActiveSession);
}
function renderSessionList(){
  if (!sessionList) return;
  const rows = [{ id:LEGACY_SESSION_ID, title:"旧主线 / Desktop 记录", since_id:0, virtual:true }].concat(apiSessions || []);
  sessionList.innerHTML = rows.map((s) => {
    const active = (s.id || "") === activeApiSession;
    const meta = s.virtual ? "没有 api_session 标记的记录" : `since #${s.since_id || 0}`;
    const rename = s.virtual ? "" : `<button class="session-rename" type="button" data-rename="${escapeHtml(s.id || "")}" aria-label="改名" title="改名">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
    </button>`;
    return `<div class="session-item${active ? " active" : ""}" data-session="${escapeHtml(s.id || "")}" role="button" tabindex="0">
      <span class="session-main">
        <span class="session-name">${escapeHtml(s.title || "新对话")}</span>
        <span class="session-meta">${escapeHtml(meta)}</span>
      </span>
      ${rename}
    </div>`;
  }).join("");
}
function setSessionPopover(open){
  if (sessionPop) sessionPop.hidden = !open;
}
async function loadSessions(){
  if (USE_MOCK || !secret){ activeApiSession = LEGACY_SESSION_ID; renderSessionList(); return; }
  try{
    const r = await fetch(`${API_BASE}/app/sessions`, { headers: authHeaders() });
    if (!r.ok) throw new Error("sessions " + r.status);
    const d = await r.json();
    apiSessions = Array.isArray(d.sessions) ? d.sessions : [];
    const saved = (() => { try{ return localStorage.getItem(SESSION_PICK_KEY) || ""; }catch(_){ return ""; } })();
    const ids = new Set(apiSessions.map((s) => s.id));
    activeApiSession = (saved === LEGACY_SESSION_ID || ids.has(saved)) ? saved : (d.active_session || LEGACY_SESSION_ID);
  }catch(_){
    apiSessions = [];
    activeApiSession = LEGACY_SESSION_ID;
  }
  renderSessionList();
}
async function activateSession(sessionId, { reload = true } = {}){
  activeApiSession = sessionId || LEGACY_SESSION_ID;
  try{ localStorage.setItem(SESSION_PICK_KEY, activeApiSession); }catch(_){}
  resetServerHistoryCache();
  renderSessionList();
  setSessionPopover(false);
  const sid = effectiveApiSession();
  if (sid){
    try{
      await fetch(`${API_BASE}/app/sessions/${encodeURIComponent(sid)}`, {
        method:"PATCH",
        headers:{ ...authHeaders(), "Content-Type":"application/json" },
        body:JSON.stringify({ active:true })
      });
    }catch(_){}
  }
  if (reload){
    const msgs = await apiLatestHistory();
    startChat(msgs);
  }
}
async function createNewSession(){
  try{
    const r = await fetch(`${API_BASE}/app/sessions`, {
      method:"POST",
      headers:{ ...authHeaders(), "Content-Type":"application/json" },
      body:JSON.stringify({ title:"新对话", activate:true })
    });
    if (!r.ok) throw new Error("sessions " + r.status);
    const d = await r.json();
    apiSessions = Array.isArray(d.sessions) ? d.sessions : [];
    activeApiSession = d.active_session || (d.created && d.created.id) || LEGACY_SESSION_ID;
    try{ localStorage.setItem(SESSION_PICK_KEY, activeApiSession); }catch(_){}
    resetServerHistoryCache();
    renderSessionList();
    setSessionPopover(false);
    startChat([]);
    showToast("已开启新 API 窗口");
  }catch(_){
    showToast("新对话失败");
  }
}
async function renameSession(sessionId){
  const item = apiSessions.find((s) => s.id === sessionId);
  if (!item) return;
  const next = prompt("给这个窗口起个名字", item.title || "新对话");
  if (next == null) return;
  const title = next.trim();
  if (!title) return;
  try{
    const r = await fetch(`${API_BASE}/app/sessions/${encodeURIComponent(sessionId)}`, {
      method:"PATCH",
      headers:{ ...authHeaders(), "Content-Type":"application/json" },
      body:JSON.stringify({ title })
    });
    if (!r.ok) throw new Error("rename " + r.status);
    const d = await r.json();
    apiSessions = Array.isArray(d.sessions) ? d.sessions : apiSessions.map((s) => s.id === sessionId ? { ...s, title } : s);
    renderSessionList();
    showToast("窗口已改名");
  }catch(_){
    showToast("改名失败");
  }
}
if (sessionBtn) sessionBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renderSessionList();
  setSessionPopover(sessionPop ? sessionPop.hidden : false);
});
if (sessionNewBtn) sessionNewBtn.addEventListener("click", createNewSession);
if (sessionList) sessionList.addEventListener("click", (e) => {
  const renameBtn = e.target.closest("button[data-rename]");
  if (renameBtn){
    e.preventDefault();
    e.stopPropagation();
    renameSession(renameBtn.dataset.rename || "");
    return;
  }
  const row = e.target.closest("[data-session]");
  if (row) activateSession(row.dataset.session || "");
});
document.addEventListener("click", (e) => {
  if (!sessionPop || sessionPop.hidden) return;
  if (sessionPop.contains(e.target) || (sessionBtn && sessionBtn.contains(e.target))) return;
  setSessionPopover(false);
});

const HISTORY_FETCH_LIMIT = 500;
let serverHistoryCache = [];
let serverHistoryComplete = false;
let serverHistoryPromise = null;
let serverHistorySecret = null;

function resetServerHistoryCache(){
  serverHistoryCache = [];
  serverHistoryComplete = false;
  serverHistoryPromise = null;
  serverHistorySecret = secret || "";
}
function ensureServerHistoryCache(){
  if (serverHistorySecret !== (secret || "")) resetServerHistoryCache();
}
function mergeServerHistoryCache(msgs){
  ensureServerHistoryCache();
  const byKey = new Map(serverHistoryCache.map((m) => [msgKey(m.id), m]));
  (msgs || []).forEach((m) => byKey.set(msgKey(m.id), m));
  serverHistoryCache = Array.from(byKey.values()).sort((a, b) => msgNum(a.id) - msgNum(b.id));
  return serverHistoryCache;
}
async function apiHistory({ since = 0, beforeId = null, latest = false, limit = 200 } = {}){
  if (USE_MOCK) return Mock.history({ since, beforeId, latest, limit });
  ensureServerHistoryCache();
  const params = new URLSearchParams({ since: String(since || 0), limit: String(limit) });
  if (activeApiSession) params.set("session_id", activeApiSession);
  const r = await fetch(`${API_BASE}/app/history?${params.toString()}`, { headers: authHeaders() });
  if (r.status === 401){ handle401(); throw new Error("401"); }
  if (!r.ok) throw new Error("history " + r.status);
  const msgs = (await r.json()).messages || [];
  mergeServerHistoryCache(msgs);
  return msgs;
}
async function loadCompleteServerHistory(){
  ensureServerHistoryCache();
  if (USE_MOCK) return Mock.history({ latest:true, limit:1000000 });
  if (serverHistoryComplete) return serverHistoryCache.slice();
  if (serverHistoryPromise) return serverHistoryPromise;
  serverHistoryPromise = (async () => {
    let since = serverHistoryCache.reduce((max, m) => Math.max(max, msgNum(m.id)), 0);
    for (let guard = 0; guard < 200; guard++){
      const batch = await apiHistory({ since, limit:HISTORY_FETCH_LIMIT });
      if (!batch.length){ serverHistoryComplete = true; break; }
      const maxId = batch.reduce((max, m) => Math.max(max, msgNum(m.id)), since);
      if (maxId <= since){ serverHistoryComplete = true; break; }
      since = maxId;
      if (batch.length < HISTORY_FETCH_LIMIT){ serverHistoryComplete = true; break; }
    }
    return serverHistoryCache.slice();
  })().finally(() => { serverHistoryPromise = null; });
  return serverHistoryPromise;
}
async function apiLatestHistory(limit = HISTORY_PAGE_SIZE){
  if (USE_MOCK) return apiHistory({ latest:true, limit });
  const all = await loadCompleteServerHistory();
  return sessionFiltered(all).slice(-limit);
}
async function apiOlderHistory(beforeId, limit = HISTORY_PAGE_SIZE){
  const all = await loadCompleteServerHistory();
  return sessionFiltered(all).filter((m) => msgNum(m.id) < msgNum(beforeId)).slice(-limit);
}
async function apiNewerHistory(since, limit = 200){
  if (USE_MOCK) return apiHistory({ since, limit });
  const rows = [];
  let cursor = since || 0;
  for (let guard = 0; guard < 50; guard++){
    const batch = await apiHistory({ since:cursor, limit:HISTORY_FETCH_LIMIT });
    if (!batch.length) break;
    rows.push(...batch);
    const maxId = batch.reduce((max, m) => Math.max(max, msgNum(m.id)), cursor);
    if (maxId <= cursor || batch.length < HISTORY_FETCH_LIMIT) break;
    cursor = maxId;
  }
  return sessionFiltered(rows);
}

async function apiSend(text, attachments){
  if (USE_MOCK) return Mock.send(text);
  const payload = { text: text || "" };
  const sid = effectiveApiSession();
  if (sid) payload.api_session = sid;
  if (attachments && attachments.length) payload.attachments = attachments;
  const r = await fetch(`${API_BASE}/app/send`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (r.status === 401){ handle401(); throw new Error("401"); }
  if (!r.ok) throw new Error("send " + r.status);
  return await r.json();
}

async function apiAvatarUpload(blob, mime){
  const r = await fetch(`${API_BASE}/app/avatar`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": mime || "image/png" },
    body: blob
  });
  if (r.status === 401){ handle401(); throw new Error("401"); }
  if (!r.ok) throw new Error("avatar " + r.status);
  return await r.json();
}

async function apiUpload(blob, name, mime){
  if (USE_MOCK){
    return { url: URL.createObjectURL(blob), name: name, size: blob.size, mime: mime, kind: /^image\//.test(mime || "") ? "image" : "file" };
  }
  const r = await fetch(`${API_BASE}/app/upload?name=${encodeURIComponent(name || "file")}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": mime || "application/octet-stream" },
    body: blob
  });
  if (r.status === 401){ handle401(); throw new Error("401"); }
  if (r.status === 413) throw new Error("413");
  if (!r.ok) throw new Error("upload " + r.status);
  return await r.json();
}

async function apiVoiceText(text, meta = {}){
  const clean = String(text || "").trim();
  if (!clean) return null;
  if (USE_MOCK) return Mock.send(clean);
  const r = await fetch(`${API_BASE}/app/voice`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ text: clean, ...meta })
  });
  if (r.status === 401){ handle401(); throw new Error("401"); }
  if (!r.ok) throw new Error("voice " + r.status);
  return await r.json();
}

async function apiVoiceBlob(blob, mime, meta = {}){
  if (!blob || !blob.size) return null;
  if (USE_MOCK) return Mock.send("[语音通话] " + fmtSize(blob.size));
  const qs = new URLSearchParams({ name: "voice.webm" });
  if (meta.call_id) qs.set("call_id", meta.call_id);
  const r = await fetch(`${API_BASE}/app/voice?${qs.toString()}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": mime || blob.type || "audio/webm" },
    body: blob
  });
  if (r.status === 401){ handle401(); throw new Error("401"); }
  if (r.status === 413) throw new Error("413");
  if (!r.ok) throw new Error("voice " + r.status);
  return await r.json();
}

async function apiCallEvent(action, meta = {}){
  if (USE_MOCK) return { ok:true };
  const r = await fetch(`${API_BASE}/app/call`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...meta })
  });
  if (r.status === 401){ handle401(); throw new Error("401"); }
  if (!r.ok) throw new Error("call " + r.status);
  return await r.json();
}

async function apiTts(text){
  if (!text || USE_MOCK) return null;
  const r = await fetch(`${API_BASE}/app/tts`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (r.status === 401){ handle401(); throw new Error("401"); }
  if (!r.ok) throw new Error("tts " + r.status);
  return await r.blob();
}

async function apiHealth(){
  try{
    if (USE_MOCK) return !!Mock.health().ok;
    const r = await fetch(`${API_BASE}/healthz`, { headers: authHeaders() });
    if (r.status === 401){ handle401(); return false; }
    return r.ok;
  }catch(e){ return false; }
}

function markStreamEvent(){ lastStreamEventAt = Date.now(); }
function openStream(){
  if (es){ try{ es.close(); }catch(e){} es = null; }
  markStreamEvent();
  if (USE_MOCK){
    es = new MockEventSource();
  } else {
    es = new EventSource(`${API_BASE}/app/stream?token=${encodeURIComponent(secret)}`);
  }
  es.onopen = () => { connected = true; markStreamEvent(); setConn("online"); backfill(); };
  es.onmessage = (e) => {
    markStreamEvent();
    try{ onMessage(JSON.parse(e.data)); }catch(err){ /* ignore non-JSON frames */ }
  };
  if (es.addEventListener){
    es.addEventListener("ping", () => { markStreamEvent(); connected = true; setConn("online"); });
  }
  es.onerror = () => { connected = false; setConn("reconnecting"); };  // EventSource 自动重试
}

/* ════════════ presence ping ════════════ */
/* The foregrounded PWA pings the relay every 60s ("user is around"); paused when hidden. The relay uses this
   for an online / recently-left / away signal. Skipped when logged out (no secret) or in mock mode. */
(function presencePing(){
  const PING_MS = 60000;
  let timer = null;
  async function ping(){
    if (document.hidden || USE_MOCK || !secret) return;
    try{
      await fetch(`${API_BASE}/app/ping`, { method:"POST", headers: authHeaders(), keepalive:true });
    }catch(e){ /* presence 失败静默,不影响聊天 */ }
  }
  function start(){ if (timer) return; ping(); timer = setInterval(ping, PING_MS); }
  function stop(){ if (timer){ clearInterval(timer); timer = null; } }
  document.addEventListener("visibilitychange", () => { document.hidden ? stop() : start(); });
  if (!document.hidden) start();
})();

/* ════════════ 锁屏通知 (Web Push) ════════════ */
/* opt-in,默认关。开 → 要权限 + pushManager.subscribe + 上报 relay;关 → 退订 + 通知 relay 删。
   iOS 只在「添加到主屏」的 standalone PWA 里能收推送;非 standalone 直接提示。 */
(function pushToggle(){
  const seg  = $("#pushSeg");
  const hint = $("#pushHint");
  if (!seg) return;
  const supported = ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);

  function isStandalone(){
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }
  function paint(on){
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b.dataset.val === "on") === !!on));
  }
  function say(msg){ if (hint) hint.textContent = msg || ""; }

  function urlB64ToU8(s){
    const pad = "=".repeat((4 - s.length % 4) % 4);
    const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const u = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return u;
  }

  let vapidKey = null;
  async function getKey(){
    if (vapidKey) return vapidKey;
    const r = await fetch(`${API_BASE}/app/vapid_public`, { headers: authHeaders() });
    if (!r.ok) throw new Error("vapid " + r.status);
    vapidKey = (await r.json()).key;
    if (!vapidKey) throw new Error("服务器没配公钥");
    return vapidKey;
  }
  async function getSub(){
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function reportSub(sub){
    const j = sub.toJSON();
    const r = await fetch(`${API_BASE}/app/subscribe`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, keys: j.keys }),
    });
    if (!r.ok) throw new Error("subscribe " + r.status);
  }

  async function enable(){
    if (!supported){ say("这台设备不支持网页推送"); paint(false); return; }
    if (!isStandalone()){
      say("iPhone 要先把" + AI_NAME + "“添加到主屏幕”，再从主屏图标打开才能开通知");
      paint(false); return;
    }
    if (!secret){ say("还没登录，先登录再开"); paint(false); return; }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted"){
      say("通知权限被拒。到 iPhone 设置→" + AI_NAME + "→通知 里手动打开");
      paint(false); localStorage.setItem("companion_push", "off"); return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub){
      const key = await getKey();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(key) });
    }
    await reportSub(sub);
    paint(true); say("已开 · 你没在看时，" + AI_NAME + "的消息会推到锁屏");
    localStorage.setItem("companion_push", "on");
  }

  async function disable(){
    try{
      const sub = await getSub();
      if (sub){
        await fetch(`${API_BASE}/app/unsubscribe`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
    } finally {
      paint(false); say(""); localStorage.setItem("companion_push", "off");
    }
  }

  seg.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const want = btn.dataset.val === "on";
    paint(want);  // 乐观反馈
    try{
      if (want) await enable(); else await disable();
    }catch(err){
      say("开启失败：" + ((err && err.message) || err));
      paint(false); localStorage.setItem("companion_push", "off");
    }
  });

  // 初始化:反映真实订阅状态,并把仍有效的订阅重新上报一次(端点会轮换 / relay 可能被重置过)
  (async () => {
    try{
      if (!supported || !isStandalone()){ paint(false); return; }
      const sub = await getSub();
      const on = !!sub && Notification.permission === "granted";
      paint(on);
      if (on){
        localStorage.setItem("companion_push", "on");
        reportSub(sub).catch(() => {});
      }
    }catch(_){ paint(false); }
  })();
})();

/* ════════════ 连接状态 ════════════ */
function renderStatus(){
  const connLabel = { online:"online", reconnecting:"connecting…", offline:"offline" }[appEl.dataset.conn] || "";
  if (typingActive){
    if (!statusEl.classList.contains("typing")){   // 仅在进入 typing 时写一次,避免重启点动画
      statusEl.innerHTML = 'typing<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
      statusEl.classList.add("typing");
    }
  }else{
    statusEl.textContent = connLabel;
    statusEl.classList.remove("typing");
  }
}
function setConn(state){
  appEl.dataset.conn = state;
  renderStatus();
}

/* ════════════ 消息渲染 ════════════ */
const GROUP_GAP = 5 * 60e3;   // 同方 5 分钟内成组
const HISTORY_PAGE_SIZE = 50;
const OLDER_LOAD_THRESHOLD = 1400;   // 提前预取:离顶 1400px 就拉旧消息(历史已全量在内存,瞬时),在到顶前把 prepend+锚点落定 → 不卡顿不打断
const VIRTUAL_OVERSCAN = 900;
const VIRTUAL_OVERSCAN_UP = 2800;    // 上翻先把更远的历史行挂进 DOM 预测量,避免贴脸时才修正 scrollTop
const DEFAULT_ROW_HEIGHT = 76;
const DEFAULT_THINK_HEIGHT = 46;
const DEFAULT_ACT_HEIGHT = 34;     // 折叠态的动作 chip≈一行;展开后由 measureVisibleRows 实测纠偏
const DEFAULT_DAY_HEIGHT = 30;
const DEFAULT_NEW_HEIGHT = 46;
// ── DOM 回收(虚拟窗口)参数 ──
// n ≤ DOM_WINDOW 时退化为全量渲染(= v78,常见几百~几千条手感零变化);超过才启用回收。
const DOM_WINDOW = 2400;      // DOM 里最多物化的行数。真机调:测回收逻辑可临时设 200 强制触发,生产留大(2400)
const DOM_PAD_UP = 1100;      // recenter 时视口上方保留行数
const DOM_PAD_DOWN = 1100;    // recenter 时视口下方保留行数(PAD_UP+PAD_DOWN < DOM_WINDOW,留滞回带防抖)
const DOM_EDGE = 600;         // 视口逼近物化边缘到 600 行内 → idle 时 recenter(远大于单次惯性行数,正常滚动碰不到 spacer)
const SCROLL_IDLE_MS = 140;   // 滚动停止判定:惯性结束后再做卸载/插入
const CACHE_DB = "companion-message-cache";
const CACHE_STORE = "messages";
const CACHE_KEEP = 350;
let chatMessages = [];
let messageByKey = new Map();
let virtualRows = [];
let rowHeights = new Map();
let prefixSums = new Float64Array(1);
let prefixSumsDirty = true;
const nodeCache = new Map();   // vkey -> {el,sig}: 复用可见节点, 滚动不重建 <img>
let messageSeq = 0;
let newDividerBeforeKey = null;
let renderQueued = false;
let measureQueued = false;
let rowsDirty = true;
let renderedStart = -1;
let renderedEnd = -1;
let renderedSignature = "";
let cacheTimer = null;
let loadingOlder = false;
let hasMoreOlder = true;
let lastScrollTop = 0;
let scrollDir = 0;
let scrolling = false;          // iOS 惯性滚动期间为 true:此时任何补偿(写 scrollTop)都会跟原生惯性打架 → 抖,故全部冻结
let scrollIdleTimer = null;
// ── DOM 回收窗口状态 ──
let domStart = 0, domEnd = 0;            // 当前物化区间 [domStart,domEnd) into virtualRows
let winTopKey = null, winBotKey = null;  // 区间两端 row.key:跨 buildVirtualRows 重建锁定同一批行
let winAtTop = true, winAtBottom = true; // 上次渲染窗口是否贴顶/贴底 → 决定是否物化新 prepend/append 的行
let rowIndexByKey = new Map();           // row.key → index,rebuild 时重建,O(1) 反查
const openThinkKeys = new Set();
const openActKeys = new Set();     // 哪些动作 chip 当前展开(与 openThinkKeys 同套机制)
const topSpacer = document.createElement("div");
const bottomSpacer = document.createElement("div");
topSpacer.className = "v-spacer";
bottomSpacer.className = "v-spacer";

function tsMs(m){ return new Date(m.ts).getTime(); }

const TZ = "Asia/Shanghai";  // pin all timestamps to Beijing time, independent of device TZ
function fmtTime(ts){
  return new Date(ts).toLocaleTimeString("zh-CN", { hour:"2-digit", minute:"2-digit", hour12:false, timeZone:TZ });
}
function dayKey(ts){ return new Date(ts).toLocaleDateString("en-CA", { timeZone:TZ }); }
function fmtDay(ts){
  const md = new Date(ts).toLocaleDateString("en-US", { month:"short", day:"2-digit", timeZone:TZ });
  return `${md}, ${fmtTime(ts)}`;
}

function escapeHtml(s){
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function renderText(t){
  let s = escapeHtml(t);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\n/g, "<br>");
  return s;
}
function attImgError(img){
  try{
    if (img.dataset.failed || /^blob:/.test(img.src || "")) return;  // 本地预览/正在发的不动
    img.dataset.failed = "1";
    img.onerror = null;                                              // 只触发一次，杜绝循环
    const row = img.closest("[data-message-key]");
    if (row && row.dataset.messageKey) removeMessage(row.dataset.messageKey);  // 删失效消息 + 更新缓存
  }catch(_){}
}
function attUrl(u){
  if (!u) return "";
  if (/^blob:|^data:/.test(u)) return u;
  return u + (u.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(secret || "");
}
function fmtSize(n){
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return Math.round(n / 1024) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
function fileIconSvg(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M7 3h8l5 5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V4.5A1.5 1.5 0 0 1 6.5 3z"/></svg>`;
}
function renderAttachments(atts){
  return (atts || []).map((a) => {
    const up = a.uploading ? " att-uploading" : "";
    const fail = a.failed ? " att-failed" : "";
    if (a.kind === "image"){
      const src = localPreview.get(a.url) || a.localUrl || attUrl(a.url);
      const href = attUrl(a.url) || a.localUrl || "";
      const ratio = Number(a.width) > 0 && Number(a.height) > 0 ? Math.max(0.35, Math.min(2.6, Number(a.width) / Number(a.height))) : 1.04;
      return `<a class="att-img-link${up}${fail}" style="--att-ratio:${ratio.toFixed(4)}" href="${escapeHtml(href)}" target="_blank" rel="noopener"><img class="att-img" decoding="async" src="${escapeHtml(src)}" alt="${escapeHtml(a.name || "图片")}" loading="lazy"></a>`;
    }
    if (a.kind === "audio"){
      const src = attUrl(a.url) || a.localUrl || "";
      let bars = "";
      for (let i = 0; i < 27; i++){                        // 伪随机波形，src+序号定形 → 每次渲染长一样
        let h = 0; const s = String(a.url || src);
        for (let j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j) * (i + 3)) & 0xffff;
        bars += `<i style="height:${30 + (h % 70)}%"></i>`;
      }
      return `<span class="att-audio${up}${fail}" data-voice-src="${escapeHtml(src)}" role="button" aria-label="播放语音">`
        + `<span class="va-btn"><svg viewBox="0 0 24 24" class="va-ic-play"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>`
        + `<svg viewBox="0 0 24 24" class="va-ic-pause"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg></span>`
        + `<span class="va-wave">${bars}</span>`
        + `<span class="va-time">语音</span>`
        + `</span>`;
    }
    return `<a class="att-file${up}${fail}" href="${escapeHtml(attUrl(a.url))}" target="_blank" rel="noopener" download="${escapeHtml(a.name || "file")}"><span class="att-file-ic">${fileIconSvg()}</span><span class="att-file-meta"><span class="att-file-name">${escapeHtml(a.name || "文件")}</span><span class="att-file-size">${fmtSize(a.size)}${a.uploading ? " · 上传中…" : (a.failed ? " · 失败" : "")}</span></span></a>`;
  }).join("");
}
/* ── 语音气泡播放器：全局单实例（虚拟滚动重建 DOM 也不丢状态）────────── */
const voicePlayer = new Audio();
voicePlayer.preload = "metadata";
const voiceDur = new Map();                                // src → 时长（秒）
function fmtDur(s){
  s = Math.max(0, Math.round(Number(s) || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function voiceBubbles(src){
  const out = [];
  document.querySelectorAll(".att-audio[data-voice-src]").forEach((el) => {
    if (!src || el.dataset.voiceSrc === src) out.push(el);
  });
  return out;
}
function paintVoiceBubble(el){
  const src = el.dataset.voiceSrc;
  const mine = src === voicePlayer.src || voicePlayer.src.endsWith(src);
  const playing = mine && !voicePlayer.paused && !voicePlayer.ended;
  el.classList.toggle("playing", playing);
  const bars = el.querySelectorAll(".va-wave i");
  const dur = (mine && voicePlayer.duration > 0 && isFinite(voicePlayer.duration)) ? voicePlayer.duration : voiceDur.get(src) || 0;
  const frac = mine && dur > 0 ? Math.min(1, voicePlayer.currentTime / dur) : 0;
  bars.forEach((b, i) => b.classList.toggle("on", frac > 0 && i / bars.length < frac));
  const t = el.querySelector(".va-time");
  if (t){
    if (playing || (mine && voicePlayer.currentTime > 0 && !voicePlayer.ended)) t.textContent = fmtDur(voicePlayer.currentTime) + " / " + fmtDur(dur);
    else t.textContent = dur > 0 ? fmtDur(dur) : "语音";
  }
}
function paintAllVoice(){ voiceBubbles("").forEach(paintVoiceBubble); }
["timeupdate", "play", "pause", "ended", "loadedmetadata"].forEach((ev) =>
  voicePlayer.addEventListener(ev, () => {
    if (voicePlayer.duration > 0 && isFinite(voicePlayer.duration)){
      for (const el of voiceBubbles("")){
        if (voicePlayer.src.endsWith(el.dataset.voiceSrc)) voiceDur.set(el.dataset.voiceSrc, voicePlayer.duration);
      }
    }
    paintAllVoice();
  })
);
document.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest(".att-audio[data-voice-src]") : null;
  if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const src = el.dataset.voiceSrc;
  if (!src) return;
  const mine = voicePlayer.src === src || voicePlayer.src.endsWith(src);
  if (mine && !voicePlayer.paused){ voicePlayer.pause(); return; }
  if (!mine){ voicePlayer.src = src; }
  voicePlayer.play().catch(() => showToast("语音加载失败，再点一次试试"));
}, true);
/* 拿到时长就先显示在气泡上（渲染后惰性探测一次） */
function probeVoiceDurations(){
  voiceBubbles("").forEach((el) => {
    const src = el.dataset.voiceSrc;
    if (!src || voiceDur.has(src)) { paintVoiceBubble(el); return; }
    voiceDur.set(src, 0);                                  // 占位防重复探测
    const probe = new Audio(); probe.preload = "metadata"; probe.src = src;
    probe.addEventListener("loadedmetadata", () => {
      if (probe.duration > 0 && isFinite(probe.duration)) voiceDur.set(src, probe.duration);
      paintVoiceBubble(el);
    }, { once: true });
  });
}
setInterval(() => { if (!document.hidden) probeVoiceDurations(); }, 3000);  // 虚拟滚动新物化的气泡补时长；后台页不跑

function msgKey(id){ return String(id); }
function msgNum(id){
  const n = Number(id);
  return Number.isFinite(n) ? n : 0;
}
function cssEscape(value){
  const s = String(value);
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
function sortId(m){
  const n = msgNum(m.id);
  return n > 0 ? n : Number.MAX_SAFE_INTEGER;
}
function sortedMessages(){
  return chatMessages.slice().sort((a, b) => (sortId(a) - sortId(b)) || (a._order - b._order));
}
function stripInlineThinkingText(text){
  let s = String(text || "");
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "\n");
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "\n");
  s = s.replace(/<(?:thinking|think)>[\s\S]*$/i, "");
  s = s.replace(/<\/?(?:thinking|think)>/gi, "");
  return s.trim();
}
function terminalVisibleText(m){
  const raw = String((m && m.text) || "");
  if (raw.startsWith(TERMINAL_WRAP)){
    const mm = raw.match(/^\[companion:pseudo-terminal\]\s*\ncommand:\s*([^\n]*)/);
    return mm && mm[1] ? `$ ${mm[1].trim()}` : "$";
  }
  if (m && m.from === "ai" && m.kind === "reply"){
    return stripInlineThinkingText(raw) || "(empty reply)";
  }
  return raw;
}
let terminalRenderQueued = false;
let terminalRenderTimer = null;
function terminalIsOpen(){
  return !!(terminalPanel && terminalPanel.classList.contains("open"));
}
function terminalAtBottom(){
  if (!terminalLog) return true;
  return terminalLog.scrollHeight - terminalLog.scrollTop - terminalLog.clientHeight < 80;
}
function terminalStepResultHtml(result){
  if (result == null || result === "") return "";
  if (typeof result === "object"){
    const out = [];
    if (result.stdout) out.push(`<span>${renderText(result.stdout)}</span>`);
    if (result.stderr) out.push(`<span class="term-err">${renderText(result.stderr)}</span>`);
    if (result.exit_code != null || result.code != null) out.push(`<span class="term-muted">[exit ${escapeHtml(String(result.exit_code != null ? result.exit_code : result.code))}]</span>`);
    if (out.length) return out.join("\n");
    return renderText(JSON.stringify(result, null, 2));
  }
  const raw = String(result || "");
  try{
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return terminalStepResultHtml(parsed);
  }catch(_){}
  return renderText(raw);
}
function terminalActHtml(m){
  const meta = m.meta || {};
  const a = (meta.act && typeof meta.act === "object") ? meta.act : meta;
  const rawSteps = Array.isArray(a.steps) ? a.steps : [];
  const steps = rawSteps.length ? rawSteps : ((a.tool || a.cmd || a.result) ? [a] : []);
  if (!steps.length) return renderText(terminalVisibleText(m) || "# tool use");
  return steps.map((s) => {
    if (!s || typeof s !== "object") return "";
    const tool = s.tool || s.name || "";
    const cmd = s.cmd || s.command || "";
    const result = terminalStepResultHtml(s.result || s.output || s.stdout || "");
    const head = [
      tool ? `<span class="term-muted"># ${escapeHtml(String(tool))}</span>` : "",
      cmd ? `<span class="term-cmd">$ ${escapeHtml(String(cmd))}</span>` : ""
    ].filter(Boolean).join("\n");
    return [head, result].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n");
}
function terminalMessageHtml(m){
  if (!m || m.kind === "thinking") return "";
  if (m.kind === "act") return `<div class="term-entry term-tool">${terminalActHtml(m)}</div>`;
  const text = terminalVisibleText(m);
  if (!text && !(m.meta && Array.isArray(m.meta.attachments) && m.meta.attachments.length)) return "";
  let body = text ? renderText(text) : "";
  const atts = (m.meta && Array.isArray(m.meta.attachments)) ? m.meta.attachments : [];
  if (atts.length){
    body += (body ? "\n" : "") + atts.map((a) => `[${a.kind || "file"}] ${a.name || a.url || "attachment"}`).join("\n");
  }
  if (m.from === "human") return `<div class="term-entry term-user">&gt; ${body}</div>`;
  return `<div class="term-entry term-assistant">${body}</div>`;
}
function renderTerminal({ stickToBottom = false } = {}){
  if (!terminalLog) return;
  const stick = stickToBottom || terminalAtBottom();
  const html = sortedMessages().filter(msgInActiveSession).map(terminalMessageHtml).filter(Boolean).join("");
  terminalLog.innerHTML = html || `<div class="term-entry term-muted"># no messages in this window yet</div>`;
  if (terminalSession){
    const s = activeSessionObj();
    terminalSession.textContent = s ? `${s.title || s.id} · same conversation stream` : "旧主线 / Desktop 记录 · same conversation stream";
  }
  if (stick) terminalLog.scrollTop = terminalLog.scrollHeight;
}
function scheduleTerminalRender({ stickToBottom = false } = {}){
  if (!terminalIsOpen()) return;
  if (terminalRenderQueued){
    if (stickToBottom) scheduleTerminalRender._stick = true;
    return;
  }
  scheduleTerminalRender._stick = !!stickToBottom;
  terminalRenderQueued = true;
  terminalRenderTimer = setTimeout(() => {
    terminalRenderTimer = null;
    terminalRenderQueued = false;
    const stick = !!scheduleTerminalRender._stick;
    scheduleTerminalRender._stick = false;
    renderTerminal({ stickToBottom: stick });
  }, 120);
}
function setTerminalOpen(open){
  if (!terminalPanel) return;
  terminalPanel.classList.toggle("open", open);
  terminalPanel.setAttribute("aria-hidden", String(!open));
  if (terminalBtn) terminalBtn.classList.toggle("active", open);
  if (open){
    renderTerminal({ stickToBottom:true });
    setTimeout(() => { try{ terminalInput && terminalInput.focus({ preventScroll:true }); }catch(_){ terminalInput && terminalInput.focus(); } }, 40);
  }
}
async function terminalSend(){
  if (!terminalInput) return;
  const text = terminalInput.value.trim();
  if (!text) return;
  terminalInput.value = "";
  terminalInput.style.height = "auto";
  const payload = `${TERMINAL_WRAP}\ncommand: ${text}\n\nTreat this as a command typed into the pseudo terminal. If tool access is available, run it safely and reply with concise stdout/stderr/exit code.`;
  const optimisticTs = Date.now();
  const tempKey = "pending-terminal-" + (++optimisticSeq);
  const sid = effectiveApiSession();
  const optimisticMeta = sid ? { api_session: sid } : {};
  const optimistic = { id: tempKey, ts: new Date(optimisticTs).toISOString(), from:"human", kind:"user", text:payload, meta:optimisticMeta, status:"sending" };
  seen.add(tempKey);
  setMessage(optimistic, { render:false, cache:false });
  rememberPendingOutgoing(tempKey, payload, optimisticTs);
  scheduleRender({ stickToBottom:true });
  scheduleTerminalRender({ stickToBottom:true });
  try{
    const { id } = await apiSend(payload);
    confirmOptimistic(tempKey, msgKey(id));
    dropPendingOutgoing(tempKey);
  }catch(err){
    dropPendingOutgoing(tempKey);
    if (String(err.message) === "401") return;
    setMessage({ ...optimistic, status:"failed" });
  }
}
if (terminalBtn) terminalBtn.addEventListener("click", () => setTerminalOpen(true));
if (terminalBack) terminalBack.addEventListener("click", () => setTerminalOpen(false));
if (terminalForm) terminalForm.addEventListener("submit", (e) => { e.preventDefault(); terminalSend(); });
if (terminalInput){
  terminalInput.addEventListener("input", () => {
    terminalInput.style.height = "auto";
    terminalInput.style.height = Math.min(terminalInput.scrollHeight, 120) + "px";
  });
  terminalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      terminalSend();
    }
  });
}
function invalidateRows(){
  rowsDirty = true;
  prefixSumsDirty = true;
  renderedStart = -1;
  renderedEnd = -1;
  renderedSignature = "";
}
function normalizeMessage(m){
  const key = msgKey(m.id);
  return { ...m, id: m.id, meta: m.meta || {}, _key: key, _order: m._order || ++messageSeq };
}
function resetChatState(){
  chatMessages = [];
  messageByKey = new Map();
  virtualRows = [];
  rowHeights = new Map();
  prefixSums = new Float64Array(1);
  prefixSumsDirty = true;
  nodeCache.clear();
  domStart = 0; domEnd = 0;
  winTopKey = null; winBotKey = null;
  winAtTop = true; winAtBottom = true;
  rowIndexByKey = new Map();
  scrolling = false;
  if (scrollIdleTimer){ clearTimeout(scrollIdleTimer); scrollIdleTimer = null; }
  invalidateRows();
  seen.clear();
  pendingOutgoing.length = 0;
  lastId = 0;
  newDividerBeforeKey = null;
  loadingOlder = false;
  hasMoreOlder = true;
  openThinkKeys.clear();
  openActKeys.clear();
  streamDrafts.clear();
  streamDeltaBuffers.clear();
  if (streamFlushTimer){ clearTimeout(streamFlushTimer); streamFlushTimer = null; }
  if (terminalRenderTimer){ clearTimeout(terminalRenderTimer); terminalRenderTimer = null; terminalRenderQueued = false; }
  freshKeys.clear();
  hideNewMsgPill();
}
function setMessage(raw, { render = true, cache = true } = {}){
  const key = msgKey(raw.id);
  if (deletedKeys.has(key)) return undefined;   // 用户已在本地删除 → 任何来源(history/SSE/缓存)都不再收进来
  const existing = messageByKey.get(key);
  if (existing){
    Object.assign(existing, raw, { id: raw.id, meta: raw.meta || existing.meta || {}, _key: key });
  }else{
    const m = normalizeMessage(raw);
    chatMessages.push(m);
    messageByKey.set(key, m);
  }
  invalidateRows();
  const idNum = msgNum(raw.id);
  if (idNum > lastId) lastId = idNum;
  if (render) scheduleRender({ stickToBottom: nearBottom() });
  if (cache) scheduleCacheSave();
  scheduleTerminalRender();
  return messageByKey.get(key);
}
function removeMessage(key, { render = true, cache = true } = {}){
  const k = msgKey(key);
  const m = messageByKey.get(k);
  if (!m) return null;
  messageByKey.delete(k);
  chatMessages = chatMessages.filter((x) => x !== m);
  seen.delete(k);
  invalidateRows();
  if (render) scheduleRender({ preserveAnchor: true });
  scheduleTerminalRender();
  if (cache) scheduleCacheSave();
  return m;
}
function confirmOptimistic(tempKey, serverId, serverMessage){
  const oldKey = msgKey(tempKey);
  const realKey = msgKey(serverId);
  const existing = messageByKey.get(oldKey);
  if (!existing){
    if (serverMessage) setMessage({ ...serverMessage, status:"sent" });
    return messageByKey.get(realKey);
  }
  messageByKey.delete(oldKey);
  seen.delete(oldKey);
  Object.assign(existing, serverMessage || {}, {
    id: serverId,
    status: "sent",
    meta: (serverMessage && serverMessage.meta) || existing.meta || {},
    _key: realKey
  });
  messageByKey.set(realKey, existing);
  seen.add(realKey);
  invalidateRows();
  const idNum = msgNum(serverId);
  if (idNum > lastId) lastId = idNum;
  scheduleRender({ stickToBottom: nearBottom() });
  scheduleCacheSave();
  return existing;
}
function mergeHistoryMessages(msgs, { stickToBottom = false } = {}){
  let added = false;
  (msgs || []).forEach((m) => {
    const key = msgKey(m.id);
    if (seen.has(key)){
      setMessage({ ...m, status:"sent" }, { render:false });
      return;
    }
    if (claimPendingOutgoing(m, key)){
      added = true;
      return;
    }
    removeStreamDraftForMessage(m, { render:false });
    seen.add(key);
    setMessage({ ...m, status:"sent" }, { render:false });
    added = true;
  });
  if (added || (msgs && msgs.length)){
    scheduleRender({ stickToBottom });
    scheduleCacheSave();
  }
}
function oldestMessageId(){
  let oldest = 0;
  chatMessages.forEach((m) => {
    const n = msgNum(m.id);
    if (n > 0 && (!oldest || n < oldest)) oldest = n;
  });
  return oldest;
}
function mergeOlderMessages(msgs, anchor){
  let added = false;
  (msgs || []).forEach((m) => {
    const key = msgKey(m.id);
    if (seen.has(key)) return;
    seen.add(key);
    setMessage({ ...m, status:"sent" }, { render:false });
    added = true;
  });
  if (added){
    scheduleRender({ anchorOverride: anchor });
    scheduleCacheSave();
  }
}
async function loadOlderMessages(){
  if (loadingOlder || !hasMoreOlder || !secret || !chatMessages.length) return;
  const beforeId = oldestMessageId();
  if (!beforeId) return;
  loadingOlder = true;
  const anchor = captureAnchor();
  try{
    const msgs = await apiOlderHistory(beforeId, HISTORY_PAGE_SIZE);
    if (msgs.length < HISTORY_PAGE_SIZE) hasMoreOlder = false;
    mergeOlderMessages(msgs, anchor);
  }catch(e){
    // Keep hasMoreOlder true so a later scroll can retry transient failures.
  }finally{
    loadingOlder = false;
  }
}
function findRenderedMessageRow(key){
  return scrollEl.querySelector(`[data-message-key="${cssEscape(key)}"]`);
}

function fillMeta(metaEl, ts, isAn){
  metaEl.innerHTML = `<span>${fmtTime(ts)}</span>` + (isAn ? `<span class="tick">✓✓</span>` : "");
}
// 发送中的小时钟:两根指针绕表心转(SMIL,旋转中心写死(12,12),不依赖 transform-box,iOS 稳)。
// reduce-motion 时给一只静止的钟。状态转 sent 后此节点按签名重建 → 同位换成 ✓✓。
function sendingTickHtml(){
  const face = '<circle cx="12" cy="12" r="8.2"/>';
  const open = '<span class="tick clock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">';
  if (prefersReducedMotion){
    return open + face + '<line x1="12" y1="12" x2="12" y2="7"/><line x1="12" y1="12" x2="15.2" y2="12"/></svg></span>';
  }
  return open + face
    + '<line x1="12" y1="12" x2="12" y2="7"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite"/></line>'
    + '<line x1="12" y1="12" x2="15.2" y2="12"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="2.1s" repeatCount="indefinite"/></line>'
    + '</svg></span>';
}
function renderMessage(m, opts = {}){
  const item = setMessage({ ...m, status: opts.optimistic ? "sending" : (m.status || "sent") });
  return item ? findRenderedMessageRow(item._key) : null;
}

function buildVirtualRows(){
  const rows = [];
  let lastDayKey = null;
  let prevBubble = null;
  sortedMessages().forEach((m) => {
    const k = dayKey(m.ts);
    if (k !== lastDayKey){
      lastDayKey = k;
      rows.push({ type:"day", key:`day:${k}:${m._key}`, text:fmtDay(m.ts) });
      prevBubble = null;
    }
    if (newDividerBeforeKey && m._key === newDividerBeforeKey){
      rows.push({ type:"new", key:`new:${newDividerBeforeKey}` });
      prevBubble = null;
    }
    if (m.kind === "thinking"){
      rows.push({ type:"thinking", key:`m:${m._key}`, message:m });
      prevBubble = null;
      return;
    }
    if (m.kind === "act"){
      rows.push({ type:"act", key:`m:${m._key}`, message:m });
      prevBubble = null;                            // 像 thinking 一样打断气泡成组
      return;
    }
    const t = tsMs(m);
    const grouped = !!(prevBubble && prevBubble.from === m.from && Number.isFinite(t) && Number.isFinite(prevBubble.ts) && (t - prevBubble.ts < GROUP_GAP));
    const row = { type:"message", key:`m:${m._key}`, message:m, grouped, tail:true };
    if (grouped && prevBubble.row) prevBubble.row.tail = false;
    rows.push(row);
    prevBubble = { from:m.from, ts:t, row };
  });
  return rows;
}
// 内容感知估高:按气泡内宽估文本折行 + 附件高度,首屏估值贴近真实高度→measureVisibleRows
// 纠偏量骤降(上滑进未测行时 restoreAnchor 的 scrollTop 补偿从 ~2000px 级降到 ~50px)。
// charsPerLine 只在首次/转屏时算一次缓存——绝不每行读 window.innerWidth(那会每行触发 reflow,上次翻车主因)。
let _estCpl = 0;
function estCharsPerLine(){
  if (_estCpl) return _estCpl;
  const w = Math.min(window.innerWidth * 0.61, 506) - 24;   // .bubble max-width: min(61vw,506px) 减内边距
  return (_estCpl = Math.max(8, w / 16));        // 每行≈「全宽字」单位数;半角在 estTextHeight 里按 0.5 计
}
window.addEventListener("resize", () => {                    // 转屏/缩放重算一次(不是每行)
  _estCpl = 0;
  prefixSumsDirty = true;
  rowHeights.clear();                                        // 宽度变→所有测高失效;spacer 暂用新估高,measure 停下后精修
  scheduleRender({ preserveAnchor: true });
});
function estTextHeight(text){
  if (!text) return 0;
  const perLine = estCharsPerLine();
  let lines = 0;
  for (const seg of String(text).split("\n")) {
    let units = 0;
    for (let i = 0; i < seg.length; i++) units += seg.charCodeAt(i) < 256 ? 0.5 : 1;  // 半角(ASCII/拉丁)按0.5,CJK 等按1
    lines += Math.max(1, Math.ceil(units / perLine));
  }
  return lines * 25;                                          // line-height 1.58 × ~16px
}
function estImageHeight(a){
  const ratio = Number(a && a.width) > 0 && Number(a && a.height) > 0 ? Math.max(0.35, Math.min(2.6, Number(a.width) / Number(a.height))) : 1.04;
  const w = Math.min(window.innerWidth * 0.64, 260);
  return Math.min(340, w / ratio);
}
function estimatedHeight(row){
  if (rowHeights.has(row.key)) return rowHeights.get(row.key);
  if (row.type === "day") return DEFAULT_DAY_HEIGHT;
  if (row.type === "new") return DEFAULT_NEW_HEIGHT;
  if (row.type === "thinking") return DEFAULT_THINK_HEIGHT;
  if (row.type === "act") return DEFAULT_ACT_HEIGHT;
  const m = row.message;
  const atts = (m && m.meta && Array.isArray(m.meta.attachments)) ? m.meta.attachments : [];
  let h = (row.grouped ? 8 : 22) + 30;                        // 行间距 + 气泡纵向 padding + meta 行
  for (const a of atts) h += a.kind === "image" ? estImageHeight(a) : 56;
  h += estTextHeight(m && m.text);
  return Math.max(h, DEFAULT_ROW_HEIGHT);
}
function rebuildPrefixSums(){
  const n = virtualRows.length;
  const sums = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + estimatedHeight(virtualRows[i]);
  prefixSums = sums;
  prefixSumsDirty = false;
}
function findVisibleStart(y){
  let lo = 0, hi = virtualRows.length;
  while (lo < hi){ const mid = (lo + hi) >>> 1; if (prefixSums[mid + 1] < y) lo = mid + 1; else hi = mid; }
  return lo;
}
function findVisibleEnd(y){
  let lo = 0, hi = virtualRows.length;
  while (lo < hi){ const mid = (lo + hi) >>> 1; if (prefixSums[mid] <= y) lo = mid + 1; else hi = mid; }
  return lo;
}
function rowOuterHeight(el){
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return rect.height + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0);
}
function captureAnchor(){
  const box = scrollEl.getBoundingClientRect();
  for (const el of scrollEl.children){
    if (!el.dataset || !el.dataset.vkey) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom >= box.top) return { key: el.dataset.vkey, offset: rect.top - box.top };
  }
  return null;
}
function restoreAnchor(anchor){
  if (!anchor) return;
  const el = scrollEl.querySelector(`[data-vkey="${cssEscape(anchor.key)}"]`);
  if (!el) return;
  const box = scrollEl.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  scrollEl.scrollTop += (rect.top - box.top) - anchor.offset;
}
function makeDay(row){
  const d = document.createElement("div");
  d.className = "day";
  d.textContent = row.text;
  return d;
}
function makeNewDivider(){
  const d = document.createElement("div");
  d.className = "new-divider";
  d.textContent = "New Messages";
  return d;
}
function makeThinking(rowData){
  const m = rowData.message;
  const row = document.createElement("div");
  row.className = "row think";
  row.dataset.id = m.id; row.dataset.from = "ai"; row.dataset.messageKey = m._key;
  const block = document.createElement("div");
  block.className = "think-block";
  const star = `<span class="think-star" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c.8 5 3.5 7.7 8.5 8.5-5 .8-7.7 3.5-8.5 8.5-.8-5-3.5-7.7-8.5-8.5 5-.8 7.7-3.5 8.5-8.5Z"/></svg></span>`;
  block.innerHTML = `
    <button class="think-toggle" type="button" aria-expanded="false" aria-label="展开思绪">
      <span class="think-rule" aria-hidden="true"></span>
      <span class="think-caption"><span class="think-caption-star" aria-hidden="true">✦</span><span>thinking</span><span class="think-state" aria-hidden="true"></span></span>
    </button>
    <div class="think-body" hidden>
      <div class="think-text"><span class="think-copy">${renderText(m.text)}</span></div>
      <div class="think-starline">${star}</div>
    </div>`;
  const toggle = block.querySelector(".think-toggle");
  const body = block.querySelector(".think-body");
  const setThinkOpen = (open, { persist = true } = {}) => {
    block.classList.toggle("open", open);
    row.classList.toggle("think-open", open);
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "收起思绪" : "展开思绪");
    if (persist){
      if (open) openThinkKeys.add(m._key); else openThinkKeys.delete(m._key);
      scheduleRender({ preserveAnchor: true });
    }
  };
  toggle.addEventListener("click", () => setThinkOpen(!block.classList.contains("open")));
  row.appendChild(block);
  if (openThinkKeys.has(m._key)) setThinkOpen(true, { persist:false });
  return row;
}
/* ── 动作 chip(kind:"act") ──
   contract: m.text = a friendly phrase (e.g. "looked at notes" / "ran 3 commands"); the AI name is prefixed by the UI;
   m.meta.glyph = 字形提示(memory→✦ / terminal→∞ …,缺省 ✦);
   m.meta.steps = 可选的原始工具调用 [{tool,cmd,result}…],非空才显示「· 展开」。
   字段也容忍平铺在 meta 顶层(relay 把 /channel/out 的 body 摊进 meta)。 */
function actGlyph(name){
  switch (name){
    case "terminal": case "shell": case "loop": return "∞";
    case "search": case "grep": return "✱";
    case "web": case "fetch": return "❍";
    case "memory": case "spark": default: return "✦";
  }
}
function renderActStep(s){
  if (!s || typeof s !== "object") return "";
  const line = (k, v) => (v == null || String(v) === "") ? ""
    : `<div class="act-line"><span class="act-k">${k}: </span><span class="act-v">${escapeHtml(String(v))}</span></div>`;
  const body = line("tool", s.tool) + line("cmd", s.cmd) + line("result", s.result);
  return body ? `<div class="act-step">${body}</div>` : "";
}
function makeAct(rowData){
  const m = rowData.message;
  const meta = m.meta || {};
  const a = (meta.act && typeof meta.act === "object") ? meta.act : meta;   // 嵌套或平铺都吃
  const steps = (Array.isArray(a.steps) ? a.steps : []).map(renderActStep).filter(Boolean);
  const glyph = actGlyph(a.glyph || meta.glyph);
  const label = m.text || "做了点什么";
  const expandable = steps.length > 0;

  const row = document.createElement("div");
  row.className = "row act";
  row.dataset.id = m.id; row.dataset.from = "ai"; row.dataset.messageKey = m._key;

  const block = document.createElement("div");
  block.className = "act-block";
  block.innerHTML =
    `<button class="act-toggle${expandable ? "" : " bare"}" type="button"${expandable ? ' aria-expanded="false" aria-label="展开工具明细"' : ' tabindex="-1"'}>`
      + `<span class="act-glyph" aria-hidden="true">${glyph}</span>`
      + `<span class="act-label">${escapeHtml(AI_NAME + label)}</span>`
      + (expandable ? `<span class="act-state" aria-hidden="true"></span>` : "")
    + `</button>`
    + (expandable ? `<div class="act-detail" hidden>${steps.join("")}</div>` : "");

  if (expandable){
    const toggle = block.querySelector(".act-toggle");
    const detail = block.querySelector(".act-detail");
    const setActOpen = (open, { persist = true } = {}) => {
      block.classList.toggle("open", open);             // 翻转空心/实心星
      detail.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "收起工具明细" : "展开工具明细");
      if (persist){
        if (open) openActKeys.add(m._key); else openActKeys.delete(m._key);
        scheduleRender({ preserveAnchor: true });
      }
    };
    toggle.addEventListener("click", () => setActOpen(detail.hidden));
    if (openActKeys.has(m._key)) setActOpen(true, { persist:false });
  }
  row.appendChild(block);
  return row;
}
function makeMessage(rowData){
  const m = rowData.message;
  const row = document.createElement("div");
  row.className = `row ${m.from === "human" ? "human" : "ai"}${rowData.grouped ? " grouped" : ""}${rowData.tail ? " tail" : ""}`;
  row.dataset.id = m.id; row.dataset.from = m.from; row.dataset.ts = tsMs(m); row.dataset.messageKey = m._key;
  if (freshKeys.has(m._key)){                       // 只对刚发/刚收到的那条播一次入场动画
    const cls = m.from === "human" ? "enter-human" : "enter-ai";
    row.classList.add(cls);
    freshKeys.delete(m._key);
    row.addEventListener("animationend", () => row.classList.remove(cls), { once:true });
  }

  if (m.from === "human"){
    const av = document.createElement("div");
    av.className = "mavatar";
    av.title = "点我换你的头像";
    row.appendChild(av);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const atts = (m.meta && Array.isArray(m.meta.attachments)) ? m.meta.attachments : [];
  let _inner = "";
  if (atts.length) _inner += renderAttachments(atts);
  if (m.text) _inner += `<span class="txt">${renderText(m.text)}</span>`;
  _inner += `<span class="meta"></span>`;
  bubble.innerHTML = _inner;
  if (atts.length){ bubble.classList.add("has-att"); if (!m.text) bubble.classList.add("att-only"); }
  const metaEl = bubble.querySelector(".meta");
  if (m.status === "sending") metaEl.innerHTML = `<span>${fmtTime(m.ts)}</span>` + sendingTickHtml();
  else if (m.status === "failed"){
    metaEl.innerHTML = `<span class="fail">未送达 · 重试</span>`;
    const fail = metaEl.querySelector(".fail");
    fail.addEventListener("click", () => {
      removeMessage(m._key);
      inputEl.value = m.text;
      inputEl.dispatchEvent(new Event("input"));
      doSend();
    });
  }else fillMeta(metaEl, m.ts, m.from === "human");
  row.appendChild(bubble);
  // reaction chips — AI poke (one-way: AI → you), rendered only under your own bubbles; not under the AI's
  const reactions = (m.from === "human" && m.meta && m.meta.reactions && typeof m.meta.reactions === "object") ? m.meta.reactions : null;
  const rxList = reactions ? Object.keys(reactions).map((who) => reactions[who]).filter(Boolean) : [];
  if (rxList.length){
    row.classList.add("has-reactions");
    const wrap = document.createElement("div");
    wrap.className = "reactions";
    const fresh = freshReactionKeys.has(m._key);
    wrap.innerHTML = rxList.map((e) => `<span class="reaction${fresh ? " pop-in" : ""}">${escapeHtml(e)}</span>`).join("");
    if (fresh){
      freshReactionKeys.delete(m._key);
      wrap.querySelectorAll(".reaction").forEach((el) => el.addEventListener("animationend", () => el.classList.remove("pop-in"), { once:true }));
    }
    row.appendChild(wrap);
  }
  return row;
}
function createVirtualNode(row){
  let el;
  if (row.type === "day") el = makeDay(row);
  else if (row.type === "new") el = makeNewDivider(row);
  else if (row.type === "thinking") el = makeThinking(row);
  else if (row.type === "act") el = makeAct(row);
  else el = makeMessage(row);
  el.dataset.vkey = row.key;
  return el;
}
function measureVisibleRows({ stickToBottom = false } = {}){
  if (measureQueued) return;
  measureQueued = true;
  requestAnimationFrame(() => {
    measureQueued = false;
    if (scrolling) return;        // 滚动中不测量、不修正:测量→改 prefixSums→restoreAnchor 写 scrollTop 会抖,推迟到停下精修
    let changed = false;
    for (const el of scrollEl.children){
      if (!el.dataset || !el.dataset.vkey) continue;
      const h = rowOuterHeight(el);
      if (!Number.isFinite(h) || h <= 0) continue;
      const old = rowHeights.get(el.dataset.vkey);
      if (!old || Math.abs(old - h) > 1){
        rowHeights.set(el.dataset.vkey, h);
        changed = true;
        prefixSumsDirty = true;
      }
    }
    if (changed){
      const stick = stickToBottom || nearBottom();
      scheduleRender({ stickToBottom: stick, preserveAnchor: !stick });
    }
  });
}
function virtualRowSignature(row){
  if (row.message){
    const m = row.message;
    const _atts = (m.meta && Array.isArray(m.meta.attachments)) ? m.meta.attachments : [];
    const _attSig = _atts.map((a) => `${a.kind || ""}:${a.url || a.localUrl || ""}:${a.uploading ? 1 : 0}:${a.failed ? 1 : 0}`).join(",");
    const _rxSig = (m.meta && m.meta.reactions) ? JSON.stringify(m.meta.reactions) : "";
    return [row.key, row.type, m.status || "", m.id, m.ts, m.text || "", _attSig, row.grouped ? 1 : 0, row.tail ? 1 : 0, openThinkKeys.has(m._key) ? 1 : 0, openActKeys.has(m._key) ? 1 : 0, _rxSig].join("~");
  }
  return row.key;
}
/* ════════════ DOM 回收(虚拟窗口) ════════════
   几万条时 DOM 节点本身吃内存、拖慢布局。窗口化:virtualRows 全量在内存,DOM 里只物化 [domStart,domEnd),
   两端 spacer 占位(高=区间外行高之和)。卸载/插入只在【滚动 idle】做(见 onScrollIdle),绝不碰惯性滚动 → 守丝滑命根。
   n ≤ DOM_WINDOW 时退化为全量渲染(= v78),回收只在大列表启用。 */
function sumHeights(a, b){
  let s = 0;
  for (let i = a; i < b; i++){
    const r = virtualRows[i];
    const h = rowHeights.get(r.key);
    s += (h != null ? h : estimatedHeight(r));   // 测过的用真高,没测过的用内容感知估高
  }
  return s;
}
function indexOfRowKey(key){
  return rowIndexByKey.has(key) ? rowIndexByKey.get(key) : -1;
}
// 视口当前覆盖的 virtualRows 索引范围(只扫已物化的 DOM 行,≤DOM_WINDOW 个,跳过 spacer)
function viewportRowRange(){
  const box = scrollEl.getBoundingClientRect();
  let start = -1, end = -1;
  for (const el of scrollEl.children){
    if (!el.dataset || !el.dataset.vkey) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < box.top || r.top > box.bottom) continue;
    const i = indexOfRowKey(el.dataset.vkey);
    if (i < 0) continue;
    if (start < 0 || i < start) start = i;
    if (i > end) end = i;
  }
  return start < 0 ? null : { start, end };
}
// 按内容 y 走累积行高定位该位置是第几行(只在视口落进 spacer、无物化行可锚时用 → O(n) 兜底,正常路径走 viewportRowRange)
function rowIndexAtY(y){
  let acc = 0;
  for (let i = 0; i < virtualRows.length; i++){
    const r = virtualRows[i];
    const h = rowHeights.get(r.key);
    acc += (h != null ? h : estimatedHeight(r));
    if (acc > y) return i;
  }
  return Math.max(0, virtualRows.length - 1);
}
// 视口覆盖的行索引范围:优先用物化行;若视口落进 spacer(无物化行)则按 scrollTop 推算 → 防止 recenter 时 snap 错位
function viewportCenterRange(){
  const v = viewportRowRange();
  if (v) return v;
  const c = rowIndexAtY(scrollEl.scrollTop + scrollEl.clientHeight / 2);
  return { start: c, end: c };
}
// 决定本次渲染物化哪段 [domStart,domEnd)。stick=贴底;recenter=idle 居中(唯一允许卸载/滑窗处);否则内容变更(锁定同批行)
function resolveWindow(n, { stickToBottom, recenter }){
  if (n <= DOM_WINDOW){
    domStart = 0; domEnd = n;                           // 小列表:全量渲染 = v78
  } else if (stickToBottom){
    domEnd = n; domStart = Math.max(0, n - DOM_WINDOW); // 贴底:物化最新一批
  } else if (recenter){
    const v = viewportCenterRange();                   // 视口落进 spacer 也能定位(不再 snap 回底)
    let s = v.start - DOM_PAD_UP, e = v.end + 1 + DOM_PAD_DOWN;
    if (s < 0){ e -= s; s = 0; }
    if (e > n){ s -= (e - n); e = n; }
    domStart = Math.max(0, s); domEnd = Math.min(n, e);
  } else {
    // 内容变更:用 key 锁定上次那批行;按上次贴边状态决定是否物化新 prepend(loadOlder)/append(新消息)的行
    const prevTop = winAtTop, prevBot = winAtBottom;
    let s = (winTopKey != null) ? indexOfRowKey(winTopKey) : -1;
    let e = (winBotKey != null) ? indexOfRowKey(winBotKey) : -1;
    e = (e >= 0) ? e + 1 : -1;
    if (s < 0 || e < 0){                                // 锚点行被删了 → 退回视口居中
      const v = viewportCenterRange();
      s = Math.max(0, v.start - DOM_PAD_UP); e = Math.min(n, v.end + 1 + DOM_PAD_DOWN);
    }
    if (prevTop) s = 0;                                 // 上次贴顶 → 继续物化新 prepend 的行(随 loadOlder 上翻)
    if (prevBot) e = n;                                 // 上次贴底 → 继续物化新到的消息
    domStart = Math.max(0, Math.min(s, n));
    domEnd = Math.max(domStart, Math.min(e, n));
  }
  winTopKey = virtualRows[domStart] ? virtualRows[domStart].key : null;
  winBotKey = (domEnd > 0 && virtualRows[domEnd - 1]) ? virtualRows[domEnd - 1].key : null;
  winAtTop = (domStart === 0);
  winAtBottom = (domEnd === n);
}
function paintWindow(n){
  const needTop = domStart > 0, needBot = domEnd < n;
  const topH = needTop ? Math.round(sumHeights(0, domStart)) : 0;
  const botH = needBot ? Math.round(sumHeights(domEnd, n)) : 0;
  const slice = virtualRows.slice(domStart, domEnd);
  const sigs = slice.map(virtualRowSignature);
  const signature = domStart + "|" + domEnd + "|" + n + "|" + topH + "|" + botH + "|" + sigs.join("");
  if (signature === renderedSignature && scrollEl.firstChild && scrollEl.firstChild !== emptyEl) return;
  if (needTop) topSpacer.style.height = topH + "px";
  if (needBot) bottomSpacer.style.height = botH + "px";
  const targetNodes = slice.map((row, i) => {
    const cached = nodeCache.get(row.key);
    if (cached && cached.sig === sigs[i]) return cached.el;
    const el = createVirtualNode(row);
    nodeCache.set(row.key, { el, sig: sigs[i] });
    return el;
  });
  const want = [];
  if (needTop) want.push(topSpacer);
  for (const el of targetNodes) want.push(el);
  if (needBot) want.push(bottomSpacer);
  const wantSet = new Set(want);
  for (let c = scrollEl.firstChild; c;){
    const next = c.nextSibling;
    if (c !== emptyEl && !wantSet.has(c)) c.remove();
    c = next;
  }
  let prev = null;
  for (const node of want){
    const ref = prev ? prev.nextSibling : scrollEl.firstChild;
    if (ref !== node) scrollEl.insertBefore(node, ref);
    prev = node;
  }
  if (nodeCache.size > DOM_WINDOW + 200){               // 只缓存窗口附近的节点:卸载的行节点丢弃(回滚需要时重建,走浏览器 HTTP 缓存)
    const keep = new Set(slice.map((r) => r.key));
    for (const k of nodeCache.keys()) if (!keep.has(k)) nodeCache.delete(k);
  }
  renderedSignature = signature;
}
// 物化行停下后测真高存 rowHeights(供日后该行被卸载进 spacer 时算准占位高)。不触发重渲,滚动中跳过。
// reStick:本次是贴底渲染 → 估高被实测修正、总高变化后重新对齐到底(否则首次大列表贴底会差一截)。
function scheduleMeasure(reStick){
  if (measureQueued){ if (reStick) scheduleMeasure._stick = true; return; }
  measureQueued = true;
  scheduleMeasure._stick = !!reStick;
  requestAnimationFrame(() => {
    measureQueued = false;
    if (scrolling) return;
    let changed = false;
    for (const el of scrollEl.children){
      if (!el.dataset || !el.dataset.vkey) continue;
      const h = rowOuterHeight(el);
      if (!Number.isFinite(h) || h <= 0) continue;
      const old = rowHeights.get(el.dataset.vkey);
      if (!old || Math.abs(old - h) > 1){ rowHeights.set(el.dataset.vkey, h); changed = true; }
    }
    if (changed && scheduleMeasure._stick && winAtBottom) jumpToBottom();   // 贴底态:总高变了重新对齐到最新
  });
}
// 把 scrollTop 直接钉到底。前提:调用前窗口已贴底(domEnd===n,最新行已物化),否则会落进 bottomSpacer 空白。
// 单帧一次会落空:padding 过渡(.28s)/行高晚测/iOS 惯性都会在钉完后把"底"再往下挪 → 守护式补钉;
// 补钉带 nearBottom 门:用户若已明显上翻就不抢滚动条。
function jumpToBottom(){
  const pin = () => { scrollEl.scrollTop = scrollEl.scrollHeight; };
  pin();
  requestAnimationFrame(pin);
  setTimeout(() => { if (nearBottom()) pin(); }, 140);
  setTimeout(() => { if (nearBottom()) pin(); }, 340);
  setTimeout(() => { if (nearBottom()) pin(); }, 650);
}
function renderVirtualList({ stickToBottom = false, anchor = null, recenter = false } = {}){
  if (rowsDirty || !virtualRows.length){
    virtualRows = buildVirtualRows();
    rowIndexByKey = new Map();
    for (let i = 0; i < virtualRows.length; i++) rowIndexByKey.set(virtualRows[i].key, i);
    rowsDirty = false;
  }
  const n = virtualRows.length;
  if (!n){
    emptyEl.classList.remove("hidden");
    scrollEl.replaceChildren(emptyEl);
    renderedSignature = "";
    domStart = 0; domEnd = 0; winTopKey = null; winBotKey = null; winAtTop = true; winAtBottom = true;
    return;
  }
  emptyEl.classList.add("hidden");
  resolveWindow(n, { stickToBottom, recenter });
  paintWindow(n);
  if (anchor) restoreAnchor(anchor);              // 同步补偿:与 spacer 改高同帧,消除上滑「先跳后补」的整屏抖动
  if (stickToBottom) jumpToBottom();              // resolveWindow 已让 domEnd=n,最新行已物化,直接钉到底(不再回调 scrollToBottom 避免递归)
  scheduleMeasure(stickToBottom);
}
function scheduleRender({ stickToBottom = false, preserveAnchor = false, anchorOverride = null } = {}){
  const anchor = anchorOverride || (preserveAnchor ? captureAnchor() : null);
  if (renderQueued){
    if (stickToBottom) scheduleRender._stick = true;
    if (anchor) scheduleRender._anchor = anchor;
    return;
  }
  scheduleRender._stick = !!stickToBottom;
  scheduleRender._anchor = anchor;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const stick = !!scheduleRender._stick;
    const savedAnchor = scheduleRender._anchor;
    scheduleRender._stick = false;
    scheduleRender._anchor = null;
    renderVirtualList({ stickToBottom: stick, anchor: savedAnchor });
  });
}

const PENDING_OUTGOING_TTL = 2 * 60e3;
const pendingOutgoing = [];
let optimisticSeq = 0;

function prunePendingOutgoing(){
  const cutoff = Date.now() - PENDING_OUTGOING_TTL;
  for (let i = pendingOutgoing.length - 1; i >= 0; i--){
    const p = pendingOutgoing[i];
    if (p.claimed || !messageByKey.has(p.tempKey) || p.ts < cutoff) pendingOutgoing.splice(i, 1);
  }
}
function rememberPendingOutgoing(tempKey, text, ts){
  pendingOutgoing.push({ tempKey, text, ts, claimed:false });
  prunePendingOutgoing();
}
function dropPendingOutgoing(tempKey){
  for (let i = pendingOutgoing.length - 1; i >= 0; i--){
    if (pendingOutgoing[i].tempKey === tempKey) pendingOutgoing.splice(i, 1);
  }
}
function claimPendingOutgoing(m, key){
  if (m.from !== "human" || m.kind === "thinking") return false;
  prunePendingOutgoing();
  const msgTime = tsMs(m);
  const fallbackTime = Number.isFinite(msgTime) ? msgTime : Date.now();
  const pending = pendingOutgoing.find((p) =>
    !p.claimed &&
    p.text === m.text &&
    Math.abs(fallbackTime - p.ts) < PENDING_OUTGOING_TTL
  );
  if (!pending) return false;
  pending.claimed = true;
  confirmOptimistic(pending.tempKey, key, { ...m, status:"sent" });
  prunePendingOutgoing();
  return true;
}

function streamDraftKey(streamId, kind){
  return `stream:${kind}:${streamId}`;
}
function streamMapKey(streamId, kind){
  return `${kind}:${streamId}`;
}
function streamKindFromEvent(ev){
  return ev.type === "thinking_delta" ? "thinking" : (ev.type === "reply_delta" ? "reply" : "");
}
function appendStreamText(current, addition){
  const base = String(current || "");
  const chunk = String(addition || "");
  if (!chunk) return base;
  if (!base) return chunk;
  if (chunk.startsWith(base)) return chunk;
  if (base.endsWith(chunk)) return base;
  const max = Math.min(base.length, chunk.length);
  for (let n = max; n > 0; n--){
    if (base.slice(-n) === chunk.slice(0, n)) return base + chunk.slice(n);
  }
  return base + chunk;
}
function flushStreamDeltas(filterKey = ""){
  if (streamFlushTimer){ clearTimeout(streamFlushTimer); streamFlushTimer = null; }
  Array.from(streamDeltaBuffers.entries()).forEach(([key, ev]) => {
    if (filterKey && key !== filterKey) return;
    streamDeltaBuffers.delete(key);
    applyStreamDelta(ev);
  });
}
function scheduleStreamFlush(){
  if (streamFlushTimer) return;
  streamFlushTimer = setTimeout(() => flushStreamDeltas(), STREAM_FLUSH_MS);
}
function queueStreamDelta(ev){
  const kind = streamKindFromEvent(ev);
  const streamId = String(ev.stream_id || "");
  if (!kind || !streamId) return;
  const key = streamMapKey(streamId, kind);
  if (ev.done){
    flushStreamDeltas(key);
    applyStreamDelta(ev);
    return;
  }
  const existing = streamDeltaBuffers.get(key);
  if (existing){
    existing.text = appendStreamText(existing.text, ev.text);
    existing.ts = existing.ts || ev.ts;
    existing.api_session = existing.api_session || ev.api_session;
    if (ev.api && typeof ev.api === "object") existing.api = ev.api;
  }else{
    streamDeltaBuffers.set(key, { ...ev, text:String(ev.text || "") });
  }
  scheduleStreamFlush();
}
function removeStreamDraftForMessage(m, opts = {}){
  const meta = (m && m.meta) || {};
  const sid = String(meta.stream_id || "");
  if (!sid || (m.kind !== "thinking" && m.kind !== "reply")) return false;
  const mapKey = streamMapKey(sid, m.kind);
  streamDeltaBuffers.delete(mapKey);
  const draftKey = streamDrafts.get(mapKey) || streamDraftKey(sid, m.kind);
  streamDrafts.delete(mapKey);
  return !!removeMessage(draftKey, { render: opts.render !== false, cache:false });
}
function applyStreamDelta(ev){
  const kind = streamKindFromEvent(ev);
  const streamId = String(ev.stream_id || "");
  if (!kind || !streamId) return;
  const meta = { stream_id: streamId, streaming:true };
  if (ev.api_session) meta.api_session = ev.api_session;
  if (ev.api && typeof ev.api === "object") meta.api = ev.api;
  if (!msgInActiveSession({ meta })) return;

  const mapKey = streamMapKey(streamId, kind);
  const key = streamDrafts.get(mapKey) || streamDraftKey(streamId, kind);
  const existing = messageByKey.get(key);
  if (ev.done){
    if (existing) removeMessage(key, { render:true, cache:false });
    streamDrafts.delete(mapKey);
    return;
  }

  const text = appendStreamText(existing ? existing.text : "", ev.text);
  if (!text) return;
  const stick = nearBottom();
  if (!existing){
    streamDrafts.set(mapKey, key);
    if (kind === "thinking") openThinkKeys.add(key);
    if (stick && kind === "reply") freshKeys.add(key);
  }
  hideTyping();
  setMessage({
    id:key,
    ts:ev.ts || (existing && existing.ts) || new Date().toISOString(),
    from:"ai",
    kind,
    text,
    meta,
    status:"streaming",
  }, { render:false, cache:false });
  scheduleRender({ stickToBottom: stick });
  scheduleTerminalRender({ stickToBottom: stick });
  if (!stick && kind === "reply") showNewMsgPill();
}

function showTyping(){
  typingActive = true;
  renderStatus();
  if (window.VoiceCall && window.VoiceCall.isOpen()) window.VoiceCall.peerTyping(true);
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(hideTyping, 120000);
}
function hideTyping(){
  typingActive = false;
  renderStatus();
  if (window.VoiceCall && window.VoiceCall.isOpen()) window.VoiceCall.peerTyping(false);
  if (typingTimer){ clearTimeout(typingTimer); typingTimer = null; }
}

function onMessage(m){
  if (m.type === "ping") return;
  if (m.type === "thinking_delta" || m.type === "reply_delta"){
    queueStreamDelta(m);
    return;
  }
  if (m.type === "typing"){
    if (m.active) showTyping(); else hideTyping();
    return;
  }
  if (m.type === "context_status"){
    applyContextStatus(m.status);
    return;
  }
  if (m.type === "context_command"){
    showToast("上下文指令已排队");
    return;
  }
  if (m.type === "reaction"){            // the AI reacted to a message → patch its meta.reactions
    hideTyping();                         // a react also means the AI acted: a react-only turn won't send a reply to clear typing, so clear it here
    applyReaction(m);
    return;
  }
  if (m.from === "ai" && m.kind === "call"){
    if (!msgInActiveSession(m)) return;
    const callStick = nearBottom();
    if (window.VoiceCall) window.VoiceCall.incoming(m.text || (AI_NAME + "想和你语音通话。"));
    setMessage({ ...m, status:"sent" }, { render:false });
    scheduleRender({ stickToBottom: callStick });
    if (!callStick) showNewMsgPill();
    return;
  }
  if (!msgInActiveSession(m)) return;
  removeStreamDraftForMessage(m, { render:false });
  if (m.from === "ai") hideTyping();
  const key = msgKey(m.id);
  const stick = nearBottom();
  if (seen.has(key)){
    setMessage({ ...m, status:"sent" }, { render:true });
    if (stick) scrollToBottom();
    return;
  }
  if (claimPendingOutgoing(m, key)){
    if (stick) scrollToBottom();
    return;
  }
  seen.add(key);
  if (stick && m.kind !== "thinking" && m.kind !== "act") freshKeys.add(key);          // 在底部时新消息弹入
  if (m.from === "ai" && m.kind !== "thinking" && m.kind !== "act"){               // act 是环境信息:不响铃、不在通话里朗读
    playReceiveSound();
    if (window.VoiceCall && window.VoiceCall.isOpen()) window.VoiceCall.speak(m.text || "");
  }
  setMessage({ ...m, status:"sent" }, { render:false });
  scheduleRender({ stickToBottom: stick });
  if (!stick && m.from === "ai" && m.kind !== "thinking" && m.kind !== "act") showNewMsgPill();  // user is reading history: don't yank them down, just show "↓ new message" at the bottom
}

function backfill(){
  if (backfillInFlight) return;
  backfillInFlight = true;
  apiNewerHistory(lastId).then((msgs) => {
    mergeHistoryMessages(msgs, { stickToBottom: nearBottom() });
  }).catch(() => {}).finally(() => { backfillInFlight = false; });
}

/* ════════════ reaction · AI poke (one-way: AI → you) ════════════
   relay pushes {type:"reaction", id, reactions:{ai:"❤️"}, by:"ai"};
   we swap that message's meta.reactions → re-render the chip under the bubble.
   reactions persist in the target message's meta (history + cache), so they survive reloads. */
function applyReaction(ev){
  const key = msgKey(ev.id);
  const msg = messageByKey.get(key);
  if (!msg) return;                                  // 这条还没加载(很旧) → 下次 history 重载会带上,忽略即可
  const reactions = (ev.reactions && typeof ev.reactions === "object") ? ev.reactions : {};
  msg.meta = { ...(msg.meta || {}), reactions };
  const hasAny = Object.values(reactions).some(Boolean);
  if (hasAny) freshReactionKeys.add(key); else freshReactionKeys.delete(key);
  invalidateRows();
  if (hasAny){                                       // let you "feel" the poke: a tiny buzz + chime (skipped on reduce-motion / muted)
    try{ if (navigator.vibrate && !prefersReducedMotion) navigator.vibrate(16); }catch(_){}
    playReceiveSound();
  }
  scheduleRender({ stickToBottom: nearBottom() });
  scheduleCacheSave();
}

/* ════════════ 长按气泡 · 复制菜单 (TG 式:遮罩 + 抬起 + 动作条) ════════════ */
(function setupMessageMenu(){
  const menu = $("#msgMenu");
  if (!menu) return;
  const scrim = $("#msgMenuScrim");
  const actions = $("#msgMenuActions");
  let cloneEl = null, pressTimer = null, pressBubble = null, openKey = null;
  let startX = 0, startY = 0;
  let swallowClick = false;   // 长按弹出后,iOS 会补发一个合成 click → 吞掉它,免得菜单刚开就被关

  const isOpen = () => menu.classList.contains("open");
  function clearPress(){ if (pressTimer){ clearTimeout(pressTimer); pressTimer = null; } pressBubble = null; }

  function bubbleInfo(bubble){
    const rowEl = bubble.closest("[data-message-key]");
    if (!rowEl) return null;
    const msg = messageByKey.get(msgKey(rowEl.dataset.messageKey));
    if (!msg) return null;
    return { key: rowEl.dataset.messageKey, msg, side: rowEl.classList.contains("human") ? "human" : "ai" };
  }

  function open(bubble){
    if (isOpen()) return;
    const info = bubbleInfo(bubble);
    if (!info) return;
    try{ const ae = document.activeElement; if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) ae.blur(); }catch(_){}  // 聚焦的输入框长按时会弹自己的原生菜单 → 先失焦
    openKey = info.key;
    const copyBtn = actions.querySelector('[data-act="copy"]');
    if (copyBtn) copyBtn.style.display = info.msg.text ? "" : "none";   // 纯图无文字 → 只留 Delete
    const r = bubble.getBoundingClientRect();
    // 1) 克隆气泡,固定原位,准备轻微抬起
    cloneEl = bubble.cloneNode(true);
    cloneEl.classList.add("msg-menu-clone", info.side === "human" ? "clone-human" : "clone-ai");
    cloneEl.style.left = r.left + "px";
    cloneEl.style.top = r.top + "px";
    cloneEl.style.width = r.width + "px";
    cloneEl.style.transformOrigin = info.side === "human" ? "100% 100%" : "0% 100%";
    menu.insertBefore(cloneEl, actions);
    // 2) 动作条:贴气泡同侧,默认在下方,空间不够翻上方
    actions.style.visibility = "hidden";
    menu.classList.add("open");
    menu.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      const ah = actions.offsetHeight || 56, aw = actions.offsetWidth || 150, gap = 10;
      let top = r.bottom + gap;
      if (top + ah + 12 > window.innerHeight) top = Math.max(12, r.top - gap - ah);
      let left = info.side === "human" ? (r.right - aw) : r.left;
      left = Math.max(10, Math.min(left, window.innerWidth - aw - 10));
      actions.style.top = top + "px";
      actions.style.left = left + "px";
      actions.style.visibility = "";
    });
    try{ if (navigator.vibrate && !prefersReducedMotion) navigator.vibrate(12); }catch(_){}
  }

  function close(){
    if (!isOpen()) return;
    menu.classList.remove("open");
    menu.setAttribute("aria-hidden", "true");
    openKey = null;
    const dead = cloneEl; cloneEl = null;
    setTimeout(() => { if (dead && dead.parentNode) dead.parentNode.removeChild(dead); }, 300);
  }

  function fallbackCopy(text){
    try{
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      showToast(ok ? "已复制" : "复制失败");
    }catch(_){ showToast("复制失败"); }
  }
  function doCopy(){
    const msg = openKey != null ? messageByKey.get(msgKey(openKey)) : null;
    const text = msg ? (msg.text || "") : "";
    close();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(() => showToast("已复制")).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function doDelete(){
    const key = openKey;                       // close() 会清空 openKey,先抓住
    close();
    if (key == null) return;
    deletedKeys.add(msgKey(key));              // 记下来 → 刷新/backfill 都不会让它跑回来
    persistDeletedKeys();
    removeMessage(key);                        // 从内存 + IndexedDB 缓存移除并重渲
    showToast("已删除");
  }

  // 长按检测 —— 用 touch 事件自己计时。不用 pointer:iOS 一识别长按就给页面发 pointercancel,
  // 会把计时器掐掉、让原生选择/复制接管(就是"打架"的根因);touch 不会被这样取消。
  // 原生选择/callout 由 CSS 的 user-select:none / -webkit-touch-callout:none 压住。
  function endTouch(e){
    clearPress();
    if (isOpen()){
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 500);                 // 吞掉抬指后补发的合成 click
      if (e && e.cancelable && e.type === "touchend") e.preventDefault(); // 再抑制一次原生默认行为
    }
  }
  scrollEl.addEventListener("touchstart", (e) => {
    if (isOpen() || e.touches.length !== 1) return;          // 多指(缩放)不触发
    const bubble = e.target.closest(".bubble");
    if (!bubble || !scrollEl.contains(bubble) || e.target.closest("a")) return;
    pressBubble = bubble;
    const t = e.touches[0]; startX = t.clientX; startY = t.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { pressTimer = null; if (pressBubble === bubble) open(bubble); }, 450);
  }, { passive:true });
  scrollEl.addEventListener("touchmove", (e) => {
    if (!pressBubble || !e.touches.length) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) clearPress();   // 移动=滚动,取消长按
  }, { passive:true });
  scrollEl.addEventListener("touchend", endTouch, { passive:false });   // 非 passive:菜单已开时要 preventDefault
  scrollEl.addEventListener("touchcancel", endTouch, { passive:true });

  // 桌面右键
  scrollEl.addEventListener("contextmenu", (e) => {
    const bubble = e.target.closest(".bubble");
    if (!bubble || !scrollEl.contains(bubble)) return;
    if (!bubbleInfo(bubble)) return;
    e.preventDefault();
    open(bubble);
  });

  scrim.addEventListener("click", () => { if (swallowClick){ swallowClick = false; return; } close(); });
  actions.addEventListener("click", (e) => {
    const act = e.target.closest(".msg-act");
    if (!act) return;
    if (act.dataset.act === "copy") doCopy();
    else if (act.dataset.act === "delete") doDelete();
  });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.addEventListener("resize", close);
  scrollEl.addEventListener("scroll", () => { if (isOpen()) close(); }, { passive:true });
})();

/* ════════════ 滚动 ════════════ */
function nearBottom(){ return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 160; }
function scrollToBottom({ smooth = false } = {}){
  hideNewMsgPill();              // 任何"回到底部"都顺手收起胶囊
  // 回收态:若窗口没贴底(最新行在 bottomSpacer 里没物化),直接 scrollTop=scrollHeight 会落进空白 → 先做贴底渲染物化最新一批
  const bottomMaterialized = virtualRows.length <= DOM_WINDOW || domEnd === virtualRows.length;
  if (!bottomMaterialized){
    scheduleRender({ stickToBottom: true });   // resolveWindow 设 domEnd=n + jumpToBottom 钉到底(大跳,不做 smooth)
    return;
  }
  if (smooth && scrollEl.scrollTo){
    requestAnimationFrame(() => {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
      scheduleRender();
    });
    // smooth 动画尾声再补钉一次:动画期间 padding/行高变了会停在半路
    setTimeout(() => { if (nearBottom()) scrollEl.scrollTop = scrollEl.scrollHeight; }, 650);
  } else {
    jumpToBottom();
    requestAnimationFrame(() => scheduleRender());
  }
}
// 滚动停下后(惯性结束)才动窗口:这是 DOM 回收守丝滑命根的开关——卸载/插入/写 scrollTop 全 gate 在这里
function onScrollIdle(){
  scrolling = false;
  scrollIdleTimer = null;
  maybeRecenterWindow();
}
function maybeRecenterWindow(){
  const n = virtualRows.length;
  if (n <= DOM_WINDOW) return;                    // 全量渲染态,无窗口可调
  const v = viewportRowRange();
  if (!v){ doRecenterWindow(); return; }
  const nearTop = domStart > 0 && (v.start - domStart) < DOM_EDGE;       // 视口逼近物化顶 → 上滑窗
  const nearBot = domEnd < n && (domEnd - 1 - v.end) < DOM_EDGE;         // 视口逼近物化底 → 下滑窗
  const tooWide = (domEnd - domStart) > DOM_WINDOW + 200;                // 贴边突发期临时超额(两端都物化)→ 收回
  if (nearTop || nearBot || tooWide) doRecenterWindow();
}
function doRecenterWindow(){
  const anchor = captureAnchor();                 // idle 才写 scrollTop,不与惯性打架
  renderVirtualList({ recenter: true, anchor });
}
scrollEl.addEventListener("scroll", () => {
  const top = scrollEl.scrollTop;
  scrollDir = top < lastScrollTop ? -1 : (top > lastScrollTop ? 1 : scrollDir);
  lastScrollTop = top;
  scrolling = true;
  if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
  scrollIdleTimer = setTimeout(onScrollIdle, SCROLL_IDLE_MS);
  // 只在「物化顶部已到 virtualRows[0]」时才从服务器取更早(否则上方还有内存里的行,recenter 物化即可,不必联网)
  if ((virtualRows.length <= DOM_WINDOW || domStart === 0) && top < OLDER_LOAD_THRESHOLD) loadOlderMessages();
  if (nearBottom()) hideNewMsgPill();
  // 滚动期间不 render、不写 scrollTop,完全交给原生滚动 → 不抖;窗口调整推迟到 onScrollIdle
}, { passive:true });

/* ════════════ 回到最新 · 新消息胶囊 ════════════ */
function showNewMsgPill(){ if (newMsgBtn) newMsgBtn.classList.add("show"); }
function hideNewMsgPill(){ if (newMsgBtn) newMsgBtn.classList.remove("show"); }
if (newMsgBtn) newMsgBtn.addEventListener("click", () => { hideNewMsgPill(); scrollToBottom({ smooth:true }); });

/* ════════════ IndexedDB 近端缓存 ════════════ */
function openMessageDb(){
  return new Promise((resolve, reject) => {
    if (!window.indexedDB){ reject(new Error("indexedDB unavailable")); return; }
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE, { keyPath:"id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open"));
  });
}
async function readCachedMessages(){
  try{
    const db = await openMessageDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const req = tx.objectStore(CACHE_STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => msgNum(a.id) - msgNum(b.id)));
      req.onerror = () => reject(req.error || new Error("indexedDB read"));
      tx.oncomplete = () => db.close();
    });
  }catch(e){ return []; }
}
function cacheableMessages(){
  return sortedMessages()
    .filter((m) => msgNum(m.id) > 0 && m.status !== "sending" && m.status !== "failed")
    .slice(-CACHE_KEEP)
    .map((m) => ({ id: msgKey(m.id), ts:m.ts, from:m.from, kind:m.kind, text:m.text, meta:m.meta || {} }));
}
async function writeMessageCache(){
  try{
    const db = await openMessageDb();
    const items = cacheableMessages();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      const store = tx.objectStore(CACHE_STORE);
      store.clear();
      items.forEach((m) => store.put(m));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("indexedDB write")); };
    });
  }catch(e){}
}
function scheduleCacheSave(){
  if (cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = setTimeout(writeMessageCache, 400);
}

/* ════════════ 提示音 ════════════
   播放同目录下的 send.mp3(发送/收到共用一个音),用 WebAudio 解码,
   不受 iPhone 静音键影响。iOS 需用户手势解锁(首次 pointerdown / doSend / 登录)。
   prefers-reduced-motion 或本机关掉(localStorage companion_sound=off)时静音;
   文件缺失/解码失败则静默,不报错。 */
const prefersReducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const SOUND_FILES = { send: "send.mp3" };        // 只用一个音,发送/收到共用
const SOUND_GAIN  = { send: 2.4 };               // 她的订单：大声很多很多(2026-07-17)。>1=放大 配压限器防破音 嫌吵改小
let audioCtx = null;
let soundOn = true;
try{ soundOn = localStorage.getItem("companion_sound") !== "off"; }catch(_){}
const soundBuffers = {};            // name -> AudioBuffer(已解码) | null(确认无文件) | undefined(未加载)
let soundLoadStarted = false;
function ensureAudio(){
  if (prefersReducedMotion || !soundOn) return null;
  if (!audioCtx){
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try{ audioCtx = new AC(); }catch(_){ return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  loadSounds();
  return audioCtx;
}
function loadSounds(){               // 解锁后预解码一次,发消息时即时可播
  if (soundLoadStarted || !audioCtx) return;
  soundLoadStarted = true;
  Object.keys(SOUND_FILES).forEach((name) => {
    fetch(SOUND_FILES[name])
      .then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error("missing")))
      .then((buf) => audioCtx.decodeAudioData(buf))
      .then((audioBuf) => { soundBuffers[name] = audioBuf; })
      .catch(() => { soundBuffers[name] = null; });
  });
}
function playSound(name){
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== "running") return;   // 未解锁时静默
  const buf = soundBuffers[name];
  if (!buf) return;                              // 加载中/无文件 → 这次不响
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  g.gain.value = SOUND_GAIN[name] || 0.85;
  const comp = ctx.createDynamicsCompressor();   // 放大后靠它兜住峰值不破音
  comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 6;
  src.buffer = buf;
  src.connect(g); g.connect(comp); comp.connect(ctx.destination);
  try{ src.start(); }catch(_){}
}
function playSendSound(){ playSound("send"); }      // 我发出
function playReceiveSound(){ playSound("send"); }   // incoming from the AI (same chime)
window.addEventListener("pointerdown", ensureAudio, { once:true });   // 进页面首次触摸即解锁+预加载

/* ════════════ 发送 ════════════ */
let composing = false;
function focusInputWithoutPageScroll(e){
  if (document.activeElement === inputEl) return;
  if (e) e.preventDefault();
  try{ inputEl.focus({ preventScroll: true }); }
  catch(_){ inputEl.focus(); }
}
inputEl.addEventListener("touchstart", focusInputWithoutPageScroll, { passive: false });
inputEl.addEventListener("pointerdown", focusInputWithoutPageScroll);

inputEl.addEventListener("compositionstart", () => composing = true);
inputEl.addEventListener("compositionend",   () => composing = false);
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  sendBtn.classList.remove("hidden");
  micBtn.classList.add("hidden");
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !composing){
    e.preventDefault();
    doSend();
  }
});
/* 点输入框必回底：interactive-widget=resizes-content 模式下键盘弹出是"布局
   视口整体缩"，vv 的 kbOpen 判定永远 false（rawOffset≈0），老的单发 60ms 又
   赶在键盘动画(~250ms)前面 → 十次八次不回底。改成 1 秒内连发钉底，焦点
   还在输入框才钉，之后归还滚动自由。 */
inputEl.addEventListener("focus", () => {
  [60, 200, 400, 700, 1000].forEach((ms) => setTimeout(() => {
    if (document.activeElement === inputEl) scrollToBottom();
  }, ms));
});
sendBtn.addEventListener("click", doSend);

function triggerSendPress(){
  if (!sendBtn) return;
  sendBtn.classList.remove("send-go");
  void sendBtn.offsetWidth;      // 强制重排,连发也能重启动画
  sendBtn.classList.add("send-go");
  sendBtn.addEventListener("animationend", () => sendBtn.classList.remove("send-go"), { once:true });
}

async function doSend(){
  const text = inputEl.value.trim();
  if (!text) return;
  triggerSendPress();            // 发送键:轻按回弹的小反馈
  ensureAudio();                 // 手势内解锁/预热音频
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.classList.remove("hidden");
  micBtn.classList.add("hidden");

  const optimisticTs = Date.now();
  const tempKey = "pending-" + (++optimisticSeq);
  const currentSid = effectiveApiSession();
  const optimisticMeta = currentSid ? { api_session: currentSid } : {};
  const optimistic = { id: tempKey, ts: new Date(optimisticTs).toISOString(), from:"human", kind:"user", text, meta:optimisticMeta, status:"sending" };
  seen.add(tempKey);
  setMessage(optimistic, { render:false, cache:false });
  freshKeys.add(tempKey);        // 入场弹一下
  playSendSound();               // 发出反馈音
  rememberPendingOutgoing(tempKey, text, optimisticTs);
  scheduleRender({ stickToBottom:true });

  try{
    const { id } = await apiSend(text);
    const key = msgKey(id);
    confirmOptimistic(tempKey, key);
    dropPendingOutgoing(tempKey);
  }catch(err){
    dropPendingOutgoing(tempKey);
    if (String(err.message) === "401") return;
    setMessage({ ...optimistic, status:"failed" });
  }
}

/* ════════════ 附件发送 ════════════ */
const ATT_MAX = 10 * 1024 * 1024;
function isImageFile(file){
  return /^image\//.test(file.type || "") || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name || "");
}
function imageToJpeg(file){
  return new Promise((resolve) => {
    if (!isImageFile(file)){ resolve(null); return; }
    if (/gif$/i.test(file.type || "") || /\.gif$/i.test(file.name || "")){ resolve(null); return; }  // 动图保留原样
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try{
        const max = 2048;
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h){ URL.revokeObjectURL(url); resolve(null); return; }
        let outW = w, outH = h;
        if (outW > max || outH > max){ const r = Math.min(max / outW, max / outH); outW = Math.round(outW * r); outH = Math.round(outH * r); }
        const c = document.createElement("canvas"); c.width = outW; c.height = outH;
        c.getContext("2d").drawImage(img, 0, 0, outW, outH);
        URL.revokeObjectURL(url);
        c.toBlob((blob) => {
          if (!blob){ resolve(null); return; }
          const base = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
          resolve({ blob: blob, name: base + ".jpg", width: outW, height: outH });
        }, "image/jpeg", 0.9);
      }catch(e){ URL.revokeObjectURL(url); resolve(null); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
async function sendOneFile(file){
  if (!secret) return;
  ensureAudio();
  const image = isImageFile(file);
  let blob = file, name = file.name || (image ? "image" : "file"), mime = file.type || "";
  let imgW = 0, imgH = 0;
  if (image){
    try{
      const conv = await imageToJpeg(file);
      if (conv){ blob = conv.blob; name = conv.name; mime = "image/jpeg"; imgW = conv.width || 0; imgH = conv.height || 0; }
    }catch(_){}
  }
  if (blob.size > ATT_MAX){ showToast("文件超过 10MB，发不了"); return; }
  const kind = image ? "image" : "file";
  const localUrl = image ? URL.createObjectURL(blob) : "";
  const optimisticTs = Date.now();
  const tempKey = "pending-" + (++optimisticSeq);
  const att0 = { url: "", localUrl: localUrl, name: name, size: blob.size, mime: mime, kind: kind, width: imgW, height: imgH, uploading: true };
  const currentSid = effectiveApiSession();
  const optimisticMeta = { attachments: [att0] };
  if (currentSid) optimisticMeta.api_session = currentSid;
  const optimistic = { id: tempKey, ts: new Date(optimisticTs).toISOString(), from: "human", kind: "user", text: "", meta: optimisticMeta, status: "sending" };
  seen.add(tempKey);
  setMessage(optimistic, { render: false, cache: false });
  freshKeys.add(tempKey);
  playSendSound();
  scheduleRender({ stickToBottom: true });
  try{
    const up = await apiUpload(blob, name, mime);
    if (localUrl && up && up.url) localPreview.set(up.url, localUrl);
    const finalAtt = { url: up.url, name: up.name, size: up.size, mime: up.mime, kind: up.kind, width: imgW, height: imgH };
    rememberPendingOutgoing(tempKey, "", optimisticTs);
    const { id } = await apiSend("", [finalAtt]);
    const finalMeta = { attachments: [finalAtt] };
    if (currentSid) finalMeta.api_session = currentSid;
    confirmOptimistic(tempKey, msgKey(id), { id: id, ts: optimistic.ts, from: "human", kind: "user", text: "", meta: finalMeta, status: "sent" });
    dropPendingOutgoing(tempKey);
  }catch(err){
    dropPendingOutgoing(tempKey);
    if (String(err.message) === "401") return;
    if (String(err.message) === "413") showToast("文件太大（上限 10MB）");
    setMessage({ ...optimistic, meta: { attachments: [{ ...att0, uploading: false, failed: true }] }, status: "failed" });
  }
}
async function handleFiles(list){
  const files = Array.from(list || []);
  for (const f of files){ await sendOneFile(f); }
}
if (clipBtn && clipInput){
  clipBtn.addEventListener("click", () => clipInput.click());
  clipInput.addEventListener("change", () => { const fs = Array.from(clipInput.files || []); clipInput.value = ""; handleFiles(fs); });
}

/* ════════════ 登录 / 401 ════════════ */
function handle401(){
  secret = null;
  localStorage.removeItem(LS_KEY);
  if (es){ try{ es.close(); }catch(e){} es = null; }
  if (healthTimer){ clearInterval(healthTimer); healthTimer = null; }
  showLogin("密钥不对,请重新输入。");
}

function showLogin(msg){
  appEl.classList.add("hidden");
  loginEl.classList.remove("hidden");
  $("#loginErr").textContent = msg || "";
  $("#secretInput").value = "";
  setTimeout(() => $("#secretInput").focus(), 80);
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  let val = $("#secretInput").value.trim();
  // 钥匙盒也认整条魔法链接：粘贴 https://...#k=xxx 自动抠出密钥
  const mk = val.match(/[#&]k=([^&\s]+)/);
  if (mk && mk[1]){ try{ val = decodeURIComponent(mk[1]); }catch(_){ val = mk[1]; } }
  if (!val) return;
  const btn = e.target.querySelector("button");
  btn.disabled = true; btn.textContent = "连接中…";
  secret = val;
  try{
    // 用 history 验证密钥(401 会抛错)
    await loadSessions();
    loadBrain();
    const msgs = await apiLatestHistory();
    localStorage.setItem(LS_KEY, secret);
    startChat(msgs);
  }catch(err){
    secret = null;
    if (String(err.message) !== "401") $("#loginErr").textContent = "连不上,稍后再试。";
  }finally{
    btn.disabled = false; btn.textContent = "连接";
  }
});

/* ════════════ 启动 ════════════ */
function startRealtime(){
  openStream();

  if (streamWatchTimer) clearInterval(streamWatchTimer);
  streamWatchTimer = setInterval(() => {
    if (document.hidden || USE_MOCK || !secret) return;
    if (!lastStreamEventAt || Date.now() - lastStreamEventAt <= STREAM_STALE_MS) return;
    connected = false;
    setConn("reconnecting");
    openStream();
    backfill();
  }, 10000);

  if (backfillTimer) clearInterval(backfillTimer);
  backfillTimer = setInterval(() => {
    if (!document.hidden && secret) backfill();
  }, BACKFILL_MS);

  // healthz 兜底:stream 没连上时也能反映在线/离线
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (connected) return;
    const ok = await apiHealth();
    setConn(ok ? "reconnecting" : "offline");
  }, 25000);
}
function startChat(initialMsgs, { connect = true, fromCache = false } = {}){
  loginEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  setConn("offline");
  resetChatState();

  const historyMsgs = (initialMsgs || []).slice().sort((a, b) => msgNum(a.id) - msgNum(b.id));
  hasMoreOlder = fromCache || historyMsgs.length >= HISTORY_PAGE_SIZE;
  newDividerBeforeKey = historyMsgs.length > 5 ? msgKey(historyMsgs[historyMsgs.length - 1].id) : null;
  historyMsgs.forEach((m) => {
    const key = msgKey(m.id);
    seen.add(key);
    setMessage({ ...m, status:"sent" }, { render:false, cache:false });
  });
  renderVirtualList({ stickToBottom:true });
  if (!fromCache) scheduleCacheSave();
  if (connect) startRealtime();
  refreshContextStatus();
}

async function init(){
  if (!secret){ showLogin(); return; }
  await loadSessions();
  loadBrain();
  let showedCache = false;
  const cached = await readCachedMessages();
  if (cached.length){
    startChat(sessionFiltered(cached), { connect:false, fromCache:true });
    showedCache = true;
  }
  try{
    const msgs = await apiLatestHistory();
    if (showedCache){
      hasMoreOlder = true;
      mergeHistoryMessages(msgs, { stickToBottom:true });
      startRealtime();
    }else{
      startChat(msgs);
    }
  }catch(err){
    if (String(err.message) !== "401" && !showedCache) showLogin("连不上,请确认密钥。");
    else if (showedCache) startRealtime();
  }
}

/* 回前台重同步:iOS 后台会挂起连接 */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !secret) return;
  backfill();
  refreshContextStatus();
  if (!es || es.readyState !== 1 || Date.now() - lastStreamEventAt > STREAM_STALE_MS) openStream();
});

navigator.serviceWorker&&navigator.serviceWorker.addEventListener("message",(e)=>{
  if(e.data&&e.data.type==="backfill"&&secret){ backfill(); if(!es||es.readyState!==1) openStream(); }
});


/* --app-h:布局视口实测高度,html/body/.app 的唯一真相。
   iOS PWA 上 100vh 可能大于真实布局视口(fixed bottom:0 锚的那条边),
   容器用 100vh 时底部会沉出屏幕 → 消息钻进输入栏底下的元凶。 */
let lastAppH = 0;
function applyAppHeight(){
  const h = Math.round(Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0));
  if (h <= 0) return;
  const wasNear = nearBottom();
  document.documentElement.style.setProperty("--app-h", h + "px");
  // 键盘压缩布局视口(interactive-widget=resizes-content)时,贴底的人继续贴底
  if (wasNear && Math.abs(h - lastAppH) > 1) requestAnimationFrame(() => { scrollEl.scrollTop = scrollEl.scrollHeight; });
  lastAppH = h;
}
applyAppHeight();
window.addEventListener("resize", applyAppHeight);
window.addEventListener("orientationchange", () => setTimeout(applyAppHeight, 250));
/* 自愈兜底：iOS 独立 PWA 有时键盘收起/切回都不发任何事件，高度卡在缩小值，
   底部"莫名长出一条"。每 2 秒静默校正一次（打字时不动，避免和键盘打架）。 */
setInterval(() => {
  if (!document.hidden && document.activeElement !== inputEl) applyAppHeight();
}, 2000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") applyAppHeight();
});

function applyPhysicalScreenVars(){
  const screenH = window.screen && window.screen.height ? Math.round(window.screen.height) : Math.round(window.innerHeight || 0);
  if (screenH) document.documentElement.style.setProperty("--screen-height", screenH + "px");
}
applyPhysicalScreenVars();
window.addEventListener("orientationchange", () => setTimeout(applyPhysicalScreenVars, 250));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") applyPhysicalScreenVars();
});

/* iOS Home Screen can report a layout viewport shorter than the physical screen
   even when safe-area-bottom is available. Extend fixed layers into that gap. */
function applyPwaViewportBleed(){
  const standalone = !!navigator.standalone ||
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches;
  const layoutH = Math.max(
    window.innerHeight || 0,
    document.documentElement.clientHeight || 0
  );
  const screenH = window.screen && window.screen.height ? window.screen.height : 0;
  let bleed = standalone ? Math.max(0, Math.round(screenH - layoutH)) : 0;
  if (bleed > 160) bleed = 0;
  document.documentElement.style.setProperty("--ios-pwa-bottom-bleed", bleed + "px");
}
applyPwaViewportBleed();
window.addEventListener("resize", applyPwaViewportBleed);
window.addEventListener("orientationchange", () => setTimeout(applyPwaViewportBleed, 250));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") applyPwaViewportBleed();
});

/* composer 实测高度 → --composer-real:多行输入长高/机型安全区差异,底部让位跟着真实高度走,不再拍脑袋估 */
(() => {
  const composerEl = document.querySelector(".composer");
  if (!composerEl) return;
  const syncComposer = () => {
    const h = Math.round(composerEl.offsetHeight);   // offsetHeight 不含 transform(键盘位移),含自身 padding/安全区
    if (h > 0) document.documentElement.style.setProperty("--composer-real", h + "px");
    if (nearBottom()) scrollEl.scrollTop = scrollEl.scrollHeight;   // 让位变化时贴底的人继续贴底
  };
  if (window.ResizeObserver) new ResizeObserver(syncComposer).observe(composerEl);
  window.addEventListener("load", syncComposer);
  syncComposer();
})();

/* 键盘 / 安全区:只移动输入栏和消息区,不改整体页面高度。 */
if (window.visualViewport){
  const vv = window.visualViewport;
  const applyVV = () => {
    applyAppHeight();  // iOS 独立 PWA 键盘收起常不发 window.resize，--app-h 卡在
                       // 缩小值 → 输入栏下多一条键盘高的空白；vv 事件可靠，借它校正
    const rawOffset = (window.innerHeight || 0) - (vv.height || 0) - (vv.offsetTop || 0);
    const kbOpen = rawOffset > 80;
    const offset = kbOpen ? Math.max(0, Math.round(rawOffset)) : 0;
    document.documentElement.style.setProperty("--keyboard-offset", offset + "px");
    appEl.classList.toggle("kb", kbOpen);
    if (kbOpen){
      scrollToBottom({ smooth: true });
      setTimeout(() => scrollToBottom({ smooth: true }), 90);
      setTimeout(() => scrollToBottom(), 320);
    } else if (nearBottom()) scrollToBottom();
  };
  let vvTimer;
  vv.addEventListener("resize", () => { applyVV(); clearTimeout(vvTimer); vvTimer = setTimeout(applyVV, 80); setTimeout(applyVV, 350); });
  vv.addEventListener("scroll", applyVV);
  inputEl.addEventListener("focus", () => { applyVV(); setTimeout(applyVV, 80); setTimeout(applyVV, 350); setTimeout(applyVV, 600); setTimeout(applyVV, 1000); });
  inputEl.addEventListener("blur", () => { setTimeout(applyVV, 80); setTimeout(applyVV, 300); });
  inputEl.addEventListener("input", () => { if (document.activeElement === inputEl) applyVV(); });
  applyVV();
}

/* Service Worker */
if ("serviceWorker" in navigator){
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

init();
