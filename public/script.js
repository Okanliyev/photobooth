const socket = io();

// UI Screens
const screens = {
    permission: document.getElementById('permission-screen'),
    main: document.getElementById('main-screen'),
    waiting: document.getElementById('waiting-screen'),
    join: document.getElementById('join-screen'),
    photoCount: document.getElementById('photo-count-screen'),
    frame: document.getElementById('frame-screen'),
    booth: document.getElementById('booth-screen'),
    result: document.getElementById('result-screen'),
};

// Controls & Video
const btnGrantCamera = document.getElementById('btn-grant-camera');
const btnRetryCamera = document.getElementById('btn-retry-camera');
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
const cameraStatus = document.getElementById('camera-status');
const btnRetake = document.getElementById('btn-retake');
const btnDownloadResult = document.getElementById('btn-download-result');
const resultCaption = document.getElementById('result-caption');
const boothAnimation = document.getElementById('booth-animation');

let localStream = null;
let currentRoom = null;
let isHost = false;
let peerConnection = null;
let selectedColor = 'blue';
let selectedPhotoCount = 5;
let capturedPhotos = [];
let sessionReadyState = { hostReady: false, guestReady: false };

const STORAGE_KEY = 'photobooth-camera-approved';
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Check URL query for auto-join link format
const urlParams = new URLSearchParams(window.location.search);
const urlRoomId = urlParams.get('room');

function hasCameraApproval() {
    return localStorage.getItem(STORAGE_KEY) === 'true';
}

function markCameraApproved() {
    localStorage.setItem(STORAGE_KEY, 'true');
}

function clearCameraApproval() {
    localStorage.removeItem(STORAGE_KEY);
}

async function requestCameraAccess(onSuccess) {
    cameraStatus.textContent = 'Connecting to your camera...';
    btnGrantCamera.disabled = true;
    btnRetryCamera.disabled = true;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        localVideo.srcObject = localStream;
        markCameraApproved();
        cameraStatus.textContent = 'Camera ready. Let’s create your memory.';

        if (typeof onSuccess === 'function') {
            onSuccess();
        }
    } catch (err) {
        cameraStatus.textContent = 'Camera access was blocked. Please allow it and try again.';
    } finally {
        btnGrantCamera.disabled = false;
        btnRetryCamera.disabled = false;
    }
}

function continueToMainScreen() {
    if (hasCameraApproval() && !localStream) {
        requestCameraAccess(() => {
            if (urlRoomId) {
                currentRoom = urlRoomId;
                showScreen('join');
                roomIdInput.value = urlRoomId;
                joinRoom(urlRoomId);
            } else {
                showScreen('main');
            }
        });
        return;
    }

    if (!localStream) {
        showScreen('permission');
        return;
    }

    if (urlRoomId) {
        currentRoom = urlRoomId;
        showScreen('join');
        roomIdInput.value = urlRoomId;
        joinRoom(urlRoomId);
        return;
    }

    showScreen('main');
}

btnGrantCamera.addEventListener('click', () => {
    requestCameraAccess(() => {
        if (urlRoomId) {
            currentRoom = urlRoomId;
            showScreen('join');
            roomIdInput.value = urlRoomId;
            joinRoom(urlRoomId);
        } else {
            showScreen('main');
        }
    });
});

btnRetryCamera.addEventListener('click', () => {
    requestCameraAccess(() => {
        showScreen('main');
    });
});

function showScreen(screenName) {
    Object.keys(screens).forEach(key => screens[key].classList.remove('active'));
    screens[screenName].classList.add('active');
}

// Main Menu Actions
btnCreateMenu.addEventListener('click', async () => {
    if (!localStream) {
        await requestCameraAccess(() => {
            isHost = true;
            const genRoomId = Math.random().toString(36).substring(2, 9);
            socket.emit('create-room', genRoomId);
        });
        return;
    }

    isHost = true;
    const genRoomId = Math.random().toString(36).substring(2, 9);
    socket.emit('create-room', genRoomId);
});

