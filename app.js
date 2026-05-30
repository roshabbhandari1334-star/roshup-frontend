/* ════════════════════════════════════════════════════════════════
   RoshUP — app.js
   Full client logic: ID management, Socket.io signaling, WebRTC
   ════════════════════════════════════════════════════════════════ */

'use strict';

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// ⚠️  After deploying backend, replace this URL with your Railway/Render URL
const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001'
  : 'https://roshup-backend.up.railway.app'; // <-- UPDATE THIS after Railway deploy

const STUN_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ─── STATE ──────────────────────────────────────────────────────────────────
const state = {
  myId: null,
  peerId: null,
  socket: null,
  pc: null,           // RTCPeerConnection
  dataChannel: null,  // RTCDataChannel for chat
  localStream: null,  // MediaStream (audio/video)
  isConnected: false,
  isInCall: false,
  callTimer: null,
  callSeconds: 0,
  audioContext: null,
  analyser: null,
  animFrameId: null,
  isMuted: false,
  isCamOff: false,
  activeTab: 'chat',
};

// ─── DOM REFS ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dom = {
  myIdDisplay:      $('my-id-display'),
  copyBtn:          $('copy-btn'),
  statusBadge:      $('status-badge'),
  statusDot:        $('status-dot'),
  statusText:       $('status-text'),
  serverDot:        $('server-dot'),
  serverStatusText: $('server-status-text'),
  peerInfo:         $('peer-info'),
  peerIdDisplay:    $('peer-id-display'),
  idHeroCard:       $('id-hero-card'),

  connectPanel:     $('connect-panel'),
  targetIdInput:    $('target-id-input'),
  connectBtn:       $('connect-btn'),

  incomingModal:    $('incoming-modal'),
  callerIdDisplay:  $('caller-id-display'),
  acceptBtn:        $('accept-btn'),
  declineBtn:       $('decline-btn'),

  commPanel:        $('comm-panel'),
  disconnectRow:    $('disconnect-row'),
  disconnectBtn:    $('disconnect-btn'),

  // Chat
  chatMessages:     $('chat-messages'),
  chatInput:        $('chat-input'),
  sendBtn:          $('send-btn'),

  // Voice
  voiceCallPeerName: $('voice-call-peer-name'),
  callTimer:        $('call-timer'),
  callAvatar:       $('call-avatar'),
  waveformCanvas:   $('waveform-canvas'),
  startCallBtn:     $('start-call-btn'),
  endCallBtn:       $('end-call-btn'),
  muteBtnVoice:     $('mute-btn-voice'),

  // Video
  localVideo:       $('local-video'),
  remoteVideo:      $('remote-video'),
  videoPlaceholder: $('video-placeholder'),
  startVideoBtn:    $('start-video-btn'),
  endVideoBtn:      $('end-video-btn'),
  muteBtnVideo:     $('mute-btn-video'),
  camToggleBtn:     $('cam-toggle-btn'),

  toastContainer:   $('toast-container'),
};

// ════════════════════════════════════════════════════════════════
// ID GENERATION
// ════════════════════════════════════════════════════════════════

function generateId() {
  const rand = (n) => Math.floor(Math.random() * n).toString().padStart(n.toString().length, '0');
  const part1 = Math.floor(10000000 + Math.random() * 90000000).toString(); // 8 digits
  const part2 = Math.floor(10000 + Math.random() * 90000).toString();       // 5 digits
  return `${part1}/${part2}`;
}

function getOrCreateId() {
  let id = localStorage.getItem('roshup_id');
  if (!id || !/^\d{8}\/\d{5}$/.test(id)) {
    id = generateId();
    localStorage.setItem('roshup_id', id);
  }
  return id;
}

// ════════════════════════════════════════════════════════════════
// SOCKET.IO CONNECTION
// ════════════════════════════════════════════════════════════════

