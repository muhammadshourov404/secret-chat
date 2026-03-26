'use strict';
/* ═══════════════════════════════════════════════════════════
   SECURE P2P  v2.0  —  script.js
   Copyright Owner: Muhammad Shourov
   Architecture: Star-topology WebRTC · Host-Approval · AES-256
   Features: Multi-user · TURN · File Chunking · Auto-prune LS
═══════════════════════════════════════════════════════════ */

/* ──────────────────────────────────────────
   1. CONFIG
────────────────────────────────────────── */
const CFG = {
  ICE: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  MAX_MSGS:    60,      // keep last 60 messages in localStorage
  CHUNK_SIZE:  16384,   // 16 KB chunks (WebRTC DataChannel safe limit)
  TYPING_STOP: 2500,    // ms idle before 'stopped typing'
  TYPING_SEND: 1500,    // ms between typing signals
  PREFIX:      'sp2p-', // peer ID prefix
  CONNECT_TO:  12000    // ms connection timeout
};

/* ──────────────────────────────────────────
   2. STATE
────────────────────────────────────────── */
const S = {
  peer:         null,
  isHost:       false,
  roomId:       null,
  myName:       null,
  encKey:       null,
  requireApproval: true,

  /* HOST: peerId → { conn, name, approved } */
  guests:       new Map(),

  /* GUEST: connection to host */
  hostConn:     null,

  /* Participants cache: [{peerId, name, isHost}] */
  participants: [],

  /* Approval queue (host) */
  aqQueue:      [],   // [{peerId, name, conn}]
  aqShowing:    false,

  /* Call state */
  activeCall:   null,
  pendingCall:  null,
  localStream:  null,
  pendingCallVideo: false,
  callTargetVideoEnabled: false,
  micOn: true,
  camOn: true,

  /* File chunking */
  fileIncoming: {},   // fileId → { chunks[], total, received, name, mimeType, size }

  /* Typing */
  typingTimer:  null,
  lastTypingAt: 0,
  isTyping:     false,
  typingPeers:  new Set(),

  retryCount:   0
};

/* ──────────────────────────────────────────
   3. DOM
────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const D = {
  // Screens
  sSetup:   $('screen-setup'),
  sWait:    $('screen-waiting'),
  sChat:    $('screen-chat'),
  sError:   $('screen-error'),
  loading:  $('loading'),
  loadTxt:  $('loading-txt'),

  // Setup
  joinBanner:   $('join-banner'),
  joinRoomId:   $('join-room-id'),
  nameInput:    $('name-input'),
  hostOptions:  $('host-options'),
  approvalToggle: $('approval-toggle'),
  btnCreate:    $('btn-create-room'),
  btnJoin:      $('btn-join-room'),

  // Waiting
  waitName:     $('wait-name-display'),
  btnCancelWait:$('btn-cancel-wait'),

  // Header
  sdot:         $('sdot'),
  stext:        $('stext'),
  btnParticipants: $('btn-participants'),
  pBadge:       $('p-badge'),
  btnAudioCall: $('btn-audio-call'),
  btnVideoCall: $('btn-video-call'),
  btnDestroy:   $('btn-destroy'),

  // Share banner
  shareBanner:  $('share-banner'),
  shareInput:   $('share-link-input'),
  btnCopy:      $('btn-copy'),
  btnShare:     $('btn-share'),

  // Approval queue
  aqWrap:       $('approval-queue'),
  aqName:       $('aq-name'),
  aqCountRow:   $('aq-count-row'),
  aqPendingCount: $('aq-pending-count'),
  btnApprove:   $('btn-approve'),
  btnReject:    $('btn-reject'),

  // Video
  videoArea:    $('video-area'),
  remoteVid:    $('remote-video'),
  localVid:     $('local-video'),
  callPeerInfo: $('call-peer-info'),
  btnTogMic:    $('btn-tog-mic'),
  btnTogCam:    $('btn-tog-cam'),
  btnEndCall:   $('btn-end-call'),

  // Incoming call
  icOverlay:    $('incoming-call'),
  icType:       $('ic-type'),
  icCallerName: $('ic-caller-name'),
  btnAccept:    $('btn-accept-call'),
  btnDecline:   $('btn-decline-call'),

  // Messages
  msgArea:      $('msg-area'),
  msgList:      $('msg-list'),
  typingRow:    $('typing-row'),
  typingLabel:  $('typing-label'),

  // File progress
  xferWrap:     $('xfer-wrap'),
  xferFill:     $('xfer-fill'),
  xferLabel:    $('xfer-label'),

  // Input
  fileInput:    $('file-input'),
  msgInput:     $('msg-input'),
  btnSend:      $('btn-send'),

  // Participants panel
  pPanel:       $('participants-panel'),
  panelOverlay: $('panel-overlay'),
  ppList:       $('pp-list'),
  btnClosePanel:$('btn-close-panel'),

  // Error
  errTitle:     $('err-title'),
  errMsg:       $('err-msg'),

  // Modals
  modalDestroy: $('modal-destroy'),
  mdCancel:     $('md-cancel'),
  mdConfirm:    $('md-confirm'),
  modalCallTarget: $('modal-call-target'),
  ctCallTypeLabel: $('ct-call-type-label'),
  ctList:       $('ct-list'),
  ctCancel:     $('ct-cancel')
};

/* ──────────────────────────────────────────
   4. UTILITIES
────────────────────────────────────────── */
function genId(n = 10) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fileIcon(mime) {
  if (!mime) return 'fa-file';
  if (mime.startsWith('image/'))  return 'fa-file-image';
  if (mime.startsWith('video/'))  return 'fa-file-video';
  if (mime.startsWith('audio/'))  return 'fa-file-audio';
  if (mime.includes('pdf'))       return 'fa-file-pdf';
  if (mime.includes('zip') || mime.includes('rar')) return 'fa-file-zipper';
  if (mime.includes('word') || mime.includes('document')) return 'fa-file-word';
  if (mime.includes('sheet') || mime.includes('excel'))   return 'fa-file-excel';
  if (mime.includes('text'))      return 'fa-file-lines';
  return 'fa-file';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function scrollBottom() {
  D.msgArea.scrollTo({ top: D.msgArea.scrollHeight, behavior: 'smooth' });
}

function ab2b64(buf) {
  let s = '';
  new Uint8Array(buf).forEach(b => s += String.fromCharCode(b));
  return btoa(s);
}

function b642ab(b64) {
  const s = atob(b64);
  const b = new ArrayBuffer(s.length);
  const v = new Uint8Array(b);
  for (let i = 0; i < s.length; i++) v[i] = s.charCodeAt(i);
  return b;
}

function nameInitial(name) {
  return (name || '?').charAt(0).toUpperCase();
}

/* Get name of a peer by ID */
function peerName(peerId) {
  if (peerId === S.peer?.id) return S.myName;
  const p = S.participants.find(x => x.peerId === peerId);
  if (p) return p.name;
  if (S.isHost) return S.guests.get(peerId)?.name || 'Unknown';
  return 'Unknown';
}

/* ──────────────────────────────────────────
   5. CRYPTO
────────────────────────────────────────── */
function deriveKey(roomId) {
  return CryptoJS.SHA256('sp2p-v2-' + roomId).toString();
}

function encrypt(text) {
  if (!S.encKey) return text;
  return CryptoJS.AES.encrypt(text, S.encKey).toString();
}

function decrypt(cipher) {
  if (!S.encKey) return cipher;
  try {
    const b = CryptoJS.AES.decrypt(cipher, S.encKey);
    return b.toString(CryptoJS.enc.Utf8) || cipher;
  } catch { return cipher; }
}

/* ──────────────────────────────────────────
   6. STORAGE
────────────────────────────────────────── */
const LS = {
  k: {
    role: r => `sp2p_role_${r}`,
    msgs: r => `sp2p_msgs_${r}`,
    myId: r => `sp2p_myid_${r}`
  },

  save(msgs) {
    if (!S.roomId) return;
    const pruned = msgs.slice(-CFG.MAX_MSGS);
    try {
      localStorage.setItem(LS.k.msgs(S.roomId), encrypt(JSON.stringify(pruned)));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        try {
          localStorage.setItem(LS.k.msgs(S.roomId), encrypt(JSON.stringify(msgs.slice(-25))));
        } catch (_) {
          localStorage.removeItem(LS.k.msgs(S.roomId));
        }
      }
    }
  },

  load() {
    if (!S.roomId) return [];
    try {
      const raw = localStorage.getItem(LS.k.msgs(S.roomId));
      return raw ? JSON.parse(decrypt(raw)) : [];
    } catch { return []; }
  },

  setRole(r) { localStorage.setItem(LS.k.role(S.roomId), r); },
  getRole()  { return localStorage.getItem(LS.k.role(S.roomId)); },
  setMyId(id){ localStorage.setItem(LS.k.myId(S.roomId), id); },
  getMyId()  { return localStorage.getItem(LS.k.myId(S.roomId)); },

  wipe() {
    if (!S.roomId) return;
    [LS.k.role, LS.k.msgs, LS.k.myId].forEach(fn => localStorage.removeItem(fn(S.roomId)));
  }
};

