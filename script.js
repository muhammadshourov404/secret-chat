'use strict';
/* ════════════════════════════════════════════════════════
   SECURE P2P  v3.0  —  script.js
   Copyright Owner: Muhammad Shourov
   ─────────────────────────────────────────────────────
   KEY FIXES FROM v2.0:
   ① PeerJS serialization: use conn.send(OBJECT) directly
     (PeerJS json-serializes internally — no JSON.stringify
      on send, no JSON.parse on receive → messages now work)
   ② Host-only Destroy button; Guest gets Leave button
   ③ Guest retry logic → fixes "Host Not Found" errors
   ④ Clean star-topology relay (host = hub)
   ⑤ Stable participant list sync
════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────
   1. CONFIG
──────────────────────────────────────── */
const CFG = {
  ICE: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    /* ── Free TURN servers (OpenRelay — no sign-up) ── */
    { urls:'turn:openrelay.metered.ca:80',  username:'openrelayproject', credential:'openrelayproject' },
    { urls:'turn:openrelay.metered.ca:443', username:'openrelayproject', credential:'openrelayproject' },
    { urls:'turns:openrelay.metered.ca:443?transport=tcp', username:'openrelayproject', credential:'openrelayproject' }
  ],
  MAX_MSGS:    60,     // auto-prune localStorage
  CHUNK_SIZE:  16384,  // 16 KB per WebRTC chunk
  TYPING_STOP: 2500,   // ms before "stopped typing"
  TYPING_GAP:  1500,   // min ms between typing signals
  PREFIX:      'sp2p', // PeerJS ID prefix
  JOIN_TIMEOUT:14000,  // ms before guest shows connection error
  MAX_RETRIES: 6,      // guest retry attempts for "host not found"
  RETRY_DELAY: 3500    // ms between retries
};

/* ────────────────────────────────────────
   2. STATE
──────────────────────────────────────── */
const S = {
  peer:           null,   // PeerJS Peer object
  roomId:         null,
  myName:         null,
  encKey:         null,
  isHost:         false,
  requireApproval:true,

  /* HOST: Map<peerId, { conn, name, approved:bool }> */
  guests:         new Map(),

  /* GUEST: DataConnection to host */
  hostConn:       null,

  /* Current participant list (shown in panel) */
  participants:   [],     // [{ peerId, name, isHost }]

  /* Approval queue (host) */
  aqQueue:        [],     // [{ peerId, name, conn }]
  aqActive:       false,

  /* Call state */
  activeCall:     null,
  pendingCall:    null,
  pendingVideo:   false,
  localStream:    null,
  micOn:          true,
  camOn:          true,

  /* File chunks in-flight */
  incoming:       {},     // fileId → { chunks[], total, received, meta }

  /* Typing */
  typingTimer:    null,
  lastTypingAt:   0,
  isTyping:       false,
  typingPeers:    new Set(),

  /* Retry (guest) */
  retryCount:     0,
  retryTimer:     null
};

/* ────────────────────────────────────────
   3. DOM REFERENCES
──────────────────────────────────────── */
const $ = id => document.getElementById(id);
const D = {
  // screens
  scSetup:  $('sc-setup'),
  scWait:   $('sc-wait'),
  scChat:   $('sc-chat'),
  scError:  $('sc-error'),
  loader:   $('loader'),
  loaderTxt:$('loader-txt'),

  // setup
  joinInfo: $('join-info'),
  jiRoomId: $('ji-roomid'),
  inpName:  $('inp-name'),
  hostOpts: $('host-opts'),
  chkApproval: $('chk-approval'),
  btnCreate:   $('btn-create'),
  btnJoin:     $('btn-join'),

  // wait
  waitName:  $('wait-name'),
  btnCancel: $('btn-cancel'),

  // chat header
  dot:       $('dot'),
  stxt:      $('stxt'),
  btnUsers:  $('btn-users'),
  ubadge:    $('ubadge'),
  btnVcall:  $('btn-vcall'),
  btnVidcall:$('btn-vidcall'),
  btnDestroy:$('btn-destroy'),
  btnLeave:  $('btn-leave'),

  // share bar
  shareBar:  $('share-bar'),
  sbLink:    $('sb-link'),
  btnCopy:   $('btn-copy'),
  btnShare:  $('btn-share'),

  // approval queue
  aqBar:     $('aq-bar'),
  aqName:    $('aq-name'),
  aqMore:    $('aq-more'),
  aqMoreN:   $('aq-more-n'),
  btnApprove:$('btn-approve'),
  btnReject: $('btn-reject'),

  // video
  vidArea:   $('vid-area'),
  vidRemote: $('vid-remote'),
  vidLocal:  $('vid-local'),
  vidLbl:    $('vid-lbl'),
  btnTmic:   $('btn-tmic'),
  btnTcam:   $('btn-tcam'),
  btnEndcall:$('btn-endcall'),

  // messages
  msgArea:   $('msg-area'),
  msgList:   $('msg-list'),
  typing:    $('typing'),
  typingTxt: $('typing-txt'),

  // progress
  xfer:      $('xfer'),
  xferFill:  $('xfer-fill'),
  xferTxt:   $('xfer-txt'),

  // input
  inpFile:   $('inp-file'),
  inpMsg:    $('inp-msg'),
  btnSend:   $('btn-send'),

  // participants panel
  pp:        $('pp'),
  ppOv:      $('pp-ov'),
  ppList:    $('pp-list'),
  btnPpClose:$('btn-pp-close'),

  // incoming call
  incCall:   $('inc-call'),
  incType:   $('inc-type'),
  incFrom:   $('inc-from'),
  btnAccept: $('btn-accept'),
  btnDecline:$('btn-decline'),

  // error
  errH:      $('err-h'),
  errP:      $('err-p'),

  // modals
  modalDestroy: $('modal-destroy'),
  mdNo:  $('md-no'),
  mdYes: $('md-yes'),
  modalPick:  $('modal-pick'),
  pickSub:    $('pick-sub'),
  pickList:   $('pick-list'),
  pickCancel: $('pick-cancel'),

  // lightbox
  lightbox:  $('lightbox'),
  lbImg:     $('lb-img')
};