function initSocket() {
  state.socket = io(BACKEND_URL, {
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 10000,
  });

  const s = state.socket;

  s.on('connect', () => {
    console.log('[Socket] Connected:', s.id);
    updateServerStatus(true);
    s.emit('register', state.myId);
  });

  s.on('registered', ({ activeUsers }) => {
    console.log('[Socket] Registered. Active users:', activeUsers);
  });

  s.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', reason);
    updateServerStatus(false);
  });

  s.on('connect_error', (err) => {
    console.warn('[Socket] Connect error:', err.message);
    updateServerStatus(false);
  });

  // ── Signaling Events ─────────────────────────────────────────
  s.on('connect-request', ({ fromId }) => {
    showIncomingModal(fromId);
  });

  s.on('connect-response', ({ fromId, accepted, reason }) => {
    if (accepted) {
      state.peerId = fromId;
      toast('info', '🔗', `${formatId(fromId)} accepted your request`);
      onPairingAccepted(true); // we are the initiator
    } else {
      const msg = reason || 'Request declined';
      toast('error', '❌', msg);
      setStatus('waiting');
      dom.connectBtn.disabled = false;
    }
  });

  s.on('offer', async ({ fromId, offer }) => {
    state.peerId = fromId;
    await handleOffer(offer);
  });

  s.on('answer', async ({ answer }) => {
    if (state.pc && state.pc.signalingState !== 'stable') {
      await state.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  });

  s.on('ice-candidate', async ({ candidate }) => {
    if (state.pc && candidate) {
      try {
        await state.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('ICE candidate error:', e);
      }
    }
  });

  s.on('peer-hangup', ({ fromId }) => {
    toast('info', '📴', `${formatId(fromId)} ended the call`);
    cleanupCall();
  });

  s.on('peer-disconnected', ({ userId }) => {
    if (userId === state.peerId) {
      toast('error', '⚡', `${formatId(userId)} disconnected`);
      handlePeerDisconnect();
    }
  });
}

// ════════════════════════════════════════════════════════════════
// WebRTC PEER CONNECTION
// ════════════════════════════════════════════════════════════════

function createPeerConnection() {
  if (state.pc) {
    state.pc.close();
  }

  const pc = new RTCPeerConnection(STUN_CONFIG);
  state.pc = pc;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && state.peerId) {
      state.socket.emit('ice-candidate', { toId: state.peerId, candidate });
    }
  };

  pc.ontrack = (event) => {
    console.log('[WebRTC] Remote track received:', event.track.kind);
    const stream = event.streams[0];
    if (!stream) return;

    if (event.track.kind === 'audio') {
      // Remote audio — play it
      if (!dom.remoteVideo.srcObject) {
        const audioEl = document.getElementById('remote-audio') || (() => {
          const el = document.createElement('audio');
          el.id = 'remote-audio';
          el.autoplay = true;
          el.style.display = 'none';
          document.body.appendChild(el);
          return el;
        })();
        audioEl.srcObject = stream;
      }
    }

    if (event.track.kind === 'video') {
      dom.remoteVideo.srcObject = stream;
      dom.remoteVideo.style.display = 'block';
      dom.videoPlaceholder.style.display = 'none';
    }
  };

  pc.ondatachannel = (event) => {
    state.dataChannel = event.channel;
    setupDataChannel(state.dataChannel);
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      setStatus('connected');
      showCommPanel();
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      handlePeerDisconnect();
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[WebRTC] ICE state:', pc.iceConnectionState);
  };

  return pc;
}

function setupDataChannel(channel) {
  channel.onopen = () => {
    console.log('[DataChannel] Open');
    addSystemMessage('Secure channel established — messages are end-to-end encrypted');
  };

  channel.onclose = () => {
    console.log('[DataChannel] Closed');
  };

  channel.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg.text, 'remote', msg.time);
    } catch (e) {
      appendMessage(event.data, 'remote', formatTime(new Date()));
    }
  };

  channel.onerror = (err) => {
    console.error('[DataChannel] Error:', err);
  };
}

