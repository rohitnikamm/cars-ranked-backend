# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the **CARS Ranked backend server** in this repository.

---

## Project Overview

CARS Ranked Backend is a Node.js server that provides HTTP REST API and Socket.io WebSocket functionality for the CARS Ranked browser extension. It manages ELO-filtered matchmaking, room creation, passage synchronization, and real-time user coordination for MCAT CARS study sessions.

**Purpose**: Coordinate ELO-filtered matchmaking (±15 ELO for ranked, first-come-first-served for casual) and synchronized passage selection between multiple browser extension clients. Server fetches ELO from Supabase (tamper-proof) and enforces a 30-second matchmaking timeout.

---

## Monorepo Structure

This backend is part of a monorepo:

- **`/cars-ranked/`** — Browser extension (Plasmo, React, TypeScript) — see [`../cars-ranked/CLAUDE.md`](../cars-ranked/CLAUDE.md)
- **`/cars-ranked-backend/`** (this directory) — Node.js Socket.io + HTTP server

---

## File Structure

```
cars-ranked-backend/
├── app.ts                     # Main server file (HTTP + Socket.io + ELO + accuracy tracking) ~500 lines
├── tsconfig.json              # TypeScript configuration
├── package.json               # Dependencies and scripts
├── package-lock.json          # Locked dependency versions
├── .env                       # Environment variables (ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
├── .gitignore                 # Git ignore patterns
└── DEBUG_NOTES.md             # Development debugging notes
```

**Note**: This is a simple single-file server. All logic is in `app.ts`.

---

## Tech Stack

| Category           | Technology            | Version |
| ------------------ | --------------------- | ------- |
| **HTTP/WebSocket** | uWebSockets.js        | 20.56.0 |
| **Real-time**      | Socket.io             | 4.8.3   |
| **Admin UI**       | @socket.io/admin-ui   | 0.5.1   |
| **Error Tracking** | Sentry (@sentry/node) | 10.32.1 |
| **Database Client**| Supabase (@supabase/supabase-js) | 2.98.0 |
| **Language**       | TypeScript            | 5.9.3   |
| **Dev Server**     | Nodemon + tsx         | —       |
| **Environment**    | dotenv                | 17.2.3  |

---

## Architecture

### Server Components

```
┌─────────────────────────────────────────┐
│         uWebSockets.js (HTTP)           │
│  ┌───────────────────────────────────┐  │
│  │     Socket.io Server              │  │
│  │  ┌────────────────────────────┐   │  │
│  │  │  @socket.io/admin-ui       │   │  │
│  │  └────────────────────────────┘   │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
         ↓                    ↓
   HTTP REST API        WebSocket Events
         ↓                    ↓
   ┌─────────┐          ┌──────────┐
   │ Rooms   │          │ Users    │
   │ (GET/   │          │ (Socket) │
   │  POST)  │          │  Events  │
   └─────────┘          └──────────┘
         ↓                    ↓
    roomPassages Map    io.sockets.adapter.rooms
    (in-memory)         (Socket.io internal)
```

### In-Memory State

**`roomPassages: Map<roomId, PassageInfo>`**

```typescript
type PassageInfo = {
    passageId: string; // Jack Westin passage ID (e.g., "passage-123")
    frameIds: number[]; // Browser frame IDs where passage exists
    passageTitle?: string; // Human-readable passage title
    passageHref?: string; // Passage anchor href for navigation
};
```

**Lifecycle**:

- Created when first user stores passage (`POST /passage/:roomId`)
- Retrieved when second user joins (`GET /passage/:roomId`)
- Deleted when room becomes empty (on `disconnect` event)

**`roomFinishTimes: Map<roomId, Map<socketId, PlayerFinishData>>`**

Tracks per-room player finish data (time + accuracy) for coordinating results.

```typescript
type PlayerFinishData = {
    elapsedMs: number;
    accuracy: number | null;   // correct / total * 100 (null if scrape failed)
    correct: number | null;
    incorrect: number | null;
    incomplete: number | null;
};
```

**Lifecycle**:

- Created when first player in room emits `playerFinished`
- When both players finish (`finishMap.size >= ROOM_MAX_CAPACITY`), personalized `resultsReady` events are emitted
- Deleted on: `cancelMatchmake`, `disconnect` (when room empties), periodic 60s sweeper, and safety net cleanup

**`roomEloResults: Map<roomId, Record<socketId, EloResult>>`**

Pre-computed ELO results for the 100% guaranteed-win early finish case. When the first player finishes with 100% accuracy, they're a guaranteed winner — ELO is computed and stored here immediately so it can be included in the second player's `resultsReady` when they finish.

