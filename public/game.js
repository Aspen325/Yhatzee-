// ─── Socket & State ────────────────────────────────────────

const socket = io();
let gameState = null;
let myId = null;
let possibleScores = null;
let isHost = false;
let selectedMaxPlayers = 2;

// ─── DOM Elements ──────────────────────────────────────────

const lobbyScreen = document.getElementById('lobby-screen');
const waitingScreen = document.getElementById('waiting-screen');
const gameScreen = document.getElementById('game-screen');
const errorMessage = document.getElementById('error-message');
const playerNameInput = document.getElementById('player-name');
const roomCodeInput = document.getElementById('room-code-input');

const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const btnStart = document.getElementById('btn-start');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnRoll = document.getElementById('btn-roll');
const btnPlayAgain = document.getElementById('btn-play-again');

const displayRoomCode = document.getElementById('display-room-code');
const playerList = document.getElementById('player-list');
const turnIndicator = document.getElementById('turn-indicator');
const roundIndicator = document.getElementById('round-indicator');
const rollsLeft = document.getElementById('rolls-left');
const scoreHint = document.getElementById('score-hint');
const gameOverModal = document.getElementById('game-over-modal');
const winnerText = document.getElementById('winner-text');
const finalScores = document.getElementById('final-scores');
const tooltip = document.getElementById('tooltip');

// ─── Player count selection ─────────────────────────────────

document.querySelectorAll('.count-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.count-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMaxPlayers = parseInt(btn.dataset.count);
  });
});

// ─── Screen management ──────────────────────────────────────

function showScreen(screen) {
  [lobbyScreen, waitingScreen, gameScreen].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorMessage.classList.remove('hidden');
  setTimeout(() => errorMessage.classList.add('hidden'), 4000);
}

// ─── Lobby Actions ──────────────────────────────────────────

btnCreate.addEventListener('click', () => {
  const name = playerNameInput.value.trim();
  if (!name) {
    showError('Please enter your name.');
    return;
  }
  isHost = true;
  socket.emit('create-room', { playerName: name, maxPlayers: selectedMaxPlayers });
});

btnJoin.addEventListener('click', () => {
  const name = playerNameInput.value.trim();
  const code = roomCodeInput.value.trim();
  if (!name) { showError('Please enter your name.'); return; }
  if (!code) { showError('Please enter a room code.'); return; }
  socket.emit('join-room', { roomCode: code, playerName: name });
});

// Allow enter key
playerNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnCreate.click();
});
roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

// ─── Waiting Room ───────────────────────────────────────────

btnCopyCode.addEventListener('click', () => {
  const code = displayRoomCode.textContent;
  navigator.clipboard.writeText(code).then(() => {
    btnCopyCode.textContent = '✅';
    setTimeout(() => btnCopyCode.textContent = '📋', 2000);
  });
});

btnStart.addEventListener('click', () => {
  socket.emit('start-game');
});

// ─── Socket Events ──────────────────────────────────────────

socket.on('connect', () => {
  myId = socket.id;
});

socket.on('room-created', ({ roomCode }) => {
  displayRoomCode.textContent = roomCode;
  showScreen(waitingScreen);
});

socket.on('room-joined', ({ roomCode }) => {
  displayRoomCode.textContent = roomCode;
  showScreen(waitingScreen);
});

socket.on('error-msg', ({ message }) => {
  showError(message);
});

socket.on('game-started', () => {
  showScreen(gameScreen);
});

socket.on('game-state', (state) => {
  gameState = state;
  myId = socket.id;

  if (state.started) {
    showScreen(gameScreen);
    renderGame();
    // Request possible scores if it's my turn and I've rolled
    const currentPlayer = state.players[state.currentPlayerIndex];
    if (currentPlayer && currentPlayer.id === myId && state.rollsLeft < 3) {
      socket.emit('get-possible-scores');
    } else {
      possibleScores = null;
      renderScorecard();
    }
  } else {
    renderWaitingRoom();
  }
});

socket.on('possible-scores', (scores) => {
  possibleScores = scores;
  renderScorecard();
});

socket.on('dice-rolled', ({ dice, rollsLeft: rl }) => {
  animateDiceRoll(dice);
});

socket.on('player-disconnected', ({ playerName }) => {
  // Could show a notification here
});

// ─── Dice Rendering ─────────────────────────────────────────

function createDieFace(value) {
  const face = document.createElement('div');
  face.className = 'die-face';
  face.dataset.value = value;
  for (let i = 0; i < value; i++) {
    const dot = document.createElement('div');
    dot.className = 'die-dot';
    face.appendChild(dot);
  }
  return face;
}