let _msgs = [];
function addMsg(m) {
  _msgs.push(m);
  LS.save(_msgs);
}

/* ──────────────────────────────────────────
   7. SOUND
────────────────────────────────────────── */
let _actx = null;
function beep(freq = 880, dur = 0.12, vol = 0.22, type = 'sine') {
  try {
    if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
    if (_actx.state === 'suspended') _actx.resume();
    const osc = _actx.createOscillator(), g = _actx.createGain();
    osc.connect(g); g.connect(_actx.destination);
    osc.frequency.value = freq; osc.type = type;
    g.gain.setValueAtTime(vol, _actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, _actx.currentTime + dur);
    osc.start(); osc.stop(_actx.currentTime + dur);
  } catch (_) {}
}
function ringBeep() { beep(660, .15, .28); setTimeout(() => beep(880, .15, .28), 200); }

/* ──────────────────────────────────────────
   8. TOAST
────────────────────────────────────────── */
let _toastT = null;
function toast(msg, type = '', dur = 2800) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  clearTimeout(_toastT);
  requestAnimationFrame(() => {
    t.classList.add('show');
    _toastT = setTimeout(() => t.classList.remove('show'), dur);
  });
}

/* ──────────────────────────────────────────
   9. LOADING / SCREEN
────────────────────────────────────────── */
function showLoad(txt = 'Please wait…') {
  D.loadTxt.textContent = txt;
  D.loading.style.display = 'flex';
}
function hideLoad() { D.loading.style.display = 'none'; }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $('screen-' + name);
  if (el) el.classList.add('active');
}

function showError(title, msg) {
  hideLoad();
  D.errTitle.textContent = title;
  D.errMsg.textContent = msg;
  showScreen('error');
}

/* ──────────────────────────────────────────
   10. STATUS
────────────────────────────────────────── */
function setStatus(state, text) {
  D.sdot.className = 'sdot ' + state;
  D.stext.textContent = text;
}

/* ──────────────────────────────────────────
   11. RENDER MESSAGES
────────────────────────────────────────── */
function renderMsg(m) {
  const isOut = m.fromPeerId === (S.peer?.id);

  if (m.type === 'system') {
    const d = document.createElement('div');
    d.className = 'msg-sys';
    d.innerHTML = `<span>${escHtml(m.content)}</span>`;
    D.msgList.appendChild(d);
    scrollBottom();
    return;
  }

  const row = document.createElement('div');
  row.className = 'msg-row ' + (isOut ? 'out' : 'in');

  const name = isOut ? '' : escHtml(m.senderName || peerName(m.fromPeerId) || 'Unknown');

  if (m.type === 'text') {
    row.innerHTML = `
      ${!isOut ? `<div class="msg-sender-name">${name}</div>` : ''}
      <div class="msg-bubble">${escHtml(m.content).replace(/\n/g,'<br>')}
        <span class="msg-time">${fmtTime(m.ts)}</span>
      </div>`;
  } else if (m.type === 'image') {
    row.innerHTML = `
      ${!isOut ? `<div class="msg-sender-name">${name}</div>` : ''}
      <div class="msg-bubble" style="padding:.35rem;background:transparent;border:none">
        <img src="${m.dataUrl}" class="msg-img" alt="${escHtml(m.fileName)}"
          onclick="openImg('${m.dataUrl}')" loading="lazy">
        <span class="msg-time" style="padding:0 .2rem">${fmtTime(m.ts)}</span>
      </div>`;
  } else if (m.type === 'file') {
    row.innerHTML = `
      ${!isOut ? `<div class="msg-sender-name">${name}</div>` : ''}
      <div class="msg-bubble">
        <div class="file-card" onclick="dlFile('${m.dataUrl}','${escHtml(m.fileName)}')">
          <i class="fas ${fileIcon(m.mimeType)} fi-icon"></i>
          <div class="fi-info">
            <div class="fi-name">${escHtml(m.fileName)}</div>
            <div class="fi-size">${fmtBytes(m.fileSize)} · tap to download</div>
          </div>
          <i class="fas fa-download" style="color:var(--muted);font-size:.75rem"></i>
        </div>
        <span class="msg-time">${fmtTime(m.ts)}</span>
      </div>`;
  }

  D.msgList.appendChild(row);
  scrollBottom();
}

