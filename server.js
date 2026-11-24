'use strict';

/**
 * TT GG — Transmissão
 * Servidor de salas: API REST + sinalização WebRTC via Socket.IO (namespace /room).
 *
 * A API replica o contrato observado no site de referência:
 *   POST   /rooms                          -> cria sala (201) e devolve cookie de sessão
 *   POST   /rooms/:code/join               -> entra na sala (200)
 *   DELETE /rooms/:code                    -> encerra sala (dono)
 *   POST   /rooms/:code/regenerate-code    -> troca o código da sala (dono)
 *   POST   /rooms/:code/share/start        -> registra início de compartilhamento
 *   POST   /rooms/:code/share/stop         -> registra fim de compartilhamento
 *   POST   /rooms/:code/participants/:id/kick          (dono)
 *   POST   /rooms/:code/participants/:id/server-mute   (dono)
 *   POST   /rooms/:code/participants/:id/server-deafen (dono)
 *   POST   /rooms/:code/participants/:id/stop-share    (dono)
 *   GET    /rooms/:code/rtc-config         -> servidores ICE para o WebRTC
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_COOKIE = 'ttgg_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

// Crockford-like: sem I, O, 0, 1 para evitar ambiguidade ao digitar.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^RVDA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const NAME_RE = /^[\p{L}\p{N}\s._-]+$/u;
const MAX_SHARES = 3;
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;
const DISCONNECT_GRACE_MS = 5000;

const ICE_SERVERS = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const nsp = io.of('/room');

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** token de sessão -> { roomCode, participantId } */
const sessions = new Map();
/** código -> sala */
const rooms = new Map();
/** participantId -> Timeout de expulsão adiado (grace period) */
const pendingRemovals = new Map();

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function newCode() {
  const bytes = crypto.randomBytes(4);
  let out = '';
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `RVDA-${out}`;
}

