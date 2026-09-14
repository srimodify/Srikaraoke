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
const TEMPO_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

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
  fairQueueMode: sessionStorage.getItem('sriKaraoke_fairMode') === '1'
};

let ytPlayer = null;
let ytReady = false;
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

function addToHistory(song, reason){
  state.history.unshift({
    id: uid(), videoId: song.videoId, title: song.title, thumbnail: song.thumbnail,
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
    if(song && ytReady && ytPlayer){
      ytPlayer.loadVideoById(song.videoId);
      ytPlayer.setPlaybackRate(state.tempo);
      state.isPlaying = true;
    }
  } else {
    stopPlayer();
  }
  renderQueue();
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
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
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
      <img src="${song.thumbnail}" alt="">
      <div class="meta">
        <div class="title">${escapeHtml(song.title)}</div>
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
  const bar = document.getElementById('now-playing-bar');
  const idle = document.getElementById('idle-screen');
  const song = currentSong();
  const nextBar = document.getElementById('next-up-bar');
  if(song){
    bar.style.display = 'flex';
    idle.style.display = 'none';
    document.getElementById('np-thumb').src = song.thumbnail;
    document.getElementById('np-title').textContent = song.title;
    document.getElementById('np-by').textContent = song.by ? 'เพิ่มโดย ' + song.by : '';

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
  } else {
    bar.style.display = 'none';
    idle.style.display = 'flex';
    nextBar.style.display = 'none';
  }
  document.getElementById('btn-playpause').textContent = state.isPlaying ? '⏸ หยุด' : '▶ เล่น';
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
  const newSong = { id: uid(), videoId: song.videoId, title: song.title, thumbnail: song.thumbnail, by: from || '' };

  // Friendly heads-up if this song was already played recently or is already queued — still adds it either way.
  const recentlyPlayed = state.history.slice(0, 15).some(h => h.videoId === newSong.videoId);
  const alreadyQueued = state.queue.some(s => s.videoId === newSong.videoId);
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
      if(list[round]) result.push(list[round]);
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
  if(!ytPlayer || !state.currentId) return;
  if(state.isPlaying){ ytPlayer.pauseVideo(); state.isPlaying = false; }
  else { ytPlayer.playVideo(); state.isPlaying = true; }
  renderQueue();
}

function stopPlayer(){
  if(ytPlayer){ try{ ytPlayer.stopVideo(); }catch(e){} }
  state.isPlaying = false;
}

/* ---------------- Tempo (speed) — allowed from host AND remote ---------------- */
function tempoStep(dir){
  const idx = TEMPO_RATES.indexOf(state.tempo);
  const nextIdx = Math.min(TEMPO_RATES.length - 1, Math.max(0, (idx === -1 ? 2 : idx) + dir));
  state.tempo = TEMPO_RATES[nextIdx];
  if(ytReady && ytPlayer) ytPlayer.setPlaybackRate(state.tempo);
  renderTempo();
  broadcastState();
}

/* ---------------- Volume — allowed from host AND remote ---------------- */
function volumeStep(dir){
  if(state.muted){ state.muted = false; if(ytReady && ytPlayer) ytPlayer.unMute(); }
  state.volume = Math.min(100, Math.max(0, state.volume + dir * 10));
  if(ytReady && ytPlayer) ytPlayer.setVolume(state.volume);
  renderVolume();
  broadcastState();
}
function toggleMute(){
  state.muted = !state.muted;
  if(ytReady && ytPlayer){ state.muted ? ytPlayer.mute() : ytPlayer.unMute(); }
  renderVolume();
  broadcastState();
}

/* ---------------- YouTube ---------------- */
let audioUnlocked = false;

function onYouTubeIframeAPIReady(){
  ytPlayer = new YT.Player('player', {
    width: '100%', height: '100%',
    playerVars: { autoplay: 0, playsinline: 1, controls: 1, rel: 0 },
    events: {
      onReady: () => { ytReady = true; ytPlayer.setVolume(state.volume); if(state.muted) ytPlayer.mute(); },
      onStateChange: (e) => {
        if(e.data === YT.PlayerState.ENDED){
          const finishedSong = currentSong();
          if(finishedSong) recordAndShowScore(finishedSong);
          skip('เล่นจบ');
        }
        if(e.data === YT.PlayerState.PLAYING){ state.isPlaying = true; renderNowPlaying(); }
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
  document.getElementById('btn-start-audio').style.display = 'none';
  document.getElementById('idle-title').textContent = 'พร้อมแล้ว!';
  document.getElementById('idle-desc').style.display = 'block';
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
}

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
  peer = new Peer(peerId);

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
}

// Guests can queue/remove songs and adjust tempo. Admins get full remote control,
// equivalent to standing at the main screen — matches what a scanned Admin QR grants.
const GUEST_ALLOWED = new Set(['ADD_SONG', 'REMOVE_SONG', 'TEMPO_UP', 'TEMPO_DOWN', 'VOLUME_UP', 'VOLUME_DOWN', 'TOGGLE_MUTE']);
const ADMIN_ALLOWED = new Set([
  ...GUEST_ALLOWED,
  'SKIP', 'PREV', 'TOGGLE_PLAY', 'INSERT_NEXT', 'MOVE_UP', 'MOVE_DOWN', 'REORDER_BEFORE', 'LOAD_PLAYLIST', 'PLAY_SONG'
]);

function handleRemoteMessage(msg, conn){
  const allowed = conn._role === 'admin' ? ADMIN_ALLOWED : GUEST_ALLOWED;
  if(!allowed.has(msg.type)) return;
  switch(msg.type){
    case 'ADD_SONG':
      addSong(msg.song, msg.from, false);
      showToast(`🎵 ${msg.from ? msg.from + ' ' : ''}เพิ่มเพลง "${msg.song.title}" เข้าคิว`);
      break;
    case 'REMOVE_SONG': removeSong(msg.id); break;
    case 'TEMPO_UP': tempoStep(1); break;
    case 'TEMPO_DOWN': tempoStep(-1); break;
    case 'VOLUME_UP': volumeStep(1); break;
    case 'VOLUME_DOWN': volumeStep(-1); break;
    case 'TOGGLE_MUTE': toggleMute(); break;
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
function sendState(conn){
  conn.send({
    type: 'STATE_UPDATE',
    queue: state.queue,
    currentId: state.currentId,
    isPlaying: state.isPlaying,
    tempo: state.tempo,
    volume: state.volume,
    muted: state.muted,
    playlists: state.playlists
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
  state.playlists[name] = state.queue.map(({ videoId, title, thumbnail, by }) => ({ videoId, title, thumbnail, by }));
  savePlaylists();
  renderPlaylists();
}

function exportPlaylists(){
  if(Object.keys(state.playlists).length === 0){
    showToast('ยังไม่มีเพลย์ลิสต์ให้ส่งออก', true);
    return;
  }
  const blob = new Blob([JSON.stringify(state.playlists, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sri-karaoke-playlists.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importPlaylistsFromFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try{
      const data = JSON.parse(e.target.result);
      if(typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('bad format');
      let count = 0;
      Object.keys(data).forEach(name => {
        const songs = data[name];
        if(!Array.isArray(songs)) return;
        const cleaned = songs
          .filter(s => s && s.videoId && s.title)
          .map(s => ({ videoId: s.videoId, title: s.title, thumbnail: s.thumbnail || '', by: s.by || '' }));
        if(cleaned.length === 0) return;
        const finalName = state.playlists[name] ? name + ' (นำเข้า)' : name;
        state.playlists[finalName] = cleaned;
        count++;
      });
      if(count === 0) throw new Error('no valid playlists');
      savePlaylists();
      renderPlaylists();
      showToast(`นำเข้าเพลย์ลิสต์สำเร็จ ${count} รายการ`);
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
    row.innerHTML = `
      <img src="${h.thumbnail}" alt="">
      <div class="meta">
        <div class="title">${escapeHtml(h.title)}</div>
        <div class="sub">${h.by ? 'เพิ่มโดย ' + escapeHtml(h.by) + ' · ' : ''}${escapeHtml(h.reason)} · ${formatTimeAgo(h.playedAt)}</div>
      </div>
      <button data-act="requeue" title="เพิ่มเข้าคิวอีกครั้ง">+ คิว</button>`;
    row.querySelector('[data-act="requeue"]').onclick = (e) => {
      addSong({ videoId: h.videoId, title: h.title, thumbnail: h.thumbnail }, 'จอหลัก', false);
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
  card.innerHTML = `
    <img src="${v.thumbnail}" alt="">
    <div class="meta">
      <div class="title">${escapeHtml(v.title)}</div>
      <div class="channel">${escapeHtml(v.channel)}</div>
    </div>
    <div class="result-actions">
      <button data-act="play">▶ เล่นเลย</button>
      <button data-act="queue">+ คิว</button>
    </div>`;
  card.querySelector('[data-act="play"]').onclick = () => {
    addSong({ videoId: v.videoId, title: v.title, thumbnail: v.thumbnail }, 'จอหลัก', true);
  };
  card.querySelector('[data-act="queue"]').onclick = (e) => {
    addSong({ videoId: v.videoId, title: v.title, thumbnail: v.thumbnail }, 'จอหลัก', false);
    e.target.textContent = 'เพิ่มแล้ว ✓';
    e.target.disabled = true;
  };
  return card;
}

async function doHostSearch(){
  const q = document.getElementById('host-search-input').value.trim();
  if(!q) return;
  const resultsEl = document.getElementById('host-search-results');

  const videoId = extractVideoId(q);
  if(videoId){
    resultsEl.innerHTML = '';
    resultsEl.appendChild(makeHostResultCard({
      videoId, title: q, channel: 'ลิงก์ที่วาง', thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
    }));
    return;
  }

  const key = getApiKey();
  if(!key){
    resultsEl.innerHTML = '<p class="hint">ยังไม่ได้ตั้งค่า API Key จึงค้นหาด้วยคำไม่ได้ — วางลิงก์ YouTube แทน หรือใส่ API Key ด้านล่าง</p>';
    return;
  }

  resultsEl.innerHTML = '<p class="hint">กำลังค้นหา…</p>';
  try{
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=12&type=video&q=${encodeURIComponent(q + ' karaoke')}&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if(data.error){
      resultsEl.innerHTML = `<p class="hint">เกิดข้อผิดพลาด: ${escapeHtml(data.error.message)}</p>`;
      return;
    }
    resultsEl.innerHTML = '';
    (data.items || []).forEach(item => {
      resultsEl.appendChild(makeHostResultCard({
        videoId: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails.medium.url
      }));
    });
    if((data.items || []).length === 0) resultsEl.innerHTML = '<p class="hint">ไม่พบผลลัพธ์ ลองคำค้นอื่น</p>';
  }catch(e){
    resultsEl.innerHTML = '<p class="hint">ค้นหาไม่สำเร็จ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต</p>';
  }
}

/* ---------------- Wiring ---------------- */
document.getElementById('btn-qr').onclick = () => openModal('qr-modal');
document.getElementById('btn-playlist').onclick = () => { renderPlaylists(); openModal('playlist-modal'); };
document.getElementById('btn-search').onclick = () => {
  updateHostSearchHint();
  openModal('search-modal');
};
document.getElementById('btn-toggle-suggested').onclick = () => {
  const section = document.getElementById('host-suggested-section');
  const showing = section.style.display !== 'none';
  if(!showing) renderSuggestedChips('host-suggested-chips', 'host-search-input', doHostSearch);
  section.style.display = showing ? 'none' : 'block';
};
document.getElementById('btn-history').onclick = () => { renderHistory(); openModal('history-modal'); };
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
document.getElementById('btn-fair-toggle').onclick = () => {
  state.fairQueueMode = !state.fairQueueMode;
  sessionStorage.setItem('sriKaraoke_fairMode', state.fairQueueMode ? '1' : '0');
  const btn = document.getElementById('btn-fair-toggle');
  btn.textContent = state.fairQueueMode ? '👥 คิวคนร้อง: เปิด' : '👥 คิวคนร้อง: ปิด';
  btn.classList.toggle('on', state.fairQueueMode);
  document.getElementById('fair-hint').style.display = state.fairQueueMode ? 'block' : 'none';
  if(state.fairQueueMode){
    fairReorderQueue();
    showToast('เปิดคิวคนร้อง — จัดคิวใหม่ให้สลับกันร้องอัตโนมัติ');
  }
  renderQueue();
};
document.getElementById('btn-toggle-queue').onclick = () => {
  const main = document.getElementById('main-content');
  const hidden = main.classList.toggle('queue-hidden');
  const btn = document.getElementById('btn-toggle-queue');
  btn.querySelector('.label').textContent = hidden ? 'แสดงคิว' : 'ซ่อนคิว';
};
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
document.getElementById('btn-export-pl').onclick = exportPlaylists;
document.getElementById('btn-import-pl').onclick = () => document.getElementById('import-pl-file').click();
document.getElementById('import-pl-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(file) importPlaylistsFromFile(file);
  e.target.value = '';
});
document.getElementById('host-search-input').addEventListener('keydown', (e) => { if(e.key === 'Enter') doHostSearch(); });
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
  document.getElementById('fair-hint').style.display = 'block';
}

initPeer();
renderQueue();
