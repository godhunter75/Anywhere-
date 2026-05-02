// DOM Elements
const landingState = document.getElementById('landing-state');
const chatState = document.getElementById('chat-state');
const interestsInput = document.getElementById('interests-input');
const startChatBtn = document.getElementById('start-chat-btn');
const matchingStatus = document.getElementById('matching-status');

const videoContainer = document.getElementById('video-container');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

const chatLog = document.getElementById('chat-log');
const chatMessageInput = document.getElementById('chat-message-input');
const sendBtn = document.getElementById('send-btn');
const leaveBtn = document.getElementById('leave-btn');

// State Variables
let socket;
let isMatching = false;
let currentRoom = null;
let peerConnection;
let localStream;
let isTextOnly = false;
let iceCandidateQueue = [];

// WebRTC Configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

// --- Initialization ---

function init() {
    socket = io();

    // Socket Event Listeners
    socket.on('connect', () => {
        console.log('Connected to signaling server');
    });

    socket.on('system_message', (msg) => {
        appendSystemMessage(msg.text, msg.type);
    });

    socket.on('match_found', async (data) => {
        console.log('Match found!', data);
        currentRoom = data.roomId;
        isMatching = false;
        
        // UI Transit
        showChatState();
        chatMessageInput.disabled = false;
        sendBtn.disabled = false;
        
        chatLog.innerHTML = ''; // Clear old chat log
        
        let introText = 'You are now chatting with a random stranger.';
        if (data.partnerInterests && data.partnerInterests.length > 0) {
            introText += ` You both like: ${data.partnerInterests.join(', ')}.`;
        }
        appendSystemMessage(introText);

        // WebRTC Setup
        await setupWebRTC(data.role);
    });

    socket.on('partner_disconnected', () => {
        appendSystemMessage("Stranger has disconnected. Press Leave / Next to find a new stranger.", "error");
        chatMessageInput.disabled = true;
        sendBtn.disabled = true;
        closePeerConnection();
        // Hide remote video stream safely
        if (remoteVideo.srcObject) {
            remoteVideo.srcObject = null;
        }
    });

    socket.on('chat_message', (msg) => {
        appendMessage(msg, 'incoming');
    });

    // WebRTC Signaling Events

    socket.on('webrtc_offer', async (offer) => {
        if (!peerConnection) return;
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('webrtc_answer', answer);
            
            // Process any queued candidates
            while (iceCandidateQueue.length > 0) {
                const c = iceCandidateQueue.shift();
                await peerConnection.addIceCandidate(c);
            }
        } catch (e) {
            console.error('Error handling offer', e);
        }
    });

    socket.on('webrtc_answer', async (answer) => {
        if (!peerConnection) return;
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            
            // Process any queued candidates
            while (iceCandidateQueue.length > 0) {
                const c = iceCandidateQueue.shift();
                await peerConnection.addIceCandidate(c);
            }
        } catch (e) {
            console.error('Error handling answer', e);
        }
    });

    socket.on('webrtc_ice_candidate', async (candidate) => {
        if (!peerConnection) return;
        try {
            const rtcCandidate = new RTCIceCandidate(candidate);
            if (peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(rtcCandidate);
            } else {
                iceCandidateQueue.push(rtcCandidate);
            }
        } catch (e) {
            console.error('Error adding received ice candidate', e);
        }
    });

    // UI Event Listeners
    startChatBtn.addEventListener('click', startMatching);
    
    // Allow enter key for interests to start matching
    interestsInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') startMatching();
    });

    sendBtn.addEventListener('click', sendMessage);
    chatMessageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    leaveBtn.addEventListener('click', leaveChat);
    
    // Global ESC key to leave/next
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && currentRoom) {
            leaveChat();
        }
    });
}

// --- Matching Logic ---

async function startMatching() {
    if (isMatching) return;
    
    const interests = interestsInput.value.trim();
    
    // Change UI state to matching
    isMatching = true;
    startChatBtn.disabled = true;
    interestsInput.disabled = true;
    matchingStatus.classList.remove('hidden');

    // Get Media Permissions upfront if possible, before entering pool
    if (!localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideo.srcObject = localStream;
            videoContainer.classList.remove('hidden');
            isTextOnly = false;
        } catch (err) {
            console.warn('Media devices denied or not available. Reverting to text-only mode.', err);
            isTextOnly = true;
            videoContainer.classList.add('hidden');
        }
    }

    socket.emit('find_match', { interests });
}

function leaveChat() {
    socket.emit('leave_chat');
    currentRoom = null;
    closePeerConnection();
    
    if (remoteVideo.srcObject) {
        remoteVideo.srcObject = null;
    }

    // Go back to matching instantly (acting as Next)
    showLandingState();
    startMatching();
}

// --- WebRTC Logic ---

async function setupWebRTC(role) {
    // Reset queue for new connection
    iceCandidateQueue = [];
    
    // Create new RTCPeerConnection
    peerConnection = new RTCPeerConnection(rtcConfig);

    // ICE Candidate handler
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', event.candidate);
        }
    };

    // Remote stream handler
    peerConnection.ontrack = (event) => {
        console.log('Received remote track');
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            videoContainer.classList.remove('hidden'); // Ensure video is visible if we receive streams
        }
    };

    // Add local tracks to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    // Signaling Role Logic
    if (role === 'initiator') {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('webrtc_offer', offer);
        } catch (e) {
            console.error('Error creating offer', e);
        }
    }
}

function closePeerConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
}

// --- Chat & UI Logic ---

function sendMessage() {
    const text = chatMessageInput.value.trim();
    if (!text || text.length === 0) return;

    // Output optimistically
    appendMessage({ text: text }, 'outgoing');
    
    // Send to server
    socket.emit('chat_message', { text: text });
    
    chatMessageInput.value = '';
    
    // Prevent immediate re-send
    sendBtn.disabled = true;
    setTimeout(() => {
        if (currentRoom) sendBtn.disabled = false;
    }, 200); 
}

function appendMessage(msg, type) {
    const container = document.createElement('div');
    container.className = `msg-container ${type}`;
    
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    
    // basic sanitization to prevent raw HTML injection
    bubble.textContent = msg.text;
    
    container.appendChild(bubble);
    chatLog.appendChild(container);
    
    scrollToBottom();
}

function appendSystemMessage(text, type = 'info') {
    const el = document.createElement('div');
    el.className = `system-msg ${type === 'error' ? 'error' : ''}`;
    el.textContent = text;
    chatLog.appendChild(el);
    scrollToBottom();
}

function scrollToBottom() {
    chatLog.scrollTop = chatLog.scrollHeight;
}

function showLandingState() {
    landingState.classList.add('active');
    landingState.classList.remove('hidden');
    
    chatState.classList.add('hidden');
    chatState.classList.remove('active');
    
    startChatBtn.disabled = false;
    interestsInput.disabled = false;
    matchingStatus.classList.add('hidden');
    isMatching = false;
}

function showChatState() {
    landingState.classList.remove('active');
    landingState.classList.add('hidden');
    
    chatState.classList.remove('hidden');
    chatState.classList.add('active');
    
    chatMessageInput.focus();
}

// Start application
window.onload = init;
