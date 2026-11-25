# TT GG Transmissão

Salas de transmissão de tela + áudio em tempo real (WebRTC mesh + Socket.IO).

## Rodar localmente

```bash
npm install
npm start
```

Abra **http://localhost:3000**.

## Para usar com amigos

- **Mesmo PC:** `http://localhost:3000` já é seguro → getUserMedia funciona.
- **Rede local:** precisa de HTTPS → tunnel (cloudflared/ngrok).
- **Deploy:** `npm start` (o app lê `PORT`).

## O que o app faz

- **Transmissão**
  - Compartilhar tela com áudio (sistema, microfone ou nenhum).
  - Até 3 transmissões simultâneas.
  - Qualidade: 720p/1080p × 30/60 fps.
  - Trocar tela/fonte de áudio durante a transmissão.
  - Volume individual por transmissão (slider + mudo).

- **Participantes**
  - Chat de texto da sala (até 200 msgs / 500 chars, badge de não lidas).
  - Volume por mic/transmissão.
  - Moderação: expulsar, silenciar, ensurdecer, parar transmissão.

- **Áudio**
  - Fonte escolhida pela transmissão.
  - Recuperação automática se o áudio se interromper.

## Estrutura

```
server.js          # Express + Socket.IO, API REST, WebRTC signaling
public/
  room.js          # malha WebRTC + moderação + transmissão
```