function uniqueCode() {
  let code = newCode();
  while (rooms.has(code)) code = newCode();
  return code;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function validateName(displayName) {
  const name = String(displayName ?? '').trim();
  if (name.length < 2) return { error: 'Nome muito curto', status: 400 };
  if (name.length > 24) return { error: 'Nome muito longo', status: 400 };
  if (!NAME_RE.test(name)) {
    return { error: 'Use apenas letras, números, espaços, ponto, traço ou underline', status: 400 };
  }
  return { name };
}

function publicParticipant(p) {
  return {
    id: p.id,
    displayName: p.displayName,
    role: p.role,
    status: p.status,
    avatar: p.avatar || null,
    sharing: p.sharing,
    micOn: p.micOn,
    muted: p.muted,
    deafened: p.deafened,
  };
}

function roomSnapshot(room) {
  return {
    code: room.code,
    status: room.status,
    createdAt: room.createdAt,
  };
}

function clearPending(participantId) {
  const t = pendingRemovals.get(participantId);
  if (t) {
    clearTimeout(t);
    pendingRemovals.delete(participantId);
  }
}

/* ------------------------------------------------------------------ */
/* Domínio                                                            */
/* ------------------------------------------------------------------ */

function createRoom(displayName, avatar) {
  const code = uniqueCode();
  const room = {
    code,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    participants: new Map(),
    idleSince: Date.now(),
  };
  const self = {
    id: crypto.randomUUID(),
    displayName,
    avatar: avatar || null,
    role: 'OWNER',
    status: 'ONLINE',
    sharing: false,
    shareSessionId: null,
    micOn: false,
    muted: false,
    deafened: false,
    socketId: null,
  };
  room.participants.set(self.id, self);
  room.idleSince = 0;
  rooms.set(code, room);
  return { room, self };
}

function joinRoom(code, displayName, avatar, session) {
  const room = rooms.get(code);
  if (!room || room.status !== 'ACTIVE') {
    return { error: 'Sala não encontrada ou encerrada.', status: 404 };
  }

  // Sessão que já participa desta sala reutiliza o mesmo participante.
  if (session && session.roomCode === code) {
    const existing = room.participants.get(session.participantId);
    if (existing) {
      clearPending(existing.id);
      existing.status = 'ONLINE';
      if (avatar) existing.avatar = avatar;
      return { room, self: existing, reused: true };
    }
  }

  // Ao entrar em outra sala, sai da anterior (uma sala por sessão).
  if (session && session.roomCode && session.roomCode !== code) {
    leaveSessionRoom(session);
  }

  const self = {
    id: crypto.randomUUID(),
    displayName,
    avatar: avatar || null,
    role: 'PARTICIPANT',
    status: 'ONLINE',
    sharing: false,
    shareSessionId: null,
    micOn: false,
    muted: false,
    deafened: false,
    socketId: null,
  };
  room.participants.set(self.id, self);
  room.idleSince = 0;
  return { room, self, reused: false };
}

function leaveSessionRoom(session) {
  const old = rooms.get(session.roomCode);
  if (!old) return;
  const p = old.participants.get(session.participantId);
  if (p) {
    clearPending(p.id);
    old.participants.delete(p.id);
    broadcastParticipants(old);
    markIdleIfEmpty(old);
  }
  session.roomCode = null;
  session.participantId = null;
}

function markIdleIfEmpty(room) {
  room.idleSince = room.participants.size === 0 ? Date.now() : 0;
}

function ownerOf(room) {
  for (const p of room.participants.values()) if (p.role === 'OWNER') return p;
  return null;
}

function broadcastParticipants(room) {
  nsp.to(room.code).emit('participants:update', [...room.participants.values()].map(publicParticipant));
}

function emitToParticipant(room, participantId, event, payload) {
  const p = room.participants.get(participantId);
  if (p && p.socketId) nsp.to(p.socketId).emit(event, payload);
}

function activeShareCount(room) {
  let n = 0;
  for (const p of room.participants.values()) if (p.sharing) n++;
  return n;
}

function closeRoom(room) {
  room.status = 'CLOSED';
  nsp.to(room.code).emit('room:closed');
  for (const p of room.participants.values()) {
    clearPending(p.id);
    if (p.socketId) {
      const s = nsp.sockets.get(p.socketId);
      if (s) s.leave(room.code);
    }
    const sess = sessionOfParticipant(p.id);
    if (sess) {
      sess.roomCode = null;
      sess.participantId = null;
    }
  }
  rooms.delete(room.code);
}

function sessionOfParticipant(participantId) {
  for (const s of sessions.values()) {
    if (s.participantId === participantId) return s;
  }
  return null;
}

function removeParticipant(room, participantId) {
  const p = room.participants.get(participantId);
  if (!p) return null;
  clearPending(participantId);
  room.participants.delete(participantId);

  const sess = sessionOfParticipant(participantId);
  if (sess && sess.participantId === participantId) {
    sess.participantId = null;
    sess.roomCode = null;
  }

  if (p.socketId) {
    const s = nsp.sockets.get(p.socketId);
    if (s) s.leave(room.code);
  }

  // Propaga para quem ficou: quem estava vendo a tela dele encerra a stream.
  for (const other of room.participants.values()) {
    if (other.socketId) nsp.to(other.socketId).emit('peer:left', { participantId });
  }

  broadcastParticipants(room);
  markIdleIfEmpty(room);
  return p;
}

/* ------------------------------------------------------------------ */
/* API REST                                                           */
/* ------------------------------------------------------------------ */

function sessionFromReq(req) {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!token) return null;
  return sessions.get(token) || null;
}

function attachSession(res, req) {
  const token = crypto.randomBytes(24).toString('base64url');
  const session = { roomCode: null, participantId: null };
  sessions.set(token, session);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
  return session;
}

function fail(res, status, message) {
  res.status(status).json({ message });
}

/** Exige sessão válida + participante dentro da sala informada. */
function requireMember(req, res) {
  const session = sessionFromReq(req);
  if (!session) {
    fail(res, 401, 'Sessão inválida.');
    return null;
  }
  const room = rooms.get(req.params.code);
  if (!room || room.status !== 'ACTIVE') {
    fail(res, 404, 'Sala não encontrada ou encerrada.');
    return null;
  }
  const self = room.participants.get(session.participantId);
  if (!self || session.roomCode !== room.code) {
    fail(res, 401, 'Sessão inválida.');
    return null;
  }
  return { session, room, self };
}

function requireOwner(req, res) {
  const ctx = requireMember(req, res);
  if (!ctx) return null;
  if (ctx.self.role !== 'OWNER') {
    fail(res, 403, 'Apenas o dono da sala pode fazer isso.');
    return null;
  }
  return ctx;
}

// POST /rooms
app.post('/rooms', (req, res) => {
  const check = validateName(req.body && req.body.displayName);
  if (check.error) return fail(res, check.status, check.error);

  let session = sessionFromReq(req);
  if (!session) session = attachSession(res, req);
  else if (session.roomCode) leaveSessionRoom(session);

  const { room, self } = createRoom(check.name, req.body && req.body.avatar);
  session.roomCode = room.code;
  session.participantId = self.id;

  res.status(201).json({ room: roomSnapshot(room), self: publicParticipant(self) });
});