window.openImg = src => { const w = window.open(); w && w.document.write(`<img src="${src}" style="max-width:100%;background:#111">`); };
window.dlFile  = (url, name) => { if (!url) return; const a = document.createElement('a'); a.href = url; a.download = name; a.click(); };

/* Append system message (not persisted) */
function sysMsg(txt) {
  renderMsg({ type: 'system', content: txt, ts: Date.now() });
}

/* ──────────────────────────────────────────
   12. PARTICIPANTS PANEL
────────────────────────────────────────── */
function buildParticipants() {
  const list = S.participants;
  D.pBadge.textContent = list.length;
  D.pBadge.style.display = list.length > 0 ? 'flex' : 'none';

  D.ppList.innerHTML = '';
  list.forEach(p => {
    const isSelf = p.peerId === S.peer?.id;
    const isHostP = p.isHost;
    const div = document.createElement('div');
    div.className = 'p-item';
    div.innerHTML = `
      <div class="p-avi">${nameInitial(p.name)}</div>
      <div class="p-info">
        <div class="p-name">${escHtml(p.name)}${isSelf ? ' <span style="color:var(--muted);font-size:.65rem">(You)</span>' : ''}</div>
        <div class="p-role">${isHostP ? '👑 Host' : 'Participant'}</div>
      </div>
      <div class="p-actions">
        ${!isSelf ? `<button class="p-action-btn" title="Voice Call" onclick="callPeer('${p.peerId}',false)"><i class="fas fa-phone"></i></button>
                    <button class="p-action-btn" title="Video Call" onclick="callPeer('${p.peerId}',true)"><i class="fas fa-video"></i></button>` : ''}
        ${S.isHost && !isSelf ? `<button class="p-action-btn kick" title="Remove" onclick="kickPeer('${p.peerId}')"><i class="fas fa-user-minus"></i></button>` : ''}
      </div>`;
    D.ppList.appendChild(div);
  });

  // Enable/disable call buttons in header
  const canCall = list.filter(p => p.peerId !== S.peer?.id).length > 0;
  D.btnAudioCall.disabled = !canCall;
  D.btnVideoCall.disabled = !canCall;
}

function openPanel() {
  D.pPanel.classList.add('open');
  D.panelOverlay.style.display = 'block';
}
function closePanel() {
  D.pPanel.classList.remove('open');
  D.panelOverlay.style.display = 'none';
}

window.callPeer = (peerId, videoEnabled) => {
  closePanel();
  startCallToPeer(peerId, videoEnabled);
};

window.kickPeer = (peerId) => {
  if (!S.isHost) return;
  const g = S.guests.get(peerId);
  if (!g) return;
  try { g.conn.send(JSON.stringify({ type: 'kicked' })); } catch (_) {}
  setTimeout(() => {
    try { g.conn.close(); } catch (_) {}
    removeParticipant(peerId);
  }, 300);
  toast(`${g.name} was removed.`, 'warn');
};

/* ──────────────────────────────────────────
   13. APPROVAL QUEUE
────────────────────────────────────────── */
function enqueueApproval(peerId, name, conn) {
  S.aqQueue.push({ peerId, name, conn });
  if (!S.aqShowing) showNextApproval();
}

function showNextApproval() {
  if (S.aqQueue.length === 0) {
    D.aqWrap.style.display = 'none';
    S.aqShowing = false;
    return;
  }
  S.aqShowing = true;
  const next = S.aqQueue[0];
  D.aqName.textContent = next.name;
  D.aqWrap.style.display = 'block';
  // Show count of remaining
  const waiting = S.aqQueue.length - 1;
  if (waiting > 0) {
    D.aqCountRow.style.display = 'flex';
    D.aqPendingCount.textContent = waiting;
  } else {
    D.aqCountRow.style.display = 'none';
  }
  beep(880, .08, .2);
}

function processApproval(approved) {
  if (S.aqQueue.length === 0) return;
  const req = S.aqQueue.shift();
  const { peerId, name, conn } = req;

  if (approved) {
    // Mark as approved
    const guest = S.guests.get(peerId);
    if (guest) {
      guest.approved = true;
      guest.name = name;
    }
    // Send approval + current participants list
    const pList = buildParticipantsList();
    try {
      conn.send(JSON.stringify({
        type: 'approved',
        hostName: S.myName,
        participants: pList
      }));
    } catch (_) {}

    // Add to participants
    addParticipant({ peerId, name, isHost: false });

    // Broadcast new participant to existing guests
    broadcastToGuests({
      type: 'peer_joined',
      peerId,
      name
    }, peerId);

    sysMsg(`${name} joined the room`);
    toast(`✅ ${name} joined`, 'ok');
    beep(660, .12, .2);
  } else {
    // Reject
    try { conn.send(JSON.stringify({ type: 'rejected', reason: 'Host declined your request.' })); } catch (_) {}
    S.guests.delete(peerId);
    toast(`❌ ${name} was rejected`, '');
  }

  showNextApproval();
}

