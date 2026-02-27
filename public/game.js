// ═══════════════════════════════════════════════════════════════
//  YAHTZEE — Client
// ═══════════════════════════════════════════════════════════════

const socket = io();
let gameState = null;
let myId = null;
let possibleScores = null;
let isHost = false;
let selectedMaxPlayers = 2;
let dicePhysics = []; // physics objects for each die
let animating = false;
let animationFrameId = null;
let finalDiceValues = [0,0,0,0,0];

// ─── DOM refs ──────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const lobbyScreen   = $('#lobby-screen');
const waitingScreen = $('#waiting-screen');
const gameScreen    = $('#game-screen');
const errorMessage  = $('#error-message');
const nameInput     = $('#player-name');
const codeInput     = $('#room-code-input');
const btnCreate     = $('#btn-create');
const btnJoin       = $('#btn-join');
const btnStart      = $('#btn-start');
const btnCopy       = $('#btn-copy-code');
const btnRoll       = $('#btn-roll');
const btnPlayAgain  = $('#btn-play-again');
const displayCode   = $('#display-room-code');
const playerListEl  = $('#player-list');
const turnInd       = $('#turn-indicator');
const roundInd      = $('#round-indicator');
const rollsLeftEl   = $('#rolls-left');
const scoreHint     = $('#score-hint');
const gameOverModal = $('#game-over-modal');
const winnerText    = $('#winner-text');
const finalScoresEl = $('#final-scores');
const tooltipEl     = $('#tooltip');
const feltSurface   = $('#felt-surface');

// ─── Screen management ──────────────────────────────────────

function showScreen(s) {
  [lobbyScreen, waitingScreen, gameScreen].forEach(el => el.classList.remove('active'));
  s.classList.add('active');
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorMessage.classList.remove('hidden');
  setTimeout(() => errorMessage.classList.add('hidden'), 4000);
}

// ─── Player count select ────────────────────────────────────

$$('.count-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.count-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMaxPlayers = parseInt(btn.dataset.count);
  });
});

// ─── Lobby ──────────────────────────────────────────────────

btnCreate.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { showError('Please enter your name.'); return; }
  isHost = true;
  socket.emit('create-room', { playerName: name, maxPlayers: selectedMaxPlayers });
});

btnJoin.addEventListener('click', () => {
  const name = nameInput.value.trim();
  const code = codeInput.value.trim();
  if (!name) { showError('Please enter your name.'); return; }
  if (!code) { showError('Please enter a room code.'); return; }
  socket.emit('join-room', { roomCode: code, playerName: name });
});

nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnCreate.click(); });
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnJoin.click(); });

// ─── Waiting Room ───────────────────────────────────────────

btnCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(displayCode.textContent).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => btnCopy.textContent = 'Copy', 2000);
  });
});

btnStart.addEventListener('click', () => socket.emit('start-game'));

// ─── Socket Events ──────────────────────────────────────────

socket.on('connect', () => { myId = socket.id; });

socket.on('room-created', ({ roomCode }) => {
  displayCode.textContent = roomCode;
  showScreen(waitingScreen);
});

socket.on('room-joined', ({ roomCode }) => {
  displayCode.textContent = roomCode;
  showScreen(waitingScreen);
});

socket.on('error-msg', ({ message }) => showError(message));

socket.on('game-started', () => showScreen(gameScreen));

