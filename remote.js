/* ===========================================================
   Sri Karaoke — รีโมท (Remote controller)
   Note: playback order/transport (play, pause, skip, prev, reorder,
   insert-next, playlists) is controlled from the main screen only.
   The remote can: search & add songs, remove/cancel songs, and
   adjust tempo — matching what the main screen allows it to do.
   =========================================================== */

const STORAGE_APIKEY = 'sriKaraoke_ytApiKey';
const LOCAL_FILE_THUMB = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="%23241C42"/><path d="M26 42a6 6 0 1 1-2-4.5V16l18-4v20.5a6 6 0 1 1-4-5.6V16.8l-10 2.2V42a6 6 0 0 1-2 0z" fill="%23FFC857"/></svg>'
);
// Same default key + override pattern as the host page (shared localStorage on the same origin).
const DEFAULT_API_KEY = 'AIzaSyBg5hplav7HzIHfXoDWlwZeENvQ7nb5i6Y';
function getApiKey(){
  const stored = localStorage.getItem(STORAGE_APIKEY);
  return stored !== null ? stored : DEFAULT_API_KEY;
}
function setApiKey(key){ localStorage.setItem(STORAGE_APIKEY, key); }
const STORAGE_NAME = 'sriKaraoke_nickname';
const STORAGE_ROOMID = 'sriKaraoke_lastRoomId';
const STORAGE_PIN = 'sriKaraoke_lastPin';
const STORAGE_ADMINTOKEN = 'sriKaraoke_lastAdminToken';

// Same extra STUN servers as the host, so connections have more paths to find each other across
// different networks. See the note in app.js for how to add a TURN server if needed too.
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

let peer = null;
let conn = null;
let currentRoomId = null;
let currentPin = '';
let currentAdminToken = '';
let myRole = 'guest';
let reconnectTimer = null;
let reconnectAttempts = 0;
let authFailed = false; // true when the PIN/admin token was rejected — don't keep auto-retrying
let myState = { queue: [], currentId: null, isPlaying: false, tempo: 1, volume: 80, muted: false, playlists: {} };
let nickname = localStorage.getItem(STORAGE_NAME) || '';

// Warn if not on a secure context — WebRTC needs HTTPS (or localhost) to be reliable.
if(location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
  document.getElementById('https-warning').style.display = 'block';
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

/* ---------------- Helpers ---------------- */
function extractVideoId(input){
  input = input.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for(const p of patterns){
    const m = input.match(p);
    if(m) return m[1];
  }
  return null;
}
function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- Connect ---------------- */
function connectToRoom(roomId, pin, adminToken, isReconnect){
  currentRoomId = roomId;
  currentPin = pin || '';
  currentAdminToken = adminToken || '';
  authFailed = false;
  sessionStorage.setItem(STORAGE_ROOMID, roomId);
  sessionStorage.setItem(STORAGE_PIN, currentPin);
  sessionStorage.setItem(STORAGE_ADMINTOKEN, currentAdminToken);
  if(!isReconnect){
    document.getElementById('connect-status').textContent = 'กำลังเชื่อมต่อ…';
  }
  if(peer){ try{ peer.destroy(); }catch(e){} }
  peer = new Peer(undefined, { config: ICE_CONFIG });
  peer.on('open', () => {
    conn = peer.connect(roomId, { reliable: true });
    conn.on('open', () => {
      // Transport is open, but the host still needs to accept our JOIN (PIN or admin token).
      conn.send({ type: 'JOIN', pin: currentPin, adminToken: currentAdminToken, nickname });
      document.getElementById('connect-status').textContent = 'กำลังตรวจสอบห้อง…';
    });
    conn.on('data', handleHostMessage);
    conn.on('close', () => { if(!authFailed) scheduleReconnect(); });
    conn.on('error', () => { if(!authFailed) scheduleReconnect(); });
  });
  peer.on('error', (err) => {
    if(isReconnect || document.getElementById('app-screen').style.display === 'flex'){
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
  const delay = Math.min(10000, 2000 * reconnectAttempts); // back off up to 10s
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToRoom(currentRoomId, currentPin, currentAdminToken, true);
  }, delay);
}

// Phones suspend background tabs when the screen locks/sleeps, which can silently kill the WebRTC
// connection without ever firing a 'close' event. The moment the screen wakes back up, check the
// connection right away instead of waiting for PeerJS to eventually notice — using the same room
// code/PIN/admin token already remembered, so no re-scan of the QR code is needed.
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible' || !currentRoomId || authFailed) return;
  const stale = !conn || !conn.open || !peer || peer.disconnected || peer.destroyed;
  if(stale){
    reconnectAttempts = 0;
    if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer = null; }
    connectToRoom(currentRoomId, currentPin, currentAdminToken, true);
  }
});