function renderDice() {
  if (!gameState) return;
  const { dice, held, rollsLeft: rl } = gameState;
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = currentPlayer && currentPlayer.id === myId;

  for (let i = 0; i < 5; i++) {
    const dieEl = document.getElementById(`die-${i}`);
    const wrapper = dieEl.parentElement;
    const holdLabel = wrapper.querySelector('.hold-label');

    dieEl.innerHTML = '';
    dieEl.classList.remove('blank', 'held');

    if (dice[i] === 0) {
      dieEl.classList.add('blank');
      holdLabel.classList.add('hidden');
    } else {
      dieEl.appendChild(createDieFace(dice[i]));
      if (held[i]) {
        dieEl.classList.add('held');
        holdLabel.classList.remove('hidden');
      } else {
        holdLabel.classList.add('hidden');
      }
    }

    // Click to hold/unhold
    wrapper.onclick = () => {
      if (!isMyTurn) return;
      if (rl === 3 || rl === 0) return;
      if (dice[i] === 0) return;
      socket.emit('toggle-hold', { index: i });
    };
  }
}

function animateDiceRoll(finalDice) {
  const held = gameState ? gameState.held : [false,false,false,false,false];

  for (let i = 0; i < 5; i++) {
    if (held[i]) continue;
    const dieEl = document.getElementById(`die-${i}`);
    dieEl.classList.add('rolling');

    // Quick random faces during animation
    let count = 0;
    const interval = setInterval(() => {
      const randVal = Math.floor(Math.random() * 6) + 1;
      dieEl.innerHTML = '';
      dieEl.classList.remove('blank');
      dieEl.appendChild(createDieFace(randVal));
      count++;
      if (count >= 6) {
        clearInterval(interval);
        dieEl.innerHTML = '';
        dieEl.appendChild(createDieFace(finalDice[i]));
        dieEl.classList.remove('rolling');
      }
    }, 60);
  }
}

// ─── Roll Button ────────────────────────────────────────────

btnRoll.addEventListener('click', () => {
  if (!gameState) return;
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  if (currentPlayer.id !== myId) return;
  if (gameState.rollsLeft <= 0) return;

  socket.emit('roll-dice');
});

// ─── Scorecard Rendering ────────────────────────────────────

function buildScorecardHeader() {
  if (!gameState) return;
  const thead = document.querySelector('#scorecard thead tr');

  // Clear old player headers
  while (thead.children.length > 1) {
    thead.removeChild(thead.lastChild);
  }

  gameState.players.forEach((player, idx) => {
    const th = document.createElement('th');
    th.className = `player-col player-color-${idx}`;
    if (idx === gameState.currentPlayerIndex && !gameState.gameOver) {
      th.classList.add('current-player-col');
    }
    th.textContent = player.name;
    if (player.id === myId) th.textContent += ' (You)';
    thead.appendChild(th);
  });

  // Update section headers colspan
  document.querySelectorAll('.section-header td').forEach(td => {
    td.setAttribute('colspan', gameState.players.length + 1);
  });
}

function renderScorecard() {
  if (!gameState) return;
  buildScorecardHeader();

  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = currentPlayer && currentPlayer.id === myId;
  const hasRolled = gameState.rollsLeft < 3;

  // Category rows
  const catRows = document.querySelectorAll('#scorecard tbody tr[data-cat]');
  catRows.forEach(row => {
    const cat = row.dataset.cat;

    // Remove old score cells
    while (row.children.length > 1) {
      row.removeChild(row.lastChild);
    }

    gameState.players.forEach((player, idx) => {
      const td = document.createElement('td');
      td.className = 'score-cell';
      if (idx === gameState.currentPlayerIndex && !gameState.gameOver) {
        td.classList.add('current-player-col');
      }

      if (player.scores[cat] !== null) {
        td.textContent = player.scores[cat];
        td.classList.add('locked');
        if (player.scores[cat] === 0) td.classList.add('zero');
      } else if (isMyTurn && hasRolled && player.id === myId && possibleScores && possibleScores[cat] !== null) {
        td.textContent = possibleScores[cat];
        td.classList.add('possible');
        if (possibleScores[cat] === 0) td.classList.add('zero-possible');

        td.addEventListener('click', () => {
          socket.emit('score-category', { category: cat });
          possibleScores = null;
        });
      } else {
        td.textContent = '–';
      }

      row.appendChild(td);
    });
  });

  // Total rows
  renderTotalRow('.upper-total-row', (p) => p.totals.upperTotal);
  renderTotalRow('.bonus-row', (p) => p.totals.upperBonus, (td, val) => {
    if (val > 0) td.classList.add('has-bonus');
  });
  renderTotalRow('.lower-total-row', (p) => p.totals.lowerTotal);
  renderTotalRow('.yahtzee-bonus-row', (p) => p.totals.yahtzeeBonusTotal);
  renderTotalRow('.grand-total-row', (p) => p.totals.grandTotal);
}

function renderTotalRow(selector, valueFn, extraFn) {
  const row = document.querySelector(selector);
  if (!row) return;

  while (row.children.length > 1) {
    row.removeChild(row.lastChild);
  }

  gameState.players.forEach((player, idx) => {
    const td = document.createElement('td');
    td.className = 'score-cell';
    if (idx === gameState.currentPlayerIndex && !gameState.gameOver) {
      td.classList.add('current-player-col');
    }
    const val = valueFn(player);
    td.textContent = val;
    if (extraFn) extraFn(td, val);
    row.appendChild(td);
  });
}

// ─── Top Bar ────────────────────────────────────────────────

