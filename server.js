const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ─── Game State ───────────────────────────────────────────────

const rooms = new Map();

const CATEGORIES = [
  'ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
  'threeOfAKind', 'fourOfAKind', 'fullHouse',
  'smallStraight', 'largeStraight', 'yahtzee', 'chance'
];

// ─── Scoring Functions ────────────────────────────────────────

function sumOfNumber(dice, num) {
  return dice.filter(d => d === num).reduce((a, b) => a + b, 0);
}

function getCounts(dice) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  dice.forEach(d => counts[d]++);
  return counts;
}

function sumAll(dice) {
  return dice.reduce((a, b) => a + b, 0);
}

function hasNOfAKind(dice, n) {
  const counts = getCounts(dice);
  return counts.some(c => c >= n);
}

function isFullHouse(dice) {
  const counts = getCounts(dice);
  const vals = counts.filter(c => c > 0);
  return vals.length === 2 && vals.includes(2) && vals.includes(3);
}

function isSmallStraight(dice) {
  const unique = [...new Set(dice)].sort();
  const str = unique.join('');
  return str.includes('1234') || str.includes('2345') || str.includes('3456');
}

function isLargeStraight(dice) {
  const sorted = [...dice].sort();
  const str = sorted.join('');
  return str === '12345' || str === '23456';
}

function isYahtzee(dice) {
  return new Set(dice).size === 1;
}

function calculateScore(dice, category) {
  switch (category) {
    case 'ones': return sumOfNumber(dice, 1);
    case 'twos': return sumOfNumber(dice, 2);
    case 'threes': return sumOfNumber(dice, 3);
    case 'fours': return sumOfNumber(dice, 4);
    case 'fives': return sumOfNumber(dice, 5);
    case 'sixes': return sumOfNumber(dice, 6);
    case 'threeOfAKind': return hasNOfAKind(dice, 3) ? sumAll(dice) : 0;
    case 'fourOfAKind': return hasNOfAKind(dice, 4) ? sumAll(dice) : 0;
    case 'fullHouse': return isFullHouse(dice) ? 25 : 0;
    case 'smallStraight': return isSmallStraight(dice) ? 30 : 0;
    case 'largeStraight': return isLargeStraight(dice) ? 40 : 0;
    case 'yahtzee': return isYahtzee(dice) ? 50 : 0;
    case 'chance': return sumAll(dice);
    default: return 0;
  }
}

function calculateScoreWithJoker(dice, category, playerScores) {
  // Yahtzee bonus joker rules
  if (isYahtzee(dice) && playerScores.yahtzee === 50) {
    // The matching upper section number
    const num = dice[0];
    const upperCats = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
    const matchingUpper = upperCats[num - 1];

    // If scoring in upper section, score normally
    if (category === matchingUpper) {
      return sumOfNumber(dice, num);
    }

    // If the matching upper section is already filled, can use joker for lower
    if (playerScores[matchingUpper] !== null) {
      if (category === 'fullHouse') return 25;
      if (category === 'smallStraight') return 30;
      if (category === 'largeStraight') return 40;
    }
  }
  return calculateScore(dice, category);
}

function getPossibleScores(dice, playerScores) {
  const scores = {};
  const yahtzeeBonus = isYahtzee(dice) && playerScores.yahtzee === 50;

  for (const cat of CATEGORIES) {
    if (playerScores[cat] !== null) {
      scores[cat] = null; // already used
    } else if (yahtzeeBonus) {
      scores[cat] = calculateScoreWithJoker(dice, cat, playerScores);
    } else {
      scores[cat] = calculateScore(dice, cat);
    }
  }
  return scores;
}

function rollDice(current, held) {
  return current.map((val, i) => held[i] ? val : Math.floor(Math.random() * 6) + 1);
}

function createPlayer(id, name) {
  const scores = {};
  CATEGORIES.forEach(c => scores[c] = null);
  return {
    id,
    name,
    scores,
    yahtzeeBonus: 0
  };
}

