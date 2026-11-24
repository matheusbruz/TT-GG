/* TT GG — landing: criar sala ou entrar por código/link. */

(() => {
  const $ = (id) => document.getElementById(id);

  const nameInput = $('nameInput');
  const codeInput = $('codeInput');
  const createBtn = $('createBtn');
  const joinBtn = $('joinBtn');
  const formError = $('formError');
  const avatarBtn = $('avatarBtn');
  const avatarFile = $('avatarFile');
  const avatarPreview = $('avatarPreview');
  const avatarInitial = $('avatarInitial');

  let busy = false;

  function showError(message) {
    formError.textContent = message;
    formError.classList.toggle('hidden', !message);
  }

  function renderAvatar() {
    const saved = TTGG.store.getAvatar();
    if (saved) {
      avatarPreview.src = saved;
      avatarPreview.classList.remove('hidden');
      avatarInitial.classList.add('hidden');
    } else {
      avatarPreview.classList.add('hidden');
      avatarInitial.classList.remove('hidden');
    }
    avatarInitial.textContent = TTGG.initials(nameInput.value) || '?';
  }

  function renderInitial() {
    if (!TTGG.store.getAvatar()) {
      avatarInitial.textContent = TTGG.initials(nameInput.value) || '?';
    }
  }

  async function withBusy(button, fn) {
    if (busy) return;
    const check = TTGG.validateDisplayName(nameInput.value);
    if (check.error) {
      showError(check.error);
      nameInput.focus();
      return;
    }

    busy = true;
    showError('');
    createBtn.disabled = true;
    joinBtn.disabled = true;
    const original = button.textContent;
    button.dataset.label = original;
    button.textContent = 'Aguarde…';

    try {
      await fn(check.name);
    } catch (err) {
      showError(err instanceof TTGG.ApiError ? err.message : 'Não foi possível conectar ao servidor.');
      button.textContent = button.dataset.label;
      createBtn.disabled = false;
      joinBtn.disabled = false;
    } finally {
      busy = false;
    }
  }

  async function createRoom(displayName) {
    TTGG.store.setDisplayName(displayName);
    const { room } = await TTGG.api('/rooms', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    });
    window.location.href = `/room/${room.code}`;
  }

  async function joinRoom(displayName) {
    const code = TTGG.extractRoomCode(codeInput.value);
    if (!code) {
      showError('Código ou link de sala inválido.');
      codeInput.focus();
      return;
    }
    TTGG.store.setDisplayName(displayName);
    const { room } = await TTGG.api(`/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    });
    window.location.href = `/room/${room.code}`;
  }

  avatarBtn.addEventListener('click', () => avatarFile.click());

  avatarFile.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      await TTGG.readAndStoreAvatar(file);
      showError('');
      renderAvatar();
    } catch (err) {
      showError(err.message || 'Não foi possível usar essa imagem.');
    }
  });

  nameInput.addEventListener('input', renderInitial);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') withBusy(createBtn, createRoom);
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') withBusy(joinBtn, joinRoom);
  });

  createBtn.addEventListener('click', () => withBusy(createBtn, createRoom));
  joinBtn.addEventListener('click', () => withBusy(joinBtn, joinRoom));

  // Restaura identidade salva neste navegador.
  const savedName = TTGG.store.getDisplayName();
  if (savedName) nameInput.value = savedName;
  renderAvatar();

  // Preenche o campo de código quando a URL traz um convite.
  const fromUrl = TTGG.extractRoomCode(window.location.href.includes('/room/')
    ? window.location.pathname
    : new URLSearchParams(window.location.search).get('code') || '');
  if (fromUrl) codeInput.value = fromUrl;
})();
