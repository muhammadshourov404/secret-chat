// Copyright Owner : Muhammad Shourov

// DOM Elements
const screens = { setup: document.getElementById('setup-screen'), chat: document.getElementById('chat-screen'), error: document.getElementById('error-screen') };
const statusDiv = document.getElementById('chat-status');
const waitingBox = document.getElementById('waiting-link-box'), shareLinkText = document.getElementById('share-link');
const chatBox = document.getElementById('chat-box'), msgInput = document.getElementById('message-input'), sendBtn = document.getElementById('send-btn');
const attachBtn = document.getElementById('attach-btn'), fileInput = document.getElementById('file-input');
const typingInd = document.getElementById('typing-indicator');

const audioCallBtn = document.getElementById('audio-call-btn'), videoCallBtn = document.getElementById('video-call-btn');
const videoContainer = document.getElementById('video-container'), localVideo = document.getElementById('local-video'), remoteVideo = document.getElementById('remote-video');
const endCallBtn = document.getElementById('end-call-btn');

// Variables
let peer = null, conn = null, currentCall = null, localStream = null;
let chatHistory = [], isHost = false, peerRealId = null;
let typingTimeout = null;

// Routing Logic
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room');
const isGuestParam = urlParams.get('guest'); // নতুন: গেস্ট চেক করার জন্য

function showScreen(screen) { Object.values(screens).forEach(s => s.classList.remove('active')); screen.classList.add('active'); }
function updateStatus(text, type, icon) { statusDiv.className = `status ${type}`; statusDiv.innerHTML = `<i class="fa-solid ${icon}"></i> ${text}`; }

// Sound Notification
function playBeep() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.type = 'sine'; osc.frequency.setValueAtTime(800, ctx.currentTime);
        gainNode.gain.setValueAtTime(0.1, ctx.currentTime); 
        osc.connect(gainNode); gainNode.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch(e) {}
}

// ---------------- Initialization ----------------
if (roomId) {
    showScreen(screens.chat);
    // যদি একই ব্রাউজারেও টেস্ট করা হয়, লিংকে guest=true থাকলে সে হোস্ট হবে না
    if (localStorage.getItem(`host_${roomId}`) === 'true' && !isGuestParam) {
        isHost = true;
    } else {
        isHost = false;
    }
    initWebRTC();
} else { showScreen(screens.setup); }

document.getElementById('create-btn').addEventListener('click', () => {
    const newRoomId = Math.random().toString(36).substring(2, 10);
    localStorage.setItem(`host_${newRoomId}`, 'true');
    window.location.href = '?room=' + newRoomId;
});

// ---------------- WebRTC Setup ----------------
function initWebRTC() {
    // Google STUN Servers (মোবাইল ডেটা বা ওয়াইফাইয়ের মধ্যে কানেকশন নিখুঁত করার জন্য)
    const peerConfig = {
        config: {
            'iceServers': [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        }
    };

    if (isHost) {
        peer = new Peer(`host-${roomId}`, peerConfig);
        peer.on('open', () => {
            updateStatus('Waiting for partner...', 'waiting', 'fa-spinner fa-spin');
            
            // নতুন লিংক জেনারেট (সাথে guest=true যুক্ত করা হয়েছে)
            const shareUrl = window.location.origin + window.location.pathname + '?room=' + roomId + '&guest=true';
            shareLinkText.innerText = shareUrl;
            waitingBox.style.display = 'block';
            loadHistory();
        });

        peer.on('connection', (incomingConn) => {
            if (conn && conn.open) { 
                incomingConn.on('open', () => { incomingConn.send({ type: 'REJECT' }); setTimeout(() => incomingConn.close(), 500); });
                return;
            }
            conn = incomingConn;
            setupConnectionHandlers();
        });
    } else {
        peer = new Peer(peerConfig);
        peer.on('open', (id) => {
            conn = peer.connect(`host-${roomId}`, { reliable: true });
            setupConnectionHandlers();
        });
    }

    peer.on('call', (call) => {
        if(confirm("Incoming Call! Do you want to answer?")) {
            navigator.mediaDevices.getUserMedia({ video: call.metadata.type === 'video', audio: true }).then(stream => {
                localStream = stream;
                localVideo.srcObject = stream;
                call.answer(stream);
                handleCallStream(call);
            }).catch(err => alert("Camera/Microphone access denied."));
        } else {
            call.close();
        }
    });

    peer.on('error', (err) => {
        console.error(err);
        if(err.type === 'peer-unavailable') {
            updateStatus('Host is offline or invalid link', 'disconnected', 'fa-circle-xmark');
        }
    });
}

function setupConnectionHandlers() {
    conn.on('open', handleConnectionOpen);
    if (conn.open) handleConnectionOpen(); // কানেকশন অলরেডি ওপেন থাকলে ফিক্স

    conn.on('data', (data) => {
        if (data.type === 'REJECT') return showScreen(screens.error);
        if (data.type === 'HANDSHAKE') peerRealId = data.peerId;
        
        if (data.type === 'MSG') {
            playBeep();
            displayMessage(data.text, 'peer');
            saveToHistory(data.text, 'peer');
        }
        if (data.type === 'FILE') {
            playBeep();
            displayFileMessage(data.fileData, data.fileName, data.fileType, 'peer');
        }
        if (data.type === 'TYPING') {
            typingInd.style.display = data.status ? 'block' : 'none';
        }
    });

    conn.on('close', () => {
        updateStatus('Partner Offline', 'disconnected', 'fa-circle-xmark');
        [msgInput, sendBtn, attachBtn, audioCallBtn, videoCallBtn].forEach(el => el.disabled = true);
        if(currentCall) endCall();
    });
}

function handleConnectionOpen() {
    updateStatus('Connected & Secure', 'connected', 'fa-shield-check');
    waitingBox.style.display = 'none';
    
    [msgInput, sendBtn, attachBtn, audioCallBtn, videoCallBtn].forEach(el => el.disabled = false);
    
    conn.send({ type: 'HANDSHAKE', peerId: peer.id });
    if(!isHost) loadHistory(); 
}

// ---------------- Messaging & File Logic ----------------
sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

msgInput.addEventListener('input', () => {
    if(conn && conn.open) {
        conn.send({ type: 'TYPING', status: true });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => conn.send({ type: 'TYPING', status: false }), 1500);
    }
});

