/* ===========================================================
   Sri Karaoke — จอที่ 2 (Second Screen)
   Read-only display: connects to the host like a guest remote, but sends no
   control messages at all — it only ever receives state and shows it full-screen.
   =========================================================== */

const STORAGE_ROOMID = 'sriKaraoke_screen2_lastRoomId';
const STORAGE_PIN = 'sriKaraoke_screen2_lastPin';
const NEXT_UP_WINDOW_SECONDS = 15;

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ],
  iceCandidatePoolSize: 10
};

// A display that is meant to stay on: keep it from dimming / sleeping while this page is open (see wakelock.js).
if(window.KeepAwake) KeepAwake.start();

let peer = null;
let conn = null;
let currentRoomId = null;
let currentPin = '';
let reconnectTimer = null;
let reconnectAttempts = 0;
let authFailed = false;

let ytPlayer = null;
let ytReady = false;
let myQueue = [];
let myCurrentId = null;
let myChords = {};

/* ---------------- MP3 now-playing screen (mirrors the host's word-by-word lyric highlight) ----------------
   Screen 2 has no access to the host's local audio file at all — everything shown here (lyrics, cover,
   title/artist, and the timing to drive the highlight) is sent over from the host. */
let s2Mp3Data = null; // { songId, code, title, artist, lines, coverDataUrl } | null
let s2LocalTimeSync = { syncedAt: 0, syncedTime: 0, active: false };
let s2CurrentLyricLineIndex = -1;
function setS2LocalTimeSync(songTimeSec){
  s2LocalTimeSync = { syncedAt: Date.now(), syncedTime: songTimeSec, active: true };
}
function getS2EstimatedTime(){
  if(!s2LocalTimeSync.active) return 0;
  return s2LocalTimeSync.syncedTime + (Date.now() - s2LocalTimeSync.syncedAt) / 1000;
}
function s2BuildLyricLineWords(container, line){
  container.innerHTML = '';
  if(!line) return;
  line.words.forEach(word => {
    const wrap = document.createElement('span');
    wrap.className = 'lyric-word';
    const base = document.createElement('span');
    base.className = 'lyric-word-base';
    base.textContent = word.text;
    const fill = document.createElement('span');
    fill.className = 'lyric-word-fill';
    fill.textContent = word.text;
    wrap.appendChild(base);
    wrap.appendChild(fill);
    container.appendChild(wrap);
  });
}
function renderS2Mp3Lyrics(){
  if(!s2Mp3Data || !s2Mp3Data.lines || document.getElementById('mp3-now-playing').style.display === 'none') return;
  // The host's sound reaches this screen a moment late, so the highlight is held back by the same amount
  const curMs = getS2EstimatedTime() * 1000 - ((s2StreamActive && currentAudioOutput === 'screen2') ? s2AudioLatencyMs : 0);
  const lines = s2Mp3Data.lines;
  let idx = -1;
  for(let i = 0; i < lines.length; i++){
    if(lines[i].startTime <= curMs) idx = i; else break;
  }
  if(idx !== s2CurrentLyricLineIndex){
    s2CurrentLyricLineIndex = idx;
    s2BuildLyricLineWords(document.getElementById('lyric-line-current'), idx >= 0 ? lines[idx] : null);
    s2BuildLyricLineWords(document.getElementById('lyric-line-next'), idx + 1 < lines.length ? lines[idx + 1] : null);
  }
  if(idx < 0) return;
  const line = lines[idx];
  const nextLineStart = idx + 1 < lines.length ? lines[idx + 1].startTime : line.words[line.words.length - 1].time + 2000;
  const fillEls = document.querySelectorAll('#lyric-line-current .lyric-word-fill');
  line.words.forEach((word, i) => {
    const wordEnd = i + 1 < line.words.length ? line.words[i + 1].time : nextLineStart;
    let progress = (curMs - word.time) / Math.max(1, wordEnd - word.time);
    progress = Math.max(0, Math.min(1, progress));
    const el = fillEls[i];
    if(el) el.style.clipPath = `inset(0 ${(1 - progress) * 100}% 0 0)`;
  });
}
setInterval(renderS2Mp3Lyrics, 100);
function songChordKey(song){
  if(!song) return null;
  return song.source === 'local' ? 'local:' + song.localFileId : 'yt:' + song.videoId;
}

if(location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
  document.getElementById('https-warning').style.display = 'block';
}

function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- Connect ---------------- */
function connectToRoom(roomId, pin, isReconnect){
  currentRoomId = roomId;
  currentPin = pin || '';
  authFailed = false;
  // localStorage, not sessionStorage — a screen locking/sleeping (or an Android TV box's aggressive
  // background app management) can suspend or fully discard this tab to save memory. sessionStorage
  // can be wiped when that happens, forcing a fresh QR scan; localStorage survives that (and even a
  // full browser/device restart), so reopening the page reconnects to the same room automatically.
  localStorage.setItem(STORAGE_ROOMID, roomId);
  localStorage.setItem(STORAGE_PIN, currentPin);
  if(!isReconnect) document.getElementById('connect-status').textContent = 'กำลังเชื่อมต่อ…';
  if(peer){ try{ peer.destroy(); }catch(e){} }
  peer = new Peer(undefined, { config: ICE_CONFIG });
  s2StreamCall = null; detachStreamAudio(); // a fresh Peer means any earlier feed is gone
  s2Cam.call = null; s2Cam.stream = null; s2CamRender(); s2CamStatsSync();
  // The host sends a local file's sound here as a one-way audio call whenever sound is routed to this screen.
  peer.on('call', (call) => {
    if(call.peer !== currentRoomId){ try{ call.close(); }catch(e){} return; } // only the host (its peer id is the room id) may send anything here
    if(call.metadata && call.metadata.kind === 'camera'){ // the host's live camera picture
      if(s2Cam.call && s2Cam.call !== call){ try{ s2Cam.call.close(); }catch(e){} }
      s2Cam.call = call;
      call.answer(); // receive only
      call.on('stream', (stream) => { s2Cam.stream = stream; s2CamRender(); s2CamStatsSync(); });
      const camGone = () => { if(s2Cam.call === call){ s2Cam.call = null; s2Cam.stream = null; s2CamRender(); s2CamStatsSync(); } };
      call.on('close', camGone);
      call.on('error', camGone);
      return;
    }
    if(s2StreamCall && s2StreamCall !== call){ try{ s2StreamCall.close(); }catch(e){} }
    s2StreamCall = call;
    call.answer(undefined, { sdpTransform: opusStereoSdp }); // receive only; ask for stereo
    call.on('stream', (stream) => attachStreamAudio(stream));
    const gone = () => { if(s2StreamCall === call){ s2StreamCall = null; detachStreamAudio(); } };
    call.on('close', gone);
    call.on('error', gone);
  });
  peer.on('open', () => {
    conn = peer.connect(roomId, { reliable: true });
    conn.on('open', () => {
      // "screen2" is just a plain guest join — it never sends ADD_SONG/REMOVE_SONG/etc.,
      // so it needs no special permission tier on the host side at all.
      conn.send({ type: 'JOIN', pin: currentPin, nickname: 'จอที่ 2', kind: 'screen2' });
      document.getElementById('connect-status').textContent = 'กำลังตรวจสอบห้อง…';
    });
    conn.on('data', handleHostMessage);
    conn.on('close', () => { if(!authFailed) scheduleReconnect(); });
    conn.on('error', () => { if(!authFailed) scheduleReconnect(); });
  });
  peer.on('error', (err) => {
    if(isReconnect || document.getElementById('display-screen').style.display === 'block'){
      scheduleReconnect();
    } else {
      document.getElementById('connect-status').textContent = 'เกิดข้อผิดพลาด: ' + err.type;
    }
  });
  peer.on('disconnected', () => { if(!authFailed) scheduleReconnect(); });
}