```typescript
type EloResult = {
    displayName: string;
    oldElo: number;
    newElo: number;
    rank: string;
    newRank: string;
};
```

**Lifecycle**:

- Created when first player finishes with 100% accuracy (via `processEloGuaranteed()`)
- Consumed when second player finishes (sent in `resultsReady` to loser + `opponentResults` to winner)
- Deleted after consumption, or on: `cancelMatchmake`, `disconnect` (when room empties), periodic 60s sweeper, and safety net cleanup

**`socketUser: Map<socketId, { userId: string, displayName: string }>`**

Tracks authenticated user identity per socket for ELO updates.

**Lifecycle**:
- Set when client emits `matchmake` with `{ userId, displayName }`
- Deleted on `cancelMatchmake` and `disconnect`

**`waitingRooms: Map<roomId, WaitingEntry>`**

Tracks rooms with 1 player waiting for a match (used by matchmaking with ELO filtering).

```typescript
type MatchType = "ranked" | "casual";

type WaitingEntry = {
    socketId: string;           // Waiting player's socket ID
    elo: number;                // Player's ELO (fetched server-side from Supabase)
    matchType: MatchType;       // "ranked" (±15 ELO filter) or "casual" (no filter)
    timeoutHandle: ReturnType<typeof setTimeout>;  // 30s matchmake timeout
};
```

**Lifecycle**:
- Created when no compatible room exists during `matchmake` → starts 30s timeout
- Consumed when a compatible player matches → `clearTimeout` + delete entry
- Deleted + `clearTimeout` on: `cancelMatchmake`, `disconnect`, timeout expiry, periodic sweeper

**Other Maps**: `socketRoom: Map<socketId, roomId>` (for cleanup)

**Supabase Admin Client**: `supabaseAdmin` — initialized with service role key (bypasses RLS). Used by `processEloUpdate()` and `processEloGuaranteed()` to read/write `profiles.elo` column.

