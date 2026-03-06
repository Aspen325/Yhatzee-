// ═══════════════════════════════════════════════════════════════
//  YAHTZEE — Client
// ═══════════════════════════════════════════════════════════════

const socket = io();
let gameState = null;
let myId = null;
let possibleScores = null;
let isHost = false;
let selectedMaxPlayers = 2;
let threeDice     = []; // Three.js die objects
let threeScene    = null;
let threeCamera   = null;
let threeRenderer = null;
let threeRAF      = null;
let faceQuats     = {};
let animating     = false;
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
  isHost = state.hostId === myId;

  // If a new turn starts with cleared dice, force animation gate off.
  // This prevents clients getting stuck waiting for a prior rAF cycle.
  if (state.started && state.rollsLeft === 3 && state.dice.every(d => d === 0)) {
    animating = false;
  }

  if (state.started) {
    showScreen(gameScreen);
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
//  THREE.JS 3D DICE ENGINE
// ═══════════════════════════════════════════════════════════════

const ANIM_DURATION   = 2600;    // ms total
const DIE_HALF_W      = 0.50;    // half-size of die cube (world units)
const TABLE_W         = 9.0;     // world table width
const TABLE_D         = 5.5;     // world table depth
const FRICTION_L      = 0.987;   // linear friction per frame
const FRICTION_A      = 0.979;   // angular friction per frame
const WALL_RESTITUTION = 0.60;
const SLOT_PULL       = 0.032;
const COLL_DIST       = DIE_HALF_W * 2.15;
const COLL_PUSH       = 0.55;

// ─── Dot layout (normalised 0-1 within face) ─────────────────
const DOT_LAYOUTS = {
  1: [[.50,.50]],
  2: [[.28,.28],[.72,.72]],
  3: [[.28,.28],[.50,.50],[.72,.72]],
  4: [[.28,.28],[.72,.28],[.28,.72],[.72,.72]],
  5: [[.28,.28],[.72,.28],[.50,.50],[.28,.72],[.72,.72]],
  6: [[.28,.22],[.72,.22],[.28,.50],[.72,.50],[.28,.78],[.72,.78]]
};

// ─── Canvas texture for a single face ───────────────────────
function createFaceTex(value, isHeld) {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, S, S);
  if (isHeld) {
    bg.addColorStop(0, '#e8f5e9'); bg.addColorStop(.5, '#a5d6a7'); bg.addColorStop(1, '#81c784');
  } else {
    bg.addColorStop(0, '#fefaf0'); bg.addColorStop(.5, '#f5e6c8'); bg.addColorStop(1, '#e8d5a8');
  }

  // Rounded-rect face
  const r = 16;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(S - r, 0);
  ctx.quadraticCurveTo(S, 0, S, r); ctx.lineTo(S, S - r);
  ctx.quadraticCurveTo(S, S, S - r, S); ctx.lineTo(r, S);
  ctx.quadraticCurveTo(0, S, 0, S - r); ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath();
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = isHeld ? '#4caf50' : '#c8a96e';
  ctx.lineWidth = 5;
  ctx.stroke();

  // Dots
  DOT_LAYOUTS[value].forEach(([px, py]) => {
    const x = px * S, y = py * S;
    const dg = ctx.createRadialGradient(x - 4, y - 4, 1, x, y, 11);
    dg.addColorStop(0, isHeld ? '#1b5e20' : '#4a3520');
    dg.addColorStop(1, isHeld ? '#0d3510' : '#2c1810');
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
  });

  return new THREE.CanvasTexture(canvas);
}

// ─── Quaternions: rotate so face-N points toward +Y (up) ─────
// BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z
// We assign values:            1    6   2    5   3    4
function buildFaceQuats() {
  const Q = THREE.Quaternion, E = THREE.Euler;
  faceQuats[1] = new Q().setFromEuler(new E(0,          0,  Math.PI / 2)); // +X → +Y
  faceQuats[2] = new Q();                                                   // +Y already up
  faceQuats[3] = new Q().setFromEuler(new E(-Math.PI / 2, 0, 0));          // +Z → +Y
  faceQuats[4] = new Q().setFromEuler(new E( Math.PI / 2, 0, 0));          // -Z → +Y
  faceQuats[5] = new Q().setFromEuler(new E( Math.PI,     0, 0));          // -Y → +Y
  faceQuats[6] = new Q().setFromEuler(new E(0,          0, -Math.PI / 2)); // -X → +Y
}