socket.on('game-state', (state) => {
  gameState = state;
  myId = socket.id;

  if (state.started) {
    showScreen(gameScreen);

    // When dice are reset (new turn starting), cancel any in-flight animation
    // so the dice disappear immediately and controls update correctly.
    if (animating && state.dice.every(d => d === 0)) {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      animating = false;
    }

    renderGame();
    const cp = state.players[state.currentPlayerIndex];
    if (cp && cp.id === myId && state.rollsLeft < 3) {
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

socket.on('dice-rolled', ({ dice }) => {
  finalDiceValues = dice;
  launchDiceAnimation(dice);
});

socket.on('player-disconnected', () => {});

// ═══════════════════════════════════════════════════════════════
//  3D DICE PHYSICS ENGINE
// ═══════════════════════════════════════════════════════════════

const DIE_SIZE = 64;
const HALF = DIE_SIZE / 2;
const ANIM_DURATION = 1800; // ms total
const BOUNCE_DAMPING = 0.55;
const FRICTION = 0.97;
const ANGULAR_FRICTION = 0.96;
const GRAVITY = 0.0015; // gentle downward pull to settle
const WALL_BOUNCE = 0.5;

// Rotation values that show each face front-facing
const FACE_ROTATIONS = {
  1: { x: 0,   y: 0   },
  2: { x: 0,   y: 180 },
  3: { x: 0,   y: 90  },
  4: { x: 0,   y: -90 },
  5: { x: -90, y: 0   },
  6: { x: 90,  y: 0   },
};

function createDieElement(index) {
  // Remove old one if exists
  const old = feltSurface.querySelector(`[data-die-index="${index}"]`);
  if (old) old.remove();
  const oldShadow = feltSurface.querySelector(`[data-shadow-index="${index}"]`);
  if (oldShadow) oldShadow.remove();

  // Shadow
  const shadow = document.createElement('div');
  shadow.className = 'die-shadow';
  shadow.dataset.shadowIndex = index;
  feltSurface.appendChild(shadow);

  // Die container
  const die = document.createElement('div');
  die.className = 'die-3d';
  die.dataset.dieIndex = index;

  // Cube
  const cube = document.createElement('div');
  cube.className = 'die-cube';

  // 6 faces
  for (let f = 1; f <= 6; f++) {
    const face = document.createElement('div');
    face.className = `die-face die-face-${f}`;
    const dots = getDotPositions(f);
    dots.forEach(() => {
      const dot = document.createElement('div');
      dot.className = 'dot';
      face.appendChild(dot);
    });
    cube.appendChild(face);
  }

  die.appendChild(cube);
  feltSurface.appendChild(die);

  // Click handler for hold/unhold
  die.addEventListener('click', () => {
    if (!gameState || animating) return;
    const cp = gameState.players[gameState.currentPlayerIndex];
    if (!cp || cp.id !== myId) return;
    if (gameState.rollsLeft === 3 || gameState.rollsLeft === 0) return;
    if (gameState.dice[index] === 0) return;
    socket.emit('toggle-hold', { index });
  });

  return { die, cube, shadow };
}

function getDotPositions(value) {
  // Returns array of length `value` (dots just need to exist; CSS handles layout via flex)
  return new Array(value).fill(0);
}

function getTableBounds() {
  const rect = feltSurface.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

function initDice() {
  feltSurface.innerHTML = '';
  dicePhysics = [];
  const bounds = getTableBounds();

  for (let i = 0; i < 5; i++) {
    const { die, cube, shadow } = createDieElement(i);

    // Place dice in a neat row in the center
    const startX = (bounds.w / 2) - (5 * 40) + i * 80;
    const startY = bounds.h / 2 - HALF;

    dicePhysics.push({
      el: die,
      cube,
      shadow,
      x: startX,
      y: startY,
      vx: 0,
      vy: 0,
      rotX: 0,
      rotY: 0,
      rotZ: 0,
      vRotX: 0,
      vRotY: 0,
      vRotZ: 0,
      targetValue: 0,
      held: false,
      settled: true,
      index: i
    });

    die.style.left = startX + 'px';
    die.style.top = startY + 'px';
    die.style.opacity = '0';
  }
}

function launchDiceAnimation(finalValues) {
  if (animating) return;
  animating = true;

  const bounds = getTableBounds();
  const margin = 20; // inside the wood border

  for (let i = 0; i < 5; i++) {
    const dp = dicePhysics[i];

    if (dp.held) {
      // Held dice don't move
      dp.settled = true;
      continue;
    }

    dp.targetValue = finalValues[i];
    dp.settled = false;
    dp.el.style.opacity = '1';

    // Launch from random edge positions with velocity toward center
    const side = Math.random();
    if (side < 0.25) {
      // from left
      dp.x = margin;
      dp.y = margin + Math.random() * (bounds.h - DIE_SIZE - margin * 2);
      dp.vx = 4 + Math.random() * 6;
      dp.vy = (Math.random() - 0.5) * 6;
    } else if (side < 0.5) {
      // from right
      dp.x = bounds.w - DIE_SIZE - margin;
      dp.y = margin + Math.random() * (bounds.h - DIE_SIZE - margin * 2);
      dp.vx = -(4 + Math.random() * 6);
      dp.vy = (Math.random() - 0.5) * 6;
    } else if (side < 0.75) {
      // from top
      dp.x = margin + Math.random() * (bounds.w - DIE_SIZE - margin * 2);
      dp.y = margin;
      dp.vx = (Math.random() - 0.5) * 6;
      dp.vy = 4 + Math.random() * 6;
    } else {
      // from bottom
      dp.x = margin + Math.random() * (bounds.w - DIE_SIZE - margin * 2);
      dp.y = bounds.h - DIE_SIZE - margin;
      dp.vx = (Math.random() - 0.5) * 6;
      dp.vy = -(4 + Math.random() * 6);
    }

    // Random fast spin
    dp.vRotX = (Math.random() - 0.5) * 30;
    dp.vRotY = (Math.random() - 0.5) * 30;
    dp.vRotZ = (Math.random() - 0.5) * 20;
  }

  const startTime = performance.now();
  animationFrameId = requestAnimationFrame(function animate(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / ANIM_DURATION, 1);
    const bounds = getTableBounds();
    const margin = 20;
    let allSettled = true;

    for (let i = 0; i < 5; i++) {
      const dp = dicePhysics[i];
      if (dp.held || dp.settled) continue;

      allSettled = false;

      // Slow down over time
      const slowdown = 1 - progress * 0.6;

      // Apply velocity
      dp.x += dp.vx * slowdown;
      dp.y += dp.vy * slowdown;

      // Bounce off walls
      const minX = margin;
      const maxX = bounds.w - DIE_SIZE - margin;
      const minY = margin;
      const maxY = bounds.h - DIE_SIZE - margin;

      if (dp.x < minX) {
        dp.x = minX;
        dp.vx = Math.abs(dp.vx) * WALL_BOUNCE;
        dp.vRotY += (Math.random() - 0.5) * 10;
      } else if (dp.x > maxX) {
        dp.x = maxX;
        dp.vx = -Math.abs(dp.vx) * WALL_BOUNCE;
        dp.vRotY += (Math.random() - 0.5) * 10;
      }

      if (dp.y < minY) {
        dp.y = minY;
        dp.vy = Math.abs(dp.vy) * WALL_BOUNCE;
        dp.vRotX += (Math.random() - 0.5) * 10;
      } else if (dp.y > maxY) {
        dp.y = maxY;
        dp.vy = -Math.abs(dp.vy) * WALL_BOUNCE;
        dp.vRotX += (Math.random() - 0.5) * 10;
      }

      // Apply friction
      dp.vx *= FRICTION;
      dp.vy *= FRICTION;
      dp.vRotX *= ANGULAR_FRICTION;
      dp.vRotY *= ANGULAR_FRICTION;
      dp.vRotZ *= ANGULAR_FRICTION;

      // Rotation
      dp.rotX += dp.vRotX * slowdown;
      dp.rotY += dp.vRotY * slowdown;
      dp.rotZ += dp.vRotZ * slowdown;

      // In the last 30% of animation, ease toward the final face rotation
      if (progress > 0.7) {
        const settle = (progress - 0.7) / 0.3; // 0 → 1
        const ease = settle * settle * (3 - 2 * settle); // smoothstep
        const target = FACE_ROTATIONS[dp.targetValue];

        // Snap rotation to nearest equivalent of target
        dp.rotX = lerpAngle(dp.rotX, target.x, ease);
        dp.rotY = lerpAngle(dp.rotY, target.y, ease);
        dp.rotZ = dp.rotZ * (1 - ease); // flatten Z rotation
      }

      // Update DOM
      dp.el.style.left = dp.x + 'px';
      dp.el.style.top = dp.y + 'px';
      dp.cube.style.transform = `rotateX(${dp.rotX}deg) rotateY(${dp.rotY}deg) rotateZ(${dp.rotZ}deg)`;

      // Shadow follows die
      dp.shadow.style.left = (dp.x + 2) + 'px';
      dp.shadow.style.top = (dp.y + DIE_SIZE + 2) + 'px';

      // Dynamic shadow size based on "height" (spin intensity)
      const spinIntensity = Math.min(1, (Math.abs(dp.vRotX) + Math.abs(dp.vRotY)) / 20);
      const shadowScale = 1 + spinIntensity * 0.4;
      dp.shadow.style.transform = `scaleX(${shadowScale})`;
      dp.shadow.style.opacity = 0.3 + spinIntensity * 0.2;
    }

    if (progress < 1) {
      animationFrameId = requestAnimationFrame(animate);
    } else {
      animationFrameId = null;
      // Final snap: ensure each die shows correct face
      for (let i = 0; i < 5; i++) {
        const dp = dicePhysics[i];
        if (dp.held) continue;
        dp.settled = true;
        const target = FACE_ROTATIONS[dp.targetValue];
        dp.rotX = target.x;
        dp.rotY = target.y;
        dp.rotZ = 0;
        dp.cube.style.transform = `rotateX(${target.x}deg) rotateY(${target.y}deg) rotateZ(0deg)`;
        dp.cube.style.transition = 'transform 0.15s ease';
        setTimeout(() => { dp.cube.style.transition = 'none'; }, 200);
      }
      animating = false;

      // Re-render full UI so controls (roll button) reflect the current state
      if (gameState) renderGame();
    }
  });
}

function lerpAngle(current, target, t) {
  // Lerp current angle toward the nearest equivalent of target
  // Find the nearest target that's a multiple of 360 away
  let diff = target - current;
  // Normalize to [-180, 180]
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return current + diff * t;
}

function renderDiceStatic() {
  if (!gameState) return;
  const { dice, held, rollsLeft } = gameState;
  const bounds = getTableBounds();

  // Ensure we have die elements
  if (dicePhysics.length === 0) {
    initDice();
  }

  for (let i = 0; i < 5; i++) {
    const dp = dicePhysics[i];
    dp.held = held[i];

    if (dice[i] === 0) {
      dp.el.style.opacity = '0';
      dp.shadow.style.opacity = '0';
      continue;
    }

    dp.el.style.opacity = '1';
    dp.shadow.style.opacity = '0.3';
    dp.targetValue = dice[i];

    // Show correct face
    const target = FACE_ROTATIONS[dice[i]];
    dp.rotX = target.x;
    dp.rotY = target.y;
    dp.rotZ = 0;
    dp.cube.style.transform = `rotateX(${target.x}deg) rotateY(${target.y}deg) rotateZ(0deg)`;

    // Update held styling on faces
    dp.cube.querySelectorAll('.die-face').forEach(face => {
      face.classList.toggle('held-face', held[i]);
    });

    // Position die shadow
    dp.shadow.style.left = (dp.x + 2) + 'px';
    dp.shadow.style.top = (dp.y + DIE_SIZE + 2) + 'px';
    dp.shadow.style.transform = 'scaleX(1)';

    // Show/hide held tag
    let tag = dp.el.querySelector('.die-held-tag');
    if (held[i]) {
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'die-held-tag';
        tag.textContent = 'HOLD';
        dp.el.appendChild(tag);
      }
      tag.style.display = '';
    } else if (tag) {
      tag.style.display = 'none';
    }
  }
}

// ─── Roll Button ────────────────────────────────────────────

btnRoll.addEventListener('click', () => {
  if (!gameState || animating) return;
  const cp = gameState.players[gameState.currentPlayerIndex];
  if (cp.id !== myId) return;
  if (gameState.rollsLeft <= 0) return;
  socket.emit('roll-dice');
});

// ─── Scorecard ──────────────────────────────────────────────

function buildScorecardHeader() {
  if (!gameState) return;
  const thead = document.querySelector('#scorecard thead tr');
  while (thead.children.length > 1) thead.removeChild(thead.lastChild);

  gameState.players.forEach((player, idx) => {
    const th = document.createElement('th');
    th.className = `player-col player-color-${idx}`;
    if (idx === gameState.currentPlayerIndex && !gameState.gameOver) {
      th.classList.add('current-player-col');
    }
    let label = player.name;
    if (player.id === myId) label += ' (You)';
    th.textContent = label;
    thead.appendChild(th);
  });

  $$('.section-header td').forEach(td => {
    td.setAttribute('colspan', gameState.players.length + 1);
  });
}

function renderScorecard() {
  if (!gameState) return;
  buildScorecardHeader();

  const cp = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = cp && cp.id === myId;
  const hasRolled = gameState.rollsLeft < 3;

  $$('#scorecard tbody tr[data-cat]').forEach(row => {
    const cat = row.dataset.cat;
    while (row.children.length > 1) row.removeChild(row.lastChild);

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
        td.textContent = '—';
        td.classList.add('empty');
      }

      row.appendChild(td);
    });
  });

  renderTotalRow('.upper-total-row', p => p.totals.upperTotal);
  renderTotalRow('.bonus-row', p => p.totals.upperBonus, (td, val) => {
    if (val > 0) td.classList.add('has-bonus');
  });
  renderTotalRow('.lower-total-row', p => p.totals.lowerTotal);
  renderTotalRow('.yahtzee-bonus-row', p => p.totals.yahtzeeBonusTotal);
  renderTotalRow('.grand-total-row', p => p.totals.grandTotal);
}

