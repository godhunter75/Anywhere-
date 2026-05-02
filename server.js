import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
// Fallback to index.html for SPA-like behavior if necessary
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Matching queue
// Stores objects containing { id, socket, interests }
let waitingPool = [];

// Rate limiter per socket map
const messageTimestamps = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Rate limits state for the user
  messageTimestamps.set(socket.id, []);

  // When a user requests to start a chat
  socket.on('find_match', (data) => {
    // data.interests could be a string or array
    const userInterests = data?.interests ? data.interests.split(',').map(i => i.trim().toLowerCase()).filter(i => i) : [];
    
    // Check if the user is already in a queue
    const isAlreadyWaiting = waitingPool.find(u => u.id === socket.id);
    if (isAlreadyWaiting) return;

    // Check if they are already in a room
    // Rooms are socket.id by default, plus any joined matched room
    let currentMatchRoom = Array.from(socket.rooms).find(room => room.startsWith('room_'));
    if (currentMatchRoom) {
      // User is already matching, needs to disconnect first
      return; 
    }

    // Attempt to match with someone having common interests
    let matchIndex = -1;
    if (userInterests.length > 0) {
      matchIndex = waitingPool.findIndex(waitingUser => {
        return waitingUser.interests.some(interest => userInterests.includes(interest));
      });
    }

    // Default to a completely random pairing if no interest match was found
    if (matchIndex === -1 && waitingPool.length > 0) {
      matchIndex = 0; // Just grab the first available
    }

    if (matchIndex !== -1) {
      // We found a match
      const partner = waitingPool.splice(matchIndex, 1)[0];
      const roomId = `room_${socket.id}_${partner.id}`;

      // Join both to the unique room
      partner.socket.join(roomId);
      socket.join(roomId);

      // Save room ID on socket for easy cleanup/disconnect handling
      partner.socket.matchRoom = roomId;
      socket.matchRoom = roomId;

      // Identify each user as 'initiator' or 'responder' for WebRTC signaling
      partner.socket.emit('match_found', { 
        roomId, 
        role: 'initiator', 
        partnerInterests: userInterests 
      });
      socket.emit('match_found', { 
        roomId, 
        role: 'responder', 
        partnerInterests: partner.interests 
      });

      console.log(`Matched ${socket.id} with ${partner.id} in ${roomId}`);
    } else {
      // No match found, join waiting pool
      waitingPool.push({
        id: socket.id,
        socket: socket,
        interests: userInterests
      });
      console.log(`User ${socket.id} added to waiting pool`);
    }
  });

  // Handle messages with rate limiting
  socket.on('chat_message', (msg) => {
    // Rate Limiting: max 5 messages per second
    const now = Date.now();
    let timestamps = messageTimestamps.get(socket.id) || [];
    timestamps = timestamps.filter(t => now - t < 1000);
    
    if (timestamps.length >= 5) {
      socket.emit('system_message', { type: 'error', text: 'You are sending messages too fast.' });
      return;
    }
    
    timestamps.push(now);
    messageTimestamps.set(socket.id, timestamps);

    if (socket.matchRoom) {
      // Broadcast to the other user in the room
      socket.to(socket.matchRoom).emit('chat_message', msg);
    }
  });

  // WebRTC Signaling: Offer
  socket.on('webrtc_offer', (offer) => {
    if (socket.matchRoom) {
      socket.to(socket.matchRoom).emit('webrtc_offer', offer);
    }
  });

  // WebRTC Signaling: Answer
  socket.on('webrtc_answer', (answer) => {
    if (socket.matchRoom) {
      socket.to(socket.matchRoom).emit('webrtc_answer', answer);
    }
  });

  // WebRTC Signaling: ICE Candidate
  socket.on('webrtc_ice_candidate', (candidate) => {
    if (socket.matchRoom) {
      socket.to(socket.matchRoom).emit('webrtc_ice_candidate', candidate);
    }
  });

  // Next or specific disconnect from chat
  socket.on('leave_chat', () => {
    leaveCurrentChat(socket);
  });

  // Socket cleanup on disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    messageTimestamps.delete(socket.id);
    
    // Remove from waiting pool if they were in it
    waitingPool = waitingPool.filter(u => u.id !== socket.id);
    
    // If they were in a chat, let the partner know
    leaveCurrentChat(socket);
  });

  function leaveCurrentChat(sock) {
    if (sock.matchRoom) {
      // Notify the other partner, so they can cleanly reset
      sock.to(sock.matchRoom).emit('partner_disconnected');
      
      // Get all sockets in the room to force leave them
      const roomClients = io.sockets.adapter.rooms.get(sock.matchRoom);
      if (roomClients) {
        for (const clientId of roomClients) {
          const clientSocket = io.sockets.sockets.get(clientId);
          if (clientSocket) {
             clientSocket.leave(sock.matchRoom);
             clientSocket.matchRoom = null;
          }
        }
      }
      sock.matchRoom = null;
    } else {
      // They might just be in the waiting pool when clicking leave/next
      waitingPool = waitingPool.filter(u => u.id !== sock.id);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AnywhereChat backend running on http://localhost:${PORT}`);
});