**Periodic Stale Room Sweeper**: Runs every 60s. Iterates `roomPassages`, `roomFinishTimes`, and `roomEloResults` Maps; deletes entries for rooms with 0 sockets. Also cleans `waitingRooms` (calls `clearTimeout` on each stale entry's timeout handle before deleting). Catches zombie rooms where sockets died without clean TCP teardown.

**Important**: In-memory state is **not persisted** to disk. Server restart clears all rooms. ELO is persisted in Supabase `profiles` table.

---

## API Reference

### HTTP REST Endpoints

All endpoints use `uWebSockets.js` HTTP handlers.

#### `GET /create`

Generate a unique 5-character room code.

**Request**: None

**Response**:

- Content-Type: `text/plain`
- Body: 5-character uppercase hex string (e.g., `"A3F9K"`)

**Logic**:

```typescript
1. Generate random 5-char code: crypto.randomBytes(20).toString('hex').slice(0, 5).toUpperCase()
2. Check if room is empty: io.sockets.adapter.rooms.get(code)?.size ?? 0 === 0
3. If occupied, regenerate until unique
4. Return code
```

**Extension Usage**: Called by [`createRoom.ts`](../cars-ranked/src/background/messages/createRoom.ts) message handler.

---

#### `POST /passage/:roomId`

Store passage metadata for a room.

**URL Parameters**:

- `roomId` (string) — 5-character room code

**Request Body** (JSON):

```json
{
    "passageId": "passage-123",
    "frameIds": [0],
    "passageTitle": "Psychology of Memory"
}
```

**Response**:

- **200 OK**: `{ "success": true }`
- **400 Bad Request**: `{ "error": "passageId and frameIds are required" }`
- **400 Bad Request**: `{ "error": "Invalid JSON" }`

**Logic**:

```typescript
1. Extract roomId from URL parameter
2. Parse JSON body (streamed via res.onData)
3. Validate passageId and frameIds are present
4. Store in roomPassages.set(roomId, { passageId, frameIds, passageTitle })
5. Log: "[CARS Ranked] Stored passage for room {roomId}: {passageId}"
```

**Extension Usage**: Called by [`setPassageInfo.ts`](../cars-ranked/src/background/messages/setPassageInfo.ts) after user creates room.

---

#### `GET /passage/:roomId`

Retrieve passage metadata for a room.

**URL Parameters**:

- `roomId` (string) — 5-character room code

**Response**:

- **200 OK**:
    ```json
    {
        "passageId": "passage-123",
        "frameIds": [0],
        "passageTitle": "Psychology of Memory"
    }
    ```
- **404 Not Found**: `{ "error": "Room not found" }`
- **400 Bad Request**: `{ "error": "Room ID is required" }`

**Logic**:

```typescript
1. Extract roomId from URL parameter
2. Lookup roomPassages.get(roomId)
3. If not found, return 404
4. Return passage info as JSON
5. Log: "[CARS Ranked] Retrieved passage for room {roomId}: {passageId}"
```

**Extension Usage**: Called by [`getPassageInfo.ts`](../cars-ranked/src/background/messages/getPassageInfo.ts) when user joins existing room.

---

### Socket.io Events

Socket.io server listens on port **3000** (hardcoded in `app.listen(3000)`).

#### Connection Event: `connection`

Triggered when a client connects.

**Handler**:

```typescript
io.sockets.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Define event handlers:
  socket.on("clockSync", ...)        // NTP-style clock sync
  socket.on("matchmake", ...)        // Auto-matchmaking
  socket.on("cancelMatchmake", ...)  // Cancel matchmaking
  socket.on("playerFinished", ...)   // Player finished test → store time, emit results
  socket.on("disconnect", ...)       // Cleanup rooms/state
});
```

---

#### Client → Server: `clockSync`

NTP-style clock synchronization. Client sends its local timestamp; server echoes it back with the server's timestamp. Client uses the round-trip to estimate clock offset.

**Payload**: `{ t0: number }` — client's `Date.now()` at send time

**Server Response**: Emits `clockSyncResponse` with `{ t0, t1: Date.now() }`

**Usage**: Client runs 3 rounds on connect, takes median offset. Used to convert server-time `countdownEndAt` to local time for synchronized countdowns.

---

#### Client → Server: `join`

Client requests to join a room.

**Payload**: `roomId` (string) — 5-character room code

**Server Logic**:

```typescript
1. Count current users in room: io.sockets.adapter.rooms.get(room)?.size ?? 0
2. If numClients > 1: emit "full" (reject)
3. Force socket to leave all other rooms (one room per socket)
4. If numClients === 0:
   - socket.join(room)
   - emit "created" to this socket
5. If numClients === 1:
   - Broadcast "join" to existing user in room
   - socket.join(room)
   - emit "joined" to this socket
6. Log join event
```

**Emitted Events** (see below): `created`, `joined`, `full`, `log`

**Extension Usage**: Called by [`connectSocket.ts`](../cars-ranked/src/background/messages/connectSocket.ts) message handler.

---

#### Server → Client: `created`

Emitted to the **first user** who creates a room.

**Payload**: `roomId` (string)

**Extension Handler**: Background service worker updates UI state.

---

#### Server → Client: `joined`

Emitted to the **second user** who joins a room.

**Payload**: `roomId` (string)

**Extension Handler**: Background service worker updates UI state, confirms successful join.

---

#### Server → Client: `join`

Broadcast to **existing users in room** when a new user joins.

**Payload**: `roomId` (string)

**Extension Handler**: Notifies first user that second user has joined.

---

#### Server → Client: `full`

Emitted when a client tries to join a room with **2+ users** (rejected).

**Payload**: `roomId` (string)

**Extension Handler**: Shows error message in popup ("Room is full").

---

#### Server → Client: `log`

Debug messages from server to client console.

**Payload**: `messages[]` (array of strings)

**Example**:

```javascript
['>>> Message from server: ', 'Room A3F9K has 1 client(s)'];
```

**Extension Handler**: Content script logs to browser console.

---

#### Client → Server: `matchmake`

Auto-matchmaking with ELO-filtered matching: finds a compatible waiting room or creates a new one with a 30s timeout.

**Payload**: `{ userId?: string, displayName?: string, matchType?: MatchType }` — user identity for ELO tracking (stored in `socketUser` map); `matchType` defaults to `"ranked"`

**Server Logic**:

```typescript
1. Store userId/displayName in socketUser map (if provided)
2. Check if socket already in a room (prevent double-matchmake)
3. Fetch player's authoritative ELO from Supabase (tamper-proof): profiles.elo (default 472)
4. Search waitingRooms for compatible room:
   - Must match matchType
   - For ranked: bidirectional ±ELO_RANGE check (Math.abs(playerElo - entry.elo) <= 15)
   - For casual (future): no ELO filter
   - Clean up stale entries (roomSize === 0) during iteration
5. If compatible room found:
   - clearTimeout(waitingEntry.timeoutHandle) — cancel waiting player's 30s timer
   - socket.join(room), compute countdownEndAt = Date.now() + COUNTDOWN_MS
   - emit "matched" { roomId, role: "guest", countdownEndAt } to joining player
   - emit "matched" { roomId, role: "host", countdownEndAt } to waiting player
6. If no compatible room:
   - Create new room, socket.join(room)
   - Start 30s timeout → on expiry: emit "matchmakeTimeout" { roomId }, clean up room
   - Store WaitingEntry { socketId, elo, matchType, timeoutHandle } in waitingRooms
   - emit "waiting" { roomId }
```

**Constants**: `ROOM_MAX_CAPACITY = 2`, `COUNTDOWN_MS = 5000`, `MATCHMAKE_TIMEOUT_MS = 30_000`, `ELO_RANGE = 15`

---

#### Client → Server: `cancelMatchmake`

Cancel matchmaking or exit a room.

**Payload**: None

**Server Logic**: Calls `clearTimeout` on any waiting entry's timeout handle, removes socket from room, deletes from waitingRooms/socketRoom/socketUser/roomPassages/roomFinishTimes/roomEloResults, emits `partnerLeft` to remaining player if any, emits `matchmakeCancelled` to requesting socket.

---

#### Server → Client: `matched`

Emitted to both players when a room becomes full.

**Payload**: `{ roomId: string, role: "host" | "guest", countdownEndAt: number }`

- `countdownEndAt`: Absolute server timestamp (`Date.now() + COUNTDOWN_MS`). Both players receive the same value. Clients convert to local time using their clock offset for synchronized countdowns.

---

#### Server → Client: `waiting`

Emitted when no compatible waiting room exists; player is waiting for an opponent. A 30s server-side timeout starts.

**Payload**: `{ roomId: string }`

---

#### Server → Client: `matchmakeTimeout`

Emitted when 30 seconds elapse with no compatible match found (±15 ELO for ranked). Server cleans up the room, socket leaves room, and all maps are cleared.

**Payload**: `{ roomId: string }`

---

#### Server → Client: `partnerLeft`

Emitted when a player's partner disconnects from the room.

**Payload**: `{ roomId: string }`

---

#### Server → Client: `passageReady`

Emitted to all sockets in a room when the host uploads passage data via `POST /passage/:roomId`.

**Payload**: `{ roomId, passageId, frameIds, passageTitle, passageHref }`

---

#### Client → Server: `playerFinished`

Player finished the test. Server stores time + accuracy data and coordinates results.

**Payload**: `{ roomId: string, elapsedMs: number, accuracy: number | null, correct: number | null, incorrect: number | null, incomplete: number | null }`

**Server Logic**:

```typescript
1. Validate socket is in this room via socketRoom
2. Validate elapsedMs is a positive number
3. Prevent duplicate submissions (finishMap.has(socket.id))
4. Store PlayerFinishData { elapsedMs, accuracy, correct, incorrect, incomplete } in roomFinishTimes
5. If finishMap.size >= ROOM_MAX_CAPACITY (both players done):
   a. Check roomEloResults for pre-computed ELO (100% early finish case):
      - If exists: send "resultsReady" to second player (loser) with full data;
        send "opponentResults" to first player (winner) with opponent's accuracy/time
      - If not: call processEloUpdate() (accuracy-first winner determination),
        emit "resultsReady" to EACH socket with personalized times + accuracy + ELO
6. If finishMap.size < ROOM_MAX_CAPACITY (first player):
   a. If accuracy === 100: guaranteed winner
      - Call processEloGuaranteed(): compute & update DB for both immediately
      - Store pre-computed ELO in roomEloResults
      - Emit "resultsReady" to winner immediately (opponentElapsedMs: -2 = still playing)
   b. If accuracy < 100 or null: can't determine winner yet
      - Emit "playerFinished" { roomId } to opponent (no details revealed)
```

---

#### Server → Client: `playerFinished`

Emitted to the opponent when the first player finishes the test. Does not reveal the finisher's time.

**Payload**: `{ roomId: string }`

---

#### Server → Client: `resultsReady`

Emitted individually to each socket when results are available. Each player receives personalized results with accuracy and ELO data. In the 100% early finish case, sent to the winner immediately (with `opponentElapsedMs: -2`) and to the loser when they finish.

**Payload**:
```typescript
{
  roomId: string,
  myElapsedMs: number,
  opponentElapsedMs: number,     // -2 = opponent still playing (100% early case)
  // Accuracy data
  myAccuracy: number | null,     // correct / total * 100
  opponentAccuracy: number | null,
  opponentCorrect: number | null,
  opponentIncorrect: number | null,
  opponentIncomplete: number | null,
  // ELO data (null if ELO processing failed)
  myDisplayName: string,
  myOldElo: number | null,
  myNewElo: number | null,
  myRank: string | null,       // "Caribbean" | "Osteopathic" | "Medical" | "Ivy"
  myNewRank: string | null,
  opponentDisplayName: string,
  opponentOldElo: number | null,
  opponentNewElo: number | null,
  opponentRank: string | null,
  opponentNewRank: string | null,
}
```

---

#### Server → Client: `opponentResults`

Sent to the 100% winner when their opponent finishes later. Fills in the opponent's accuracy and time data that was pending (shown as "Still playing..." in the winner's UI).