// ── Initiator flow ─────────────────────────────────────────────
async function onPairingAccepted(isInitiator) {
  setStatus('connecting');
  const pc = createPeerConnection();

  if (isInitiator) {
    // Create data channel BEFORE offer
    const dc = pc.createDataChannel('chat', { ordered: true });
    state.dataChannel = dc;
    setupDataChannel(dc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket.emit('offer', { toId: state.peerId, offer: pc.localDescription });
    } catch (err) {
      console.error('[WebRTC] Offer error:', err);
      toast('error', '⚠️', 'Failed to initiate WebRTC connection');
    }
  }
}

// ── Callee flow ────────────────────────────────────────────────
async function handleOffer(offer) {
  setStatus('connecting');
  const pc = createPeerConnection();

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.socket.emit('answer', { toId: state.peerId, answer: pc.localDescription });
  } catch (err) {
    console.error('[WebRTC] Answer error:', err);
    toast('error', '⚠️', 'Failed to respond to WebRTC offer');
  }
}

// ════════════════════════════════════════════════════════════════
// MEDIA — VOICE & VIDEO
// ════════════════════════════════════════════════════════════════

async function startVoiceCall() {
  if (!state.pc || !state.isConnected) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.localStream = stream;

    stream.getTracks().forEach(track => state.pc.addTrack(track, stream));

    // Renegotiate
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    state.socket.emit('offer', { toId: state.peerId, offer: state.pc.localDescription });

    dom.startCallBtn.style.display = 'none';
    dom.endCallBtn.style.display = 'flex';
    dom.muteBtnVoice.disabled = false;
    dom.callAvatar.classList.add('active');

    state.isInCall = true;
    startCallTimer();
    setupWaveform(stream);

    toast('success', '🎤', 'Voice call started');
  } catch (err) {
    console.error('Media error:', err);
    if (err.name === 'NotAllowedError') {
      toast('error', '🚫', 'Microphone permission denied');
    } else {
      toast('error', '⚠️', 'Could not access microphone');
    }
  }
}

async function startVideoCall() {
  if (!state.pc || !state.isConnected) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    state.localStream = stream;

    dom.localVideo.srcObject = stream;
    dom.localVideo.style.display = 'block';

    stream.getTracks().forEach(track => state.pc.addTrack(track, stream));

    // Renegotiate
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    state.socket.emit('offer', { toId: state.peerId, offer: state.pc.localDescription });

    dom.startVideoBtn.style.display = 'none';
    dom.endVideoBtn.style.display = 'flex';
    dom.muteBtnVideo.disabled = false;
    dom.camToggleBtn.disabled = false;

    state.isInCall = true;
    toast('success', '📹', 'Video call started');
  } catch (err) {
    console.error('Media error:', err);
    if (err.name === 'NotAllowedError') {
      toast('error', '🚫', 'Camera/microphone permission denied');
    } else {
      toast('error', '⚠️', 'Could not access camera or microphone');
    }
  }
}

function cleanupCall() {
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }

  dom.localVideo.srcObject = null;
  dom.remoteVideo.srcObject = null;
  dom.localVideo.style.display = 'none';
  dom.remoteVideo.style.display = 'none';
  dom.videoPlaceholder.style.display = 'flex';

  dom.startCallBtn.style.display = 'flex';
  dom.endCallBtn.style.display = 'none';
  dom.startVideoBtn.style.display = 'flex';
  dom.endVideoBtn.style.display = 'none';

  dom.callAvatar.classList.remove('active');
  stopCallTimer();
  stopWaveform();

  state.isInCall = false;
  state.isMuted = false;
  state.isCamOff = false;

  updateMuteUI(false, 'voice');
  updateMuteUI(false, 'video');
}

// ── Mute / Camera toggle ───────────────────────────────────────
function toggleMute(context) {
  if (!state.localStream) return;
  const audioTrack = state.localStream.getAudioTracks()[0];
  if (!audioTrack) return;

  state.isMuted = !state.isMuted;
  audioTrack.enabled = !state.isMuted;
  updateMuteUI(state.isMuted, context);
}