/* ────────────────────────────────────────
   4. UTILITIES
──────────────────────────────────────── */
function genId(n = 10) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}
function fileIco(m) {
  if (!m) return 'fa-file';
  if (m.startsWith('image/'))  return 'fa-file-image';
  if (m.startsWith('video/'))  return 'fa-file-video';
  if (m.startsWith('audio/'))  return 'fa-file-audio';
  if (m.includes('pdf'))       return 'fa-file-pdf';
  if (m.includes('zip')||m.includes('rar')) return 'fa-file-zipper';
  if (m.includes('word')||m.includes('document')) return 'fa-file-word';
  if (m.includes('sheet')||m.includes('excel'))   return 'fa-file-excel';
  if (m.includes('text'))      return 'fa-file-lines';
  return 'fa-file';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function initial(n) { return (n||'?').charAt(0).toUpperCase(); }
function scrollBot() { D.msgArea.scrollTo({ top:D.msgArea.scrollHeight, behavior:'smooth' }); }
function ab2b64(buf) {
  let s=''; new Uint8Array(buf).forEach(b=>s+=String.fromCharCode(b)); return btoa(s);
}
function b642ab(b64) {
  const s=atob(b64), b=new ArrayBuffer(s.length), v=new Uint8Array(b);
  for(let i=0;i<s.length;i++) v[i]=s.charCodeAt(i); return b;
}

/* ────────────────────────────────────────
   5. CRYPTO (AES-256)
──────────────────────────────────────── */
function deriveKey(rid) { return CryptoJS.SHA256('sp2p-v3-' + rid).toString(); }
function enc(t) {
  if (!S.encKey) return t;
  return CryptoJS.AES.encrypt(t, S.encKey).toString();
}
function dec(c) {
  if (!S.encKey) return c;
  try { return CryptoJS.AES.decrypt(c, S.encKey).toString(CryptoJS.enc.Utf8) || c; }
  catch { return c; }
}

/* ────────────────────────────────────────
   6. STORAGE (auto-prune)
──────────────────────────────────────── */
const LS = {
  km: r => `sp2p_m_${r}`,
  kr: r => `sp2p_r_${r}`,
  ki: r => `sp2p_i_${r}`,

  saveMsgs(msgs) {
    if (!S.roomId) return;
    const pruned = msgs.slice(-CFG.MAX_MSGS);
    try {
      localStorage.setItem(LS.km(S.roomId), enc(JSON.stringify(pruned)));
    } catch(e) {
      if (e.name === 'QuotaExceededError') {
        try { localStorage.setItem(LS.km(S.roomId), enc(JSON.stringify(msgs.slice(-20)))); }
        catch (_) { localStorage.removeItem(LS.km(S.roomId)); }
      }
    }
  },
  loadMsgs() {
    if (!S.roomId) return [];
    try { const r=localStorage.getItem(LS.km(S.roomId)); return r?JSON.parse(dec(r)):[];} catch{return [];}
  },
  setRole(r)  { localStorage.setItem(LS.kr(S.roomId), r); },
  getRole()   { return localStorage.getItem(LS.kr(S.roomId)); },
  setMyId(id) { localStorage.setItem(LS.ki(S.roomId), id); },
  getMyId()   { return localStorage.getItem(LS.ki(S.roomId)); },
  wipe() {
    if (!S.roomId) return;
    [LS.km, LS.kr, LS.ki].forEach(fn => localStorage.removeItem(fn(S.roomId)));
  }
};
let _msgs = [];
function addMsg(m) { _msgs.push(m); LS.saveMsgs(_msgs); }

/* ────────────────────────────────────────
   7. SOUND
──────────────────────────────────────── */
let _actx = null;
function beep(freq=880, dur=.12, vol=.2) {
  try {
    if (!_actx) _actx = new (window.AudioContext||window.webkitAudioContext)();
    if (_actx.state==='suspended') _actx.resume();
    const o=_actx.createOscillator(), g=_actx.createGain();
    o.connect(g); g.connect(_actx.destination);
    o.frequency.value=freq; g.gain.setValueAtTime(vol,_actx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,_actx.currentTime+dur);
    o.start(); o.stop(_actx.currentTime+dur);
  } catch(_){}
}
function ringBeep() { beep(660,.14,.28); setTimeout(()=>beep(880,.14,.28),200); }

/* ────────────────────────────────────────
   8. TOAST
──────────────────────────────────────── */
let _tTimer=null;
function toast(msg, type='', dur=2800) {
  let t=document.querySelector('.toast');
  if (!t) { t=document.createElement('div'); t.className='toast'; document.body.appendChild(t); }
  t.textContent=msg; t.className='toast'+(type?' '+type:'');
  clearTimeout(_tTimer);
  requestAnimationFrame(()=>{
    t.classList.add('show');
    _tTimer=setTimeout(()=>t.classList.remove('show'), dur);
  });
}

/* ────────────────────────────────────────
   9. LOADING / SCREENS
──────────────────────────────────────── */
function showLoad(txt='Please wait…') { D.loaderTxt.textContent=txt; D.loader.style.display='flex'; }
function hideLoad() { D.loader.style.display='none'; }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  $('sc-'+id)?.classList.add('active');
}
function showError(h, p) { hideLoad(); D.errH.textContent=h; D.errP.textContent=p; showScreen('error'); }

/* ────────────────────────────────────────
   10. STATUS BAR
──────────────────────────────────────── */
function setStatus(state, txt) {
  D.dot.className='dot '+state;
  D.stxt.textContent=txt;
}