function scheduleReconnect(){
  if(reconnectTimer || !currentRoomId || authFailed) return;
  document.getElementById('reconnect-banner').style.display = 'block';
  reconnectAttempts++;
  const delay = Math.min(10000, 2000 * reconnectAttempts);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToRoom(currentRoomId, currentPin, true);
  }, delay);
}

// Screen 2 is meant to sit untouched for a whole event, so it needs the same "wake up and
// reconnect immediately" handling as the phone remotes do.
// Screens sleep/lock (or an Android TV box aggressively manages background apps), which can silently
// kill the WebRTC connection without ever firing a 'close' event. Check the connection right away
// when the page becomes visible/focused again — using the room code/PIN already remembered, so no
// re-scan of the QR code is needed.
function reconnectIfStale(){
  if(!currentRoomId || authFailed) return;
  const stale = !conn || !conn.open || !peer || peer.disconnected || peer.destroyed;
  if(stale){
    reconnectAttempts = 0;
    if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer = null; }
    connectToRoom(currentRoomId, currentPin, true);
  }
}
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible') reconnectIfStale();
});
window.addEventListener('focus', reconnectIfStale);
// Extra safety net that doesn't depend on any browser event firing correctly at all, so a dropped
// connection can't go unnoticed for more than ~10s — especially useful for a screen meant to be left
// running unattended for a whole event.
setInterval(() => {
  if(document.visibilityState === 'visible') reconnectIfStale();
}, 10000);

function handleHostMessage(msg){
  if(msg.type === 'JOIN_OK'){
    reconnectAttempts = 0;
    document.getElementById('reconnect-banner').style.display = 'none';
    document.getElementById('connect-status').textContent = '';
    document.getElementById('connect-screen').style.display = 'none';
    document.getElementById('display-screen').style.display = 'block';
    return;
  }
  if(msg.type === 'JOIN_REJECTED'){
    authFailed = true;
    document.getElementById('display-screen').style.display = 'none';
    document.getElementById('connect-screen').style.display = 'flex';
    document.getElementById('reconnect-banner').style.display = 'none';
    document.getElementById('connect-status').textContent = '❌ รหัส PIN ไม่ถูกต้อง กรุณากรอกใหม่แล้วกดเชื่อมต่ออีกครั้ง';
    return;
  }
  if(msg.type === 'STATE_UPDATE'){
    myQueue = msg.queue || [];
    myCurrentId = msg.currentId;
    applyVideoState(msg.currentId, msg.currentTime);
    if(typeof msg.currentTime === 'number') setS2LocalTimeSync(msg.currentTime);
    renderDisplay();
    return;
  }
  if(msg.type === 'TIME_SYNC'){
    if(msg.currentId === myCurrentId && ytReady && ytPlayer && typeof ytPlayer.getCurrentTime === 'function'){
      try{
        const drift = Math.abs(ytPlayer.getCurrentTime() - msg.currentTime);
        if(drift > 2.5) ytPlayer.seekTo(msg.currentTime, true);
      }catch(e){}
    }
    // Also the only timing source for local MP3s — Screen 2 has no file of its own to read a clock
    // from, so this periodic ping (plus local extrapolation between pings) is what drives the
    // word-by-word lyric highlight staying roughly in step with the host.
    if(msg.currentId === myCurrentId) setS2LocalTimeSync(msg.currentTime);
    return;
  }
  if(msg.type === 'AUDIO_OUTPUT'){
    if(typeof msg.latencyMs === 'number' && msg.latencyMs >= 0 && msg.latencyMs <= 2000) s2AudioLatencyMs = msg.latencyMs;
    applyAudioFromHost(msg.output, msg.volume, msg.muted);
    return;
  }
  if(msg.type === 'CHORDS_LIBRARY'){
    myChords = msg.chords || {};
    return;
  }
  if(msg.type === 'PLAY_SOUND_EFFECT'){
    playSoundEffectOnScreen2(msg.file);
    return;
  }
  if(msg.type === 'CAM_CONFIG'){ s2CamOnConfig(msg); return; }
  if(msg.type === 'BG_SYNC'){ s2BgOnSync(msg); return; }
  if(msg.type === 'BG_IMAGE'){ s2BgOnImage(msg); return; }
  if(msg.type === 'EMOJI_REACTION'){
    showEmojiReaction(msg.emoji);
    return;
  }
  if(msg.type === 'MP3_LYRICS'){
    s2Mp3Data = msg.songId ? msg : null;
    renderDisplay();
    return;
  }
  if(msg.type === 'SCORE_ANNOUNCE'){
    showScorePopup(msg.entry, msg.leaderboard);
  }
}