**Payload**:
```typescript
{
  roomId: string,
  opponentElapsedMs: number,
  opponentAccuracy: number | null,
  opponentCorrect: number | null,
  opponentIncorrect: number | null,
  opponentIncomplete: number | null,
}
```

---

#### Client → Server: `disconnect`

Triggered when a client disconnects (browser close, network loss, etc.).

**Server Logic**:

```typescript
1. Log: "User disconnected: {socket.id}"
2. Look up room via socketRoom, clean up socketRoom and socketUser entries
3. If room found:
   a. clearTimeout on any waitingRooms entry for this room (prevent orphaned timers)
   b. Remove from waitingRooms
   c. If room empty: delete roomPassages, roomFinishTimes, and roomEloResults for that room
   d. If room has remaining players (< capacity): emit "partnerLeft" to them
4. Safety net: iterate roomPassages, roomFinishTimes, and roomEloResults Maps, delete entries for empty rooms
```

**Critical**: This is the **primary cleanup mechanism**. All in-memory state (roomPassages, roomFinishTimes, roomEloResults, waitingRooms, socketRoom) is cleaned up when rooms become empty.

---

## Admin Dashboard

Socket.io Admin UI is enabled via `@socket.io/admin-ui`.

**Access**:

- URL: http://localhost:3000/admin
- Username: `admin`
- Password: Bcrypt hash stored in `ADMIN_PASSWORD` environment variable