// ─── Create one die mesh with 6 canvas-texture faces ─────────
const FACE_ORDER = [1, 6, 2, 5, 3, 4]; // maps material index → pip value
function createDieMesh() {
  const geo  = new THREE.BoxGeometry(1, 1, 1);
  const mats = FACE_ORDER.map(v =>
    new THREE.MeshLambertMaterial({ map: createFaceTex(v, false) })
  );
  return new THREE.Mesh(geo, mats);
}

// ─── Initialise Three.js scene (idempotent) ──────────────────
function initThreeJS() {
  if (threeRenderer) return; // already set up

  threeScene = new THREE.Scene();

  // Lighting
  threeScene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.80);
  sun.position.set(3, 10, 5);
  threeScene.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.30);
  fill.position.set(-5, 4, -3);
  threeScene.add(fill);

  // Renderer (transparent so the CSS felt shows through)
  const rect = feltSurface.getBoundingClientRect();
  threeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  threeRenderer.setSize(rect.width || 600, rect.height || 400);
  threeRenderer.domElement.style.cssText =
    'position:absolute;inset:0;pointer-events:none;z-index:5;';
  feltSurface.appendChild(threeRenderer.domElement);

  // Camera — perspective from above-and-in-front
  const aspect = (rect.width || 600) / Math.max(rect.height || 400, 1);
  threeCamera = new THREE.PerspectiveCamera(48, aspect, 0.1, 100);
  threeCamera.position.set(0, 9, 7);
  threeCamera.lookAt(0, 0, 0);

  buildFaceQuats();

  // Click-to-hold via raycasting
  feltSurface.addEventListener('click', onFeltClick);
}

// ─── Hold toggle via raycasting ──────────────────────────────
function onFeltClick(e) {
  if (!gameState || animating || !threeDice.length) return;
  const cp = gameState.players[gameState.currentPlayerIndex];
  if (!cp || cp.id !== myId) return;
  if (gameState.rollsLeft === 3 || gameState.rollsLeft === 0) return;

  const rect = feltSurface.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
   -((e.clientY - rect.top)  / rect.height) *  2 + 1
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, threeCamera);
  const hits = ray.intersectObjects(threeDice.map(d => d.mesh));
  if (!hits.length) return;
  const idx = threeDice.findIndex(d => d.mesh === hits[0].object);
  if (idx < 0 || gameState.dice[idx] === 0) return;
  socket.emit('toggle-hold', { index: idx });
}

// ─── Fixed landing slots (identical for every client) ────────
function getLandingSlots() {
  return [
    { x: -3.0, z:  0.40 },
    { x: -1.5, z: -0.40 },
    { x:  0.0, z:  0.40 },
    { x:  1.5, z: -0.40 },
    { x:  3.0, z:  0.40 },
  ];
}

// ─── Dice-vs-dice collision resolution ───────────────────────
function resolveCollisions() {
  const minX = -TABLE_W / 2 + DIE_HALF_W, maxX = TABLE_W / 2 - DIE_HALF_W;
  const minZ = -TABLE_D / 2 + DIE_HALF_W, maxZ = TABLE_D / 2 - DIE_HALF_W;

  for (let i = 0; i < threeDice.length; i++) {
    for (let j = i + 1; j < threeDice.length; j++) {
      const a = threeDice[i], b = threeDice[j];
      const dx = b.mesh.position.x - a.mesh.position.x;
      const dz = b.mesh.position.z - a.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      if (!dist || dist >= COLL_DIST) continue;

      const overlap = COLL_DIST - dist;
      const nx = dx / dist, nz = dz / dist;
      const aM = !a.held && !a.settled, bM = !b.held && !b.settled;

      if (aM && bM) {
        a.mesh.position.x -= nx * overlap * 0.5; a.mesh.position.z -= nz * overlap * 0.5;
        b.mesh.position.x += nx * overlap * 0.5; b.mesh.position.z += nz * overlap * 0.5;
        a.vel.x -= nx * COLL_PUSH; a.vel.z -= nz * COLL_PUSH;
        b.vel.x += nx * COLL_PUSH; b.vel.z += nz * COLL_PUSH;
        a.angVel.y += (Math.random() - 0.5) * 3;
        b.angVel.y += (Math.random() - 0.5) * 3;
      } else if (aM) {
        a.mesh.position.x -= nx * overlap; a.mesh.position.z -= nz * overlap;
        a.vel.x -= nx * COLL_PUSH; a.vel.z -= nz * COLL_PUSH;
      } else if (bM) {
        b.mesh.position.x += nx * overlap; b.mesh.position.z += nz * overlap;
        b.vel.x += nx * COLL_PUSH; b.vel.z += nz * COLL_PUSH;
      }

      if (aM) {
        a.mesh.position.x = Math.max(minX, Math.min(maxX, a.mesh.position.x));
        a.mesh.position.z = Math.max(minZ, Math.min(maxZ, a.mesh.position.z));
      }
      if (bM) {
        b.mesh.position.x = Math.max(minX, Math.min(maxX, b.mesh.position.x));
        b.mesh.position.z = Math.max(minZ, Math.min(maxZ, b.mesh.position.z));
      }
    }
  }
}