function calculateTotals(player) {
  const upperCats = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
  const lowerCats = ['threeOfAKind', 'fourOfAKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance'];

  let upperTotal = 0;
  upperCats.forEach(c => {
    if (player.scores[c] !== null) upperTotal += player.scores[c];
  });

  const upperBonus = upperTotal >= 63 ? 35 : 0;

  let lowerTotal = 0;
  lowerCats.forEach(c => {
    if (player.scores[c] !== null) lowerTotal += player.scores[c];
  });

  const yahtzeeBonusTotal = player.yahtzeeBonus * 100;

  return {
    upperTotal,
    upperBonus,
    lowerTotal,
    yahtzeeBonusTotal,
    grandTotal: upperTotal + upperBonus + lowerTotal + yahtzeeBonusTotal
  };
}

function isGameOver(room) {
  return room.players.every(p =>
    CATEGORIES.every(c => p.scores[c] !== null)
  );
}

function getGameState(room, forPlayerId) {
  return {
    roomId: room.id,
    roomCode: room.code,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      scores: p.scores,
      yahtzeeBonus: p.yahtzeeBonus,
      totals: calculateTotals(p),
      isConnected: room.connections.has(p.id)
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    dice: room.dice,
    held: room.held,
    rollsLeft: room.rollsLeft,
    round: room.round,
    gameOver: room.gameOver,
    winner: room.winner,
    maxPlayers: room.maxPlayers,
    started: room.started
  };
}

// ─── Room Management ──────────────────────────────────────────

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createRoom(hostId, hostName, maxPlayers) {
  let code = generateRoomCode();
  while ([...rooms.values()].some(r => r.code === code)) {
    code = generateRoomCode();
  }

  const room = {
    id: uuidv4(),
    code,
    players: [createPlayer(hostId, hostName)],
    connections: new Set([hostId]),
    currentPlayerIndex: 0,
    dice: [0, 0, 0, 0, 0],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    round: 1,
    gameOver: false,
    winner: null,
    maxPlayers: maxPlayers || 2,
    started: false,
    hostId
  };

  rooms.set(room.id, room);
  return room;
}

// Clean up empty rooms periodically
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.connections.size === 0) {
      const age = Date.now() - (room.lastActivity || 0);
      if (age > 5 * 60 * 1000) {
        rooms.delete(id);
      }
    }
  }
}, 60 * 1000);

