/* TT GG — sala: sinalização Socket.IO + malha WebRTC + UI de moderação. */

(() => {
  const $ = (id) => document.getElementById(id);

  /* ------------------------------- elementos ------------------------------ */
  const stateLoading = $('stateLoading');
  const stateError = $('stateError');
  const stateRoom = $('stateRoom');
  const errorMessage = $('errorMessage');
  const backHome = $('backHome');

  const roomCodeEl = $('roomCode');
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const copyLinkBtn = $('copyLinkBtn');
  const copyLinkLabel = $('copyLinkLabel');
  const regenBtn = $('regenBtn');
  const closeRoomBtn = $('closeRoomBtn');
  const leaveBtn = $('leaveBtn');
  const participantCount = $('participantCount');
  const participantList = $('participantList');

  const shareGrid = $('shareGrid');
  const emptyState = $('emptyState');
  const toast = $('toast');

  const micBtn = $('micBtn');
  const micLabel = $('micLabel');
  const deafenBtn = $('deafenBtn');
  const deafenLabel = $('deafenLabel');
  const shareBtn = $('shareBtn');
  const shareLabel = $('shareLabel');
  const leaveCtrlBtn = $('leaveCtrlBtn');

  const nameModal = $('nameModal');
  const nameForm = $('nameForm');
  const nameModalInput = $('nameModalInput');
  const nameModalError = $('nameModalError');
  const nameCancel = $('nameCancel');

  const closeModal = $('closeModal');
  const closeModalCode = $('closeModalCode');
  const closeCancel = $('closeCancel');
  const closeConfirm = $('closeConfirm');

  const regenModal = $('regenModal');
  const regenModalCode = $('regenModalCode');
  const regenCancel = $('regenCancel');
  const regenConfirm = $('regenConfirm');

  /* -------------------------------- estado -------------------------------- */
  const code = TTGG.normalizeCode(window.location.pathname.split('/').pop());
  const remoteAudio = new Map(); // peerId -> HTMLAudioElement
  const peers = new Map(); // peerId -> { pc, polite, makingOffer, ignoreOffer, isSettingRemoteAnswerPending, shareStream }
  const tiles = new Map(); // participantId -> { el, video }

  let socket = null;
  let self = null;
  let participants = new Map();
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let phase = 'loading'; // loading | error | need-name | ready

  let localMicTrack = null;
  let localShareStream = null;
  let micOn = false;
  let serverMuted = false;
  let deafened = false;
  let isSharing = false;
  let shareBusy = false;
  const signalLog = [];

  /* -------------------------------- helpers ------------------------------- */

  function setPhase(next) {
    phase = next;
    stateLoading.classList.toggle('hidden', next !== 'loading');
    stateError.classList.toggle('hidden', next !== 'error');
    stateRoom.classList.toggle('hidden', next !== 'ready');
    if (next !== 'need-name') nameModal.classList.add('hidden');
  }

  function showError(message) {
    errorMessage.textContent = message;
    setPhase('error');
  }

  let toastTimer = null;
  function showToast(message, kind = 'error') {
    toast.textContent = message;
    toast.classList.toggle('info', kind === 'info');
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
  }

  function isOwner() {
    return self && self.role === 'OWNER';
  }

  function activeShareCount() {
    let n = 0;
    for (const p of participants.values()) if (p.sharing) n++;
    return n;
  }

  /* ----------------------------- WebRTC: peers ---------------------------- */

  function createPeer(peerId) {
    if (peers.has(peerId)) return peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers });
    const peer = {
      pc,
      // Perfect negotiation: um lado "educado" cede em caso de colisão de ofertas.
      polite: self.id < peerId,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      shareStream: null,
    };
    peers.set(peerId, peer);

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(peerId, { candidate: event.candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.warn('negotiationneeded falhou', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.ontrack = (event) => {
      if (event.track.kind === 'video') {
        peer.shareStream = event.streams[0] || new MediaStream([event.track]);
        event.track.addEventListener('ended', () => {
          peer.shareStream = null;
          renderShares();
        });
        renderShares();
      } else {
        ensureAudioElement(peerId, event.streams[0] || new MediaStream([event.track]));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Tenta uma vez reconectar via novo handshake de ICE.
        try {
          pc.restartIce();
        } catch {
          /* suportado apenas em navegadores modernos */
        }
      }
    };

    // Publica os tracks locais já conhecidos neste novo par.
    if (localMicTrack) {
      try {
        pc.addTrack(localMicTrack);
      } catch {
        /* track já adicionado */
      }
    }
    if (localShareStream) {
      for (const track of localShareStream.getTracks()) {
        try {
          const sender = pc.addTrack(track, localShareStream);
          applyShareEncoding(sender, track);
        } catch {
          /* track já adicionado */
        }
      }
    }

    return peer;
  }

  function applyShareEncoding(sender, track) {
    if (track.kind !== 'video') return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      // Mesmo limite aplicado no original: 1,5 Mbps / 15 fps.
      params.encodings[0].maxBitrate = 1_500_000;
      params.encodings[0].maxFramerate = 15;
      sender.setParameters(params);
    } catch {
      /* parâmetros não suportados */
    }
  }

  function sendSignal(to, data) {
    signalLog.push({ dir: 'out', to, kind: data.description ? data.description.type : 'candidate' });
    if (socket && socket.connected) socket.emit('rtc:signal', { to, data });
  }

  async function receiveSignal(from, data) {
    signalLog.push({ dir: 'in', from, kind: data.description ? data.description.type : 'candidate' });
    const peer = createPeer(from);
    const { pc } = peer;

    try {
      if (data.description) {
        const readyForOffer =
          !peer.makingOffer &&
          (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
        const offerCollision = data.description.type === 'offer' && !readyForOffer;

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return; // lado rude descarta a oferta conflitante

        peer.isSettingRemoteAnswerPending = data.description.type === 'answer';
        await pc.setRemoteDescription(data.description);
        peer.isSettingRemoteAnswerPending = false;

        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal(from, { description: pc.localDescription });
        }
        // Aplica candidatos que chegaram antes da descrição remota.
        const queued = peer.pendingCandidates.splice(0);
        for (const cand of queued) await pc.addIceCandidate(cand);
      } else if (data.candidate) {
        if (!pc.remoteDescription) {
          // Candidato chegou antes do offer/answer: enfileira.
          peer.pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('falha ao processar sinalização', err);
    }
  }

  function ensureAudioElement(peerId, stream) {
    let el = remoteAudio.get(peerId);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.className = 'remote-audio';
      document.body.appendChild(el);
      remoteAudio.set(peerId, el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = deafened;
    el.play().catch(() => {});
  }

  function closePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) {
      try {
        peer.pc.close();
      } catch {
        /* já fechado */
      }
      peers.delete(peerId);
    }
    const el = remoteAudio.get(peerId);
    if (el) {
      el.pause();
      el.srcObject = null;
      el.remove();
      remoteAudio.delete(peerId);
    }
  }

  /** Garante que exista um par WebRTC para cada participante remoto. */
  function syncPeers() {
    const known = new Set(participants.keys());
    for (const id of known) {
      if (id !== self.id && !peers.has(id)) createPeer(id);
    }
    for (const id of [...peers.keys()]) {
      if (!known.has(id)) closePeer(id);
    }
  }

  /* ------------------------------- mídia local ---------------------------- */

  async function ensureMicTrack() {
    if (localMicTrack) return localMicTrack;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    localMicTrack = stream.getAudioTracks()[0];
    for (const { pc } of peers.values()) {
      try {
        pc.addTrack(localMicTrack);
      } catch {
        /* já adicionado */
      }
    }
    return localMicTrack;
  }

  async function toggleMic() {
    if (serverMuted) {
      showToast('Seu microfone foi silenciado pelo dono da sala.');
      return;
    }
    try {
      if (!micOn) {
        await ensureMicTrack();
        localMicTrack.enabled = true;
        micOn = true;
      } else {
        localMicTrack.enabled = false;
        micOn = false;
      }
      if (socket && socket.connected) socket.emit('room:mic', { on: micOn });
      renderControls();
    } catch {
      showToast('Não foi possível acessar seu microfone. Verifique as permissões do navegador.');
    }
  }

  function toggleDeafen() {
    deafened = !deafened;
    for (const el of remoteAudio.values()) el.muted = deafened;
    renderControls();
  }

  async function startSharing() {
    if (shareBusy || isSharing) return;
    if (!isSharing && activeShareCount() >= 3 && !participants.get(self.id)?.sharing) {
      showToast('Já existe uma tela sendo compartilhada');
      return;
    }

    shareBusy = true;
    renderControls();
    try {
      // Registra no servidor primeiro (valida limite de 3 telas).
      await TTGG.api(`/rooms/${code}/share/start`, { method: 'POST', body: '{}' });

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: true,
      });

      localShareStream = stream;
      const videoTrack = stream.getVideoTracks()[0];
      videoTrack.addEventListener('ended', () => {
        stopSharing();
      });

      for (const { pc } of peers.values()) {
        for (const track of stream.getTracks()) {
          try {
            applyShareEncoding(pc.addTrack(track, stream), track);
          } catch {
            /* já adicionado */
          }
        }
      }

      isSharing = true;
      if (socket && socket.connected) socket.emit('room:share', { on: true });
      renderShares();
      renderControls();
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        showToast('Compartilhamento cancelado.');
      } else if (err instanceof TTGG.ApiError) {
        showToast(err.message);
        // O servidor recusou: reverte o registro feito antes da permissão.
        TTGG.api(`/rooms/${code}/share/stop`, { method: 'POST', body: '{}' }).catch(() => {});
      } else {
        showToast('Não foi possível iniciar o compartilhamento.');
      }
    } finally {
      shareBusy = false;
      renderControls();
    }
  }

  async function stopSharing() {
    if (!isSharing) return;
    isSharing = false;

    if (localShareStream) {
      for (const track of localShareStream.getTracks()) track.stop();
      localShareStream = null;
    }

    for (const { pc } of peers.values()) {
      for (const sender of [...pc.getSenders()]) {
        if (sender.track && sender.track.kind === 'video') {
          try {
            pc.removeTrack(sender);
          } catch {
            /* ignora */
          }
        }
      }
    }

    if (socket && socket.connected) socket.emit('room:share', { on: false });
    TTGG.api(`/rooms/${code}/share/stop`, { method: 'POST', body: '{}' }).catch(() => {});
    renderShares();
    renderControls();
  }

  /* --------------------------------- UI ---------------------------------- */

  function statusLabel() {
    if (!socket) return 'Conectando…';
    if (socket.connected) return 'Conectado';
    if (socket.active) return 'Reconectando...';
    return 'Desconectado';
  }

  function renderStatus() {
    const label = statusLabel();
    statusText.textContent = label;
    statusDot.classList.toggle('connected', label === 'Conectado');
    statusDot.classList.toggle('reconnecting', label === 'Reconectando...');
  }

  function renderControls() {
    const mutedByServer = serverMuted;

    micBtn.classList.toggle('off', !micOn || mutedByServer);
    micLabel.textContent = mutedByServer ? 'Silenciado' : micOn ? 'Microfone' : 'Mudo';
    micBtn.disabled = mutedByServer;
    micBtn.title = mutedByServer
      ? 'O dono da sala silenciou seu microfone'
      : micOn
        ? 'Desativar microfone'
        : 'Ativar microfone';

    deafenBtn.classList.toggle('off', deafened);
    deafenLabel.textContent = deafened ? 'Áudio silenciado' : 'Áudio';
    deafenBtn.title = deafened ? 'Reativar áudio' : 'Silenciar áudio recebido';

    const selfParticipant = participants.get(self.id);
    const selfSharing = isSharing || Boolean(selfParticipant && selfParticipant.sharing);
    const blocked = !selfSharing && activeShareCount() >= 3;

    shareBtn.classList.toggle('sharing', selfSharing);
    shareLabel.textContent = selfSharing ? 'Encerrar transmissão' : 'Compartilhar tela';
    shareBtn.disabled = shareBusy || (!selfSharing && blocked);
    shareBtn.title = blocked ? 'Já existe uma tela sendo compartilhada' : shareLabel.textContent;
  }

  function participantTemplate(p) {
    const isSelf = self && p.id === self.id;
    const host = p.role === 'OWNER';
    const micMuted = p.muted || !p.micOn;
    const wrap = document.createElement('div');
    wrap.className = 'participant';
    wrap.dataset.id = p.id;

    const avatarHtml = p.avatar
      ? `<img src="${p.avatar}" alt="" />`
      : TTGG.escapeHtml(TTGG.initials(p.displayName));

    const actions = isOwner() && !host
      ? `<div class="participant-actions">
           ${p.sharing ? `<button class="icon-btn" data-act="stop-share" title="Encerrar compartilhamento">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="2" x2="22" y1="3" y2="3"/></svg></button>` : ''}
           <button class="icon-btn ${p.muted ? 'active' : ''}" data-act="mute" title="${p.muted ? 'Reativar áudio' : 'Desativar áudio no servidor'}">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 2 20 20"/><path d="M9 9v1a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" x2="12" y1="19" y2="22"/></svg></button>
           <button class="icon-btn ${p.deafened ? 'active' : ''}" data-act="deafen" title="${p.deafened ? 'Reativar áudio' : 'Silenciar áudio'}">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg></button>
           <button class="icon-btn danger" data-act="kick" title="Remover participante">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/></svg></button>
         </div>`
      : '';

    wrap.innerHTML = `
      <div class="avatar" data-avatar>${avatarHtml}</div>
      <div class="participant-main">
        <div class="participant-name">
          <span class="text">${TTGG.escapeHtml(p.displayName)}${isSelf ? ' (você)' : ''}</span>
          ${host ? '<span class="host-tag">host</span>' : ''}
        </div>
        <div class="participant-meta">
          <span class="dot ${p.status === 'ONLINE' ? '' : 'off'}"></span>
          <span>${p.status === 'ONLINE' ? 'online' : 'offline'}</span>
          ${micMuted ? '<span title="Microfone mutado">· mic off</span>' : ''}
          ${p.deafened ? '<span title="Áudio silenciado no servidor">· surdo</span>' : ''}
          ${p.sharing ? '<span class="sharing">· compartilhando</span>' : ''}
        </div>
      </div>
      ${actions}
    `;

    wrap.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-act]');
      if (!btn) return;
      moderate(btn.dataset.act, p.id);
    });

    return wrap;
  }

  function renderParticipants() {
    const list = [...participants.values()].sort((a, b) => {
      if (a.role === b.role) return a.displayName.localeCompare(b.displayName);
      return a.role === 'OWNER' ? -1 : 1;
    });

    participantCount.textContent = String(list.length);

    const existing = new Map([...participantList.children].map((el) => [el.dataset.id, el]));
    const seen = new Set();

    for (const p of list) {
      seen.add(p.id);
      const old = existing.get(p.id);
      if (old) {
        // Atualiza apenas os campos que mudam com frequência.
        const meta = old.querySelector('.participant-meta');
        const micMuted = p.muted || !p.micOn;
        meta.innerHTML = `
          <span class="dot ${p.status === 'ONLINE' ? '' : 'off'}"></span>
          <span>${p.status === 'ONLINE' ? 'online' : 'offline'}</span>
          ${micMuted ? '<span title="Microfone mutado">· mic off</span>' : ''}
          ${p.deafened ? '<span title="Áudio silenciado no servidor">· surdo</span>' : ''}
          ${p.sharing ? '<span class="sharing">· compartilhando</span>' : ''}
        `;
        const oldAvatar = old.querySelector('[data-avatar]');
        const wantAvatar = p.avatar || '';
        if ((oldAvatar.dataset.src || '') !== wantAvatar) {
          oldAvatar.dataset.src = wantAvatar;
          oldAvatar.innerHTML = p.avatar
            ? `<img src="${p.avatar}" alt="" />`
            : TTGG.escapeHtml(TTGG.initials(p.displayName));
        }
        // Re-renderiza se as ações de moderação precisarem aparecer/esconder.
        const hadActions = Boolean(old.querySelector('.participant-actions'));
        const needsActions = isOwner() && p.role !== 'OWNER';
        if (hadActions !== needsActions) {
          old.replaceWith(participantTemplate(p));
        }
      } else {
        participantList.appendChild(participantTemplate(p));
      }
    }

    for (const [id, el] of existing) {
      if (!seen.has(id)) el.remove();
    }
  }

  function renderShares() {
    const sharers = [...participants.values()].filter((p) => p.sharing);

    shareGrid.classList.toggle('hidden', sharers.length === 0);
    emptyState.classList.toggle('hidden', sharers.length > 0);
    shareGrid.classList.toggle('cols-2', sharers.length > 1);

    const seen = new Set();

    for (const p of sharers) {
      seen.add(p.id);
      let tile = tiles.get(p.id);

      if (!tile) {
        const el = document.createElement('div');
        el.className = 'share-tile';
        el.innerHTML = `
          <video autoplay playsinline muted></video>
          <div class="tile-label"><span class="live-dot"></span><span data-name></span></div>
          <div class="tile-actions">
            <button class="icon-btn" data-fullscreen title="Tela cheia">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            </button>
          </div>`;
        const video = el.querySelector('video');
        el.querySelector('[data-fullscreen]').addEventListener('click', () => {
          if (document.fullscreenElement) document.exitFullscreen();
          else el.requestFullscreen().catch(() => {});
        });
        tile = { el, video };
        tiles.set(p.id, tile);
        shareGrid.appendChild(el);
      }

      tile.el.querySelector('[data-name]').textContent =
        p.displayName + (self && p.id === self.id ? ' (você)' : '');

      // Fonte do vídeo: prévia local ou stream remoto recebido.
      const stream = p.id === self.id ? localShareStream : (peers.get(p.id) || {}).shareStream;
      if (stream && tile.video.srcObject !== stream) {
        tile.video.srcObject = stream;
        tile.video.play().catch(() => {});
      }
    }

    for (const [id, tile] of tiles) {
      if (!seen.has(id)) {
        tile.video.srcObject = null;
        tile.el.remove();
        tiles.delete(id);
      }
    }
  }

  function moderate(action, targetId) {
    const path = {
      kick: 'kick',
      mute: 'server-mute',
      deafen: 'server-deafen',
      'stop-share': 'stop-share',
    }[action];
    if (!path) return;

    TTGG.api(`/rooms/${code}/participants/${targetId}/${path}`, { method: 'POST', body: '{}' }).catch(
      (err) => showToast(err instanceof TTGG.ApiError ? err.message : 'Não foi possível concluir a ação.')
    );
  }

  /* ------------------------------ fluxo de entrada ------------------------ */

  async function join(displayName) {
    setPhase('loading');
    try {
      const result = await TTGG.api(`/rooms/${code}/join`, {
        method: 'POST',
        body: JSON.stringify({ displayName }),
      });
      self = result.self;
      roomCodeEl.textContent = result.room.code;
      closeRoomBtn.classList.toggle('hidden', self.role !== 'OWNER');
      regenBtn.classList.toggle('hidden', self.role !== 'OWNER');
      connectSocket();
    } catch (err) {
      showError(err instanceof TTGG.ApiError ? err.message : 'Não foi possível conectar à sala.');
    }
  }

  function connectSocket() {
    socket = io('/room', { autoConnect: false, withCredentials: true });

    socket.on('connect', renderStatus);
    socket.on('disconnect', renderStatus);
    socket.on('reconnect_attempt', renderStatus);

    socket.on('rtc:config', (payload) => {
      if (payload && Array.isArray(payload.iceServers) && payload.iceServers.length) {
        iceServers = payload.iceServers;
      }
    });

    socket.on('room:joined', (payload) => {
      if (payload && payload.self) self = payload.self;
      renderStatus();
    });

    socket.on('participants:update', (list) => {
      participants = new Map((list || []).map((p) => [p.id, p]));

      // Sincroniza o estado local com o que o servidor diz sobre você.
      const me = participants.get(self.id);
      if (me) {
        if (me.muted !== serverMuted) {
          serverMuted = me.muted;
          if (serverMuted && micOn) {
            micOn = false;
            if (localMicTrack) localMicTrack.enabled = false;
            if (socket.connected) socket.emit('room:mic', { on: false });
            showToast('Seu microfone foi silenciado pelo dono da sala.');
          } else if (!serverMuted) {
            showToast('Seu microfone foi reativado pelo dono da sala.', 'info');
          }
        }
        if (me.deafened !== deafened) {
          deafened = me.deafened;
          for (const el of remoteAudio.values()) el.muted = deafened;
        }
        if (me.sharing !== isSharing && !me.sharing && isSharing) {
          // Dono forçou o fim do compartilhamento.
          stopSharing();
        }
      }

      syncPeers();
      renderParticipants();
      renderShares();
      renderControls();
    });

    socket.on('rtc:signal', (payload) => {
      if (payload && payload.from) receiveSignal(payload.from, payload.data);
    });

    socket.on('room:error', (payload) => {
      showError((payload && payload.message) || 'Não foi possível conectar à sala.');
      teardown();
    });

    socket.on('room:closed', () => {
      showError('Esta sala foi encerrada pelo dono.');
      teardown();
    });

    socket.on('room:code-changed', (payload) => {
      if (!payload || !payload.code) return;
      const next = TTGG.normalizeCode(payload.code);
      window.history.replaceState(null, '', `/room/${next}`);
      roomCodeEl.textContent = next;
      showToast('O link da sala foi atualizado.', 'info');
    });

    socket.on('kicked', () => {
      showError('Você foi removido da sala pelo dono.');
      teardown();
    });

    socket.on('muted', (payload) => {
      // O servidor força o estado; participants:update confirma em seguida.
      if (payload && payload.muted) serverMuted = true;
      renderControls();
    });

    socket.on('deafened', (payload) => {
      if (payload) {
        deafened = Boolean(payload.deafened);
        for (const el of remoteAudio.values()) el.muted = deafened;
      }
      renderControls();
    });

    socket.on('share:force-stop', () => {
      showToast('O dono da sala encerrou seu compartilhamento.');
      stopSharing();
    });

    socket.connect();
    socket.emit('room:join', { code });
    setPhase('ready');
    renderStatus();
    renderControls();
  }

  function teardown() {
    stopSharing();
    for (const id of [...peers.keys()]) closePeer(id);
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
  }

  function leave() {
    teardown();
    window.location.href = '/';
  }

  /* -------------------------------- eventos ------------------------------- */

  backHome.addEventListener('click', () => {
    window.location.href = '/';
  });

  copyLinkBtn.addEventListener('click', async () => {
    const link = TTGG.buildInviteLink(roomCodeEl.textContent.trim());
    const ok = await TTGG.copyText(link);
    copyLinkLabel.textContent = ok ? 'Copiado!' : 'Copiar manualmente';
    setTimeout(() => {
      copyLinkLabel.textContent = 'Copiar link';
    }, 1500);
  });

  micBtn.addEventListener('click', toggleMic);
  deafenBtn.addEventListener('click', toggleDeafen);
  shareBtn.addEventListener('click', () => (isSharing ? stopSharing() : startSharing()));
  leaveCtrlBtn.addEventListener('click', leave);
  leaveBtn.addEventListener('click', leave);

  closeRoomBtn.addEventListener('click', () => {
    closeModalCode.textContent = roomCodeEl.textContent.trim();
    closeModal.classList.remove('hidden');
  });
  closeCancel.addEventListener('click', () => closeModal.classList.add('hidden'));
  closeConfirm.addEventListener('click', async () => {
    closeConfirm.disabled = true;
    try {
      await TTGG.api(`/rooms/${code}`, { method: 'DELETE' });
      leave();
    } catch (err) {
      showToast(err instanceof TTGG.ApiError ? err.message : 'Não foi possível encerrar a sala.');
      closeModal.classList.add('hidden');
    } finally {
      closeConfirm.disabled = false;
    }
  });

  regenBtn.addEventListener('click', () => {
    regenModalCode.textContent = roomCodeEl.textContent.trim();
    regenModal.classList.remove('hidden');
  });
  regenCancel.addEventListener('click', () => regenModal.classList.add('hidden'));
  regenConfirm.addEventListener('click', async () => {
    regenConfirm.disabled = true;
    try {
      const result = await TTGG.api(`/rooms/${code}/regenerate-code`, { method: 'POST' });
      const next = TTGG.normalizeCode(result.code);
      window.history.replaceState(null, '', `/room/${next}`);
      roomCodeEl.textContent = next;
      regenModal.classList.add('hidden');
      showToast('O link da sala foi atualizado.', 'info');
    } catch (err) {
      showToast(err instanceof TTGG.ApiError ? err.message : 'Não foi possível trocar o link da sala.');
    } finally {
      regenConfirm.disabled = false;
    }
  });

  // Fecha modais no backdrop/Escape.
  for (const modal of [closeModal, regenModal]) {
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeModal.classList.add('hidden');
    regenModal.classList.add('hidden');
  });

  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const check = TTGG.validateDisplayName(nameModalInput.value);
    if (check.error) {
      nameModalError.textContent = check.error;
      nameModalError.classList.remove('hidden');
      return;
    }
    nameModalError.classList.add('hidden');
    TTGG.store.setDisplayName(check.name);
    nameModal.classList.add('hidden');
    join(check.name);
  });

  nameCancel.addEventListener('click', () => {
    window.location.href = '/';
  });

  window.addEventListener('beforeunload', () => {
    if (isSharing && localShareStream) {
      for (const track of localShareStream.getTracks()) track.stop();
    }
  });

  /* -------------------------------- start --------------------------------- */

  // Hook de diagnóstico (somente leitura) para testes automatizados.
  window.__ttgg = {
    get peers() {
      return [...peers.keys()];
    },
    get participants() {
      return [...participants.values()];
    },
    get signals() {
      return signalLog;
    },
    get state() {
      return { phase, micOn, deafened, isSharing, serverMuted, code };
    },
    // Diagnóstico detalhado dos pares WebRTC (somente leitura).
    pcStates() {
      return [...peers.entries()].map(([id, peer]) => ({
        id,
        connectionState: peer.pc.connectionState,
        iceGatheringState: peer.pc.iceGatheringState,
        iceConnectionState: peer.pc.iceConnectionState,
        signalingState: peer.pc.signalingState,
        localDesc: peer.pc.localDescription ? peer.pc.localDescription.type : null,
        remoteDesc: peer.pc.remoteDescription ? peer.pc.remoteDescription.type : null,
        localSdp: peer.pc.localDescription ? String(peer.pc.localDescription.sdp) : null,
        senders: peer.pc.getSenders().length,
        receivers: peer.pc.getReceivers().length,
        pendingCandidates: peer.pendingCandidates.length,
      }));
    },
  };

  if (!TTGG.isValidCode(code)) {
    showError('Código de sala inválido.');
  } else {
    const savedName = TTGG.store.getDisplayName();
    if (savedName) join(savedName);
    else {
      setPhase('ready');
      stateRoom.classList.add('hidden');
      nameModal.classList.remove('hidden');
      phase = 'need-name';
      nameModalInput.focus();
    }
  }
})();