function updateMuteUI(muted, context) {
  const btn = context === 'voice' ? dom.muteBtnVoice : dom.muteBtnVideo;
  btn.innerHTML = muted ? '🔇' : '🎙️';
  btn.title = muted ? 'Unmute' : 'Mute';
  btn.classList.toggle('muted', muted);
}

function toggleCamera() {
  if (!state.localStream) return;
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (!videoTrack) return;

  state.isCamOff = !state.isCamOff;
  videoTrack.enabled = !state.isCamOff;
  dom.camToggleBtn.innerHTML = state.isCamOff ? '📷' : '📹';
  dom.camToggleBtn.classList.toggle('muted', state.isCamOff);
}

// ────────────────────────────────────────────────────────────────
// WAVEFORM VISUALIZER
// ────────────────────────────────────────────────────────────────

function setupWaveform(stream) {
  try {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioContext.createMediaStreamSource(stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 256;
    source.connect(state.analyser);
    drawWaveform();
  } catch (e) {
    console.warn('Waveform setup failed:', e);
  }
}

function drawWaveform() {
  if (!state.analyser || !dom.waveformCanvas) return;

  const canvas = dom.waveformCanvas;
  const ctx = canvas.getContext('2d');
  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  // DPI-aware sizing
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;

  function draw() {
    state.animFrameId = requestAnimationFrame(draw);
    state.analyser.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, W, H);

    const barWidth = (W / bufferLength) * 2.2;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * (H * 0.85);
      const hue = 180 + (dataArray[i] / 255) * 60; // cyan to blue
      const alpha = 0.6 + (dataArray[i] / 255) * 0.4;

      ctx.fillStyle = `hsla(${hue}, 100%, 60%, ${alpha})`;

      const yPos = (H - barHeight) / 2;
      ctx.beginPath();
      ctx.roundRect(x, yPos, barWidth - 1, barHeight, 2);
      ctx.fill();

      x += barWidth + 1;
    }
  }

  draw();
}

function stopWaveform() {
  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
    state.analyser = null;
  }
  // Clear canvas
  const canvas = dom.waveformCanvas;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// ────────────────────────────────────────────────────────────────
// CALL TIMER
// ────────────────────────────────────────────────────────────────