/* ────────────────────────────────────────
   11. RENDER MESSAGES
──────────────────────────────────────── */
function renderMsg(m) {
  if (m.type === 'system') {
    const d=document.createElement('div'); d.className='msys';
    d.innerHTML=`<span>${esc(m.content)}</span>`;
    D.msgList.appendChild(d); scrollBot(); return;
  }

  const isOut = m.from === S.peer?.id;
  const row = document.createElement('div');
  row.className = 'mrow ' + (isOut ? 'out' : 'in');

  const nameHtml = !isOut ? `<div class="mname">${esc(m.senderName || '?')}</div>` : '';
  const time = `<span class="mtime">${fmtTime(m.ts)}</span>`;

  if (m.type === 'text') {
    row.innerHTML = nameHtml +
      `<div class="mbub">${esc(m.content).replace(/\n/g,'<br>')}${time}</div>`;
  }
  else if (m.type === 'image') {
    row.innerHTML = nameHtml +
      `<div class="mbub" style="padding:.32rem;background:transparent;border:none">
        <img src="${m.url}" class="mimg" alt="${esc(m.name)}" loading="lazy"
          onclick="openLB('${m.url}')">
        ${time}
       </div>`;
  }
  else if (m.type === 'file') {
    row.innerHTML = nameHtml +
      `<div class="mbub">
        <div class="fcard" onclick="dlFile('${m.url||''}','${esc(m.name)}')">
          <i class="fas ${fileIco(m.mime)} fic"></i>
          <div class="fi"><div class="fn">${esc(m.name)}</div><div class="fs">${fmtBytes(m.size)} · tap to save</div></div>
          <i class="fas fa-download" style="color:var(--t3);font-size:.72rem"></i>
        </div>${time}
       </div>`;
  }
  D.msgList.appendChild(row); scrollBot();
}

function sysMsg(txt) { renderMsg({ type:'system', content:txt, ts:Date.now() }); }

window.openLB = src => { D.lbImg.src=src; D.lightbox.style.display='flex'; };
window.closeLB = ()  => { D.lightbox.style.display='none'; D.lbImg.src=''; };
window.dlFile  = (url,name) => { if(!url)return; const a=document.createElement('a');a.href=url;a.download=name;a.click(); };

/* ────────────────────────────────────────
   12. SEND DATA — KEY FIX
   ─────────────────────────────────────
   PeerJS v1.x with DEFAULT serialization:
   conn.send(object) → other side receives object (no parse needed)
   conn.send(string) → other side receives the same string
   
   WRONG PATTERN (v2.0 bug):
     conn.send(JSON.stringify(obj)) + JSON.parse(raw)
     ↑ This double-encodes or loses data depending on PeerJS version
   
   CORRECT PATTERN (v3.0 fix):
     conn.send(obj) → received as obj directly
──────────────────────────────────────── */

/* Send to ALL approved guests (host) */
function broadcast(obj, skipPeer=null) {
  S.guests.forEach((g, pid) => {
    if (g.approved && g.conn?.open && pid !== skipPeer) {
      try { g.conn.send(obj); } catch(_) {}
    }
  });
}

/* Send to host (guest) */
function toHost(obj) {
  if (S.hostConn?.open) {
    try { S.hostConn.send(obj); } catch(_) { toast('Send failed.','err'); }
  }
}

/* ────────────────────────────────────────
   13. TEXT MESSAGING
──────────────────────────────────────── */
function sendText() {
  const text = D.inpMsg.value.trim();
  if (!text) return;
  D.inpMsg.value = '';
  D.inpMsg.style.height = 'auto';
  clearTimeout(S.typingTimer);
  S.isTyping = false;
  sendTyping(false);

  const msg = {
    type: 'msg',
    id:   genId(12),
    from: S.peer.id,
    senderName: S.myName,
    content: enc(text),
    ts: Date.now()
  };

  if (S.isHost) {
    /* Host → broadcast to all guests */
    broadcast(msg);
    /* Show locally (decrypt for own view) */
    renderMsg({ ...msg, content: text });
    addMsg({ ...msg, content: text });
  } else {
    /* Guest → send to host (host will relay) */
    toHost(msg);
    /* Show locally */
    renderMsg({ ...msg, content: text });
    addMsg({ ...msg, content: text });
  }
}

/* ────────────────────────────────────────
   14. TYPING INDICATOR
──────────────────────────────────────── */
function sendTyping(active) {
  const obj = { type:'typing', from:S.peer.id, senderName:S.myName, active };
  if (S.isHost) broadcast(obj);
  else toHost(obj);
}

function onTypingInput() {
  if (D.inpMsg.disabled) return;
  const now = Date.now();
  if (!S.isTyping || now - S.lastTypingAt > CFG.TYPING_GAP) {
    S.isTyping = true; S.lastTypingAt = now; sendTyping(true);
  }
  clearTimeout(S.typingTimer);
  S.typingTimer = setTimeout(()=>{ S.isTyping=false; sendTyping(false); }, CFG.TYPING_STOP);
}

function setTypingPeer(peerId, name, active) {
  if (active) S.typingPeers.add(peerId+':'+name);
  else S.typingPeers.forEach(k=>{ if(k.startsWith(peerId+':')) S.typingPeers.delete(k); });
  updateTypingUI();
}

function updateTypingUI() {
  if (S.typingPeers.size === 0) { D.typing.style.display='none'; return; }
  const names = [...S.typingPeers].map(k=>k.split(':').slice(1).join(':'));
  D.typing.style.display='flex';
  D.typingTxt.textContent = names.join(', ') + (names.length===1?' is typing…':' are typing…');
  scrollBot();
}

/* ────────────────────────────────────────
   15. FILE SHARING (16 KB chunks)
──────────────────────────────────────── */
async function sendFile(file) {
  if (file.size > 150*1024*1024) { toast('Max file size: 150 MB','err'); return; }
  const fileId = genId(12);
  const buf = await file.arrayBuffer();
  const total = Math.ceil(buf.byteLength / CFG.CHUNK_SIZE);

  D.xfer.style.display='flex'; D.xferFill.style.width='0%';
  D.xferTxt.textContent=`Sending 0%`;

  for (let i=0; i<total; i++) {
    const start = i * CFG.CHUNK_SIZE;
    const pkt = {
      type:'chunk', fileId, idx:i, total,
      name:file.name, mime:file.type, size:buf.byteLength,
      from:S.peer.id, senderName:S.myName,
      data: ab2b64(buf.slice(start, start+CFG.CHUNK_SIZE))
    };
    if (S.isHost) broadcast(pkt);
    else toHost(pkt);

    const pct = Math.round(((i+1)/total)*100);
    D.xferFill.style.width=pct+'%';
    D.xferTxt.textContent=`Sending ${pct}%`;
    if (i%10===9) await new Promise(r=>setTimeout(r,0));
  }
  setTimeout(()=>{ D.xfer.style.display='none'; }, 700);

  /* Show own preview */
  const url = URL.createObjectURL(new Blob([buf],{type:file.type}));
  const m = { type:file.type.startsWith('image/')?'image':'file',
    id:fileId, name:file.name, mime:file.type, size:buf.byteLength,
    url, from:S.peer.id, senderName:S.myName, ts:Date.now() };
  renderMsg(m); addMsg({...m, url:''});
}