/* ──────────────────────────────────────────
   14. PARTICIPANT LIST MANAGEMENT
────────────────────────────────────────── */
function buildParticipantsList() {
  // Returns array of all current approved participants
  const list = [{ peerId: S.peer.id, name: S.myName, isHost: S.isHost }];
  if (S.isHost) {
    S.guests.forEach((g, pid) => {
      if (g.approved) list.push({ peerId: pid, name: g.name, isHost: false });
    });
  }
  return list;
}

function addParticipant(p) {
  if (!S.participants.find(x => x.peerId === p.peerId)) {
    S.participants.push(p);
  }
  buildParticipants();
}

function removeParticipant(peerId) {
  S.participants = S.participants.filter(p => p.peerId !== peerId);
  S.guests.delete(peerId);
  buildParticipants();
}

/* ──────────────────────────────────────────
   15. MESSAGING — HOST RELAY
────────────────────────────────────────── */

/* Broadcast raw JSON string to all approved guests, optionally excluding one */
function broadcastToGuests(obj, excludePeerId = null) {
  const str = JSON.stringify(obj);
  S.guests.forEach((g, pid) => {
    if (g.approved && g.conn.open && pid !== excludePeerId) {
      try { g.conn.send(str); } catch (_) {}
    }
  });
}

/* Send a message as host (to all guests) */
function hostSendMsg(content) {
  const msg = {
    type: 'text',
    id:   genId(12),
    fromPeerId:  S.peer.id,
    senderName:  S.myName,
    content:     encrypt(content),
    ts:          Date.now()
  };
  broadcastToGuests({ type: 'msg_relay', ...msg });
  renderMsg({ ...msg, content }); // show plaintext locally
  addMsg({ ...msg, content });
}

/* Guest sends message to host */
function guestSendMsg(content) {
  if (!S.hostConn?.open) return;
  const msg = {
    type: 'msg',
    id:   genId(12),
    fromPeerId: S.peer.id,
    senderName: S.myName,
    content: encrypt(content),
    ts: Date.now()
  };
  try {
    S.hostConn.send(JSON.stringify(msg));
    renderMsg({ ...msg, content });  // show locally
    addMsg({ ...msg, content });
  } catch (_) { toast('Send failed.', 'err'); }
}

function sendTextMessage() {
  const text = D.msgInput.value.trim();
  if (!text) return;
  D.msgInput.value = '';
  D.msgInput.style.height = 'auto';
  clearTimeout(S.typingTimer);
  S.isTyping = false;
  sendTypingSignal(false);
  if (S.isHost) hostSendMsg(text);
  else guestSendMsg(text);
}

/* ──────────────────────────────────────────
   16. TYPING INDICATOR
────────────────────────────────────────── */
function sendTypingSignal(active) {
  const obj = JSON.stringify({ type: 'typing', active, fromPeerId: S.peer.id, senderName: S.myName });
  if (S.isHost) {
    broadcastToGuests({ type: 'typing_relay', active, fromPeerId: S.peer.id, senderName: S.myName });
  } else {
    if (S.hostConn?.open) try { S.hostConn.send(obj); } catch (_) {}
  }
}

function onTypingInput() {
  const now = Date.now();
  if (!S.isTyping || now - S.lastTypingAt > CFG.TYPING_SEND) {
    S.isTyping = true;
    S.lastTypingAt = now;
    sendTypingSignal(true);
  }
  clearTimeout(S.typingTimer);
  S.typingTimer = setTimeout(() => { S.isTyping = false; sendTypingSignal(false); }, CFG.TYPING_STOP);
}

function updateTypingUI() {
  const names = [];
  S.typingPeers.forEach(pid => {
    const p = S.participants.find(x => x.peerId === pid);
    names.push(p?.name || 'Someone');
  });
  if (names.length === 0) {
    D.typingRow.style.display = 'none';
  } else {
    D.typingRow.style.display = 'flex';
    D.typingLabel.textContent = names.join(', ') + (names.length === 1 ? ' is typing…' : ' are typing…');
    scrollBottom();
  }
}

/* ──────────────────────────────────────────
   17. FILE SHARING — CHUNKED
────────────────────────────────────────── */
function sendFileToAll(file) {
  if (file.size > 150 * 1024 * 1024) { toast('Max file size is 150 MB.', 'err'); return; }
  const fileId = genId(12);
  const reader = new FileReader();
  reader.onload = async e => {
    const buf = e.target.result;
    const total = Math.ceil(buf.byteLength / CFG.CHUNK_SIZE);
    D.xferWrap.style.display = 'flex';
    D.xferFill.style.width = '0%';
    D.xferLabel.textContent = `Sending "${file.name}"… 0%`;

    for (let i = 0; i < total; i++) {
      const start = i * CFG.CHUNK_SIZE;
      const chunk = ab2b64(buf.slice(start, start + CFG.CHUNK_SIZE));
      const pkt = {
        type: 'file_chunk',
        fileId, index: i, total,
        name: file.name, mimeType: file.type, size: buf.byteLength, chunk
      };
      const str = JSON.stringify(pkt);
      try {
        if (S.isHost) broadcastToGuests(JSON.parse(str));
        else if (S.hostConn?.open) S.hostConn.send(str);
      } catch { D.xferWrap.style.display = 'none'; toast('File send failed.', 'err'); return; }

      const pct = Math.round(((i + 1) / total) * 100);
      D.xferFill.style.width = pct + '%';
      D.xferLabel.textContent = `Sending "${file.name}"… ${pct}%`;
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }

    setTimeout(() => { D.xferWrap.style.display = 'none'; }, 800);

    const blob = new Blob([buf], { type: file.type });
    const dataUrl = URL.createObjectURL(blob);
    const msgObj = {
      type: file.type.startsWith('image/') ? 'image' : 'file',
      id: fileId, fileName: file.name, mimeType: file.type,
      fileSize: file.size, dataUrl,
      fromPeerId: S.peer.id, senderName: S.myName,
      ts: Date.now()
    };
    renderMsg(msgObj);
    addMsg({ ...msgObj, dataUrl: '' });
  };
  reader.readAsArrayBuffer(file);
}