// POST /rooms/:code/join
app.post('/rooms/:code/join', (req, res) => {
  const rawCode = String(req.params.code || '').trim().toUpperCase();
  if (!CODE_RE.test(rawCode)) return fail(res, 400, 'Código de sala inválido');

  const check = validateName(req.body && req.body.displayName);
  if (check.error) return fail(res, check.status, check.error);

  let session = sessionFromReq(req);
  if (!session) session = attachSession(res, req);

  const result = joinRoom(rawCode, check.name, req.body && req.body.avatar, session);
  if (result.error) return fail(res, result.status, result.error);

  session.roomCode = result.room.code;
  session.participantId = result.self.id;

  if (!result.reused) broadcastParticipants(result.room);
  res.json({ room: roomSnapshot(result.room), self: publicParticipant(result.self) });
});

// GET /rooms/:code/rtc-config
app.get('/rooms/:code/rtc-config', (req, res) => {
  const ctx = requireMember(req, res);
  if (!ctx) return;
  res.json({ iceServers: ICE_SERVERS });
});

// POST /rooms/:code/share/start
app.post('/rooms/:code/share/start', (req, res) => {
  const ctx = requireMember(req, res);
  if (!ctx) return;
  const { room, self } = ctx;

  if (!self.sharing && activeShareCount(room) >= MAX_SHARES) {
    return fail(res, 409, 'Já existe uma tela sendo compartilhada');
  }

  if (!self.sharing) {
    self.sharing = true;
    self.shareSessionId = crypto.randomUUID();
    broadcastParticipants(room);
  }
  res.json({ streamSessionId: self.shareSessionId });
});

// POST /rooms/:code/share/stop
app.post('/rooms/:code/share/stop', (req, res) => {
  const ctx = requireMember(req, res);
  if (!ctx) return;
  const { room, self } = ctx;
  if (self.sharing) {
    self.sharing = false;
    self.shareSessionId = null;
    broadcastParticipants(room);
  }
  res.json({ ok: true });
});

// POST /rooms/:code/regenerate-code
app.post('/rooms/:code/regenerate-code', (req, res) => {
  const ctx = requireOwner(req, res);
  if (!ctx) return;
  const { room } = ctx;

  const next = uniqueCode();
  rooms.delete(room.code);
  room.code = next;
  rooms.set(next, room);

  for (const s of nsp.adapter.rooms.get(room.code) || []) {
    const sock = nsp.sockets.get(s);
    if (sock) sock.leave(room.code);
  }
  for (const p of room.participants.values()) {
    if (p.socketId) {
      const sock = nsp.sockets.get(p.socketId);
      if (sock) sock.join(next);
    }
    const sess = sessionOfParticipant(p.id);
    if (sess) sess.roomCode = next;
  }

  nsp.to(next).emit('room:code-changed', { code: next });
  broadcastParticipants(room);
  res.json({ code: next });
});

// DELETE /rooms/:code
app.delete('/rooms/:code', (req, res) => {
  const ctx = requireOwner(req, res);
  if (!ctx) return;
  closeRoom(ctx.room);
  res.json({ ok: true });
});

function participantAction(req, res, handler) {
  const ctx = requireOwner(req, res);
  if (!ctx) return;
  const { room } = ctx;
  const target = room.participants.get(req.params.id);
  if (!target) return fail(res, 404, 'Participante não encontrado.');
  if (target.role === 'OWNER') return fail(res, 400, 'O dono da sala não pode ser moderado.');
  handler(ctx, target);
}

// POST /rooms/:code/participants/:id/kick
app.post('/rooms/:code/participants/:id/kick', (req, res) => {
  participantAction(req, res, ({ room }, target) => {
    emitToParticipant(room, target.id, 'kicked');
    removeParticipant(room, target.id);
    res.json({ ok: true });
  });
});

// POST /rooms/:code/participants/:id/server-mute
app.post('/rooms/:code/participants/:id/server-mute', (req, res) => {
  participantAction(req, res, ({ room }, target) => {
    target.muted = !target.muted;
    if (target.muted) target.micOn = false;
    emitToParticipant(room, target.id, 'muted', { muted: target.muted });
    broadcastParticipants(room);
    res.json({ muted: target.muted });
  });
});

