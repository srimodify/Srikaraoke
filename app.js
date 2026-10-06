/* ===========================================================
   Sri Karaoke — จอหลัก (Host / TV)
   =========================================================== */

const STORAGE_PLAYLISTS = 'sriKaraoke_playlists';
const STORAGE_APIKEY = 'sriKaraoke_ytApiKey';
// Default YouTube Data API key so search-by-keyword works out of the box.
// Can still be changed any time from the search modal's "ตั้งค่า API Key" field.
// Base64-encoded, not plaintext, so this doesn't get flagged/revoked by automated secret-scanners if
// this source is ever pushed to a public repo. This is light obfuscation, not real security — anyone
// who opens the browser's network tab or devtools can still recover the key, same as any client-side
// code. Decoded once at load time below.
const DEFAULT_API_KEY_B64 = 'QUl6YVN5Qmc1aHBsYXY3SHpJSGZYb0RXbHdaZUVOdlE3bmI1aTZZ';
const DEFAULT_API_KEY = atob(DEFAULT_API_KEY_B64);
function getApiKey(){
  const stored = localStorage.getItem(STORAGE_APIKEY);
  return stored !== null ? stored : DEFAULT_API_KEY;
}
function setApiKey(key){ localStorage.setItem(STORAGE_APIKEY, key); }
const STORAGE_HISTORY = 'sriKaraoke_history';
const STORAGE_SCORES = 'sriKaraoke_scores';
const STORAGE_CHORDS = 'sriKaraoke_chords';
const TEMPO_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
// A simple original placeholder icon (a music note on a solid circle) for songs added from the
// device's own files, which have no real thumbnail like YouTube search results do.
const LOCAL_FILE_THUMB = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="%23241C42"/><path d="M26 42a6 6 0 1 1-2-4.5V16l18-4v20.5a6 6 0 1 1-4-5.6V16.8l-10 2.2V42a6 6 0 0 1-2 0z" fill="%23FFC857"/></svg>'
);

const state = {
  queue: [],          // [{id, videoId, title, thumbnail, by}]
  currentId: null,    // id of the song currently loaded/playing
  isPlaying: false,
  tempo: 1,
  volume: 80,
  muted: false,
  playlists: loadPlaylists(),
  history: loadHistory(),
  scores: loadScores(),
  pinEnabled: false,
  pin: '',
  fairQueueMode: sessionStorage.getItem('sriKaraoke_fairMode') === '1',
  screen2Enabled: sessionStorage.getItem('sriKaraoke_screen2Enabled') === '1',
  audioOutput: sessionStorage.getItem('sriKaraoke_audioOutput') || 'screen1',
  scoringEnabled: sessionStorage.getItem('sriKaraoke_scoringEnabled') !== '0',
  channelMode: ['stereo', 'LL', 'RR'].includes(sessionStorage.getItem('sriKaraoke_channelMode')) ? sessionStorage.getItem('sriKaraoke_channelMode') : 'stereo',
  localLibrary: [],
  chords: loadChords()
};

let ytPlayer = null;
let ytReady = false;
let localPlayer = null; // <video> element used for songs from the device's own file system
// Web Audio routing for local files (channel mode + sending to Screen 2) — built lazily, see "Local-file audio routing" below
let localGraph = null;          // { ctx, source, router, toHost, toStream, streamDest } once built
let localGraphBuilding = null;  // promise while it's being built, so concurrent callers share one attempt
let localAudioBroken = false;   // true if the player can't be (or has been left un-) routed: stop trying
let localGraphLastFail = 0;     // timestamp of the last failed attempt, to avoid hammering on every audio update
const localStreamCalls = new Map(); // Screen 2's peer id -> the live audio MediaConnection we're sending it
let audioLatencyMs = parseInt(localStorage.getItem('sriKaraoke_audioLatencyMs') || '250', 10);
if(!(audioLatencyMs >= 0 && audioLatencyMs <= 2000)) audioLatencyMs = 250;
const localFiles = new Map(); // localFileId -> File object (kept in memory only, this device/session only)
let peer = null;
const connections = []; // connected remote controllers
let dragSrcId = null;

/* ---------------- Utilities ---------------- */
function uid(){ return Math.random().toString(36).slice(2, 10); }

function roomCode(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for(let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function loadPlaylists(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_PLAYLISTS)) || {}; }
  catch(e){ return {}; }
}
function savePlaylists(){ localStorage.setItem(STORAGE_PLAYLISTS, JSON.stringify(state.playlists)); }

function loadHistory(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_HISTORY)) || []; }
  catch(e){ return []; }
}
function saveHistory(){ localStorage.setItem(STORAGE_HISTORY, JSON.stringify(state.history)); }

function loadScores(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_SCORES)) || []; }
  catch(e){ return []; }
}
function saveScores(){ localStorage.setItem(STORAGE_SCORES, JSON.stringify(state.scores)); }

function loadChords(){
  try{
    const parsed = JSON.parse(localStorage.getItem(STORAGE_CHORDS));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  }catch(e){ return {}; }
}
function saveChordsStorage(){ localStorage.setItem(STORAGE_CHORDS, JSON.stringify(state.chords)); }
// Chords are keyed per-song using whichever identifier that song actually has, so YouTube songs and
// local-file songs never collide with each other in the same chord library.
function songChordKey(song){
  if(!song) return null;
  return song.source === 'local' ? 'local:' + song.localFileId : 'yt:' + song.videoId;
}

function addToHistory(song, reason){
  state.history.unshift({
    id: uid(), source: song.source || 'youtube', videoId: song.videoId, localFileId: song.localFileId,
    title: song.title, thumbnail: song.thumbnail,
    by: song.by || '', reason: reason || '', playedAt: Date.now()
  });
  if(state.history.length > 200) state.history.length = 200;
  saveHistory();
}

/* ---------------- Singing score (random, for fun) ---------------- */
let scorePopupTimer = null;

function randomScore(){ return Math.floor(60 + Math.random() * 41); } // 60–100
function scoreTier(score){
  if(score >= 95) return { label: 'เพอร์เฟค!', color: '#FFD700' };
  if(score >= 85) return { label: 'ยอดเยี่ยม!', color: '#FFC857' };
  if(score >= 70) return { label: 'เก่งมาก!', color: '#2EE6D6' };
  return { label: 'พยายามได้ดี!', color: '#FF3D81' };
}

function recordAndShowScore(song){
  if(!state.scoringEnabled) return;
  const score = randomScore();
  const entry = { id: uid(), title: song.title, by: song.by || '', score, at: Date.now() };
  state.scores.unshift(entry);
  if(state.scores.length > 500) state.scores.length = 500;
  saveScores();
  const leaderboard = [...state.scores].sort((a, b) => b.score - a.score).slice(0, 5);
  showScorePopup(entry);
  // Let everyone's phone flash the result too, not just the shared screen.
  connections.forEach(conn => { if(conn.open) conn.send({ type: 'SCORE_ANNOUNCE', entry, leaderboard }); });
}

// A single floating 👍 — triggered by the host's own button, or forwarded here whenever a remote
// sends one. Broadcast onward to connections (Screen 2 included) so the reaction shows on every
// shared display, not just whichever one it originated from.
const EMOJI_REACTIONS = ['👍','🔥','❤️','👏','🎉','💯','🍻','💞','🤘','🫶','😍','😮','😁','😂','😜','🤫','🥱','🤭','🎊','🫰','💤','🌹','🎂','🎄','🪼','🐧'];
function showEmojiReaction(emoji){
  const el = document.createElement('div');
  el.className = 'emoji-reaction';
  el.textContent = emoji || '👍';
  el.style.left = (20 + Math.random() * 60) + '%';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
function renderEmojiGrid(){
  const grid = document.getElementById('emoji-grid');
  grid.innerHTML = '';
  EMOJI_REACTIONS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = emoji;
    btn.onclick = () => {
      showEmojiReaction(emoji);
      connections.forEach(c => { if(c.open) c.send({ type: 'EMOJI_REACTION', emoji }); });
    };
    grid.appendChild(btn);
  });
}
renderEmojiGrid();
document.getElementById('btn-emoji-toggle').onclick = () => {
  const panel = document.getElementById('emoji-panel');
  const shown = panel.style.display !== 'none';
  panel.style.display = shown ? 'none' : 'flex';
};
// A dedicated close button inside the panel itself — the header toggle button that normally opens/
// closes this panel can be hidden (the ▲/▼ "hide menu" control), which would otherwise leave no way
// to close the panel at all once it's open.
document.getElementById('btn-emoji-panel-close').onclick = () => {
  document.getElementById('emoji-panel').style.display = 'none';
};

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

function showScorePopup(entry){
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
  scorePopupTimer = setTimeout(() => {
    const leaderboard = [...state.scores].sort((a, b) => b.score - a.score).slice(0, 5);
    showLeaderboardPopup(leaderboard);
  }, 3500);
}

function showLeaderboardPopup(leaderboard){
  const overlay = document.getElementById('score-popup-overlay');
  const box = document.getElementById('score-popup-box');
  box.innerHTML = `
    <div class="score-stage-title">🏆 5 อันดับคะแนนสูงสุด</div>
    <div class="leaderboard-list">
      ${leaderboard.map((e, i) => `
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
  scorePopupTimer = setTimeout(hideScorePopup, 4500);
}

function hideScorePopup(){
  clearTimeout(scorePopupTimer);
  document.getElementById('score-popup-overlay').style.display = 'none';
}
document.getElementById('score-popup-overlay').addEventListener('click', hideScorePopup);

function formatTimeAgo(ts){
  const diff = Math.floor((Date.now() - ts) / 1000);
  if(diff < 60) return 'เมื่อสักครู่';
  if(diff < 3600) return Math.floor(diff / 60) + ' นาทีที่แล้ว';
  if(diff < 86400) return Math.floor(diff / 3600) + ' ชั่วโมงที่แล้ว';
  return Math.floor(diff / 86400) + ' วันที่แล้ว';
}

// Central place where "what's currently playing" changes, so history always gets recorded consistently.
function recordAndSetCurrent(prevSongObj, newId, reason){
  if(prevSongObj) addToHistory(prevSongObj, reason);
  state.currentId = newId;
  if(newId){
    const song = state.queue.find(s => s.id === newId);
    if(song) loadSongIntoPlayer(song);
  } else {
    stopPlayer();
  }
  clearVotes(); // "vote for next song" only makes sense relative to whatever is playing now
  renderQueue();
}

// Switches between the YouTube iframe and the local <video> element depending on the song's
// source, and loads/plays the song on whichever one applies.

let isLoadingSong = false;
let loadingOverlayTimeout = null;
function showLoadingOverlay(song){
  const overlay = document.getElementById('loading-overlay');
  if(!overlay) return;
  document.getElementById('loading-blur-bg').style.backgroundImage = song.thumbnail ? `url("${song.thumbnail}")` : 'none';
  document.getElementById('loading-title').textContent = song.title;
  document.getElementById('loading-by').textContent = song.by ? 'เพิ่มโดย ' + song.by : '';
  overlay.style.display = 'flex';
  isLoadingSong = true;
  applyAudioOutput(); // mutes the real player so any pre-roll ad audio stays silent
  clearTimeout(loadingOverlayTimeout);
  clearTimeout(audioRestoreTimeout);
  // Safety net: if the "playing" event never fires for some reason, don't leave this stuck forever.
  loadingOverlayTimeout = setTimeout(hideLoadingOverlay, 20000);
}
let audioRestoreTimeout = null;
function hideLoadingOverlay(){
  const overlay = document.getElementById('loading-overlay');
  if(overlay) overlay.style.display = 'none';
  clearTimeout(loadingOverlayTimeout);
  loadingOverlayTimeout = null;
  clearTimeout(audioRestoreTimeout);
  // Small buffer before actually restoring audio: YouTube's "PLAYING" state can fire as soon as a
  // pre-roll ad itself starts (not only for the real song), so unmuting a beat later reduces — though
  // can't fully guarantee eliminating, since the embedding page has no real way to tell ad from
  // content apart — the chance of catching the tail of an ad's audio right at that transition.
  audioRestoreTimeout = setTimeout(() => {
    isLoadingSong = false;
    applyAudioOutput();
  }, 1200);
}

function loadSongIntoPlayer(song){
  const ytWrap = document.getElementById('player');
  showLoadingOverlay(song);
  if(song.source === 'local'){
    const file = localFiles.get(song.localFileId);
    if(!file){
      showToast(`ไม่พบไฟล์ "${song.title}" ในเครื่อง (อาจยังไม่ได้เลือกโฟลเดอร์ในเซสชันนี้) — ข้ามไปเพลงถัดไป`, true);
      skip('ไฟล์หายไป');
      return;
    }
    if(ytWrap) ytWrap.style.display = 'none';
    // mute() first for instant silence — stopVideo() alone can take a brief moment to actually cut
    // the audio, which is exactly the overlap window this is meant to close.
    if(ytPlayer){ try{ ytPlayer.mute(); ytPlayer.pauseVideo(); ytPlayer.stopVideo(); }catch(e){} }
    if(localPlayer){
      localPlayer.style.display = 'block';
      const url = URL.createObjectURL(file);
      localPlayer.src = url;
      localPlayer.playbackRate = state.tempo;
      prepareLocalElementAudio(); // volume/mute + (if needed) the channel-mode / Screen 2 routing
      localPlayer.play().catch(() => {});
    }
    state.isPlaying = true;
    if(isAudioOnlyFile(file.name)){
      localPlayer.style.display = 'none'; // no visual content — the MP3 screen covers this space instead
      loadMp3LyricsForSong(song);
    } else {
      hideMp3NowPlaying();
    }
  } else {
    console.debug('[YT Debug] Loading YouTube video:', song.videoId, '| ytReady:', ytReady, '| ytPlayer exists:', !!ytPlayer);
    if(localPlayer){ localPlayer.pause(); localPlayer.removeAttribute('src'); localPlayer.load(); localPlayer.style.display = 'none'; }
    if(ytWrap) ytWrap.style.display = '';
    if(ytReady && ytPlayer){
      ytPlayer.loadVideoById(song.videoId);
      ytPlayer.setPlaybackRate(state.tempo);
      state.isPlaying = true;
    } else {
      console.warn('[YT Debug] YouTube player was not ready — video will not load. ytReady:', ytReady, 'ytPlayer:', ytPlayer);
      // The YouTube IFrame API script itself (loaded from youtube.com) can fail or take unusually
      // long to load — a flaky connection, a firewall/network restriction, or an ad-blocker are the
      // most common causes, and none of them are something this page can fix on its own. Rather than
      // silently doing nothing (which just looks like the app is broken), keep checking for a while
      // and load the song the moment the player does become ready, while telling the operator what's
      // actually going on in the meantime.
      showToast('⚠️ ยังเชื่อมต่อ YouTube ไม่สำเร็จ กำลังลองใหม่... (ตรวจสอบอินเทอร์เน็ต/ตัวบล็อกโฆษณาถ้ายังไม่ขึ้น)', true);
      waitForYouTubePlayerThenRetry(song);
    }
    hideMp3NowPlaying();
  }
  applyAudioOutput(); // final step: makes sure the "muted while loading" state actually takes effect,
                       // overriding whatever volume/mute the branch above just set
}

// Guards the retry loop below so an older attempt can't fire after the operator has already moved on
// to a different song (skipped, picked something else, etc.) while still waiting for YouTube.
let ytRetryToken = 0;
function waitForYouTubePlayerThenRetry(song){
  const myToken = ++ytRetryToken;
  const startedAt = Date.now();
  const timeoutMs = 20000;
  const check = () => {
    if(myToken !== ytRetryToken) return; // a different song was requested meanwhile — stop retrying this one
    if(currentSong()?.id !== song.id) return; // the operator moved on — nothing left to retry into
    if(ytReady && ytPlayer){
      console.debug('[YT Debug] YouTube player became ready — loading the pending video now:', song.videoId);
      try{
        ytPlayer.loadVideoById(song.videoId);
        ytPlayer.setPlaybackRate(state.tempo);
        state.isPlaying = true;
        showToast('✅ เชื่อมต่อ YouTube สำเร็จแล้ว กำลังเล่น "' + song.title + '"');
      }catch(e){ console.error('[YT Debug] Retry load failed:', e); }
      return;
    }
    if(Date.now() - startedAt > timeoutMs){
      showToast('❌ เชื่อมต่อ YouTube ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตของจอหลัก หรือปิดตัวบล็อกโฆษณาที่อาจบล็อก youtube.com แล้วลองเล่นเพลงนี้ใหม่', true);
      return;
    }
    setTimeout(check, 1000);
  };
  setTimeout(check, 1000);
}

function closeModal(id){ document.getElementById(id).classList.add('hidden'); }
function openModal(id){ document.getElementById(id).classList.remove('hidden'); }
window.closeModal = closeModal;

function showToast(msg, isError){
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 4000);
}

// First-load disclaimer — shown every time the page opens; must be dismissed before use.
document.getElementById('btn-disclaimer-enter').onclick = () => {
  document.getElementById('disclaimer-modal').style.display = 'none';
  openModal('role-select-modal');
};
document.getElementById('btn-role-host').onclick = () => {
  closeModal('role-select-modal');
  camHostReady = true; // from here on this device really is the main screen: the camera may start if it's wanted
  camSync();
};
document.getElementById('btn-role-screen2').onclick = () => {
  window.location.href = 'screen2.html';
};
document.getElementById('btn-role-remote').onclick = () => {
  window.location.href = 'remote.html';
};
document.getElementById('btn-disclaimer-features').onclick = () => {
  const showingFeatures = document.getElementById('disclaimer-panel-features').style.display !== 'none';
  document.getElementById('disclaimer-panel-about').style.display = showingFeatures ? 'block' : 'none';
  document.getElementById('disclaimer-panel-features').style.display = showingFeatures ? 'none' : 'block';
  document.getElementById('disclaimer-title').textContent = showingFeatures ? 'เกี่ยวกับเว็บไซต์' : 'คุณสมบัติของระบบ';
  document.getElementById('disclaimer-subtitle').textContent = showingFeatures
    ? 'ข้อมูลเกี่ยวกับเว็บไซต์ ลิขสิทธิ์ และการใช้งาน'
    : 'ความสามารถและฟีเจอร์ทั้งหมดที่ระบบรองรับ';
  document.getElementById('btn-disclaimer-features').textContent = showingFeatures ? 'คุณสมบัติ' : 'เกี่ยวกับเว็บไซต์';
  document.getElementById('disclaimer-panel-about').scrollTop = 0;
  document.getElementById('disclaimer-panel-features').scrollTop = 0;
};
document.getElementById('btn-disclaimer-cancel').onclick = () => {
  try{ window.close(); }catch(e){}
  setTimeout(() => {
    const modal = document.getElementById('disclaimer-modal');
    modal.querySelector('h2').textContent = 'ปิดการใช้งาน';
    modal.querySelector('.sub').style.display = 'none';
    modal.querySelectorAll('.disclaimer-body').forEach(el => el.remove());
    const msg = document.createElement('p');
    msg.style.cssText = 'text-align:center;padding:24px 0;';
    msg.textContent = 'คุณเลือกยกเลิกการเข้าใช้งาน กรุณาปิดแท็บ/หน้าต่างนี้ด้วยตนเอง';
    modal.querySelector('.close-row').before(msg);
    modal.querySelector('.close-row').style.display = 'none';
  }, 250);
};

// Warn if not on a secure context — WebRTC (used for the remote connection) is unreliable over plain HTTP.
if(location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
  document.getElementById('https-warning').style.display = 'block';
}

function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function currentIndex(){ return state.queue.findIndex(s => s.id === state.currentId); }
function currentSong(){ return state.queue.find(s => s.id === state.currentId) || null; }

// Well-known sing-along picks shown as quick-tap chips in the search modal.
// Edit this list to suit your own event/crowd.
const SUGGESTED_SONGS = [
  'ทะเลใจ - เบิร์ด ธงไชย',
  'ใจสั่งมา - The Toys',
  'แสงสุดท้าย - Big Ass',
  'ยินดีที่ไม่รู้จัก - Getsunova',
  'คืนที่ดาวเต็มฟ้า - พงษ์สิทธิ์ คำภีร์',
  'Perfect - Ed Sheeran',
  'Hotel California - Eagles',
  'Someone Like You - Adele',
  'My Way - Frank Sinatra',
  'I Will Survive - Gloria Gaynor',
  'Yesterday - The Beatles',
  'Shape of You - Ed Sheeran'
];
function renderSuggestedChips(containerId, inputId, triggerFn){
  const wrap = document.getElementById(containerId);
  if(wrap.dataset.rendered) return; // build once
  wrap.dataset.rendered = '1';
  SUGGESTED_SONGS.forEach(title => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = title;
    chip.onclick = () => { document.getElementById(inputId).value = title; triggerFn(); };
    wrap.appendChild(chip);
  });
}

function extractVideoId(input){
  input = input.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for(const p of patterns){ const m = input.match(p); if(m) return m[1]; }
  return null;
}

/* ---------------- Rendering ---------------- */
function renderQueue(){
  const list = document.getElementById('queue-list');
  document.getElementById('queue-count').textContent = state.queue.length + ' เพลง';
  const curId = state.currentId;
  list.innerHTML = '';
  state.queue.forEach((song, i) => {
    const li = document.createElement('li');
    const isCurrent = song.id === curId;
    li.className = 'q-item' + (isCurrent ? ' playing' : '');
    li.draggable = true;
    li.dataset.id = song.id;
    li.innerHTML = `
      <div class="drag-handle" title="ลากเพื่อจัดเรียง">⋮⋮</div>
      <div class="idx">${isCurrent ? '▶' : i + 1}</div>
      <img src="${escapeHtml(song.thumbnail)}" alt="">
      <div class="meta">
        <div class="title">${song.source === 'local' ? '<span class="source-badge local">💻</span>' : ''}${escapeHtml(song.title)}${voteTally.get(song.id) ? ' <span class="vote-badge">🗳️ ' + voteTally.get(song.id) + '</span>' : ''}</div>
        <div class="by">${song.by ? 'เพิ่มโดย ' + escapeHtml(song.by) : ''}</div>
      </div>
      <div class="actions">
        ${isCurrent ? '' : `
        <button data-act="up" title="เลื่อนขึ้น">▲</button>
        <button data-act="down" title="เลื่อนลง">▼</button>
        <button data-act="next" title="แทรกเล่นถัดไป">⇧</button>`}
        <button data-act="remove" title="ลบออกจากคิว">✕</button>
      </div>`;
    if(!isCurrent){
      li.querySelector('[data-act="up"]').onclick = (e) => { e.stopPropagation(); moveUp(song.id); };
      li.querySelector('[data-act="down"]').onclick = (e) => { e.stopPropagation(); moveDown(song.id); };
      li.querySelector('[data-act="next"]').onclick = (e) => { e.stopPropagation(); insertNext(song.id); };
    }
    li.querySelector('[data-act="remove"]').onclick = (e) => { e.stopPropagation(); removeSong(song.id); };
    li.addEventListener('click', () => { if(!isCurrent) playSongId(song.id); });
    // drag & drop reordering (mouse / trackpad)
    li.addEventListener('dragstart', () => { dragSrcId = song.id; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { dragSrcId = null; li.classList.remove('dragging'); });
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if(dragSrcId && dragSrcId !== song.id) reorderBefore(dragSrcId, song.id);
    });
    list.appendChild(li);
  });
  renderNowPlaying();
  renderTempo();
  renderVolume();
  broadcastState();
}

