'use strict';

/* ═══════════════════════════════════════════════════════════
   SECURE P2P CHAT & CALL — script.js
   Copyright Owner: Muhammad Shourov
   Architecture: WebRTC (PeerJS) + AES-256 (CryptoJS)
   Features: TURN servers, File Chunking, Auto-prune Storage
═══════════════════════════════════════════════════════════ */

/* ──────────────────────────────────────────
   1. CONFIGURATION
────────────────────────────────────────── */
const CFG = {
  // ICE = STUN (free) + TURN (OpenRelay — free, no signup required)
  ICE: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    {                                                    // TURN via UDP on port 80
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {                                                    // TURN via UDP/TCP on port 443
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {                                                    // TURN via TLS on port 443 (works through strict firewalls)
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  MAX_MSGS:      50,      // Auto-prune: keep last 50 messages in localStorage
  CHUNK_SIZE:    16384,   // 16 KB — safe WebRTC DataChannel chunk size
  TYPING_STOP:   2500,    // ms before "stopped typing" signal fires
  TYPING_SEND:   1500,    // ms minimum between consecutive typing signals
  RETRY_DELAY:   6000,    // ms to wait before retrying a taken Peer ID
  PREFIX:        'srp2p-' // Prefix for PeerJS IDs
};

/* ──────────────────────────────────────────
   2. APP STATE
────────────────────────────────────────── */
const S = {
  peer:          null,   // PeerJS instance
  conn:          null,   // DataConnection
  call:          null,   // MediaConnection (active call)
  pendingCall:   null,   // Incoming call object waiting for answer
  localStream:   null,   // Our camera/mic stream
  roomId:        null,   // Room identifier from URL
  encKey:        null,   // AES encryption key (derived from roomId)
  isHost:        false,  // true = created the room
  guestConn:     false,  // Host flag: is a guest already connected?
  guestPeerId:   null,   // Guest's peer ID (tracked by host)
  micOn:         true,
  camOn:         true,
  pendingCallVideo: false, // was the incoming call a video call?
  typingTimer:   null,
  lastTypingAt:  0,
  isTyping:      false,
  fileIncoming:  {},     // { fileId: { chunks:[], total, name, mimeType, size, received } }
  retryCount:    0
};

/* ──────────────────────────────────────────
   3. DOM REFERENCES
────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const DOM = {
  // Screens
  sSetup:   $('screen-setup'),
  sChat:    $('screen-chat'),
  sError:   $('screen-error'),
  loading:  $('loading-overlay'),
  loadTxt:  $('loading-text'),

  // Setup
  btnCreate: $('btn-create-room'),

  // Header
  statusDot: $('status-dot'),
  statusTxt: $('status-text'),
  btnAudioCall: $('btn-audio-call'),
  btnVideoCall: $('btn-video-call'),
  btnDestroy:   $('btn-destroy'),

  // Share banner
  shareBanner:  $('share-banner'),
  shareLinkIn:  $('share-link-input'),
  btnCopy:      $('btn-copy-link'),

  // Video
  videoArea:   $('video-area'),
  remoteVid:   $('remote-video'),
  localVid:    $('local-video'),
  btnTogMic:   $('btn-toggle-mic'),
  btnTogCam:   $('btn-toggle-cam'),
  btnEndCall:  $('btn-end-call'),

  // Incoming call
  incOverlay: $('incoming-call-overlay'),
  icTypeLabel: $('ic-type-label'),
  btnAccept:  $('btn-accept-call'),
  btnDecline: $('btn-decline-call'),

  // Messages
  msgArea:   $('messages-area'),
  msgList:   $('messages-list'),
  typing:    $('typing-indicator'),

  // File transfer progress
  xferWrap:  $('xfer-progress-wrap'),
  xferFill:  $('xfer-bar-fill'),
  xferLabel: $('xfer-label'),

  // Input
  fileInput: $('file-input'),
  msgInput:  $('msg-input'),
  btnSend:   $('btn-send'),

  // Error screen
  errTitle: $('err-title'),
  errMsg:   $('err-msg'),

  // Confirm modal
  confirmModal:   $('confirm-modal'),
  modalCancel:    $('modal-cancel'),
  modalConfirm:   $('modal-confirm')
};

/* ──────────────────────────────────────────
   4. UTILITIES
────────────────────────────────────────── */

/** Generate random alphanumeric string */
function genId(len = 10) {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36])
    .join('');
}

/** Format timestamp to HH:MM */
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Format bytes to human readable */
function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Get file type icon (FontAwesome class) */
function fileIcon(mimeType) {
  if (!mimeType) return 'fa-file';
  if (mimeType.startsWith('image/'))       return 'fa-file-image';
  if (mimeType.startsWith('video/'))       return 'fa-file-video';
  if (mimeType.startsWith('audio/'))       return 'fa-file-audio';
  if (mimeType.includes('pdf'))            return 'fa-file-pdf';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return 'fa-file-zipper';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'fa-file-word';
  if (mimeType.includes('sheet') || mimeType.includes('excel'))   return 'fa-file-excel';
  if (mimeType.includes('text')) return 'fa-file-lines';
  return 'fa-file';
}

/** Scroll messages to bottom */
function scrollBottom() {
  DOM.msgArea.scrollTo({ top: DOM.msgArea.scrollHeight, behavior: 'smooth' });
}

/** ArrayBuffer to Base64 */
function ab2b64(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (let b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

/** Base64 to ArrayBuffer */
function b642ab(b64) {
  const str = atob(b64);
  const buf = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i);
  return buf;
}

/* ──────────────────────────────────────────
   5. CRYPTO — AES-256 Encryption
────────────────────────────────────────── */

/** Derive AES key from roomId (SHA-256 hash) */
function deriveKey(roomId) {
  return CryptoJS.SHA256('srp2p-v1-' + roomId).toString();
}

/** Encrypt plaintext string → ciphertext string */
function encrypt(text) {
  if (!S.encKey) return text;
  return CryptoJS.AES.encrypt(text, S.encKey).toString();
}

/** Decrypt ciphertext string → plaintext string */
function decrypt(cipher) {
  if (!S.encKey) return cipher;
  try {
    const bytes = CryptoJS.AES.decrypt(cipher, S.encKey);
    const result = bytes.toString(CryptoJS.enc.Utf8);
    return result || cipher; // fallback if decrypt fails
  } catch {
    return cipher;
  }
}

/* ──────────────────────────────────────────
   6. STORAGE — LocalStorage with auto-prune
────────────────────────────────────────── */

const LS = {
  key: {
    role:   r => `srp2p_role_${r}`,
    msgs:   r => `srp2p_msgs_${r}`,
    guest:  r => `srp2p_gpid_${r}`   // guest's peer ID
  },

  /** Save messages (encrypted, last MAX_MSGS only) */
  saveMsgs(msgs) {
    const roomId = S.roomId;
    if (!roomId) return;
    // Prune to last MAX_MSGS
    const pruned = msgs.slice(-CFG.MAX_MSGS);
    try {
      // Encrypt the entire JSON blob
      const plain = JSON.stringify(pruned);
      const cipher = encrypt(plain);
      localStorage.setItem(LS.key.msgs(roomId), cipher);
    } catch (e) {
      // If quota exceeded, drop oldest messages and retry
      if (e.name === 'QuotaExceededError') {
        const fewer = msgs.slice(-Math.floor(CFG.MAX_MSGS / 2));
        try {
          localStorage.setItem(LS.key.msgs(roomId), encrypt(JSON.stringify(fewer)));
        } catch (_) {
          localStorage.removeItem(LS.key.msgs(roomId)); // nuclear fallback
        }
      }
    }
  },

  /** Load and decrypt messages */
  loadMsgs() {
    const roomId = S.roomId;
    if (!roomId) return [];
    try {
      const cipher = localStorage.getItem(LS.key.msgs(roomId));
      if (!cipher) return [];
      const plain = decrypt(cipher);
      return JSON.parse(plain) || [];
    } catch {
      return [];
    }
  },

  /** Store role for reconnect detection */
  setRole(role) {
    localStorage.setItem(LS.key.role(S.roomId), role);
  },

  getRole() {
    return localStorage.getItem(LS.key.role(S.roomId));
  },

  /** Store / retrieve guest peer ID */
  setGuestId(id) {
    localStorage.setItem(LS.key.guest(S.roomId), id);
  },

  getGuestId() {
    return localStorage.getItem(LS.key.guest(S.roomId));
  },

  /** Wipe ALL keys for current room */
  destroyRoom() {
    const r = S.roomId;
    if (!r) return;
    [LS.key.role(r), LS.key.msgs(r), LS.key.guest(r)].forEach(k => localStorage.removeItem(k));
  }
};

/* In-memory messages array (mirrors storage) */
let _msgs = [];

function addMsg(msgObj) {
  _msgs.push(msgObj);
  LS.saveMsgs(_msgs);
}

/* ──────────────────────────────────────────
   7. SOUND — AudioContext beep
────────────────────────────────────────── */
let _audioCtx = null;

function playBeep(freq = 880, dur = 0.12, vol = 0.25, type = 'sine') {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    // Resume if suspended (mobile browsers require user gesture)
    if (ctx.state === 'suspended') ctx.resume();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch (_) {}
}

function playCallRing() {
  // Double beep for incoming call
  playBeep(660, 0.15, 0.3);
  setTimeout(() => playBeep(880, 0.15, 0.3), 200);
}

/* ──────────────────────────────────────────
   8. TOAST NOTIFICATIONS
────────────────────────────────────────── */
let _toastTimer = null;
function showToast(msg, type = '', dur = 2800) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  requestAnimationFrame(() => {
    t.classList.add('visible');
    _toastTimer = setTimeout(() => t.classList.remove('visible'), dur);
  });
}

/* ──────────────────────────────────────────
   9. LOADING OVERLAY
────────────────────────────────────────── */
function showLoading(text = 'Please wait…') {
  DOM.loadTxt.textContent = text;
  DOM.loading.style.display = 'flex';
}

function hideLoading() {
  DOM.loading.style.display = 'none';
}

/* ──────────────────────────────────────────
   10. SCREEN MANAGEMENT
────────────────────────────────────────── */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = $('screen-' + name);
  if (target) target.classList.add('active');
}