function recvChunk(pkt) {
  const { fileId, idx, total, name, mime, size, from, senderName, data } = pkt;
  if (!S.incoming[fileId]) {
    S.incoming[fileId] = { chunks:new Array(total).fill(null), total, rcv:0, name, mime, size, from, senderName };
  }
  const fi = S.incoming[fileId];
  if (fi.chunks[idx] !== null) return; // deduplicate
  fi.chunks[idx] = b642ab(data); fi.rcv++;

  const pct = Math.round((fi.rcv/fi.total)*100);
  D.xfer.style.display='flex'; D.xferFill.style.width=pct+'%';
  D.xferTxt.textContent=`Receiving ${pct}%`;

  if (fi.rcv === fi.total) {
    const url = URL.createObjectURL(new Blob(fi.chunks,{type:fi.mime}));
    delete S.incoming[fileId];
    setTimeout(()=>{ D.xfer.style.display='none'; },700);
    beep(1100,.08,.18);
    const m = { type:fi.mime.startsWith('image/')?'image':'file',
      id:fileId, name:fi.name, mime:fi.mime, size:fi.size,
      url, from:fi.from, senderName:fi.senderName, ts:Date.now() };
    renderMsg(m); addMsg({...m, url:''});
  }
}

/* ────────────────────────────────────────
   16. DATA ROUTER — handles all incoming objects
──────────────────────────────────────── */
function handleData(data, fromPeerId) {
  if (!data || !data.type) return;

  switch (data.type) {

    /* ── Text message ── */
    case 'msg': {
      const plain = dec(data.content);
      if (S.isHost) {
        const guest = S.guests.get(fromPeerId);
        if (!guest?.approved) return;
        /* Show on host's screen */
        renderMsg({ ...data, content:plain });
        addMsg({ ...data, content:plain });
        beep(880,.07,.18);
        /* Relay to all other approved guests */
        broadcast({ ...data }, fromPeerId);
      } else {
        /* Guest receives relay from host (from field = original sender) */
        renderMsg({ ...data, content:plain });
        addMsg({ ...data, content:plain });
        beep(880,.07,.18);
      }
      break;
    }

    /* ── Typing ── */
    case 'typing': {
      if (S.isHost) {
        const guest = S.guests.get(fromPeerId);
        if (!guest?.approved) return;
        setTypingPeer(data.from, data.senderName, data.active);
        /* Relay to other guests */
        broadcast(data, fromPeerId);
      } else {
        /* Guest — from field = original typer */
        if (data.from !== S.peer.id) setTypingPeer(data.from, data.senderName, data.active);
      }
      break;
    }

    /* ── File chunk ── */
    case 'chunk': {
      if (S.isHost) {
        const guest = S.guests.get(fromPeerId);
        if (!guest?.approved) return;
        recvChunk(data);
        /* Relay to other guests */
        broadcast(data, fromPeerId);
      } else {
        /* Guest receives relayed chunk */
        if (data.from !== S.peer.id) recvChunk(data);
      }
      break;
    }

    /* ── Guest join request ── */
    case 'join_req': {
      if (!S.isHost) return;
      const guest = S.guests.get(fromPeerId);
      if (!guest) return;
      guest.name = data.name;
      if (S.requireApproval) {
        S.aqQueue.push({ peerId:fromPeerId, name:data.name, conn:guest.conn });
        if (!S.aqActive) showNextAQ();
      } else {
        approveGuest(fromPeerId, data.name, guest.conn);
      }
      break;
    }

    /* ── Host approved (guest receives) ── */
    case 'approved': {
      if (S.isHost) return;
      /* Build participant list from host's data */
      S.participants = data.participants || [];
      /* Ensure self is in list */
      if (!S.participants.find(p=>p.peerId===S.peer.id)) {
        S.participants.push({ peerId:S.peer.id, name:S.myName, isHost:false });
      }
      onEnteredRoom();
      break;
    }

    /* ── Host rejected (guest receives) ── */
    case 'rejected': {
      if (S.isHost) return;
      hideLoad();
      showError('Request Rejected', data.reason || 'The host declined your join request.');
      break;
    }

    /* ── Kicked (guest receives) ── */
    case 'kicked': {
      if (S.isHost) return;
      cleanAll();
      showError('Removed from Room', 'You were removed by the host.');
      break;
    }

    /* ── Room full signal ── */
    case 'room_full': {
      if (S.isHost) return;
      hideLoad();
      showError('Room Full', 'Could not join: this room has reached its limit.');
      break;
    }

    /* ── Peer joined broadcast (guests receive) ── */
    case 'peer_in': {
      if (S.isHost) return;
      if (!S.participants.find(p=>p.peerId===data.peerId)) {
        S.participants.push({ peerId:data.peerId, name:data.name, isHost:false });
      }
      refreshParticipants();
      sysMsg(`${data.name} joined`);
      break;
    }

    /* ── Peer left broadcast (guests receive) ── */
    case 'peer_out': {
      if (S.isHost) return;
      S.participants = S.participants.filter(p=>p.peerId!==data.peerId);
      refreshParticipants();
      sysMsg(`${data.name} left`);
      break;
    }

    /* ── Host closed room ── */
    case 'room_closed': {
      if (S.isHost) return;
      cleanAll();
      showError('Room Closed', 'The host has closed this room.');
      break;
    }
  }
}

/* ────────────────────────────────────────
   17. APPROVAL QUEUE
──────────────────────────────────────── */
function showNextAQ() {
  if (S.aqQueue.length === 0) { D.aqBar.style.display='none'; S.aqActive=false; return; }
  S.aqActive = true;
  const next = S.aqQueue[0];
  D.aqName.textContent = next.name;
  D.aqBar.style.display = 'block';
  const waiting = S.aqQueue.length - 1;
  D.aqMore.style.display = waiting > 0 ? 'flex' : 'none';
  D.aqMoreN.textContent = waiting;
  beep(880,.07,.18);
}

function processAQ(approved) {
  if (S.aqQueue.length === 0) return;
  const req = S.aqQueue.shift();
  if (approved) {
    approveGuest(req.peerId, req.name, req.conn);
  } else {
    try { req.conn.send({ type:'rejected', reason:'The host declined your request.' }); } catch(_) {}
    S.guests.delete(req.peerId);
    toast(`${req.name} was rejected`,'');
  }
  showNextAQ();
}