// Only actually plays if this screen is currently the audio source (same "เสียงออกที่จอไหน" setting
// as everything else) — the host only forwards these here in that exact situation anyway, but this
// stays defensive in case a message arrives right as the setting is changing.
function playSoundEffectOnScreen2(file){
  if(!file || currentAudioOutput !== 'screen2') return;
  const el = document.getElementById('sfx-player');
  if(!el) return;
  try{
    el.src = 'sound-effects/' + encodeURIComponent(file);
    el.volume = currentAudioMuted ? 0 : (currentAudioVolume / 100);
    el.currentTime = 0;
    el.play().catch(() => {});
  }catch(e){}
}

// Screen 2's own YouTube player is normally muted (the host is the default audio source), but if
// the host switches "เสียงออกที่จอไหน" to Screen 2, it broadcasts an AUDIO_OUTPUT message telling
// this page to become the audio source instead — volume/mute here then mirror the host's controls.
let pendingAudioState = null;
let currentAudioOutput = 'screen1', currentAudioVolume = 100, currentAudioMuted = false;
let s2AudioLatencyMs = 250;   // how late the streamed sound arrives (set on the host) — holds MP3 lyrics back to match
let s2StreamCall = null;      // the host's live audio feed for local files (see peer.on('call') below)
let s2StreamActive = false;   // true while that feed is attached to the <audio> element
let isLoadingSong = false;
// Same Opus-stereo SDP tweak as on the host (the two pages share no code): WebRTC sends Opus as mono unless
// the SDP asks for stereo, which would collapse Stereo mode to mono here.
function opusStereoSdp(sdp){
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if(!m) return sdp;
  const pt = m[1];
  const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
  const fmtp = new RegExp('(a=fmtp:' + pt + ' )([^\\r\\n]*)');
  if(fmtp.test(sdp)){
    return sdp.replace(fmtp, (all, head, params) => /(^|;)stereo=/.test(params) ? all : head + params + ';' + extra);
  }
  return sdp.replace(m[0], m[0] + '\r\na=fmtp:' + pt + ' ' + extra);
}

// The streamed local-file sound plays in its own <audio> element; the host's volume / mute / output choice
// (the same AUDIO_OUTPUT message that drives the YouTube player here) controls it.
function applyStreamAudioLevel(){
  const el = document.getElementById('s2-stream-audio');
  if(!el) return;
  const active = currentAudioOutput === 'screen2' && !currentAudioMuted;
  el.muted = !active;
  el.volume = active ? Math.max(0, Math.min(1, currentAudioVolume / 100)) : 0;
}
function attachStreamAudio(stream){
  const el = document.getElementById('s2-stream-audio');
  if(!el) return;
  s2StreamActive = true;
  el.srcObject = stream;
  applyStreamAudioLevel();
  const p = el.play();
  if(p && p.catch) p.catch(() => { document.getElementById('s2-audio-unlock').style.display = 'block'; }); // browser wants a tap first
}
function detachStreamAudio(){
  s2StreamActive = false;
  const el = document.getElementById('s2-stream-audio');
  if(el){ try{ el.pause(); }catch(e){} el.srcObject = null; }
  const banner = document.getElementById('s2-audio-unlock');
  if(banner) banner.style.display = 'none';
}
function tryUnlockStreamAudio(){
  const el = document.getElementById('s2-stream-audio');
  if(!s2StreamActive || !el || !el.paused) return;
  const p = el.play();
  const hide = () => { document.getElementById('s2-audio-unlock').style.display = 'none'; };
  if(p && p.then) p.then(hide).catch(() => {}); else hide();
}
document.addEventListener('click', tryUnlockStreamAudio);
document.addEventListener('touchstart', tryUnlockStreamAudio, { passive: true });

function applyAudioFromHost(output, volume, muted){
  console.debug('[Audio Debug] Screen 2 applyAudioFromHost called. output:', output, '| volume:', volume, '| muted:', muted, '| ytReady:', ytReady, '| ytPlayer exists:', !!ytPlayer, '| isLoadingSong:', isLoadingSong);
  currentAudioOutput = output;
  currentAudioVolume = typeof volume === 'number' ? volume : 100;
  currentAudioMuted = !!muted;
  applyStreamAudioLevel(); // independent of the YouTube player, so it must not wait for (or be skipped by) the check below
  if(!ytReady || !ytPlayer){ console.warn('[Audio Debug] Screen 2 YT player not ready — storing as pending.'); pendingAudioState = { output, volume, muted }; return; }
  try{
    if(output === 'screen2' && !isLoadingSong){
      console.debug('[Audio Debug] Screen 2 unmuting/setting volume:', currentAudioMuted ? 0 : currentAudioVolume);
      ytPlayer.setVolume(currentAudioMuted ? 0 : currentAudioVolume);
      if(currentAudioMuted) ytPlayer.mute(); else ytPlayer.unMute();
    } else {
      console.debug('[Audio Debug] Screen 2 muting (output is screen1, or currently loading a song).');
      ytPlayer.mute();
      ytPlayer.setVolume(0);
    }
  }catch(e){
    console.error('[Audio Debug] Screen 2 applyAudioFromHost threw:', e);
  }
}

/* ---------------- Ambient "please wait" music during the loading overlay ----------------
   Entirely synthesized in real time via the Web Audio API — no audio file, no copyrighted material
   involved at all. Only actually audible on Screen 2 when it's the current audio-output target. */
