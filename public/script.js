const socket = io();

// UI Screens
const screens = {
    permission: document.getElementById('permission-screen'),
    main: document.getElementById('main-screen'),
    waiting: document.getElementById('waiting-screen'),
    join: document.getElementById('join-screen'),
    frame: document.getElementById('frame-screen'),
    booth: document.getElementById('booth-screen'),
    result: document.getElementById('result-screen'),
};

// Controls & Video
const btnGrantCamera = document.getElementById('btn-grant-camera');
const btnCreateMenu = document.getElementById('btn-create-menu');
const btnJoinMenu = document.getElementById('btn-join-menu');
const btnCopyLink = document.getElementById('btn-copy-link');
const btnSubmitJoin = document.getElementById('btn-submit-join');
const shareLinkInput = document.getElementById('share-link-input');
const roomIdInput = document.getElementById('room-id-input');
const countdownOverlay = document.getElementById('countdown-overlay');
const photoCounter = document.getElementById('photo-counter');
const videoWrapper = document.getElementById('video-wrapper');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

let localStream = null;
let currentRoom = null;
let isHost = false;
let peerConnection = null;
let selectedColor = 'blue';
let capturedPhotos = [];

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Check URL query for auto-join link format
const urlParams = new URLSearchParams(window.location.search);
const urlRoomId = urlParams.get('room');

// Step 1: Camera Permission
btnGrantCamera.addEventListener('click', async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        localVideo.srcObject = localStream;
        
        if (urlRoomId) {
            // Direct link user: go straight to joining
            currentRoom = urlRoomId;
            showScreen('join');
            roomIdInput.value = urlRoomId;
            joinRoom(urlRoomId);
        } else {
            showScreen('main');
        }
    } catch (err) {
        alert('Camera access is required for the photobooth to work!');
    }
});

function showScreen(screenName) {
    Object.keys(screens).forEach(key => screens[key].classList.remove('active'));
    screens[screenName].classList.add('active');
}

// Main Menu Actions
btnCreateMenu.addEventListener('click', () => {
    isHost = true;
    const genRoomId = Math.random().toString(36).substring(2, 9);
    socket.emit('create-room', genRoomId);
});

btnJoinMenu.addEventListener('click', () => {
    isHost = false;
    showScreen('join');
});

// Host receives room data
socket.on('room-created', (roomId) => {
    currentRoom = roomId;
    const fullLink = `${window.location.origin}/?room=${roomId}`;
    shareLinkInput.value = fullLink;
    showScreen('waiting');
});

btnCopyLink.addEventListener('click', () => {
    shareLinkInput.select();
    document.execCommand('copy');
    alert('Link copied to clipboard!');
});

// Guest submits join
btnSubmitJoin.addEventListener('click', () => {
    let targetRoom = roomIdInput.value.trim();
    if(targetRoom.includes('?room=')) {
        targetRoom = targetRoom.split('?room=')[1];
    }
    if (targetRoom) {
        currentRoom = targetRoom;
        joinRoom(targetRoom);
    }
});

function joinRoom(roomId) {
    socket.emit('join-room', roomId);
}

socket.on('join-success', () => {
    setupWebRTC();
    document.getElementById('frame-status-text').innerText = "Waiting for host to select a frame color...";
    document.getElementById('guest-waiting-frame').classList.remove('hidden');
    showScreen('frame');
});

socket.on('room-error', (msg) => { alert(msg); showScreen('main'); });

// When guest joins, Host proceeds to Frame selection
socket.on('guest-joined', () => {
    setupWebRTC();
    // Host opens WebRTC Connection by creating Offer
    createOffer();
    
    document.getElementById('host-frame-options').classList.remove('hidden');
    showScreen('frame');
});

// WebRTC Signaling Logic
function setupWebRTC() {
    peerConnection = new RTCPeerConnection(rtcConfig);
    
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    
    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
    };
    
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { room: currentRoom, signal: { candidate: event.candidate } });
        }
    };
}

async function createOffer() {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { room: currentRoom, signal: { sdp: peerConnection.localDescription } });
}