function renderNowPlaying(){
  const idle = document.getElementById('idle-screen');
  const song = currentSong();
  if(song){
    idle.style.display = 'none';
    document.title = '🎤 ' + song.title + ' — Sri Karaoke';
  } else {
    idle.style.display = 'flex';
    document.getElementById('next-up-bar').style.display = 'none';
    document.title = 'Sri Karaoke';
    // Welcome message only ever shows before "เริ่มระบบ" is clicked (i.e. the very first time the
    // system is opened). After that, an empty queue shows a blinking prompt instead.
    const title = document.getElementById('idle-title');
    const desc = document.getElementById('idle-desc');
    const emptyMsg = document.getElementById('idle-empty-queue-msg');
    const idleContent = document.querySelector('#idle-screen .idle-content');
    const startBtn = document.getElementById('btn-start-audio');
    if(audioUnlocked){
      title.style.display = 'none';
      desc.style.display = 'none';
      emptyMsg.style.display = 'block';
      startBtn.style.display = 'none';
      idleContent.classList.add('no-box'); // just the blinking text over the disco lights, no card behind it
    } else {
      title.style.display = '';
      emptyMsg.style.display = 'none';
      startBtn.style.display = '';
      idleContent.classList.remove('no-box');
    }
  }
  updateNowPlayingBar(song);
  document.getElementById('btn-playpause').textContent = state.isPlaying ? '⏸ หยุด' : '▶ เล่น';
  renderNextUpBar();
  renderChordBar();
  syncIdleJingle();
  syncIdleSlideshow();
  updateChannelModeButton();
  syncLocalAudioToScreen2();
  camSync();
}

// "Now playing" is shown as a continuously scrolling ticker (right-to-left) across the bottom of the
// video, on a transparent background so the video itself is never blocked. Speed scales with the
// text length so longer titles don't feel rushed. Restarts cleanly on every song change.
function updateNowPlayingBar(song){
  const bar = document.getElementById('now-playing-bar');
  const textEl = document.getElementById('np-marquee-text');
  if(!song){
    bar.style.display = 'none';
    textEl.style.animation = 'none';
    return;
  }
  textEl.textContent = '🎤 กำลังเล่นเพลงนี้: ' + song.title + (song.by ? ' • เพิ่มโดย ' + song.by : '') + (song.dedication ? ' • 💌 ' + song.dedication : '');
  bar.style.display = 'block';
  // Reset then re-apply the animation so it restarts from the right edge every time, and so the
  // duration can be recalculated for the new text's length.
  textEl.style.animation = 'none';
  void textEl.offsetWidth; // force reflow so the browser "forgets" the previous animation state
  const duration = Math.max(10, textEl.textContent.length * 0.35);
  textEl.style.animation = `np-marquee-rtl ${duration}s linear infinite`;
}

// Shows what's coming up next only in the last ~15 seconds of the current song (not the whole time),
// so it doesn't distract earlier on. Driven by a timer since it depends on live playback position.
const NEXT_UP_WINDOW_SECONDS = 15;
// Abstracts "how far into the current song are we" across the two possible players (YouTube iframe
// or the local <video> element), so timing-dependent features don't need to know which one is active.
function getPlaybackTimes(){
  const song = currentSong();
  if(song && song.source === 'local' && localPlayer && localPlayer.src){
    return { duration: localPlayer.duration || 0, currentTime: localPlayer.currentTime || 0 };
  }
  if(ytReady && ytPlayer){
    try{ return { duration: ytPlayer.getDuration() || 0, currentTime: ytPlayer.getCurrentTime() || 0 }; }
    catch(e){ return { duration: 0, currentTime: 0 }; }
  }
  return { duration: 0, currentTime: 0 };
}
function renderNextUpBar(){
  const nextBar = document.getElementById('next-up-bar');
  const song = currentSong();
  if(!song){
    nextBar.style.display = 'none';
    return;
  }
  const { duration, currentTime: curTime } = getPlaybackTimes();
  const remaining = duration - curTime;
  if(!duration || remaining > NEXT_UP_WINDOW_SECONDS || remaining < 0){
    nextBar.style.display = 'none';
    return;
  }
  const idx = currentIndex();
  const upcoming = idx > -1 ? state.queue[idx + 1] : null;
  if(upcoming){
    nextBar.classList.remove('warn');
    nextBar.innerHTML = `<span class="next-up-label">▶ ถัดไป</span><span class="next-up-title">${escapeHtml(upcoming.title)}</span>`;
  } else {
    nextBar.classList.add('warn');
    nextBar.innerHTML = `<span class="next-up-warn">⚠️ ไม่มีเพลงในคิว...กรุณาเลือกเพลง</span>`;
  }
  nextBar.style.display = 'flex';
}
setInterval(renderNextUpBar, 1000);

/* ---------------- Chords (saved per song — works for both YouTube and local-file songs) ---------------- */
let chordTargetKey = null;
let chordTargetTitle = '';

function parseSimpleChords(text, secondsPerChord){
  const chords = text.trim().split(/\s+/).filter(Boolean);
  return chords.map((chord, i) => ({ t: i * secondsPerChord, chord }));
}
function parseTimedChords(text){
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const timeline = [];
  lines.forEach(line => {
    let m = line.match(/^(\d+):(\d{1,2})\s+(.+)$/);
    if(m){
      timeline.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10), chord: m[3].trim() });
      return;
    }
    m = line.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if(m) timeline.push({ t: parseFloat(m[1]), chord: m[2].trim() });
  });
  timeline.sort((a, b) => a.t - b.t);
  return timeline;
}

function renderChordBar(){
  const bar = document.getElementById('chord-bar');
  const track = document.getElementById('chord-track');
  const nextBar = document.getElementById('next-up-bar');
  const headerH = getHeaderHeightPx();
  const song = currentSong();
  const key = songChordKey(song);
  const entry = key ? state.chords[key] : null;
  if(!song || !entry || !entry.timeline || entry.timeline.length === 0){
    bar.style.display = 'none';
    nextBar.style.top = headerH + 'px';
    return;
  }
  const { currentTime: curTime, duration } = getPlaybackTimes();
  const timeline = entry.timeline;
  const totalSpan = Math.max(duration || 0, timeline[timeline.length - 1].t + 8);

  // Only rebuild the segment strip when the song (or its chord data) actually changes — not on every
  // tick — so the highlight can just slide between existing segments instead of the whole bar flashing.
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
  if(idx === -1){ bar.style.display = 'none'; nextBar.style.top = headerH + 'px'; return; }

  track.querySelectorAll('.chord-segment').forEach(el => {
    el.classList.toggle('current', parseInt(el.dataset.idx, 10) === idx);
  });
  bar.style.display = 'block';
  // Nudge the "up next" banner down while chords are showing, so the two never overlap on the rare
  // occasion a song has chords AND is in its last 15 seconds at the same time.
  nextBar.style.top = (headerH + 52) + 'px';
}
setInterval(renderChordBar, 500);

function setChordMode(mode){
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  document.getElementById('chord-hint-simple').style.display = mode === 'simple' ? 'block' : 'none';
  document.getElementById('chord-hint-timed').style.display = mode === 'timed' ? 'block' : 'none';
  document.getElementById('chord-input-simple').style.display = mode === 'simple' ? 'block' : 'none';
  document.getElementById('chord-input-timed').style.display = mode === 'timed' ? 'block' : 'none';
}

function loadChordFormForTarget(){
  const titleEl = document.getElementById('chords-song-title');
  const saveBtn = document.getElementById('btn-chords-save');
  const delBtn = document.getElementById('btn-chords-delete');
  if(!chordTargetKey){
    titleEl.textContent = 'เล่นเพลง หรือเลือก "แก้ไข" จากคลังคอร์ดด้านล่างเพื่อเริ่มเพิ่มคอร์ด';
    document.getElementById('chord-input-simple-text').value = '';
    document.getElementById('chord-input-timed-text').value = '';
    saveBtn.disabled = true;
    delBtn.disabled = true;
    return;
  }
  titleEl.textContent = '🎵 ' + chordTargetTitle;
  saveBtn.disabled = false;
  const existing = state.chords[chordTargetKey];
  delBtn.disabled = !existing;
  if(existing){
    setChordMode(existing.mode);
    if(existing.mode === 'simple'){
      document.getElementById('chord-input-simple-text').value = existing.raw || '';
      document.getElementById('chord-seconds-per').value = existing.secondsPerChord || 4;
    } else {
      document.getElementById('chord-input-timed-text').value = existing.raw || '';
    }
  } else {
    document.getElementById('chord-input-simple-text').value = '';
    document.getElementById('chord-input-timed-text').value = '';
    document.getElementById('chord-seconds-per').value = 4;
    setChordMode('simple');
  }
}

function renderChordLibrary(){
  const wrap = document.getElementById('chord-library-list');
  const keys = Object.keys(state.chords);
  document.getElementById('chord-count').textContent = keys.length;
  if(keys.length === 0){
    wrap.innerHTML = '<div class="empty-note">ยังไม่มีคอร์ดที่บันทึกไว้</div>';
    return;
  }
  wrap.innerHTML = '';
  keys.forEach(key => {
    const entry = state.chords[key];
    const row = document.createElement('div');
    row.className = 'pl-row';
    row.innerHTML = `
      <div class="name">${escapeHtml(entry.title || key)}</div>
      <div class="count">${entry.mode === 'timed' ? 'โหมดละเอียด' : 'โหมดง่าย'} · ${entry.timeline.length} คอร์ด</div>
      <button data-act="edit">แก้ไข</button>`;
    row.querySelector('[data-act="edit"]').onclick = () => {
      chordTargetKey = key;
      chordTargetTitle = entry.title || key;
      loadChordFormForTarget();
    };
    wrap.appendChild(row);
  });
}

function openChordsModal(){
  const song = currentSong();
  const key = songChordKey(song);
  if(key){ chordTargetKey = key; chordTargetTitle = song.title; }
  renderChordLibrary();
  loadChordFormForTarget();
  openModal('chords-modal');
}

/* ---------------- Sound effects (vertical panel over the left side of the video) ----------------
   File list comes from sound-effects/manifest.json — a plain JSON array of filenames that the
   operator edits by hand (a static site has no way to "scan a folder" on its own). Button labels are
   just the filename with its extension stripped. */
let soundEffects = []; // [{file, label}]
async function loadSoundEffects(){
  try{
    const res = await fetch('sound-effects/manifest.json');
    if(!res.ok) throw new Error('manifest not found');
    const files = await res.json();
    if(!Array.isArray(files)) throw new Error('manifest is not a list');
    // Each entry can be a plain filename string (old format, still supported) or an object
    // {file, icon, label} so a sound can show an emoji instead of just its filename.
    soundEffects = files.map(f => {
      if(typeof f === 'string'){
        return { file: f, icon: '', label: f.replace(/\.[^.]+$/, '') };
      }
      return {
        file: f.file || '',
        icon: f.icon || '',
        label: f.label || (f.file ? f.file.replace(/\.[^.]+$/, '') : '')
      };
    }).filter(fx => fx.file);
  }catch(e){
    soundEffects = [];
  }
  renderEffectsPanel();
  connections.forEach(c => { if(c.open) c.send({ type: 'SOUND_EFFECTS', effects: soundEffects }); });
}
function renderEffectsPanel(){
  const list = document.getElementById('effects-panel-list');
  if(!list) return;
  if(soundEffects.length === 0){
    list.innerHTML = '<div class="effects-empty-note">ยังไม่มีเสียงเอฟเฟกต์ — เพิ่มไฟล์ได้ที่โฟลเดอร์ sound-effects (ดู README.txt ในโฟลเดอร์นั้น)</div>';
    return;
  }
  list.innerHTML = '';
  soundEffects.forEach(fx => {
    const btn = document.createElement('button');
    btn.className = 'effects-btn';
    if(fx.icon){
      const iconEl = document.createElement('span');
      iconEl.className = 'effects-btn-icon';
      iconEl.textContent = fx.icon;
      btn.appendChild(iconEl);
    }
    const labelEl = document.createElement('span');
    labelEl.className = 'effects-btn-label';
    labelEl.textContent = fx.label;
    btn.appendChild(labelEl);
    btn.title = fx.label;
    btn.onclick = () => playSoundEffect(fx.file);
    list.appendChild(btn);
  });
}
// Plays through whichever screen is the current audio source (same "เสียงออกที่จอไหน" setting used
// everywhere else) — if that's Screen 2, this device doesn't have the speakers right now, so it just
// asks Screen 2 to play the effect instead of playing it here.
function playSoundEffect(file){
  if(!file) return;
  if(state.audioOutput === 'screen2'){
    connections.forEach(c => { if(c.open) c.send({ type: 'PLAY_SOUND_EFFECT', file }); });
    return;
  }
  const el = document.getElementById('sfx-player');
  if(!el) return;
  try{
    el.src = 'sound-effects/' + encodeURIComponent(file);
    el.volume = state.muted ? 0 : (state.volume / 100);
    el.currentTime = 0;
    el.play().catch(() => {});
  }catch(e){}
}

function renderTempo(){
  document.getElementById('tempo-value').textContent = state.tempo.toFixed(2) + 'x';
}

function renderVolume(){
  document.getElementById('volume-value').textContent = state.muted ? 'ปิดเสียง' : state.volume + '%';
  document.getElementById('btn-mute').textContent = state.muted ? '🔇' : '🔊';
  document.getElementById('btn-mute').classList.toggle('on', state.muted);
}

/* ---------------- Queue operations (playback order = host only) ---------------- */
function addSong(song, from, playNow, dedication){
  const ded = (dedication || '').trim().slice(0, 40); // kept short so it always fits on one line wherever it's shown
  const newSong = song.source === 'local'
    ? { id: uid(), source: 'local', localFileId: song.localFileId, title: song.title, thumbnail: LOCAL_FILE_THUMB, by: from || '', dedication: ded }
    : { id: uid(), source: 'youtube', videoId: song.videoId, title: song.title, thumbnail: song.thumbnail, by: from || '', dedication: ded };

  // Friendly heads-up if this song was already played recently or is already queued — still adds it either way.
  const matchKey = s => s.source === 'local' ? s.localFileId : s.videoId;
  const recentlyPlayed = state.history.slice(0, 15).some(h => (h.source || 'youtube') === newSong.source && matchKey(h) === matchKey(newSong));
  const alreadyQueued = state.queue.some(s => s.source === newSong.source && matchKey(s) === matchKey(newSong));
  if(recentlyPlayed) showToast(`⚠️ "${newSong.title}" เพิ่งเล่นไปแล้วก่อนหน้านี้`, true);
  else if(alreadyQueued) showToast(`⚠️ "${newSong.title}" มีอยู่ในคิวแล้ว`, true);

  state.queue.push(newSong);
  if(playNow && state.currentId){
    const idx = state.queue.findIndex(s => s.id === newSong.id);
    state.queue.splice(idx, 1);
    state.queue.splice(currentIndex() + 1, 0, newSong);
    playSongId(newSong.id);
  } else if(state.currentId === null){
    playSongId(newSong.id);
  } else {
    if(state.fairQueueMode) fairReorderQueue();
    renderQueue();
  }
}

function removeSong(id){
  const idx = state.queue.findIndex(s => s.id === id);
  if(idx === -1) return;
  const wasCurrent = id === state.currentId;
  const removedSong = state.queue[idx];
  state.queue.splice(idx, 1);
  if(wasCurrent){
    const nextIdx = state.queue.length ? Math.min(idx, state.queue.length - 1) : -1;
    const nextId = nextIdx > -1 ? state.queue[nextIdx].id : null;
    recordAndSetCurrent(removedSong, nextId, 'ลบออกจากคิว');
  } else {
    renderQueue();
  }
}

function insertNext(id){
  const idx = state.queue.findIndex(s => s.id === id);
  if(idx === -1 || id === state.currentId) return;
  const [song] = state.queue.splice(idx, 1);
  const target = state.currentId === null ? 0 : currentIndex() + 1;
  state.queue.splice(target, 0, song);
  renderQueue();
}

function moveUp(id){
  if(id === state.currentId) return; // the now-playing song isn't reorderable — only skip/prev change what's current
  const idx = state.queue.findIndex(s => s.id === id);
  if(idx <= 0) return;
  const curIdx = currentIndex();
  if(curIdx !== -1 && idx - 1 <= curIdx) return; // can't move above the currently playing song's slot
  [state.queue[idx - 1], state.queue[idx]] = [state.queue[idx], state.queue[idx - 1]];
  renderQueue();
}
function moveDown(id){
  if(id === state.currentId) return;
  const idx = state.queue.findIndex(s => s.id === id);
  if(idx === -1 || idx >= state.queue.length - 1) return;
  [state.queue[idx + 1], state.queue[idx]] = [state.queue[idx], state.queue[idx + 1]];
  renderQueue();
}

// "คิวคนร้อง" fairness: re-sorts the not-yet-played tail of the queue into round-robin
// order by singer, so one person adding many songs doesn't monopolize consecutive turns.
// Never touches the currently playing song or anything before it.
// Configurable via the "คิวคนร้อง" popup — how many songs each singer gets before rotating to the
// next; default is 1 (round-robin every song) unless the operator sets otherwise.
let FAIR_QUEUE_SONGS_PER_TURN = parseInt(sessionStorage.getItem('sriKaraoke_fairSongsPerTurn'), 10) || 1;
function fairReorderQueue(){
  const idx = currentIndex();
  const headPortion = idx > -1 ? state.queue.slice(0, idx + 1) : [];
  const tailPortion = idx > -1 ? state.queue.slice(idx + 1) : state.queue.slice();

  const groups = new Map();
  const order = [];
  tailPortion.forEach(song => {
    const key = song.by || 'ไม่ระบุชื่อ';
    if(!groups.has(key)){ groups.set(key, []); order.push(key); }
    groups.get(key).push(song);
  });

  const result = [];
  let round = 0;
  while(result.length < tailPortion.length){
    for(const key of order){
      const list = groups.get(key);
      for(let i = 0; i < FAIR_QUEUE_SONGS_PER_TURN; i++){
        const pos = round * FAIR_QUEUE_SONGS_PER_TURN + i;
        if(list[pos]) result.push(list[pos]);
      }
    }
    round++;
  }
  state.queue = headPortion.concat(result);
}
function reorderBefore(draggedId, targetId){
  if(draggedId === state.currentId || targetId === state.currentId) return; // keep the now-playing slot fixed
  const from = state.queue.findIndex(s => s.id === draggedId);
  if(from === -1) return;
  const [song] = state.queue.splice(from, 1);
  const to = state.queue.findIndex(s => s.id === targetId);
  if(to === -1){ state.queue.splice(from, 0, song); return; } // target vanished mid-drag — put it back, don't misplace it
  state.queue.splice(to, 0, song);
  renderQueue();
}

function playSongId(id){
  const song = state.queue.find(s => s.id === id);
  if(!song || id === state.currentId) return;
  const prev = currentSong();
  recordAndSetCurrent(prev, id, 'เปลี่ยนเพลง');
}

function skip(reason){
  const idx = currentIndex();
  if(idx === -1) return; // nothing currently playing, nothing to advance from
  const [finishedSong] = state.queue.splice(idx, 1); // finished/skipped songs leave the queue automatically
  const nextId = state.queue[idx] ? state.queue[idx].id : null;
  recordAndSetCurrent(finishedSong, nextId, reason || 'ข้าม');
}

function prevSong(){
  const idx = currentIndex();
  if(idx > 0) playSongId(state.queue[idx - 1].id);
}

function togglePlayPause(){
  const song = currentSong();
  if(!song || !state.currentId) return;
  if(song.source === 'local' && localPlayer){
    if(state.isPlaying){ localPlayer.pause(); state.isPlaying = false; }
    else { localPlayer.play().catch(() => {}); state.isPlaying = true; }
  } else if(ytPlayer){
    if(state.isPlaying){ ytPlayer.pauseVideo(); state.isPlaying = false; }
    else { ytPlayer.playVideo(); state.isPlaying = true; }
  }
  renderQueue();
}

function stopPlayer(){
  if(ytPlayer){ try{ ytPlayer.stopVideo(); }catch(e){} }
  if(localPlayer){ try{ localPlayer.pause(); localPlayer.removeAttribute('src'); localPlayer.load(); localPlayer.style.display = 'none'; }catch(e){} }
  const ytWrap = document.getElementById('player');
  if(ytWrap) ytWrap.style.display = '';
  state.isPlaying = false;
  hideLoadingOverlay();
  hideMp3NowPlaying();
}

/* ---------------- Tempo (speed) — allowed from host AND remote ---------------- */
function tempoStep(dir){
  const idx = TEMPO_RATES.indexOf(state.tempo);
  const nextIdx = Math.min(TEMPO_RATES.length - 1, Math.max(0, (idx === -1 ? 2 : idx) + dir));
  state.tempo = TEMPO_RATES[nextIdx];
  if(ytReady && ytPlayer){ try{ ytPlayer.setPlaybackRate(state.tempo); }catch(e){} }
  if(localPlayer) localPlayer.playbackRate = state.tempo;
  renderTempo();
  broadcastState();
}

/* ---------------- Volume — allowed from host AND remote ---------------- */
function volumeStep(dir){
  state.muted = false;
  state.volume = Math.min(100, Math.max(0, state.volume + dir * 10));
  applyAudioOutput();
  renderVolume();
  broadcastState();
}
function toggleMute(){
  state.muted = !state.muted;
  applyAudioOutput();
  renderVolume();
  broadcastState();
}

// Routes the shared volume/tempo controls to whichever screen is currently the audio source.
// When Screen 2 is the source, the host's own player is force-muted and every connection (Screen 2,
// phone remotes) gets an AUDIO_OUTPUT message — phone remotes have no player and simply ignore it.
/* ---------------- Local-file audio routing ----------------
   Two features need the local player's sound to pass through the Web Audio API instead of going straight to
   the speakers: the channel mode (Stereo / L+L / R+R — for karaoke discs that put music on one channel and
   music+vocals on the other) and sending a local file's sound to Screen 2.
   Until one of them is actually needed (Stereo + sound on this device = the original, untouched path), the
   player is NOT touched at all — once a <video> element is attached to the Web Audio API it can't be
   detached again, so this is only done on demand, and only after the browser has confirmed audio is allowed
   to run (otherwise attaching it would leave the file silent). */
const CHANNEL_MODES = ['stereo', 'LL', 'RR'];
const CHANNEL_MODE_LABEL = { stereo: 'Stereo', LL: 'L+L', RR: 'R+R' };