function showError(title = 'Error', msg = 'Something went wrong.') {
  hideLoading();
  DOM.errTitle.textContent = title;
  DOM.errMsg.textContent   = msg;
  showScreen('error');
}

/* ──────────────────────────────────────────
   11. STATUS UPDATE
────────────────────────────────────────── */
function setStatus(state, text) {
  // state: 'waiting' | 'connecting' | 'connected' | 'calling' | 'error'
  DOM.statusDot.className = 'sdot ' + state;
  DOM.statusTxt.textContent = text;
}

/* ──────────────────────────────────────────
   12. MESSAGE RENDERING
────────────────────────────────────────── */

/** Append a message object to the chat UI */
function renderMsg(msg) {
  const isOut = (msg.sender === 'me');

  if (msg.type === 'system') {
    const div = document.createElement('div');
    div.className = 'msg-system';
    div.innerHTML = `<span>${escHtml(msg.content)}</span>`;
    DOM.msgList.appendChild(div);
    scrollBottom();
    return;
  }

  const row = document.createElement('div');
  row.className = 'msg-row ' + (isOut ? 'out' : 'in');

  if (msg.type === 'text') {
    row.innerHTML = `
      <div class="msg-bubble">
        ${escHtml(msg.content).replace(/\n/g, '<br>')}
        <span class="msg-time">${formatTime(msg.ts)}</span>
      </div>`;
  }
  else if (msg.type === 'image') {
    row.innerHTML = `
      <div class="msg-bubble" style="padding:0.4rem;background:transparent;border:none">
        <img
          src="${msg.dataUrl}"
          class="msg-image"
          alt="${escHtml(msg.fileName)}"
          onclick="openImg('${msg.dataUrl}')"
          loading="lazy"
        >
        <span class="msg-time" style="padding:0 0.3rem 0.1rem">${formatTime(msg.ts)}</span>
      </div>`;
  }
  else if (msg.type === 'file') {
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="file-msg-card" data-url="${msg.dataUrl || ''}" data-name="${escHtml(msg.fileName)}"
             onclick="downloadFile('${msg.dataUrl || ''}','${escHtml(msg.fileName)}')">
          <i class="fas ${fileIcon(msg.mimeType)} file-icon"></i>
          <div class="file-details">
            <div class="file-name">${escHtml(msg.fileName)}</div>
            <div class="file-size">${fmtBytes(msg.fileSize)} · tap to download</div>
          </div>
          <i class="fas fa-download" style="color:var(--text-muted);font-size:0.8rem"></i>
        </div>
        <span class="msg-time">${formatTime(msg.ts)}</span>
      </div>`;
  }

  DOM.msgList.appendChild(row);
  scrollBottom();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

/** Open image in new tab */
window.openImg = function(src) {
  const w = window.open();
  if (w) {
    w.document.write(`<img src="${src}" style="max-width:100%;background:#111">`);
  }
};

/** Download file from data URL */
window.downloadFile = function(url, name) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
};

/* ──────────────────────────────────────────
   13. TYPING INDICATOR
────────────────────────────────────────── */
function sendTyping(active) {
  if (!S.conn || !S.conn.open) return;
  try {
    S.conn.send(JSON.stringify({ type: 'typing', active }));
  } catch (_) {}
}

function handleTypingInput() {
  const now = Date.now();
  if (!S.isTyping || now - S.lastTypingAt > CFG.TYPING_SEND) {
    S.isTyping = true;
    S.lastTypingAt = now;
    sendTyping(true);
  }
  clearTimeout(S.typingTimer);
  S.typingTimer = setTimeout(() => {
    S.isTyping = false;
    sendTyping(false);
  }, CFG.TYPING_STOP);
}

function showTyping() {
  DOM.typing.style.display = 'flex';
  scrollBottom();
}

function hideTyping() {
  DOM.typing.style.display = 'none';
}

/* ──────────────────────────────────────────
   14. SENDING MESSAGES
────────────────────────────────────────── */
function sendTextMessage() {
  const text = DOM.msgInput.value.trim();
  if (!text || !S.conn || !S.conn.open) return;

  // Clear typing state
  clearTimeout(S.typingTimer);
  S.isTyping = false;
  sendTyping(false);

  const msg = {
    type:    'text',
    id:      genId(12),
    content: text,
    sender:  'me',
    ts:      Date.now()
  };

  // Encrypt content before sending
  const payload = { type: 'msg', id: msg.id, content: encrypt(text), ts: msg.ts };
  try {
    S.conn.send(JSON.stringify(payload));
  } catch (e) {
    showToast('Send failed. Check connection.', 'danger');
    return;
  }

  DOM.msgInput.value = '';
  DOM.msgInput.style.height = 'auto';
  renderMsg(msg);
  addMsg(msg);
}

/* ──────────────────────────────────────────
   15. FILE SENDING — with ArrayBuffer Chunking
────────────────────────────────────────── */
function sendFile(file) {
  if (!S.conn || !S.conn.open) {
    showToast('Not connected yet.', 'danger');
    return;
  }

  const isImage = file.type.startsWith('image/');
  const fileId  = genId(12);
  const reader  = new FileReader();

  reader.onload = async function(e) {
    const buffer   = e.target.result;          // ArrayBuffer
    const totalLen = buffer.byteLength;
    const chunks   = Math.ceil(totalLen / CFG.CHUNK_SIZE);

    // Show progress
    DOM.xferWrap.style.display = 'flex';
    DOM.xferFill.style.width = '0%';
    DOM.xferLabel.textContent = `Sending "${file.name}"… 0%`;

    // Send chunks sequentially (await each to avoid data channel overflow)
    for (let i = 0; i < chunks; i++) {
      const start = i * CFG.CHUNK_SIZE;
      const end   = Math.min(start + CFG.CHUNK_SIZE, totalLen);
      const slice = buffer.slice(start, end);
      const b64   = ab2b64(slice);

      const packet = {
        type:     'file_chunk',
        fileId,
        index:    i,
        total:    chunks,
        name:     file.name,
        mimeType: file.type,
        size:     totalLen,
        chunk:    b64
      };

      try {
        S.conn.send(JSON.stringify(packet));
      } catch (err) {
        DOM.xferWrap.style.display = 'none';
        showToast('File send failed.', 'danger');
        return;
      }

      // Update progress
      const pct = Math.round(((i + 1) / chunks) * 100);
      DOM.xferFill.style.width = pct + '%';
      DOM.xferLabel.textContent = `Sending "${file.name}"… ${pct}%`;

      // Yield to event loop every 10 chunks to prevent UI freeze
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }

    // Hide progress
    setTimeout(() => { DOM.xferWrap.style.display = 'none'; }, 800);

    // Create local preview
    if (isImage) {
      const dataUrl = URL.createObjectURL(new Blob([buffer], { type: file.type }));
      const msg = { type: 'image', id: fileId, fileName: file.name, mimeType: file.type, fileSize: file.size, dataUrl, sender: 'me', ts: Date.now() };
      renderMsg(msg);
      addMsg({ ...msg, dataUrl: '' }); // don't store binary in LS
    } else {
      const dataUrl = URL.createObjectURL(new Blob([buffer], { type: file.type }));
      const msg = { type: 'file', id: fileId, fileName: file.name, mimeType: file.type, fileSize: file.size, dataUrl, sender: 'me', ts: Date.now() };
      renderMsg(msg);
      addMsg({ ...msg, dataUrl: '' });
    }
  };

  reader.readAsArrayBuffer(file);
}

/* ──────────────────────────────────────────
   16. FILE RECEIVING — Chunk Reassembly
────────────────────────────────────────── */
function receiveFileChunk(packet) {
  const { fileId, index, total, name, mimeType, size, chunk } = packet;

  if (!S.fileIncoming[fileId]) {
    S.fileIncoming[fileId] = {
      chunks:   new Array(total).fill(null),
      total,
      received: 0,
      name,
      mimeType,
      size
    };
  }

  const fi = S.fileIncoming[fileId];
  fi.chunks[index] = b642ab(chunk);
  fi.received++;

  // Update progress (for large files)
  const pct = Math.round((fi.received / fi.total) * 100);
  DOM.xferWrap.style.display = 'flex';
  DOM.xferFill.style.width = pct + '%';
  DOM.xferLabel.textContent = `Receiving "${name}"… ${pct}%`;

  if (fi.received === fi.total) {
    // All chunks received → reassemble
    const blob   = new Blob(fi.chunks, { type: mimeType });
    const dataUrl = URL.createObjectURL(blob);
    delete S.fileIncoming[fileId];

    setTimeout(() => { DOM.xferWrap.style.display = 'none'; }, 800);
    playBeep(1100, 0.1, 0.2);

    const ts = Date.now();
    if (mimeType.startsWith('image/')) {
      const msg = { type: 'image', id: fileId, fileName: name, mimeType, fileSize: size, dataUrl, sender: 'peer', ts };
      renderMsg(msg);
      addMsg({ ...msg, dataUrl: '' });
    } else {
      const msg = { type: 'file', id: fileId, fileName: name, mimeType, fileSize: size, dataUrl, sender: 'peer', ts };
      renderMsg(msg);
      addMsg({ ...msg, dataUrl: '' });
    }
  }
}

/* ──────────────────────────────────────────
   17. RECEIVE DATA — Master Handler
────────────────────────────────────────── */
function onData(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }

  switch (data.type) {

    case 'room_full':
      hideLoading();
      showError('Access Denied', 'This room is already full. Only 2 people are allowed per room.');
      break;

    case 'room_ready':
      // Host confirmed guest is accepted
      setStatus('connected', 'Secure — Connected');
      enableChatUI();
      showToast('🔒 Secure connection established!', 'success');
      playBeep(660, 0.15, 0.2);
      appendSystemMsg('Secure connection established');
      break;

    case 'msg':
      const decrypted = decrypt(data.content);
      const msg = { type: 'text', id: data.id, content: decrypted, sender: 'peer', ts: data.ts };
      renderMsg(msg);
      addMsg(msg);
      playBeep(880, 0.08, 0.2);
      break;

    case 'typing':
      data.active ? showTyping() : hideTyping();
      break;

    case 'file_chunk':
      receiveFileChunk(data);
      break;

    case 'call_type':
      // Peer is about to call us — store video preference
      S.pendingCallVideo = data.videoEnabled;
      break;

    case 'call_rejected':
      hideCallUI();
      showToast('Call was declined.', '');
      break;
  }
}

/* ──────────────────────────────────────────
   18. DATA CONNECTION SETUP
────────────────────────────────────────── */
function setupConnection(conn) {
  S.conn = conn;

  conn.on('open', () => {
    if (S.isHost) {
      // Tell guest the room is ready
      conn.send(JSON.stringify({ type: 'room_ready' }));
      setStatus('connected', 'Secure — Connected');
      enableChatUI();
      hideBanner();
      appendSystemMsg('Guest joined the secure room');
      playBeep(660, 0.15, 0.2);
      showToast('🔒 Peer connected!', 'success');
    }
  });

  conn.on('data', onData);

  conn.on('close', () => {
    setStatus('waiting', 'Peer disconnected');
    disableChatUI();
    if (S.isHost) {
      S.guestConn = false;
      S.guestPeerId = null;
      showBanner();
      appendSystemMsg('Peer disconnected');
      showToast('Peer disconnected.', '');
    } else {
      appendSystemMsg('Disconnected from host');
      showToast('Host disconnected.', '');
    }
    // End any active call
    if (S.call) cleanupCall();
    S.conn = null;
  });

  conn.on('error', err => {
    console.warn('[Connection Error]', err);
  });
}

/* ──────────────────────────────────────────
   19. PEER SETUP — HOST
────────────────────────────────────────── */
function setupHostPeer(roomId) {
  const hostPeerId = CFG.PREFIX + roomId;
  showLoading('Creating secure room…');

  const peer = new Peer(hostPeerId, {
    config: { iceServers: CFG.ICE, iceTransportPolicy: 'all' }
  });

  peer.on('open', id => {
    S.peer   = peer;
    S.roomId = roomId;
    S.encKey = deriveKey(roomId);
    S.isHost = true;
    LS.setRole('host');
    S.retryCount = 0;

    // Load existing messages
    _msgs = LS.loadMsgs();
    _msgs.filter(m => m.type !== 'system').forEach(renderMsg);

    hideLoading();
    showScreen('chat');
    showBanner();
    setStatus('waiting', 'Waiting for peer…');
  });

  peer.on('connection', conn => {
    if (S.guestConn) {
      // 3rd person — reject immediately
      conn.on('open', () => {
        try { conn.send(JSON.stringify({ type: 'room_full' })); } catch (_) {}
        setTimeout(() => conn.close(), 600);
      });
      return;
    }
    S.guestConn    = true;
    S.guestPeerId  = conn.peer;
    setStatus('connecting', 'Peer connecting…');
    setupConnection(conn);
  });

  peer.on('call', call => {
    S.pendingCall = call;
    showIncomingCallUI(S.pendingCallVideo);
    playCallRing();
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id' && S.retryCount < 5) {
      // Peer ID still in use (host reconnecting quickly) — retry
      S.retryCount++;
      showLoading(`Reconnecting… (attempt ${S.retryCount})`);
      setTimeout(() => setupHostPeer(roomId), CFG.RETRY_DELAY);
    } else if (err.type === 'unavailable-id') {
      hideLoading();
      showError('Room Unavailable', 'Could not reclaim this room. Please create a new room.');
    } else {
      console.warn('[PeerJS Error]', err.type, err.message);
    }
  });

  peer.on('disconnected', () => {
    // PeerJS broker disconnect (not WebRTC) — try to reconnect broker
    if (!peer.destroyed) {
      setTimeout(() => { try { peer.reconnect(); } catch (_) {} }, 3000);
    }
  });
}

/* ──────────────────────────────────────────
   20. PEER SETUP — GUEST
────────────────────────────────────────── */
function setupGuestPeer(roomId) {
  // Use stored guest peer ID if available (for reconnection consistency)
  let guestId = LS.getGuestId();
  if (!guestId) {
    guestId = CFG.PREFIX + roomId + '-g-' + genId(8);
    LS.setGuestId(guestId);
  }

  showLoading('Joining secure room…');

  const peer = new Peer(guestId, {
    config: { iceServers: CFG.ICE, iceTransportPolicy: 'all' }
  });

  peer.on('open', () => {
    S.peer   = peer;
    S.roomId = roomId;
    S.encKey = deriveKey(roomId);
    S.isHost = false;
    LS.setRole('guest');

    // Connect to host
    const hostPeerId = CFG.PREFIX + roomId;
    // Use default serialization — PeerJS handles string data reliably
    const conn = peer.connect(hostPeerId, {
      reliable: true
    });

    setStatus('connecting', 'Connecting to host…');

    conn.on('open', () => {
      // Load existing messages
      _msgs = LS.loadMsgs();
      _msgs.filter(m => m.type !== 'system').forEach(renderMsg);

      hideLoading();
      showScreen('chat');
      // Connection will be confirmed by 'room_ready' message from host
    });

    conn.on('error', err => {
      hideLoading();
      showError('Connection Failed', 'Could not reach host. The room may no longer exist.');
    });

    setupConnection(conn);

    // Set a timeout: if no room_ready in 12s, show error
    const to = setTimeout(() => {
      if (!S.conn || !S.conn.open) {
        hideLoading();
        showError('Connection Timeout', 'Could not connect. The room may be full or no longer exists.');
      }
    }, 12000);
    conn.on('open', () => clearTimeout(to));
  });

  peer.on('call', call => {
    S.pendingCall = call;
    showIncomingCallUI(S.pendingCallVideo);
    playCallRing();
  });

  peer.on('error', err => {
    hideLoading();
    if (err.type === 'peer-unavailable') {
      showError('Room Not Found', 'This room does not exist or the host has left. Ask your contact to share a new link.');
    } else if (err.type === 'unavailable-id') {
      // Guest ID conflict — generate new ID and retry
      LS.setGuestId('');
      setupGuestPeer(roomId);
    } else {
      showError('Connection Error', `Failed to connect: ${err.message}`);
    }
  });

  peer.on('disconnected', () => {
    if (!peer.destroyed) {
      setTimeout(() => { try { peer.reconnect(); } catch (_) {} }, 3000);
    }
  });
}

/* ──────────────────────────────────────────
   21. CALL MANAGEMENT
────────────────────────────────────────── */

async function startCall(videoEnabled) {
  if (!S.conn || !S.conn.open) {
    showToast('Not connected.', 'danger');
    return;
  }

  // Signal to remote peer what type of call is coming
  try {
    S.conn.send(JSON.stringify({ type: 'call_type', videoEnabled }));
  } catch (_) {}

  // Get media
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: videoEnabled ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch (e) {
    showToast('Microphone/camera permission denied.', 'danger');
    return;
  }

  S.localStream = stream;
  S.micOn = true;
  S.camOn = videoEnabled;
  DOM.localVid.srcObject = stream;
  DOM.videoArea.style.display = 'block';

  updateCallButtons();

  // Find remote peer ID
  const remotePeerId = S.isHost ? S.guestPeerId : (CFG.PREFIX + S.roomId);
  const call = S.peer.call(remotePeerId, stream);

  if (!call) {
    showToast('Could not initiate call.', 'danger');
    cleanupLocalStream();
    return;
  }

  S.call = call;
  setStatus('calling', 'Call in progress…');

  call.on('stream', remoteStream => {
    DOM.remoteVid.srcObject = remoteStream;
    DOM.videoArea.style.display = 'block';
  });

  call.on('close', () => {
    cleanupCall();
    appendSystemMsg('Call ended');
  });

  call.on('error', err => {
    cleanupCall();
    showToast('Call error: ' + err.message, 'danger');
  });
}

function showIncomingCallUI(videoEnabled) {
  DOM.icTypeLabel.textContent = videoEnabled ? 'Video' : 'Voice';
  DOM.incOverlay.style.display = 'flex';
  setStatus('calling', 'Incoming call…');
}

function hideCallUI() {
  DOM.incOverlay.style.display = 'none';
  setStatus('connected', 'Secure — Connected');
  S.pendingCall = null;
}

async function acceptCall() {
  if (!S.pendingCall) return;
  const call = S.pendingCall;
  S.pendingCall = null;

  const videoEnabled = S.pendingCallVideo;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: videoEnabled ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch {
    showToast('Permission denied. Cannot answer call.', 'danger');
    call.close();
    hideCallUI();
    return;
  }

  S.localStream = stream;
  S.micOn = true;
  S.camOn = videoEnabled;
  DOM.localVid.srcObject = stream;
  DOM.incOverlay.style.display = 'none';
  DOM.videoArea.style.display = 'block';
  updateCallButtons();

  call.answer(stream);
  S.call = call;
  setStatus('calling', 'Call in progress…');

  call.on('stream', remoteStream => {
    DOM.remoteVid.srcObject = remoteStream;
  });

  call.on('close', () => {
    cleanupCall();
    appendSystemMsg('Call ended');
  });
}

function declineCall() {
  if (S.pendingCall) {
    S.pendingCall.close();
    S.pendingCall = null;
  }
  // Notify peer
  try { S.conn.send(JSON.stringify({ type: 'call_rejected' })); } catch (_) {}
  hideCallUI();
}

function endCall() {
  if (S.call) { try { S.call.close(); } catch (_) {} }
  cleanupCall();
  appendSystemMsg('Call ended');
}

function cleanupCall() {
  cleanupLocalStream();
  if (S.call) { try { S.call.close(); } catch (_) {} S.call = null; }
  DOM.remoteVid.srcObject = null;
  DOM.videoArea.style.display = 'none';
  DOM.incOverlay.style.display = 'none';
  S.pendingCall = null;
  S.micOn = true; S.camOn = true;
  if (S.conn && S.conn.open) setStatus('connected', 'Secure — Connected');
  else setStatus('waiting', 'Waiting for peer…');
}

function cleanupLocalStream() {
  if (S.localStream) {
    S.localStream.getTracks().forEach(t => t.stop());
    S.localStream = null;
  }
  DOM.localVid.srcObject = null;
}

function toggleMic() {
  if (!S.localStream) return;
  S.micOn = !S.micOn;
  S.localStream.getAudioTracks().forEach(t => { t.enabled = S.micOn; });
  DOM.btnTogMic.className = 'ccbtn' + (S.micOn ? ' active' : ' muted');
  DOM.btnTogMic.innerHTML = `<i class="fas fa-microphone${S.micOn ? '' : '-slash'}"></i>`;
}

function toggleCam() {
  if (!S.localStream) return;
  S.camOn = !S.camOn;
  S.localStream.getVideoTracks().forEach(t => { t.enabled = S.camOn; });
  DOM.btnTogCam.className = 'ccbtn' + (S.camOn ? ' active' : ' muted');
  DOM.btnTogCam.innerHTML = `<i class="fas fa-video${S.camOn ? '' : '-slash'}"></i>`;
}

function updateCallButtons() {
  DOM.btnTogMic.className = 'ccbtn active';
  DOM.btnTogMic.innerHTML = '<i class="fas fa-microphone"></i>';
  DOM.btnTogCam.className = 'ccbtn ' + (S.camOn ? 'active' : 'muted');
  DOM.btnTogCam.innerHTML = `<i class="fas fa-video${S.camOn ? '' : '-slash'}"></i>`;
}

/* ──────────────────────────────────────────
   22. UI HELPERS
────────────────────────────────────────── */
function enableChatUI() {
  DOM.msgInput.disabled = false;
  DOM.msgInput.focus();
  DOM.btnSend.disabled = false;
  DOM.btnAudioCall.disabled = false;
  DOM.btnVideoCall.disabled = false;
}

function disableChatUI() {
  DOM.msgInput.disabled = true;
  DOM.btnSend.disabled = true;
  DOM.btnAudioCall.disabled = true;
  DOM.btnVideoCall.disabled = true;
}

function showBanner() {
  if (!S.isHost) return;
  DOM.shareBanner.style.display = 'block';
  const url = location.origin + location.pathname + '?room=' + S.roomId;
  DOM.shareLinkIn.value = url;
}

function hideBanner() {
  DOM.shareBanner.style.display = 'none';
}

function appendSystemMsg(text) {
  const msg = { type: 'system', content: text, sender: 'system', ts: Date.now() };
  renderMsg(msg);
  // Don't persist system messages to storage
}

/* ──────────────────────────────────────────
   23. DESTROY ROOM
────────────────────────────────────────── */
function destroyRoom() {
  // Close connections
  if (S.call) { try { S.call.close(); } catch (_) {} S.call = null; }
  if (S.conn) { try { S.conn.close(); } catch (_) {} S.conn = null; }
  if (S.peer && !S.peer.destroyed) { try { S.peer.destroy(); } catch (_) {} S.peer = null; }
  cleanupLocalStream();

  // Wipe all local data
  LS.destroyRoom();

  // Navigate back to home (clean URL)
  window.location.href = window.location.pathname;
}

/* ──────────────────────────────────────────
   24. COPY LINK
────────────────────────────────────────── */
function copyLink() {
  const url = DOM.shareLinkIn.value;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    DOM.btnCopy.classList.add('copied');
    DOM.btnCopy.innerHTML = '<i class="fas fa-check"></i><span>Copied!</span>';
    setTimeout(() => {
      DOM.btnCopy.classList.remove('copied');
      DOM.btnCopy.innerHTML = '<i class="fas fa-copy"></i><span>Copy</span>';
    }, 2500);
    showToast('Link copied!', 'success');
  }).catch(() => {
    // Fallback for older browsers
    DOM.shareLinkIn.select();
    document.execCommand('copy');
    showToast('Link copied!', 'success');
  });
}

/* ──────────────────────────────────────────
   25. AUTO-RESIZE TEXTAREA
────────────────────────────────────────── */
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/* ──────────────────────────────────────────
   26. INITIALIZATION
────────────────────────────────────────── */
function init() {
  const params  = new URLSearchParams(location.search);
  const roomId  = params.get('room');

  if (!roomId) {
    // No room in URL → show setup screen
    showScreen('setup');
    return;
  }

  // Validate room ID format (alphanumeric, 6-20 chars)
  if (!/^[a-z0-9]{6,20}$/.test(roomId)) {
    showError('Invalid Link', 'This room link is invalid or has expired.');
    return;
  }

  // Check existing role in localStorage for this room
  S.roomId = roomId;
  S.encKey = deriveKey(roomId);
  const existingRole = LS.getRole();

  if (existingRole === 'host') {
    // Returning host — reconnect
    setupHostPeer(roomId);
  } else {
    // New visitor or returning guest — join as guest
    setupGuestPeer(roomId);
  }
}

/* ──────────────────────────────────────────
   27. EVENT LISTENERS
────────────────────────────────────────── */

// Setup screen — Create Room
DOM.btnCreate.addEventListener('click', () => {
  const roomId = genId(10); // e.g. 'xk7mq2nbpr'
  // Navigate to the new room URL
  window.location.href = `${location.pathname}?room=${roomId}`;
});

// Send button
DOM.btnSend.addEventListener('click', sendTextMessage);

// Enter to send (Shift+Enter = new line)
DOM.msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});

// Typing indicator on input
DOM.msgInput.addEventListener('input', () => {
  autoResize(DOM.msgInput);
  handleTypingInput();
});

// File attach
DOM.fileInput.addEventListener('change', () => {
  const file = DOM.fileInput.files[0];
  if (!file) return;

  // Max file size check: 100 MB
  if (file.size > 100 * 1024 * 1024) {
    showToast('Max file size is 100 MB.', 'danger');
    DOM.fileInput.value = '';
    return;
  }

  sendFile(file);
  DOM.fileInput.value = '';
});

// Copy link button
DOM.btnCopy.addEventListener('click', copyLink);

// Audio call
DOM.btnAudioCall.addEventListener('click', () => startCall(false));

// Video call
DOM.btnVideoCall.addEventListener('click', () => startCall(true));

// End call
DOM.btnEndCall.addEventListener('click', endCall);

// Toggle mic / cam
DOM.btnTogMic.addEventListener('click', toggleMic);
DOM.btnTogCam.addEventListener('click', toggleCam);

// Accept / Decline incoming call
DOM.btnAccept.addEventListener('click', acceptCall);
DOM.btnDecline.addEventListener('click', declineCall);

// Destroy room button → show confirm modal
DOM.btnDestroy.addEventListener('click', () => {
  DOM.confirmModal.style.display = 'flex';
});
DOM.modalCancel.addEventListener('click', () => {
  DOM.confirmModal.style.display = 'none';
});
DOM.modalConfirm.addEventListener('click', () => {
  DOM.confirmModal.style.display = 'none';
  destroyRoom();
});

// Close modal on backdrop click
DOM.confirmModal.addEventListener('click', e => {
  if (e.target === DOM.confirmModal) DOM.confirmModal.style.display = 'none';
});

// Prevent zoom on double-tap (iOS)
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });

/* ──────────────────────────────────────────
   28. START
────────────────────────────────────────── */
init();
