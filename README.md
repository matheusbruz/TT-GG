# TT GG Transmissão

Sistema de salas de transmissão de tela e áudio em tempo real (WebRTC mesh + Socket.IO), com moderação do dono da sala.

## Requisitos
- Node.js 18+ (testado em 20.x)
- npm

## Como rodar localmente

```bash
cd "C:\Users\Bruzaca\Desktop\TT GG"
npm install
npm start
```

Abra http://localhost:3000 no navegador.

- `npm start` sobe o servidor na porta 3000 (ou em `PORT` se definido).
- A página inicial cria ou entra em uma sala com código no formato `RVDA-XXXX`.

## Usar com amigos (internet)

O site precisa de **HTTPS** para o navegador liberar câmera/microfone/tela (getUserMedia exige contexto seguro). `http://localhost` é considerado seguro; um IP de LAN (`http://192.168.x.x`) **não** é.

### Opção A — Túnel (mais fácil, sem deploy)
1. Instale o [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) ou o [ngrok](https://ngrok.com/download).
2. Rode o servidor: `npm start`
3. Em outro terminal: `cloudflared tunnel --url http://localhost:3000` (ou `ngrok http 3000`)
4. Envie o link HTTPS gerado para seus amigos.
5. Todos entram pelo link, criam/entram na sala e compartilham o código `RVDA-XXXX`.

### Opção B — Deploy (Render / Railway / Fly.io)
1. Suba o projeto para um repositório Git (sem a pasta `node_modules`).
2. Crie um serviço web apontando para o repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Variável de ambiente: `PORT` (a plataforma define; o app lê `process.env.PORT`).
3. A plataforma fornece HTTPS automaticamente.
4. Compartilhe a URL pública.

Observações para deploy:
- Dados ficam em memória: salas são perdidas ao reiniciar o servidor.
- Uma única instância é suficiente para grupos pequenos (a malha WebRTC é peer-to-peer; o servidor só sinaliza).
- O limite de 3 compartilhamentos simultâneos está no código (`MAX_SHARES = 3`).

## Funcionalidades
- Criar sala (você vira dono/OWNER) e gerar link de convite.
- Entrar em sala por código ou link.
- Chat da sala em texto (sem histórico no servidor, até 200 mensagens, 500 caracteres, aviso de mensagem não lida).
- Compartilhar tela (até 3 simultâneos) com qualidade ajustável:
  - Resolução **720p** ou **1080p** e **30 fps** ou **60 fps** (bitrate de 2,5 a 7 Mbps conforme a escolha).
  - Escolha da **fonte de áudio**: áudio do computador (tela/guia), microfone ou nenhum — por padrão não captura o sistema inteiro.
  - Preferências lembradas no `localStorage` (`ttgg_share_resolution`, `ttgg_share_fps`, `ttgg_share_audio`, `ttgg_share_mic`).
- Durante a transmissão: **trocar a tela** e **trocar a fonte de áudio** sem encerrar, e abrir as configurações pelo botão no próprio tile (o modal também abre ao apertar **Compartilhar tela**).
- Volume individual por transmissão (slider + mudo em cada tile).
- Visualização da transmissão reduzida (grade com largura máxima), mantendo o botão de **tela cheia**.
- Áudio transmitido com fonte própria (sistema, microfone ou nenhum) e recuperação se o track de áudio encerrar durante a transmissão.
- Moderação do dono: expulsar, silenciar (server-mute), ensurdecer (server-deafen), parar compartilhamento de outro.
- Trocar o código da sala (regenerate-code) e encerrar a sala.
- Persistência de nome/avatar no `localStorage` (`ttgg_display_name`, `ttgg_avatar`).
- Cookie de sessão `ttgg_session` (HttpOnly, SameSite=Lax, 30 dias).

## Desenvolvimento
- `npm test` não está configurado; há um script de teste em `../revoada/test-ttgg.js` (34 casos da API).
- Logs do servidor aparecem no console.

## Estrutura
```
server.js          # Express + Socket.IO, API REST, sinalização WebRTC
public/
  index.html       # landing
  home.js
  room.html        # sala
  room.js          # malha WebRTC (perfect negotiation) + moderação
  lib.js           # cliente de API, storage, avatar, código/convite
  styles.css       # tokens de design
```