// Pure (takes the audio source in, returns the routing) so it can be tested against a real Web Audio engine.
//   Stereo: left -> left,  right -> right
//   L+L   : left -> both speakers      R+R: right -> both speakers
// Every mode still outputs to BOTH speakers — only which channel feeds them changes.
function buildChannelRouter(ctx, source){
  // Force exactly 2 channels first: a mono file becomes L=R (so R+R isn't silent), 5.1 gets folded down.
  const pre = ctx.createGain();
  pre.channelCount = 2; pre.channelCountMode = 'explicit'; pre.channelInterpretation = 'speakers';
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const g = { LtoL: ctx.createGain(), LtoR: ctx.createGain(), RtoL: ctx.createGain(), RtoR: ctx.createGain() };
  const output = ctx.createGain();
  output.channelCount = 2; output.channelCountMode = 'explicit'; output.channelInterpretation = 'speakers';
  source.connect(pre);
  pre.connect(splitter);
  splitter.connect(g.LtoL, 0); splitter.connect(g.LtoR, 0);
  splitter.connect(g.RtoL, 1); splitter.connect(g.RtoR, 1);
  g.LtoL.connect(merger, 0, 0); g.RtoL.connect(merger, 0, 0);
  g.LtoR.connect(merger, 0, 1); g.RtoR.connect(merger, 0, 1);
  merger.connect(output);
  function setMode(mode, immediate){
    const m = { stereo: [1, 0, 0, 1], LL: [1, 1, 0, 0], RR: [0, 0, 1, 1] }[mode] || [1, 0, 0, 1];
    [g.LtoL, g.LtoR, g.RtoL, g.RtoR].forEach((node, i) => {
      if(immediate) node.gain.value = m[i];
      else node.gain.setTargetAtTime(m[i], ctx.currentTime, 0.01); // short ramp so switching doesn't click
    });
  }
  return { input: pre, output, gains: g, setMode };
}

// WebRTC sends Opus as mono unless both sides' SDP say otherwise — add stereo (and a music-grade bitrate)
// to the Opus line so Stereo mode actually arrives in stereo at Screen 2.
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

function ensureLocalAudioGraph(){
  if(localGraph) return Promise.resolve(localGraph);
  if(localGraphBuilding) return localGraphBuilding;
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC || !localPlayer || localAudioBroken) return Promise.resolve(null);
  localGraphBuilding = (async () => {
    let ctx = null;
    try{
      ctx = new AC();
      // A browser that isn't allowing audio yet doesn't reject resume() — it leaves the promise pending until
      // someone taps the page — so don't wait forever: give it a moment, then treat it as blocked.
      try{ await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1500))]); }catch(e){}
      // Not allowed to run (no user interaction / blocked)? Don't attach: that would silence the file.
      if(ctx.state !== 'running') throw new Error('AudioContext is ' + ctx.state);
    }catch(e){
      console.warn('[Audio] Web Audio not available right now — leaving the player untouched.', e);
      try{ if(ctx) ctx.close(); }catch(_){}
      localGraphLastFail = Date.now();
      return null;
    }
    let source;
    try{
      source = ctx.createMediaElementSource(localPlayer);
    }catch(e){
      console.warn('[Audio] Could not attach the local player to Web Audio.', e);
      try{ ctx.close(); }catch(_){}
      localAudioBroken = true;
      localGraphLastFail = Date.now();
      return null;
    }
    // From here on the player's sound ONLY comes out through this graph.
    try{
      const router = buildChannelRouter(ctx, source);
      router.setMode(state.channelMode, true);
      const toHost = ctx.createGain();
      router.output.connect(toHost);
      toHost.connect(ctx.destination);
      let toStream = null, streamDest = null;
      if(ctx.createMediaStreamDestination){
        streamDest = ctx.createMediaStreamDestination();
        toStream = ctx.createGain();
        toStream.gain.value = 0;
        router.output.connect(toStream);
        toStream.connect(streamDest);
      }
      localGraph = { ctx, source, router, toHost, toStream, streamDest };
      return localGraph;
    }catch(e){
      console.error('[Audio] Building the routing failed — connecting the player straight to the speakers.', e);
      try{ source.disconnect(); }catch(_){}
      try{ source.connect(ctx.destination); }catch(_){}
      localAudioBroken = true;
      localGraphLastFail = Date.now();
      return null;
    }
  })().finally(() => { localGraphBuilding = null; });
  return localGraphBuilding;
}

// Sets how loud the local player is, in whichever mode it's in (graph or original direct path).
// `silenceHost` = this device's own speakers should be silent (sound is going to Screen 2, or still loading).
function applyLocalPlayerLevels(silenceHost){
  if(!localPlayer) return;
  if(localGraph){
    // Volume/mute are applied by the graph's gain nodes, so the element itself stays wide open.
    localPlayer.volume = 1;
    localPlayer.muted = false;
    // e.g. a backgrounded tab on Android can have its audio engine paused — wake it, otherwise nothing is heard
    if(localGraph.ctx.state === 'suspended'){ try{ localGraph.ctx.resume().catch(() => {}); }catch(e){} }
    const t = localGraph.ctx.currentTime;
    localGraph.toHost.gain.setTargetAtTime(silenceHost ? 0 : (state.muted ? 0 : state.volume / 100), t, 0.01);
    if(localGraph.toStream) localGraph.toStream.gain.setTargetAtTime(state.audioOutput === 'screen2' ? 1 : 0, t, 0.01);
  } else if(silenceHost){
    localPlayer.muted = true;
    localPlayer.volume = 0;
  } else {
    localPlayer.volume = state.volume / 100;
    localPlayer.muted = state.muted;
  }
}

function localRoutingWanted(){
  const song = currentSong();
  return !!song && song.source === 'local' && (state.channelMode !== 'stereo' || state.audioOutput === 'screen2');
}

// Backs out of everything that depended on the routing, so the room is never left silent or mislabelled:
// the channel mode returns to Stereo and, if sound was set to Screen 2, it returns to this device.
function abandonLocalRouting(onlyScreen2Output){
  if(!onlyScreen2Output && state.channelMode !== 'stereo'){
    state.channelMode = 'stereo';
    sessionStorage.setItem('sriKaraoke_channelMode', 'stereo');
    showToast('⚠️ เปิดโหมดช่องเสียงไม่ได้ (เบราว์เซอร์ไม่อนุญาตระบบเสียงขั้นสูง ลองกดที่หน้าจอ 1 ครั้งแล้วลองใหม่) — กลับเป็น Stereo', true);
  }
  if(state.audioOutput === 'screen2' && currentSong()?.source === 'local'){
    state.audioOutput = 'screen1';
    sessionStorage.setItem('sriKaraoke_audioOutput', 'screen1');
    const outputBtn = document.getElementById('btn-audio-output-toggle');
    if(outputBtn) outputBtn.textContent = 'จอหลัก';
    showToast('⚠️ ส่งเสียงไฟล์ในเครื่องไปจอที่ 2 ไม่ได้ — ย้ายเสียงกลับมาที่จอหลักให้อัตโนมัติ', true);
  }
  applyAudioOutput();
  updateChannelModeButton();
  broadcastState();
}

// Builds the routing if (and only if) the current song needs it; re-applies levels once it's ready.
// `userInitiated` skips the short cool-down after a failed attempt: the cool-down only exists so that
// automatic refreshes (e.g. every volume change) don't keep retrying, never to ignore what the operator just asked for.
function maybeBuildLocalGraph(userInitiated){
  // The routing exists but this browser has no way to hand its sound to Screen 2 (no MediaStream destination):
  // keep the channel mode (it works fine) and only take the output back to this device.
  if(localGraph && !localGraph.streamDest && state.audioOutput === 'screen2' && currentSong()?.source === 'local'){
    abandonLocalRouting(true);
    return;
  }
  if(localGraph || !localPlayer || !localRoutingWanted()) return;
  if(localAudioBroken){ abandonLocalRouting(); return; } // can never work in this page: say so instead of staying silent
  if(!userInitiated && Date.now() - localGraphLastFail < 3000) return;
  ensureLocalAudioGraph().then(g => {
    if(g) applyAudioOutput();
    else abandonLocalRouting();
  });
}

// Called as a local song is about to start. Keeps the player silent until the routing it needs exists, so
// nothing ever leaks out un-routed (e.g. in R+R, or to this speaker when it should only go to Screen 2).
function prepareLocalElementAudio(){
  const needsRouting = state.channelMode !== 'stereo' || state.audioOutput === 'screen2';
  if(localGraph || !needsRouting){
    applyLocalPlayerLevels(state.audioOutput === 'screen2');
    return;
  }
  // Routing is needed but doesn't exist yet: hold the element silent meanwhile, then either build it or — if that
  // can never work here — back out and restore normal sound (never leave the file silent).
  localPlayer.muted = true;
  localPlayer.volume = 0;
  // currentSong() is already the new song here (state.currentId is set before loadSongIntoPlayer runs)
  maybeBuildLocalGraph(true);
}

function setChannelMode(mode){
  if(!CHANNEL_MODES.includes(mode)) return;
  if(mode !== 'stereo' && !localGraph && localAudioBroken){
    showToast('⚠️ เบราว์เซอร์นี้ใช้โหมดช่องเสียงไม่ได้ (ตัวเล่นเชื่อมระบบเสียงขั้นสูงไม่สำเร็จ) — ลองรีเฟรชหน้านี้', true);
    return;
  }
  state.channelMode = mode;
  sessionStorage.setItem('sriKaraoke_channelMode', mode);
  if(localGraph){
    localGraph.router.setMode(mode);
    try{ if(localGraph.ctx.state === 'suspended') localGraph.ctx.resume(); }catch(e){}
  } else if(mode !== 'stereo'){
    maybeBuildLocalGraph(true); // first time a non-Stereo mode is wanted for the current local song
  }
  updateChannelModeButton();
  broadcastState();
  showToast('🎚️ ช่องเสียง: ' + CHANNEL_MODE_LABEL[mode]);
}

function updateChannelModeButton(){
  const btn = document.getElementById('btn-channel-mode');
  if(!btn) return;
  const song = currentSong();
  btn.style.display = (song && song.source === 'local') ? '' : 'none';
  btn.querySelector('.label').textContent = CHANNEL_MODE_LABEL[state.channelMode];
  btn.title = 'ช่องเสียง: ' + CHANNEL_MODE_LABEL[state.channelMode] + ' (กดเพื่อสลับ Stereo → L+L → R+R)';
}

// Sends the local player's sound to every connected Screen 2 while sound is routed there for a local song,
// and hangs up as soon as that stops being true. Idempotent — safe to call from anywhere, any number of times.
function syncLocalAudioToScreen2(){
  const want = state.audioOutput === 'screen2' && !!localGraph && !!localGraph.streamDest && currentSong()?.source === 'local';
  connections.forEach(c => {
    if(!c._isScreen2) return;
    const existing = localStreamCalls.get(c.peer);
    if(want && c.open && !existing && peer && !peer.destroyed){
      try{
        const call = peer.call(c.peer, localGraph.streamDest.stream, { sdpTransform: opusStereoSdp, metadata: { kind: 'audio' } });
        localStreamCalls.set(c.peer, call);
        call.on('close', () => { if(localStreamCalls.get(c.peer) === call) localStreamCalls.delete(c.peer); });
        call.on('error', () => { if(localStreamCalls.get(c.peer) === call) localStreamCalls.delete(c.peer); });
      }catch(e){
        // Sound is set to go to Screen 2 and this device is silent, so a feed that can't start must not be left like that
        console.warn('[Audio] Could not start sending sound to Screen 2', e);
        abandonLocalRouting(true);
        return;
      }
    } else if(!want && existing){
      try{ existing.close(); }catch(e){}
      localStreamCalls.delete(c.peer);
    }
  });
  // forget calls whose Screen 2 has gone away
  for(const [peerId, call] of [...localStreamCalls]){
    if(!connections.some(c => c.peer === peerId && c.open)){
      try{ call.close(); }catch(e){}
      localStreamCalls.delete(peerId);
    }
  }
}

function applyAudioOutput(userInitiated){
  const forceMuteForLoading = isLoadingSong && state.audioOutput === 'screen1';
  const silenceHost = state.audioOutput === 'screen2' || forceMuteForLoading;
  if(silenceHost){
    if(ytReady && ytPlayer){ try{ ytPlayer.mute(); ytPlayer.setVolume(0); }catch(e){} }
  } else {
    if(ytReady && ytPlayer){
      try{ ytPlayer.setVolume(state.volume); state.muted ? ytPlayer.mute() : ytPlayer.unMute(); }catch(e){}
    }
  }
  applyLocalPlayerLevels(silenceHost);
  connections.forEach(c => {
    if(c.open) c.send({ type: 'AUDIO_OUTPUT', output: state.audioOutput, volume: state.volume, muted: state.muted, latencyMs: audioLatencyMs });
  });
  maybeBuildLocalGraph(userInitiated);
  syncLocalAudioToScreen2();
  syncIdleJingle();
}

// "กรุณาเลือกเพลง.mp3" — loops softly whenever the queue is empty (first-ever load with nothing
// queued yet, or the last song just finished), so the room isn't silent while waiting for someone to
// pick a song. Stops the instant a real song starts. Only plays on whichever screen is the current
// audio source, and needs the same one-time autoplay unlock as everything else ("เริ่มระบบ" button).
function syncIdleJingle(){
  const el = document.getElementById('idle-jingle');
  if(!el) return;
  const isIdle = !currentSong();
  const isSource = state.audioOutput === 'screen1';
  if(isIdle && isSource && audioUnlocked){
    el.volume = state.muted ? 0 : (state.volume / 100);
    if(el.paused){
      el.play().catch(() => {
        // Most likely cause: this device just clicked "เริ่มระบบ" a split-second ago and the file
        // hasn't buffered anything yet, so the very first play() attempt gets rejected. Retry the
        // moment the browser says it's actually ready to play — no extra click needed for that case.
        // Also keep the old "next real interaction" fallback as a safety net for genuine autoplay
        // blocks that a mere canplay event wouldn't fix.
        const retryOnReady = () => {
          cleanup();
          syncIdleJingle(); // re-checks current state fresh — safe even if things changed meanwhile
        };
        const cleanup = () => {
          el.removeEventListener('canplay', retryOnReady);
          document.removeEventListener('click', retryOnReady);
          document.removeEventListener('touchstart', retryOnReady);
        };
        el.addEventListener('canplay', retryOnReady, { once: true });
        document.addEventListener('click', retryOnReady, { once: true });
        document.addEventListener('touchstart', retryOnReady, { once: true });
      });
    }
  } else if(!el.paused){
    el.pause();
  }
}

/* ---------------- YouTube ---------------- */
let audioUnlocked = localStorage.getItem('sriKaraoke_audioUnlocked') === '1';