function receiveChunk(pkt) {
  const { fileId, index, total, name, mimeType, size, chunk, fromPeerId, senderName } = pkt;
  if (!S.fileIncoming[fileId]) {
    S.fileIncoming[fileId] = { chunks: new Array(total).fill(null), total, received: 0, name, mimeType, size, fromPeerId, senderName };
  }
  const fi = S.fileIncoming[fileId];
  fi.chunks[index] = b642ab(chunk);
  fi.received++;

  const pct = Math.round((fi.received / fi.total) * 100);
  D.xferWrap.style.display = 'flex';
  D.xferFill.style.width = pct + '%';
  D.xferLabel.textContent = `Receiving "${name}"… ${pct}%`;

  if (fi.received === fi.total) {
    const dataUrl = URL.createObjectURL(new Blob(fi.chunks, { type: fi.mimeType }));
    delete S.fileIncoming[fileId];
    setTimeout(() => { D.xferWrap.style.display = 'none'; }, 800);
    beep(1100, .08, .18);
    const msgObj = {
      type: fi.mimeType.startsWith('image/') ? 'image' : 'file',
      id: fileId, fileName: fi.name, mimeType: fi.mimeType,
      fileSize: fi.size, dataUrl,
      fromPeerId: fi.fromPeerId || 'unknown',
      senderName: fi.senderName || peerName(fi.fromPeerId),
      ts: Date.now()
    };
    renderMsg(msgObj);
    addMsg({ ...msgObj, dataUrl: '' });
  }
}

/* ──────────────────────────────────────────
   18. DATA HANDLER — HOST
────────────────────────────────────────── */
function onHostData(fromPeerId, raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const guest = S.guests.get(fromPeerId);

  switch (data.type) {
    case 'join_request':
      if (!guest) return;
      if (S.requireApproval) {
        enqueueApproval(fromPeerId, data.name, guest.conn);
      } else {
        // Auto-approve
        guest.approved = true;
        guest.name = data.name;
        const pList = buildParticipantsList();
        try { guest.conn.send(JSON.stringify({ type: 'approved', hostName: S.myName, participants: pList })); } catch (_) {}
        addParticipant({ peerId: fromPeerId, name: data.name, isHost: false });
        broadcastToGuests({ type: 'peer_joined', peerId: fromPeerId, name: data.name }, fromPeerId);
        sysMsg(`${data.name} joined the room`);
        toast(`✅ ${data.name} joined`, 'ok');
        beep(660, .12, .2);
      }
      break;

    case 'msg':
      if (!guest?.approved) return;
      const plain = decrypt(data.content);
      // Show in host's UI
      renderMsg({ type: 'text', id: data.id, content: plain, fromPeerId, senderName: guest.name, ts: data.ts });
      addMsg({ type: 'text', id: data.id, content: plain, fromPeerId, senderName: guest.name, ts: data.ts });
      beep(880, .07, .18);
      // Relay to all other guests
      broadcastToGuests({ type: 'msg_relay', id: data.id, content: data.content, fromPeerId, senderName: guest.name, ts: data.ts }, fromPeerId);
      break;

    case 'typing':
      if (!guest?.approved) return;
      // Relay to other guests
      broadcastToGuests({ type: 'typing_relay', active: data.active, fromPeerId, senderName: guest.name }, fromPeerId);
      if (data.active) { S.typingPeers.add(fromPeerId); } else { S.typingPeers.delete(fromPeerId); }
      updateTypingUI();
      break;

    case 'file_chunk':
      if (!guest?.approved) return;
      // Add sender info and relay
      const relayPkt = { ...data, fromPeerId, senderName: guest.name };
      broadcastToGuests(relayPkt, fromPeerId);
      receiveChunk(relayPkt);
      break;

    case 'call_type':
      // Guest is about to call someone directly — no relay needed (direct P2P call)
      break;
  }
}

/* ──────────────────────────────────────────
   19. DATA HANDLER — GUEST
────────────────────────────────────────── */
function onGuestData(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  switch (data.type) {
    case 'approved':
      // We're in! Build participant list and enter chat
      S.participants = data.participants || [];
      // Make sure we're in the list
      if (!S.participants.find(p => p.peerId === S.peer.id)) {
        S.participants.push({ peerId: S.peer.id, name: S.myName, isHost: false });
      }
      hideLoad();
      showScreen('chat');
      enableChat();
      buildParticipants();
      setStatus('connected', 'Connected · ' + (S.participants.length) + ' online');
      // Load history
      _msgs = LS.load();
      _msgs.forEach(renderMsg);
      sysMsg(`You joined the room (${S.participants.length} online)`);
      toast('🔒 Joined secure room!', 'ok');
      beep(660, .12, .2);
      break;

    case 'rejected':
      hideLoad();
      showError('Request Rejected', data.reason || 'The host declined your join request.');
      break;

    case 'kicked':
      showError('Removed', 'You were removed from the room by the host.');
      cleanupAll();
      break;

    case 'room_full':
      hideLoad();
      showError('Room Full', 'Could not join: the host\'s room is unavailable.');
      break;

    case 'msg_relay':
      const plain = decrypt(data.content);
      renderMsg({ type: 'text', id: data.id, content: plain, fromPeerId: data.fromPeerId, senderName: data.senderName, ts: data.ts });
      addMsg({ type: 'text', id: data.id, content: plain, fromPeerId: data.fromPeerId, senderName: data.senderName, ts: data.ts });
      beep(880, .07, .18);
      break;

    case 'typing_relay':
      if (data.active) { S.typingPeers.add(data.fromPeerId); } else { S.typingPeers.delete(data.fromPeerId); }
      updateTypingUI();
      break;

    case 'file_chunk':
      receiveChunk(data);
      break;

    case 'peer_joined':
      if (!S.participants.find(p => p.peerId === data.peerId)) {
        S.participants.push({ peerId: data.peerId, name: data.name, isHost: false });
      }
      buildParticipants();
      setStatus('connected', 'Connected · ' + S.participants.length + ' online');
      sysMsg(`${data.name} joined`);
      break;

    case 'peer_left':
      removeParticipant(data.peerId);
      setStatus('connected', 'Connected · ' + S.participants.length + ' online');
      sysMsg(`${data.name} left`);
      break;
  }
}

/* ──────────────────────────────────────────
   20. CONNECTION SETUP
────────────────────────────────────────── */

