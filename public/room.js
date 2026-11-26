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

  const shareModal = $('shareModal');
  const segSource = $('segSource');
  const segResolution = $('segResolution');
  const segFps = $('segFps');
  const shareCameraSelect = $('shareCameraSelect');
  const shareAudioSelect = $('shareAudioSelect');
  const shareMicSelect = $('shareMicSelect');
  const shareAudioHint = $('shareAudioHint');
  const shareLiveHint = $('shareLiveHint');
  const switchScreenBtn = $('switchScreenBtn');
  const switchScreenLabel = $('switchScreenLabel');
  const shareModalClose = $('shareModalClose');
  const shareModalStart = $('shareModalStart');
  const shareStartLabel = $('shareStartLabel');

  const chatBtn = $('chatBtn');
  const chatBadge = $('chatBadge');
  const chatPanel = $('chatPanel');
  const chatClose = $('chatClose');
  const chatMessages = $('chatMessages');
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');

  /* -------------------------------- estado -------------------------------- */
  const code = TTGG.normalizeCode(window.location.pathname.split('/').pop());
  const remoteAudio = new Map(); // `${peerId}:${mic|share}` -> HTMLAudioElement
  const peers = new Map(); // peerId -> { pc, polite, ..., shareStream, micSender, shareSenders }
  const tiles = new Map(); // participantId -> { el, video }
  const peerVolumes = new Map(); // participantId -> volume do microfone (0..1)
  const shareVolumes = new Map(); // participantId -> volume da transmissão (0..1)
  const sharePrevVolumes = new Map(); // último volume antes do mudo da transmissão

  let socket = null;
  let self = null;
  let participants = new Map();
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let phase = 'loading'; // loading | error | need-name | ready

  let localShareStream = null;
  let serverMuted = false;
  let deafened = false;
  let isSharing = false;
  let shareBusy = false;
  const signalLog = [];

  // Configurações da transmissão (fonte, resolução, fps e fonte do áudio).
  const shareSettings = {
    source: localStorage.getItem('ttgg_share_source') || 'screen',
    resolution: localStorage.getItem('ttgg_share_resolution') || '720p',
    fps: Number(localStorage.getItem('ttgg_share_fps')) || 30,
    audioMode: localStorage.getItem('ttgg_share_audio') || 'none',
    micDeviceId: localStorage.getItem('ttgg_share_mic') || '',
    cameraDeviceId: localStorage.getItem('ttgg_share_camera') || '',
  };
  if (!['screen', 'camera'].includes(shareSettings.source)) shareSettings.source = 'screen';
  if (shareSettings.resolution !== '1080p') shareSettings.resolution = '720p';
  if (shareSettings.fps !== 60) shareSettings.fps = 30;
  if (!['system', 'mic', 'none'].includes(shareSettings.audioMode)) shareSettings.audioMode = 'none';
  if (shareSettings.source === 'camera' && shareSettings.audioMode === 'system') {
    shareSettings.audioMode = 'none'; // webcam não expõe áudio do sistema
  }

  let rawSourceStream = null; // captura crua (getDisplayMedia ou getUserMedia da webcam)
  let systemAudioTrack = null; // áudio do sistema da captura atual
  let shareMicTrack = null; // microfone aberto só para a transmissão
  let shareAudioTrack = null; // áudio transmitido no momento
  let shareVideoTrack = null; // vídeo transmitido no momento (original ou redimensionado)
  let videoPipeline = null; // pipeline de redimensionamento, quando ativo

  // Chat da sala.
  let chatUnread = 0;
  const chatLog = [];

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
      micSender: null,
      shareSenders: { video: null, audio: null },
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
        // Áudio da transmissão chega na mesma stream que o vídeo; o microfone vem sozinho.
        const stream = event.streams[0] || new MediaStream([event.track]);
        const kind = stream.getVideoTracks().length > 0 ? 'share' : 'mic';
        ensureAudioElement(peerId, stream, kind);
        event.track.addEventListener('ended', () => dropAudioElement(peerId, kind));
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
    if (localShareStream) {
      for (const track of localShareStream.getTracks()) {
        try {
          const sender = pc.addTrack(track, localShareStream);
          applyShareEncoding(sender, track);
          if (track.kind === 'video') peer.shareSenders.video = sender;
          else peer.shareSenders.audio = sender;
        } catch {
          /* track já adicionado */
        }
      }
    }

    return peer;
  }

  /** Bitrate máximo conforme a qualidade escolhida na transmissão. */
  function maxShareBitrate() {
    const key = `${shareSettings.resolution}-${shareSettings.fps}`;
    return (
      {
        '720p-30': 2_500_000,
        '720p-60': 4_000_000,
        '1080p-30': 4_500_000,
        '1080p-60': 7_000_000,
      }[key] || 3_000_000
    );
  }

  // Cadeia de atualização por sender: evita setParameters concorrentes
  // (o Chrome rejeita a segunda chamada feita logo após a primeira).
  const encodingChains = new WeakMap();

  function applyShareEncoding(sender, track) {
    if (!sender || !track || track.kind !== 'video') return Promise.resolve();
    const previous = encodingChains.get(sender) || Promise.resolve();
    const run = previous.then(async () => {
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = maxShareBitrate();
        params.encodings[0].maxFramerate = shareSettings.fps;
        await sender.setParameters(params);
      } catch {
        /* parâmetros não suportados neste navegador */
      }
    });
    encodingChains.set(sender, run);
    return run;
  }

  /** Encontra (e memoriza) o sender usado para o vídeo/áudio da transmissão. */
  function shareSenderOf(peer, kind) {
    const remembered = peer.shareSenders[kind];
    if (remembered && peer.pc.getSenders().includes(remembered)) return remembered;
    const found = peer.pc
      .getSenders()
      .find((s) => s !== peer.micSender && (s.track ? s.track.kind === kind : false));
    peer.shareSenders[kind] = found || null;
    return found;
  }

  /** Troca (ou remove) o track enviado na transmissão para um par. */
  async function replaceShareTrack(peer, kind, track) {
    const { pc } = peer;
    const sender = shareSenderOf(peer, kind);
    if (sender) {
      try {
        await sender.replaceTrack(track || null);
        if (track) await applyShareEncoding(sender, track);
      } catch (err) {
        console.warn('replaceTrack falhou', err);
      }
      return;
    }
    if (!track || !localShareStream) return;
    try {
      const newSender = pc.addTrack(track, localShareStream);
      peer.shareSenders[kind] = newSender;
      await applyShareEncoding(newSender, track);
    } catch {
      /* já adicionado */
    }
  }

  /** Propaga uma troca de track da transmissão para todos os pares. */
  function broadcastShareTrack(kind, track) {
    return Promise.all([...peers.values()].map((peer) => replaceShareTrack(peer, kind, track)));
  }

  /** Remove da transmissão os senders de vídeo/áudio (mantém o microfone). */
  function removeShareSenders(peer) {
    for (const kind of ['video', 'audio']) {
      const sender = shareSenderOf(peer, kind);
      if (sender) {
        try {
          peer.pc.removeTrack(sender);
        } catch {
          /* ignora */
        }
        peer.shareSenders[kind] = null;
      }
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

  function ensureAudioElement(peerId, stream, kind) {
    const key = `${peerId}:${kind || 'mic'}`;
    let el = remoteAudio.get(key);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.className = 'remote-audio';
      document.body.appendChild(el);
      remoteAudio.set(key, el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = deafened;
    el.volume = volumeOf(kind === 'share' ? shareVolumes : peerVolumes, peerId);
    el.play().catch(() => {});
  }

  /** Remove o elemento de áudio de uma stream que terminou (ex.: fim da transmissão). */
  function dropAudioElement(peerId, kind) {
    const key = `${peerId}:${kind || 'mic'}`;
    const el = remoteAudio.get(key);
    if (!el) return;
    el.pause();
    el.srcObject = null;
    el.remove();
    remoteAudio.delete(key);
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
    for (const [key, el] of [...remoteAudio]) {
      if (!key.startsWith(`${peerId}:`)) continue;
      el.pause();
      el.srcObject = null;
      el.remove();
      remoteAudio.delete(key);
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

  function toggleDeafen() {
    deafened = !deafened;
    applyAudioVolumes();
    renderControls();
  }

  /* ------------------------------ volumes -------------------------------- */

  function volumeOf(map, id) {
    const v = map.get(id);
    return typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 1;
  }

  function applyAudioVolumes() {
    for (const [key, el] of remoteAudio) {
      const sep = key.lastIndexOf(':');
      const peerId = key.slice(0, sep);
      const kind = key.slice(sep + 1);
      el.muted = deafened;
      el.volume = volumeOf(kind === 'share' ? shareVolumes : peerVolumes, peerId);
    }
  }

  /** Se o elemento de áudio ficou pausado, tenta retomar o playback (ex.: após troca de aba). */
  function resumeRemoteAudio() {
    for (const el of [...remoteAudio.values()]) {
      if (el.srcObject && el.paused) {
        el.play().catch(() => {});
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      resumeRemoteAudio();
      if (isSharing) {
        recoverShareAudio().catch(() => {});
      }
    }
  });

  /* ----------------------------- mídia da tela --------------------------- */

  function qualityTarget() {
    const height = shareSettings.resolution === '1080p' ? 1080 : 720;
    return { width: height === 1080 ? 1920 : 1280, height, fps: shareSettings.fps };
  }

  function displayConstraints() {
    const t = qualityTarget();
    return {
      video: {
        frameRate: { ideal: t.fps, max: t.fps },
        height: { ideal: t.height },
        width: { ideal: t.width },
      },
      // Pede o áudio da área só quando é essa a fonte escolhida.
      audio: shareSettings.audioMode === 'system',
    };
  }

  function isCameraSource() {
    return shareSettings.source === 'camera';
  }

  /** Webcam escolhida, com a qualidade pedida (deviceId ideal evita falha se trocar). */
  function cameraConstraints() {
    const t = qualityTarget();
    const video = {
      width: { ideal: t.width },
      height: { ideal: t.height },
      frameRate: { ideal: t.fps },
    };
    if (shareSettings.cameraDeviceId) video.deviceId = { ideal: shareSettings.cameraDeviceId };
    return { video, audio: false };
  }

  /** Abre a fonte escolhida: tela (getDisplayMedia) ou webcam (getUserMedia). */
  async function acquireSourceStream(source) {
    if (source === 'camera') {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia indisponível');
      }
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          if (isSharing && isCameraSource()) stopSharing();
        });
      }
      return stream;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia(displayConstraints());
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => stopSharing());
    return stream;
  }

  function persistShareSettings() {
    try {
      localStorage.setItem('ttgg_share_source', shareSettings.source);
      localStorage.setItem('ttgg_share_resolution', shareSettings.resolution);
      localStorage.setItem('ttgg_share_fps', String(shareSettings.fps));
      localStorage.setItem('ttgg_share_audio', shareSettings.audioMode);
      localStorage.setItem('ttgg_share_mic', shareSettings.micDeviceId);
      localStorage.setItem('ttgg_share_camera', shareSettings.cameraDeviceId);
    } catch {
      /* storage indisponível */
    }
  }

  function stopTrack(track) {
    if (!track) return;
    try {
      track.stop();
    } catch {
      /* já parado */
    }
  }

  function stopStreamTracks(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) stopTrack(track);
  }

  /** Redimensiona a captura para a qualidade escolhida (canvas -> captureStream). */
  function createVideoPipeline(sourceTrack, target) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = new MediaStream([sourceTrack]);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas indisponível');
    const outStream = canvas.captureStream(target.fps);
    const outTrack = outStream.getVideoTracks()[0];

    let raf = 0;
    let timer = 0;
    let lastDraw = 0;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      if (document.hidden) {
        // rAF fica suspenso em abas ocultas: usa timer para manter o canvas produzindo frames.
        if (!timer) timer = setInterval(() => draw(performance.now()), Math.max(16, Math.round(1000 / target.fps)));
      } else {
        if (timer) {
          clearInterval(timer);
          timer = 0;
        }
        raf = requestAnimationFrame(draw);
      }
    };

    const draw = (ts) => {
      if (stopped) return;
      raf = 0;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw && vh) {
        if (ts - lastDraw >= 1000 / target.fps - 2) {
          lastDraw = ts;
          const scale = Math.min(1, target.width / vw, target.height / vh);
          const w = Math.max(2, Math.round((vw * scale) / 2) * 2);
          const h = Math.max(2, Math.round((vh * scale) / 2) * 2);
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          try {
            ctx.drawImage(video, 0, 0, w, h);
          } catch {
            /* frame indisponível */
          }
        }
      }
      schedule();
    };

    const onVisibilityChange = () => {
      if (stopped) return;
      if (document.hidden) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        if (timer) {
          clearInterval(timer);
          timer = 0;
        }
      }
      schedule();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    video.play().catch(() => {});
    schedule();

    return {
      track: outTrack,
      stop() {
        stopped = true;
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        if (timer) {
          clearInterval(timer);
          timer = 0;
        }
        document.removeEventListener('visibilitychange', onVisibilityChange);
        try {
          video.pause();
        } catch {
          /* ignora */
        }
        video.srcObject = null;
        stopTrack(outTrack);
      },
    };
  }

  /** Track enviado: redimensiona só quando a fonte é maior que a qualidade pedida. */
  function buildVideoTrack(sourceTrack) {
    const target = qualityTarget();
    const sourceHeight = (sourceTrack.getSettings && sourceTrack.getSettings().height) || 0;
    if (sourceHeight && sourceHeight <= target.height) return { track: sourceTrack, pipeline: null };
    try {
      const pipeline = createVideoPipeline(sourceTrack, target);
      return { track: pipeline.track, pipeline };
    } catch {
      return { track: sourceTrack, pipeline: null };
    }
  }

  /** Abre o microfone escolhido para transmitir junto com a tela. */
  async function openShareMic() {
    const audio = shareSettings.micDeviceId
      ? {
          deviceId: { exact: shareSettings.micDeviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      const track = stream.getAudioTracks()[0];
      track.addEventListener('ended', () => {
        if (shareAudioTrack !== track) return;
        shareAudioTrack = null;
        shareSettings.audioMode = 'none';
        persistShareSettings();
        broadcastShareTrack('audio', null);
        syncLocalShareStream();
        renderShares();
        renderShareSettings();
      });
      return track;
    } catch {
      showToast('Não foi possível abrir o microfone para a transmissão.');
      return null;
    }
  }

  /**
   * Guard: se o track de áudio da transmissão encerrar enquanto ainda estamos
   * transmitindo (ex.: captura interrompida), tenta reabrir a fonte de áudio.
   */
  async function recoverShareAudio() {
    if (!isSharing) return false;
    if (shareSettings.audioMode === 'mic') {
      if (!shareMicTrack || shareMicTrack.readyState !== 'live') {
        shareMicTrack = await openShareMic();
      }
      if (shareMicTrack && shareMicTrack.readyState === 'live') {
        shareAudioTrack = shareMicTrack;
        await broadcastShareTrack('audio', shareAudioTrack);
        return true;
      }
      shareSettings.audioMode = 'none';
      persistShareSettings();
      renderShareSettings();
      return false;
    }
    if (shareSettings.audioMode === 'system') {
      if (systemAudioTrack && systemAudioTrack.readyState === 'live') {
        shareAudioTrack = systemAudioTrack;
        await broadcastShareTrack('audio', shareAudioTrack);
        return true;
      }
    }
    return false;
  }

  /** Mantém a stream local (usada na prévia e em novos pares) em dia. */
  function syncLocalShareStream() {
    const wanted = [shareVideoTrack];
    if (shareAudioTrack && shareAudioTrack.readyState === 'live') wanted.push(shareAudioTrack);
    if (!localShareStream) {
      localShareStream = new MediaStream(wanted.filter(Boolean));
      return localShareStream;
    }
    for (const track of [...localShareStream.getTracks()]) {
      if (!wanted.includes(track)) localShareStream.removeTrack(track);
    }
    for (const track of wanted) {
      if (!localShareStream.getTracks().includes(track)) localShareStream.addTrack(track);
    }
    return localShareStream;
  }

  function resetShareState() {
    if (videoPipeline) {
      videoPipeline.stop();
      videoPipeline = null;
    }
    stopStreamTracks(rawSourceStream);
    rawSourceStream = null;
    stopTrack(shareMicTrack);
    shareMicTrack = null;
    systemAudioTrack = null;
    shareAudioTrack = null;
    shareVideoTrack = null;
    localShareStream = null;
  }

  async function startSharing() {
    if (shareBusy || isSharing) return;
    if (activeShareCount() >= 3 && !participants.get(self.id)?.sharing) {
      showToast('Já existe uma transmissão ativa');
      return;
    }
    if (isCameraSource() && shareSettings.audioMode === 'system') {
      shareSettings.audioMode = 'none';
      persistShareSettings();
    }

    shareBusy = true;
    renderControls();
    try {
      // Registra no servidor primeiro (valida limite de 3 transmissões).
      await TTGG.api(`/rooms/${code}/share/start`, { method: 'POST', body: '{}' });

      const acquired = await acquireSourceStream(shareSettings.source);
      rawSourceStream = acquired;
      systemAudioTrack = isCameraSource() ? null : acquired.getAudioTracks()[0] || null;

      if (systemAudioTrack) {
        systemAudioTrack.addEventListener('ended', () => {
          if (shareAudioTrack !== systemAudioTrack) return;
          shareAudioTrack = null;
          broadcastShareTrack('audio', null);
          syncLocalShareStream();
          renderShares();
          showToast('O áudio da transmissão foi interrompido. Ajuste a fonte em Transmissão para continuar.', 'info');
        });
      }

      const rawVideo = acquired.getVideoTracks()[0];
      if (!rawVideo) throw new Error('A fonte escolhida não enviou vídeo.');

      const built = buildVideoTrack(rawVideo);
      videoPipeline = built.pipeline;
      shareVideoTrack = built.track;

      shareAudioTrack = null;
      stopTrack(shareMicTrack);
      shareMicTrack = null;

      if (shareSettings.audioMode === 'mic') {
        shareMicTrack = await openShareMic();
        shareAudioTrack = shareMicTrack;
        if (!shareAudioTrack) {
          shareSettings.audioMode = 'none';
          persistShareSettings();
        }
      } else if (shareSettings.audioMode === 'system') {
        shareAudioTrack = systemAudioTrack;
        if (!shareAudioTrack) {
          showToast(
            'Este navegador não liberou áudio da tela escolhida. Escolha outra fonte de áudio em Transmissão.',
            'info'
          );
        }
      }

      syncLocalShareStream();

      for (const peer of peers.values()) {
        for (const track of localShareStream.getTracks()) {
          try {
            const sender = peer.pc.addTrack(track, localShareStream);
            applyShareEncoding(sender, track);
            if (track.kind === 'video') peer.shareSenders.video = sender;
            else peer.shareSenders.audio = sender;
          } catch {
            /* já adicionado */
          }
        }
      }

      isSharing = true;
      if (socket && socket.connected) socket.emit('room:share', { on: true });
      renderShares();
      renderControls();
      renderShareSettings();
    } catch (err) {
      if (!isSharing) resetShareState();
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
      renderShareSettings();
    }
  }

  /** Troca a fonte transmitida (tela/webcam) sem encerrar a transmissão. */
  async function switchSource() {
    if (!isSharing || shareBusy) return false;
    shareBusy = true;
    renderControls();
    try {
      const acquired = await acquireSourceStream(shareSettings.source);
      const rawVideo = acquired.getVideoTracks()[0];
      if (!rawVideo) throw new Error('A fonte escolhida não enviou vídeo.');

      const oldSource = rawSourceStream;
      const oldPipeline = videoPipeline;

      rawSourceStream = acquired;
      systemAudioTrack = isCameraSource() ? null : acquired.getAudioTracks()[0] || null;

      const built = buildVideoTrack(rawVideo);
      videoPipeline = built.pipeline;
      shareVideoTrack = built.track;
      await broadcastShareTrack('video', shareVideoTrack);
      if (oldPipeline) oldPipeline.stop();

      let audioWarning = null;
      if (shareSettings.audioMode === 'system') {
        if (systemAudioTrack && systemAudioTrack.readyState === 'live') {
          shareAudioTrack = systemAudioTrack;
          await broadcastShareTrack('audio', shareAudioTrack);
        } else {
          audioWarning = 'A nova área escolhida não expôs áudio do sistema.';
        }
      }

      // Encerra só o que saiu de uso (o áudio ainda transmitido é preservado).
      if (oldSource) {
        for (const track of oldSource.getTracks()) {
          if (track !== shareAudioTrack) stopTrack(track);
        }
      }

      syncLocalShareStream();
      renderShares();
      renderShareSettings();
      showToast(isCameraSource() ? 'Câmera trocada com sucesso.' : 'Tela trocada com sucesso.', 'info');
      if (audioWarning) showToast(audioWarning, 'info');
      return true;
    } catch (err) {
      if (err && err.name === 'NotAllowedError') showToast('Troca de fonte cancelada.', 'info');
      else showToast('Não foi possível trocar a fonte.');
      return false;
    } finally {
      shareBusy = false;
      renderControls();
      renderShareSettings();
    }
  }

  /** Alterna entre tela e webcam — também com a transmissão já no ar. */
  async function setShareSource(source) {
    if (shareBusy || shareSettings.source === source) return;
    const previous = shareSettings.source;
    const previousAudio = shareSettings.audioMode;
    shareSettings.source = source;

    if (source === 'camera' && shareSettings.audioMode === 'system') {
      shareSettings.audioMode = 'none';
      if (isSharing) {
        await broadcastShareTrack('audio', null);
        shareAudioTrack = null;
        stopTrack(shareMicTrack);
        shareMicTrack = null;
      }
      showToast('Áudio do sistema não existe na webcam: fonte ajustada para sem áudio.', 'info');
    }
    persistShareSettings();

    if (!isSharing) {
      renderShareSettings();
      renderControls();
      await populateCameraDevices();
      return;
    }

    const ok = await switchSource();
    if (!ok) {
      shareSettings.source = previous;
      shareSettings.audioMode = previousAudio;
      persistShareSettings();
      await recoverShareAudio().catch(() => {});
      renderShareSettings();
      renderControls();
    }
  }

  /** Aplica resolução/fps escolhidos a uma transmissão já em andamento. */
  async function applyVideoQuality() {
    if (!isSharing || shareBusy || !rawSourceStream) return;
    if (isCameraSource()) {
      // A câmera precisa ser reaberta para aplicar resolução/fps pedidos.
      await switchSource();
      return;
    }
    const rawVideo = rawSourceStream.getVideoTracks()[0];
    if (!rawVideo) return;

    const built = buildVideoTrack(rawVideo);
    const oldPipeline = videoPipeline;
    videoPipeline = built.pipeline;
    shareVideoTrack = built.track;
    await broadcastShareTrack('video', shareVideoTrack);
    if (oldPipeline) oldPipeline.stop();

    syncLocalShareStream();
    renderShares();
  }

  /** Escolhe de onde vem o áudio transmitido (sistema, microfone ou nenhum). */
  async function setShareAudioMode(mode) {
    const previous = shareSettings.audioMode;
    shareSettings.audioMode = mode;
    persistShareSettings();

    if (!isSharing) {
      renderShareSettings();
      return;
    }

    if (mode === 'none') {
      await broadcastShareTrack('audio', null);
      shareAudioTrack = null;
      stopTrack(shareMicTrack);
      shareMicTrack = null;
    } else if (mode === 'mic') {
      if (!shareMicTrack || shareMicTrack.readyState !== 'live') {
        shareMicTrack = await openShareMic();
      }
      if (shareMicTrack) {
        shareAudioTrack = shareMicTrack;
        await broadcastShareTrack('audio', shareAudioTrack);
      } else {
        shareSettings.audioMode = 'none';
        persistShareSettings();
      }
    } else {
      // Áudio do sistema: só existe vindo de uma captura de tela nova.
      if (systemAudioTrack && systemAudioTrack.readyState === 'live') {
        shareAudioTrack = systemAudioTrack;
        await broadcastShareTrack('audio', shareAudioTrack);
      } else {
        showToast('Para transmitir o áudio do sistema é preciso escolher a tela novamente.', 'info');
        const ok = await switchSource();
        if (!ok || !systemAudioTrack || systemAudioTrack.readyState !== 'live') {
          shareSettings.audioMode = previous;
          persistShareSettings();
          renderShareSettings();
          showToast(
            `Sem áudio do sistema nesta área: a fonte continuou em ${audioModeLabel(previous)}.`,
            'info'
          );
        }
      }
    }

    if (shareSettings.audioMode !== 'mic' && shareMicTrack && shareMicTrack !== shareAudioTrack) {
      stopTrack(shareMicTrack);
      shareMicTrack = null;
    }

    syncLocalShareStream();
    renderShares();
    renderShareSettings();
  }

  async function stopSharing() {
    if (!isSharing && !localShareStream) return;
    isSharing = false;

    for (const peer of peers.values()) removeShareSenders(peer);
    resetShareState();

    if (socket && socket.connected) socket.emit('room:share', { on: false });
    TTGG.api(`/rooms/${code}/share/stop`, { method: 'POST', body: '{}' }).catch(() => {});
    renderShares();
    renderControls();
    renderShareSettings();
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
    deafenBtn.classList.toggle('off', deafened);
    deafenLabel.textContent = deafened ? 'Áudio silenciado' : 'Áudio';
    deafenBtn.title = deafened ? 'Reativar áudio' : 'Silenciar áudio recebido';

    const selfParticipant = self ? participants.get(self.id) : null;
    const selfSharing = isSharing || Boolean(selfParticipant && selfParticipant.sharing);
    const blocked = !selfSharing && activeShareCount() >= 3;

    shareBtn.classList.toggle('sharing', selfSharing);
    shareLabel.textContent = selfSharing
      ? 'Encerrar transmissão'
      : isCameraSource()
        ? 'Compartilhar webcam'
        : 'Compartilhar tela';
    shareBtn.disabled = shareBusy || (!selfSharing && blocked);
    shareBtn.title = blocked ? 'Já existe uma transmissão ativa' : shareLabel.textContent;
  }

  function participantTemplate(p) {
    const isSelf = self && p.id === self.id;
    const host = p.role === 'OWNER';
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

    // Volume do microfone de cada participante (não faz sentido para você).
    const micVolume = volumeOf(peerVolumes, p.id);
    const volumeCtl = isSelf
      ? ''
      : `<button class="icon-btn" data-act="volume" title="Volume do microfone de ${TTGG.escapeHtml(p.displayName)}">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
         </button>
         <div class="participant-volume hidden" data-volume-row>
           <input type="range" min="0" max="1" step="0.05" data-mic-volume value="${micVolume}"
                  aria-label="Volume do microfone de ${TTGG.escapeHtml(p.displayName)}" />
           <span class="vol-value" data-vol-value>${Math.round(micVolume * 100)}%</span>
         </div>`;

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
          ${p.deafened ? '<span title="Áudio silenciado no servidor">· surdo</span>' : ''}
          ${p.sharing ? '<span class="sharing">· compartilhando</span>' : ''}
        </div>
      </div>
      ${actions}
      ${volumeCtl}
    `;

    wrap.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'volume') {
        const row = wrap.querySelector('[data-volume-row]');
        if (row) row.classList.toggle('hidden');
        return;
      }
      moderate(btn.dataset.act, p.id);
    });

    const range = wrap.querySelector('[data-mic-volume]');
    if (range) {
      range.addEventListener('input', () => {
        const value = Number(range.value);
        peerVolumes.set(p.id, value);
        const label = wrap.querySelector('[data-vol-value]');
        if (label) label.textContent = `${Math.round(value * 100)}%`;
        applyAudioVolumes();
      });
    }

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
        meta.innerHTML = `
          <span class="dot ${p.status === 'ONLINE' ? '' : 'off'}"></span>
          <span>${p.status === 'ONLINE' ? 'online' : 'offline'}</span>
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
          <div class="tile-volume">
            <button class="icon-btn" data-share-mute title="Silenciar áudio desta transmissão">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
            </button>
            <input type="range" min="0" max="1" step="0.05" data-share-volume
                   aria-label="Volume da transmissão" />
          </div>
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

        // Volume individual do áudio desta transmissão.
        const range = el.querySelector('[data-share-volume]');
        const muteBtn = el.querySelector('[data-share-mute]');
        const syncVolumeUi = () => {
          const value = volumeOf(shareVolumes, p.id);
          if (document.activeElement !== range) range.value = String(value);
          muteBtn.classList.toggle('off', value === 0);
          muteBtn.title = value === 0 ? 'Reativar áudio desta transmissão' : 'Silenciar áudio desta transmissão';
        };
        range.value = String(volumeOf(shareVolumes, p.id));
        range.addEventListener('input', () => {
          const value = Number(range.value);
          shareVolumes.set(p.id, value);
          if (value > 0) sharePrevVolumes.set(p.id, value);
          syncVolumeUi();
          applyAudioVolumes();
        });
        muteBtn.addEventListener('click', () => {
          const current = volumeOf(shareVolumes, p.id);
          if (current > 0) {
            sharePrevVolumes.set(p.id, current);
            shareVolumes.set(p.id, 0);
          } else {
            shareVolumes.set(p.id, sharePrevVolumes.get(p.id) || 1);
          }
          syncVolumeUi();
          applyAudioVolumes();
        });
        el._syncVolumeUi = syncVolumeUi;

        tile = { el, video };
        tiles.set(p.id, tile);
        shareGrid.appendChild(el);
      }

      tile.el.querySelector('[data-name]').textContent =
        p.displayName + (self && p.id === self.id ? ' (você)' : '');

      // Botão de configuração aparece só na sua própria transmissão.
      let settingsBtn = tile.el.querySelector('[data-share-settings]');
      if (p.id === self.id && !settingsBtn) {
        settingsBtn = document.createElement('button');
        settingsBtn.className = 'icon-btn';
        settingsBtn.dataset.shareSettings = '1';
        settingsBtn.title = 'Configurar transmissão';
        settingsBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
        settingsBtn.addEventListener('click', openShareSettings);
        tile.el.querySelector('.tile-actions').appendChild(settingsBtn);
      } else if (p.id !== self.id && settingsBtn) {
        settingsBtn.remove();
      }

      if (tile.el._syncVolumeUi) tile.el._syncVolumeUi();

      // Fonte do vídeo: prévia local ou stream remoto recebido.
      const stream = p.id === self.id ? localShareStream : (peers.get(p.id) || {}).shareStream;
      if (stream && tile.video.srcObject !== stream) {
        tile.video.srcObject = stream;
        tile.video.play().catch(() => {});
      }
      if (!stream && tile.video.srcObject) tile.video.srcObject = null;
    }

    for (const [id, tile] of tiles) {
      if (!seen.has(id)) {
        tile.video.srcObject = null;
        tile.el.remove();
        tiles.delete(id);
        // A transmissão acabou: remove também o áudio dela (o do microfone permanece).
        dropAudioElement(id, 'share');
      }
    }
  }

  /* --------------------- configurações da transmissão -------------------- */

  function audioModeLabel(mode) {
    return { system: 'áudio do sistema', mic: 'microfone', none: 'sem áudio' }[mode] || 'sem áudio';
  }

  function openShareSettings() {
    shareModal.classList.remove('hidden');
    renderShareSettings();
    populateMicDevices();
    populateCameraDevices();
  }

  function closeShareSettings() {
    shareModal.classList.add('hidden');
  }

  function renderShareSettings() {
    const camera = isCameraSource();

    for (const btn of segSource.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('active', btn.dataset.value === shareSettings.source);
      btn.disabled = shareBusy;
    }
    for (const btn of segResolution.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('active', btn.dataset.value === shareSettings.resolution);
      btn.disabled = shareBusy;
    }
    for (const btn of segFps.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('active', Number(btn.dataset.value) === shareSettings.fps);
      btn.disabled = shareBusy;
    }

    shareCameraSelect.classList.toggle('hidden', !camera);
    shareCameraSelect.disabled = shareBusy;

    shareAudioSelect.value = shareSettings.audioMode;
    shareAudioSelect.disabled = shareBusy;
    const systemOption = shareAudioSelect.querySelector('option[value="system"]');
    if (systemOption) {
      systemOption.disabled = camera;
      systemOption.hidden = camera;
    }
    shareMicSelect.classList.toggle('hidden', shareSettings.audioMode !== 'mic');
    shareMicSelect.disabled = shareBusy;

    shareLiveHint.classList.toggle('hidden', !isSharing);
    switchScreenBtn.classList.toggle('hidden', !isSharing);
    switchScreenLabel.textContent = camera ? 'Trocar câmera' : 'Trocar tela';
    shareStartLabel.textContent = camera ? 'Transmitir webcam' : 'Compartilhar tela';
    shareModalStart.classList.toggle('hidden', isSharing);
    switchScreenBtn.disabled = shareBusy;
    shareModalStart.disabled = shareBusy;

    const hints = {
      system: 'Usa o som da tela ou guia compartilhada (quando o navegador oferecer). Ao escolher a tela, marque “Compartilhar áudio”.',
      mic: 'Transmite só a voz do microfone escolhido — nada do som do computador.',
      none: 'A transmissão sai sem áudio.',
    };
    shareAudioHint.textContent = camera && shareSettings.audioMode === 'system'
      ? 'Áudio do sistema só está disponível na transmissão de tela.'
      : hints[shareSettings.audioMode] || '';
  }

  async function populateMicDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
      shareMicSelect.innerHTML = '<option value="">Microfone padrão</option>';
      inputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microfone ${index + 1}`;
        shareMicSelect.appendChild(option);
      });
      const current = shareSettings.micDeviceId;
      const found = current && inputs.some((d) => d.deviceId === current);
      shareMicSelect.value = found ? current : '';
      if (current && !found) {
        // Dispositivo sumiu (tirado da tomada / permissão revogada): volta ao padrão.
        shareSettings.micDeviceId = '';
        persistShareSettings();
      }
    } catch {
      /* sem enumerateDevices */
    }
  }

  /** Lista câmeras reais e virtuais (OBS, ManyCam, etc.). */
  async function populateCameraDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
      shareCameraSelect.innerHTML = '<option value="">Câmera padrão</option>';
      inputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Câmera ${index + 1}`;
        shareCameraSelect.appendChild(option);
      });
      const current = shareSettings.cameraDeviceId;
      const found = current && inputs.some((d) => d.deviceId === current);
      shareCameraSelect.value = found ? current : '';
      if (current && !found) {
        shareSettings.cameraDeviceId = '';
        persistShareSettings();
      }
    } catch {
      /* sem enumerateDevices */
    }
  }

  /* -------------------------------- chat --------------------------------- */

  function renderChatBadge() {
    chatBadge.classList.toggle('hidden', chatUnread === 0);
    chatBadge.textContent = chatUnread > 99 ? '99+' : String(chatUnread);
  }

  function scrollChatToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function openChat() {
    chatPanel.classList.remove('hidden');
    chatUnread = 0;
    renderChatBadge();
    scrollChatToBottom();
    chatInput.focus();
  }

  function closeChat() {
    chatPanel.classList.add('hidden');
  }

  function toggleChat() {
    if (chatPanel.classList.contains('hidden')) openChat();
    else closeChat();
  }

  function appendChatMessage(message, { silent = false } = {}) {
    chatLog.push(message);
    const empty = chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = 'chat-msg';
    const avatarHtml = message.avatar
      ? `<img src="${message.avatar}" alt="" />`
      : TTGG.escapeHtml(TTGG.initials(message.name));
    const time = new Date(message.ts || Date.now()).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });

    row.innerHTML = `
      <div class="avatar">${avatarHtml}</div>
      <div class="body">
        <div class="meta">
          <span class="who ${message.role === 'OWNER' ? 'host' : ''}">${TTGG.escapeHtml(message.name)}</span>
          <span>${time}</span>
        </div>
        <div class="text">${TTGG.escapeHtml(message.text)}</div>
      </div>`;

    chatMessages.appendChild(row);
    while (chatMessages.children.length > 200) chatMessages.firstElementChild.remove();
    scrollChatToBottom();

    if (silent) return;
    if (chatPanel.classList.contains('hidden') && (!self || message.from !== self.id)) {
      chatUnread++;
      renderChatBadge();
    }
  }

  function renderChatHistory(list) {
    chatMessages.innerHTML = '';
    chatLog.length = 0;
    if (!list || !list.length) {
      chatMessages.innerHTML = '<p class="chat-empty">Nenhuma mensagem ainda. Diga oi!</p>';
      return;
    }
    for (const message of list) appendChatMessage(message, { silent: true });
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
          if (serverMuted) showToast('Seu microfone foi silenciado pelo dono da sala.');
          else showToast('Seu microfone foi reativado pelo dono da sala.', 'info');
          renderControls();
        }
        if (me.deafened !== deafened) {
          deafened = me.deafened;
          applyAudioVolumes();
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

    socket.on('chat:history', (list) => renderChatHistory(list));

    socket.on('chat:message', (message) => {
      if (!message || !message.text) return;
      // Evita duplicar quando o histórico chega depois das mensagens novas.
      if (chatLog.some((m) => m.id === message.id)) return;
      appendChatMessage(message);
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
        applyAudioVolumes();
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

  deafenBtn.addEventListener('click', toggleDeafen);
  shareBtn.addEventListener('click', () => {
    if (isSharing) {
      stopSharing();
      return;
    }
    const me = self ? participants.get(self.id) : null;
    if (me && me.sharing) {
      // Sinal preso no servidor (ex.: a página foi recarregada no meio da transmissão).
      if (socket && socket.connected) socket.emit('room:share', { on: false });
      TTGG.api(`/rooms/${code}/share/stop`, { method: 'POST', body: '{}' }).catch(() => {});
      showToast('Transmissão anterior encerrada.', 'info');
      return;
    }
    openShareSettings(); // escolher qualidade/áudio antes de começar
  });
  leaveCtrlBtn.addEventListener('click', leave);
  leaveBtn.addEventListener('click', leave);

  // Configurações da transmissão (qualidade, áudio e troca de tela).
  shareModalClose.addEventListener('click', closeShareSettings);
  shareModalStart.addEventListener('click', () => {
    closeShareSettings();
    startSharing();
  });
  switchScreenBtn.addEventListener('click', () => {
    switchSource();
  });

  segSource.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    setShareSource(btn.dataset.value);
  });

  shareCameraSelect.addEventListener('change', async () => {
    shareSettings.cameraDeviceId = shareCameraSelect.value;
    persistShareSettings();
    if (isSharing && isCameraSource()) await switchSource();
  });

  segResolution.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    if (shareSettings.resolution === btn.dataset.value) return;
    shareSettings.resolution = btn.dataset.value;
    persistShareSettings();
    renderShareSettings();
    applyVideoQuality();
  });

  segFps.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    const fps = Number(btn.dataset.value);
    if (shareSettings.fps === fps) return;
    shareSettings.fps = fps;
    persistShareSettings();
    renderShareSettings();
    applyVideoQuality();
  });

  shareAudioSelect.addEventListener('change', () => {
    setShareAudioMode(shareAudioSelect.value);
  });

  shareMicSelect.addEventListener('change', async () => {
    shareSettings.micDeviceId = shareMicSelect.value;
    persistShareSettings();
    if (shareSettings.audioMode !== 'mic' || !isSharing) return;
    // Troca o microfone usado na transmissão ao vivo.
    const next = await openShareMic();
    if (!next) return;
    stopTrack(shareMicTrack);
    shareMicTrack = next;
    shareAudioTrack = next;
    await broadcastShareTrack('audio', next);
    syncLocalShareStream();
    renderShares();
  });

  // Chat da sala.
  chatBtn.addEventListener('click', toggleChat);
  chatClose.addEventListener('click', closeChat);
  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    if (socket && socket.connected) socket.emit('chat:send', { text });
    chatInput.value = '';
    chatInput.focus();
  });

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
  for (const modal of [closeModal, regenModal, shareModal]) {
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeModal.classList.add('hidden');
    regenModal.classList.add('hidden');
    shareModal.classList.add('hidden');
    if (!chatPanel.classList.contains('hidden') && document.activeElement !== chatInput) closeChat();
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
    if (videoPipeline) videoPipeline.stop();
    if (localShareStream) stopStreamTracks(localShareStream);
    if (rawSourceStream) stopStreamTracks(rawSourceStream);
    if (shareMicTrack) stopTrack(shareMicTrack);
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
      return { phase, deafened, isSharing, serverMuted, code, source: shareSettings.source };
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