// POST /rooms/:code/participants/:id/server-deafen
app.post('/rooms/:code/participants/:id/server-deafen', (req, res) => {
  participantAction(req, res, ({ room }, target) => {
    target.deafened = !target.deafened;
    emitToParticipant(room, target.id, 'deafened', { deafened: target.deafened });
    broadcastParticipants(room);
    res.json({ deafened: target.deafened });
  });
});

// POST /rooms/:code/participants/:id/stop-share
app.post('/rooms/:code/participants/:id/stop-share', (req, res) => {
  participantAction(req, res, ({ room }, target) => {
    if (target.sharing) {
      target.sharing = false;
      target.shareSessionId = null;
      broadcastParticipants(room);
    }
    emitToParticipant(room, target.id, 'share:force-stop');
    res.json({ ok: true });
  });
});

// SPA fallback para /room/:code
app.get('/room/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

/* ------------------------------------------------------------------ */
/* Socket.IO — namespace /room                                        */
/* ------------------------------------------------------------------ */

nsp.use((socket, next) => {
  const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
  const session = token ? sessions.get(token) : null;
  if (!session) return next(new Error('unauthorized'));
  socket.data.session = session;
  next();
});

nsp.on('connection', (socket) => {
  const session = socket.data.session;

  socket.on('room:join', ({ code } = {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    const self = room && room.participants.get(session.participantId);

    if (!room || !self || session.roomCode !== roomCode || room.status !== 'ACTIVE') {
      socket.emit('room:error', { message: 'Sala não encontrada ou encerrada.' });
      return;
    }

    clearPending(self.id);
    if (self.socketId && self.socketId !== socket.id) {
      const prev = nsp.sockets.get(self.socketId);
      if (prev) prev.leave(roomCode);
    }

    self.socketId = socket.id;
    self.status = 'ONLINE';
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    socket.emit('rtc:config', { iceServers: ICE_SERVERS });
    socket.emit('room:joined', { self: publicParticipant(self), code: roomCode });
    broadcastParticipants(room);
  });

  // Estado de microfone publicado pelo cliente (para exibir na lista).
  socket.on('room:mic', ({ on } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const self = room.participants.get(session.participantId);
    if (!self) return;
    // Silenciado pelo dono não pode voltar sozinho.
    const next = self.muted ? false : Boolean(on);
    if (self.micOn !== next) {
      self.micOn = next;
      broadcastParticipants(room);
    }
  });

  // Estado do compartilhamento publicado pelo cliente.
  socket.on('room:share', ({ on } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const self = room.participants.get(session.participantId);
    if (!self) return;
    const next = Boolean(on);
    if (self.sharing !== next) {
      if (next && activeShareCount(room) >= MAX_SHARES) return;
      self.sharing = next;
      self.shareSessionId = next ? crypto.randomUUID() : null;
      broadcastParticipants(room);
    }
  });

  // Sinalização WebRTC: retransmite para o participante alvo.
  socket.on('rtc:signal', ({ to, data } = {}) => {    const room = rooms.get(socket.data.roomCode);
    if (!room || !data) return;
    const target = room.participants.get(to);
    if (target && target.socketId) {
      nsp.to(target.socketId).emit('rtc:signal', {
        from: session.participantId,
        data,
      });
    }
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const self = room.participants.get(session.participantId);
    if (!self || self.socketId !== socket.id) return;

    self.socketId = null;
    self.status = 'OFFLINE';

    // Grace period: o cliente pode estar apenas reconectando.
    clearPending(self.id);
    pendingRemovals.set(
      self.id,
      setTimeout(() => {
        pendingRemovals.delete(self.id);
        const current = rooms.get(room.code);
        if (!current) return;
        const still = current.participants.get(self.id);
        if (still && !still.socketId) removeParticipant(current, self.id);
      }, DISCONNECT_GRACE_MS)
    );

    broadcastParticipants(room);
    markIdleIfEmpty(room);
  });
});

/* ------------------------------------------------------------------ */
/* Limpeza                                                            */
/* ------------------------------------------------------------------ */

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.idleSince && now - room.idleSince > ROOM_IDLE_TTL_MS) {
      room.status = 'CLOSED';
      rooms.delete(code);
    }
  }
  for (const [token, s] of sessions) {
    if (!s.roomCode && !s.participantId) {
      // sessão ociosa por mais de 30 dias já é removida pelo cookie; aqui só evita vazamento
      if (!sessions.has(token)) sessions.delete(token);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`TT GG transmissão rodando em http://localhost:${PORT}`);
});