function send(msg){
  if(conn && conn.open) conn.send(msg);
}

function applyRoleUI(){
  const isAdmin = myRole === 'admin';
  document.getElementById('role-badge').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('admin-transport').style.display = isAdmin ? 'flex' : 'none';
}

function handleHostMessage(msg){
  if(msg.type === 'JOIN_OK'){
    reconnectAttempts = 0;
    myRole = msg.role || 'guest';
    applyRoleUI();
    document.getElementById('reconnect-banner').style.display = 'none';
    document.getElementById('connect-status').textContent = '';
    document.getElementById('connect-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'flex';
    document.getElementById('room-pill').textContent = currentRoomId.replace('srikaraoke-', '');
    return;
  }
  if(msg.type === 'JOIN_REJECTED'){
    authFailed = true;
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('connect-screen').style.display = 'flex';
    document.getElementById('reconnect-banner').style.display = 'none';
    document.getElementById('connect-status').textContent = '❌ รหัส PIN/รหัสแอดมินไม่ถูกต้อง กรุณากรอกใหม่แล้วกดเชื่อมต่ออีกครั้ง';
    return;
  }
  if(msg.type === 'STATE_UPDATE'){
    myState.queue = msg.queue;
    myState.currentId = msg.currentId;
    myState.isPlaying = msg.isPlaying;
    myState.tempo = msg.tempo || 1;
    myState.volume = msg.volume != null ? msg.volume : 80;
    myState.muted = !!msg.muted;
    myState.playlists = msg.playlists || {};
    renderNowPlayingStrip();
    renderQueueTab();
    renderPlaylistsTab();
    renderTempo();
    renderVolume();
    return;
  }
  if(msg.type === 'LOCAL_LIBRARY'){
    myLocalLibrary = msg.localLibrary || [];
    return;
  }
  if(msg.type === 'AUDIO_OUTPUT'){
    myAudioOutput = msg.output || 'screen1';
    return;
  }
  if(msg.type === 'SCORE_ANNOUNCE'){
    showScorePopup(msg.entry, msg.leaderboard);
  }
}

/* ---------------- Local music library (metadata only — files stay on the host device) ---------------- */
let myLocalLibrary = [];
let myAudioOutput = 'screen1';

/* ---------------- Singing score popup (mirrors host) ---------------- */
let scorePopupTimer = null;
function scoreTier(score){
  if(score >= 95) return { label: 'เพอร์เฟค!', color: '#FFD700' };
  if(score >= 85) return { label: 'ยอดเยี่ยม!', color: '#FFC857' };
  if(score >= 70) return { label: 'เก่งมาก!', color: '#2EE6D6' };
  return { label: 'พยายามได้ดี!', color: '#FF3D81' };
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
document.getElementById('score-popup-overlay').addEventListener('click', () => {
  clearTimeout(scorePopupTimer);
  document.getElementById('score-popup-overlay').style.display = 'none';
});

/* ---------------- Now playing strip ---------------- */
function renderNowPlayingStrip(){
  const strip = document.getElementById('np-strip');
  const song = myState.queue.find(s => s.id === myState.currentId);
  if(song){
    strip.style.display = 'flex';
    document.getElementById('np-thumb').src = song.thumbnail;
    document.getElementById('np-title').textContent = song.title;
    document.getElementById('np-indicator').textContent = myState.isPlaying ? '▶' : '⏸';
  } else {
    strip.style.display = 'none';
  }
}

/* ---------------- Tempo (allowed from remote) ---------------- */
function renderTempo(){
  document.getElementById('tempo-value').textContent = myState.tempo.toFixed(2) + 'x';
}
document.getElementById('btn-tempo-down').onclick = () => send({ type: 'TEMPO_DOWN' });
document.getElementById('btn-tempo-up').onclick = () => send({ type: 'TEMPO_UP' });

/* ---------------- Volume (allowed from remote) ---------------- */
function renderVolume(){
  document.getElementById('volume-value').textContent = myState.muted ? 'ปิดเสียง' : myState.volume + '%';
  const btn = document.getElementById('btn-mute');
  btn.textContent = myState.muted ? '🔇' : '🔊';
  btn.classList.toggle('on', myState.muted);
}
document.getElementById('btn-volume-down').onclick = () => send({ type: 'VOLUME_DOWN' });
document.getElementById('btn-volume-up').onclick = () => send({ type: 'VOLUME_UP' });
document.getElementById('btn-mute').onclick = () => send({ type: 'TOGGLE_MUTE' });

/* ---------------- Admin transport (only visible/effective for admin-role connections) ---------------- */
document.getElementById('btn-admin-prev').onclick = () => send({ type: 'PREV' });
document.getElementById('btn-admin-playpause').onclick = () => send({ type: 'TOGGLE_PLAY' });
document.getElementById('btn-admin-skip').onclick = () => send({ type: 'SKIP' });

/* ---------------- Queue tab ---------------- */
/* Guests: view + remove only. Admins: full control, same as the main screen. */
function renderQueueTab(){
  const wrap = document.getElementById('remote-queue-list');
  const isAdmin = myRole === 'admin';
  if(myState.queue.length === 0){
    wrap.innerHTML = '<div class="empty-note">คิวว่าง ลองค้นหาเพลงจากแท็บ "ค้นหา"</div>';
    return;
  }
  wrap.innerHTML = '';
  myState.queue.forEach((song, i) => {
    const div = document.createElement('div');
    div.className = 'q-item' + (song.id === myState.currentId ? ' playing' : '');
    div.innerHTML = `
      <div class="idx">${song.id === myState.currentId ? '▶' : i + 1}</div>
      <img src="${escapeHtml(song.thumbnail)}" alt="">
      <div class="meta">
        <div class="title">${song.source === 'local' ? '<span class="source-badge local">💻</span>' : ''}${escapeHtml(song.title)}</div>
        <div class="by">${song.by ? 'เพิ่มโดย ' + escapeHtml(song.by) : ''}</div>
      </div>
      <div class="actions">
        ${isAdmin ? '<button data-act="up" title="เลื่อนขึ้น">▲</button><button data-act="down" title="เลื่อนลง">▼</button><button data-act="next" title="แทรกเล่นถัดไป">⇧</button>' : ''}
        <button data-act="remove" title="ลบ/ยกเลิกเพลงนี้">✕</button>
      </div>`;
    if(isAdmin){
      div.querySelector('[data-act="up"]').onclick = (e) => { e.stopPropagation(); send({ type: 'MOVE_UP', id: song.id }); };
      div.querySelector('[data-act="down"]').onclick = (e) => { e.stopPropagation(); send({ type: 'MOVE_DOWN', id: song.id }); };
      div.querySelector('[data-act="next"]').onclick = (e) => { e.stopPropagation(); send({ type: 'INSERT_NEXT', id: song.id }); };
      div.addEventListener('click', () => { if(song.id !== myState.currentId) send({ type: 'PLAY_SONG', id: song.id }); });
    }
    div.querySelector('[data-act="remove"]').onclick = (e) => { e.stopPropagation(); send({ type: 'REMOVE_SONG', id: song.id }); };
    wrap.appendChild(div);
  });
  if(!isAdmin){
    const note = document.createElement('div');
    note.className = 'control-note';
    note.textContent = 'การจัดลำดับคิวและเล่น/หยุด/ข้ามเพลง ควบคุมได้ที่จอหลักหรือรีโมทแอดมินเท่านั้น';
    wrap.appendChild(note);
  }
}

/* ---------------- Playlists tab ---------------- */
/* Guests: view only. Admins: can load a playlist into the queue remotely. */
function renderPlaylistsTab(){
  const wrap = document.getElementById('remote-pl-list');
  const isAdmin = myRole === 'admin';
  const names = Object.keys(myState.playlists);
  if(names.length === 0){
    wrap.innerHTML = '<div class="empty-note">จอหลักยังไม่มีเพลย์ลิสต์ที่บันทึกไว้</div>';
    return;
  }
  wrap.innerHTML = '';
  names.forEach(name => {
    const row = document.createElement('div');
    row.className = 'pl-row';
    row.innerHTML = `
      <div class="name">${escapeHtml(name)}</div>
      <div class="count">${myState.playlists[name].length} เพลง</div>
      ${isAdmin ? '<button data-act="load">เล่นเลย</button>' : ''}`;
    if(isAdmin){
      row.querySelector('[data-act="load"]').onclick = () => send({ type: 'LOAD_PLAYLIST', name });
    }
    wrap.appendChild(row);
  });
  if(!isAdmin){
    const note = document.createElement('div');
    note.className = 'control-note';
    note.textContent = 'เปิดเพลย์ลิสต์ได้ที่จอหลักหรือรีโมทแอดมินเท่านั้น';
    wrap.appendChild(note);
  }
}

/* ---------------- Search ---------------- */
function updateSearchHint(){
  const key = getApiKey();
  const hint = document.getElementById('search-hint');
  hint.innerHTML = key
    ? 'พิมพ์ชื่อเพลงเพื่อค้นหา หรือวางลิงก์ YouTube โดยตรง'
    : 'ยังไม่ได้ตั้งค่า API Key — วางลิงก์ YouTube โดยตรงในช่องด้านบนเพื่อเพิ่มเพลงได้เลย (ตั้งค่า API Key ในแท็บ "ตั้งค่า" เพื่อค้นหาด้วยคำ)';
}

async function doSearch(){
  const q = document.getElementById('search-input').value.trim();
  if(!q) return;
  const resultsEl = document.getElementById('search-results');

  const videoId = extractVideoId(q);
  if(videoId){
    const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    resultsEl.innerHTML = '';
    resultsEl.appendChild(makeResultCard({ videoId, title: q, channel: 'ลิงก์ที่วาง', thumbnail, source: 'youtube' }));
    return;
  }

  const qLower = q.toLowerCase();
  const localMatches = myLocalLibrary
    .filter(f => f.title.toLowerCase().includes(qLower) || f.path.toLowerCase().includes(qLower))
    .slice(0, 12);

  const key = getApiKey();
  if(!key){
    resultsEl.innerHTML = '';
    localMatches.forEach(m => resultsEl.appendChild(makeResultCard({
      title: m.title, channel: m.path, thumbnail: LOCAL_FILE_THUMB, source: 'local', localFileId: m.id
    })));
    if(localMatches.length === 0){
      resultsEl.innerHTML = '<p class="hint">ยังไม่ได้ตั้งค่า API Key จึงค้นหาจาก YouTube ไม่ได้ — วางลิงก์ YouTube แทน หรือไปตั้งค่า API Key ในแท็บ "ตั้งค่า" (ค้นหาจากไฟล์ในเครื่องจอหลักได้ตามปกติถ้ามีการเชื่อมต่อโฟลเดอร์ไว้)</p>';
    }
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
    localMatches.forEach(m => resultsEl.appendChild(makeResultCard({
      title: m.title, channel: m.path, thumbnail: LOCAL_FILE_THUMB, source: 'local', localFileId: m.id
    })));
    (data.items || []).forEach(item => {
      resultsEl.appendChild(makeResultCard({
        videoId: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails.medium.url,
        source: 'youtube'
      }));
    });
    if((data.items || []).length === 0 && localMatches.length === 0){
      resultsEl.innerHTML = '<p class="hint">ไม่พบผลลัพธ์ ลองคำค้นอื่น</p>';
    }
  }catch(e){
    resultsEl.innerHTML = '';
    localMatches.forEach(m => resultsEl.appendChild(makeResultCard({
      title: m.title, channel: m.path, thumbnail: LOCAL_FILE_THUMB, source: 'local', localFileId: m.id
    })));
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'ค้นหาจาก YouTube ไม่สำเร็จ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต (แสดงเฉพาะผลจากไฟล์ในเครื่องจอหลักได้ตามปกติ)';
    resultsEl.appendChild(note);
  }
}

function makeResultCard(v){
  const card = document.createElement('div');
  card.className = 'result-card';
  const badge = v.source === 'local'
    ? '<span class="source-badge local">💻 อุปกรณ์</span>'
    : '<span class="source-badge yt">🌐 YouTube</span>';
  card.innerHTML = `
    <img src="${escapeHtml(v.thumbnail)}" alt="">
    <div class="meta">
      <div class="title">${badge}${escapeHtml(v.title)}</div>
      <div class="channel">${escapeHtml(v.channel)}</div>
    </div>
    <button>+ เพิ่ม</button>`;
  card.querySelector('button').onclick = () => {
    const song = v.source === 'local'
      ? { source: 'local', localFileId: v.localFileId, title: v.title, thumbnail: v.thumbnail }
      : { source: 'youtube', videoId: v.videoId, title: v.title, thumbnail: v.thumbnail };
    send({ type: 'ADD_SONG', song, from: nickname });
    card.querySelector('button').textContent = 'เพิ่มแล้ว ✓';
    card.querySelector('button').disabled = true;
  };
  return card;
}

/* ---------------- Tabs ---------------- */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  };
});

