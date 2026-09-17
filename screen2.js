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
  sessionStorage.setItem(STORAGE_ROOMID, roomId);
  sessionStorage.setItem(STORAGE_PIN, currentPin);
  if(!isReconnect) document.getElementById('connect-status').textContent = 'กำลังเชื่อมต่อ…';
  if(peer){ try{ peer.destroy(); }catch(e){} }
  peer = new Peer(undefined, { config: ICE_CONFIG });
  peer.on('open', () => {
    conn = peer.connect(roomId, { reliable: true });
    conn.on('open', () => {
      // "screen2" is just a plain guest join — it never sends ADD_SONG/REMOVE_SONG/etc.,
      // so it needs no special permission tier on the host side at all.
      conn.send({ type: 'JOIN', pin: currentPin, nickname: 'จอที่ 2' });
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
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible' || !currentRoomId || authFailed) return;
  const stale = !conn || !conn.open || !peer || peer.disconnected || peer.destroyed;
  if(stale){
    reconnectAttempts = 0;
    if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer = null; }
    connectToRoom(currentRoomId, currentPin, true);
  }
});

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
    return;
  }
  if(msg.type === 'AUDIO_OUTPUT'){
    applyAudioFromHost(msg.output, msg.volume, msg.muted);
    return;
  }
  if(msg.type === 'CHORDS_LIBRARY'){
    myChords = msg.chords || {};
    return;
  }
  if(msg.type === 'SCORE_ANNOUNCE'){
    showScorePopup(msg.entry, msg.leaderboard);
  }
}

// Screen 2's own YouTube player is normally muted (the host is the default audio source), but if
// the host switches "เสียงออกที่จอไหน" to Screen 2, it broadcasts an AUDIO_OUTPUT message telling
// this page to become the audio source instead — volume/mute here then mirror the host's controls.
let pendingAudioState = null;
function applyAudioFromHost(output, volume, muted){
  if(!ytReady || !ytPlayer){ pendingAudioState = { output, volume, muted }; return; }
  try{
    if(output === 'screen2'){
      ytPlayer.setVolume(muted ? 0 : (typeof volume === 'number' ? volume : 100));
      if(muted) ytPlayer.mute(); else ytPlayer.unMute();
    } else {
      ytPlayer.mute();
      ytPlayer.setVolume(0);
    }
  }catch(e){}
}

/* ---------------- YouTube player ---------------- */
let lastLoadedVideoId = null;
function onYouTubeIframeAPIReady(){
  ytPlayer = new YT.Player('d-player', {
    width: '100%', height: '100%',
    playerVars: { autoplay: 1, playsinline: 1, controls: 0, rel: 0, disablekb: 1, modestbranding: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        // Screen 2 is a silent visual display by default (the host is the audio source), so this
        // player is muted on purpose unless the host has switched audio output to Screen 2.
        if(pendingAudioState) applyAudioFromHost(pendingAudioState.output, pendingAudioState.volume, pendingAudioState.muted);
        else { ytPlayer.mute(); ytPlayer.setVolume(0); }
      }
    }
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function applyVideoState(currentId, currentTime){
  const song = myQueue.find(s => s.id === currentId);
  if(!song || song.source === 'local'){
    // Local files only exist on the host device's own file system — Screen 2 has no way to read or
    // play them, so it just clears its player and shows a placeholder (handled in renderDisplay).
    lastLoadedVideoId = null;
    if(ytReady && ytPlayer){ try{ ytPlayer.stopVideo(); }catch(e){} }
    return;
  }
  if(!ytReady || !ytPlayer) return;
  if(song.videoId !== lastLoadedVideoId){
    lastLoadedVideoId = song.videoId;
    try{
      ytPlayer.loadVideoById(song.videoId);
      if(typeof currentTime === 'number' && currentTime > 1){
        setTimeout(() => { try{ ytPlayer.seekTo(currentTime, true); }catch(e){} }, 600);
      }
    }catch(e){}
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
  textEl.textContent = '🎤 กำลังเล่นเพลงนี้: ' + song.title + (song.by ? ' • เพิ่มโดย ' + song.by : '');
  textEl.style.animation = 'none';
  void textEl.offsetWidth; // force reflow so the browser "forgets" the previous animation state
  const duration = Math.max(10, textEl.textContent.length * 0.35);
  textEl.style.animation = `np-marquee-rtl ${duration}s linear infinite`;
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

  if(song && song.source === 'local'){
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
  const room = params.get('room') || sessionStorage.getItem(STORAGE_ROOMID);
  const pin = params.get('pin') || sessionStorage.getItem(STORAGE_PIN) || '';
  if(room){
    document.getElementById('room-input').value = room.replace('srikaraoke-', '').toUpperCase();
    document.getElementById('pin-input').value = pin;
    connectToRoom(room, pin);
  }
})();
