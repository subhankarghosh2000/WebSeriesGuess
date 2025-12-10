// server.js — updated: emit 'reset' to clients so display resets when host resets
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');

app.use(express.static(PUBLIC_DIR));

// fixed rounds = 5 (cannot be changed)
const FIXED_ROUNDS = 5;

// Utility: Fisher-Yates shuffle
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; --i) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Read image files
function readImageFiles() {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  return fs.readdirSync(IMAGES_DIR).filter(f => {
    const m = mime.lookup(f) || '';
    return m.startsWith('image/');
  });
}

// Deck variables
let files = readImageFiles();
let deck = [];
let deckIndex = 0;

function buildDeckFromFiles(fileList) {
  const copy = Array.from(fileList);
  shuffleInPlace(copy);
  deck = copy;
  deckIndex = 0;
  console.log(`Deck built: ${deck.length} images`);
}

// build initial deck
buildDeckFromFiles(files);

let gameState = {
  rounds: FIXED_ROUNDS,
  shown: 0,
  inProgress: false
};

// Optional endpoint
app.get('/api/images', (req, res) => {
  files = readImageFiles();
  res.json({ count: files.length, images: files, deckRemaining: Math.max(0, deck.length - deckIndex) });
});

// Serve display at root for convenience
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'display.html'));
});

io.on('connection', socket => {
  console.log('conn:', socket.id);

  // send current config + deckRemaining
  socket.emit('config', {
    rounds: gameState.rounds,
    shown: gameState.shown,
    inProgress: gameState.inProgress,
    deckRemaining: Math.max(0, deck.length - deckIndex)
  });

  // Admin can reset the game (rebuild & reshuffle)
  socket.on('reset-game', () => {
    files = readImageFiles();
    buildDeckFromFiles(files);
    gameState.shown = 0;
    gameState.inProgress = false;
    io.emit('config', { rounds: gameState.rounds, shown: gameState.shown, inProgress: gameState.inProgress, deckRemaining: Math.max(0, deck.length - deckIndex) });

    // NEW: emit a clear/reset event so displays can return to landing state
    io.emit('reset', { message: 'Game reset by organiser' });
  });

  // When display requests next (spacebar)
  socket.on('request-next', () => {
    // detect folder changes (if changed, rebuild deck and instruct to restart)
    const currentFiles = readImageFiles();
    const filesChanged = currentFiles.length !== files.length || currentFiles.some(f => !files.includes(f));
    if (filesChanged) {
      files = currentFiles;
      buildDeckFromFiles(files);
      gameState.shown = 0;
      gameState.inProgress = false;
      io.emit('config', { rounds: gameState.rounds, shown: gameState.shown, inProgress: gameState.inProgress, deckRemaining: Math.max(0, deck.length - deckIndex) });
      // Also notify clients to reset their UI
      io.emit('reset', { message: 'Image set changed on server — deck rebuilt. Start again from host.' });
      socket.emit('error-msg', 'Image set changed on server — deck rebuilt. Start again from host.');
      return;
    }

    // deck exhausted?
    if (deckIndex >= deck.length) {
      // no images left to serve
      socket.emit('deck-finished', { message: 'All images shown — deck finished.' });
      io.emit('config', { rounds: gameState.rounds, shown: gameState.shown, inProgress: false, deckRemaining: 0 });
      return;
    }

    // If game already reached the fixed rounds, don't serve next
    if (gameState.inProgress && gameState.shown >= gameState.rounds) {
      socket.emit('game-over', { message: 'Round limit reached (5). Use Reset to start again.' });
      return;
    }

    // If this is the first image in a run, mark game inProgress
    if (!gameState.inProgress) gameState.inProgress = true;

    // Serve next image from deck
    const file = deck[deckIndex++];
    const url = `/images/${encodeURIComponent(file)}`;
    const name = path.parse(file).name;

    // increment shown count
    gameState.shown += 1;

    // Emit show-image first so clients always display the name.
    io.emit('show-image', { url, name, shown: gameState.shown, rounds: gameState.rounds, deckRemaining: Math.max(0, deck.length - deckIndex) });

    // After emitting the last image, notify deck-finished AND mark inProgress=false,
    // but do NOT clear the series name on clients.
    if (deckIndex >= deck.length) {
      io.emit('deck-finished', { message: 'All images shown — deck finished.' });
      gameState.inProgress = false;
      io.emit('config', { rounds: gameState.rounds, shown: gameState.shown, inProgress: gameState.inProgress, deckRemaining: 0 });
      return;
    }

    // If we've reached the fixed-round limit after this image, notify game-over but keep last name visible.
    if (gameState.shown >= gameState.rounds) {
      io.emit('game-over', { message: `Round limit reached (${gameState.rounds}).` });
      gameState.inProgress = false;
      io.emit('config', { rounds: gameState.rounds, shown: gameState.shown, inProgress: gameState.inProgress, deckRemaining: Math.max(0, deck.length - deckIndex) });
    } else {
      // regular update to config (deckRemaining updated)
      io.emit('config', { rounds: gameState.rounds, shown: gameState.shown, inProgress: gameState.inProgress, deckRemaining: Math.max(0, deck.length - deckIndex) });
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server listening on', PORT));