function approveGuest(peerId, name, conn) {
  const guest = S.guests.get(peerId);
  if (!guest) return;
  guest.approved = true;
  guest.name = name;

  /* Build full participant list to send */
  const pList = buildPList();

  /* Notify guest they're approved */
  try { conn.send({ type:'approved', participants:pList }); } catch(_) {}

  /* Add to host's own participant list */
  if (!S.participants.find(p=>p.peerId===peerId)) {
    S.participants.push({ peerId, name, isHost:false });
  }
  refreshParticipants();

  /* Notify ALL other guests about new member */
  broadcast({ type:'peer_in', peerId, name }, peerId);

  sysMsg(`${name} joined`);
  toast(`✅ ${name} joined`,'ok');
  beep(660,.12,.2);
}

function buildPList() {
  const list = [{ peerId:S.peer.id, name:S.myName, isHost:true }];
  S.guests.forEach((g,pid)=>{ if(g.approved) list.push({peerId:pid,name:g.name,isHost:false}); });
  return list;
}

/* ────────────────────────────────────────
   18. PARTICIPANTS PANEL
──────────────────────────────────────── */
function refreshParticipants() {
  const cnt = S.participants.length;
  D.ubadge.textContent = cnt;

  D.ppList.innerHTML = '';
  S.participants.forEach(p => {
    const isSelf = p.peerId === S.peer?.id;
    const row = document.createElement('div');
    row.className = 'pitem';
    row.innerHTML = `
      <div class="pav">${initial(p.name)}</div>
      <div class="pinfo">
        <div class="pname">${esc(p.name)}${isSelf?'<span style="font-size:.6rem;color:var(--t3);margin-left:.3rem">(You)</span>':''}</div>
        <div class="prole">${p.isHost?'👑 Host':'Participant'}</div>
      </div>
      <div class="pacts">
        ${!isSelf?`
          <button class="pact" title="Voice call" onclick="callPeer('${p.peerId}',false)"><i class="fas fa-phone"></i></button>
          <button class="pact" title="Video call" onclick="callPeer('${p.peerId}',true)"><i class="fas fa-video"></i></button>
        `:''}
        ${S.isHost && !isSelf?`<button class="pact kick" title="Remove" onclick="kickPeer('${p.peerId}')"><i class="fas fa-user-minus"></i></button>`:''}
      </div>`;
    D.ppList.appendChild(row);
  });

  /* Enable call buttons if there are other participants */
  const hasOthers = S.participants.filter(p=>p.peerId!==S.peer?.id).length > 0;
  D.btnVcall.disabled   = !hasOthers;
  D.btnVidcall.disabled = !hasOthers;
}

window.callPeer = (pid, video) => { closePanel(); startCallTo(pid, video); };
window.kickPeer = pid => {
  if (!S.isHost) return;
  const g = S.guests.get(pid);
  if (!g) return;
  try { g.conn.send({ type:'kicked' }); } catch(_) {}
  setTimeout(()=>{
    try { g.conn.close(); } catch(_) {}
    S.participants = S.participants.filter(p=>p.peerId!==pid);
    S.guests.delete(pid);
    broadcast({ type:'peer_out', peerId:pid, name:g.name });
    refreshParticipants();
    sysMsg(`${g.name} was removed`);
    toast(`${g.name} removed`,'warn');
  }, 300);
};

function openPanel()  { D.pp.classList.add('open'); D.ppOv.style.display='block'; }
function closePanel() { D.pp.classList.remove('open'); D.ppOv.style.display='none'; }

/* ────────────────────────────────────────
   19. INCOMING CONNECTION HANDLER (Host)
──────────────────────────────────────── */
function onIncomingConn(conn) {
  const pid = conn.peer;

  if (S.guests.has(pid)) {
    /* Reconnect — reuse existing slot */
    const g = S.guests.get(pid);
    g.conn = conn;
  } else {
    S.guests.set(pid, { conn, name:'?', approved:false });
  }

  conn.on('open', () => {
    /* Wait for join_req — no action needed here */
  });

  conn.on('data', data => {
    /* data arrives as an OBJECT (PeerJS json serialization) */
    handleData(data, pid);
  });

  conn.on('close', () => {
    const g = S.guests.get(pid);
    if (g?.approved) {
      const name = g.name;
      S.participants = S.participants.filter(p=>p.peerId!==pid);
      S.guests.delete(pid);
      broadcast({ type:'peer_out', peerId:pid, name });
      refreshParticipants();
      sysMsg(`${name} disconnected`);
      toast(`${name} left`,'');
    } else {
      S.guests.delete(pid);
      /* Remove from AQ if pending */
      S.aqQueue = S.aqQueue.filter(r=>r.peerId!==pid);
      if (S.aqActive) showNextAQ();
    }
    S.typingPeers.forEach(k=>{ if(k.startsWith(pid+':')) S.typingPeers.delete(k); });
    updateTypingUI();
  });

  conn.on('error', err => { console.warn('[conn err]', err.message); });
}

/* ────────────────────────────────────────
   20. HOST PEER INIT
──────────────────────────────────────── */
function startHost(roomId) {
  S.roomId = roomId;
  S.encKey = deriveKey(roomId);
  S.isHost = true;

  const peerId = `${CFG.PREFIX}-${roomId}`;
  showLoad('Creating secure room…');

  const peer = new Peer(peerId, {
    config: { iceServers:CFG.ICE, iceTransportPolicy:'all' }
  });
  S.peer = peer;

  peer.on('open', id => {
    S.retryCount = 0;
    LS.setRole('host'); LS.setMyId(id);

    /* Init participant list with self */
    S.participants = [{ peerId:id, name:S.myName, isHost:true }];

    /* Load history */
    _msgs = LS.loadMsgs();
    _msgs.forEach(renderMsg);

    hideLoad(); showScreen('chat');
    setHostUI();
    setStatus('ok', 'Room ready — waiting for guests');
    showShareBanner(roomId);
  });

  peer.on('connection', conn => onIncomingConn(conn));

  peer.on('call', call => {
    S.pendingCall = call;
    S.pendingVideo = call.metadata?.video !== false;
    const callerName = findName(call.peer);
    D.incFrom.textContent = 'from ' + callerName;
    D.incType.textContent  = S.pendingVideo ? 'Video' : 'Voice';
    D.incCall.style.display = 'flex';
    ringBeep();
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      /* Peer ID taken — retry up to MAX_RETRIES */
      if (S.retryCount < CFG.MAX_RETRIES) {
        S.retryCount++;
        showLoad(`Reconnecting… (${S.retryCount}/${CFG.MAX_RETRIES})`);
        S.retryTimer = setTimeout(()=>startHost(roomId), CFG.RETRY_DELAY);
      } else {
        showError('Room Unavailable', 'Could not reclaim this room. Please create a new one from home.');
      }
    } else {
      console.warn('[host peer err]', err.type, err.message);
    }
  });

  peer.on('disconnected', ()=>{ if(!peer.destroyed) setTimeout(()=>{ try{peer.reconnect();}catch(_){} },3000); });
}