/* ---------------- Settings ---------------- */
document.getElementById('api-key-input').value = getApiKey();
document.getElementById('btn-save-key').onclick = () => {
  setApiKey(document.getElementById('api-key-input').value.trim());
  updateSearchHint();
  document.getElementById('btn-save-key').textContent = 'บันทึกแล้ว ✓';
  setTimeout(() => { document.getElementById('btn-save-key').textContent = 'บันทึก'; }, 1500);
};
updateSearchHint();

/* ---------------- Connect screen wiring ---------------- */
document.getElementById('nickname-input').value = nickname;
document.getElementById('nickname-input').addEventListener('change', (e) => {
  nickname = e.target.value.trim();
  localStorage.setItem(STORAGE_NAME, nickname);
});

document.getElementById('btn-connect').onclick = () => {
  let code = document.getElementById('room-input').value.trim().toUpperCase();
  if(!code) return;
  const roomId = code.startsWith('SRIKARAOKE-') ? code.toLowerCase() : 'srikaraoke-' + code;
  const pin = document.getElementById('pin-input').value.trim();
  const adminToken = document.getElementById('admintoken-input').value.trim().toUpperCase();
  connectToRoom(roomId, pin, adminToken);
};
document.getElementById('search-input').addEventListener('keydown', (e) => { if(e.key === 'Enter') doSearch(); });
document.getElementById('search-input').addEventListener('input', (e) => {
  liveLocalSearchRemote(e.target.value.trim());
});
document.getElementById('btn-search').onclick = doSearch;

/* Auto-connect from ?room=/&pin=/&admintoken= params (QR scan), or resume the last room after a refresh */
(function autoConnect(){
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room') || sessionStorage.getItem(STORAGE_ROOMID);
  const pin = params.get('pin') || sessionStorage.getItem(STORAGE_PIN) || '';
  const adminToken = params.get('admintoken') || sessionStorage.getItem(STORAGE_ADMINTOKEN) || '';
  if(room){
    document.getElementById('room-input').value = room.replace('srikaraoke-', '').toUpperCase();
    document.getElementById('pin-input').value = pin;
    document.getElementById('admintoken-input').value = adminToken;
    connectToRoom(room, pin, adminToken);
  }
})();

/* Service worker */
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed', err));
  });
}