let ambientCtx = null;
let ambientNodes = null;
let ambientChordTimer = null;
function ensureAmbientContext(){
  if(!ambientCtx){
    try{ ambientCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){ return null; }
  }
  if(ambientCtx.state === 'suspended'){ ambientCtx.resume().catch(() => {}); }
  return ambientCtx;
}
// Screen 2 has no "start" button of its own, so the very first genuine tap/click anywhere on this
// page (e.g. while setting it up) is the only real user gesture available to unlock Web Audio.
function unlockAmbienceOnFirstGesture(){
  ensureAmbientContext();
  document.removeEventListener('click', unlockAmbienceOnFirstGesture);
  document.removeEventListener('touchstart', unlockAmbienceOnFirstGesture);
}
document.addEventListener('click', unlockAmbienceOnFirstGesture);
document.addEventListener('touchstart', unlockAmbienceOnFirstGesture);
function startLoadingAmbience(){
  const ctx = ensureAmbientContext();
  if(!ctx || ambientNodes) return;
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  master.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 1.2);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1100;
  filter.connect(master);
  const chordSets = [
    [261.63, 329.63, 392.00],
    [220.00, 277.18, 329.63]
  ];
  let oscillators = [];
  let chordIndex = 0;
  function playChord(freqs){
    const oldOscs = oscillators;
    oscillators = [];
    oldOscs.forEach(o => {
      try{
        o.gain.gain.cancelScheduledValues(ctx.currentTime);
        o.gain.gain.setValueAtTime(o.gain.gain.value, ctx.currentTime);
        o.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
        o.osc.stop(ctx.currentTime + 1.6);
      }catch(e){}
    });
    freqs.forEach(freq => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.linearRampToValueAtTime(1 / freqs.length, ctx.currentTime + 1.5);
      osc.connect(g);
      g.connect(filter);
      osc.start();
      oscillators.push({ osc, gain: g });
    });
  }
  playChord(chordSets[chordIndex]);
  ambientChordTimer = setInterval(() => {
    chordIndex = (chordIndex + 1) % chordSets.length;
    playChord(chordSets[chordIndex]);
  }, 4000);
  ambientNodes = { master, get oscillators(){ return oscillators; } };
}
function stopLoadingAmbience(){
  if(!ambientNodes || !ambientCtx) return;
  const ctx = ambientCtx;
  const { master, oscillators } = ambientNodes;
  try{
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
  }catch(e){}
  clearInterval(ambientChordTimer);
  ambientChordTimer = null;
  const oscsToStop = oscillators;
  setTimeout(() => { oscsToStop.forEach(o => { try{ o.osc.stop(); }catch(e){} }); }, 700);
  ambientNodes = null;
}

/* ---------------- YouTube player ---------------- */
let lastLoadedVideoId = null;
let loadingOverlayTimeout = null;
function showLoadingOverlay(song){
  const overlay = document.getElementById('loading-overlay');
  if(!overlay) return;
  document.getElementById('loading-blur-bg').style.backgroundImage = song.thumbnail ? `url("${song.thumbnail}")` : 'none';
  document.getElementById('loading-title').textContent = song.title;
  document.getElementById('loading-by').textContent = song.by ? 'เพิ่มโดย ' + song.by : '';
  overlay.style.display = 'flex';
  isLoadingSong = true;
  applyAudioFromHost(currentAudioOutput, currentAudioVolume, currentAudioMuted); // mute the real player while "loading" (silent — no ambient music, per request)
  clearTimeout(loadingOverlayTimeout);
  clearTimeout(audioRestoreTimeout);
  loadingOverlayTimeout = setTimeout(hideLoadingOverlay, 20000);
}
let audioRestoreTimeout = null;
function hideLoadingOverlay(){
  const overlay = document.getElementById('loading-overlay');
  if(overlay) overlay.style.display = 'none';
  stopLoadingAmbience();
  clearTimeout(loadingOverlayTimeout);
  loadingOverlayTimeout = null;
  clearTimeout(audioRestoreTimeout);
  // Small buffer before actually restoring audio — same reasoning as the host (see its comment).
  audioRestoreTimeout = setTimeout(() => {
    isLoadingSong = false;
    applyAudioFromHost(currentAudioOutput, currentAudioVolume, currentAudioMuted);
  }, 1200);
}