function renderTotalRow(selector, valueFn, extraFn) {
  const row = document.querySelector(selector);
  if (!row) return;
  while (row.children.length > 1) row.removeChild(row.lastChild);

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

// ─── Top Bar / Controls ─────────────────────────────────────

function renderTopBar() {
  if (!gameState) return;
  const cp = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = cp && cp.id === myId;

  if (gameState.gameOver) {
    turnInd.textContent = 'Game Over!';
    turnInd.className = 'turn-indicator';
  } else if (isMyTurn) {
    turnInd.textContent = "Your Turn — Roll!";
    turnInd.className = 'turn-indicator my-turn';
  } else {
    turnInd.textContent = `${cp.name}'s Turn`;
    turnInd.className = 'turn-indicator other-turn';
  }

  roundInd.textContent = `Round ${Math.min(gameState.round, 13)} / 13`;
}

function renderControls() {
  if (!gameState) return;
  const cp = gameState.players[gameState.currentPlayerIndex];
  const isMyTurn = cp && cp.id === myId;

  rollsLeftEl.textContent = gameState.rollsLeft;
  btnRoll.disabled = !isMyTurn || gameState.rollsLeft <= 0 || gameState.gameOver || animating;

  if (isMyTurn && gameState.rollsLeft === 0) {
    scoreHint.classList.remove('hidden');
  } else {
    scoreHint.classList.add('hidden');
  }
}

// ─── Waiting Room ───────────────────────────────────────────

function renderWaitingRoom() {
  if (!gameState) return;
  playerListEl.innerHTML = '';

  gameState.players.forEach((player, idx) => {
    const item = document.createElement('div');
    item.className = 'player-item';
    const dotColor = ['#1a5276', '#c0392b', '#7d3c98', '#d4a017'][idx] || '#666';
    item.innerHTML = `
      <span class="dot" style="background:${dotColor}"></span>
      <span>${player.name}${player.id === myId ? ' (You)' : ''}</span>
      ${idx === 0 ? '<span class="host-badge">HOST</span>' : ''}
    `;
    playerListEl.appendChild(item);
  });

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
  const sorted = [...gameState.players].sort((a, b) => b.totals.grandTotal - a.totals.grandTotal);
  const medals = ['1st', '2nd', '3rd', '4th'];

  winnerText.textContent = `${sorted[0].name} Wins!`;
  finalScoresEl.innerHTML = '';

  sorted.forEach((player, idx) => {
    const row = document.createElement('div');
    row.className = `final-score-row${idx === 0 ? ' winner' : ''}`;
    row.innerHTML = `
      <span class="rank">${medals[idx]}</span>
      <span class="name">${player.name}${player.id === myId ? ' (You)' : ''}</span>
      <span class="score">${player.totals.grandTotal}</span>
    `;
    finalScoresEl.appendChild(row);
  });
}

btnPlayAgain.addEventListener('click', () => {
  gameOverModal.classList.add('hidden');
  showScreen(lobbyScreen);
  gameState = null;
  possibleScores = null;
  isHost = false;
  dicePhysics = [];
});

// ─── Master render ──────────────────────────────────────────

function renderGame() {
  if (dicePhysics.length === 0) initDice();
  renderTopBar();
  if (!animating) renderDiceStatic();
  renderControls();
  renderScorecard();
  renderGameOver();
}

// ─── Category tooltips ──────────────────────────────────────

const catDescs = {
  ones: 'Count and add only Ones',
  twos: 'Count and add only Twos',
  threes: 'Count and add only Threes',
  fours: 'Count and add only Fours',
  fives: 'Count and add only Fives',
  sixes: 'Count and add only Sixes',
  threeOfAKind: 'At least 3 dice the same → sum of all dice',
  fourOfAKind: 'At least 4 dice the same → sum of all dice',
  fullHouse: '3 of one kind + 2 of another → 25 pts',
  smallStraight: '4 in a row (e.g. 1-2-3-4) → 30 pts',
  largeStraight: '5 in a row (e.g. 1-2-3-4-5) → 40 pts',
  yahtzee: 'All 5 dice the same → 50 pts',
  chance: 'Any combination → sum of all dice'
};

$$('#scorecard tbody tr[data-cat]').forEach(row => {
  const desc = catDescs[row.dataset.cat];
  if (!desc) return;
  const catName = row.querySelector('.cat-name');

  catName.addEventListener('mouseenter', e => {
    tooltipEl.textContent = desc;
    tooltipEl.classList.remove('hidden');
    const r = e.target.getBoundingClientRect();
    tooltipEl.style.left = (r.right + 10) + 'px';
    tooltipEl.style.top = r.top + 'px';
  });

  catName.addEventListener('mouseleave', () => {
    tooltipEl.classList.add('hidden');
  });
});

// ─── Window resize: reinit dice positions ───────────────────

let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (gameState && gameState.started && dicePhysics.length > 0) {
      const bounds = getTableBounds();
      for (let i = 0; i < 5; i++) {
        const dp = dicePhysics[i];
        // Clamp positions to new bounds
        dp.x = Math.min(Math.max(20, dp.x), bounds.w - DIE_SIZE - 20);
        dp.y = Math.min(Math.max(20, dp.y), bounds.h - DIE_SIZE - 20);
        dp.el.style.left = dp.x + 'px';
        dp.el.style.top = dp.y + 'px';
        dp.shadow.style.left = (dp.x + 2) + 'px';
        dp.shadow.style.top = (dp.y + DIE_SIZE + 2) + 'px';
      }
    }
  }, 100);
});

// ─── Focus name input ───────────────────────────────────────
nameInput.focus();
