// DOM Elements
const screenSetup = document.getElementById('setup-screen');
const screenChat = document.getElementById('chat-screen');
const screenError = document.getElementById('error-screen');
const statusDiv = document.getElementById('chat-status');
const waitingBox = document.getElementById('waiting-link-box');
const shareLinkText = document.getElementById('share-link');
const chatBox = document.getElementById('chat-box');
const msgInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');

// Variables
let peer = null;
let conn = null;
let chatHistory = [];
let isHost = false;

// URL থেকে Room ID বের করা
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room');

// স্ক্রিন পরিবর্তনের ফাংশন
function showScreen(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    screen.classList.add('active');
}

// স্ট্যাটাস আপডেট করার ফাংশন
function updateStatus(text, type, icon) {
    statusDiv.className = `status ${type}`;
    statusDiv.innerHTML = `<i class="fa-solid ${icon}"></i> ${text}`;
}

// ---------------- Initialization ----------------
if (roomId) {
    // রুমে প্রবেশ (URL এ Room ID আছে)
    showScreen(screenChat);
    
    // চেক করা হচ্ছে সে এই রুমের হোস্ট কি না (আগে লিংকে ঢুকে থাকলে লোকাল স্টোরেজে ডেটা থাকবে)
    if (localStorage.getItem(`host_${roomId}`) === 'true') {
        isHost = true;
    }

    initWebRTC();
} else {
    // হোম পেজ (URL এ Room ID নেই)
    showScreen(screenSetup);
}

// ---------------- Host Logic: Create Room ----------------
document.getElementById('create-btn').addEventListener('click', () => {
    // একটি নতুন ইউনিক Room ID তৈরি করা
    const newRoomId = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 6);
    
    // হোস্ট হিসেবে লোকাল স্টোরেজে মার্ক করে রাখা
    localStorage.setItem(`host_${newRoomId}`, 'true');
    
    // URL পরিবর্তন করে ওই রুমে চলে যাওয়া
    window.location.href = '?room=' + newRoomId;
});


// ---------------- WebRTC & PeerJS Logic ----------------
function initWebRTC() {
    if (isHost) {
        // হোস্ট সবসময় নির্দিষ্ট আইডি নিয়ে সার্ভারে বসবে (যাতে গেস্ট তাকে খুঁজে পায়)
        peer = new Peer(`host-${roomId}`);
        
        peer.on('open', () => {
            updateStatus('Waiting for peer...', 'waiting', 'fa-spinner fa-spin');
            
            // লিংক দেখানো
            const currentUrl = window.location.href;
            shareLinkText.innerText = currentUrl;
            waitingBox.style.display = 'block';
            
            loadHistory(); // পূর্বের চ্যাট থাকলে লোড হবে
        });

        // কেউ যুক্ত হতে চাইলে
        peer.on('connection', (incomingConn) => {
            // যদি আগে থেকেই কেউ কানেক্টেড থাকে, তবে ৩য় ব্যক্তিকে ব্লক করবে
            if (conn && conn.open) {
                incomingConn.on('open', () => {
                    incomingConn.send({ type: 'REJECT' });
                    setTimeout(() => incomingConn.close(), 500);
                });
                return;
            }
            conn = incomingConn;
            setupConnectionHandlers();
        });

    } else {
        // গেস্ট রেন্ডম আইডি নিয়ে সার্ভারে ঢুকবে
        peer = new Peer();
        
        peer.on('open', () => {
            // গেস্ট হোস্টের আইডিতে রিকোয়েস্ট পাঠাবে
            conn = peer.connect(`host-${roomId}`);
            setupConnectionHandlers();
        });
    }
}

function setupConnectionHandlers() {
    conn.on('open', () => {
        updateStatus('Connected', 'connected', 'fa-shield-check');
        waitingBox.style.display = 'none';
        msgInput.disabled = false;
        sendBtn.disabled = false;
        
        if(!isHost) loadHistory(); 
    });

    conn.on('data', (data) => {
        if (data.type === 'REJECT') {
            showScreen(screenError);
            return;
        }
        if (data.type === 'MSG') {
            displayMessage(data.text, 'peer');
            saveToHistory(data.text, 'peer');
        }
    });

    conn.on('close', () => {
        updateStatus('Peer Disconnected', 'disconnected', 'fa-circle-xmark');
        msgInput.disabled = true;
        sendBtn.disabled = true;
    });
}

// ---------------- Messaging Logic ----------------
sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
    const text = msgInput.value.trim();
    if (text && conn && conn.open) {
        // এনক্রিপ্টেড কমিউনিকেশন (WebRTC বাই-ডিফল্ট E2EE)
        conn.send({ type: 'MSG', text: text });
        displayMessage(text, 'me');
        saveToHistory(text, 'me');
        msgInput.value = '';
    }
}

function displayMessage(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    msgDiv.innerText = text;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// ---------------- Storage & Encryption ----------------
function saveToHistory(text, sender) {
    chatHistory.push({ text, sender });
    const encryptedData = CryptoJS.AES.encrypt(JSON.stringify(chatHistory), roomId).toString();
    localStorage.setItem(`chat_history_${roomId}`, encryptedData);
}

function loadHistory() {
    const encryptedData = localStorage.getItem(`chat_history_${roomId}`);
    if (encryptedData) {
        try {
            const bytes = CryptoJS.AES.decrypt(encryptedData, roomId);
            const decryptedText = bytes.toString(CryptoJS.enc.Utf8);
            if (decryptedText) {
                chatHistory = JSON.parse(decryptedText);
                chatHistory.forEach(msg => displayMessage(msg.text, msg.sender));
            }
        } catch (e) {
            console.error("Encryption mismatch or corrupted data.");
        }
    }
}

// ---------------- Extra Features ----------------
document.getElementById('copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(shareLinkText.innerText);
    const btn = document.getElementById('copy-btn');
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
    setTimeout(() => btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy Link', 2000);
});

// রুম ক্লোজ এবং ডেটা ডিলিট করা
document.getElementById('close-room-btn').addEventListener('click', () => {
    if(confirm("Are you sure you want to close this room and delete all chat history?")) {
        localStorage.removeItem(`chat_history_${roomId}`);
        localStorage.removeItem(`host_${roomId}`);
        if(conn) conn.close();
        window.location.href = '?'; // হোম পেজে রিডাইরেক্ট 
    }
});

document.getElementById('call-btn').addEventListener('click', () => {
    alert("Audio call feature integration will be implemented next.");
});
