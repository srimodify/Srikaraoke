/* ===========================================================
   Sri Karaoke — จอหลัก (Host / TV)
   =========================================================== */

const STORAGE_PLAYLISTS = 'sriKaraoke_playlists';
const STORAGE_APIKEY = 'sriKaraoke_ytApiKey';
// Default YouTube Data API key so search-by-keyword works out of the box.
// Can still be changed any time from the search modal's "ตั้งค่า API Key" field.
const DEFAULT_API_KEY = 'AIzaSyBg5hplav7HzIHfXoDWlwZeENvQ7nb5i6Y';
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
  localLibrary: [],
  chords: loadChords()
};

let ytPlayer = null;
let ytReady = false;
let localPlayer = null; // <video> element used for songs from the device's own file system
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
    if(localPlayer){
      localPlayer.style.display = 'block';
      const url = URL.createObjectURL(file);
      localPlayer.src = url;
      localPlayer.playbackRate = state.tempo;
      localPlayer.volume = state.audioOutput === 'screen2' ? 0 : state.volume / 100;
      localPlayer.muted = state.audioOutput === 'screen2' ? true : state.muted;
      localPlayer.play().catch(() => {});
    }
    state.isPlaying = true;
  } else {
    if(localPlayer){ localPlayer.pause(); localPlayer.removeAttribute('src'); localPlayer.load(); localPlayer.style.display = 'none'; }
    if(ytWrap) ytWrap.style.display = '';
    if(ytReady && ytPlayer){
      ytPlayer.loadVideoById(song.videoId);
      ytPlayer.setPlaybackRate(state.tempo);
      state.isPlaying = true;
    }
  }
  applyAudioOutput(); // final step: makes sure the "muted while loading" state actually takes effect,
                       // overriding whatever volume/mute the branch above just set
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
        <div class="title">${song.source === 'local' ? '<span class="source-badge local">💻</span>' : ''}${escapeHtml(song.title)}</div>
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
  textEl.textContent = '🎤 กำลังเล่นเพลงนี้: ' + song.title + (song.by ? ' • เพิ่มโดย ' + song.by : '');
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
  const song = currentSong();
  const key = songChordKey(song);
  const entry = key ? state.chords[key] : null;
  if(!song || !entry || !entry.timeline || entry.timeline.length === 0){
    bar.style.display = 'none';
    nextBar.style.top = '0';
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
  if(idx === -1){ bar.style.display = 'none'; nextBar.style.top = '0'; return; }

  track.querySelectorAll('.chord-segment').forEach(el => {
    el.classList.toggle('current', parseInt(el.dataset.idx, 10) === idx);
  });
  bar.style.display = 'block';
  // Nudge the "up next" banner down while chords are showing, so the two never overlap on the rare
  // occasion a song has chords AND is in its last 15 seconds at the same time.
  nextBar.style.top = '52px';
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
      const labelEl = document.createElement('span');
      labelEl.className = 'effects-btn-label';
      labelEl.textContent = fx.label;
      btn.appendChild(iconEl);
      btn.appendChild(labelEl);
    } else {
      btn.textContent = fx.label;
    }
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
function addSong(song, from, playNow){
  const newSong = song.source === 'local'
    ? { id: uid(), source: 'local', localFileId: song.localFileId, title: song.title, thumbnail: LOCAL_FILE_THUMB, by: from || '' }
    : { id: uid(), source: 'youtube', videoId: song.videoId, title: song.title, thumbnail: song.thumbnail, by: from || '' };

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
function applyAudioOutput(){
  const forceMuteForLoading = isLoadingSong && state.audioOutput === 'screen1';
  if(state.audioOutput === 'screen2' || forceMuteForLoading){
    if(ytReady && ytPlayer){ try{ ytPlayer.mute(); ytPlayer.setVolume(0); }catch(e){} }
    if(localPlayer){ localPlayer.muted = true; localPlayer.volume = 0; }
  } else {
    if(ytReady && ytPlayer){
      try{ ytPlayer.setVolume(state.volume); state.muted ? ytPlayer.mute() : ytPlayer.unMute(); }catch(e){}
    }
    if(localPlayer){ localPlayer.volume = state.volume / 100; localPlayer.muted = state.muted; }
  }
  connections.forEach(c => {
    if(c.open) c.send({ type: 'AUDIO_OUTPUT', output: state.audioOutput, volume: state.volume, muted: state.muted });
  });
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
      onReady: () => { ytReady = true; applyAudioOutput(); },
      onStateChange: (e) => {
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
            connections.push(conn);
            conn.send({ type: 'JOIN_OK', role });
            updateConnStatus();
            sendState(conn);
            conn.send({ type: 'LOCAL_LIBRARY', localLibrary: state.localLibrary });
            conn.send({ type: 'CHORDS_LIBRARY', chords: state.chords });
            conn.send({ type: 'SOUND_EFFECTS', effects: soundEffects });
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
const GUEST_ALLOWED = new Set(['ADD_SONG', 'REMOVE_SONG', 'TEMPO_UP', 'TEMPO_DOWN', 'VOLUME_UP', 'VOLUME_DOWN', 'TOGGLE_MUTE', 'PLAY_SOUND_EFFECT']);
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
      addSong(msg.song, msg.from, false);
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
  }
}

function broadcastState(){
  connections.forEach(conn => { if(conn.open) sendState(conn); });
}
// A lighter periodic ping so long-idle screens (mainly Screen 2, which plays its own copy of the
// video independently) stay roughly in sync without re-sending the whole queue/playlists repeatedly.
// Only meaningful for YouTube songs — Screen 2 can't play local files, so there's nothing to sync then.
setInterval(() => {
  const song = currentSong();
  if(!song || song.source === 'local' || connections.length === 0) return;
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
function startNewParty(){
  if(!confirm('เริ่มงานใหม่? ระบบจะล้างคิวเพลง คะแนน และประวัติทั้งหมด (เพลย์ลิสต์ที่บันทึกไว้จะไม่ถูกลบ)')) return;
  state.queue = [];
  state.currentId = null;
  stopPlayer();
  state.scores = [];
  saveScores();
  state.history = [];
  saveHistory();
  renderQueue();
  showToast('เริ่มงานใหม่แล้ว — คิว คะแนน และประวัติถูกล้างแล้ว');
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
function scanLocalFolder(fileList){
  const audioExts = /\.(mp3|mp4|m4a|wav|ogg|oga|webm|mov|avi|flac|aac|wma)$/i;
  state.localLibrary = [];
  localFiles.clear();
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
  state.audioOutput = state.audioOutput === 'screen1' ? 'screen2' : 'screen1';
  sessionStorage.setItem('sriKaraoke_audioOutput', state.audioOutput);
  document.getElementById('btn-audio-output-toggle').textContent = state.audioOutput === 'screen2' ? 'จอที่ 2' : 'จอหลัก';
  applyAudioOutput();
  showToast(state.audioOutput === 'screen2' ? '🔊 เสียงย้ายไปออกที่จอที่ 2 แล้ว' : '🔊 เสียงย้ายกลับมาที่จอหลักแล้ว');
};
document.getElementById('btn-pick-local-folder').onclick = () => document.getElementById('local-folder-input').click();
document.getElementById('local-folder-input').addEventListener('change', (e) => {
  if(e.target.files && e.target.files.length) scanLocalFolder(e.target.files);
});
document.getElementById('btn-clear-local-folder').onclick = () => {
  clearLocalFolder();
  document.getElementById('local-folder-input').value = '';
};
document.getElementById('queue-toggle-btn').onclick = () => {
  const main = document.getElementById('main-content');
  const hidden = main.classList.toggle('queue-hidden');
  const btn = document.getElementById('queue-toggle-btn');
  btn.textContent = hidden ? '◀' : '▶';
  btn.title = hidden ? 'แสดงคิวเพลง' : 'ซ่อนคิวเพลง';
};
document.getElementById('effects-toggle-btn').onclick = () => {
  const panel = document.getElementById('effects-panel');
  const btn = document.getElementById('effects-toggle-btn');
  const shown = panel.style.display !== 'none';
  panel.style.display = shown ? 'none' : 'flex';
  btn.textContent = shown ? '▶' : '◀';
  btn.title = shown ? 'แสดงเสียงเอฟเฟกต์' : 'ซ่อนเสียงเอฟเฟกต์';
};
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

/* ---------------- Dark / light theme (remembered per device, not just per session) ---------------- */
let lightTheme = localStorage.getItem('sriKaraoke_theme') === 'light';
function applyTheme(){
  document.body.classList.toggle('light-theme', lightTheme);
  document.getElementById('btn-theme-toggle').textContent = lightTheme ? 'สว่าง' : 'มืด';
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', lightTheme ? '#FFFFFF' : '#1B1533');
}
document.getElementById('btn-theme-toggle').onclick = () => {
  lightTheme = !lightTheme;
  localStorage.setItem('sriKaraoke_theme', lightTheme ? 'light' : 'dark');
  applyTheme();
};
applyTheme();
applyPowerSaving();

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