function renderTopBar() {
  if (!gameState) return;
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = currentPlayer && currentPlayer.id === myId;

  if (gameState.gameOver) {
    turnIndicator.textContent = 'Game Over!';
    turnIndicator.className = 'turn-indicator';
  } else if (isMyTurn) {
    turnIndicator.textContent = "Your Turn";
    turnIndicator.className = 'turn-indicator my-turn';
  } else {
    turnIndicator.textContent = `${currentPlayer.name}'s Turn`;
    turnIndicator.className = 'turn-indicator other-turn';
  }

  const maxRounds = 13;
  const round = Math.min(gameState.round, maxRounds);
  roundIndicator.textContent = `Round ${round} / ${maxRounds}`;
}

// ─── Controls ───────────────────────────────────────────────

function renderControls() {
  if (!gameState) return;
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = currentPlayer && currentPlayer.id === myId;

  rollsLeft.textContent = gameState.rollsLeft;

  if (!isMyTurn || gameState.rollsLeft <= 0 || gameState.gameOver) {
    btnRoll.disabled = true;
  } else {
    btnRoll.disabled = false;
  }

  // Show hint when rolls are used up
  if (isMyTurn && gameState.rollsLeft === 0) {
    scoreHint.classList.remove('hidden');
  } else {
    scoreHint.classList.add('hidden');
  }
}

// ─── Waiting Room Render ────────────────────────────────────

function renderWaitingRoom() {
  if (!gameState) return;
  playerList.innerHTML = '';

  gameState.players.forEach((player, idx) => {
    const item = document.createElement('div');
    item.className = 'player-item';
    item.innerHTML = `
      <span class="dot player-dot-${idx}"></span>
      <span>${player.name}${player.id === myId ? ' (You)' : ''}</span>
      ${idx === 0 ? '<span class="host-badge">HOST</span>' : ''}
    `;
    playerList.appendChild(item);
  });

  // Show start button only for host when enough players
  if (isHost && gameState.players.length >= 2) {
    btnStart.classList.remove('hidden');
  } else {
    btnStart.classList.add('hidden');
  }
}

// ─── Game Over ──────────────────────────────────────────────

function renderGameOver() {
  if (!gameState || !gameState.gameOver) {
    gameOverModal.classList.add('hidden');
    return;
  }

  gameOverModal.classList.remove('hidden');

  // Sort players by grand total
  const sorted = [...gameState.players].sort((a, b) => b.totals.grandTotal - a.totals.grandTotal);

  const rankEmojis = ['🥇', '🥈', '🥉', '4th'];
  winnerText.textContent = `🏆 ${sorted[0].name} Wins!`;

  finalScores.innerHTML = '';
  sorted.forEach((player, idx) => {
    const row = document.createElement('div');
    row.className = `final-score-row ${idx === 0 ? 'winner' : ''}`;
    row.innerHTML = `
      <span class="rank">${rankEmojis[idx] || ''}</span>
      <span class="name">${player.name}${player.id === myId ? ' (You)' : ''}</span>
      <span class="score">${player.totals.grandTotal}</span>
    `;
    finalScores.appendChild(row);
  });
}

btnPlayAgain.addEventListener('click', () => {
  gameOverModal.classList.add('hidden');
  showScreen(lobbyScreen);
  gameState = null;
  possibleScores = null;
  isHost = false;
});

// ─── Master Render ──────────────────────────────────────────

function renderGame() {
  renderTopBar();
  renderDice();
  renderControls();
  renderScorecard();
  renderGameOver();
}

// ─── Tooltips for categories ────────────────────────────────

const categoryDescriptions = {
  ones: 'Sum of all dice showing 1',
  twos: 'Sum of all dice showing 2',
  threes: 'Sum of all dice showing 3',
  fours: 'Sum of all dice showing 4',
  fives: 'Sum of all dice showing 5',
  sixes: 'Sum of all dice showing 6',
  threeOfAKind: 'At least three dice the same – score sum of all dice',
  fourOfAKind: 'At least four dice the same – score sum of all dice',
  fullHouse: 'Three of one number and two of another – scores 25',
  smallStraight: 'Four sequential dice (e.g. 1-2-3-4) – scores 30',
  largeStraight: 'Five sequential dice (e.g. 1-2-3-4-5) – scores 40',
  yahtzee: 'All five dice the same – scores 50',
  chance: 'Any combination – score sum of all dice'
};

document.querySelectorAll('#scorecard tbody tr[data-cat]').forEach(row => {
  const cat = row.dataset.cat;
  const desc = categoryDescriptions[cat];
  if (!desc) return;

  row.querySelector('.cat-name').addEventListener('mouseenter', (e) => {
    tooltip.textContent = desc;
    tooltip.classList.remove('hidden');
    const rect = e.target.getBoundingClientRect();
    tooltip.style.left = (rect.right + 8) + 'px';
    tooltip.style.top = (rect.top) + 'px';
  });

  row.querySelector('.cat-name').addEventListener('mouseleave', () => {
    tooltip.classList.add('hidden');
  });
});

// ─── Focus name input on load ───────────────────────────────
playerNameInput.focus();