**Features**:

- View connected sockets
- Monitor rooms and users
- See real-time events
- Disconnect clients manually

**Configuration** (`app.ts`):

```typescript
instrument(io, {
    auth: {
        type: 'basic',
        username: 'admin',
        password: process.env.ADMIN_PASSWORD as string,
    },
});
```

---

## Extension Integration

### Extension → Backend Communication Flow

#### Room Creation Flow

```
Extension Background (createRoom.ts)
  ↓ HTTP GET
Backend: GET /create → generates "A3F9K"
  ↓ HTTP Response
Extension Background: Stores roomId
  ↓
Extension Content Script: Scans passage
  ↓ HTTP POST
Backend: POST /passage/A3F9K with { passageId, frameIds, passageTitle }
  ↓ HTTP Response
Backend: roomPassages.set("A3F9K", ...)
  ↓ WebSocket
Extension Background (connectSocket.ts): socket.emit("join", "A3F9K")
  ↓ Socket.io
Backend: socket.on("join") → emit "created"
  ↓ WebSocket
Extension Popup: Shows "Room created: A3F9K"
```

#### Room Joining Flow

```
Extension Background (getPassageInfo.ts)
  ↓ HTTP GET
Backend: GET /passage/A3F9K → { passageId, frameIds, passageTitle }
  ↓ HTTP Response
Extension Background: Stores passage data
  ↓
Extension Content Script: Navigates to passage
  ↓ WebSocket
Extension Background (connectSocket.ts): socket.emit("join", "A3F9K")
  ↓ Socket.io
Backend: socket.on("join") → emit "joined" + broadcast "join" to room
  ↓ WebSocket
Extension Popup: Shows "Joined room: A3F9K"
  ↓
Backend: Both users now in same Socket.io room
```

### Extension Message Handlers That Call Backend

| Extension Handler                                                               | Backend Endpoint/Event  | Request            | Response                  |
| ------------------------------------------------------------------------------- | ----------------------- | ------------------ | ------------------------- |
| [`createRoom.ts`](../cars-ranked/src/background/messages/createRoom.ts)         | `GET /create`           | None               | Room code (string)        |
| [`getPassageInfo.ts`](../cars-ranked/src/background/messages/getPassageInfo.ts) | `GET /passage/:roomId`  | None               | `PassageInfo` JSON        |
| [`setPassageInfo.ts`](../cars-ranked/src/background/messages/setPassageInfo.ts) | `POST /passage/:roomId` | `PassageInfo` JSON | `{ success: true }`       |
| [`connectSocket.ts`](../cars-ranked/src/background/messages/connectSocket.ts)   | Socket.io `join`        | `roomId` string    | `created`/`joined`/`full` |

For full extension details, see [`../cars-ranked/CLAUDE.md`](../cars-ranked/CLAUDE.md).

---

## Commands