btnJoinMenu.addEventListener('click', async () => {
    if (!localStream) {
        await requestCameraAccess(() => {
            isHost = false;
            showScreen('join');
        });
        return;
    }

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

// When guest joins, Host proceeds to Photo Count selection
socket.on('guest-joined', () => {
    setupWebRTC();
    // Host opens WebRTC Connection by creating Offer
    createOffer();
    
    showScreen('photoCount');
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

// Photo Count Selection (Host Side)
document.querySelectorAll('.btn-count').forEach(button => {
    button.addEventListener('click', (e) => {
        selectedPhotoCount = parseInt(e.target.getAttribute('data-count'), 10);
        document.getElementById('host-frame-options').classList.remove('hidden');
        showScreen('frame');
    });
});

function resetSessionReadyState() {
    sessionReadyState = { hostReady: false, guestReady: false };
}

// Start Photobooth Session
socket.on('start-booth', (color) => {
    selectedColor = color;
    videoWrapper.className = `video-container frame-${color}`;
    resetSessionReadyState();
    showScreen('booth');
    setTimeout(() => {
        startPhotoboothSession();
    }, 900);
});

socket.on('begin-session', () => {
    showScreen('booth');
    setTimeout(() => {
        startPhotoboothSession();
    }, 900);
});

// Capturing Photos Loop (flexible count)
async function startPhotoboothSession() {
    capturedPhotos = [];
    for (let i = 1; i <= selectedPhotoCount; i++) {
        photoCounter.innerText = `Photos: ${i} / ${selectedPhotoCount}`;
        await runCountdown(3);
        captureFrame();
    }
    photoCounter.innerText = `Photos: ${selectedPhotoCount} / ${selectedPhotoCount}`;
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
    boothAnimation.classList.remove('hidden');
    setTimeout(() => boothAnimation.classList.add('hidden'), 600);

    // Hidden internal canvas to snapshot current view
    const snapCanvas = document.createElement('canvas');
    const ctx = snapCanvas.getContext('2d');
    
    // Capture at fixed 3:2 aspect ratio per participant (width:height = 3:2)
    // Use reasonably high resolution for good output while keeping memory in check
    const perPhotoW = 900; // width for each participant capture
    const perPhotoH = 600; // height for each participant capture (3:2)

    snapCanvas.width = perPhotoW * 2; // two participants side-by-side
    snapCanvas.height = perPhotoH;

    // Draw Local Video (Mirrored for natural look) using cover behavior
    ctx.save();
    ctx.translate(perPhotoW, 0);
    ctx.scale(-1, 1);
    drawImageCover(ctx, localVideo, 0, 0, perPhotoW, perPhotoH);
    ctx.restore();

    // Draw Remote Video using cover behavior
    drawImageCover(ctx, remoteVideo, perPhotoW, 0, perPhotoW, perPhotoH);
    
    capturedPhotos.push(snapCanvas.toDataURL('image/png'));
    
    // Flash effect
    document.body.style.background = '#ffffff';
    setTimeout(() => { document.body.style.background = '#121212'; }, 150);
}

// Generate Photobooth Strip with Color Border
function generateFinalStrip() {
    const finalCanvas = document.createElement('canvas');
    const ctx = finalCanvas.getContext('2d');

    const margin = 24;
    const spacing = 18;

    // Load all images first to get real dimensions (use first image as base width)
    const imgs = capturedPhotos.map(url => {
        const img = new Image();
        img.src = url;
        return img;
    });

    Promise.all(imgs.map(img => new Promise(res => { 
        if (img.complete) {
            res();
        } else {
            img.onload = res;
            img.onerror = res; // Also resolve on error to prevent hanging
        }
    }))).then(() => {
        const baseW = imgs[0]?.width || 640;
        const baseH = imgs[0]?.height || 240;
        const count = imgs.length;

        const singlePhotoW = baseW;
        const singlePhotoH = baseH;

        finalCanvas.width = singlePhotoW + (margin * 2);
        finalCanvas.height = (singlePhotoH * count) + (spacing * (count - 1)) + (margin * 2);

        const hexColors = { blue: '#0055ff', red: '#ff3333', purple: '#aa00ff', black: '#111111', white: '#f5f5f5' };
        const frameColor = hexColors[selectedColor] || '#333';

        // Fill the frame color as the dominant background
        ctx.fillStyle = frameColor;
        ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

        // Draw all images and their white card backgrounds
        imgs.forEach((img, index) => {
            const x = margin;
            const y = margin + (index * (singlePhotoH + spacing));
            const cardW = singlePhotoW;
            const cardH = singlePhotoH;

            // white card inset to create border effect
            const inset = 10;
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
            ctx.shadowBlur = 10;
            ctx.shadowOffsetY = 4;
            ctx.fillRect(x + inset, y + inset, cardW - (inset * 2), cardH - (inset * 2));
            ctx.restore();

            // draw image using 'cover' behavior and clip to the white card area
            drawImageCover(ctx, img, x + inset, y + inset, cardW - (inset * 2), cardH - (inset * 2));
        });

        // After all drawing is done, finalize the download
        finalizeDownload(finalCanvas);
    });
}

function drawImageCover(ctx, img, x, y, width, height) {
    const scale = Math.max(width / img.width, height / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = x + (width - dw) / 2;
    const dy = y + (height - dh) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
}

function drawImagePreserveAspect(ctx, img, x, y, width, height) {
    const imageAspect = img.width / img.height;
    const boxAspect = width / height;

    let drawWidth = width;
    let drawHeight = height;

    if (imageAspect > boxAspect) {
        drawHeight = height;
        drawWidth = height * imageAspect;
    } else {
        drawWidth = width;
        drawHeight = width / imageAspect;
    }

    const offsetX = x + (width - drawWidth) / 2;
    const offsetY = y + (height - drawHeight) / 2;
    ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
}

function downloadCanvas(canvas) {
    const dataURL = canvas.toDataURL('image/png');
    const downloadLink = document.createElement('a');
    downloadLink.href = dataURL;
    downloadLink.download = `photobooth-${Date.now()}.png`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
}

function finalizeDownload(canvas) {
    showScreen('result');
    resultCaption.textContent = 'Your photobooth strip is ready. Download it whenever you like.';
    const canvasHolder = document.getElementById('canvas-holder');
    canvasHolder.innerHTML = '';
    
    // Ensure canvas is properly styled and displayed
    canvas.classList.add('result-canvas');
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';
    
    canvasHolder.appendChild(canvas);
}

btnDownloadResult.addEventListener('click', () => {
    const canvas = document.querySelector('#canvas-holder canvas');
    if (canvas) {
        downloadCanvas(canvas);
    }
});

btnRetake.addEventListener('click', () => {
    capturedPhotos = [];
    document.getElementById('canvas-holder').innerHTML = '';
    if (currentRoom) {
        socket.emit('start-session-request', { room: currentRoom, action: 'retake' });
    } else {
        showScreen('main');
    }
});

socket.on('peer-disconnected', () => {
    alert('Your friend disconnected. Room will reset.');
    window.location.reload();
});

continueToMainScreen();