/* ────────────────────────────────────────
   21. GUEST PEER INIT
──────────────────────────────────────── */
function startGuest(roomId) {
  S.roomId = roomId;
  S.encKey = deriveKey(roomId);
  S.isHost = false;

  /* Stable guest peer ID for reconnect */
  let myId = LS.getMyId();
  if (!myId || myId === `${CFG.PREFIX}-${roomId}`) {
    myId = `${CFG.PREFIX}-${roomId}-g-${genId(8)}`;
    LS.setMyId(myId);
  }

  showLoad('Connecting to room…');

  const peer = new Peer(myId, {
    config: { iceServers:CFG.ICE, iceTransportPolicy:'all' }
  });
  S.peer = peer;

  peer.on('open', ()=>{
    LS.setRole('guest');
    connectToHost(roomId);
  });

  peer.on('call', call => {
    S.pendingCall = call;
    S.pendingVideo = call.metadata?.video !== false;
    const callerName = findName(call.peer);
    D.incFrom.textContent = 'from ' + callerName;
    D.incType.textContent  = S.pendingVideo ? 'Video' : 'Voice';
    D.incCall.style.display = 'flex';
    ringBeep();
  });

  peer.on('error', err => {
    if (err.type === 'peer-unavailable' || err.type === 'unavailable-id') {
      /* Host peer ID not found — retry with delay */
      if (S.retryCount < CFG.MAX_RETRIES) {
        S.retryCount++;
        showLoad(`Host not found, retrying… (${S.retryCount}/${CFG.MAX_RETRIES})`);
        S.retryTimer = setTimeout(()=>{
          try{ S.peer.destroy(); }catch(_){}
          startGuest(roomId);
        }, CFG.RETRY_DELAY);
      } else {
        hideLoad();
        showError('Room Not Found',
          'Could not connect to the host. The room may not exist, or the host is offline. Try refreshing.');
      }
    } else {
      console.warn('[guest peer err]', err.type, err.message);
    }
  });

  peer.on('disconnected', ()=>{ if(!peer.destroyed) setTimeout(()=>{ try{peer.reconnect();}catch(_){} },3000); });
}

function connectToHost(roomId) {
  const hostId = `${CFG.PREFIX}-${roomId}`;
  setStatus('wait', 'Connecting…');

  const conn = S.peer.connect(hostId, { reliable:true });
  S.hostConn = conn;

  /* Timeout if connection never opens */
  const timeout = setTimeout(()=>{
    if (!conn.open) {
      if (S.retryCount < CFG.MAX_RETRIES) {
        S.retryCount++;
        showLoad(`Connection slow, retrying… (${S.retryCount}/${CFG.MAX_RETRIES})`);
        try{ conn.close(); }catch(_){}
        setTimeout(()=>connectToHost(roomId), 2000);
      } else {
        hideLoad();
        showError('Connection Timeout', 'Could not reach the host. They may be offline.');
      }
    }
  }, CFG.JOIN_TIMEOUT);

  conn.on('open', ()=>{
    clearTimeout(timeout);
    S.retryCount = 0; // reset on success
    /* Send join request */
    conn.send({ type:'join_req', name:S.myName });
    /* Show waiting screen */
    hideLoad();
    D.waitName.textContent = S.myName;
    showScreen('wait');
  });

  conn.on('data', data => {
    /* data arrives as OBJECT */
    handleData(data, `${CFG.PREFIX}-${roomId}`);
  });

  conn.on('close', ()=>{
    if ($('sc-chat').classList.contains('active')) {
      setStatus('err', 'Disconnected');
      disableInput();
      sysMsg('Connection to host was lost');
      toast('Disconnected from host.','err');
    }
  });

  conn.on('error', err => {
    clearTimeout(timeout);
    console.warn('[guest conn err]', err.message);
  });
}

/* ────────────────────────────────────────
   22. AFTER APPROVAL — enter chat room
──────────────────────────────────────── */
function onEnteredRoom() {
  hideLoad();
  showScreen('chat');
  setGuestUI();
  enableInput();
  refreshParticipants();
  const cnt = S.participants.length;
  setStatus('ok', `Connected · ${cnt} online`);

  /* Load history */
  _msgs = LS.loadMsgs();
  _msgs.forEach(renderMsg);

  const others = S.participants.filter(p=>!p.isHost).length;
  sysMsg(`You joined the room · ${cnt} ${cnt===1?'person':'people'} online`);
  toast('🔒 Secure connection established!','ok');
  beep(660,.12,.2);
}

/* ────────────────────────────────────────
   23. UI SETUP — HOST vs GUEST
──────────────────────────────────────── */
function setHostUI() {
  D.btnDestroy.style.display = 'flex';  /* Host can destroy */
  D.btnLeave.style.display   = 'none';  /* Host doesn't "leave" */
  refreshParticipants();
  enableInput();
}

function setGuestUI() {
  D.btnDestroy.style.display = 'none';  /* Guests CANNOT destroy */
  D.btnLeave.style.display   = 'flex';  /* Guests can leave */
}

function enableInput() {
  D.inpMsg.disabled = false;
  D.btnSend.disabled = false;
  D.inpMsg.focus();
}
function disableInput() {
  D.inpMsg.disabled = true;
  D.btnSend.disabled = true;
}