// ─── Socket.IO ────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = null;

  socket.on('create-room', ({ playerName, maxPlayers }) => {
    playerId = socket.id;
    const room = createRoom(playerId, playerName, maxPlayers);
    currentRoom = room;
    room.lastActivity = Date.now();
    socket.join(room.id);
    socket.emit('room-created', { roomCode: room.code, roomId: room.id });
    io.to(room.id).emit('game-state', getGameState(room, playerId));
  });

  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = [...rooms.values()].find(r => r.code === roomCode.toUpperCase());

    if (!room) {
      socket.emit('error-msg', { message: 'Room not found. Check the code and try again.' });
      return;
    }

    if (room.started) {
      // Allow reconnection
      const existing = room.players.find(p => p.name === playerName);
      if (existing) {
        playerId = existing.id;
        currentRoom = room;
        room.connections.add(playerId);
        room.lastActivity = Date.now();
        // Update the player id mapping for the new socket
        const oldId = existing.id;
        existing.id = socket.id;
        room.connections.delete(oldId);
        room.connections.add(socket.id);
        playerId = socket.id;
        socket.join(room.id);
        socket.emit('room-joined', { roomCode: room.code, roomId: room.id });
        io.to(room.id).emit('game-state', getGameState(room, playerId));
        return;
      }
      socket.emit('error-msg', { message: 'Game already in progress.' });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('error-msg', { message: 'Room is full.' });
      return;
    }

    playerId = socket.id;
    room.players.push(createPlayer(playerId, playerName));
    room.connections.add(playerId);
    room.lastActivity = Date.now();
    currentRoom = room;
    socket.join(room.id);
    socket.emit('room-joined', { roomCode: room.code, roomId: room.id });
    io.to(room.id).emit('game-state', getGameState(room, playerId));
  });

  socket.on('start-game', () => {
    if (!currentRoom) return;
    if (currentRoom.hostId !== playerId) return;
    if (currentRoom.players.length < 2) {
      socket.emit('error-msg', { message: 'Need at least 2 players to start.' });
      return;
    }

    currentRoom.started = true;
    currentRoom.lastActivity = Date.now();
    io.to(currentRoom.id).emit('game-started');
    io.to(currentRoom.id).emit('game-state', getGameState(currentRoom, playerId));
  });

  socket.on('roll-dice', () => {
    if (!currentRoom || !currentRoom.started) return;
    const room = currentRoom;

    if (room.gameOver) return;
    if (room.players[room.currentPlayerIndex].id !== playerId) return;
    if (room.rollsLeft <= 0) return;

    if (room.rollsLeft === 3) {
      room.held = [false, false, false, false, false];
    }

    room.dice = rollDice(room.dice, room.held);
    room.rollsLeft--;
    room.lastActivity = Date.now();

    io.to(room.id).emit('dice-rolled', {
      dice: room.dice,
      rollsLeft: room.rollsLeft
    });
    io.to(room.id).emit('game-state', getGameState(room, playerId));
  });

  socket.on('toggle-hold', ({ index }) => {
    if (!currentRoom || !currentRoom.started) return;
    const room = currentRoom;

    if (room.gameOver) return;
    if (room.players[room.currentPlayerIndex].id !== playerId) return;
    if (room.rollsLeft === 3 || room.rollsLeft === 0) return;

    room.held[index] = !room.held[index];
    room.lastActivity = Date.now();

    io.to(room.id).emit('game-state', getGameState(room, playerId));
  });

  socket.on('score-category', ({ category }) => {
    if (!currentRoom || !currentRoom.started) return;
    const room = currentRoom;

    if (room.gameOver) return;
    if (room.players[room.currentPlayerIndex].id !== playerId) return;
    if (room.rollsLeft === 3) return; // must roll at least once
    if (!CATEGORIES.includes(category)) return;

    const player = room.players[room.currentPlayerIndex];
    if (player.scores[category] !== null) return;

    // Check for Yahtzee bonus
    if (isYahtzee(room.dice) && player.scores.yahtzee === 50) {
      player.yahtzeeBonus++;
    }

    // Calculate and assign score
    const possibleScores = getPossibleScores(room.dice, player.scores);
    player.scores[category] = possibleScores[category] !== null ? possibleScores[category] : 0;

    // Move to next player / next round
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    if (room.currentPlayerIndex === 0) {
      room.round++;
    }

    room.dice = [0, 0, 0, 0, 0];
    room.held = [false, false, false, false, false];
    room.rollsLeft = 3;
    room.lastActivity = Date.now();

    // Check if game is over
    if (isGameOver(room)) {
      room.gameOver = true;
      const totals = room.players.map(p => ({
        id: p.id,
        name: p.name,
        total: calculateTotals(p).grandTotal
      }));
      totals.sort((a, b) => b.total - a.total);
      room.winner = totals[0];
    }

    io.to(room.id).emit('game-state', getGameState(room, playerId));
  });

  socket.on('get-possible-scores', () => {
    if (!currentRoom || !currentRoom.started) return;
    const room = currentRoom;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    if (room.rollsLeft === 3) return;

    const possible = getPossibleScores(room.dice, player.scores);
    socket.emit('possible-scores', possible);
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      currentRoom.connections.delete(playerId);
      currentRoom.lastActivity = Date.now();

      if (!currentRoom.started && currentRoom.connections.size === 0) {
        rooms.delete(currentRoom.id);
      } else {
        io.to(currentRoom.id).emit('game-state', getGameState(currentRoom, playerId));
        io.to(currentRoom.id).emit('player-disconnected', {
          playerName: currentRoom.players.find(p => p.id === playerId)?.name
        });
      }
    }
  });
});

// ─── Start Server ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Yahtzee server running on port ${PORT}`);
});