function onYouTubeIframeAPIReady(){
  ytPlayer = new YT.Player('d-player', {
    width: '100%', height: '100%',
    playerVars: { autoplay: 1, playsinline: 1, controls: 0, rel: 0, disablekb: 1, modestbranding: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        console.debug('[S2 Debug] Screen 2 YouTube player onReady fired.');
        // Screen 2 is a silent visual display by default (the host is the audio source), so this
        // player is muted on purpose unless the host has switched audio output to Screen 2.
        if(pendingAudioState) applyAudioFromHost(pendingAudioState.output, pendingAudioState.volume, pendingAudioState.muted);
        else { ytPlayer.mute(); ytPlayer.setVolume(0); }
      },
      onStateChange: (e) => {
        console.debug('[S2 Debug] Screen 2 onStateChange fired, state:', e.data, '(PLAYING=', YT.PlayerState.PLAYING, ')');
        if(e.data === YT.PlayerState.PLAYING) hideLoadingOverlay();
      },
      onError: (e) => {
        console.error('[S2 Debug] Screen 2 YouTube player error:', e.data);
      }
    }
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function applyVideoState(currentId, currentTime){
  const song = myQueue.find(s => s.id === currentId);
  console.debug('[S2 Debug] applyVideoState called. currentId:', currentId, '| song found:', !!song, '| source:', song?.source, '| ytReady:', ytReady, '| ytPlayer exists:', !!ytPlayer, '| lastLoadedVideoId:', lastLoadedVideoId);
  if(!song || song.source === 'local'){
    // Local files only exist on the host device's own file system — Screen 2 has no way to read or
    // play them, so it just clears its player and shows a placeholder (handled in renderDisplay).
    lastLoadedVideoId = null;
    hideLoadingOverlay();
    if(ytReady && ytPlayer){ try{ ytPlayer.stopVideo(); }catch(e){} }
    return;
  }
  if(!ytReady || !ytPlayer){ console.warn('[S2 Debug] YT player not ready on Screen 2 — cannot load video.'); return; }
  if(song.videoId !== lastLoadedVideoId){
    console.debug('[S2 Debug] Loading new video on Screen 2:', song.videoId);
    lastLoadedVideoId = song.videoId;
    showLoadingOverlay(song);
    try{
      ytPlayer.loadVideoById(song.videoId);
      if(typeof currentTime === 'number' && currentTime > 1){
        setTimeout(() => { try{ ytPlayer.seekTo(currentTime, true); }catch(e){} }, 600);
      }
    }catch(e){
      console.error('[S2 Debug] loadVideoById threw an error:', e);
    }
  } else {
    console.debug('[S2 Debug] Same videoId as already loaded — skipping reload.');
  }
}

/* ---------------- Display: now playing / idle / next up ---------------- */
let hasEverPlayed = false; // welcome message only shows before the first song this session; after that, an empty queue shows the blinking prompt instead

// Same right-to-left scrolling ticker as the main screen, at the same font size. Only restarts when
// the song actually changes — renderDisplay() runs every second (for the next-up countdown), so this
// guards against resetting the scroll position on every tick, which would stop it from ever scrolling.
let lastMarqueeSongId = null;
function updateNowPlayingMarquee(song){
  const textEl = document.getElementById('d-np-marquee-text');
  if(!song){
    textEl.style.animation = 'none';
    lastMarqueeSongId = null;
    return;
  }
  if(song.id === lastMarqueeSongId) return;
  lastMarqueeSongId = song.id;
  textEl.textContent = '🎤 กำลังเล่นเพลงนี้: ' + song.title + (song.by ? ' • เพิ่มโดย ' + song.by : '') + (song.dedication ? ' • 💌 ' + song.dedication : '');
  textEl.style.animation = 'none';
  void textEl.offsetWidth; // force reflow so the browser "forgets" the previous animation state
  const duration = Math.max(10, textEl.textContent.length * 0.35);
  textEl.style.animation = `np-marquee-rtl ${duration}s linear infinite`;
}

/* ---------------- Idle background pictures (sent over by the host) ----------------
   Same look as the host's own empty-queue screen. The host only pushes a small list of picture keys
   (BG_SYNC); this page asks for just the ones it doesn't already have (BG_NEED) and the host sends them
   one by one (BG_IMAGE). Timing and order come from the host's settings. Kept in memory only, so a
   reload of this page simply fetches them again. */
const s2Bg = { keys: [], urls: new Map(), intervalSec: 10, order: 'seq', active: false, currentKey: null, timer: null, showingA: true };
function s2BgAvailable(){ return s2Bg.keys.filter(k => s2Bg.urls.has(k)); }
function s2BgShow(key){
  const a = document.getElementById('d-idle-bg-a');
  const b = document.getElementById('d-idle-bg-b');
  const next = s2Bg.showingA ? b : a;
  const prev = s2Bg.showingA ? a : b;
  next.style.backgroundImage = `url("${s2Bg.urls.get(key)}")`;
  next.classList.add('visible');
  prev.classList.remove('visible');
  s2Bg.showingA = !s2Bg.showingA;
  s2Bg.currentKey = key;
}
function s2BgAdvance(){
  if(!s2Bg.active) return;
  const avail = s2BgAvailable();
  if(avail.length < 2) return;
  const cur = avail.indexOf(s2Bg.currentKey);
  let next;
  if(s2Bg.order === 'random'){
    do{ next = Math.floor(Math.random() * avail.length); }while(next === cur);
  } else {
    next = (cur + 1) % avail.length;
  }
  s2BgShow(avail[next]);
}
// Idempotent — called every second from renderDisplay() and after every message that changes anything.
function s2BgSync(){
  const idle = document.getElementById('d-idle');
  const avail = s2BgAvailable();
  const show = s2Bg.active && avail.length > 0;
  idle.classList.toggle('has-custom-bg', show);
  if(avail.length === 0 && s2Bg.currentKey){
    s2Bg.currentKey = null;
    ['d-idle-bg-a', 'd-idle-bg-b'].forEach(id => {
      const el = document.getElementById(id);
      el.classList.remove('visible');
      el.style.backgroundImage = '';
    });
  }
  if(!show || idle.classList.contains('has-camera')){ // nothing to show, or the live camera is covering it for now
    if(s2Bg.timer){ clearInterval(s2Bg.timer); s2Bg.timer = null; }
    return;
  }
  if(!s2Bg.currentKey || !avail.includes(s2Bg.currentKey)){
    s2BgShow(s2Bg.order === 'random' ? avail[Math.floor(Math.random() * avail.length)] : avail[0]);
  }
  if(avail.length > 1){
    if(!s2Bg.timer) s2Bg.timer = setInterval(s2BgAdvance, s2Bg.intervalSec * 1000);
  } else if(s2Bg.timer){
    clearInterval(s2Bg.timer); s2Bg.timer = null;
  }
}
function s2BgSetActive(active){
  s2Bg.active = !!active;
  s2BgSync();
}
function s2BgOnSync(msg){
  const keys = Array.isArray(msg.keys) ? msg.keys.filter(k => typeof k === 'string').slice(0, 40) : [];
  const iv = Number(msg.intervalSec);
  const newInterval = (iv >= 3 && iv <= 3600) ? iv : 10;
  if(newInterval !== s2Bg.intervalSec && s2Bg.timer){ clearInterval(s2Bg.timer); s2Bg.timer = null; } // restart with the new timing
  s2Bg.keys = keys;
  s2Bg.intervalSec = newInterval;
  s2Bg.order = msg.order === 'random' ? 'random' : 'seq';
  for(const [k, url] of [...s2Bg.urls]){ // forget pictures the host no longer has
    if(!keys.includes(k)){ URL.revokeObjectURL(url); s2Bg.urls.delete(k); }
  }
  const need = keys.filter(k => !s2Bg.urls.has(k));
  if(need.length && conn && conn.open) conn.send({ type: 'BG_NEED', keys: need });
  s2BgSync();
}
function s2BgOnImage(msg){
  if(typeof msg.key !== 'string' || !msg.data) return;
  if(!s2Bg.keys.includes(msg.key) || s2Bg.urls.has(msg.key)) return; // removed in the meantime, or a duplicate
  const mime = (typeof msg.mime === 'string' && msg.mime.indexOf('image/') === 0) ? msg.mime : 'image/jpeg';
  s2Bg.urls.set(msg.key, URL.createObjectURL(new Blob([msg.data], { type: mime })));
  s2BgSync();
}

/* ---------------- Live camera (sent over by the host) ----------------
   Same places as on the host: full-screen on the idle screen, behind the MP3 lyrics, and a small window at the
   top-left while a video plays. The host decides whether to send it at all (its per-screen switch); here we only
   have to show what arrives, and quietly go back to the normal background the moment it stops arriving. */
const s2Cam = { stream: null, call: null, source: 'slides', mirror: false, pip: true };
function s2CamContext(){
  const song = myQueue.find(s => s.id === myCurrentId);
  if(!song) return 'idle';
  if(song.source === 'local' && s2Mp3Data && s2Mp3Data.songId === song.id) return 'mp3';
  return 'video';
}
function s2CamLive(){
  const track = s2Cam.stream && s2Cam.stream.getVideoTracks()[0];
  return !!track && track.readyState === 'live';
}
// Idempotent — called every second from renderDisplay() and whenever the camera / its settings change.
function s2CamRender(){
  const ctx = s2CamContext();
  const show = s2Cam.source === 'camera' && s2CamLive() && (ctx !== 'video' || s2Cam.pip);
  const idleOn = show && ctx === 'idle', mp3On = show && ctx === 'mp3', pipOn = show && ctx === 'video';
  const attach = (id, on) => {
    const el = document.getElementById(id);
    if(!el) return;
    if(on){
      if(el.srcObject !== s2Cam.stream) el.srcObject = s2Cam.stream;
      const p = el.play(); if(p && p.catch) p.catch(() => {});
    } else if(el.srcObject){
      el.srcObject = null;
    }
  };
  document.getElementById('d-idle').classList.toggle('has-camera', idleOn);
  document.getElementById('mp3-now-playing').classList.toggle('has-camera', mp3On);
  document.getElementById('s2-cam-pip').style.display = pipOn ? 'block' : 'none';
  attach('s2-idle-cam', idleOn); attach('s2-mp3-cam', mp3On); attach('s2-cam-pip-video', pipOn);
  document.body.classList.toggle('cam-mirror', s2Cam.mirror);
  s2BgSync(); // the slideshow steps aside while the camera covers the idle screen, and resumes when it doesn't
}
function s2CamOnConfig(msg){
  s2Cam.source = msg.source === 'camera' ? 'camera' : 'slides';
  s2Cam.mirror = !!msg.mirror;
  s2Cam.pip = msg.pip !== false;
  if(s2Cam.source !== 'camera' && s2Cam.call){ try{ s2Cam.call.close(); }catch(e){} s2Cam.call = null; s2Cam.stream = null; }
  s2CamRender();
  s2CamStatsSync();
}

/* Reports how the camera picture is arriving (frame rate, buffering, decode time, route) back to the main screen every
   few seconds while it is — shown in the main screen's Settings, so a delayed picture can be traced to its cause.
   Same statistics reader as the main screen's (the two pages share no code). */
function camSummarizeStats(report, prev){
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const all = [], byId = new Map();
  report.forEach(r => { all.push(r); byId.set(r.id, r); });
  const isVideo = r => (r.kind || r.mediaType) === 'video';
  const outV = all.find(r => r.type === 'outbound-rtp' && isVideo(r)) || null;
  const inV = all.find(r => r.type === 'inbound-rtp' && isVideo(r)) || null;
  const transport = all.find(r => r.type === 'transport' && r.selectedCandidatePairId);
  const pair = (transport && byId.get(transport.selectedCandidatePairId))
    || all.find(r => r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') || null;
  const next = {}, result = { out: null, in: null, route: null };
  const avg = (curNum, curDen, prevNum, prevDen) => (prev && curDen != null && prevDen != null && curNum != null && prevNum != null && curDen > prevDen)
    ? (curNum - prevNum) / (curDen - prevDen) * 1000 : null; // average per frame since the previous reading, in ms
  if(outV){
    next.encTime = num(outV.totalEncodeTime); next.encFrames = num(outV.framesEncoded);
    result.out = { w: num(outV.frameWidth), h: num(outV.frameHeight), fps: num(outV.framesPerSecond),
      limit: outV.qualityLimitationReason || 'none', encodeMs: avg(next.encTime, next.encFrames, prev && prev.encTime, prev && prev.encFrames) };
  }
  if(inV){
    next.jbDelay = num(inV.jitterBufferDelay); next.jbCount = num(inV.jitterBufferEmittedCount);
    next.decTime = num(inV.totalDecodeTime); next.decFrames = num(inV.framesDecoded);
    next.lost = num(inV.packetsLost); next.recv = num(inV.packetsReceived);
    let lossPct = null;
    if(prev && prev.recv != null && next.recv != null){
      const got = next.recv - prev.recv, lost = Math.max(0, (next.lost || 0) - (prev.lost || 0));
      if(got + lost > 0) lossPct = lost / (got + lost) * 100;
    }
    result.in = { w: num(inV.frameWidth), h: num(inV.frameHeight), fps: num(inV.framesPerSecond), dropped: num(inV.framesDropped), lossPct,
      jbMs: avg(next.jbDelay, next.jbCount, prev && prev.jbDelay, prev && prev.jbCount),
      decodeMs: avg(next.decTime, next.decFrames, prev && prev.decTime, prev && prev.decFrames) };
  }
  if(pair){
    const lt = (byId.get(pair.localCandidateId) || {}).candidateType, rt = (byId.get(pair.remoteCandidateId) || {}).candidateType;
    result.route = { kind: (lt === 'relay' || rt === 'relay') ? 'relay' : ((lt || rt) ? 'direct' : 'unknown'),
      rttMs: num(pair.currentRoundTripTime) != null ? pair.currentRoundTripTime * 1000 : null };
  }
  return { result, next };
}
let s2CamStatsTimer = null, s2CamStatsPrev = null;
async function s2CamStatsPoll(){
  const call = s2Cam.call;
  if(!call || !call.peerConnection || !conn || !conn.open) return;
  try{
    const report = await call.peerConnection.getStats();
    if(s2Cam.call !== call) return; // the call ended while the reading was in flight
    const { result, next } = camSummarizeStats(report, s2CamStatsPrev);
    s2CamStatsPrev = next;
    if(conn && conn.open) conn.send({ type: 'CAM_STATS', in: result.in, route: result.route });
  }catch(e){}
}
function s2CamStatsSync(){ // only while a picture is actually arriving
  const live = !!(s2Cam.call && s2Cam.stream);
  if(live && !s2CamStatsTimer){ s2CamStatsTimer = setInterval(s2CamStatsPoll, 3000); }
  else if(!live && s2CamStatsTimer){ clearInterval(s2CamStatsTimer); s2CamStatsTimer = null; s2CamStatsPrev = null; }
}

function renderDisplay(){
  const song = myQueue.find(s => s.id === myCurrentId);
  const idle = document.getElementById('d-idle');
  const npBar = document.getElementById('d-now-playing');
  const nextBar = document.getElementById('d-next-up');
  const idleTitle = document.querySelector('#d-idle .display:not(.empty-queue-blink)');
  const idleDesc = document.querySelector('#d-idle p');
  const emptyMsg = document.getElementById('d-empty-queue-msg');

  if(song) hasEverPlayed = true;
  s2BgSetActive(!song); // pictures only while the queue is empty — not over a song, nor the "playing on the main screen" note
  s2CamRender();

  if(song && song.source === 'local'){
    if(s2Mp3Data && s2Mp3Data.songId === song.id){
      // The host sent over lyrics/cover/timing for this exact song — show the same word-by-word
      // karaoke screen the host itself displays, instead of the generic "can't play this here" note.
      idle.style.display = 'none';
      document.getElementById('mp3-now-playing').style.display = 'flex';
      document.getElementById('mp3-code').textContent = s2Mp3Data.code || song.title;
      const titleRow = document.getElementById('mp3-title-row');
      const artistRow = document.getElementById('mp3-artist-row');
      if(s2Mp3Data.title){ document.getElementById('mp3-title').textContent = s2Mp3Data.title; titleRow.style.display = 'flex'; }
      else { titleRow.style.display = 'none'; }
      if(s2Mp3Data.artist){ document.getElementById('mp3-artist').textContent = s2Mp3Data.artist; artistRow.style.display = 'flex'; }
      else { artistRow.style.display = 'none'; }
      const bg = document.getElementById('mp3-bg');
      bg.classList.remove('has-cover', 'pattern-1', 'pattern-2', 'pattern-3', 'pattern-4', 'pattern-5');
      if(s2Mp3Data.coverDataUrl){
        bg.style.backgroundImage = `url("${s2Mp3Data.coverDataUrl}")`;
        bg.classList.add('has-cover');
      } else {
        bg.style.backgroundImage = '';
        if(s2Mp3Data.bgPattern) bg.classList.add(s2Mp3Data.bgPattern); // same pattern the host picked for this exact file
      }
      document.getElementById('mp3-lyrics').style.display = s2Mp3Data.lines ? 'flex' : 'none';
      npBar.style.display = 'block';
      updateNowPlayingMarquee(song);
      nextBar.style.display = 'none';
      return;
    }
    document.getElementById('mp3-now-playing').style.display = 'none';
    // Local files only exist on the host's own file system — Screen 2 can't read or play them, so it
    // shows a friendly placeholder with the song title while the audio/video plays on the host itself.
    idle.style.display = 'flex';
    idleTitle.style.display = '';
    idleDesc.style.display = '';
    emptyMsg.style.display = 'none';
    idleTitle.innerHTML = '🔊 กำลังเล่นจากอุปกรณ์ที่จอหลัก';
    idleDesc.textContent = 'ไฟล์เพลงในเครื่องเล่นได้เฉพาะที่จอหลักเท่านั้น';
    npBar.style.display = 'block';
    updateNowPlayingMarquee(song);
    nextBar.style.display = 'none'; // no reliable playback-position info available for local files here
    return;
  }
  document.getElementById('mp3-now-playing').style.display = 'none';
  idleTitle.innerHTML = 'รอเพลงถัดไป... <span>Sri Karaoke</span>';
  idleDesc.textContent = 'ยังไม่มีเพลงเล่นอยู่ตอนนี้ — เพลงจะขึ้นแสดงที่นี่โดยอัตโนมัติ';

  if(song){
    idle.style.display = 'none';
    npBar.style.display = 'block';
    updateNowPlayingMarquee(song);

    const idx = myQueue.findIndex(s => s.id === myCurrentId);
    const upcoming = idx > -1 ? myQueue[idx + 1] : null;
    let showNext = false, remaining = Infinity;
    if(ytReady && ytPlayer){
      try{
        const duration = ytPlayer.getDuration() || 0;
        const curTime = ytPlayer.getCurrentTime() || 0;
        remaining = duration - curTime;
        showNext = !!duration && remaining <= NEXT_UP_WINDOW_SECONDS && remaining >= 0;
      }catch(e){}
    }
    if(showNext){
      if(upcoming){
        nextBar.classList.remove('warn');
        document.getElementById('d-next-title').textContent = upcoming.title;
      } else {
        nextBar.classList.add('warn');
        document.getElementById('d-next-title').textContent = '⚠️ ไม่มีเพลงในคิว...กรุณาเลือกเพลง';
      }
      nextBar.style.display = 'block';
    } else {
      nextBar.style.display = 'none';
    }
  } else {
    idle.style.display = 'flex';
    npBar.style.display = 'none';
    nextBar.style.display = 'none';
    updateNowPlayingMarquee(null);
    if(hasEverPlayed){
      idleTitle.style.display = 'none';
      idleDesc.style.display = 'none';
      emptyMsg.style.display = 'block';
    } else {
      idleTitle.style.display = '';
      idleDesc.style.display = '';
      emptyMsg.style.display = 'none';
    }
  }
}
setInterval(renderDisplay, 1000);

/* ---------------- Chords (mirrors the host's chord bar, using this page's own YouTube player for timing) ---------------- */
function renderChordBar(){
  const bar = document.getElementById('d-chord-bar');
  const track = document.getElementById('d-chord-track');
  const nextBar = document.getElementById('d-next-up');
  if(!bar || !track) return;
  const song = myQueue.find(s => s.id === myCurrentId);
  const key = songChordKey(song);
  const entry = key ? myChords[key] : null;
  if(!song || !entry || !entry.timeline || entry.timeline.length === 0){
    bar.style.display = 'none';
    if(nextBar) nextBar.style.top = '0';
    return;
  }
  let curTime = 0, duration = 0;
  if(ytReady && ytPlayer){
    try{ curTime = ytPlayer.getCurrentTime() || 0; duration = ytPlayer.getDuration() || 0; }catch(e){}
  }
  const timeline = entry.timeline;
  const totalSpan = Math.max(duration || 0, timeline[timeline.length - 1].t + 8);

  if(track.dataset.forKey !== key){
    track.dataset.forKey = key;
    track.innerHTML = timeline.map((c, i) => {
      const start = c.t;
      const end = (i < timeline.length - 1) ? timeline[i + 1].t : totalSpan;
      const leftPct = (start / totalSpan) * 100;
      const widthPct = Math.max(0, ((end - start) / totalSpan) * 100);
      return `<div class="chord-segment" data-idx="${i}" style="left:${leftPct}%;width:${widthPct}%;">${escapeHtml(c.chord)}</div>`;
    }).join('');
  }

  let idx = -1;
  for(let i = 0; i < timeline.length; i++){
    if(timeline[i].t <= curTime) idx = i; else break;
  }
  if(idx === -1){ bar.style.display = 'none'; if(nextBar) nextBar.style.top = '0'; return; }
  track.querySelectorAll('.chord-segment').forEach(el => {
    el.classList.toggle('current', parseInt(el.dataset.idx, 10) === idx);
  });
  bar.style.display = 'block';
  if(nextBar) nextBar.style.top = '52px';
}
setInterval(renderChordBar, 500);

/* ---------------- Singing score popup (mirrors host/remote) ---------------- */
let scorePopupTimer = null;
function scoreTier(score){
  if(score >= 95) return { label: 'เพอร์เฟค!', color: '#FFD700' };
  if(score >= 85) return { label: 'ยอดเยี่ยม!', color: '#FFC857' };
  if(score >= 70) return { label: 'เก่งมาก!', color: '#2EE6D6' };
  return { label: 'พยายามได้ดี!', color: '#FF3D81' };
}
// A single floating emoji — the host forwards one here whenever anyone (itself or a remote) sends one.
function showEmojiReaction(emoji){
  const el = document.createElement('div');
  el.className = 'emoji-reaction';
  el.textContent = emoji || '👍';
  el.style.left = (20 + Math.random() * 60) + '%';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// A lightweight, dependency-free confetti burst — plain DOM + CSS animation, no canvas or library.
function launchConfetti(){
  const container = document.createElement('div');
  container.className = 'confetti-container';
  const colors = ['#FFC857', '#FF3D81', '#2EE6D6', '#FFD700', '#ffffff'];
  for(let i = 0; i < 70; i++){
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = (Math.random() * 100) + '%';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = (Math.random() * 0.4) + 's';
    piece.style.animationDuration = (2.6 + Math.random() * 1.6) + 's';
    piece.style.setProperty('--rot', (Math.random() * 360) + 'deg');
    container.appendChild(piece);
  }
  document.body.appendChild(container);
  setTimeout(() => container.remove(), 4600);
}

function showScorePopup(entry, leaderboard){
  const overlay = document.getElementById('score-popup-overlay');
  const box = document.getElementById('score-popup-box');
  const tier = scoreTier(entry.score);
  box.innerHTML = `
    <div class="score-stage-title">🎤 คะแนนร้องเพลง</div>
    <div class="score-singer">${escapeHtml(entry.by || 'ไม่ระบุชื่อ')}</div>
    <div class="score-song">${escapeHtml(entry.title)}</div>
    <div class="score-number" style="color:${tier.color}">${entry.score}</div>
    <div class="score-tier" style="color:${tier.color}">${tier.label}</div>`;
  overlay.style.display = 'flex';
  if(entry.score >= 90) launchConfetti();
  clearTimeout(scorePopupTimer);
  scorePopupTimer = setTimeout(() => showLeaderboardPopup(leaderboard), 3500);
}
function showLeaderboardPopup(leaderboard){
  const overlay = document.getElementById('score-popup-overlay');
  const box = document.getElementById('score-popup-box');
  box.innerHTML = `
    <div class="score-stage-title">🏆 5 อันดับคะแนนสูงสุด</div>
    <div class="leaderboard-list">
      ${(leaderboard || []).map((e, i) => `
        <div class="lb-row">
          <span class="lb-rank">${i + 1}</span>
          <div class="lb-info">
            <div class="lb-name">${escapeHtml(e.by || 'ไม่ระบุชื่อ')}</div>
            <div class="lb-song">${escapeHtml(e.title)}</div>
          </div>
          <span class="lb-score">${e.score}</span>
        </div>`).join('')}
    </div>`;
  overlay.style.display = 'flex';
  clearTimeout(scorePopupTimer);
  scorePopupTimer = setTimeout(() => { overlay.style.display = 'none'; }, 4500);
}

/* ---------------- Connect screen wiring ---------------- */
document.getElementById('btn-connect').onclick = () => {
  let code = document.getElementById('room-input').value.trim().toUpperCase();
  if(!code) return;
  const roomId = code.startsWith('SRIKARAOKE-') ? code.toLowerCase() : 'srikaraoke-' + code;
  const pin = document.getElementById('pin-input').value.trim();
  connectToRoom(roomId, pin);
};

(function autoConnect(){
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room') || localStorage.getItem(STORAGE_ROOMID);
  const pin = params.get('pin') || localStorage.getItem(STORAGE_PIN) || '';
  if(room){
    document.getElementById('room-input').value = room.replace('srikaraoke-', '').toUpperCase();
    document.getElementById('pin-input').value = pin;
    connectToRoom(room, pin);
  }
})();

// Service worker — this was missing entirely on Screen 2 (present on the host and remote pages, but
// never here), which is very likely exactly why Screen 2 specifically could not be installed as a PWA
// on some devices: without an active service worker, this page fails the standard installability
// criteria regardless of how correct manifest-screen2.json itself is.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed', err));
  });
}