function sendMessage() {
    const text = msgInput.value.trim();
    if (text && conn && conn.open) {
        conn.send({ type: 'MSG', text: text });
        displayMessage(text, 'me');
        saveToHistory(text, 'me');
        msgInput.value = '';
        conn.send({ type: 'TYPING', status: false }); 
    }
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return alert("File size must be under 2MB.");
    
    const reader = new FileReader();
    reader.onload = (event) => {
        const base64Data = event.target.result;
        if (conn && conn.open) {
            conn.send({ type: 'FILE', fileName: file.name, fileType: file.type, fileData: base64Data });
            displayFileMessage(base64Data, file.name, file.type, 'me');
        }
    };
    reader.readAsDataURL(file);
});

function displayMessage(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    msgDiv.innerText = text;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function displayFileMessage(dataUrl, fileName, fileType, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    if (fileType.startsWith('image/')) {
        msgDiv.innerHTML = `<img src="${dataUrl}" alt="${fileName}"><br><small>${fileName}</small>`;
    } else {
        msgDiv.innerHTML = `<i class="fa-solid fa-file"></i> <a href="${dataUrl}" download="${fileName}" style="color: inherit;">${fileName}</a>`;
    }
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// ---------------- Storage & Encryption ----------------
function saveToHistory(text, sender) {
    chatHistory.push({ text, sender });
    const encryptedData = CryptoJS.AES.encrypt(JSON.stringify(chatHistory), roomId).toString();
    localStorage.setItem(`chat_${roomId}`, encryptedData);
}

function loadHistory() {
    const encryptedData = localStorage.getItem(`chat_${roomId}`);
    if (encryptedData) {
        try {
            const bytes = CryptoJS.AES.decrypt(encryptedData, roomId);
            const decryptedText = bytes.toString(CryptoJS.enc.Utf8);
            if (decryptedText) {
                chatHistory = JSON.parse(decryptedText);
                chatBox.innerHTML = '<div class="encryption-notice"><i class="fa-solid fa-lock"></i> All messages and calls are E2E Encrypted.</div>';
                chatHistory.forEach(msg => displayMessage(msg.text, msg.sender));
            }
        } catch (e) {}
    }
}

// ---------------- Audio & Video Call Logic ----------------
function startCall(isVideo) {
    if (!peerRealId && isHost) peerRealId = conn.peer; 
    const targetPeerId = isHost ? peerRealId : `host-${roomId}`;

    navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true }).then(stream => {
        localStream = stream;
        localVideo.srcObject = stream;
        const call = peer.call(targetPeerId, stream, { metadata: { type: isVideo ? 'video' : 'audio' } });
        handleCallStream(call);
    }).catch(err => alert("Camera/Microphone access required for calls."));
}

function handleCallStream(call) {
    currentCall = call;
    videoContainer.style.display = 'block';
    
    call.on('stream', (remoteStream) => {
        remoteVideo.srcObject = remoteStream;
    });
    call.on('close', endCall);
}

function endCall() {
    if(currentCall) currentCall.close();
    if(localStream) localStream.getTracks().forEach(track => track.stop());
    videoContainer.style.display = 'none';
    currentCall = null;
    localStream = null;
}

audioCallBtn.addEventListener('click', () => startCall(false));
videoCallBtn.addEventListener('click', () => startCall(true));
endCallBtn.addEventListener('click', endCall);

// ---------------- Extras ----------------
document.getElementById('copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(shareLinkText.innerText);
    const btn = document.getElementById('copy-btn');
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
    setTimeout(() => btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy Link', 2000);
});

document.getElementById('close-room-btn').addEventListener('click', () => {
    if(confirm("Destroy room and delete history?")) {
        localStorage.removeItem(`chat_${roomId}`);
        localStorage.removeItem(`host_${roomId}`);
        if(conn) conn.close();
        if(currentCall) endCall();
        window.location.href = '?'; 
    }
});