function startCallTimer() {
  state.callSeconds = 0;
  updateTimerDisplay();
  state.callTimer = setInterval(() => {
    state.callSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function stopCallTimer() {
  clearInterval(state.callTimer);
  state.callTimer = null;
  state.callSeconds = 0;
  if (dom.callTimer) dom.callTimer.textContent = '';
}

function updateTimerDisplay() {
  const m = Math.floor(state.callSeconds / 60).toString().padStart(2, '0');
  const s = (state.callSeconds % 60).toString().padStart(2, '0');
  if (dom.callTimer) dom.callTimer.textContent = `${m}:${s}`;
}

// ════════════════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════════════════

function setStatus(status) {
  const badge = dom.statusBadge;
  badge.className = `status-badge ${status}`;

  const labels = {
    waiting:    'Waiting',
    connecting: 'Connecting...',
    connected:  'Connected',
    declined:   'Declined',
  };

  dom.statusText.textContent = labels[status] || status;
  state.isConnected = status === 'connected';
}

function updateServerStatus(online) {
  dom.serverDot.className = `server-dot ${online ? 'online' : ''}`;
  dom.serverStatusText.textContent = online ? 'Online' : 'Offline';
}

function showIncomingModal(fromId) {
  dom.callerIdDisplay.textContent = fromId;
  dom.incomingModal.classList.add('visible');

  // Store for accept/decline handlers
  dom.incomingModal.dataset.fromId = fromId;
}

function hideIncomingModal() {
  dom.incomingModal.classList.remove('visible');
}

function showCommPanel() {
  dom.commPanel.style.display = 'flex';
  requestAnimationFrame(() => {
    dom.commPanel.classList.add('visible');
  });

  dom.connectPanel.classList.add('hidden');
  dom.disconnectRow.classList.add('visible');
  dom.idHeroCard.classList.add('connected');

  dom.peerInfo.classList.add('visible');
  dom.peerIdDisplay.textContent = state.peerId;
  dom.voiceCallPeerName.textContent = state.peerId;
}

function hideCommPanel() {
  dom.commPanel.classList.remove('visible');
  setTimeout(() => {
    dom.commPanel.style.display = 'none';
  }, 500);

  dom.connectPanel.classList.remove('hidden');
  dom.disconnectRow.classList.remove('visible');
  dom.idHeroCard.classList.remove('connected');
  dom.peerInfo.classList.remove('visible');
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tabName}`);
  });
}

// ─── Chat UI ──────────────────────────────────────────────────
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(text, direction, timeStr) {
  // Remove empty state
  const empty = dom.chatMessages.querySelector('.chat-empty');
  if (empty) empty.remove();

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${direction}`;

  const msgText = document.createElement('div');
  msgText.className = 'message-text';
  msgText.textContent = text;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = timeStr || formatTime(new Date());

  bubble.appendChild(msgText);
  bubble.appendChild(meta);
  dom.chatMessages.appendChild(bubble);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  dom.chatMessages.appendChild(el);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function sendChatMessage() {
  const text = dom.chatInput.value.trim();
  if (!text) return;
  if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
    toast('error', '⚠️', 'Chat channel not ready');
    return;
  }

  const timeStr = formatTime(new Date());
  const payload = JSON.stringify({ text, time: timeStr });

  try {
    state.dataChannel.send(payload);
    appendMessage(text, 'own', timeStr);
    dom.chatInput.value = '';
    dom.chatInput.style.height = '44px';
  } catch (err) {
    console.error('Send error:', err);
    toast('error', '⚠️', 'Failed to send message');
  }
}

// ─── Toast Notifications ──────────────────────────────────────
function toast(type, icon, message) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${message}</span>`;
  dom.toastContainer.appendChild(el);

  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ─── Copy ID ──────────────────────────────────────────────────
function copyId() {
  navigator.clipboard.writeText(state.myId).then(() => {
    dom.copyBtn.classList.add('copied');
    dom.copyBtn.querySelector('.copy-text').textContent = 'Copied!';
    setTimeout(() => {
      dom.copyBtn.classList.remove('copied');
      dom.copyBtn.querySelector('.copy-text').textContent = 'Copy ID';
    }, 2000);
  }).catch(() => {
    // Fallback for older browsers
    const el = document.createElement('textarea');
    el.value = state.myId;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    dom.copyBtn.querySelector('.copy-text').textContent = 'Copied!';
    setTimeout(() => {
      dom.copyBtn.querySelector('.copy-text').textContent = 'Copy ID';
    }, 2000);
  });
}

function formatId(id) {
  return id ? id.substring(0, 8) + '…' : 'Unknown';
}

// ─── Input Formatting ─────────────────────────────────────────
function formatIdInput(value) {
  // Strip non-digits and slash, then auto-insert slash
  let digits = value.replace(/[^0-9]/g, '');
  if (digits.length <= 8) return digits;
  return digits.substring(0, 8) + '/' + digits.substring(8, 13);
}

// ── Peer disconnect handler ────────────────────────────────────
function handlePeerDisconnect() {
  if (!state.peerId) return;

  cleanupCall();
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  state.dataChannel = null;

  const prevPeer = state.peerId;
  state.peerId = null;

  setStatus('waiting');
  hideCommPanel();

  dom.chatMessages.innerHTML = `
    <div class="chat-empty">
      <div class="chat-empty-icon">💬</div>
      <div class="chat-empty-text">Messages appear here once connected</div>
    </div>`;

  dom.connectBtn.disabled = false;
  dom.targetIdInput.disabled = false;

  toast('error', '🔌', `${formatId(prevPeer)} disconnected`);
}

function disconnect() {
  if (state.peerId) {
    state.socket.emit('hangup', { toId: state.peerId });
  }
  handlePeerDisconnect();
}

// ════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ════════════════════════════════════════════════════════════════

function bindEvents() {
  // Copy ID
  dom.copyBtn.addEventListener('click', copyId);

  // Connect
  dom.connectBtn.addEventListener('click', () => {
    const targetId = dom.targetIdInput.value.trim();

    if (!/^\d{8}\/\d{5}$/.test(targetId)) {
      toast('error', '⚠️', 'Enter a valid ID in format XXXXXXXX/XXXXX');
      dom.targetIdInput.focus();
      return;
    }

    if (targetId === state.myId) {
      toast('error', '😅', 'You cannot connect to yourself');
      return;
    }

    dom.connectBtn.disabled = true;
    setStatus('connecting');
    state.peerId = targetId;

    state.socket.emit('connect-request', {
      fromId: state.myId,
      toId: targetId,
    });

    toast('info', '📡', `Sending request to ${formatId(targetId)}...`);
  });

  // Auto-format ID input
  dom.targetIdInput.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    const formatted = formatIdInput(e.target.value);
    e.target.value = formatted;
    // Restore cursor position (roughly)
    if (formatted.length === 9 && pos === 8) {
      e.target.setSelectionRange(9, 9);
    }
  });

  // Connect on Enter
  dom.targetIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.connectBtn.click();
  });

  // Incoming modal
  dom.acceptBtn.addEventListener('click', () => {
    const fromId = dom.incomingModal.dataset.fromId;
    hideIncomingModal();
    state.peerId = fromId;
    state.socket.emit('connect-response', {
      fromId: state.myId,
      toId: fromId,
      accepted: true,
    });
    onPairingAccepted(false); // we are the callee
    toast('success', '✅', `Connected to ${formatId(fromId)}`);
  });

  dom.declineBtn.addEventListener('click', () => {
    const fromId = dom.incomingModal.dataset.fromId;
    hideIncomingModal();
    state.socket.emit('connect-response', {
      fromId: state.myId,
      toId: fromId,
      accepted: false,
      reason: 'Request declined',
    });
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Chat send
  dom.sendBtn.addEventListener('click', sendChatMessage);

  dom.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Auto-resize textarea
  dom.chatInput.addEventListener('input', () => {
    dom.chatInput.style.height = '44px';
    dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 120) + 'px';
  });

  // Voice call
  dom.startCallBtn.addEventListener('click', startVoiceCall);
  dom.endCallBtn.addEventListener('click', () => {
    if (state.peerId) state.socket.emit('hangup', { toId: state.peerId });
    cleanupCall();
    toast('info', '📴', 'Voice call ended');
  });
  dom.muteBtnVoice.addEventListener('click', () => toggleMute('voice'));

  // Video call
  dom.startVideoBtn.addEventListener('click', startVideoCall);
  dom.endVideoBtn.addEventListener('click', () => {
    if (state.peerId) state.socket.emit('hangup', { toId: state.peerId });
    cleanupCall();
    toast('info', '📴', 'Video call ended');
  });
  dom.muteBtnVideo.addEventListener('click', () => toggleMute('video'));
  dom.camToggleBtn.addEventListener('click', toggleCamera);

  // Disconnect
  dom.disconnectBtn.addEventListener('click', () => {
    if (confirm('Disconnect from peer?')) disconnect();
  });

  // Keyboard shortcut: Enter in connect input
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideIncomingModal();
  });
}

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════

function init() {
  // Get or generate ID
  state.myId = getOrCreateId();
  dom.myIdDisplay.textContent = state.myId;

  // Set initial status
  setStatus('waiting');

  // Bind all UI events
  bindEvents();

  // Start with chat tab active
  switchTab('chat');

  // Connect to signaling server
  initSocket();

  console.log('[RoshUP] Initialized with ID:', state.myId);
}

// Run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