/* Host accepts incoming connection */
function handleIncomingConnection(conn) {
  const peerId = conn.peer;

  // Store connection (not yet approved)
  S.guests.set(peerId, { conn, name: '?', approved: false });

  conn.on('open', () => {
    // Waiting for join_request message
  });

  conn.on('data', raw => onHostData(peerId, raw));

  conn.on('close', () => {
    const g = S.guests.get(peerId);
    if (g?.approved) {
      const name = g.name;
      removeParticipant(peerId);
      broadcastToGuests({ type: 'peer_left', peerId, name });
      setStatus('connected', 'Connected · ' + S.participants.length + ' online');
      sysMsg(`${name} disconnected`);
      toast(`${name} left`, '');
    } else {
      S.guests.delete(peerId);
      // Remove from approval queue if pending
      S.aqQueue = S.aqQueue.filter(r => r.peerId !== peerId);
      if (S.aqShowing && S.aqQueue.length === 0 && S.aqWrap.style.display !== 'none') {
        const showing = D.aqName.textContent;
        if (showing === '?' || !S.guests.has(peerId)) showNextApproval();
      }
    }
    S.typingPeers.delete(peerId);
    updateTypingUI();
  });

  conn.on('error', err => console.warn('[Conn error]', err));
}

/* Guest connects to host */
function connectAsGuest(roomId) {
  const hostPeerId = CFG.PREFIX + roomId;
  setStatus('connecting', 'Connecting…');

  const conn = S.peer.connect(hostPeerId, { reliable: true });
  S.hostConn = conn;

  const timeout = setTimeout(() => {
    if (!conn.open) {
      hideLoad();
      showError('Connection Timeout', 'Could not reach the host. They may be offline.');
    }
  }, CFG.CONNECT_TO);

  conn.on('open', () => {
    clearTimeout(timeout);
    // Send join request
    conn.send(JSON.stringify({ type: 'join_request', name: S.myName, peerId: S.peer.id }));
    // Show waiting screen
    hideLoad();
    D.waitName.textContent = S.myName;
    showScreen('waiting');
  });

  conn.on('data', onGuestData);

  conn.on('close', () => {
    if (document.getElementById('screen-chat').classList.contains('active')) {
      setStatus('error', 'Disconnected from host');
      disableChat();
      sysMsg('Connection to host lost');
      toast('Disconnected from host.', 'err');
    }
  });

  conn.on('error', () => {
    hideLoad();
    showError('Connection Failed', 'Could not connect to the host. The room may not exist.');
  });
}

/* ──────────────────────────────────────────
   21. PEER INIT — HOST
────────────────────────────────────────── */
function initHost(roomId) {
  const peerId = CFG.PREFIX + roomId;
  showLoad('Creating secure room…');

  const peer = new Peer(peerId, { config: { iceServers: CFG.ICE, iceTransportPolicy: 'all' } });
  S.peer = peer;

  peer.on('open', id => {
    S.roomId = roomId;
    S.encKey = deriveKey(roomId);
    S.isHost = true;
    S.retryCount = 0;
    LS.setRole('host');
    LS.setMyId(id);

    // Build own participant entry
    S.participants = [{ peerId: id, name: S.myName, isHost: true }];
    buildParticipants();

    // Load chat history
    _msgs = LS.load();
    _msgs.forEach(renderMsg);

    hideLoad();
    showScreen('chat');
    enableChat();
    setStatus('connected', 'Room ready · Waiting for guests');
    showShareBanner(roomId);
    D.shareBanner.style.display = 'block';
  });

  peer.on('connection', handleIncomingConnection);

  peer.on('call', call => {
    S.pendingCall = call;
    S.pendingCallVideo = call.metadata?.videoEnabled !== false;
    const callerName = peerName(call.peer) || 'Unknown';
    D.icCallerName.textContent = 'from ' + callerName;
    D.icType.textContent = S.pendingCallVideo ? 'Video' : 'Voice';
    D.icOverlay.style.display = 'flex';
    ringBeep();
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id' && S.retryCount < 5) {
      S.retryCount++;
      showLoad(`Reconnecting… (${S.retryCount}/5)`);
      setTimeout(() => initHost(roomId), 5000);
    } else if (err.type === 'unavailable-id') {
      showError('Room Unavailable', 'Could not reclaim this room. Please create a new one.');
    } else {
      console.warn('[Host PeerJS]', err.type, err.message);
    }
  });

  peer.on('disconnected', () => {
    if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (_) {} }, 3000);
  });
}

/* ──────────────────────────────────────────
   22. PEER INIT — GUEST
────────────────────────────────────────── */
function initGuest(roomId) {
  // Reuse stored peer ID if available (reconnect stability)
  let myPeerId = LS.getMyId();
  if (!myPeerId || myPeerId === CFG.PREFIX + roomId) {
    myPeerId = CFG.PREFIX + roomId + '-g-' + genId(8);
    LS.setMyId(myPeerId);
  }

  showLoad('Connecting…');

  const peer = new Peer(myPeerId, { config: { iceServers: CFG.ICE, iceTransportPolicy: 'all' } });
  S.peer = peer;

  peer.on('open', () => {
    S.roomId = roomId;
    S.encKey = deriveKey(roomId);
    S.isHost = false;
    LS.setRole('guest');
    connectAsGuest(roomId);
  });

  peer.on('call', call => {
    S.pendingCall = call;
    S.pendingCallVideo = call.metadata?.videoEnabled !== false;
    const callerName = peerName(call.peer) || 'Unknown';
    D.icCallerName.textContent = 'from ' + callerName;
    D.icType.textContent = S.pendingCallVideo ? 'Video' : 'Voice';
    D.icOverlay.style.display = 'flex';
    ringBeep();
  });

  peer.on('error', err => {
    hideLoad();
    if (err.type === 'peer-unavailable') {
      showError('Host Not Found', 'The room doesn\'t exist or the host went offline.');
    } else if (err.type === 'unavailable-id') {
      LS.setMyId('');
      initGuest(roomId);
    } else {
      showError('Error', err.message || 'Connection failed.');
    }
  });

  peer.on('disconnected', () => {
    if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (_) {} }, 3000);
  });
}