// ─── initDice: create/reset the 5 die objects ────────────────
function initDice() {
  initThreeJS();
  threeDice.forEach(d => threeScene.remove(d.mesh));
  threeDice = [];

  const slots = getLandingSlots();
  for (let i = 0; i < 5; i++) {
    const mesh = createDieMesh();
    mesh.position.set(slots[i].x, DIE_HALF_W, slots[i].z);
    mesh.visible = false;
    threeScene.add(mesh);
    threeDice.push({
      mesh,
      vel:         new THREE.Vector3(),
      angVel:      new THREE.Vector3(),
      held:        false,
      settled:     true,
      targetValue: 0,
      slotX:       slots[i].x,
      slotZ:       slots[i].z,
      index:       i,
    });
  }
  threeRenderer.render(threeScene, threeCamera);
}

// ─── Main animation entry point ──────────────────────────────
function launchDiceAnimation(finalValues) {
  if (animating) return;
  animating = true;

  const slots  = getLandingSlots();
  const halfW  = TABLE_W / 2 - DIE_HALF_W;
  const halfD  = TABLE_D / 2 - DIE_HALF_W;
  const tmpQ   = new THREE.Quaternion();

  for (let i = 0; i < 5; i++) {
    const d = threeDice[i];
    if (d.held) { d.settled = true; continue; }

    d.targetValue = finalValues[i];
    d.settled     = false;
    d.slotX       = slots[i].x;
    d.slotZ       = slots[i].z;
    d.mesh.visible = true;

    // Spawn just outside a random edge
    const side = Math.floor(Math.random() * 4);
    let sx, sz;
    if      (side === 0) { sx = -TABLE_W / 2 - 0.8; sz = (Math.random() - 0.5) * TABLE_D; }
    else if (side === 1) { sx =  TABLE_W / 2 + 0.8; sz = (Math.random() - 0.5) * TABLE_D; }
    else if (side === 2) { sx = (Math.random() - 0.5) * TABLE_W; sz = -TABLE_D / 2 - 0.8; }
    else                 { sx = (Math.random() - 0.5) * TABLE_W; sz =  TABLE_D / 2 + 0.8; }
    d.mesh.position.set(sx, DIE_HALF_W, sz);

    // Velocity aimed at landing slot + small random spread
    const dx = d.slotX - sx, dz = d.slotZ - sz;
    const len = Math.hypot(dx, dz) || 1;
    const spd = 7 + Math.random() * 3;
    d.vel.set(
      (dx / len) * spd + (Math.random() - 0.5) * 2.5,
      0,
      (dz / len) * spd + (Math.random() - 0.5) * 2.5
    );

    // Random tumble spin
    d.angVel.set(
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 10
    );

    // Random start orientation
    d.mesh.quaternion.set(
      Math.random() - 0.5, Math.random() - 0.5,
      Math.random() - 0.5, Math.random() - 0.5
    ).normalize();
  }

  const startTime = performance.now();
  let prevTime = startTime;

  function animate(now) {
    const elapsed  = now - startTime;
    const progress = Math.min(elapsed / ANIM_DURATION, 1);
    const dt       = Math.min((now - prevTime) / 16.667, 2.5);
    prevTime = now;

    const slowdown = 1 - progress * progress * 0.65;

    for (let i = 0; i < 5; i++) {
      const d = threeDice[i];
      if (d.held || d.settled) continue;

      // Translate
      d.mesh.position.x += d.vel.x * slowdown * dt;
      d.mesh.position.z += d.vel.z * slowdown * dt;

      // Wall bounce
      if (d.mesh.position.x < -halfW) {
        d.mesh.position.x = -halfW;
        d.vel.x = Math.abs(d.vel.x) * WALL_RESTITUTION;
        d.angVel.y += (Math.random() - 0.5) * 5;
      } else if (d.mesh.position.x > halfW) {
        d.mesh.position.x = halfW;
        d.vel.x = -Math.abs(d.vel.x) * WALL_RESTITUTION;
        d.angVel.y += (Math.random() - 0.5) * 5;
      }
      if (d.mesh.position.z < -halfD) {
        d.mesh.position.z = -halfD;
        d.vel.z = Math.abs(d.vel.z) * WALL_RESTITUTION;
        d.angVel.x += (Math.random() - 0.5) * 5;
      } else if (d.mesh.position.z > halfD) {
        d.mesh.position.z = halfD;
        d.vel.z = -Math.abs(d.vel.z) * WALL_RESTITUTION;
        d.angVel.x += (Math.random() - 0.5) * 5;
      }

      // Friction
      d.vel.x    *= Math.pow(FRICTION_L, dt);
      d.vel.z    *= Math.pow(FRICTION_L, dt);
      d.angVel.x *= Math.pow(FRICTION_A, dt);
      d.angVel.y *= Math.pow(FRICTION_A, dt);
      d.angVel.z *= Math.pow(FRICTION_A, dt);

      // Pull toward landing slot in second half
      if (progress > 0.5) {
        const t = (progress - 0.5) / 0.5;
        d.vel.x += (d.slotX - d.mesh.position.x) * SLOT_PULL * t;
        d.vel.z += (d.slotZ - d.mesh.position.z) * SLOT_PULL * t;
      }

      // Apply angular velocity as quaternion rotation
      const spinMag = d.angVel.length() * slowdown * dt;
      if (spinMag > 0.0001) {
        tmpQ.setFromAxisAngle(d.angVel.clone().normalize(), spinMag);
        d.mesh.quaternion.multiplyQuaternions(tmpQ, d.mesh.quaternion);
      }

      // Slerp toward correct face in last 35%
      if (progress > 0.65 && d.targetValue) {
        const t    = (progress - 0.65) / 0.35;
        const ease = t * t * (3 - 2 * t); // smoothstep
        d.mesh.quaternion.slerp(faceQuats[d.targetValue], ease * 0.20 + 0.04);
      }
    }

    resolveCollisions();
    threeRenderer.render(threeScene, threeCamera);

    if (progress < 1) {
      threeRAF = requestAnimationFrame(animate);
    } else {
      // Snap each die to exact slot + exact face
      for (let i = 0; i < 5; i++) {
        const d = threeDice[i];
        if (d.held) continue;
        d.settled = true;
        d.mesh.position.set(d.slotX, DIE_HALF_W, d.slotZ);
        d.mesh.quaternion.copy(faceQuats[d.targetValue]);
      }
      threeRenderer.render(threeScene, threeCamera);
      animating = false;
      if (gameState) renderGame();
    }
  }

  threeRAF = requestAnimationFrame(animate);
}