function onYouTubeIframeAPIReady(){
  ytPlayer = new YT.Player('player', {
    width: '100%', height: '100%',
    playerVars: { autoplay: 0, playsinline: 1, controls: 1, rel: 0 },
    events: {
      onReady: () => { ytReady = true; console.debug('[YT Debug] YouTube player onReady fired.'); applyAudioOutput(); },
      onStateChange: (e) => {
        console.debug('[YT Debug] onStateChange fired, state:', e.data, '(PLAYING=', YT.PlayerState.PLAYING, ')');
        if(e.data === YT.PlayerState.ENDED){
          const finishedSong = currentSong();
          if(finishedSong) recordAndShowScore(finishedSong);
          skip('เล่นจบ');
        }
        if(e.data === YT.PlayerState.PLAYING){ state.isPlaying = true; hideLoadingOverlay(); renderNowPlaying(); }
        if(e.data === YT.PlayerState.PAUSED){ state.isPlaying = false; renderNowPlaying(); }
      },
      onError: (e) => {
        // 2=invalid id, 5=html5 error, 100=not found/removed, 101/150=embedding disabled
        const song = currentSong();
        showToast(`เล่นวิดีโอ "${song ? song.title : ''}" ไม่ได้ (ถูกลบ/ปิดการฝัง) — ข้ามไปเพลงถัดไป`, true);
        skip('เล่นไม่ได้');
      }
    }
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

// Local <video> element — plays songs added from the device's own files. Mirrors the YouTube
// player's ended/error/play/pause handling so the rest of the app (scoring, skip, now-playing state)
// doesn't need to care which source is currently active.
localPlayer = document.getElementById('local-player');
if(localPlayer){
  localPlayer.addEventListener('ended', () => {
    const finishedSong = currentSong();
    if(finishedSong) recordAndShowScore(finishedSong);
    skip('เล่นจบ');
  });
  localPlayer.addEventListener('error', () => {
    const song = currentSong();
    if(song && song.source === 'local'){
      showToast(`เล่นไฟล์ "${song.title}" ไม่ได้ (ไฟล์เสียหายหรือรูปแบบไม่รองรับ) — ข้ามไปเพลงถัดไป`, true);
      skip('เล่นไม่ได้');
    }
  });
  localPlayer.addEventListener('playing', () => { state.isPlaying = true; hideLoadingOverlay(); renderNowPlaying(); });
  localPlayer.addEventListener('pause', () => { state.isPlaying = false; renderNowPlaying(); });
}

// Browsers block audio-with-sound playback that isn't triggered directly by a user click.
// Songs added remotely (via a phone) arrive as a network message, not a click on THIS page,
// so the very first playback needs one manual tap here to "unlock" autoplay for the rest of the session.
document.getElementById('btn-start-audio').onclick = () => {
  if(ytReady && ytPlayer){
    try{
      ytPlayer.mute();
      ytPlayer.playVideo();
      setTimeout(() => { try{ ytPlayer.pauseVideo(); ytPlayer.unMute(); }catch(e){} }, 300);
    }catch(e){}
  }
  audioUnlocked = true;
  localStorage.setItem('sriKaraoke_audioUnlocked', '1');
  document.getElementById('btn-start-audio').style.display = 'none';
  renderNowPlaying();
};

/* ---------------- PeerJS (remote sync) ---------------- */
const STORAGE_ROOMCODE = 'sriKaraoke_roomCode';
const STORAGE_PINENABLED = 'sriKaraoke_pinEnabled';
const STORAGE_PIN = 'sriKaraoke_pin';
const STORAGE_ADMINTOKEN = 'sriKaraoke_adminToken';
let peerRetryCount = 0;
let myRoomId = '';

function generatePin(){
  return String(Math.floor(1000 + Math.random() * 9000));
}
function generateAdminToken(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for(let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function renderRoomQR(){
  // Guest link — respects the PIN toggle, can only ever queue/remove/tempo.
  const guestUrl = new URL('remote.html', window.location.href);
  guestUrl.searchParams.set('room', myRoomId);
  guestUrl.searchParams.set('role', 'guest');
  if(state.pinEnabled && state.pin) guestUrl.searchParams.set('pin', state.pin);
  document.getElementById('room-url-text').textContent = guestUrl.toString();
  document.getElementById('qrcode').innerHTML = '';
  new QRCode(document.getElementById('qrcode'), {
    text: guestUrl.toString(), width: 180, height: 180, colorDark: '#1B1533', colorLight: '#ffffff'
  });

  // Admin link — carries its own secret token and always gets full control, regardless of the PIN toggle.
  const adminUrl = new URL('remote.html', window.location.href);
  adminUrl.searchParams.set('room', myRoomId);
  adminUrl.searchParams.set('role', 'admin');
  adminUrl.searchParams.set('admintoken', state.adminToken);
  document.getElementById('admin-room-url-text').textContent = adminUrl.toString();
  document.getElementById('qrcode-admin').innerHTML = '';
  new QRCode(document.getElementById('qrcode-admin'), {
    text: adminUrl.toString(), width: 180, height: 180, colorDark: '#1B1533', colorLight: '#ffffff'
  });

  // Screen 2 link — a read-only display, so it just reuses the guest PIN gate (no special token needed).
  if(state.screen2Enabled){
    const screen2Url = new URL('screen2.html', window.location.href);
    screen2Url.searchParams.set('room', myRoomId);
    if(state.pinEnabled && state.pin) screen2Url.searchParams.set('pin', state.pin);
    document.getElementById('screen2-room-code-text').textContent = myRoomId.replace('srikaraoke-', '').toUpperCase();
    document.getElementById('screen2-room-url-text').textContent = screen2Url.toString();
    const pinRow = document.getElementById('screen2-pin-display-row');
    if(state.pinEnabled && state.pin){
      pinRow.style.display = 'flex';
      document.getElementById('screen2-pin-value').textContent = state.pin;
    } else {
      pinRow.style.display = 'none';
    }
    // Rebuild the QR container fresh each time (rather than reusing the same node) so there's no
    // chance of a stale canvas/table left behind by the QR library from a previous render.
    const qrHost = document.getElementById('qrcode-screen2');
    qrHost.innerHTML = '';
    const qrInner = document.createElement('div');
    qrHost.appendChild(qrInner);
    new QRCode(qrInner, {
      text: screen2Url.toString(), width: 180, height: 180, colorDark: '#1B1533', colorLight: '#ffffff'
    });
  }
}

// Extra STUN servers beyond PeerJS's default, so connections have more paths to find each other
// across different networks. If phones still connect unreliably on strict networks (hotel/corporate
// Wi-Fi, some mobile carriers), STUN alone often isn't enough — add a TURN server too. Free options:
// sign up for a free tier at a service like metered.ca, Twilio, or Xirsys, then add a line like:
// { urls: 'turn:YOUR_TURN_HOST:3478', username: 'YOUR_USERNAME', credential: 'YOUR_CREDENTIAL' }
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

function initPeer(){
  // Reuse the same room code (and PIN/admin-token settings) across a refresh within this browser
  // tab session, so the QR codes stay valid and connected phones can reconnect to the same room.
  let code = sessionStorage.getItem(STORAGE_ROOMCODE);
  if(!code){
    code = roomCode();
    sessionStorage.setItem(STORAGE_ROOMCODE, code);
  }
  state.pinEnabled = sessionStorage.getItem(STORAGE_PINENABLED) === '1';
  state.pin = sessionStorage.getItem(STORAGE_PIN) || '';
  state.adminToken = sessionStorage.getItem(STORAGE_ADMINTOKEN) || generateAdminToken();
  sessionStorage.setItem(STORAGE_ADMINTOKEN, state.adminToken);

  const peerId = 'srikaraoke-' + code;
  peer = new Peer(peerId, { config: ICE_CONFIG });

  peer.on('open', (id) => {
    peerRetryCount = 0;
    myRoomId = id;
    document.getElementById('room-code-text').textContent = code;
    document.getElementById('pin-toggle').checked = state.pinEnabled;
    document.getElementById('pin-display-row').style.display = state.pinEnabled ? 'flex' : 'none';
    document.getElementById('pin-value').textContent = state.pin || '----';
    renderRoomQR();
  });

  peer.on('connection', (conn) => {
    let joined = false;
    // Give the remote a few seconds to identify itself; drop silent/unauthenticated connections.
    const joinTimeout = setTimeout(() => { if(!joined){ try{ conn.close(); }catch(e){} } }, 8000);

    conn.on('data', (msg) => {
      if(!joined){
        if(msg.type === 'JOIN'){
          let role = null;
          if(msg.adminToken && msg.adminToken === state.adminToken){
            role = 'admin';
          } else if(!state.pinEnabled || msg.pin === state.pin){
            role = 'guest';
          }
          if(role){
            clearTimeout(joinTimeout);
            joined = true;
            conn._nickname = msg.nickname || '';
            conn._role = role;
            conn._isScreen2 = msg.kind === 'screen2'; // only Screen 2 gets the idle-background pictures
            connections.push(conn);
            conn.send({ type: 'JOIN_OK', role });
            updateConnStatus();
            sendState(conn);
            conn.send({ type: 'LOCAL_LIBRARY', localLibrary: state.localLibrary });
            conn.send({ type: 'CHORDS_LIBRARY', chords: state.chords });
            conn.send({ type: 'SOUND_EFFECTS', effects: soundEffects });
            if(conn._isScreen2){ bgSendSync(conn); camSendConfig(conn); syncLocalAudioToScreen2(); camSync(); }
            if(voteTally.size > 0){
              const tally = {};
              voteTally.forEach((count, id) => { if(count > 0) tally[id] = count; });
              if(Object.keys(tally).length > 0) conn.send({ type: 'VOTE_TALLY', tally });
            }
            {
              const song = currentSong();
              if(song && song.source === 'local'){
                const file = localFiles.get(song.localFileId);
                if(file && isAudioOnlyFile(file.name)){
                  conn.send({ type: 'MP3_LYRICS', songId: song.id, code: song.title, title: currentMp3Lyrics?.title || '', artist: currentMp3Lyrics?.artist || '', lines: currentMp3Lyrics?.lines || null, coverDataUrl: currentMp3Lyrics?.coverDataUrl || null, bgPattern: pickMp3BgPattern(song.localFileId || song.title || '') });
                }
              }
            }
          } else {
            conn.send({ type: 'JOIN_REJECTED' });
            setTimeout(() => { try{ conn.close(); }catch(e){} }, 300);
          }
        }
        return; // ignore anything else until a valid JOIN is received
      }
      handleRemoteMessage(msg, conn);
    });

    conn.on('close', () => {
      const i = connections.indexOf(conn);
      if(i > -1) connections.splice(i, 1);
      updateConnStatus();
      if(conn._isScreen2){ syncLocalAudioToScreen2(); camSync(); }
      // Don't let a vote outlive the connection that cast it — free it up for the tally.
      const votedFor = voteByConn.get(conn.peer);
      if(votedFor){
        voteByConn.delete(conn.peer);
        voteTally.set(votedFor, Math.max(0, (voteTally.get(votedFor) || 0) - 1));
        broadcastVoteTally();
        renderQueue();
      }
    });
  });

  peer.on('disconnected', () => {
    // Lost connection to the PeerJS broker (not the remotes) — try to recover automatically.
    showToast('การเชื่อมต่อสัญญาณขาดหาย กำลังเชื่อมต่อใหม่…', true);
    setTimeout(() => { if(peer && !peer.destroyed) peer.reconnect(); }, 1500);
  });

  peer.on('error', (err) => {
    console.error('PeerJS error', err);
    if(err.type === 'unavailable-id' && peerRetryCount < 3){
      // Room code collided with someone else's session — generate a fresh one and retry.
      peerRetryCount++;
      sessionStorage.removeItem(STORAGE_ROOMCODE);
      initPeer();
      return;
    }
    document.getElementById('conn-status').textContent = 'เกิดข้อผิดพลาดในการเชื่อมต่อ: ' + err.type;
  });
}

function updateConnStatus(){
  const el = document.getElementById('conn-status');
  if(connections.length === 0){ el.textContent = 'รอการเชื่อมต่อ…'; return; }
  const admins = connections.filter(c => c._role === 'admin').length;
  const guests = connections.length - admins;
  const parts = [];
  if(guests) parts.push(`ผู้ใช้ทั่วไป ${guests}`);
  if(admins) parts.push(`แอดมิน ${admins}`);
  el.textContent = 'เชื่อมต่อแล้ว: ' + parts.join(', ');
  renderConnectedDevices();
}

function renderConnectedDevices(){
  const wrap = document.getElementById('connected-devices-list');
  if(!wrap) return;
  if(connections.length === 0){
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = connections.map((c, i) => `
    <div class="device-row">
      <span class="device-role">${c._role === 'admin' ? '👑' : '👤'}</span>
      <span class="device-name">${escapeHtml(c._nickname || 'ไม่ระบุชื่อ')}</span>
      <button data-idx="${i}">ตัดการเชื่อมต่อ</button>
    </div>`).join('');
  wrap.querySelectorAll('button[data-idx]').forEach(btn => {
    btn.onclick = () => {
      const c = connections[parseInt(btn.dataset.idx, 10)];
      if(c){ try{ c.close(); }catch(e){} }
      setTimeout(renderConnectedDevices, 200);
    };
  });
}

// Guests can queue/remove songs and adjust tempo. Admins get full remote control,
// equivalent to standing at the main screen — matches what a scanned Admin QR grants.
const GUEST_ALLOWED = new Set(['ADD_SONG', 'REMOVE_SONG', 'TEMPO_UP', 'TEMPO_DOWN', 'VOLUME_UP', 'VOLUME_DOWN', 'TOGGLE_MUTE', 'PLAY_SOUND_EFFECT', 'EMOJI_REACTION', 'VOTE_NEXT_SONG', 'BG_NEED', 'CHANNEL_MODE', 'CAM_STATS']);
const ADMIN_ALLOWED = new Set([
  ...GUEST_ALLOWED,
  'SKIP', 'PREV', 'TOGGLE_PLAY', 'INSERT_NEXT', 'MOVE_UP', 'MOVE_DOWN', 'REORDER_BEFORE', 'LOAD_PLAYLIST', 'PLAY_SONG'
]);

function handleRemoteMessage(msg, conn){
  const allowed = conn._role === 'admin' ? ADMIN_ALLOWED : GUEST_ALLOWED;
  if(!allowed.has(msg.type)) return;
  switch(msg.type){
    case 'ADD_SONG':
      // A local-file request only makes sense if the file is actually in this device's memory —
      // a remote can only ever have seen the title (never the file itself), so double-check here.
      if(msg.song && msg.song.source === 'local' && !localFiles.has(msg.song.localFileId)){
        showToast('เพลงจากไฟล์ในเครื่องนี้ไม่พร้อมแล้ว (อาจล้างโฟลเดอร์ไปแล้ว) — ไม่ได้เพิ่มเข้าคิว', true);
        break;
      }
      addSong(msg.song, msg.from, false, msg.dedication);
      showToast(`🎵 ${msg.from ? msg.from + ' ' : ''}เพิ่มเพลง "${msg.song.title}" เข้าคิว`);
      break;
    case 'REMOVE_SONG': removeSong(msg.id); break;
    case 'TEMPO_UP': tempoStep(1); break;
    case 'TEMPO_DOWN': tempoStep(-1); break;
    case 'VOLUME_UP': volumeStep(1); break;
    case 'VOLUME_DOWN': volumeStep(-1); break;
    case 'TOGGLE_MUTE': toggleMute(); break;
    case 'PLAY_SOUND_EFFECT': playSoundEffect(msg.file); break;
    case 'SKIP': skip('ข้าม (แอดมินรีโมท)'); break;
    case 'PREV': prevSong(); break;
    case 'TOGGLE_PLAY': togglePlayPause(); break;
    case 'INSERT_NEXT': insertNext(msg.id); break;
    case 'MOVE_UP': moveUp(msg.id); break;
    case 'MOVE_DOWN': moveDown(msg.id); break;
    case 'REORDER_BEFORE': reorderBefore(msg.draggedId, msg.targetId); break;
    case 'LOAD_PLAYLIST': loadPlaylistIntoQueue(msg.name); break;
    case 'PLAY_SONG': playSongId(msg.id); break;
    case 'EMOJI_REACTION':
      showEmojiReaction(msg.emoji);
      connections.forEach(c => { if(c.open) c.send({ type: 'EMOJI_REACTION', emoji: msg.emoji }); });
      break;
    case 'VOTE_NEXT_SONG': handleVoteNextSong(conn, msg.songId); break;
    case 'BG_NEED': bgHandleNeed(conn, msg.keys); break;
    case 'CHANNEL_MODE': setChannelMode(msg.mode); break;
    case 'CAM_STATS': camOnStats(conn, msg); break;
  }
}

/* ---------------- Voting for which queued song plays next (a suggestion to the admin, not automatic —
   the admin still picks what actually plays). Votes reset whenever the current song changes, since
   "next" only makes sense relative to right now. ---------------- */
const voteTally = new Map(); // songId -> vote count
const voteByConn = new Map(); // conn.peer -> the songId that connection currently has a vote on
function handleVoteNextSong(conn, songId){
  if(!state.queue.some(s => s.id === songId && s.id !== state.currentId)) return; // ignore votes for the currently playing song or a song no longer in the queue
  const prevVote = voteByConn.get(conn.peer);
  if(prevVote === songId) return; // no actual change
  if(prevVote) voteTally.set(prevVote, Math.max(0, (voteTally.get(prevVote) || 0) - 1));
  voteByConn.set(conn.peer, songId);
  voteTally.set(songId, (voteTally.get(songId) || 0) + 1);
  broadcastVoteTally();
  renderQueue();
}
function broadcastVoteTally(){
  const tally = {};
  voteTally.forEach((count, id) => { if(count > 0) tally[id] = count; });
  connections.forEach(c => { if(c.open) c.send({ type: 'VOTE_TALLY', tally }); });
}
function clearVotes(){
  if(voteTally.size === 0 && voteByConn.size === 0) return; // nothing to do, avoid a pointless broadcast every song
  voteTally.clear();
  voteByConn.clear();
  broadcastVoteTally();
}

function broadcastState(){
  connections.forEach(conn => { if(conn.open) sendState(conn); });
}
// A lighter periodic ping so long-idle screens (mainly Screen 2, which plays its own copy of the
// video independently) stay roughly in sync without re-sending the whole queue/playlists repeatedly.
// Meaningful for YouTube songs, and for local MP3s with embedded lyrics (Screen 2 needs this timing to
// drive its own word-by-word highlight even though it has no audio file to play) — but not local video
// files, since Screen 2 can't play those at all and has nothing to sync there.
setInterval(() => {
  const song = currentSong();
  if(!song || connections.length === 0) return;
  if(song.source === 'local'){
    const file = localFiles.get(song.localFileId);
    if(!file || !isAudioOnlyFile(file.name)) return;
  }
  const { currentTime: t } = getPlaybackTimes();
  connections.forEach(conn => {
    if(conn.open) conn.send({ type: 'TIME_SYNC', currentId: state.currentId, currentTime: t });
  });
}, 4000);
function sendState(conn){
  const { currentTime } = getPlaybackTimes();
  conn.send({
    type: 'STATE_UPDATE',
    queue: state.queue,
    currentId: state.currentId,
    currentTime: currentTime,
    isPlaying: state.isPlaying,
    tempo: state.tempo,
    volume: state.volume,
    muted: state.muted,
    channelMode: state.channelMode,
    playlists: state.playlists,
    localLibrary: state.localLibrary
  });
}

/* ---------------- Playlists (host only) ---------------- */
function renderPlaylists(){
  const wrap = document.getElementById('pl-list');
  const names = Object.keys(state.playlists);
  if(names.length === 0){
    wrap.innerHTML = '<div class="empty-note">ยังไม่มีเพลย์ลิสต์ที่บันทึกไว้</div>';
    return;
  }
  wrap.innerHTML = '';
  names.forEach(name => {
    const row = document.createElement('div');
    row.className = 'pl-row';
    row.innerHTML = `
      <div class="name">${escapeHtml(name)}</div>
      <div class="count">${state.playlists[name].length} เพลง</div>
      <button data-act="load">โหลดเข้าคิว</button>
      <button data-act="del">ลบ</button>`;
    row.querySelector('[data-act="load"]').onclick = () => loadPlaylistIntoQueue(name);
    row.querySelector('[data-act="del"]').onclick = () => {
      delete state.playlists[name];
      savePlaylists();
      renderPlaylists();
    };
    wrap.appendChild(row);
  });
}

function loadPlaylistIntoQueue(name){
  const songs = state.playlists[name];
  if(!songs) return;
  const prev = currentSong();
  if(prev) addToHistory(prev, 'เปลี่ยนเพลย์ลิสต์');
  state.queue = songs.map(s => ({ ...s, id: uid() }));
  state.currentId = null;
  if(state.queue.length) recordAndSetCurrent(null, state.queue[0].id, 'เปลี่ยนเพลย์ลิสต์');
  else renderQueue();
  closeModal('playlist-modal');
}

function savePlaylistFromQueue(name){
  if(!name || state.queue.length === 0) return;
  state.playlists[name] = state.queue.map(({ source, videoId, localFileId, title, thumbnail, by }) => ({
    source: source || 'youtube', videoId, localFileId, title, thumbnail, by
  }));
  savePlaylists();
  renderPlaylists();
}

function exportBackup(){
  const hasData = Object.keys(state.playlists).length > 0 || state.history.length > 0;
  if(!hasData){
    showToast('ยังไม่มีข้อมูลให้สำรอง', true);
    return;
  }
  const payload = {
    type: 'sri-karaoke-backup',
    version: 1,
    exportedAt: Date.now(),
    playlists: state.playlists,
    history: state.history
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sri-karaoke-backup.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importBackupFromFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try{
      const data = JSON.parse(e.target.result);
      if(typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('bad format');

      let plCount = 0, histCount = 0;

      // Playlists — also accepts an older playlists-only export file (no "type"/"playlists" wrapper).
      const plSource = (data.playlists && typeof data.playlists === 'object' && !Array.isArray(data.playlists))
        ? data.playlists
        : (!data.type && !data.history ? data : null);
      if(plSource){
        Object.keys(plSource).forEach(name => {
          const songs = plSource[name];
          if(!Array.isArray(songs)) return;
          const cleaned = songs
            .filter(s => s && s.title && (s.videoId || s.localFileId))
            .map(s => ({
              source: s.source || (s.localFileId ? 'local' : 'youtube'),
              videoId: s.videoId, localFileId: s.localFileId,
              title: s.title, thumbnail: s.thumbnail || '', by: s.by || ''
            }));
          if(cleaned.length === 0) return;
          const finalName = state.playlists[name] ? name + ' (นำเข้า)' : name;
          state.playlists[finalName] = cleaned;
          plCount++;
        });
      }

      // History — merged in alongside existing entries, newest first, capped at 200.
      if(Array.isArray(data.history)){
        data.history.forEach(h => {
          if(h && h.title && (h.videoId || h.localFileId)){
            state.history.push({
              id: uid(), source: h.source || (h.localFileId ? 'local' : 'youtube'),
              videoId: h.videoId, localFileId: h.localFileId, title: h.title, thumbnail: h.thumbnail || '',
              by: h.by || '', reason: h.reason || '', playedAt: h.playedAt || Date.now()
            });
            histCount++;
          }
        });
        state.history.sort((a, b) => b.playedAt - a.playedAt);
        if(state.history.length > 200) state.history.length = 200;
      }

      if(plCount === 0 && histCount === 0) throw new Error('nothing to import');

      savePlaylists();
      saveHistory();
      renderPlaylists();

      const parts = [];
      if(plCount) parts.push(`เพลย์ลิสต์ ${plCount}`);
      if(histCount) parts.push(`ประวัติ ${histCount} รายการ`);
      showToast('นำเข้าสำเร็จ: ' + parts.join(', '));
    }catch(err){
      showToast('นำเข้าไฟล์ไม่สำเร็จ — รูปแบบไฟล์ไม่ถูกต้อง', true);
    }
  };
  reader.readAsText(file);
}

/* ---------------- History (host only) ---------------- */
function renderHistory(){
  const wrap = document.getElementById('history-list');
  if(state.history.length === 0){
    wrap.innerHTML = '<div class="empty-note">ยังไม่มีประวัติเพลงที่เล่นไปแล้ว</div>';
    return;
  }
  wrap.innerHTML = '';
  state.history.forEach(h => {
    const row = document.createElement('div');
    row.className = 'hist-row';
    const badge = h.source === 'local' ? '<span class="source-badge local">💻</span>' : '';
    row.innerHTML = `
      <img src="${escapeHtml(h.thumbnail)}" alt="">
      <div class="meta">
        <div class="title">${badge}${escapeHtml(h.title)}</div>
        <div class="sub">${h.by ? 'เพิ่มโดย ' + escapeHtml(h.by) + ' · ' : ''}${escapeHtml(h.reason)} · ${formatTimeAgo(h.playedAt)}</div>
      </div>
      <button data-act="requeue" title="เพิ่มเข้าคิวอีกครั้ง">+ คิว</button>`;
    row.querySelector('[data-act="requeue"]').onclick = (e) => {
      addSong({
        source: h.source || 'youtube', videoId: h.videoId, localFileId: h.localFileId,
        title: h.title, thumbnail: h.thumbnail
      }, 'จอหลัก', false);
      e.target.textContent = 'เพิ่มแล้ว ✓';
      e.target.disabled = true;
    };
    wrap.appendChild(row);
  });
}

function clearHistory(){
  state.history = [];
  saveHistory();
  renderHistory();
}

// Clears the queue, scores, and history for a fresh event — but deliberately keeps saved playlists,
// since those are the reusable thing people want to keep across different parties.
// Computed from whatever is still in state.scores/state.history right before startNewParty wipes them
// — this is the only point in the app's lifecycle where "the whole night" is still available to look
// back on, so the summary has to be built here, right before the reset actually happens.
function computeNightSummary(){
  const scores = state.scores;
  const history = state.history;
  if(scores.length === 0 && history.length === 0) return null;

  const byAvg = {};
  scores.forEach(s => {
    const name = s.by || '';
    if(!name) return;
    if(!byAvg[name]) byAvg[name] = { total: 0, count: 0 };
    byAvg[name].total += s.score;
    byAvg[name].count++;
  });
  let bestSinger = null, bestAvg = -1;
  Object.entries(byAvg).forEach(([name, agg]) => {
    const avg = agg.total / agg.count;
    if(avg > bestAvg){ bestAvg = avg; bestSinger = name; }
  });

  const songCounts = {};
  history.forEach(h => { songCounts[h.title] = (songCounts[h.title] || 0) + 1; });
  let hitSong = null, hitCount = 0;
  Object.entries(songCounts).forEach(([title, count]) => { if(count > hitCount){ hitCount = count; hitSong = title; } });

  const singCounts = {};
  history.forEach(h => { if(h.by) singCounts[h.by] = (singCounts[h.by] || 0) + 1; });
  let mostActive = null, mostActiveCount = 0;
  Object.entries(singCounts).forEach(([name, count]) => { if(count > mostActiveCount){ mostActiveCount = count; mostActive = name; } });

  let topScore = null;
  scores.forEach(s => { if(!topScore || s.score > topScore.score) topScore = s; });

  return {
    totalSongs: history.length,
    bestSinger: bestSinger ? { name: bestSinger, avg: Math.round(byAvg[bestSinger].total / byAvg[bestSinger].count) } : null,
    hitSong: hitSong && hitCount > 1 ? { title: hitSong, count: hitCount } : null, // only interesting if it actually repeated
    mostActive: mostActive ? { name: mostActive, count: mostActiveCount } : null,
    topScore: topScore ? { name: topScore.by || 'ไม่ระบุชื่อ', title: topScore.title, score: topScore.score } : null
  };
}

function showNightSummary(summary, onClose){
  const overlay = document.getElementById('night-summary-overlay');
  const statsEl = document.getElementById('night-summary-stats');
  let html = `<div class="ns-row"><span class="ns-label">🎵 เพลงที่เล่นทั้งหมด</span><span class="ns-value">${summary.totalSongs} เพลง</span></div>`;
  if(summary.bestSinger) html += `<div class="ns-row"><span class="ns-label">🏆 นักร้องยอดเยี่ยม</span><span class="ns-value">${escapeHtml(summary.bestSinger.name)} (เฉลี่ย ${summary.bestSinger.avg} คะแนน)</span></div>`;
  if(summary.hitSong) html += `<div class="ns-row"><span class="ns-label">🔥 เพลงฮิตที่สุด</span><span class="ns-value">${escapeHtml(summary.hitSong.title)} (เล่น ${summary.hitSong.count} ครั้ง)</span></div>`;
  if(summary.mostActive) html += `<div class="ns-row"><span class="ns-label">🎤 ร้องมากที่สุด</span><span class="ns-value">${escapeHtml(summary.mostActive.name)} (${summary.mostActive.count} เพลง)</span></div>`;
  if(summary.topScore) html += `<div class="ns-row"><span class="ns-label">⭐ คะแนนสูงสุดของคืนนี้</span><span class="ns-value">${escapeHtml(summary.topScore.name)} — ${summary.topScore.score} คะแนน (${escapeHtml(summary.topScore.title)})</span></div>`;
  statsEl.innerHTML = html;
  overlay.style.display = 'flex';
  document.getElementById('btn-close-night-summary').onclick = () => {
    overlay.style.display = 'none';
    if(onClose) onClose();
  };
}

function startNewParty(){
  if(!confirm('เริ่มงานใหม่? ระบบจะล้างคิวเพลง คะแนน และประวัติทั้งหมด (เพลย์ลิสต์ที่บันทึกไว้จะไม่ถูกลบ)')) return;
  const summary = computeNightSummary();
  const doReset = () => {
    state.queue = [];
    state.currentId = null;
    stopPlayer();
    state.scores = [];
    saveScores();
    state.history = [];
    saveHistory();
    renderQueue();
    showToast('เริ่มงานใหม่แล้ว — คิว คะแนน และประวัติถูกล้างแล้ว');
  };
  if(summary) showNightSummary(summary, doReset);
  else doReset();
}

/* ---------------- Search (single-screen mode: search & queue/play directly) ---------------- */
function updateHostSearchHint(){
  const key = getApiKey();
  document.getElementById('host-search-hint').textContent = key
    ? 'พิมพ์ชื่อเพลงเพื่อค้นหา หรือวางลิงก์ YouTube โดยตรง'
    : 'ยังไม่ได้ตั้งค่า API Key — วางลิงก์ YouTube โดยตรงเพื่อเพิ่มเพลงได้เลย หรือใส่ API Key ด้านล่างเพื่อค้นหาด้วยคำ';
}

function makeHostResultCard(v){
  const card = document.createElement('div');
  card.className = 'result-card';
  const badge = v.source === 'local'
    ? '<span class="source-badge local">💻 อุปกรณ์</span>'
    : '<span class="source-badge yt">▶ YouTube</span>';
  card.innerHTML = `
    <img src="${escapeHtml(v.thumbnail)}" alt="">
    <div class="meta">
      <div class="title">${badge}${escapeHtml(v.title)}</div>
      <div class="channel">${escapeHtml(v.channel)}</div>
    </div>
    <div class="result-actions">
      <button data-act="play">▶ เล่นเลย</button>
      <button data-act="queue">+ คิว</button>
    </div>`;
  const songPayload = v.source === 'local'
    ? { source: 'local', localFileId: v.localFileId, title: v.title }
    : { source: 'youtube', videoId: v.videoId, title: v.title, thumbnail: v.thumbnail };
  card.querySelector('[data-act="play"]').onclick = () => {
    addSong(songPayload, 'จอหลัก', true);
  };
  card.querySelector('[data-act="queue"]').onclick = (e) => {
    addSong(songPayload, 'จอหลัก', false);
    e.target.textContent = 'เพิ่มแล้ว ✓';
    e.target.disabled = true;
  };
  return card;
}

// Whether YouTube searches are biased toward karaoke/instrumental versions ("karaoke" appended to
// the query) or left as a plain search for the regular studio/vocal version of the song.
let hostSearchMode = sessionStorage.getItem('sriKaraoke_searchMode') || 'karaoke';

// Live, instant filtering of the LOCAL music library only as the user types — free (no API calls),
// so it can safely update on every keystroke. Calling the YouTube API on every keystroke instead
// would burn through the API quota very fast, so that still waits for an explicit "ค้นหา" click/Enter.
function liveLocalSearch(q){
  const resultsEl = document.getElementById('host-search-results');
  if(!q){ resultsEl.innerHTML = ''; return; }
  if(extractVideoId(q)) return; // a pasted YouTube link — leave it for the explicit search instead
  const matches = state.localLibrary
    .filter(f => f.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 15)
    .map(f => ({ source: 'local', localFileId: f.id, title: f.title, channel: 'ไฟล์ในเครื่อง', thumbnail: LOCAL_FILE_THUMB }));
  resultsEl.innerHTML = '';
  matches.forEach(m => resultsEl.appendChild(makeHostResultCard(m)));
  if(matches.length === 0){
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'ไม่พบไฟล์ในเครื่องที่ตรงกับคำนี้ — กด "ค้นหา" เพื่อค้นหาจาก YouTube ด้วย';
    resultsEl.appendChild(note);
  }
}

// "ยอดนิยม" — actual trending/popular MUSIC videos from YouTube (chart=mostPopular, Music category,
// Thailand region), not the play history (that's now its own separate "ประวัติ" button).
async function fetchPopularSongs(){
  const resultsEl = document.getElementById('host-search-results');
  document.getElementById('host-search-input').value = '';
  const key = getApiKey();
  if(!key){
    resultsEl.innerHTML = '<p class="hint">ต้องตั้งค่า YouTube API Key ก่อนถึงจะดึงเพลงยอดนิยมได้ — ไปที่เมนู "⚙️ ตั้งค่า"</p>';
    return;
  }
  resultsEl.innerHTML = '<p class="hint">กำลังโหลดเพลงยอดนิยม…</p>';
  try{
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&regionCode=TH&maxResults=20&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if(data.error){
      resultsEl.innerHTML = `<p class="hint">เกิดข้อผิดพลาด: ${escapeHtml(data.error.message)}</p>`;
      return;
    }
    resultsEl.innerHTML = '';
    (data.items || []).forEach(item => {
      resultsEl.appendChild(makeHostResultCard({
        source: 'youtube',
        videoId: item.id,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails.medium.url
      }));
    });
    if((data.items || []).length === 0) resultsEl.innerHTML = '<p class="hint">ดึงเพลงยอดนิยมไม่สำเร็จ ลองใหม่อีกครั้ง</p>';
  }catch(e){
    resultsEl.innerHTML = '<p class="hint">ดึงเพลงยอดนิยมไม่สำเร็จ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต</p>';
  }
}

async function doHostSearch(){
  const q = document.getElementById('host-search-input').value.trim();
  if(!q) return;
  const resultsEl = document.getElementById('host-search-results');

  const videoId = extractVideoId(q);
  if(videoId){
    resultsEl.innerHTML = '';
    resultsEl.appendChild(makeHostResultCard({
      source: 'youtube', videoId, title: q, channel: 'ลิงก์ที่วาง', thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
    }));
    return;
  }

  // Local files (from the folder picked in ⚙️ ตั้งค่า) are matched by simple substring first —
  // fast, no network needed, and shown alongside YouTube results either way.
  const localMatches = state.localLibrary
    .filter(f => f.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8)
    .map(f => ({ source: 'local', localFileId: f.id, title: f.title, channel: 'ไฟล์ในเครื่อง', thumbnail: LOCAL_FILE_THUMB }));

  const key = getApiKey();
  if(!key){
    resultsEl.innerHTML = '';
    localMatches.forEach(m => resultsEl.appendChild(makeHostResultCard(m)));
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = localMatches.length
      ? 'แสดงเฉพาะผลจากไฟล์ในเครื่อง — ยังไม่ได้ตั้งค่า API Key จึงค้นหาจาก YouTube ด้วยคำไม่ได้ (วางลิงก์ YouTube แทนได้)'
      : 'ยังไม่ได้ตั้งค่า API Key จึงค้นหาด้วยคำไม่ได้ — วางลิงก์ YouTube แทน หรือใส่ API Key ที่เมนู "⚙️ ตั้งค่า"';
    resultsEl.appendChild(note);
    return;
  }

  resultsEl.innerHTML = '<p class="hint">กำลังค้นหา…</p>';
  try{
    const searchQuery = hostSearchMode === 'karaoke' ? q + ' karaoke' : q;
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=12&type=video&q=${encodeURIComponent(searchQuery)}&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if(data.error){
      resultsEl.innerHTML = `<p class="hint">เกิดข้อผิดพลาด: ${escapeHtml(data.error.message)}</p>`;
      return;
    }
    resultsEl.innerHTML = '';
    localMatches.forEach(m => resultsEl.appendChild(makeHostResultCard(m)));
    (data.items || []).forEach(item => {
      resultsEl.appendChild(makeHostResultCard({
        source: 'youtube',
        videoId: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails.medium.url
      }));
    });
    if((data.items || []).length === 0 && localMatches.length === 0) resultsEl.innerHTML = '<p class="hint">ไม่พบผลลัพธ์ ลองคำค้นอื่น</p>';
  }catch(e){
    resultsEl.innerHTML = '';
    localMatches.forEach(m => resultsEl.appendChild(makeHostResultCard(m)));
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'ค้นหาจาก YouTube ไม่สำเร็จ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต (แสดงเฉพาะผลจากไฟล์ในเครื่องได้ตามปกติ)';
    resultsEl.appendChild(note);
  }
}

/* ---------------- Local music library (host only — files never leave this device) ---------------- */
/* ---------------- MP3 embedded lyrics (ID3 "LyrHdr1" format) ----------------
   Some Thai karaoke MP3 files embed word-by-word synced lyrics (and sometimes cover art) inside a
   custom ID3v2 frame. The lyrics are stored as: a "LyrHdr1" prefix, then base64, then zlib-compressed
   XML text (itself encoded as Thai codepage 874, not UTF-8 despite what its own XML header claims).
   Everything here runs entirely in the browser — the file never leaves this device. */
const AUDIO_ONLY_EXT = /\.(mp3|wav|m4a|aac|flac|oga|wma)$/i;
function isAudioOnlyFile(name){ return AUDIO_ONLY_EXT.test(name || ''); }

function synchsafeInt(view, offset){
  return (view.getUint8(offset) << 21) | (view.getUint8(offset + 1) << 14) | (view.getUint8(offset + 2) << 7) | view.getUint8(offset + 3);
}
function bytesToBase64(bytes){
  let binary = '';
  const chunkSize = 0x8000;
  for(let i = 0; i < bytes.length; i += chunkSize){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
async function inflateZlib(bytes){
  // Native browser decompression (Chrome 80+, Firefox 113+, Safari 16.4+) — no external library needed.
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
function parseLyricXml(xmlString){
  try{
    const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
    const perr = doc.querySelector('parsererror');
    if(perr){
      console.warn('[MP3 Lyrics] XML failed to parse:', perr.textContent?.slice(0, 300));
      console.debug('[MP3 Lyrics] Raw XML that failed (first 600 chars):', JSON.stringify(xmlString.slice(0, 600)));
      return null;
    }
    console.debug('[MP3 Lyrics] XML root element:', doc.documentElement?.nodeName);
    const info = doc.querySelector('INFO');
    const title = info?.querySelector('TITLE')?.textContent?.trim() || '';
    const artist = info?.querySelector('ARTIST')?.textContent?.trim() || '';
    const lineEls = doc.querySelectorAll('LYRIC > LINE');
    console.debug('[MP3 Lyrics] LYRIC > LINE elements found:', lineEls.length);
    if(lineEls.length === 0){
      console.debug('[MP3 Lyrics] No LINE elements matched — raw XML for inspection (first 900 chars):', JSON.stringify(xmlString.slice(0, 900)));
    }
    const lines = [];
    lineEls.forEach(lineEl => {
      const words = [];
      lineEl.querySelectorAll('WORD').forEach(wordEl => {
        const t = parseInt(wordEl.querySelector('TIME')?.textContent || '0', 10);
        const text = wordEl.querySelector('TEXT')?.textContent || '';
        words.push({ time: t, text });
      });
      if(words.length) lines.push({ words, startTime: words[0].time });
    });
    return lines.length ? { lines, title, artist } : null;
  }catch(e){
    console.error('[MP3 Lyrics] parseLyricXml threw an exception:', e);
    return null;
  }
}
async function extractMp3Lyrics(file){
  try{
    console.debug('[MP3 Lyrics] Reading file:', file.name, file.size, 'bytes');
    const buf = await file.arrayBuffer();
    const view = new DataView(buf);
    if(buf.byteLength < 10 || view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33){
      console.debug('[MP3 Lyrics] No ID3v2 tag found at the start of this file — nothing to extract.');
      return null;
    }
    const majorVersion = view.getUint8(3);
    const flags = view.getUint8(5);
    const tagSize = synchsafeInt(view, 6);
    let offset = 10;
    const end = Math.min(10 + tagSize, buf.byteLength);
    if(flags & 0x40){ // extended header present — skip over it
      const extSize = majorVersion >= 4 ? synchsafeInt(view, offset) : view.getUint32(offset, false);
      offset += extSize + (majorVersion >= 4 ? 0 : 4);
    }
    // Frame sizes are supposed to be plain 32-bit big-endian in ID3v2.3 and synchsafe (7 bits/byte) in
    // ID3v2.4 — but some real-world tagging tools (including whatever wrote files like this one) label
    // their output as v2.3 while actually writing v2.4-style synchsafe sizes anyway. Rather than trust
    // the declared version blindly (which silently reads the frame boundary wrong, corrupting
    // everything read afterward), check whether the resulting boundary actually lands on a sane next
    // frame ID, and fall back to the other interpretation if it doesn't.
    function frameBoundaryLooksValid(startOffset, size){
      if(size <= 0) return false;
      const nextOffset = startOffset + 10 + size;
      // Past the tag's own declared boundary is never valid, even if it's still within the file overall
      // (the rest of the file past the tag is the actual MP3 audio stream, not more ID3 frames).
      if(nextOffset > end || nextOffset > buf.byteLength - 4) return false;
      if(nextOffset >= end - 10) return true; // right at the tag's end (likely just padding) — plausible
      const nextId = String.fromCharCode(view.getUint8(nextOffset), view.getUint8(nextOffset + 1), view.getUint8(nextOffset + 2), view.getUint8(nextOffset + 3));
      return /^[A-Z0-9]{4}$/.test(nextId) || nextId === '\u0000\u0000\u0000\u0000';
    }
    let coverBytes = null, coverMime = null;
    while(offset < end - 10){
      const frameId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
      if(frameId === '\u0000\u0000\u0000\u0000') break;
      if(!/^[A-Z0-9]{4}$/.test(frameId)) break; // hit padding or garbage — stop here
      const sizeDeclared = majorVersion >= 4 ? synchsafeInt(view, offset + 4) : view.getUint32(offset + 4, false);
      const sizeAlternate = majorVersion >= 4 ? view.getUint32(offset + 4, false) : synchsafeInt(view, offset + 4);
      let frameSize = sizeDeclared;
      if(!frameBoundaryLooksValid(offset, frameSize) && frameBoundaryLooksValid(offset, sizeAlternate)){
        frameSize = sizeAlternate; // this file's writer used the size format for the other ID3 version
      }
      if(frameSize <= 0 || offset + 10 + frameSize > buf.byteLength) break;
      const frameStart = offset + 10;
      if(frameId === 'APIC' && !coverBytes){
        try{
          let p = frameStart;
          const frameEnd = frameStart + frameSize;
          const encoding = view.getUint8(p); p += 1;
          let mimeEnd = p;
          while(mimeEnd < frameEnd && view.getUint8(mimeEnd) !== 0) mimeEnd++;
          coverMime = new TextDecoder('latin1').decode(new Uint8Array(buf, p, mimeEnd - p)) || 'image/jpeg';
          p = mimeEnd + 1;
          p += 1; // picture type byte
          if(encoding === 1 || encoding === 2){
            while(p < frameEnd - 1 && !(view.getUint8(p) === 0 && view.getUint8(p + 1) === 0)) p += 2;
            p += 2;
          } else {
            while(p < frameEnd && view.getUint8(p) !== 0) p++;
            p += 1;
          }
          coverBytes = new Uint8Array(buf, p, Math.max(0, frameEnd - p));
        }catch(e){ coverBytes = null; }
      }
      offset = frameStart + frameSize;
    }
    // The lyrics payload is found by scanning for its literal "LyrHdr1" signature directly, rather
    // than trusting any frame's declared size to delimit it — frame sizes from this software have
    // proven unreliable across different files in ways a single boundary-validation heuristic doesn't
    // fully catch. Once the signature is found, the base64 payload is self-delimiting: just keep
    // consuming valid base64 characters until hitting one that isn't (the start of the next frame, a
    // null byte, etc.) — this works regardless of what the frame header claims.
    const scanEnd = Math.min(end + 4096, buf.byteLength); // small margin past the tag in case its own declared size is also off
    const scanRegion = new Uint8Array(buf, 0, scanEnd);
    let asBytes = '';
    for(let i = 0; i < scanRegion.length; i++) asBytes += String.fromCharCode(scanRegion[i]);
    const sigIndex = asBytes.indexOf('LyrHdr1');
    console.debug('[MP3 Lyrics] "LyrHdr1" signature found at byte offset:', sigIndex, '| APIC (cover) frame found:', !!coverBytes);
    let parsed = null;
    if(sigIndex !== -1){
      let i = sigIndex + 7;
      const isBase64Char = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '+' || c === '/' || c === '=';
      while(i < asBytes.length && isBase64Char(asBytes[i])) i++;
      const b64 = asBytes.slice(sigIndex + 7, i);
      console.debug('[MP3 Lyrics] Extracted base64 payload length:', b64.length);
      {
        try{
          const binStr = atob(b64);
          const compressed = new Uint8Array(binStr.length);
          for(let i = 0; i < binStr.length; i++) compressed[i] = binStr.charCodeAt(i);
          if(typeof DecompressionStream === 'undefined'){
            console.warn('[MP3 Lyrics] This browser does not support DecompressionStream — cannot read embedded lyrics. Showing background+title only.');
          } else {
            const inflated = await inflateZlib(compressed);
            console.debug('[MP3 Lyrics] Decompressed', inflated.length, 'bytes of XML lyric data.');
            const xmlText = new TextDecoder('windows-874').decode(inflated);
            parsed = parseLyricXml(xmlText);
            console.debug('[MP3 Lyrics] Parsed lyric lines:', parsed ? parsed.lines.length : 'PARSING FAILED (see next warning if any)');
          }
        }catch(innerErr){
          console.warn('[MP3 Lyrics] Failed to decode/decompress/parse the embedded lyric data:', innerErr);
        }
      }
    } else {
      console.debug('[MP3 Lyrics] No "LyrHdr1" signature found anywhere in this file\'s ID3 tag — not this karaoke format, or a different one.');
    }
    let coverDataUrl = null;
    if(coverBytes && coverBytes.length > 0){
      coverDataUrl = `data:${coverMime || 'image/jpeg'};base64,${bytesToBase64(coverBytes)}`;
    }
    if(!parsed && !coverDataUrl){
      console.debug('[MP3 Lyrics] No lyrics and no cover art found for this file — showing background+title only.');
      return null;
    }
    return { lines: parsed?.lines || null, title: parsed?.title || '', artist: parsed?.artist || '', coverDataUrl };
  }catch(e){
    console.warn('[MP3 Lyrics] Unexpected error while parsing this file:', e);
    return null;
  }
}
const mp3LyricsCache = new Map(); // localFileId -> parsed result | null
async function getMp3Lyrics(song){
  if(mp3LyricsCache.has(song.localFileId)) return mp3LyricsCache.get(song.localFileId);
  const file = localFiles.get(song.localFileId);
  if(!file) return null;
  const result = await extractMp3Lyrics(file);
  mp3LyricsCache.set(song.localFileId, result);
  return result;
}

/* ---------------- MP3 now-playing screen + word-by-word lyric rendering ---------------- */
let currentMp3Lyrics = null; // { lines, title, artist, coverDataUrl } for the currently loaded song, or null
let currentLyricLineIndex = -1;
let mp3LyricsLoadToken = 0; // guards against a slow parse resolving after the user has already skipped away

function hideMp3NowPlaying(){
  document.getElementById('mp3-now-playing').style.display = 'none';
  document.getElementById('mp3-lyrics').style.display = 'none';
  document.getElementById('mp3-title-row').style.display = 'none';
  document.getElementById('mp3-artist-row').style.display = 'none';
  document.getElementById('mp3-progress-wrap').style.display = 'none';
  document.getElementById('mp3-bg').classList.remove('has-cover', ...MP3_BG_PATTERNS);
  document.getElementById('mp3-bg').style.backgroundImage = '';
  currentMp3Lyrics = null;
  currentLyricLineIndex = -1;
  mp3LyricsLoadToken++;
  connections.forEach(c => { if(c.open) c.send({ type: 'MP3_LYRICS', songId: null, code: '', title: '', artist: '', lines: null, coverDataUrl: null }); });
}

// A small set of CSS-only gradient backgrounds used on the MP3 "now playing" screen whenever a file
// has no embedded cover art, so it isn't just a plain flat background every time. The pick is a
// deterministic hash of the file's id, not actual randomness — so the same file always lands on the
// same pattern rather than jumping around on every replay.
const MP3_BG_PATTERNS = ['pattern-1', 'pattern-2', 'pattern-3', 'pattern-4', 'pattern-5'];
function pickMp3BgPattern(seed){
  let hash = 0;
  for(let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return MP3_BG_PATTERNS[hash % MP3_BG_PATTERNS.length];
}

function loadMp3LyricsForSong(song){
  const myToken = ++mp3LyricsLoadToken;
  currentMp3Lyrics = null;
  currentLyricLineIndex = -1;
  document.getElementById('mp3-now-playing').style.display = 'flex';
  document.getElementById('mp3-lyrics').style.display = 'none';
  document.getElementById('mp3-title-row').style.display = 'none';
  document.getElementById('mp3-artist-row').style.display = 'none';
  const mp3BgEl = document.getElementById('mp3-bg');
  mp3BgEl.classList.remove('has-cover', ...MP3_BG_PATTERNS);
  mp3BgEl.style.backgroundImage = '';
  // Show a pattern immediately (same one every time for this exact file, so it doesn't flicker between
  // different patterns on repeat plays) — swapped out for real cover art below if the file has one.
  mp3BgEl.classList.add(pickMp3BgPattern(song.localFileId || song.title || ''));
  // "รหัสเพลง" always shows the filename-derived title — for files where the filename already IS a
  // real song name (not an actual code), this row just ends up showing that name, which is fine; the
  // "ชื่อเพลง"/"นักร้อง" rows below only appear once the embedded metadata actually decodes successfully.
  document.getElementById('mp3-code').textContent = song.title;
  document.getElementById('mp3-title').textContent = '';
  document.getElementById('mp3-artist').textContent = '';
  console.debug('[MP3 Lyrics] Loading lyrics for:', song.title, '| localFileId:', song.localFileId, '| file in memory:', localFiles.has(song.localFileId));
  getMp3Lyrics(song).then(result => {
    console.debug('[MP3 Lyrics] Result for', song.title, ':', result ? { hasLines: !!result.lines, lineCount: result.lines?.length, hasCover: !!result.coverDataUrl, decodedTitle: result.title, artist: result.artist } : 'null (no lyrics/cover found)');
    if(myToken !== mp3LyricsLoadToken) { console.debug('[MP3 Lyrics] Discarding result — a different song loaded meanwhile.'); return; }
    currentMp3Lyrics = result;
    if(result && result.title){
      document.getElementById('mp3-title').textContent = result.title;
      document.getElementById('mp3-title-row').style.display = 'flex';
    }
    if(result && result.artist){
      document.getElementById('mp3-artist').textContent = result.artist;
      document.getElementById('mp3-artist-row').style.display = 'flex';
    }
    if(result && result.coverDataUrl){
      document.getElementById('mp3-bg').classList.remove(...MP3_BG_PATTERNS);
      document.getElementById('mp3-bg').style.backgroundImage = `url("${result.coverDataUrl}")`;
      document.getElementById('mp3-bg').classList.add('has-cover');
    }
    document.getElementById('mp3-lyrics').style.display = (result && result.lines) ? 'flex' : 'none';
    broadcastMp3Lyrics(song, result);
  }).catch(err => {
    console.error('[MP3 Lyrics] Unexpected error loading lyrics:', err);
  });
}

function broadcastMp3Lyrics(song, result){
  const payload = {
    type: 'MP3_LYRICS',
    songId: song.id,
    code: song.title,
    title: result?.title || '',
    artist: result?.artist || '',
    lines: result?.lines || null,
    coverDataUrl: result?.coverDataUrl || null,
    bgPattern: pickMp3BgPattern(song.localFileId || song.title || '') // sent along so Screen 2 shows the exact same pattern as the host, not an independently-picked one
  };
  connections.forEach(c => { if(c.open) c.send(payload); });
}

function buildLyricLineWords(container, line){
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

function renderMp3Lyrics(){
  if(document.getElementById('mp3-now-playing').style.display === 'none') return;
  if(!currentMp3Lyrics || !currentMp3Lyrics.lines) return;
  const { currentTime } = getPlaybackTimes();
  // Sound routed to Screen 2 arrives a little late, so hold the highlight back by the same amount
  const curMs = currentTime * 1000 - (state.audioOutput === 'screen2' ? audioLatencyMs : 0);
  const lines = currentMp3Lyrics.lines;
  let idx = -1;
  for(let i = 0; i < lines.length; i++){
    if(lines[i].startTime <= curMs) idx = i; else break;
  }
  if(idx !== currentLyricLineIndex){
    currentLyricLineIndex = idx;
    buildLyricLineWords(document.getElementById('lyric-line-current'), idx >= 0 ? lines[idx] : null);
    buildLyricLineWords(document.getElementById('lyric-line-next'), idx + 1 < lines.length ? lines[idx + 1] : null);
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
setInterval(renderMp3Lyrics, 100);

/* ---------------- MP3 progress bar + seeking ---------------- */
function formatMp3Time(seconds){
  seconds = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function updateMp3Progress(){
  const wrap = document.getElementById('mp3-progress-wrap');
  if(document.getElementById('mp3-now-playing').style.display === 'none'){ wrap.style.display = 'none'; return; }
  const song = currentSong();
  if(!song || song.source !== 'local' || !localPlayer || !localPlayer.duration){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  if(mp3Seeking) return; // don't fight the user's drag with the playback position
  const { currentTime, duration } = getPlaybackTimes();
  const pct = duration ? Math.min(100, (currentTime / duration) * 100) : 0;
  document.getElementById('mp3-progress-fill').style.width = pct + '%';
  document.getElementById('mp3-progress-handle').style.left = pct + '%';
  document.getElementById('mp3-time-current').textContent = formatMp3Time(currentTime);
  document.getElementById('mp3-time-total').textContent = formatMp3Time(duration);
}
setInterval(updateMp3Progress, 500);

let mp3Seeking = false;
function seekMp3ToClientX(clientX){
  const track = document.getElementById('mp3-progress-track');
  const rect = track.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  document.getElementById('mp3-progress-fill').style.width = (pct * 100) + '%';
  document.getElementById('mp3-progress-handle').style.left = (pct * 100) + '%';
  if(localPlayer && localPlayer.duration){
    document.getElementById('mp3-time-current').textContent = formatMp3Time(pct * localPlayer.duration);
    return pct * localPlayer.duration;
  }
  return null;
}
function commitMp3Seek(clientX){
  const t = seekMp3ToClientX(clientX);
  if(t !== null && localPlayer) localPlayer.currentTime = t;
}
(function wireMp3ProgressSeek(){
  const track = document.getElementById('mp3-progress-track');
  track.addEventListener('mousedown', (e) => { mp3Seeking = true; seekMp3ToClientX(e.clientX); });
  document.addEventListener('mousemove', (e) => { if(mp3Seeking) seekMp3ToClientX(e.clientX); });
  document.addEventListener('mouseup', (e) => { if(mp3Seeking){ mp3Seeking = false; commitMp3Seek(e.clientX); } });
  track.addEventListener('touchstart', (e) => { mp3Seeking = true; seekMp3ToClientX(e.touches[0].clientX); }, { passive: true });
  document.addEventListener('touchmove', (e) => { if(mp3Seeking) seekMp3ToClientX(e.touches[0].clientX); }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if(mp3Seeking){
      mp3Seeking = false;
      const touch = e.changedTouches && e.changedTouches[0];
      if(touch) commitMp3Seek(touch.clientX);
    }
  });
})();
// Keep Screen 2's lyric sync from lagging up to 4s behind after a manual seek — nudge it immediately.
if(localPlayer){
  localPlayer.addEventListener('seeked', () => {
    const song = currentSong();
    if(song){
      connections.forEach(conn => { if(conn.open) conn.send({ type: 'TIME_SYNC', currentId: state.currentId, currentTime: localPlayer.currentTime }); });
    }
  });
}

function scanLocalFolder(fileList){
  // Which of these a given browser can actually decode varies (mpg/mpeg/dat/wmv/avi/mkv often can't be played by Chrome/Edge);
  // a file it can't open is reported and skipped at play time rather than hidden here.
  const audioExts = /\.(mp3|mp4|m4a|m4v|mkv|mpg|mpeg|dat|wmv|wav|ogg|oga|webm|mov|avi|flac|aac|wma)$/i;
  state.localLibrary = [];
  localFiles.clear();
  mp3LyricsCache.clear(); // re-scanning means reading fresh from disk — don't serve stale cached lyrics/cover art from before

  Array.from(fileList).forEach(file => {
    if(!audioExts.test(file.name)) return;
    const relPath = file.webkitRelativePath || file.name;
    // Deterministic ID from the file's path (not random) — so re-selecting the same folder later
    // (e.g. after a page refresh, which this API requires every time) reconnects existing queue
    // entries, playlists, and history to the same files instead of orphaning them with stale IDs.
    let hash = 0;
    for(let i = 0; i < relPath.length; i++){ hash = ((hash << 5) - hash + relPath.charCodeAt(i)) | 0; }
    const id = 'lf_' + Math.abs(hash).toString(36);
    localFiles.set(id, file);
    state.localLibrary.push({
      id,
      title: file.name.replace(/\.[^.]+$/, ''),
      path: relPath
    });
  });
  renderLocalLibraryStatus();
  connections.forEach(c => { if(c.open) c.send({ type: 'LOCAL_LIBRARY', localLibrary: state.localLibrary }); });
  showToast(`พบเพลงในเครื่อง ${state.localLibrary.length} ไฟล์`);
}

function clearLocalFolder(){
  state.localLibrary = [];
  localFiles.clear();
  renderLocalLibraryStatus();
  connections.forEach(c => { if(c.open) c.send({ type: 'LOCAL_LIBRARY', localLibrary: [] }); });
}

function renderLocalLibraryStatus(){
  const el = document.getElementById('local-library-status');
  if(!el) return;
  if(state.localLibrary.length === 0){
    el.textContent = 'ยังไม่ได้เลือกโฟลเดอร์เพลง';
    document.getElementById('btn-clear-local-folder').style.display = 'none';
  } else {
    el.textContent = `พบเพลง ${state.localLibrary.length} ไฟล์ (รวมโฟลเดอร์ย่อย) — ต้องเลือกโฟลเดอร์ใหม่ทุกครั้งที่รีเฟรชหน้านี้`;
    document.getElementById('btn-clear-local-folder').style.display = 'inline-flex';
  }
}


/* ---------------- Wiring ---------------- */
document.getElementById('btn-qr').onclick = () => { renderConnectedDevices(); openModal('qr-modal'); };
document.getElementById('btn-playlist').onclick = () => { renderPlaylists(); openModal('playlist-modal'); };
document.getElementById('btn-search').onclick = () => {
  updateHostSearchHint();
  document.getElementById('host-search-input').value = '';
  document.getElementById('host-search-results').innerHTML = '';
  openModal('search-modal');
};
document.querySelectorAll('#host-search-mode-tabs .mode-tab').forEach(tab => {
  if(tab.dataset.mode === hostSearchMode) tab.classList.add('active');
  else tab.classList.remove('active');
  tab.onclick = () => {
    hostSearchMode = tab.dataset.mode;
    sessionStorage.setItem('sriKaraoke_searchMode', hostSearchMode);
    document.querySelectorAll('#host-search-mode-tabs .mode-tab').forEach(t => t.classList.toggle('active', t === tab));
    // Re-run the search immediately if there's already a query showing — otherwise switching modes
    // silently does nothing until the next explicit search, which looks like the toggle has no effect.
    if(document.getElementById('host-search-input').value.trim()) doHostSearch();
  };
});
document.getElementById('btn-toggle-suggested').onclick = () => {
  const section = document.getElementById('host-suggested-section');
  const showing = section.style.display !== 'none';
  if(!showing) renderSuggestedChips('host-suggested-chips', 'host-search-input', doHostSearch);
  section.style.display = showing ? 'none' : 'block';
};
document.getElementById('btn-settings').onclick = () => openModal('settings-modal');
document.getElementById('btn-chords').onclick = openChordsModal;
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.onclick = () => setChordMode(tab.dataset.mode);
});
function broadcastChords(){
  connections.forEach(c => { if(c.open) c.send({ type: 'CHORDS_LIBRARY', chords: state.chords }); });
}
document.getElementById('btn-chords-save').onclick = () => {
  if(!chordTargetKey) return;
  const mode = document.querySelector('.mode-tab.active').dataset.mode;
  let timeline, raw, secondsPerChord = null;
  if(mode === 'simple'){
    raw = document.getElementById('chord-input-simple-text').value.trim();
    secondsPerChord = parseFloat(document.getElementById('chord-seconds-per').value) || 4;
    timeline = parseSimpleChords(raw, secondsPerChord);
  } else {
    raw = document.getElementById('chord-input-timed-text').value.trim();
    timeline = parseTimedChords(raw);
  }
  if(!raw || timeline.length === 0){
    showToast('กรุณาพิมพ์คอร์ดก่อนบันทึก', true);
    return;
  }
  state.chords[chordTargetKey] = { title: chordTargetTitle, mode, raw, secondsPerChord, timeline, savedAt: Date.now() };
  saveChordsStorage();
  renderChordLibrary();
  loadChordFormForTarget();
  broadcastChords();
  showToast('บันทึกคอร์ดแล้ว');
};
document.getElementById('btn-chords-delete').onclick = () => {
  if(!chordTargetKey || !state.chords[chordTargetKey]) return;
  delete state.chords[chordTargetKey];
  saveChordsStorage();
  renderChordLibrary();
  loadChordFormForTarget();
  broadcastChords();
  showToast('ลบคอร์ดเพลงนี้แล้ว');
};
document.getElementById('btn-popular').onclick = fetchPopularSongs;
document.getElementById('btn-open-history').onclick = () => { closeModal('search-modal'); renderHistory(); openModal('history-modal'); };
document.getElementById('btn-clear-history').onclick = () => {
  if(confirm('ล้างประวัติเพลงที่เล่นไปแล้วทั้งหมด?')) clearHistory();
};
document.getElementById('pin-toggle').onchange = (e) => {
  state.pinEnabled = e.target.checked;
  if(state.pinEnabled && !state.pin) state.pin = generatePin();
  sessionStorage.setItem(STORAGE_PINENABLED, state.pinEnabled ? '1' : '0');
  sessionStorage.setItem(STORAGE_PIN, state.pin);
  document.getElementById('pin-display-row').style.display = state.pinEnabled ? 'flex' : 'none';
  document.getElementById('pin-value').textContent = state.pin || '----';
  if(myRoomId) renderRoomQR();
};
document.getElementById('btn-regen-pin').onclick = () => {
  state.pin = generatePin();
  sessionStorage.setItem(STORAGE_PIN, state.pin);
  document.getElementById('pin-value').textContent = state.pin;
  if(myRoomId) renderRoomQR();
  showToast('สร้างรหัส PIN ใหม่แล้ว — อุปกรณ์ที่เชื่อมต่ออยู่เดิมยังใช้งานได้ตามปกติ');
};
document.getElementById('btn-regen-admintoken').onclick = () => {
  state.adminToken = generateAdminToken();
  sessionStorage.setItem(STORAGE_ADMINTOKEN, state.adminToken);
  if(myRoomId) renderRoomQR();
  showToast('สร้างรหัสแอดมินใหม่แล้ว — QR แอดมินเดิมจะใช้ต่อไม่ได้ (คนที่เชื่อมต่ออยู่แล้วไม่ถูกตัดสิทธิ์)');
};
function updateFairHintText(){
  document.getElementById('fair-hint').textContent =
    `โหมดนี้จะจัดคิวใหม่อัตโนมัติเมื่อมีการเพิ่มเพลง ให้แต่ละคนได้ร้อง ${FAIR_QUEUE_SONGS_PER_TURN} เพลงต่อรอบแล้วสลับกันแทนที่จะเรียงตามลำดับที่เพิ่ม`;
}
document.getElementById('btn-fair-toggle').onclick = () => {
  document.getElementById('fair-queue-count-input').value = FAIR_QUEUE_SONGS_PER_TURN;
  openModal('fair-queue-modal');
};
document.getElementById('btn-fair-queue-apply').onclick = () => {
  const n = parseInt(document.getElementById('fair-queue-count-input').value, 10);
  if(!n || n < 1){
    showToast('กรุณาใส่จำนวนเพลง/คน อย่างน้อย 1 เพลง', true);
    return;
  }
  FAIR_QUEUE_SONGS_PER_TURN = n;
  sessionStorage.setItem('sriKaraoke_fairSongsPerTurn', String(n));
  state.fairQueueMode = true;
  sessionStorage.setItem('sriKaraoke_fairMode', '1');
  const btn = document.getElementById('btn-fair-toggle');
  btn.textContent = '👥 คิวคนร้อง: เปิด';
  btn.classList.add('on');
  updateFairHintText();
  document.getElementById('fair-hint').style.display = 'block';
  fairReorderQueue();
  renderQueue();
  closeModal('fair-queue-modal');
  showToast(`เปิดคิวคนร้อง — ${n} เพลง/คน จัดคิวใหม่ให้สลับกันร้องอัตโนมัติ`);
};
document.getElementById('btn-fair-queue-disable').onclick = () => {
  state.fairQueueMode = false;
  sessionStorage.setItem('sriKaraoke_fairMode', '0');
  const btn = document.getElementById('btn-fair-toggle');
  btn.textContent = '👥 คิวคนร้อง: ปิด';
  btn.classList.remove('on');
  document.getElementById('fair-hint').style.display = 'none';
  renderQueue();
  closeModal('fair-queue-modal');
};
document.getElementById('btn-screen2-toggle').onclick = () => {
  state.screen2Enabled = !state.screen2Enabled;
  sessionStorage.setItem('sriKaraoke_screen2Enabled', state.screen2Enabled ? '1' : '0');
  const btn = document.getElementById('btn-screen2-toggle');
  btn.textContent = state.screen2Enabled ? 'เปิด' : 'ปิด';
  btn.classList.toggle('accent', state.screen2Enabled);
  document.getElementById('audio-output-row').style.display = state.screen2Enabled ? 'flex' : 'none';
  document.getElementById('audio-latency-row').style.display = state.screen2Enabled ? 'flex' : 'none';
  camSync();
  if(!state.screen2Enabled && state.audioOutput === 'screen2'){
    // Screen 2 just got turned off — bring audio back to the main screen automatically.
    state.audioOutput = 'screen1';
    sessionStorage.setItem('sriKaraoke_audioOutput', 'screen1');
    document.getElementById('btn-audio-output-toggle').textContent = 'จอหลัก';
    applyAudioOutput();
  }
  if(state.screen2Enabled && myRoomId){
    // Show the QR immediately — no extra button/click needed to see it.
    renderRoomQR();
    closeModal('settings-modal');
    openModal('qr-screen2-modal');
  }
};
document.getElementById('btn-audio-output-toggle').onclick = () => {
  const wantsScreen2 = state.audioOutput === 'screen1';
  state.audioOutput = wantsScreen2 ? 'screen2' : 'screen1';
  sessionStorage.setItem('sriKaraoke_audioOutput', state.audioOutput);
  document.getElementById('btn-audio-output-toggle').textContent = state.audioOutput === 'screen2' ? 'จอที่ 2' : 'จอหลัก';
  applyAudioOutput(true);
  showToast(state.audioOutput === 'screen2' ? '🔊 เสียงย้ายไปออกที่จอที่ 2 แล้ว' : '🔊 เสียงย้ายกลับมาที่จอหลักแล้ว');
};
document.getElementById('btn-channel-mode').onclick = () => {
  setChannelMode(CHANNEL_MODES[(CHANNEL_MODES.indexOf(state.channelMode) + 1) % CHANNEL_MODES.length]);
};
{
  const latencySel = document.getElementById('audio-latency-select');
  latencySel.value = String(audioLatencyMs);
  if(latencySel.value !== String(audioLatencyMs)){ // a stored value that isn't one of the offered steps
    const opt = document.createElement('option');
    opt.value = String(audioLatencyMs); opt.textContent = audioLatencyMs + ' มิลลิวินาที';
    latencySel.appendChild(opt);
    latencySel.value = String(audioLatencyMs);
  }
  latencySel.addEventListener('change', (e) => {
    audioLatencyMs = parseInt(e.target.value, 10) || 0;
    localStorage.setItem('sriKaraoke_audioLatencyMs', String(audioLatencyMs));
    applyAudioOutput(); // pushes the new value to Screen 2 as well
  });
}
document.getElementById('btn-pick-local-folder').onclick = () => document.getElementById('local-folder-input').click();
document.getElementById('local-folder-input').addEventListener('change', (e) => {
  if(e.target.files && e.target.files.length) scanLocalFolder(e.target.files);
});
document.getElementById('btn-clear-local-folder').onclick = () => {
  clearLocalFolder();
  document.getElementById('local-folder-input').value = '';
};
function getHeaderHeightPx(){
  const v = getComputedStyle(document.documentElement).getPropertyValue('--header-h');
  return parseFloat(v) || 0;
}
function updateHeaderHeightVar(){
  const header = document.querySelector('header');
  if(header.classList.contains('collapsed')){
    document.documentElement.style.setProperty('--header-h', '0px');
  } else {
    document.documentElement.style.setProperty('--header-h', header.getBoundingClientRect().height + 'px');
  }
}
function isPortraitNow(){
  return window.matchMedia('(orientation: portrait)').matches;
}
// The queue panel used to permanently take up its own share of the layout, so this button could just
// sit at a fixed spot on the (moving) boundary of the video area. Now that the panel floats on top of
// the video instead, this button has to be positioned in JS against the panel's own actual size —
// and that boundary is a different edge entirely in portrait (bottom, panel below) vs landscape
// (right, panel beside), so the icon/axis both flip with orientation too.
function updateQueueTogglePosition(){
  const btn = document.getElementById('queue-toggle-btn');
  const panel = document.getElementById('queue-panel');
  const hidden = document.getElementById('main-content').classList.contains('queue-hidden');
  if(isPortraitNow()){
    btn.style.top = ''; btn.style.right = '';
    btn.style.left = '50%';
    btn.style.bottom = (hidden ? 0 : panel.getBoundingClientRect().height) + 'px';
    btn.style.transform = 'translate(-50%, 50%)';
    btn.textContent = hidden ? '▲' : '▼';
  } else {
    btn.style.left = ''; btn.style.bottom = '';
    btn.style.top = 'calc(50% + var(--header-h,0px)/2)';
    btn.style.right = (hidden ? 0 : panel.getBoundingClientRect().width) + 'px';
    btn.style.transform = 'translate(50%, -50%)';
    btn.textContent = hidden ? '◀' : '▶';
  }
  btn.title = hidden ? 'แสดงคิวเพลง' : 'ซ่อนคิวเพลง';
}
document.getElementById('queue-toggle-btn').onclick = () => {
  document.getElementById('main-content').classList.toggle('queue-hidden');
  updateQueueTogglePosition();
};
window.addEventListener('resize', updateQueueTogglePosition);
window.addEventListener('orientationchange', () => setTimeout(updateQueueTogglePosition, 200));
// Mirrors updateQueueTogglePosition() — sits right at the boundary between the panel and the video,
// not at the fixed screen edge, so it moves in/out together with the panel instead of staying half
// off-screen when the panel is open.
function updateEffectsTogglePosition(){
  const btn = document.getElementById('effects-toggle-btn');
  const panel = document.getElementById('effects-panel');
  const shown = panel.style.display !== 'none';
  btn.style.left = (shown ? panel.getBoundingClientRect().width : 0) + 'px';
  document.documentElement.style.setProperty('--effects-w', (shown ? panel.getBoundingClientRect().width : 0) + 'px'); // lets the camera window step aside
  btn.textContent = shown ? '◀' : '▶';
  btn.title = shown ? 'ซ่อนเสียงเอฟเฟกต์' : 'แสดงเสียงเอฟเฟกต์';
}
document.getElementById('effects-toggle-btn').onclick = () => {
  const panel = document.getElementById('effects-panel');
  const shown = panel.style.display !== 'none';
  panel.style.display = shown ? 'none' : 'flex';
  updateEffectsTogglePosition();
};
window.addEventListener('resize', updateEffectsTogglePosition);
window.addEventListener('orientationchange', () => setTimeout(updateEffectsTogglePosition, 200));
updateEffectsTogglePosition();
loadSoundEffects();
document.getElementById('btn-new-party').onclick = startNewParty;

/* ---------------- Power-saving mode (turns off the idle-screen animations, for weaker devices) ---------------- */
let powerSaving = sessionStorage.getItem('sriKaraoke_powerSaving') === '1';
function applyPowerSaving(){
  document.body.classList.toggle('power-saving', powerSaving);
  const btn = document.getElementById('btn-power-saving');
  btn.classList.toggle('accent', powerSaving);
  btn.textContent = powerSaving ? 'เปิด' : 'ปิด';
}
document.getElementById('btn-power-saving').onclick = () => {
  powerSaving = !powerSaving;
  sessionStorage.setItem('sriKaraoke_powerSaving', powerSaving ? '1' : '0');
  applyPowerSaving();
};
document.getElementById('btn-scoring-toggle').onclick = () => {
  state.scoringEnabled = !state.scoringEnabled;
  sessionStorage.setItem('sriKaraoke_scoringEnabled', state.scoringEnabled ? '1' : '0');
  const btn = document.getElementById('btn-scoring-toggle');
  btn.textContent = state.scoringEnabled ? 'เปิด' : 'ปิด';
  btn.classList.toggle('accent', state.scoringEnabled);
};
let chordsButtonVisible = sessionStorage.getItem('sriKaraoke_chordsButtonVisible') === '1';
document.getElementById('btn-chords').style.display = chordsButtonVisible ? '' : 'none';
if(chordsButtonVisible){
  document.getElementById('btn-chords-button-toggle').textContent = 'เปิด';
  document.getElementById('btn-chords-button-toggle').classList.add('accent');
}
document.getElementById('btn-chords-button-toggle').onclick = () => {
  chordsButtonVisible = !chordsButtonVisible;
  sessionStorage.setItem('sriKaraoke_chordsButtonVisible', chordsButtonVisible ? '1' : '0');
  document.getElementById('btn-chords').style.display = chordsButtonVisible ? '' : 'none';
  const btn = document.getElementById('btn-chords-button-toggle');
  btn.textContent = chordsButtonVisible ? 'เปิด' : 'ปิด';
  btn.classList.toggle('accent', chordsButtonVisible);
};

/* ---------------- Theme (remembered per device, not just per session) ---------------- */
const THEME_COLORS = { dark: '#1B1533', light: '#FFFFFF', birthday: '#4A1259', newyear: '#2D1B4E', songkran: '#0A4A63' };
const THEME_CLASS = { light: 'light-theme', birthday: 'birthday-theme', newyear: 'newyear-theme', songkran: 'songkran-theme' };
const THEME_DECORATIONS = {
  birthday: ['🎈', '🎈', '🎈', '🎈', '🎉', '🎁'],
  newyear: ['🎆', '✨', '🎇', '✨', '🎆', '🥳'],
  songkran: ['💦', '🌸', '💦', '🌺', '💦', '🌸']
};
let currentTheme = localStorage.getItem('sriKaraoke_theme') || 'dark';
if(!THEME_COLORS[currentTheme]) currentTheme = 'dark'; // guard against a stale/invalid stored value
function applyTheme(){
  document.body.classList.remove(...Object.values(THEME_CLASS));
  if(THEME_CLASS[currentTheme]) document.body.classList.add(THEME_CLASS[currentTheme]);
  const select = document.getElementById('theme-select');
  if(select) select.value = currentTheme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', THEME_COLORS[currentTheme]);
  const decoContainer = document.getElementById('theme-decorations');
  const decos = THEME_DECORATIONS[currentTheme];
  if(decos){
    decoContainer.style.display = 'block';
    decoContainer.querySelectorAll('.deco').forEach((el, i) => { el.textContent = decos[i] || ''; });
  } else {
    decoContainer.style.display = 'none';
  }
}
document.getElementById('theme-select').addEventListener('change', (e) => {
  currentTheme = e.target.value;
  localStorage.setItem('sriKaraoke_theme', currentTheme);
  applyTheme();
});
applyTheme();
applyPowerSaving();

/* ---------------- Idle-screen custom background (picture slideshow) ----------------
   Shown in place of the disco screen whenever nothing is playing (queue empty / stopped). Pictures are
   resized down and kept in IndexedDB — unlike the local music folder, the browser lets us keep these
   across refreshes, so they only need to be added once. If IndexedDB isn't usable (e.g. some private
   browsing modes), pictures still work for the current session but are lost on refresh. */
const BG_DB_NAME = 'sriKaraoke_bg';
const BG_STORE = 'images';
const BG_MAX_IMAGES = 20;
const BG_MAX_DIM = 1920; // longest side after resize — plenty for a TV, keeps memory sane
const BG_INTERVALS = [5, 10, 15, 30, 60, 120, 300];
let bgImages = [];          // [{ id, blob, url, name }]  — url is an object URL made from the stored blob
let bgMemoryOnly = false;   // true once we've found IndexedDB can't be used
let bgMemId = 0;            // negative ids for in-memory-only pictures (IndexedDB ids are always positive)
let bgIndex = -1;           // which picture is on screen right now
let bgTimer = null;
let bgShowingA = true;      // which of the two crossfade layers is the visible one
let bgIntervalSec = parseInt(localStorage.getItem('sriKaraoke_bgInterval') || '10', 10);
if(!BG_INTERVALS.includes(bgIntervalSec)) bgIntervalSec = 10;
let bgOrder = localStorage.getItem('sriKaraoke_bgOrder') === 'random' ? 'random' : 'seq';

function bgOpenDb(){
  return new Promise((resolve, reject) => {
    if(!window.indexedDB){ reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(BG_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(BG_STORE, { keyPath: 'id', autoIncrement: true }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}
// Runs one request against the store and resolves with its result once the transaction has really committed.
function bgTx(mode, makeRequest){
  return bgOpenDb().then(db => new Promise((resolve, reject) => {
    let result;
    const tx = db.transaction(BG_STORE, mode);
    const req = makeRequest(tx.objectStore(BG_STORE));
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('transaction aborted')); };
  }));
}

function bgResizeToBlob(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      if(!w || !h){ reject(new Error('empty image')); return; }
      const scale = Math.min(1, BG_MAX_DIM / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0F0C1E'; // PNGs with transparency would otherwise turn black/odd when saved as JPEG
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('could not encode image')), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

async function bgLoadAll(){
  let records = [];
  try{
    records = (await bgTx('readonly', store => store.getAll())) || [];
  }catch(e){
    console.warn('[Background] IndexedDB unavailable — pictures will only last for this session.', e);
    bgMemoryOnly = true;
  }
  bgImages.forEach(i => URL.revokeObjectURL(i.url));
  bgImages = records
    .filter(r => r && r.blob)
    .sort((a, b) => a.id - b.id)
    .map(r => ({ id: r.id, key: r.key || ('legacy' + r.id + '_' + r.blob.size), blob: r.blob, url: URL.createObjectURL(r.blob), name: r.name || '' }));
  bgRefreshAll();
}

async function bgAddFiles(fileList){
  const files = Array.from(fileList || []).filter(f => f.type && f.type.startsWith('image/'));
  if(files.length === 0){ showToast('ไม่พบไฟล์ภาพในที่เลือก', true); return; }
  const room = BG_MAX_IMAGES - bgImages.length;
  if(room <= 0){ showToast(`เพิ่มภาพได้สูงสุด ${BG_MAX_IMAGES} ภาพ — ลบภาพเก่าออกก่อน`, true); return; }
  const take = files.slice(0, room);
  let added = 0, failed = 0;
  for(const f of take){
    try{
      const blob = await bgResizeToBlob(f);
      const key = bgNewKey();
      let id;
      if(!bgMemoryOnly){
        try{
          id = await bgTx('readwrite', store => store.add({ blob, key, name: f.name, addedAt: Date.now() }));
        }catch(e){
          console.warn('[Background] Could not save to IndexedDB, keeping in memory only.', e);
          bgMemoryOnly = true;
        }
      }
      if(bgMemoryOnly) id = --bgMemId;
      bgImages.push({ id, key, blob, url: URL.createObjectURL(blob), name: f.name });
      added++;
    }catch(e){
      console.warn('[Background] Skipped a file:', f.name, e);
      failed++;
    }
  }
  bgRefreshAll();
  if(added > 0) showToast(`เพิ่มภาพพื้นหลัง ${added} ภาพแล้ว` + (take.length < files.length ? ` (เกินจำนวนสูงสุด ${BG_MAX_IMAGES} ภาพ จึงข้ามบางไฟล์)` : ''));
  if(failed > 0) showToast(`อ่านไฟล์ภาพไม่ได้ ${failed} ไฟล์`, true);
  if(bgMemoryOnly && added > 0) showToast('เบราว์เซอร์นี้เก็บภาพถาวรไม่ได้ — ภาพจะอยู่จนกว่าจะปิด/รีเฟรชหน้านี้', true);
}

async function bgRemove(id){
  const i = bgImages.findIndex(x => x.id === id);
  if(i < 0) return;
  const [img] = bgImages.splice(i, 1);
  URL.revokeObjectURL(img.url);
  if(id > 0 && !bgMemoryOnly){
    try{ await bgTx('readwrite', store => store.delete(id)); }
    catch(e){ console.warn('[Background] Could not delete from IndexedDB', e); }
  }
  bgRefreshAll();
}

async function bgClearAll(){
  if(bgImages.length === 0) return;
  if(!confirm('ลบภาพพื้นหลังทั้งหมด? จะกลับไปใช้หน้าจอเริ่มต้น')) return;
  bgImages.forEach(i => URL.revokeObjectURL(i.url));
  bgImages = [];
  if(!bgMemoryOnly){
    try{ await bgTx('readwrite', store => store.clear()); }
    catch(e){ console.warn('[Background] Could not clear IndexedDB', e); }
  }
  bgRefreshAll();
}

/* ---- Sending the pictures to Screen 2 ----
   Screen 2 can't read this device's storage, so pictures go over the existing PeerJS connection. To keep this
   from ever getting in the way of normal control messages (skip, state updates, ...), only a tiny list of
   picture keys is pushed on change (BG_SYNC); Screen 2 asks for just the ones it doesn't already hold
   (BG_NEED), and they're sent one at a time, waiting for the connection's send buffer to drain in between. */
function bgNewKey(){
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function bgBlobToArrayBuffer(blob){
  if(blob.arrayBuffer) return blob.arrayBuffer();
  return new Promise((resolve, reject) => { // older browsers without Blob.arrayBuffer()
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}
function bgSyncPayload(){
  return { type: 'BG_SYNC', keys: bgImages.map(i => i.key), intervalSec: bgIntervalSec, order: bgOrder };
}
function bgSendSync(conn){
  if(conn && conn.open) conn.send(bgSyncPayload());
}
function bgBroadcastSync(){
  connections.forEach(c => { if(c._isScreen2) bgSendSync(c); });
}
function bgConnBusy(conn){
  try{
    if(conn.bufferSize > 0) return true; // PeerJS's own queue of not-yet-handed-off chunks
    const dc = conn.dataChannel;
    return !!(dc && dc.bufferedAmount > 262144); // plus what's already inside the browser's channel buffer
  }catch(e){ return false; }
}
function bgHandleNeed(conn, keys){
  if(!conn._isScreen2 || !Array.isArray(keys)) return;
  bgServeImages(conn, keys.filter(k => typeof k === 'string').slice(0, BG_MAX_IMAGES));
}
function bgServeImages(conn, keys){
  conn._bgSent = conn._bgSent || new Set();   // the channel is reliable + ordered, so once sent it WILL arrive: never send twice
  conn._bgQueue = conn._bgQueue || [];
  keys.forEach(k => { if(!conn._bgSent.has(k) && !conn._bgQueue.includes(k)) conn._bgQueue.push(k); });
  if(conn._bgPumping) return;
  conn._bgPumping = true;
  (async () => {
    try{
      while(conn._bgQueue.length && conn.open){
        const key = conn._bgQueue.shift();
        const img = bgImages.find(i => i.key === key);
        if(!img) continue; // deleted while it was waiting in the queue
        const data = await bgBlobToArrayBuffer(img.blob);
        if(!conn.open) break;
        conn._bgSent.add(key);
        conn.send({ type: 'BG_IMAGE', key, mime: img.blob.type || 'image/jpeg', data });
        let waited = 0; // let this picture clear the pipe before the next, so control messages stay snappy
        while(conn.open && bgConnBusy(conn) && waited < 30000){
          await new Promise(r => setTimeout(r, 100));
          waited += 100;
        }
      }
    }catch(e){
      console.warn('[Background] Sending a picture to Screen 2 failed', e);
    }finally{
      conn._bgPumping = false;
    }
  })();
}

function bgIdleVisible(){
  return document.getElementById('idle-screen').style.display !== 'none';
}

function bgShowIndex(i){
  const a = document.getElementById('idle-bg-a');
  const b = document.getElementById('idle-bg-b');
  const next = bgShowingA ? b : a;
  const prev = bgShowingA ? a : b;
  next.style.backgroundImage = `url("${bgImages[i].url}")`;
  next.classList.add('visible');
  prev.classList.remove('visible');
  bgShowingA = !bgShowingA;
  bgIndex = i;
}
function bgNextIndex(){
  const n = bgImages.length;
  if(n <= 1) return 0;
  if(bgOrder === 'random'){
    let r;
    do{ r = Math.floor(Math.random() * n); }while(r === bgIndex);
    return r;
  }
  return (bgIndex + 1) % n;
}
function bgAdvance(){
  if(bgImages.length === 0 || !bgIdleVisible()) return;
  bgShowIndex(bgNextIndex());
}

// Idempotent on purpose — renderNowPlaying() calls this on every render, so it must only act on real changes.
function syncIdleSlideshow(){
  const idle = document.getElementById('idle-screen');
  const has = bgImages.length > 0;
  idle.classList.toggle('has-custom-bg', has);
  const shouldRun = has && bgIdleVisible() && !idle.classList.contains('has-camera');
  if(!shouldRun){
    if(bgTimer){ clearInterval(bgTimer); bgTimer = null; }
    return;
  }
  if(bgIndex < 0 || bgIndex >= bgImages.length){
    bgShowIndex(bgOrder === 'random' ? Math.floor(Math.random() * bgImages.length) : 0);
  }
  if(bgImages.length > 1){
    if(!bgTimer) bgTimer = setInterval(bgAdvance, bgIntervalSec * 1000);
  } else if(bgTimer){
    clearInterval(bgTimer); bgTimer = null;
  }
}

function bgRenderThumbs(){
  const wrap = document.getElementById('bg-thumbs');
  wrap.innerHTML = '';
  bgImages.forEach(img => {
    const d = document.createElement('div');
    d.className = 'bg-thumb';
    const im = document.createElement('img');
    im.src = img.url; im.alt = '';
    const del = document.createElement('button');
    del.type = 'button'; del.textContent = '✕'; del.title = 'ลบภาพนี้';
    del.onclick = () => bgRemove(img.id);
    d.appendChild(im); d.appendChild(del);
    wrap.appendChild(d);
  });
  const status = document.getElementById('bg-status');
  if(bgImages.length === 0){
    status.textContent = 'ยังไม่ได้เพิ่มภาพ — ใช้หน้าจอเริ่มต้น';
  } else {
    status.textContent = `มี ${bgImages.length}/${BG_MAX_IMAGES} ภาพ` + (bgImages.length > 1 ? ' — เปลี่ยนภาพแบบสไลด์โชว์' : '') + (bgMemoryOnly ? ' (ชั่วคราว: จะหายเมื่อรีเฟรชหน้านี้)' : '');
  }
  document.getElementById('btn-bg-clear').style.display = bgImages.length > 0 ? '' : 'none';
}

// Any change to the picture set (or the timing) starts the slideshow over cleanly.
function bgRefreshAll(){
  if(bgTimer){ clearInterval(bgTimer); bgTimer = null; }
  bgIndex = -1;
  bgShowingA = true;
  ['idle-bg-a', 'idle-bg-b'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('visible');
    el.style.backgroundImage = '';
  });
  bgRenderThumbs();
  syncIdleSlideshow();
  bgBroadcastSync();
}

document.getElementById('btn-bg-add').onclick = () => document.getElementById('bg-file-input').click();
document.getElementById('bg-file-input').addEventListener('change', async (e) => {
  const files = e.target.files;
  if(files && files.length) await bgAddFiles(files);
  e.target.value = ''; // so choosing the same file again later still triggers a change
});
document.getElementById('btn-bg-clear').onclick = bgClearAll;
document.getElementById('bg-interval-select').value = String(bgIntervalSec);
document.getElementById('bg-interval-select').addEventListener('change', (e) => {
  bgIntervalSec = parseInt(e.target.value, 10);
  localStorage.setItem('sriKaraoke_bgInterval', String(bgIntervalSec));
  if(bgTimer){ clearInterval(bgTimer); bgTimer = null; } // restart the timer with the new interval
  syncIdleSlideshow();
  bgBroadcastSync();
});
document.getElementById('bg-order-select').value = bgOrder;
document.getElementById('bg-order-select').addEventListener('change', (e) => {
  bgOrder = e.target.value === 'random' ? 'random' : 'seq';
  localStorage.setItem('sriKaraoke_bgOrder', bgOrder);
  bgBroadcastSync();
});
bgLoadAll();

/* ---------------- Live camera (webcam / the device's camera) as a background ----------------
   An alternative to the picture slideshow (one or the other, chosen in Settings). Shown full-screen on the idle
   screen and behind the MP3 lyrics, and as a small window (top-left) while a video plays. The main screen and
   Screen 2 can each show it or not. Whenever the camera can't be used (permission refused, unplugged, busy, no
   camera) the screens simply go back to what they'd show without it: the slideshow pictures, or the disco lights.
   The camera is only switched on while some screen is actually going to show it (plus a short linger so the gap
   between two songs doesn't turn it off and on again). */
const camCfg = {
  source: localStorage.getItem('sriKaraoke_bgSource') === 'camera' ? 'camera' : 'slides',
  deviceId: localStorage.getItem('sriKaraoke_camDevice') || '',
  mirror: localStorage.getItem('sriKaraoke_camMirror') === '1',
  host: localStorage.getItem('sriKaraoke_camHost') !== '0',
  screen2: localStorage.getItem('sriKaraoke_camScreen2') !== '0',
  pip: localStorage.getItem('sriKaraoke_camPip') !== '0',
  quality: ['high', 'medium', 'low'].includes(localStorage.getItem('sriKaraoke_camQuality')) ? localStorage.getItem('sriKaraoke_camQuality') : 'medium'
};
// state: off (no stream, will start when needed) | starting | on | lost (unplugged / busy / not found) | denied | unsupported
const cam = { state: 'off', stream: null, track: null, label: '', error: '', token: 0, linger: null, muteTimer: null, lastStart: 0, announced: null };
const camStreamCalls = new Map(); // Screen 2's peer id -> the live camera MediaConnection we're sending it
const CAM_LINGER_MS = 5000;
// The camera only switches on once this device has been chosen as the main screen. renderNowPlaying() already runs at
// page load, and without this the camera (and its permission prompt / light) would start behind the welcome and
// role-selection screens — including on a device that's about to turn into a remote or Screen 2 instead.
let camHostReady = false;

function camSave(){
  localStorage.setItem('sriKaraoke_bgSource', camCfg.source);
  localStorage.setItem('sriKaraoke_camDevice', camCfg.deviceId);
  localStorage.setItem('sriKaraoke_camMirror', camCfg.mirror ? '1' : '0');
  localStorage.setItem('sriKaraoke_camHost', camCfg.host ? '1' : '0');
  localStorage.setItem('sriKaraoke_camScreen2', camCfg.screen2 ? '1' : '0');
  localStorage.setItem('sriKaraoke_camPip', camCfg.pip ? '1' : '0');
  localStorage.setItem('sriKaraoke_camQuality', camCfg.quality);
}

// What the screens are in right now: nothing queued / an MP3 (full-screen lyrics page) / any other video.
function camContext(){
  const song = currentSong();
  if(!song) return 'idle';
  if(song.source === 'local'){
    const file = localFiles.get(song.localFileId);
    if(file && isAudioOnlyFile(file.name)) return 'mp3';
  }
  return 'video';
}
// Would this screen show the camera in this context, if the camera works?
function camShowsOn(screen, ctx){
  if(camCfg.source !== 'camera') return false;
  if(screen === 'host'){
    if(!camCfg.host) return false;
  } else if(!(camCfg.screen2 && state.screen2Enabled && connections.some(c => c._isScreen2 && c.open))){
    return false;
  }
  return ctx === 'idle' || ctx === 'mp3' || (ctx === 'video' && camCfg.pip);
}
function camNeeded(){
  if(!camHostReady) return false;
  const ctx = camContext();
  return camShowsOn('host', ctx) || camShowsOn('screen2', ctx);
}
function camHealthy(){
  return cam.state === 'on' && !!cam.stream && !!cam.track && cam.track.readyState === 'live';
}

function camStatusText(){
  if(cam.state === 'on') return '🟢 กล้องกำลังทำงาน' + (cam.label ? ': ' + cam.label : '');
  if(cam.state === 'starting') return '⏳ กำลังเปิดกล้อง… (ถ้ามีหน้าต่างขออนุญาต ให้กด "อนุญาต")';
  if(cam.state === 'off') return '⚪ กล้องปิดอยู่ — จะเปิดเองอัตโนมัติตอนที่มีหน้าจอต้องแสดงกล้อง (หรือกด "เปิดกล้อง" เพื่อทดสอบ)';
  return '🔴 ' + cam.error + ' — ตอนนี้ใช้ภาพสไลด์โชว์ (หรือไฟดิสโก้ถ้าไม่ได้ตั้งภาพไว้) แทนไปก่อน';
}
function camSetToggle(id, on){
  const b = document.getElementById(id);
  b.textContent = on ? 'เปิด' : 'ปิด';
  b.classList.toggle('accent', on);
}
function camUpdateSettingsUI(){
  document.getElementById('bg-source-select').value = camCfg.source;
  document.getElementById('bg-camera-block').style.display = camCfg.source === 'camera' ? 'block' : 'none';
  document.getElementById('cam-status').textContent = camStatusText();
  camSetToggle('btn-cam-host', camCfg.host);
  camSetToggle('btn-cam-screen2', camCfg.screen2);
  camSetToggle('btn-cam-pip', camCfg.pip);
  camSetToggle('btn-cam-mirror', camCfg.mirror);
  document.getElementById('cam-screen2-row').style.display = state.screen2Enabled ? 'flex' : 'none';
  document.getElementById('cam-quality-row').style.display = state.screen2Enabled ? 'flex' : 'none';
  document.getElementById('cam-quality-select').value = camCfg.quality;
  const linkText = camLinkText();
  const linkEl = document.getElementById('cam-link-status');
  linkEl.textContent = linkText;
  linkEl.style.display = linkText ? 'block' : 'none';
}

async function camRefreshDevices(){
  if(!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)) return;
  let devs = [];
  try{ devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); }catch(e){ return; }
  const sel = document.getElementById('cam-device-select');
  sel.innerHTML = '';
  sel.appendChild(new Option('กล้องเริ่มต้นของเครื่อง', ''));
  devs.forEach((d, i) => sel.appendChild(new Option(d.label || ('กล้อง ' + (i + 1)), d.deviceId)));
  sel.value = camCfg.deviceId;
  if(sel.value !== camCfg.deviceId) sel.value = ''; // the remembered camera isn't plugged in right now
}

function camReleaseStream(){
  cam.token++; // cancels a start that is still waiting on the permission prompt
  clearTimeout(cam.muteTimer); cam.muteTimer = null;
  if(cam.stream){ cam.stream.getTracks().forEach(t => { try{ t.stop(); }catch(e){} }); }
  cam.stream = null; cam.track = null; cam.label = '';
}

async function camStart(userInitiated){
  if(cam.state === 'starting' || cam.state === 'on') return;
  if(!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)){
    cam.state = 'unsupported';
    cam.error = 'เบราว์เซอร์นี้ใช้กล้องไม่ได้ (ต้องเปิดเว็บผ่าน HTTPS และเบราว์เซอร์ต้องรองรับ)';
    if(userInitiated) showToast('📷 ' + cam.error, true);
    camSync();
    return;
  }
  const token = ++cam.token;
  cam.state = 'starting'; cam.error = ''; cam.lastStart = Date.now();
  camUpdateSettingsUI();
  let stream = null;
  try{
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    if(camCfg.deviceId) video.deviceId = { ideal: camCfg.deviceId }; // "ideal", so a camera that's no longer there falls back to the default instead of failing
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  }catch(e){
    if(token !== cam.token) return; // superseded while waiting
    const n = e && e.name;
    if(n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError'){
      cam.state = 'denied';
      cam.error = 'ไม่ได้รับอนุญาตให้ใช้กล้อง (กดไอคอนกล้อง/แม่กุญแจที่แถบที่อยู่ของเบราว์เซอร์ เลือก "อนุญาต" แล้วกด "เปิดกล้อง")';
    } else if(n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError'){
      cam.state = 'lost';
      cam.error = 'ไม่พบกล้อง (ตรวจสอบว่าเสียบเว็บแคมแล้ว)';
    } else {
      cam.state = 'lost';
      cam.error = 'เปิดกล้องไม่ได้ (อาจมีโปรแกรมอื่นกำลังใช้กล้องอยู่)';
    }
    if(userInitiated || cam.announced !== cam.state){ showToast('📷 ' + cam.error, true); }
    cam.announced = cam.state;
    camSync();
    return;
  }
  // Settings changed (or the camera stopped being wanted) while the prompt was open: don't keep a camera running for nothing
  if(token !== cam.token || camCfg.source !== 'camera'){
    stream.getTracks().forEach(t => { try{ t.stop(); }catch(e){} });
    if(token === cam.token){ cam.state = 'off'; camSync(); }
    return;
  }
  const track = stream.getVideoTracks()[0];
  if(!track){
    stream.getTracks().forEach(t => { try{ t.stop(); }catch(e){} });
    cam.state = 'lost'; cam.error = 'ไม่พบภาพจากกล้อง';
    camSync();
    return;
  }
  cam.stream = stream; cam.track = track; cam.label = track.label || '';
  cam.state = 'on'; cam.error = ''; cam.announced = null;
  track.addEventListener('ended', () => { if(cam.track === track) camLost('กล้องถูกถอดออกหรือหยุดทำงาน'); });
  track.addEventListener('mute', () => { // no pictures coming in: give it a few seconds to recover before giving up on it
    if(cam.track !== track) return;
    clearTimeout(cam.muteTimer);
    cam.muteTimer = setTimeout(() => { if(cam.track === track && track.muted) camLost('กล้องไม่ส่งภาพ'); }, 4000);
  });
  track.addEventListener('unmute', () => { clearTimeout(cam.muteTimer); cam.muteTimer = null; });
  camRefreshDevices(); // device names are only available once permission has been given
  camSync();
}

function camLost(msg){
  camReleaseStream();
  cam.state = 'lost'; cam.error = msg;
  showToast('📷 ' + msg + ' — กลับไปใช้พื้นหลังเดิมให้อัตโนมัติ', true);
  cam.announced = 'lost';
  camSync();
}

// Brings a camera that failed back if the device may have returned (re-plugged, tab visible again, ...).
function camRecover(){
  if(camCfg.source !== 'camera') return;
  if(cam.state === 'on' && cam.track && cam.track.readyState !== 'live'){ camLost('กล้องหยุดทำงาน'); return; }
  if(cam.state === 'lost' && camNeeded() && Date.now() - cam.lastStart > 2000){
    cam.state = 'off';
    camSync();
  }
}

// Shows the camera wherever it should be showing right now (and puts the normal background back everywhere else).
function camRenderUI(){
  const ctx = camContext();
  const healthy = camHealthy();
  const hostShows = healthy && camShowsOn('host', ctx);
  const attach = (id, on) => {
    const el = document.getElementById(id);
    if(on){
      if(el.srcObject !== cam.stream){ el.srcObject = cam.stream; }
      const p = el.play(); if(p && p.catch) p.catch(() => {});
    } else if(el.srcObject){
      el.srcObject = null;
    }
  };
  const idleOn = hostShows && ctx === 'idle';
  const mp3On = hostShows && ctx === 'mp3';
  const pipOn = hostShows && ctx === 'video';
  document.getElementById('idle-screen').classList.toggle('has-camera', idleOn);
  document.getElementById('mp3-now-playing').classList.toggle('has-camera', mp3On);
  document.getElementById('cam-pip').style.display = pipOn ? 'block' : 'none';
  attach('idle-cam', idleOn); attach('mp3-cam', mp3On); attach('cam-pip-video', pipOn);
  document.body.classList.toggle('cam-mirror', camCfg.mirror);
  syncIdleSlideshow(); // the slideshow steps aside while the camera covers the idle screen, and resumes the moment it doesn't
}

function camSendConfig(conn){
  if(conn && conn.open) conn.send({ type: 'CAM_CONFIG', source: camCfg.source, mirror: camCfg.mirror, pip: camCfg.pip });
}
function camBroadcastConfig(){
  connections.forEach(c => { if(c._isScreen2) camSendConfig(c); });
}

// Sends the live picture to every connected Screen 2 that should be showing it, and hangs up when it shouldn't.
function camSyncScreen2(){
  const want = camHealthy() && camShowsOn('screen2', camContext());
  connections.forEach(c => {
    if(!c._isScreen2) return;
    const existing = camStreamCalls.get(c.peer);
    if(want && c.open && !existing && peer && !peer.destroyed){
      try{
        const call = peer.call(c.peer, cam.stream, { metadata: { kind: 'camera' } });
        camStreamCalls.set(c.peer, call);
        const gone = () => { if(camStreamCalls.get(c.peer) === call) camStreamCalls.delete(c.peer); };
        call.on('close', gone);
        call.on('error', gone);
        camScheduleQuality(call); // keep the live picture light on the network and on a modest main-screen device
      }catch(e){
        console.warn('[Camera] Could not start sending the camera to Screen 2 (it keeps its normal background)', e);
      }
    } else if(!want && existing){
      try{ existing.close(); }catch(e){}
      camStreamCalls.delete(c.peer);
    }
  });
  for(const [peerId, call] of [...camStreamCalls]){ // Screen 2 went away
    if(!connections.some(c => c.peer === peerId && c.open)){
      try{ call.close(); }catch(e){}
      camStreamCalls.delete(peerId);
    }
  }
  camStatsSync();
}

/* ---- How much picture goes to Screen 2 ----
   The camera itself is captured at 720p for this screen; what's SENT can be smaller. A background doesn't need every
   pixel, and encoding less is the quickest way to take load (and delay) off a modest main-screen device or a weak WiFi. */
const CAM_QUALITY = {
  high:   { label: '720p 30fps', scale: 1,     fps: 30, kbps: 1500 },
  medium: { label: '540p 24fps', scale: 4 / 3, fps: 24, kbps: 900 },
  low:    { label: '360p 15fps', scale: 2,     fps: 15, kbps: 450 }
};
function camApplyQuality(call){
  const q = CAM_QUALITY[camCfg.quality] || CAM_QUALITY.medium;
  try{
    (call.peerConnection ? call.peerConnection.getSenders() : []).forEach(sender => {
      if(!sender.track || sender.track.kind !== 'video') return;
      const params = sender.getParameters();
      if(!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      enc.maxBitrate = q.kbps * 1000;
      enc.maxFramerate = q.fps;
      enc.scaleResolutionDownBy = q.scale;
      sender.setParameters(params).catch(() => {});
    });
  }catch(e){}
}
// The sender isn't always ready to take new parameters the instant the call is created, so try a few times.
function camScheduleQuality(call){
  [0, 800, 2500, 6000].forEach(ms => setTimeout(() => {
    if([...camStreamCalls.values()].includes(call)) camApplyQuality(call);
  }, ms));
}

/* ---- Is the picture on Screen 2 really delayed, and why? ----
   Screen 2 and this screen each read WebRTC's own statistics every few seconds; the result is shown in Settings so a
   long delay can be traced to its cause (this screen's CPU, the WiFi, Screen 2's buffer/CPU, or a relayed route). */
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
function camEstimateDelayMs(host, s2){
  if(!(s2 && s2.in && s2.in.jbMs != null)) return null; // needs Screen 2's side of the story
  const rtt = (s2.route && s2.route.rttMs != null) ? s2.route.rttMs : (host && host.route && host.route.rttMs) || 0;
  return Math.round(33 + ((host && host.out && host.out.encodeMs) || 0) + rtt / 2 + s2.in.jbMs + (s2.in.decodeMs || 0));
}
function camLinkAdvice(host, s2){
  const tips = [];
  const route = (s2 && s2.route) || (host && host.route);
  if(route && route.kind === 'relay') tips.push('ภาพวิ่งผ่านเซิร์ฟเวอร์ relay ซึ่งมักช้ากว่าการต่อตรง — ตรวจว่าจอหลักกับจอที่ 2 อยู่ใน WiFi/วงเครือข่ายเดียวกัน');
  if(host && host.out){
    if(host.out.limit === 'cpu') tips.push('เครื่องจอหลักเข้ารหัสภาพไม่ทัน (CPU) — ลดคุณภาพภาพที่ส่ง หรือปิดหน้าต่างเล็ก/สวิตช์ส่งไปจอที่ 2');
    else if(host.out.limit === 'bandwidth') tips.push('เครือข่ายไม่พอสำหรับภาพนี้ — ลดคุณภาพภาพที่ส่ง');
    if(host.out.encodeMs != null && host.out.encodeMs > 30) tips.push('เครื่องจอหลักใช้เวลาเข้ารหัสต่อเฟรมนาน — ลดคุณภาพภาพที่ส่ง');
  }
  if(s2 && s2.in){
    if(s2.in.jbMs != null && s2.in.jbMs > 250) tips.push('จอที่ 2 ต้องพักภาพในบัฟเฟอร์นาน (สัญญาณไม่นิ่ง/แพ็กเก็ตหาย) — ตรวจ WiFi ของจอที่ 2');
    if(s2.in.decodeMs != null && s2.in.decodeMs > 30) tips.push('เครื่องจอที่ 2 ถอดรหัสภาพไม่ทัน — ลดคุณภาพภาพที่ส่ง');
    if(s2.in.lossPct != null && s2.in.lossPct > 3) tips.push('แพ็กเก็ตภาพสูญหายราว ' + Math.round(s2.in.lossPct) + '% — WiFi ไม่นิ่ง');
  }
  return tips;
}
const camLink = { host: null, s2: null, s2At: 0 };
function camLinkText(){
  if(camStreamCalls.size === 0) return '';
  const r = n => Math.round(n);
  const lines = [];
  const o = camLink.host && camLink.host.out;
  if(o){
    lines.push('ส่งไปจอที่ 2: ' + (o.w && o.h ? o.w + '×' + o.h : '—') + (o.fps != null ? ' · ' + r(o.fps) + ' fps' : '')
      + (o.encodeMs != null ? ' · เข้ารหัส ' + r(o.encodeMs) + ' ms/เฟรม' : '') + (o.limit && o.limit !== 'none' ? ' · ถูกจำกัดโดย ' + o.limit : ''));
  } else {
    lines.push('ส่งไปจอที่ 2: กำลังเริ่มวัดค่า…');
  }
  const fresh = camLink.s2 && Date.now() - camLink.s2At < 12000;
  const s2 = fresh ? camLink.s2 : null;
  if(s2 && s2.in){
    const route = s2.route && s2.route.kind === 'relay' ? 'ผ่าน relay' : (s2.route && s2.route.kind === 'direct' ? 'ต่อตรง' : 'ไม่ทราบ');
    lines.push('จอที่ 2 รับ: ' + (s2.in.fps != null ? r(s2.in.fps) + ' fps' : '—') + (s2.in.jbMs != null ? ' · บัฟเฟอร์ ' + r(s2.in.jbMs) + ' ms' : '')
      + (s2.in.decodeMs != null ? ' · ถอดรหัส ' + r(s2.in.decodeMs) + ' ms' : '') + (s2.route && s2.route.rttMs != null ? ' · RTT ' + r(s2.route.rttMs) + ' ms' : '')
      + ' · ' + route + (s2.in.dropped ? ' · ทิ้ง ' + s2.in.dropped + ' เฟรม' : ''));
  } else {
    lines.push('จอที่ 2 รับ: รอรายงานจากจอที่ 2…');
  }
  const est = camEstimateDelayMs(camLink.host, s2);
  if(est != null) lines.push('ความหน่วงโดยประมาณ ≈ ' + (Math.round(est / 10) * 10) + ' ms (ปกติในวง WiFi เดียวกันราว 150-400 ms)' + (est > 800 ? ' — สูงกว่าปกติ' : ''));
  camLinkAdvice(camLink.host, s2).forEach(t => lines.push('⚠️ ' + t));
  return lines.join('\n');
}
let camStatsTimer = null;
const camStatsPrev = new Map(); // Screen 2's peer id -> previous reading of this side's own stats
async function camPollStats(){
  for(const [peerId, call] of [...camStreamCalls]){
    try{
      const pc = call.peerConnection;
      if(!pc || !pc.getStats) continue;
      const report = await pc.getStats();
      if(camStreamCalls.get(peerId) !== call) continue; // hung up while the reading was in flight: don't bring old numbers back
      const { result, next } = camSummarizeStats(report, camStatsPrev.get(peerId));
      camStatsPrev.set(peerId, next);
      camLink.host = result;
    }catch(e){}
  }
  camUpdateSettingsUI();
}
function camStatsSync(){ // reads only while a picture is actually being sent
  if(camStreamCalls.size && !camStatsTimer){
    camLink.host = null; camLink.s2 = null; camStatsPrev.clear(); // a new run starts from nothing, never from the last one's numbers
    camStatsTimer = setInterval(camPollStats, 3000);
  } else if(!camStreamCalls.size && camStatsTimer){
    clearInterval(camStatsTimer); camStatsTimer = null;
    camLink.host = null; camLink.s2 = null; camStatsPrev.clear();
    camUpdateSettingsUI();
  }
}
// What Screen 2 reports about the picture it receives (Screen 2 is a plain guest, so every value is checked here).
function camOnStats(conn, msg){
  if(!conn._isScreen2 || !msg || typeof msg !== 'object') return;
  const clamp = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : null;
  const i = msg.in && typeof msg.in === 'object' ? msg.in : null;
  const rt = msg.route && typeof msg.route === 'object' ? msg.route : null;
  if(!i && !rt) return; // nothing usable in it: keep what we already know rather than wiping it
  camLink.s2 = {
    in: i ? { fps: clamp(i.fps, 0, 240), jbMs: clamp(i.jbMs, 0, 60000), decodeMs: clamp(i.decodeMs, 0, 60000), lossPct: clamp(i.lossPct, 0, 100), dropped: clamp(i.dropped, 0, 1e9) } : null,
    route: rt ? { kind: ['direct', 'relay', 'unknown'].includes(rt.kind) ? rt.kind : 'unknown', rttMs: clamp(rt.rttMs, 0, 60000) } : null
  };
  camLink.s2At = Date.now();
  camUpdateSettingsUI();
}

// The one place that decides what the camera should be doing. Idempotent: safe to call from anywhere, any number of times.
function camSync(){
  if(camCfg.source !== 'camera'){
    if(cam.stream || cam.state !== 'off') camReleaseStream();
    cam.state = 'off'; cam.error = '';
    clearTimeout(cam.linger); cam.linger = null;
  } else if(camNeeded()){
    clearTimeout(cam.linger); cam.linger = null;
    if(cam.state === 'off') camStart(false);
  } else if(cam.state === 'on' && !cam.linger){
    cam.linger = setTimeout(() => {
      cam.linger = null;
      if(camCfg.source === 'camera' && !camNeeded() && cam.state === 'on'){ camReleaseStream(); cam.state = 'off'; camSync(); }
    }, CAM_LINGER_MS);
  }
  camRenderUI();
  camSyncScreen2();
  camUpdateSettingsUI();
}

document.getElementById('bg-source-select').addEventListener('change', (e) => {
  camCfg.source = e.target.value === 'camera' ? 'camera' : 'slides';
  camSave();
  if(camCfg.source === 'camera'){
    cam.state = 'off'; cam.error = ''; cam.announced = null;
    camStart(true); // ask for permission now, while the operator is looking at the settings, and list the cameras
  }
  camSync();
  camBroadcastConfig();
});
document.getElementById('cam-device-select').addEventListener('change', (e) => {
  camCfg.deviceId = e.target.value;
  camSave();
  camReleaseStream(); cam.state = 'off'; cam.announced = null;
  camStart(true);
  camSync();
});
document.getElementById('cam-quality-select').addEventListener('change', (e) => {
  camCfg.quality = ['high', 'medium', 'low'].includes(e.target.value) ? e.target.value : 'medium';
  camSave();
  camStreamCalls.forEach(call => camApplyQuality(call)); // takes effect on the live picture straight away, no reconnecting
});
document.getElementById('btn-cam-retry').onclick = () => {
  camReleaseStream(); cam.state = 'off'; cam.announced = null;
  camStart(true);
  camSync();
};
[['btn-cam-host', 'host'], ['btn-cam-screen2', 'screen2'], ['btn-cam-pip', 'pip'], ['btn-cam-mirror', 'mirror']].forEach(([id, key]) => {
  document.getElementById(id).onclick = () => {
    camCfg[key] = !camCfg[key];
    camSave();
    camSync();
    camBroadcastConfig();
  };
});
document.addEventListener('visibilitychange', () => { if(!document.hidden) camRecover(); });
if(navigator.mediaDevices && navigator.mediaDevices.addEventListener){
  navigator.mediaDevices.addEventListener('devicechange', () => { camRefreshDevices(); camRecover(); });
}
camUpdateSettingsUI();
camRefreshDevices();

/* ---------------- App-level fullscreen (the whole app UI, not YouTube's own fullscreen) ---------------- */
function isFullscreen(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}
function requestFullscreenCompat(el){
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if(fn) return fn.call(el);
}
function exitFullscreenCompat(){
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if(fn) return fn.call(document);
}
function updateFullscreenBtn(){
  const btn = document.getElementById('btn-fullscreen');
  btn.querySelector('.label').textContent = isFullscreen() ? 'ย่อจอ' : 'เต็มจอ';
}
document.getElementById('btn-fullscreen').onclick = () => {
  if(isFullscreen()) exitFullscreenCompat();
  else requestFullscreenCompat(document.documentElement);
};
['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach(evt => {
  document.addEventListener(evt, updateFullscreenBtn);
});

function performLogout(){
  try{ if(peer) peer.destroy(); }catch(e){}
  try{ stopPlayer(); }catch(e){}
  try{ window.close(); }catch(e){}
  setTimeout(() => {
    document.body.innerHTML = `
      <div style="height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--ink);color:var(--text);text-align:center;padding:24px;font-family:'Sarabun',sans-serif;">
        <div style="font-family:'Kanit',sans-serif;font-size:24px;font-weight:700;">ออกจากระบบแล้ว</div>
        <p style="color:var(--text-dim);max-width:360px;">กรุณาปิดแท็บ/หน้าต่างนี้ด้วยตนเอง</p>
      </div>`;
  }, 250);
}
document.getElementById('btn-logout').onclick = () => openModal('logout-confirm-modal');
document.getElementById('btn-logout-cancel').onclick = () => closeModal('logout-confirm-modal');
document.getElementById('btn-logout-confirm').onclick = () => {
  closeModal('logout-confirm-modal');
  performLogout();
};

/* ---------------- Tap-to-toggle header (like a video player's auto-hide controls) ---------------- */
function setHeaderCollapsed(collapsed){
  document.querySelector('header').classList.toggle('collapsed', collapsed);
  document.getElementById('btn-toggle-header').textContent = collapsed ? '▼' : '▲';
  updateHeaderHeightVar();
  updateQueueTogglePosition();
  if(!collapsed) setTimeout(() => { updateHeaderHeightVar(); updateQueueTogglePosition(); }, 300); // re-measure once the expand transition settles
}
function toggleHeaderCollapsed(){
  setHeaderCollapsed(!document.querySelector('header').classList.contains('collapsed'));
}
document.getElementById('btn-toggle-header').onclick = toggleHeaderCollapsed;
// Tapping the video itself must always reach YouTube's own controls (captions, settings, seek bar,
// play/pause) normally — so the header toggle is deliberately NOT tied to clicks on the video/overlay
// bars. The small ▲/▼ handle below is the one guaranteed way to show/hide the menu; tapping the idle
// screen (shown only when nothing is playing, so it never competes with YouTube's controls) also works.
document.getElementById('idle-screen').addEventListener('click', (e) => {
  if(e.target.id === 'btn-start-audio' || e.target.closest('#btn-start-audio')) return;
  toggleHeaderCollapsed();
});
document.getElementById('btn-skip').onclick = skip;
document.getElementById('btn-prev').onclick = prevSong;
document.getElementById('btn-playpause').onclick = togglePlayPause;
document.getElementById('btn-tempo-down').onclick = () => tempoStep(-1);
document.getElementById('btn-tempo-up').onclick = () => tempoStep(1);
document.getElementById('btn-volume-down').onclick = () => volumeStep(-1);
document.getElementById('btn-volume-up').onclick = () => volumeStep(1);
document.getElementById('btn-mute').onclick = () => toggleMute();
document.getElementById('btn-save-pl').onclick = () => {
  const input = document.getElementById('new-pl-name');
  savePlaylistFromQueue(input.value.trim());
  input.value = '';
};
document.getElementById('btn-export-pl').onclick = exportBackup;
document.getElementById('btn-import-pl').onclick = () => document.getElementById('import-pl-file').click();
document.getElementById('import-pl-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(file) importBackupFromFile(file);
  e.target.value = '';
});
document.getElementById('host-search-input').addEventListener('keydown', (e) => { if(e.key === 'Enter') doHostSearch(); });
document.getElementById('host-search-input').addEventListener('input', (e) => {
  liveLocalSearch(e.target.value.trim());
});
document.getElementById('btn-host-search').onclick = doHostSearch;
document.getElementById('host-api-key-input').value = getApiKey();
document.getElementById('btn-host-save-key').onclick = () => {
  setApiKey(document.getElementById('host-api-key-input').value.trim());
  updateHostSearchHint();
  const btn = document.getElementById('btn-host-save-key');
  btn.textContent = 'บันทึกแล้ว ✓';
  setTimeout(() => { btn.textContent = 'บันทึก'; }, 1500);
};

// close modal on backdrop click
document.querySelectorAll('.modal-overlay').forEach(ov => {
  ov.addEventListener('click', (e) => { if(e.target === ov) ov.classList.add('hidden'); });
});

// TV / Android box remote support: Escape or Back closes modals
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape' || e.keyCode === 461 || e.keyCode === 10009){
    document.querySelectorAll('.modal-overlay').forEach(ov => ov.classList.add('hidden'));
  }
  if(e.key === 'MediaTrackNext') skip();
  if(e.key === 'MediaTrackPrevious') prevSong();
  if(e.key === 'MediaPlayPause' || e.key === ' '){
    if(document.activeElement.tagName !== 'INPUT') { e.preventDefault(); togglePlayPause(); }
  }
});

// Service worker
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed', err));
  });
}

// Reflect a fair-queue-mode setting restored from sessionStorage (e.g. after a refresh)
if(state.fairQueueMode){
  const btn = document.getElementById('btn-fair-toggle');
  btn.textContent = '👥 คิวคนร้อง: เปิด';
  btn.classList.add('on');
  updateFairHintText();
  document.getElementById('fair-hint').style.display = 'block';
}
// Same for the Second Screen toggle
if(state.screen2Enabled){
  document.getElementById('btn-screen2-toggle').textContent = 'เปิด';
  document.getElementById('btn-screen2-toggle').classList.add('accent');
  document.getElementById('audio-output-row').style.display = 'flex';
  document.getElementById('audio-latency-row').style.display = 'flex';
  document.getElementById('cam-screen2-row').style.display = 'flex';
  document.getElementById('btn-audio-output-toggle').textContent = state.audioOutput === 'screen2' ? 'จอที่ 2' : 'จอหลัก';
}
// Same for the scoring-system toggle (button defaults to "เปิด"/accent in the HTML, so only
// the "turned off" case needs to be reflected here)
if(!state.scoringEnabled){
  document.getElementById('btn-scoring-toggle').textContent = 'ปิด';
  document.getElementById('btn-scoring-toggle').classList.remove('accent');
}

// The main screen's own tab rarely sleeps (it's usually a plugged-in TV/box), but this covers the
// case where it does — e.g. a laptop used as the host going to sleep, or the browser backgrounding
// the tab. Check the signaling connection the moment the tab becomes visible again.
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible' || !peer) return;
  if(peer.destroyed){ initPeer(); }
  else if(peer.disconnected){ peer.reconnect(); }
});

initPeer();
renderQueue();

// Now that the header/queue panel/effects panel all float over the video instead of taking up their
// own fixed layout space, several of them need to know the header's actual current height (it can
// change — collapsed vs expanded, or just wrapping differently on a narrow screen) and the queue
// panel's actual current size, to position themselves correctly without overlapping each other.
updateHeaderHeightVar();
updateQueueTogglePosition();
window.addEventListener('resize', updateHeaderHeightVar);
window.addEventListener('orientationchange', () => setTimeout(updateHeaderHeightVar, 200));