socket.on('signal', async (data) => {
    if (data.signal.sdp) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
        if (peerConnection.remoteDescription.type === 'offer') {
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { room: currentRoom, signal: { sdp: peerConnection.localDescription } });
        }
    } else if (data.signal.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
    }
});

// Frame Selection Interaction (Host Side)
document.querySelectorAll('.btn-frame').forEach(button => {
    button.addEventListener('click', (e) => {
        const color = e.target.getAttribute('data-color');
        socket.emit('select-frame', { room: currentRoom, color: color });
    });
});

// Start Photobooth Session
socket.on('start-booth', (color) => {
    selectedColor = color;
    videoWrapper.className = `video-container frame-${color}`;
    showScreen('booth');
    startPhotoboothSession();
});

// Capturing 5 Photos Loop
async function startPhotoboothSession() {
    capturedPhotos = [];
    for (let i = 1; i <= 5; i++) {
        photoCounter.innerText = `Photos: ${i - 1} / 5`;
        await runCountdown(3);
        captureFrame();
    }
    photoCounter.innerText = `Photos: 5 / 5`;
    setTimeout(() => {
        generateFinalStrip();
    }, 1000);
}

function runCountdown(seconds) {
    return new Promise((resolve) => {
        let counter = seconds;
        countdownOverlay.innerText = counter;
        countdownOverlay.style.display = 'flex';
        
        const interval = setInterval(() => {
            counter--;
            if (counter > 0) {
                countdownOverlay.innerText = counter;
            } else {
                clearInterval(interval);
                countdownOverlay.style.display = 'none';
                resolve();
            }
        }, 1000);
    });
}

function captureFrame() {
    // Hidden internal canvas to snapshot current view
    const snapCanvas = document.createElement('canvas');
    const ctx = snapCanvas.getContext('2d');
    
    // Size of individual video streams inside the strip
    const vWidth = 320;
    const vHeight = 240;
    
    snapCanvas.width = vWidth * 2;
    snapCanvas.height = vHeight;
    
    // Draw Local Video (Mirrored for natural look)
    ctx.save();
    ctx.translate(vWidth, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(localVideo, 0, 0, vWidth, vHeight);
    ctx.restore();
    
    // Draw Remote Video
    ctx.drawImage(remoteVideo, vWidth, 0, vWidth, vHeight);
    
    capturedPhotos.push(snapCanvas.toDataURL('image/png'));
    
    // Flash effect
    document.body.style.background = '#ffffff';
    setTimeout(() => { document.body.style.background = '#121212'; }, 150);
}

// Generate Photobooth Strip with Color Border
function generateFinalStrip() {
    const finalCanvas = document.createElement('canvas');
    const ctx = finalCanvas.getContext('2d');
    
    const singlePhotoW = 640; // 320 * 2
    const singlePhotoH = 240;
    const margin = 25;
    const spacing = 15;
    
    finalCanvas.width = singlePhotoW + (margin * 2);
    finalCanvas.height = (singlePhotoH * 5) + (spacing * 4) + (margin * 2);
    
    // Set frame color background
    const hexColors = { blue: '#0055ff', red: '#ff3333', purple: '#aa00ff' };
    ctx.fillStyle = hexColors[selectedColor] || '#333';
    ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
    
    let loadedCount = 0;
    capturedPhotos.forEach((dataUrl, index) => {
        const img = new Image();
        img.src = dataUrl;
        img.onload = () => {
            const x = margin;
            const y = margin + (index * (singlePhotoH + spacing));
            ctx.drawImage(img, x, y, singlePhotoW, singlePhotoH);
            
            loadedCount++;
            if (loadedCount === 5) {
                finalizeDownload(finalCanvas);
            }
        };
    });
}

function finalizeDownload(canvas) {
    showScreen('result');
    const dataURL = canvas.toDataURL('image/png');
    
    // Render on screen
    document.getElementById('canvas-holder').appendChild(canvas);
    
    // Auto Trigger Download
    const downloadLink = document.createElement('a');
    downloadLink.href = dataURL;
    downloadLink.download = `photobooth-${Date.now()}.png`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
}

socket.on('peer-disconnected', () => {
    alert('Your friend disconnected. Room will reset.');
    window.location.reload();
});