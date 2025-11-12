document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const roomCode = (params.get('room') || '').toUpperCase();
  const displayName = (params.get('name') || '').trim();

  if (!roomCode || !displayName) {
    window.location.replace('/');
    return;
  }

  const socket = io();
  const peerConnections = {};
  const remoteAudio = new Map();
  const audioContainer = document.getElementById('audioContainer');

  const roomCodeLabel = document.getElementById('roomCodeLabel');
  const participantList = document.getElementById('participantList');
  const participantCount = document.getElementById('participantCount');
  const messageFeed = document.getElementById('messageFeed');
  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const toggleVoiceBtn = document.getElementById('toggleVoiceBtn');
  const voiceHint = document.getElementById('voiceHint');
  const voiceStatus = document.getElementById('voiceStatus');
  const leaveRoomBtn = document.getElementById('leaveRoomBtn');
  const backToStartBtn = document.getElementById('backToStart');

  roomCodeLabel.textContent = roomCode;

  let currentUsers = [];
  let mySocketId = null;
  let joinConfirmed = false;
  let voiceEnabled = false;
  let voiceReadyOnServer = false;
  let localStream = null;
  let audioContext = null;
  let analyserTimer = null;
  let lastSpeaking = false;

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:80?transport=tcp',
          'turns:openrelay.metered.ca:443'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };

  const escapeHtml = (value = '') =>
    value.replace(/[&<>"']/g, (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]
    );

  const joinRoom = () => {
    socket.emit('joinRoom', { roomCode, name: displayName }, (response) => {
      if (!response?.ok) {
        alert(response?.error || 'Не удалось войти в комнату.');
        window.location.replace('/');
        return;
      }
      joinConfirmed = true;
      toggleVoiceBtn.disabled = false;
    });
  };

  socket.on('session', ({ socketId }) => {
    mySocketId = socketId;
  });

  if (socket.connected) {
    joinRoom();
  }
  socket.on('connect', joinRoom);

  socket.on('roomHistory', (history = []) => {
    history.forEach(renderMessage);
    scrollMessages();
  });

  socket.on('chatMessage', (message) => {
    renderMessage(message);
    scrollMessages();
  });

  socket.on('roomUsers', (users = []) => {
    currentUsers = users;
    renderParticipants(users);
    participantCount.textContent = users.length;

    const me = users.find((user) => user.id === mySocketId);
    const wasVoiceReady = voiceReadyOnServer;
    voiceReadyOnServer = Boolean(me?.inVoice);

    if (!users.some((user) => user.id === mySocketId)) {
      window.location.replace('/');
    }

    if (!voiceReadyOnServer || (voiceReadyOnServer && !wasVoiceReady)) {
      Object.keys(peerConnections).forEach(tearDownPeer);
    }

    syncVoicePeers();
  });

  socket.on('voice:activity', ({ socketId, speaking }) => {
    const row = participantList.querySelector(`[data-user-id="${socketId}"]`);
    if (row) {
      row.dataset.speaking = speaking ? 'true' : 'false';
    }
  });

  socket.on('userLeft', ({ socketId }) => {
    tearDownPeer(socketId);
  });

  socket.on('webrtc-offer', async ({ from, sdp }) => {
    const pc = ensurePeerConnection(from, false);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await ensureLocalTracks(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { targetId: from, sdp: pc.localDescription });
    } catch (error) {
      console.error('Error handling offer', error);
    }
  });

  socket.on('webrtc-answer', async ({ from, sdp }) => {
    const pc = peerConnections[from];
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (error) {
      console.error('Error handling answer', error);
    }
  });

  socket.on('webrtc-ice', async ({ from, candidate }) => {
    const pc = peerConnections[from];
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error adding ICE candidate', error);
    }
  });

  socket.on('disconnect', () => {
    disableVoice();
    alert('Соединение с сервером потеряно.');
  });

  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    socket.emit('chatMessage', { roomCode, text }, (response) => {
      if (!response?.ok) {
        alert('Не удалось отправить сообщение.');
      }
    });
    messageInput.value = '';
  });

  toggleVoiceBtn.addEventListener('click', () => {
    if (voiceEnabled) {
      disableVoice();
    } else {
      enableVoice();
    }
  });

  leaveRoomBtn.addEventListener('click', () => {
    disableVoice();
    socket.emit('leaveRoom');
    window.location.replace('/');
  });

  backToStartBtn.addEventListener('click', () => {
    disableVoice();
    socket.emit('leaveRoom');
    window.location.replace('/');
  });

  window.addEventListener('beforeunload', () => {
    socket.emit('leaveRoom');
  });

  function renderParticipants(users) {
    participantList.innerHTML = '';
    users.forEach((user) => {
      const li = document.createElement('li');
      li.className = 'participant';
      if (user.inVoice) li.classList.add('in-voice');
      if (user.id === mySocketId) li.classList.add('is-self');
      li.dataset.userId = user.id;
      li.dataset.speaking = user.speaking ? 'true' : 'false';
      li.innerHTML = `
        <div class="participant-name">${escapeHtml(user.name || 'Гость')}</div>
        <div class="participant-flags">
          <span class="voice-pill">${user.inVoice ? '🔊' : '🔈'}</span>
          <span class="speaking-dot"></span>
        </div>
      `;
      participantList.appendChild(li);
    });
  }

  function renderMessage(message = {}) {
    const row = document.createElement('div');
    row.className = 'message-row';
    if (message.senderId === mySocketId) {
      row.classList.add('is-self');
    }

    const time = new Date(message.timestamp || Date.now()).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    });

    row.innerHTML = `
      <div class="message-meta">
        <span class="message-author">${escapeHtml(message.name || 'Без имени')}</span>
        <span class="message-time">${time}</span>
      </div>
      <p class="message-text">${escapeHtml(message.text || '')}</p>
    `;

    messageFeed.appendChild(row);
    if (messageFeed.children.length > 500) {
      messageFeed.removeChild(messageFeed.firstChild);
    }
  }

  function scrollMessages() {
    messageFeed.scrollTop = messageFeed.scrollHeight;
  }

  function shouldInitiateOffer(targetId) {
    if (!voiceEnabled || !mySocketId) return false;
    return mySocketId > targetId;
  }

  function ensurePeerConnection(targetId, maybeInitiate = true) {
    if (peerConnections[targetId]) {
      ensureLocalTracks(peerConnections[targetId]);
      return peerConnections[targetId];
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[targetId] = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-ice', { targetId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        attachRemoteAudio(targetId, stream);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        tearDownPeer(targetId);
      }
    };

    ensureLocalTracks(pc);

    if (maybeInitiate && shouldInitiateOffer(targetId)) {
      makeOffer(targetId, pc);
    }

    return pc;
  }

  async function makeOffer(targetId, pc) {
    try {
      await ensureLocalTracks(pc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { targetId, sdp: pc.localDescription });
    } catch (error) {
      console.error('Offer error', error);
    }
  }

  async function ensureLocalTracks(pc) {
    if (!localStream || !pc) return;
    const existingTracks = pc.getSenders().map((sender) => sender.track);
    localStream.getTracks().forEach((track) => {
      if (!existingTracks.includes(track)) {
        pc.addTrack(track, localStream);
      }
    });
  }

  function syncVoicePeers() {
    if (!voiceEnabled || !voiceReadyOnServer) {
      Object.keys(peerConnections).forEach(tearDownPeer);
      return;
    }

    const otherVoiceUsers = currentUsers
      .filter((user) => user.inVoice && user.id !== mySocketId)
      .map((user) => user.id);

    otherVoiceUsers.forEach((id) => ensurePeerConnection(id, true));

    Object.keys(peerConnections).forEach((id) => {
      if (!otherVoiceUsers.includes(id)) {
        tearDownPeer(id);
      }
    });
  }

  function attachRemoteAudio(socketId, stream) {
    let audio = remoteAudio.get(socketId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.dataset.userId = socketId;
      audioContainer.appendChild(audio);
      remoteAudio.set(socketId, audio);
    }
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    audio.play().catch((error) => {
      console.error('Не удалось воспроизвести удалённый аудио-поток', error);
    });
  }

  function tearDownPeer(socketId) {
    const pc = peerConnections[socketId];
    if (pc) {
      pc.close();
      delete peerConnections[socketId];
    }
    const audio = remoteAudio.get(socketId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      remoteAudio.delete(socketId);
    }
  }

  async function enableVoice() {
    if (voiceEnabled) return;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceEnabled = true;
      toggleVoiceBtn.textContent = 'Выйти из голоса';
      voiceHint.textContent = 'Микрофон активен. Мы подсвечиваем говорящих.';
      voiceStatus.textContent = 'Вы в голосовом канале';
      socket.emit('voice:join');
      startVoiceActivityDetection(localStream);
      syncVoicePeers();
    } catch (error) {
      console.error(error);
      alert(`Не удалось получить доступ к микрофону: ${error.message}`);
    }
  }

  function disableVoice() {
    if (!voiceEnabled) return;
    voiceEnabled = false;
    voiceReadyOnServer = false;
    socket.emit('voice:leave');
    toggleVoiceBtn.textContent = 'Войти в голос';
    toggleVoiceBtn.disabled = !joinConfirmed;
    voiceHint.textContent = 'Вы еще не подключались к голосу.';
    voiceStatus.textContent = 'Микрофон выключен';
    stopVoiceActivityDetection();

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }

    Object.keys(peerConnections).forEach(tearDownPeer);
  }

  function startVoiceActivityDetection(stream) {
    stopVoiceActivityDetection();
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;

    audioContext = new Context();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.frequencyBinCount);

    analyserTimer = setInterval(() => {
      analyser.getByteFrequencyData(buffer);
      const avg = buffer.reduce((sum, value) => sum + value, 0) / buffer.length;
      const speaking = avg > 30;
      if (speaking !== lastSpeaking) {
        lastSpeaking = speaking;
        socket.emit('voice:activity', { speaking });
      }
    }, 300);
  }

  function stopVoiceActivityDetection() {
    if (analyserTimer) {
      clearInterval(analyserTimer);
      analyserTimer = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    lastSpeaking = false;
  }
});