```bash
# Development
npm run dev                  # Nodemon + tsx → watches app.ts → port 3000
npm run build                # TypeScript compile → dist/
npm start                    # Run compiled dist/app.js
npm run sentry:sourcemaps    # Upload source maps to Sentry (requires SENTRY_AUTH_TOKEN)

# Sentry (included in build)
npm run build                # Compiles + uploads sourcemaps automatically
```

**Note**: No test framework is configured.

---

## Environment Variables

**`.env`** file (required):

```bash
ADMIN_PASSWORD="<bcrypt-hashed-password>"  # For Socket.io Admin UI
SUPABASE_URL="https://nmhxwlqugqvzptbxtmqd.supabase.co"  # Supabase project URL
SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"  # Bypasses RLS for ELO updates
```

**Generating Admin Password**:

```bash
# Install bcrypt-cli globally
npm install -g bcrypt-cli

# Generate hash (example: password "admin123")
bcryptjs "admin123"

# Copy hash to .env
ADMIN_PASSWORD="$2a$10$..."
```

**Optional** (for Sentry):

- `SENTRY_AUTH_TOKEN` — Sentry authentication token for sourcemap uploads
- `SENTRY_ORG` — Sentry organization slug
- `SENTRY_PROJECT` — Sentry project slug

---

## Server Configuration

### Port

**Default**: Port **3000** via `const PORT = Number(process.env.PORT) || 3000`.

**To Change**: Set `PORT` environment variable in `.env`.

**Extension Update Required**:

```bash
# cars-ranked/.env
PLASMO_PUBLIC_SOCKET_ENDPOINT="http://localhost:<NEW_PORT>"
```

### CORS

Socket.io configured with permissive CORS (required for browser extension):

```typescript
const io = new Server({
    cors: {
        origin: true, // Allow all origins
        credentials: true, // Allow credentials
        methods: ['GET'], // Only GET for CORS preflight
    },
});
```

**Security Note**: In production, restrict `origin` to specific domains.

### Room Limits

**Maximum users per room**: **2** (hardcoded in `join` event handler)

```typescript
if (numClients > 1) {
    socket.emit('full', room); // Reject if already 2 users
}
```

**To Change**: Modify condition in `socket.on("join")` handler.

---

## Data Lifecycle

### Room Creation

```
1. Extension calls GET /create
2. Backend generates unique code (e.g., "A3F9K")
3. Extension calls POST /passage/A3F9K
4. Backend stores in roomPassages Map
5. Room now exists with passage data
```

### Room Active State

```
1. First user: socket.emit("join", "A3F9K")
   - Backend: socket.join("A3F9K")
   - Backend: emit "created"

2. Second user: socket.emit("join", "A3F9K")
   - Backend: socket.join("A3F9K")
   - Backend: broadcast "join" to first user
   - Backend: emit "joined" to second user

3. Both users in Socket.io room "A3F9K"
4. roomPassages.get("A3F9K") contains passage data
```

### Room Cleanup

```
1. User closes browser tab → WebSocket disconnect
2. Backend: socket.on("disconnect") triggered
3. Backend: Check if isEmpty("A3F9K") === true
4. If empty: roomPassages.delete("A3F9K")
5. Room fully cleaned up (no storage, no state)
```

**Important**: No orphaned rooms. All state is ephemeral.

### Timer & Results Lifecycle

```
1. Player clicks "End Test" in browser
   → Extension scrapes accuracy from results page (correct/incorrect/incomplete)
   → Extension emits playerFinished { roomId, elapsedMs, accuracy, correct, incorrect, incomplete }
   → Server stores PlayerFinishData in roomFinishTimes[roomId][socketId]

2. If first player to finish with 100% accuracy (guaranteed winner):
   → Server calls processEloGuaranteed() → computes & updates DB for both
   → Server stores pre-computed ELO in roomEloResults
   → Server emits "resultsReady" to winner immediately (opponentElapsedMs: -2 = still playing)
   → Server emits "playerFinished" { roomId } to opponent (no details)
   → Winner sees results with opponent card showing "Still playing..."

3. If first player to finish with <100% accuracy:
   → Server emits "playerFinished" { roomId } to opponent (no details)
   → Opponent's extension shows "Waiting for opponent..."

4. If second player to finish (finishMap.size >= ROOM_MAX_CAPACITY):
   a. If roomEloResults exists (100% early finish case):
      → Server emits "resultsReady" to second player (loser) with full data + pre-computed ELO
      → Server emits "opponentResults" to first player (winner) with opponent's accuracy/time
   b. Normal case (no pre-computed ELO):
      → Server calls processEloUpdate() (accuracy-first winner determination)
      → Server emits personalized "resultsReady" to EACH socket with times + accuracy + ELO
   → Both extensions show Final Results screen

5. If opponent disconnects before finishing:
   → Extension handles via "partnerLeft" event
   → If player already finished, shows results with opponentElapsedMs: -1 (DNF)
   → If 100% early ELO was processed, ELO stands (already written to DB)
```