/* ──────────────────────────────────────────
   23. CALLS
────────────────────────────────────────── */
async function startCallToPeer(targetPeerId, videoEnabled) {
  if (!S.peer) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: videoEnabled ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch { toast('Camera/mic permission denied.', 'err'); return; }

  S.localStream = stream;
  S.micOn = true;
  S.camOn = videoEnabled;
  D.localVid.srcObject = stream;
  D.videoArea.style.display = 'block';
  updateVidBtns();

  const calleeName = peerName(targetPeerId);
  D.callPeerInfo.textContent = `Calling ${calleeName}…`;

  const call = S.peer.call(targetPeerId, stream, {
    metadata: { videoEnabled, callerName: S.myName }
  });
  if (!call) { cleanupCall(); toast('Call failed.', 'err'); return; }
  S.activeCall = call;
  setStatus('calling', 'In call with ' + calleeName);

  call.on('stream', remote => {
    D.remoteVid.srcObject = remote;
    D.callPeerInfo.textContent = calleeName;
  });
  call.on('close', () => { cleanupCall(); sysMsg('Call ended'); });
  call.on('error', err => { cleanupCall(); toast('Call error: ' + err.message, 'err'); });
}

async function acceptCall() {
  if (!S.pendingCall) return;
  const call = S.pendingCall;
  S.pendingCall = null;
  D.icOverlay.style.display = 'none';

  const videoEnabled = S.pendingCallVideo;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: videoEnabled ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch { toast('Permission denied.', 'err'); call.close(); return; }

  S.localStream = stream;
  S.micOn = true; S.camOn = videoEnabled;
  D.localVid.srcObject = stream;
  D.videoArea.style.display = 'block';
  updateVidBtns();

  const callerName = peerName(call.peer);
  D.callPeerInfo.textContent = callerName;
  call.answer(stream);
  S.activeCall = call;
  setStatus('calling', 'In call with ' + callerName);

  call.on('stream', remote => { D.remoteVid.srcObject = remote; });
  call.on('close', () => { cleanupCall(); sysMsg('Call ended'); });
  call.on('error', err => { cleanupCall(); toast('Call error: ' + err.message, 'err'); });
}

function declineCall() {
  if (S.pendingCall) { try { S.pendingCall.close(); } catch (_) {} S.pendingCall = null; }
  D.icOverlay.style.display = 'none';
}

function endCall() {
  if (S.activeCall) { try { S.activeCall.close(); } catch (_) {} }
  cleanupCall();
  sysMsg('Call ended');
}

function cleanupCall() {
  if (S.localStream) { S.localStream.getTracks().forEach(t => t.stop()); S.localStream = null; }
  if (S.activeCall) { try { S.activeCall.close(); } catch (_) {} S.activeCall = null; }
  D.remoteVid.srcObject = null;
  D.localVid.srcObject = null;
  D.videoArea.style.display = 'none';
  D.icOverlay.style.display = 'none';
  S.pendingCall = null;
  S.micOn = true; S.camOn = true;
  const cnt = S.participants.length;
  setStatus('connected', cnt > 0 ? 'Connected · ' + cnt + ' online' : 'Room ready');
}

function toggleMic() {
  if (!S.localStream) return;
  S.micOn = !S.micOn;
  S.localStream.getAudioTracks().forEach(t => { t.enabled = S.micOn; });
  updateVidBtns();
}

function toggleCam() {
  if (!S.localStream) return;
  S.camOn = !S.camOn;
  S.localStream.getVideoTracks().forEach(t => { t.enabled = S.camOn; });
  updateVidBtns();
}

function updateVidBtns() {
  D.btnTogMic.className = 'vbtn ' + (S.micOn ? 'active' : 'muted');
  D.btnTogMic.innerHTML = `<i class="fas fa-microphone${S.micOn ? '' : '-slash'}"></i>`;
  D.btnTogCam.className = 'vbtn ' + (S.camOn ? 'active' : 'muted');
  D.btnTogCam.innerHTML = `<i class="fas fa-video${S.camOn ? '' : '-slash'}"></i>`;
}

/* Header call buttons — open target picker if multiple peers, else call directly */
function headerCall(videoEnabled) {
  const others = S.participants.filter(p => p.peerId !== S.peer?.id);
  if (others.length === 0) { toast('No one to call yet.', 'warn'); return; }
  if (others.length === 1) { startCallToPeer(others[0].peerId, videoEnabled); return; }

  // Show picker modal
  D.ctCallTypeLabel.textContent = `Choose who to ${videoEnabled ? 'video' : 'voice'} call:`;
  D.ctList.innerHTML = '';
  others.forEach(p => {
    const div = document.createElement('div');
    div.className = 'ct-item';
    div.innerHTML = `<div class="ct-avi">${nameInitial(p.name)}</div><div class="ct-name">${escHtml(p.name)}</div>`;
    div.onclick = () => {
      D.modalCallTarget.style.display = 'none';
      startCallToPeer(p.peerId, videoEnabled);
    };
    D.ctList.appendChild(div);
  });
  D.modalCallTarget.style.display = 'flex';
}

/* ──────────────────────────────────────────
   24. SHARE BANNER
────────────────────────────────────────── */
function showShareBanner(roomId) {
  const url = location.origin + location.pathname + '?room=' + roomId;
  D.shareInput.value = url;
  D.shareBanner.style.display = 'block';
  // Show native share button if available
  if (navigator.share) D.btnShare.style.display = 'flex';
}

function copyLink() {
  const url = D.shareInput.value;
  navigator.clipboard.writeText(url).then(() => {
    D.btnCopy.classList.add('copied');
    D.btnCopy.innerHTML = '<i class="fas fa-check"></i><span>Copied!</span>';
    setTimeout(() => { D.btnCopy.classList.remove('copied'); D.btnCopy.innerHTML = '<i class="fas fa-copy"></i><span>Copy</span>'; }, 2500);
    toast('Link copied!', 'ok');
  }).catch(() => { D.shareInput.select(); document.execCommand('copy'); toast('Copied!', 'ok'); });
}