function showShareBanner(roomId) {
  const url = `${location.origin}${location.pathname}?room=${roomId}`;
  D.sbLink.value = url;
  D.shareBar.style.display = 'flex';
  if (navigator.share) D.btnShare.style.display = 'flex';
}

function hideShareBanner() {
  D.shareBar.style.display = 'none';
}

/* ────────────────────────────────────────
   24. CALLS
──────────────────────────────────────── */
function findName(pid) {
  if (pid === S.peer?.id) return S.myName;
  const p = S.participants.find(x=>x.peerId===pid);
  return p?.name || S.guests.get(pid)?.name || 'Unknown';
}

async function startCallTo(targetPid, video) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio:true,
      video:video?{facingMode:'user',width:{ideal:640},height:{ideal:480}}:false
    });
  } catch { toast('Camera/mic permission denied.','err'); return; }

  S.localStream = stream; S.micOn=true; S.camOn=video;
  D.vidLocal.srcObject = stream;
  D.vidArea.style.display = 'block';
  updateVidBtns();

  const name = findName(targetPid);
  D.vidLbl.textContent = `Calling ${name}…`;

  const call = S.peer.call(targetPid, stream, { metadata:{ video, callerName:S.myName } });
  if (!call) { cleanCall(); toast('Call failed.','err'); return; }
  S.activeCall = call;
  setStatus('call', `In call · ${name}`);

  call.on('stream', remote => { D.vidRemote.srcObject=remote; D.vidLbl.textContent=name; });
  call.on('close',  ()=>{ cleanCall(); sysMsg('Call ended'); });
  call.on('error',  err=>{ cleanCall(); toast('Call error: '+err.message,'err'); });
}

async function acceptCall() {
  const call = S.pendingCall; if(!call) return;
  S.pendingCall = null; D.incCall.style.display='none';
  const video = S.pendingVideo;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio:true,
      video:video?{facingMode:'user',width:{ideal:640},height:{ideal:480}}:false
    });
  } catch { toast('Permission denied.','err'); try{call.close();}catch(_){} return; }

  S.localStream=stream; S.micOn=true; S.camOn=video;
  D.vidLocal.srcObject=stream;
  D.vidArea.style.display='block';
  updateVidBtns();
  call.answer(stream);
  S.activeCall=call;
  const name=findName(call.peer);
  D.vidLbl.textContent=name;
  setStatus('call','In call · '+name);
  call.on('stream', r=>{ D.vidRemote.srcObject=r; });
  call.on('close',  ()=>{ cleanCall(); sysMsg('Call ended'); });
  call.on('error',  err=>{ cleanCall(); toast('Call error: '+err.message,'err'); });
}

function declineCall() {
  if (S.pendingCall) { try{S.pendingCall.close();}catch(_){} S.pendingCall=null; }
  D.incCall.style.display='none';
}

function endCall() { if(S.activeCall){try{S.activeCall.close();}catch(_){}} cleanCall(); sysMsg('Call ended'); }

function cleanCall() {
  if(S.localStream){S.localStream.getTracks().forEach(t=>t.stop());S.localStream=null;}
  if(S.activeCall){try{S.activeCall.close();}catch(_){}S.activeCall=null;}
  D.vidRemote.srcObject=null; D.vidLocal.srcObject=null;
  D.vidArea.style.display='none'; D.incCall.style.display='none';
  S.pendingCall=null; S.micOn=true; S.camOn=true;
  const cnt=S.participants.length;
  setStatus(cnt>0?'ok':'wait', cnt>0?`Connected · ${cnt} online`:'Room ready');
}

function toggleMic() {
  if (!S.localStream) return;
  S.micOn=!S.micOn;
  S.localStream.getAudioTracks().forEach(t=>{t.enabled=S.micOn;});
  updateVidBtns();
}
function toggleCam() {
  if (!S.localStream) return;
  S.camOn=!S.camOn;
  S.localStream.getVideoTracks().forEach(t=>{t.enabled=S.camOn;});
  updateVidBtns();
}
function updateVidBtns() {
  D.btnTmic.className='vbtn '+(S.micOn?'on':'off');
  D.btnTmic.innerHTML=`<i class="fas fa-microphone${S.micOn?'':'-slash'}"></i>`;
  D.btnTcam.className='vbtn '+(S.camOn?'on':'off');
  D.btnTcam.innerHTML=`<i class="fas fa-video${S.camOn?'':'-slash'}"></i>`;
}

/* Header call buttons — pick target if multiple participants */
function headerCall(video) {
  const others = S.participants.filter(p=>p.peerId!==S.peer?.id);
  if (others.length === 0) { toast('No one to call yet.','warn'); return; }
  if (others.length === 1) { startCallTo(others[0].peerId, video); return; }
  /* Show picker */
  D.pickSub.textContent = `Choose who to ${video?'video':'voice'} call:`;
  D.pickList.innerHTML = '';
  others.forEach(p=>{
    const d=document.createElement('div'); d.className='pitem-pick';
    d.innerHTML=`<div class="ppav">${initial(p.name)}</div><div class="ppname">${esc(p.name)}</div>`;
    d.onclick=()=>{ D.modalPick.style.display='none'; startCallTo(p.peerId,video); };
    D.pickList.appendChild(d);
  });
  D.modalPick.style.display='flex';
}

/* ────────────────────────────────────────
   25. DESTROY / LEAVE
──────────────────────────────────────── */
function cleanAll() {
  clearTimeout(S.retryTimer);
  cleanCall();
  if (S.isHost) {
    try { broadcast({ type:'room_closed' }); } catch(_) {}
    S.guests.forEach(g=>{ try{g.conn.close();}catch(_){} });
  } else {
    try { S.hostConn?.close(); } catch(_) {}
  }
  if (S.peer && !S.peer.destroyed) { try{S.peer.destroy();}catch(_){} }
}

function destroyRoom() {
  cleanAll();
  LS.wipe();
  location.href = location.pathname;
}

function leaveRoom() {
  cleanAll();
  location.href = location.pathname;
}