### ELO Ranking System

Server-side ELO computation and persistence via Supabase.

**Database**: `public.profiles.elo` — integer column, default 472, CHECK constraint [472, 528]

**Ranks and Deltas**:

| Rank | ELO Range | Win | Loss |
|------|-----------|-----|------|
| Caribbean | 472-485 | +5 | -1 |
| Osteopathic | 486-499 | +3 | -2 |
| Medical | 500-514 | +2 | -3 |
| Ivy | 515-528 | +1 | -5 |

**Functions** (in `app.ts`):
- `getRank(elo)` → rank name based on ELO value
- `computeNewElo(currentElo, won)` → new ELO clamped to [472, 528]
- `processEloUpdate(player1, player2)` → async: fetches ELO from Supabase, determines winner (**accuracy-first**: higher accuracy wins; time tiebreaker; equal both = tie/no change), computes new ELO, updates DB, returns results for both players
- `processEloGuaranteed(winnerSocketId, loserSocketId)` → async: called when first player finishes with 100% accuracy (guaranteed winner). Fetches ELO, computes new ELO for both, updates DB immediately, returns results. Winner sees results right away; loser sees theirs when they finish.

**Flow (normal)**: When both players finish → `processEloUpdate()` called → fetches both profiles → determines winner (higher accuracy wins; time tiebreaker; tie = no change) → applies rank-specific delta → clamps → updates `profiles.elo` → returns `{ displayName, oldElo, newElo, rank, newRank }` per player → included in `resultsReady` payload.