/* ──────────────────────────────────────────
   25. DESTROY / CLEANUP
────────────────────────────────────────── */
function cleanupAll() {
  cleanupCall();
  S.guests.forEach(g => { try { g.conn.close(); } catch (_) {} });
  if (S.hostConn) { try { S.hostConn.close(); } catch (_) {} }
  if (S.peer && !S.peer.destroyed) { try { S.peer.destroy(); } catch (_) {} }
}

function destroyRoom() {
  cleanupAll();
  LS.wipe();
  window.location.href = location.pathname;
}

/* ──────────────────────────────────────────
   26. UI ENABLE/DISABLE
────────────────────────────────────────── */
function enableChat() {
  D.msgInput.disabled = false;
  D.btnSend.disabled = false;
  D.msgInput.focus();
}

function disableChat() {
  D.msgInput.disabled = true;
  D.btnSend.disabled = true;
  D.btnAudioCall.disabled = true;
  D.btnVideoCall.disabled = true;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/* ──────────────────────────────────────────
   27. INIT
────────────────────────────────────────── */
function init() {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');

  if (roomId) {
    // Validate
    if (!/^[a-z0-9]{6,20}$/.test(roomId)) {
      showError('Invalid Link', 'This link is malformed or has expired.');
      return;
    }
    // Guest mode — show join UI
    D.hostOptions.style.display = 'none';
    D.btnCreate.style.display = 'none';
    D.btnJoin.style.display = 'flex';
    D.joinBanner.style.display = 'flex';
    D.joinRoomId.textContent = roomId;

    // Auto-fill saved name
    const savedName = localStorage.getItem('sp2p_name');
    if (savedName) D.nameInput.value = savedName;

    D.btnJoin.onclick = () => {
      const name = D.nameInput.value.trim();
      if (!name) { D.nameInput.focus(); toast('Please enter your name.', 'warn'); return; }
      localStorage.setItem('sp2p_name', name);
      S.myName = name;
      initGuest(roomId);
    };
  } else {
    // Host mode — no ?room= in URL
    D.hostOptions.style.display = 'flex';
    D.btnCreate.style.display = 'flex';
    D.btnJoin.style.display = 'none';
    D.joinBanner.style.display = 'none';

    // Auto-fill saved name
    const savedName = localStorage.getItem('sp2p_name');
    if (savedName) D.nameInput.value = savedName;

    D.btnCreate.onclick = () => {
      const name = D.nameInput.value.trim();
      if (!name) { D.nameInput.focus(); toast('Please enter your name.', 'warn'); return; }
      localStorage.setItem('sp2p_name', name);
      S.myName = name;
      S.requireApproval = D.approvalToggle.checked;
      const newRoomId = genId(10);
      // Navigate to room URL with host flag
      window.location.href = `${location.pathname}?room=${newRoomId}&host=1`;
    };
  }
}

/* ── STARTUP ── */
(function startup() {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const isHostFlag = params.get('host') === '1';

  if (isHostFlag && roomId && /^[a-z0-9]{6,20}$/.test(roomId)) {
    // Returning/direct host — skip setup screen, go straight to room
    const savedName = localStorage.getItem('sp2p_name') || 'Host';
    S.myName = savedName;
    S.requireApproval = true;
    initHost(roomId);
  } else {
    // Normal init — show setup screen
    init();
  }
})();

/* ──────────────────────────────────────────
   28. EVENT LISTENERS
────────────────────────────────────────── */

// Enter key in name field triggers button
D.nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const btn = D.btnJoin.style.display !== 'none' ? D.btnJoin : D.btnCreate;
    if (btn.style.display !== 'none') btn.click();
  }
});

// Cancel waiting screen
D.btnCancelWait.addEventListener('click', () => {
  if (S.hostConn) { try { S.hostConn.close(); } catch (_) {} }
  if (S.peer && !S.peer.destroyed) { try { S.peer.destroy(); } catch (_) {} }
  window.location.href = location.pathname;
});

// Approval queue
D.btnApprove.addEventListener('click', () => processApproval(true));
D.btnReject.addEventListener('click', () => processApproval(false));

// Copy link
D.btnCopy.addEventListener('click', copyLink);

// Native share
D.btnShare.addEventListener('click', () => {
  navigator.share({ title: 'Join my Secure P2P Room', url: D.shareInput.value });
});

// Participants panel
D.btnParticipants.addEventListener('click', () => {
  if (D.pPanel.classList.contains('open')) closePanel();
  else openPanel();
});
D.btnClosePanel.addEventListener('click', closePanel);
D.panelOverlay.addEventListener('click', closePanel);

// Call buttons (header)
D.btnAudioCall.addEventListener('click', () => headerCall(false));
D.btnVideoCall.addEventListener('click', () => headerCall(true));

// Destroy
D.btnDestroy.addEventListener('click', () => { D.modalDestroy.style.display = 'flex'; });
D.mdCancel.addEventListener('click', () => { D.modalDestroy.style.display = 'none'; });
D.mdConfirm.addEventListener('click', () => { D.modalDestroy.style.display = 'none'; destroyRoom(); });
D.modalDestroy.addEventListener('click', e => { if (e.target === D.modalDestroy) D.modalDestroy.style.display = 'none'; });

// Call target modal
D.ctCancel.addEventListener('click', () => { D.modalCallTarget.style.display = 'none'; });
D.modalCallTarget.addEventListener('click', e => { if (e.target === D.modalCallTarget) D.modalCallTarget.style.display = 'none'; });

// Video controls
D.btnTogMic.addEventListener('click', toggleMic);
D.btnTogCam.addEventListener('click', toggleCam);
D.btnEndCall.addEventListener('click', endCall);

// Incoming call
D.btnAccept.addEventListener('click', acceptCall);
D.btnDecline.addEventListener('click', declineCall);

// Send message
D.btnSend.addEventListener('click', sendTextMessage);
D.msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});
D.msgInput.addEventListener('input', () => {
  autoResize(D.msgInput);
  if (!D.msgInput.disabled) onTypingInput();
});

// File input
D.fileInput.addEventListener('change', () => {
  const file = D.fileInput.files[0];
  if (!file) return;
  if (!S.peer) { toast('Not connected.', 'err'); return; }
  sendFileToAll(file);
  D.fileInput.value = '';
});

// Prevent double-tap zoom (iOS)
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