// ─── Static render: reposition dice between rolls ────────────
function renderDiceStatic() {
  if (!gameState || !threeDice.length) return;
  const { dice, held } = gameState;
  const slots = getLandingSlots();

  for (let i = 0; i < 5; i++) {
    const d = threeDice[i];
    const wasHeld = d.held;
    d.held = held[i];

    if (dice[i] === 0) { d.mesh.visible = false; continue; }

    d.mesh.visible = true;
    d.targetValue  = dice[i];
    d.mesh.position.set(slots[i].x, DIE_HALF_W, slots[i].z);
    d.mesh.quaternion.copy(faceQuats[dice[i]]);

    // Swap face textures when hold state changes
    if (d.held !== wasHeld) {
      d.mesh.material.forEach((mat, fi) => {
        mat.map.dispose();
        mat.map = createFaceTex(FACE_ORDER[fi], d.held);
        mat.needsUpdate = true;
      });
    }
  }
  threeRenderer.render(threeScene, threeCamera);
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
  if (threeScene) threeDice.forEach(d => threeScene.remove(d.mesh));
  threeDice = [];
});

// ─── Master render ──────────────────────────────────────────

function renderGame() {
  if (threeDice.length === 0) initDice();
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

// ─── Window resize: update Three.js viewport ────────────────

let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (!threeRenderer || !threeCamera) return;
    const rect = feltSurface.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    threeRenderer.setSize(rect.width, rect.height);
    threeCamera.aspect = rect.width / rect.height;
    threeCamera.updateProjectionMatrix();
    if (!animating) threeRenderer.render(threeScene, threeCamera);
  }, 100);
});

// ─── Focus name input ───────────────────────────────────────
nameInput.focus();