/* ────────────────────────────────────────
   26. COPY LINK
──────────────────────────────────────── */
function copyLink() {
  const url = D.sbLink.value;
  navigator.clipboard.writeText(url).then(()=>{
    D.btnCopy.classList.add('copied');
    D.btnCopy.innerHTML='<i class="fas fa-check"></i><span>Copied!</span>';
    setTimeout(()=>{ D.btnCopy.classList.remove('copied'); D.btnCopy.innerHTML='<i class="fas fa-copy"></i><span>Copy</span>'; },2500);
    toast('Link copied!','ok');
  }).catch(()=>{
    D.sbLink.select(); document.execCommand('copy'); toast('Copied!','ok');
  });
}

/* ────────────────────────────────────────
   27. STARTUP — route host vs guest
──────────────────────────────────────── */
function boot() {
  const params  = new URLSearchParams(location.search);
  const roomId  = params.get('room');
  const isHostP = params.get('host') === '1';

  /* ── HOST PATH (from "Create Room" navigation) ── */
  if (roomId && isHostP) {
    if (!/^[a-z0-9]{8,20}$/.test(roomId)) { showError('Invalid Room','Bad room ID.'); return; }
    const name = localStorage.getItem('sp2p_name') || 'Host';
    const approval = localStorage.getItem('sp2p_approval') !== 'false';
    S.myName = name; S.requireApproval = approval;
    startHost(roomId);
    return;
  }

  /* ── GUEST PATH (someone shared the link) ── */
  if (roomId && !isHostP) {
    if (!/^[a-z0-9]{8,20}$/.test(roomId)) { showError('Invalid Link','This link is malformed or has expired.'); return; }
    /* Show setup with join UI */
    D.hostOpts.style.display  = 'none';
    D.btnCreate.style.display = 'none';
    D.btnJoin.style.display   = 'flex';
    D.joinInfo.style.display  = 'flex';
    D.jiRoomId.textContent    = roomId;
    const saved = localStorage.getItem('sp2p_name');
    if (saved) D.inpName.value = saved;

    D.btnJoin.onclick = () => {
      const name = D.inpName.value.trim();
      if (!name) { D.inpName.focus(); toast('Please enter your name.','warn'); return; }
      localStorage.setItem('sp2p_name', name);
      S.myName = name;
      startGuest(roomId);
    };
    return;
  }

  /* ── HOME (no params) — Show host setup ── */
  D.hostOpts.style.display  = 'flex';
  D.btnCreate.style.display = 'flex';
  D.btnJoin.style.display   = 'none';
  D.joinInfo.style.display  = 'none';
  const saved = localStorage.getItem('sp2p_name');
  if (saved) D.inpName.value = saved;

  D.btnCreate.onclick = () => {
    const name = D.inpName.value.trim();
    if (!name) { D.inpName.focus(); toast('Please enter your name.','warn'); return; }
    localStorage.setItem('sp2p_name', name);
    localStorage.setItem('sp2p_approval', String(D.chkApproval.checked));
    S.myName = name;
    const newRoom = genId(10);
    location.href = `${location.pathname}?room=${newRoom}&host=1`;
  };
}

/* ────────────────────────────────────────
   28. EVENT LISTENERS
──────────────────────────────────────── */

/* Name field — Enter key triggers button */
$('inp-name').addEventListener('keydown', e=>{
  if (e.key!=='Enter') return;
  e.preventDefault();
  const btn = D.btnJoin.style.display!=='none' ? D.btnJoin : D.btnCreate;
  btn.click();
});

/* Cancel waiting */
D.btnCancel.addEventListener('click', ()=>{
  clearTimeout(S.retryTimer);
  try{S.hostConn?.close();}catch(_){}
  try{if(!S.peer?.destroyed)S.peer?.destroy();}catch(_){}
  location.href = location.pathname;
});

/* Approval queue */
D.btnApprove.addEventListener('click', ()=>processAQ(true));
D.btnReject.addEventListener('click',  ()=>processAQ(false));

/* Copy link */
D.btnCopy.addEventListener('click', copyLink);
$('btn-share').addEventListener('click', ()=>{
  navigator.share?.({ title:'Join SecureP2P Room', url:D.sbLink.value });
});

/* Participants panel */
D.btnUsers.addEventListener('click', ()=>{ D.pp.classList.contains('open')?closePanel():openPanel(); });
D.btnPpClose.addEventListener('click', closePanel);
D.ppOv.addEventListener('click', closePanel);

/* Call buttons */
D.btnVcall.addEventListener('click',   ()=>headerCall(false));
D.btnVidcall.addEventListener('click', ()=>headerCall(true));

/* Destroy / Leave */
D.btnDestroy.addEventListener('click', ()=>{ D.modalDestroy.style.display='flex'; });
D.btnLeave.addEventListener('click', ()=>{ leaveRoom(); });
D.mdNo.addEventListener('click',  ()=>{ D.modalDestroy.style.display='none'; });
D.mdYes.addEventListener('click', ()=>{ D.modalDestroy.style.display='none'; destroyRoom(); });
D.modalDestroy.addEventListener('click', e=>{ if(e.target===D.modalDestroy) D.modalDestroy.style.display='none'; });

/* Call target modal */
D.pickCancel.addEventListener('click', ()=>{ D.modalPick.style.display='none'; });
D.modalPick.addEventListener('click', e=>{ if(e.target===D.modalPick) D.modalPick.style.display='none'; });

/* Video controls */
D.btnTmic.addEventListener('click', toggleMic);
D.btnTcam.addEventListener('click', toggleCam);
D.btnEndcall.addEventListener('click', endCall);

/* Incoming call */
D.btnAccept.addEventListener('click', acceptCall);
D.btnDecline.addEventListener('click', declineCall);

/* Send message */
D.btnSend.addEventListener('click', sendText);
$('inp-msg').addEventListener('keydown', e=>{
  if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});
$('inp-msg').addEventListener('input', ()=>{
  /* Auto-resize */
  const el=D.inpMsg; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px';
  onTypingInput();
});

/* File attach */
$('inp-file').addEventListener('change', ()=>{
  const file=D.inpFile.files[0]; if(!file) return;
  if (!S.peer) { toast('Not connected.','err'); return; }
  sendFile(file);
  D.inpFile.value='';
});

/* Lightbox — close on img click */
$('lb-img').addEventListener('click', e=>e.stopPropagation());

/* Prevent double-tap zoom on iOS */
document.addEventListener('dblclick', e=>e.preventDefault(), { passive:false });

/* ────────────────────────────────────────
   START
──────────────────────────────────────── */
boot();