**Flow (100% early finish)**: First player finishes with 100% accuracy → `processEloGuaranteed()` called → fetches both profiles → winner = first player (guaranteed) → computes and updates DB for both immediately → stores in `roomEloResults` → sends `resultsReady` to winner (`opponentElapsedMs: -2` = still playing) → when opponent finishes: sends `resultsReady` to loser + `opponentResults` to winner (fills in opponent's accuracy/time).

---

## Error Handling

### HTTP Errors

| Status          | Condition                  | Response                                           |
| --------------- | -------------------------- | -------------------------------------------------- |
| 400 Bad Request | Missing room ID            | `{ error: "Room ID is required" }`                 |
| 400 Bad Request | Invalid JSON body          | `{ error: "Invalid JSON" }`                        |
| 400 Bad Request | Missing passageId/frameIds | `{ error: "passageId and frameIds are required" }` |
| 404 Not Found   | Room doesn't exist         | `{ error: "Room not found" }`                      |

### Socket.io Errors

| Event  | Condition         | Action                          |
| ------ | ----------------- | ------------------------------- |
| `full` | Room has 2+ users | Reject new connection           |
| (none) | Connection error  | Browser extension handles retry |

**Sentry Integration**: All errors are automatically captured by `@sentry/node`.

---

## Logging

### Console Logs

**Server Start**:

```
listening on *:3000
```

**User Connection**:

```
User connected: AbCdEfGhIj123456
```

**Room Join**:

```
>>> Message from server: Room A3F9K has 0 client(s)
>>> Message from server: Request to create or join room A3F9K
emit(): client AbCdEfGhIj123456 joined room A3F9K
```

**Passage Storage**:

```
[CARS Ranked] Stored passage for room A3F9K: passage-123 (Psychology of Memory)
```

**Passage Retrieval**:

```
[CARS Ranked] Retrieved passage for room A3F9K: passage-123
```

**User Disconnect**:

```
User disconnected: AbCdEfGhIj123456
[CARS Ranked] Cleaned up passage for empty room A3F9K
```

### Client Logs

The `log()` function sends debug messages to clients:

```typescript
function log(...messages: string[]) {
    const array = ['>>> Message from server: '];
    for (let i = 0; i < messages.length; i++) {
        array.push(arguments[i]);
    }
    socket.emit('log', array);
}
```

Extension content script receives these via `socket.on("log")`.

---

## Debugging Tips

### Verify Server Running

```bash
curl http://localhost:3000/create
# Should return: "A3F9K" (or similar)

curl http://localhost:3000/passage/A3F9K
# Should return: {"error":"Room not found"}
```

### Test Socket.io Connection

```bash
npm install -g wscat
wscat -c ws://localhost:3000/socket.io/?EIO=4&transport=websocket

# Should see Socket.io handshake
```

### Check Active Rooms

**Admin UI**: http://localhost:3000/admin

- Username: `admin`
- Password: Value from `.env` (plaintext, not hash)

### Common Issues

**Port 3000 already in use**:

```bash
lsof -ti:3000 | xargs kill -9  # Kill process on port 3000
```

**CORS errors**:

- Verify `cors: { origin: true }` in Socket.io config
- Check browser console for specific CORS error

**Room not found (404)**:

- Room may have been cleaned up (all users disconnected)
- Verify passage was stored via `POST /passage/:roomId`
- Check server logs for cleanup messages

**Admin password not working**:

- `.env` should contain **plaintext** password, not bcrypt hash
- Restart server after changing `.env`

---

## Making Extension Changes

When extension modifies backend requirements:

### Adding New HTTP Endpoint

1. **Add route in `app.ts`**:

    ```typescript
    app.get('/room/:roomId/users', (res, req) => {
        const roomId = req.getParameter(0);
        const room = io.sockets.adapter.rooms.get(roomId);
        const userCount = room?.size ?? 0;
        res.end(JSON.stringify({ userCount }));
    });
    ```

2. **Create extension message handler**:

    ```typescript
    // cars-ranked/src/background/messages/getRoomUsers.ts
    export default async function getRoomUsers({ body }) {
        const response = await fetch(`${endpoint}/room/${body.roomId}/users`);
        return await response.json();
    }
    ```

3. **Update both CLAUDE.md files**:
    - `cars-ranked-backend/CLAUDE.md` (this file): Add to API Reference
    - `cars-ranked/CLAUDE.md`: Add to Backend Integration table

### Adding New Socket.io Event

1. **Add handler in `app.ts`**:

    ```typescript
    socket.on('message', (roomId, message) => {
        io.sockets.in(roomId).emit('message', socket.id, message);
    });
    ```

2. **Add to extension background**:

    ```typescript
    // cars-ranked/src/background/index.ts
    socket.on('message', (userId, message) => {
        console.log(`Message from ${userId}: ${message}`);
    });
    ```

3. **Update types** (if needed):

    ```typescript
    // cars-ranked/src/types/socket.ts
    export enum SOCKET_EVENTS {
        MESSAGE = 'message', // Add new event
        // ...existing events
    }
    ```

4. **Update both CLAUDE.md files**

---

## Production Deployment

### Build for Production

```bash
npm run build
# Outputs to dist/app.js
# Automatically uploads sourcemaps to Sentry
```

### Run Production Build

```bash
npm start
# Runs node dist/app.js
```

### Environment Checklist

- [ ] Set `ADMIN_PASSWORD` in production `.env`
- [ ] Configure Sentry environment variables (optional)
- [ ] Update extension `.env` with production backend URL
- [ ] Restrict CORS `origin` to extension domain
- [ ] Consider persisting `roomPassages` to Redis/database
- [ ] Set up process manager (PM2, systemd, etc.)
- [ ] Configure reverse proxy (nginx) for HTTPS
- [ ] Enable rate limiting for HTTP endpoints

### Scaling Considerations

**Current Limitations**:

- Single-process server (no clustering)
- In-memory state (lost on restart)
- No Redis/database persistence
- No horizontal scaling

**Recommendations for Scale**:

1. **Redis Adapter**: Store `roomPassages` in Redis
    ```bash
    npm install @socket.io/redis-adapter redis
    ```
2. **Socket.io Redis**: Share rooms across multiple server instances
3. **Database**: Persist room history (optional)
4. **Load Balancer**: Sticky sessions required for Socket.io

---

## Security Considerations

### Current Security Posture

- **No socket authentication**: Anyone can create/join rooms with code (user identity sent voluntarily with matchmake)
- **Supabase service role key**: Used server-side only for ELO updates (bypasses RLS); never exposed to client
- **Ephemeral data**: Passage info deleted when room empties; ELO persisted in Supabase
- **No rate limiting**: Vulnerable to abuse (room creation spam)
- **Permissive CORS**: Allows all origins

### Recommendations

1. **Rate Limiting**: Add per-IP limits for `/create`
2. **Room Expiration**: Auto-delete rooms after X hours
3. **CORS Restriction**: Whitelist specific origins
4. **Input Validation**: Sanitize room codes, passage IDs
5. **Admin UI**: Add authentication middleware (beyond basic auth)

---

## Related Documentation

- **Browser Extension**: See [`../cars-ranked/CLAUDE.md`](../cars-ranked/CLAUDE.md)
- **uWebSockets.js**: https://github.com/uNetworking/uWebSockets.js
- **Socket.io Server**: https://socket.io/docs/v4/server-api/
- **Socket.io Admin UI**: https://socket.io/docs/v4/admin-ui/
- **Sentry Node.js**: https://docs.sentry.io/platforms/node/
