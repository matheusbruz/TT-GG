/* TT GG — utilitários compartilhados (espelha as helpers do bundle original). */

const TTGG = (() => {
  const CODE_RE = /^RVDA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  /** fetch com cookies + JSON, lançando ApiError com a mensagem do servidor. */
  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      let message = 'Erro inesperado';
      try {
        const data = await res.json();
        message = data.message || message;
      } catch {
        /* corpo não é JSON */
      }
      throw new ApiError(message, res.status);
    }
    return res.json();
  }

  /* --------------------------- identidade local --------------------------- */

  const NAME_KEY = 'ttgg_display_name';
  const AVATAR_KEY = 'ttgg_avatar';

  const store = {
    getDisplayName: () => localStorage.getItem(NAME_KEY),
    setDisplayName: (v) => localStorage.setItem(NAME_KEY, v),
    getAvatar: () => localStorage.getItem(AVATAR_KEY),
    setAvatar: (v) => localStorage.setItem(AVATAR_KEY, v),
  };

  /**
   * Lê a imagem escolhida, redimensiona para no máximo 128px (maior lado)
   * e grava como data URL JPEG 0.85 — mesmo comportamento do site original.
   */
  function readAndStoreAvatar(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
        img.onload = () => {
          const scale = Math.min(1, 128 / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('Não foi possível processar a imagem.'));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          store.setAvatar(dataUrl);
          resolve(dataUrl);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ------------------------------ sala/código ----------------------------- */

  function isValidCode(code) {
    return CODE_RE.test(String(code || '').trim().toUpperCase());
  }

  function normalizeCode(code) {
    return String(code || '').trim().toUpperCase();
  }

  /**
   * Aceita "RVDA-X7K2" ou um link de convite (…/room/RVDA-X7K2) e devolve
   * o código normalizado, ou null.
   */
  function extractRoomCode(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const direct = normalizeCode(raw);
    if (isValidCode(direct)) return direct;

    try {
      const url = new URL(raw);
      const segments = url.pathname.split('/').filter(Boolean);
      const idx = segments.indexOf('room');
      if (idx !== -1 && segments[idx + 1]) {
        const fromLink = normalizeCode(segments[idx + 1]);
        if (isValidCode(fromLink)) return fromLink;
      }
    } catch {
      /* não é uma URL */
    }
    return null;
  }

  function buildInviteLink(code) {
    return `${window.location.origin}/room/${code}`;
  }

  function validateDisplayName(value) {
    const name = String(value || '').trim();
    if (name.length < 2) return { error: 'Digite um nome com pelo menos 2 caracteres.' };
    if (name.length > 24) return { error: 'Nome muito longo.' };
    if (!/^[\p{L}\p{N}\s._-]+$/u.test(name)) {
      return { error: 'Use apenas letras, números, espaços, ponto, traço ou underline.' };
    }
    return { name };
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Copia para a área de transferência com fallback (http sem permissão). */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  return {
    api,
    ApiError,
    store,
    readAndStoreAvatar,
    isValidCode,
    normalizeCode,
    extractRoomCode,
    buildInviteLink,
    validateDisplayName,
    initials,
    escapeHtml,
    copyText,
  };
})();
