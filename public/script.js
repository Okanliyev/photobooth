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
let pendingIceCandidates = []; // candidates that arrive before remoteDescription is set

const STORAGE_KEY = 'photobooth-camera-approved';
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Shared capture dimensions (also used as a safe fallback if an image fails to decode)
const PER_PHOTO_W = 900;
const PER_PHOTO_H = 600;

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

btnCopyLink.addEventListener('click', async () => {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(shareLinkInput.value);
        } else {
            // Fallback for browsers without the async Clipboard API
            shareLinkInput.select();
            document.execCommand('copy');
        }
        alert('Link copied to clipboard!');
    } catch (err) {
        // Final fallback: at least select the text so the user can copy manually
        shareLinkInput.select();
        alert('Could not copy automatically. The link is selected — press Ctrl/Cmd+C to copy.');
    }
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
    // Guard against leaking a connection if setupWebRTC() is ever called twice
    // (e.g. a stray reconnect) before the old one is torn down.
    if (peerConnection) {
        peerConnection.close();
    }
    pendingIceCandidates = [];

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
    // Signals can arrive before setupWebRTC() has run (e.g. out-of-order delivery);
    // there's nothing to apply them to yet, so just ignore them.
    if (!peerConnection) return;

    try {
        if (data.signal.sdp) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));

            // Now that the remote description is set, flush any ICE candidates
            // that arrived early and couldn't be applied yet.
            for (const candidate of pendingIceCandidates) {
                await peerConnection.addIceCandidate(candidate);
            }
            pendingIceCandidates = [];

            if (peerConnection.remoteDescription.type === 'offer') {
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit('signal', { room: currentRoom, signal: { sdp: peerConnection.localDescription } });
            }
        } else if (data.signal.candidate) {
            const candidate = new RTCIceCandidate(data.signal.candidate);
            if (peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(candidate);
            } else {
                // Remote description isn't set yet - queue it for later.
                pendingIceCandidates.push(candidate);
            }
        }
    } catch (err) {
        console.error('WebRTC signaling error:', err);
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
    snapCanvas.width = PER_PHOTO_W * 2; // two participants side-by-side
    snapCanvas.height = PER_PHOTO_H;

    // Draw Local Video (Mirrored for natural look) using cover behavior
    ctx.save();
    ctx.translate(PER_PHOTO_W, 0);
    ctx.scale(-1, 1);
    drawImageCover(ctx, localVideo, 0, 0, PER_PHOTO_W, PER_PHOTO_H);
    ctx.restore();

    // Draw Remote Video using cover behavior
    drawImageCover(ctx, remoteVideo, PER_PHOTO_W, 0, PER_PHOTO_W, PER_PHOTO_H);
    
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
        if (img.complete && img.naturalWidth > 0) {
            res();
        } else {
            img.onload = res;
            img.onerror = res; // Also resolve on error to prevent hanging
        }
    }))).then(() => {
        // Prefer the real decoded size of the first successfully-loaded image,
        // and fall back to the known capture size (matches what captureFrame()
        // actually produces) rather than an arbitrary, mismatched hardcoded size.
        const firstGood = imgs.find(img => img.naturalWidth > 0);
        const baseW = firstGood ? firstGood.naturalWidth : PER_PHOTO_W * 2;
        const baseH = firstGood ? firstGood.naturalHeight : PER_PHOTO_H;
        const count = imgs.length;

        if (count === 0) {
            // Nothing to render (all captures failed) — bail out gracefully instead
            // of producing a broken/empty canvas.
            resultCaption.textContent = 'Something went wrong capturing your photos. Please try again.';
            showScreen('result');
            return;
        }

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

function drawImageCover(ctx, source, x, y, width, height) {
    // <video> elements expose their real pixel dimensions via videoWidth/videoHeight —
    // .width/.height on a video only reflect the HTML width/height *attributes*
    // (0 here, since none are set), which would otherwise produce NaN/Infinity math.
    const isVideo = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
    const sourceW = isVideo ? source.videoWidth : source.width;
    const sourceH = isVideo ? source.videoHeight : source.height;

    if (!sourceW || !sourceH) {
        // Nothing to draw yet (e.g. remote video hasn't received a frame) — skip
        // rather than let NaN dimensions throw inside drawImage().
        return;
    }

    const scale = Math.max(width / sourceW, height / sourceH);
    const dw = sourceW * scale;
    const dh = sourceH * scale;
    const dx = x + (width - dw) / 2;
    const dy = y + (height - dh) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.drawImage(source, dx, dy, dw, dh);
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
    
    // Convert canvas to image for better display
    const dataURL = canvas.toDataURL('image/png');
    const img = document.createElement('img');
    img.src = dataURL;
    img.classList.add('result-canvas');
    img.alt = 'Photobooth strip';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.borderRadius = '18px';
    img.style.boxShadow = '0 16px 40px rgba(0,0,0,0.24)';
    img.style.display = 'block';
    img.style.margin = '0 auto';
    
    canvasHolder.appendChild(img);
}

btnDownloadResult.addEventListener('click', () => {
    const img = document.querySelector('#canvas-holder img');
    if (img) {
        const downloadLink = document.createElement('a');
        downloadLink.href = img.src;
        downloadLink.download = `photobooth-${Date.now()}.png`;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
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