document.addEventListener('DOMContentLoaded', () => {
  const nameInput = document.getElementById('nameInput');
  const roomCodeInput = document.getElementById('roomCodeInput');
  const createRoomBtn = document.getElementById('createRoomBtn');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const startForm = document.getElementById('startForm');
  const errorBox = document.getElementById('startError');

  const formatRoomCode = (value = '') =>
    value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);

  const updateJoinState = () => {
    const hasName = Boolean(nameInput.value.trim());
    const hasCode = Boolean(roomCodeInput.value.trim());
    joinRoomBtn.disabled = !(hasName && hasCode);
  };

  const showError = (message = '') => {
    errorBox.textContent = message;
  };

  const setBusy = (busy) => {
    createRoomBtn.disabled = busy;
    joinRoomBtn.disabled = busy || !(nameInput.value.trim() && roomCodeInput.value.trim());
  };

  const redirectToRoom = (roomCode, name) => {
    const params = new URLSearchParams({ room: roomCode, name });
    window.location.href = `/room.html?${params.toString()}`;
  };

  const requestRoomCreation = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showError('Введите имя перед созданием комнаты');
      nameInput.focus();
      return;
    }

    setBusy(true);
    showError('');

    try {
      const response = await fetch('/api/create-room', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to create room');
      const data = await response.json();
      if (!data?.roomCode) throw new Error('roomCode missing');
      redirectToRoom(data.roomCode, name);
    } catch (error) {
      console.error(error);
      showError('Не удалось создать комнату. Попробуйте снова.');
    } finally {
      setBusy(false);
    }
  };

  startForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const roomCode = formatRoomCode(roomCodeInput.value);

    if (!name) {
      showError('Введите имя, чтобы присоединиться');
      nameInput.focus();
      return;
    }

    if (!roomCode) {
      showError('Введите корректный код комнаты');
      roomCodeInput.focus();
      return;
    }

    showError('');
    redirectToRoom(roomCode, name);
  });

  createRoomBtn.addEventListener('click', (event) => {
    event.preventDefault();
    requestRoomCreation();
  });

  [nameInput, roomCodeInput].forEach((input) => {
    input.addEventListener('input', () => {
      if (input === roomCodeInput) {
        input.value = formatRoomCode(input.value);
      }
      showError('');
      updateJoinState();
    });
  });

  updateJoinState();
});
