# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the **CARS Ranked backend server** in this repository.

---

## Project Overview

CARS Ranked Backend is a Node.js server that provides HTTP REST API and Socket.io WebSocket functionality for the CARS Ranked browser extension. It manages ELO-filtered matchmaking, room creation, passage synchronization, and real-time user coordination for MCAT CARS study sessions.

**Purpose**: Coordinate matchmaking (±15 ELO-filtered for ranked, first-come-first-served for casual) and synchronized passage selection between multiple browser extension clients. Server fetches ELO from Supabase (tamper-proof) and enforces a 30-second matchmaking timeout. Ranked mode applies ELO gain/loss; casual mode skips all ELO processing.

---

## Monorepo Structure

This backend is part of a monorepo:

- **`/cars-ranked/`** — Browser extension (Plasmo, React, TypeScript) — see [`../cars-ranked/CLAUDE.md`](../cars-ranked/CLAUDE.md)
- **`/cars-ranked-backend/`** (this directory) — Node.js Socket.io + HTTP server

---

## File Structure

```
cars-ranked-backend/
├── app.ts                     # Main server file (HTTP + Socket.io + ELO + accuracy tracking) ~850 lines
├── Dockerfile                 # Ubuntu 24.04 + Node 22 for Railway deployment (uWebSockets.js requires glibc 2.38+)
├── tsconfig.json              # TypeScript configuration (module: nodenext)
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
| **Error Tracking** | Sentry (@sentry/node) | 10.32.1 (dependency only; not initialized in app.ts) |
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
    isTest: boolean;            // Test user flag — test users only match with other test users
    timeoutHandle: ReturnType<typeof setTimeout>;  // 30s matchmake timeout
};
```

**Lifecycle**:
- Created when no compatible room exists during `matchmake` → starts 30s timeout
- Consumed when a compatible player matches → `clearTimeout` + delete entry
- Deleted + `clearTimeout` on: `cancelMatchmake`, `disconnect`, timeout expiry, periodic sweeper

**`roomMatchTypes: Map<roomId, MatchType>`**

Tracks match type per room for ELO decision at finish time.

**Lifecycle**:
- Set when room is created during `matchmake` (`roomMatchTypes.set(code, matchType)`)
- Read in `playerFinished` handler to gate ELO processing (`isCasual = roomMatchTypes.get(roomId) === "casual"`)
- Included in all `resultsReady` emissions as `matchType` field
- Deleted on: `cancelMatchmake`, `disconnect` (when room empties), periodic 60s sweeper, and safety net cleanup

**Other Maps**: `socketRoom: Map<socketId, roomId>` (for cleanup), `matchmakingInProgress: Set<socketId>` (async mutex — prevents concurrent processing of duplicate matchmake events from the same socket; entries added before async work and removed in `finally` block)

**Supabase Admin Client**: `supabaseAdmin` — initialized with service role key (bypasses RLS). Used by `processEloUpdate()` and `processEloGuaranteed()` to read/write `profiles.elo` column. Also reads `profiles.is_test` during matchmaking for test user isolation.

**Periodic Stale Room Sweeper**: Runs every 60s. Iterates `roomPassages`, `roomFinishTimes`, `roomEloResults`, and `roomMatchTypes` Maps; deletes entries for rooms with 0 sockets. Also cleans `waitingRooms` (calls `clearTimeout` on each stale entry's timeout handle before deleting) and expired `socketRateLimits` entries. Catches zombie rooms where sockets died without clean TCP teardown.

**Important**: In-memory state is **not persisted** to disk. Server restart clears all rooms. ELO is persisted in Supabase `profiles` table.

---

## API Reference

### HTTP REST Endpoints

All endpoints use `uWebSockets.js` HTTP handlers.

#### `POST /passage/:roomId`

Store passage metadata for a room.

**URL Parameters**:

- `roomId` (string) — 10-character alphanumeric room code (validated against `/^[A-Za-z0-9]{5,12}$/`)

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
- **400 Bad Request**: `{ "error": "Invalid room ID" }` (invalid format)
- **400 Bad Request**: `{ "error": "passageId and frameIds (array, 1-20 items) are required" }`
- **400 Bad Request**: `{ "error": "Invalid passageId" }` (non-string or >200 chars)
- **400 Bad Request**: `{ "error": "Invalid JSON" }`

**Logic**:

```typescript
1. Extract roomId from URL parameter, validate format
2. Parse JSON body (streamed via res.onData)
3. Validate passageId (string, max 200 chars) and frameIds (array, 1-20 items)
4. Store in roomPassages.set(roomId, { passageId, frameIds, passageTitle, passageHref })
5. Emit "passageReady" to room, respond with security headers
```

**Extension Usage**: Called by [`setPassageInfo.ts`](../cars-ranked/src/background/messages/setPassageInfo.ts) after user creates room.

---

#### `GET /passage/:roomId`

Retrieve passage metadata for a room.

**URL Parameters**:

- `roomId` (string) — 10-character alphanumeric room code (validated against `/^[A-Za-z0-9]{5,12}$/`)

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
- **400 Bad Request**: `{ "error": "Invalid room ID" }`

**Logic**:

```typescript
1. Extract roomId from URL parameter, validate format
2. Lookup roomPassages.get(roomId)
3. If not found, return 404 with security headers
4. Return passage info as JSON with security headers
```

**Extension Usage**: Called by [`getPassageInfo.ts`](../cars-ranked/src/background/messages/getPassageInfo.ts) when user joins existing room.

---

### Socket.io Events

Socket.io server listens on port **3000** (configurable via `PORT` env var, default 3000).

#### Connection Event: `connection`

Triggered when a client connects.

**Handler**:

```typescript
io.sockets.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("clockSync", ...)        // NTP-style clock sync
  socket.on("matchmake", ...)        // Auto-matchmaking (creates/joins rooms)
  socket.on("cancelMatchmake", ...)  // Cancel matchmaking / exit room
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

#### Client → Server: `matchmake`

Auto-matchmaking: finds a compatible waiting room or creates a new one with a 30s timeout. Ranked uses ±15 ELO filter; casual uses first-come-first-served (no ELO filter).

**Payload**: `{ userId?: string, displayName?: string, matchType?: MatchType }` — user identity for ELO tracking (stored in `socketUser` map); `matchType` defaults to `"ranked"`

**Server Logic**:

```typescript
1. Rate limit check (5 events per 10s window per socket) — reject with error if exceeded
2. Validate matchType is "ranked" or "casual" — reject with error if invalid
3. Store userId/displayName in socketUser map (if provided)
4. Acquire async mutex (matchmakingInProgress Set) — prevents concurrent processing of duplicate matchmake events from the same socket
5. Check if socket already in a room (prevent double-matchmake)
6. If ranked: check isRankedWindowOpen() — reject with "matchmakeRejected" if outside window
7. Fetch player's authoritative ELO and is_test flag from Supabase (tamper-proof): profiles.elo (default 472), profiles.is_test (default false)
8. Search waitingRooms for compatible room:
   - Must match matchType
   - Must match isTest flag (test users only match with test users)
   - Never match a socket with itself (entry.socketId !== socket.id)
   - For ranked: bidirectional ±ELO_RANGE check (Math.abs(playerElo - entry.elo) <= 15)
   - For casual: no ELO filter
   - Clean up stale entries (roomSize === 0) during iteration
9. If compatible room found:
   - clearTimeout(waitingEntry.timeoutHandle) + waitingRooms.delete() BEFORE socket.join() (race condition prevention)
   - socket.join(room), compute countdownEndAt = Date.now() + COUNTDOWN_MS
   - emit "matched" { roomId, role: "guest", countdownEndAt } to joining player
   - emit "matched" { roomId, role: "host", countdownEndAt } to waiting player
10. If no compatible room:
   - Create new 10-char alphanumeric room code, socket.join(room)
   - roomMatchTypes.set(code, matchType) — track match type for ELO gating
   - Start 30s timeout → on expiry: emit "matchmakeTimeout" { roomId }, clean up room
   - Store WaitingEntry { socketId, elo, matchType, isTest, timeoutHandle } in waitingRooms
   - emit "waiting" { roomId }
```

**Constants**: `ROOM_MAX_CAPACITY = 2`, `COUNTDOWN_MS = 5000`, `MATCHMAKE_TIMEOUT_MS = 30_000`, `ELO_RANGE = 15`

---

#### Client → Server: `cancelMatchmake`

Cancel matchmaking or exit a room.

**Payload**: None

**Server Logic**: Calls `clearTimeout` on any waiting entry's timeout handle, removes socket from room, deletes from waitingRooms/socketRoom/socketUser/roomPassages/roomFinishTimes/roomEloResults/roomMatchTypes, emits `partnerLeft` to remaining player if any, emits `matchmakeCancelled` to requesting socket.

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

Emitted when 30 seconds elapse with no compatible match found (±15 ELO for ranked, any player for casual). Server cleans up the room, socket leaves room, and all maps are cleared.

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
1. Rate limit check (5 events per 10s window per socket)
2. Validate roomId format (alphanumeric, 5-12 chars)
3. Validate socket is in this room via socketRoom
4. Validate elapsedMs is a positive number, max 14,400,000ms (4 hours)
5. Validate accuracy range (0-100 or null), correct/incorrect/incomplete (non-negative integers, max 1000, or null)
6. Prevent duplicate submissions (finishMap.has(socket.id))
4. Store PlayerFinishData { elapsedMs, accuracy, correct, incorrect, incomplete } in roomFinishTimes
5. Determine isCasual = roomMatchTypes.get(roomId) === "casual"
6. If finishMap.size >= ROOM_MAX_CAPACITY (both players done):
   a. Check roomEloResults for pre-computed ELO (100% early finish case, ranked only):
      - If exists: send "resultsReady" to second player (loser) with full data;
        send "opponentResults" to first player (winner) with opponent's accuracy/time
   b. If casual: fetch profiles read-only (no ELO update), emit "resultsReady"
      to EACH socket with myNewElo === myOldElo
   c. If ranked (normal): call processEloUpdate() (accuracy-first winner determination),
      emit "resultsReady" to EACH socket with personalized times + accuracy + ELO
7. If finishMap.size < ROOM_MAX_CAPACITY (first player):
   a. If accuracy === 100 AND ranked: guaranteed winner
      - Call processEloGuaranteed(): compute & update DB for both immediately
      - Store pre-computed ELO in roomEloResults
      - Emit "resultsReady" to winner immediately (opponentElapsedMs: -2 = still playing)
   b. If accuracy === 100 AND casual: send immediate results with unchanged ELO
      (no DB writes, no roomEloResults storage)
   c. If accuracy < 100 or null: can't determine winner yet
      - Emit "playerFinished" { roomId } to opponent (no details revealed)
8. All "resultsReady" emissions include matchType field
```

---

#### Server → Client: `playerFinished`

Emitted to the opponent when the first player finishes the test. Does not reveal the finisher's time.

**Payload**: `{ roomId: string }`

---

#### Server → Client: `resultsReady`

Emitted individually to each socket when results are available. Each player receives personalized results with accuracy and ELO data. In the 100% early finish case, sent to the winner immediately (with `opponentElapsedMs: -2`) and to the loser when they finish. For casual mode, `myNewElo === myOldElo` (no ELO change).

**Payload**:
```typescript
{
  roomId: string,
  matchType: MatchType,          // "ranked" or "casual"
  myElapsedMs: number,
  opponentElapsedMs: number,     // -2 = opponent still playing (100% early case)
  // Accuracy data
  myAccuracy: number | null,     // correct / total * 100
  opponentAccuracy: number | null,
  opponentCorrect: number | null,
  opponentIncorrect: number | null,
  opponentIncomplete: number | null,
  // ELO data (null if ELO processing failed; for casual, myNewElo === myOldElo)
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
   c. If room empty: delete roomPassages, roomFinishTimes, roomEloResults, and roomMatchTypes for that room
   d. If room has remaining players (< capacity): emit "partnerLeft" to them
4. Safety net: iterate roomPassages, roomFinishTimes, roomEloResults, and roomMatchTypes Maps, delete entries for empty rooms
```

**Critical**: This is the **primary cleanup mechanism**. All in-memory state (roomPassages, roomFinishTimes, roomEloResults, roomMatchTypes, waitingRooms, socketRoom) is cleaned up when rooms become empty.

---

## Admin Dashboard

Socket.io Admin UI is enabled via `@socket.io/admin-ui`.

**Access**:

- URL: http://localhost:3000/admin (dev) or https://cars-ranked-backend-qa.up.railway.app/admin (QA)
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

Room creation and joining is handled entirely by the `matchmake` Socket.io event. The extension emits `matchmake` with `{ userId, displayName, matchType }`, and the server either creates a new waiting room or matches with an existing compatible one. Passage data is exchanged via HTTP after matching.

### Extension Message Handlers That Call Backend

| Extension Handler                                                               | Backend Endpoint/Event  | Request            | Response                  |
| ------------------------------------------------------------------------------- | ----------------------- | ------------------ | ------------------------- |
| [`matchmake.ts`](../cars-ranked/src/background/messages/matchmake.ts)           | Socket.io `matchmake`   | `{ userId, displayName, matchType }` | `waiting`/`matched`/`matchmakeTimeout` |
| [`cancelMatchmake.ts`](../cars-ranked/src/background/messages/cancelMatchmake.ts) | Socket.io `cancelMatchmake` | None           | `matchmakeCancelled`      |
| [`getPassageInfo.ts`](../cars-ranked/src/background/messages/getPassageInfo.ts) | `GET /passage/:roomId`  | None               | `PassageInfo` JSON        |
| [`setPassageInfo.ts`](../cars-ranked/src/background/messages/setPassageInfo.ts) | `POST /passage/:roomId` | `PassageInfo` JSON | `{ success: true }`       |
| [`connectSocket.ts`](../cars-ranked/src/background/messages/connectSocket.ts)   | (legacy) Maps tab→room in `tabSockets` | `{ tabId, roomCode }` | `{ success }` |

For full extension details, see [`../cars-ranked/CLAUDE.md`](../cars-ranked/CLAUDE.md).

---

## Commands

```bash
# Development
npm run dev                  # Nodemon + tsx → watches app.ts → port 3000
npm run build                # TypeScript compile → dist/ (tsc only)
npm run build:full           # TypeScript compile + Sentry sourcemap upload
npm start                    # Run compiled dist/app.js
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

**Railway**: `PORT` is auto-injected by Railway at runtime — do not set it manually in Railway env vars.

**Local Dev**: Set `PORT` in `.env` to override the default. Update `cars-ranked/.env` accordingly:

```bash
# cars-ranked/.env
PLASMO_PUBLIC_SOCKET_ENDPOINT="http://localhost:<NEW_PORT>"
```

### CORS

Socket.io CORS is restricted to the deterministic extension ID derived from the manifest `key` field. All installations share the same ID (`gemfgidajmobibjlnhehbjglemnnihmo`) regardless of machine or directory.

```typescript
const ALLOWED_ORIGINS = [
    "chrome-extension://gemfgidajmobibjlnhehbjglemnnihmo",
];
const io = new Server({
    cors: {
        origin: (origin, callback) => {
            if (!origin || ALLOWED_ORIGINS.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error("CORS origin not allowed"));
            }
        },
        credentials: true,
        methods: ['GET'],
    },
});
```

### Room Limits

**Maximum users per room**: **2** (`ROOM_MAX_CAPACITY` constant in `app.ts`, used by matchmaking logic).

---

## Data Lifecycle

### Room Creation (via Matchmaking)

```
1. First player emits "matchmake" { userId, displayName, matchType }
2. Server generates room code, socket.join(room), emits "waiting"
3. Second compatible player emits "matchmake"
4. Server matches them, both socket.join(room), emits "matched" to both
5. Host scans DOM for passages, POSTs to /passage/:roomId
6. Server emits "passageReady" to room
```

### Room Active State

```
1. Both users matched via matchmake event → in same Socket.io room
2. Host POSTs passage data → roomPassages.set(roomId, ...)
3. Both users navigate to passage after countdown
4. roomPassages.get(roomId) contains passage data
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

2. If first player to finish with 100% accuracy:
   → Ranked: Server calls processEloGuaranteed() → computes & updates DB for both
     → Server stores pre-computed ELO in roomEloResults
     → Server emits "resultsReady" to winner immediately (opponentElapsedMs: -2 = still playing)
   → Casual: Server fetches profiles read-only, emits "resultsReady" with unchanged ELO
     (no DB writes, no roomEloResults storage)
   → Server emits "playerFinished" { roomId } to opponent (no details)
   → Winner sees results with opponent card showing "Still playing..."

3. If first player to finish with <100% accuracy:
   → Server emits "playerFinished" { roomId } to opponent (no details)
   → Opponent's extension shows "Waiting for opponent..."

4. If second player to finish (finishMap.size >= ROOM_MAX_CAPACITY):
   a. If roomEloResults exists (100% early finish case, ranked only):
      → Server emits "resultsReady" to second player (loser) with full data + pre-computed ELO
      → Server emits "opponentResults" to first player (winner) with opponent's accuracy/time
   b. Casual mode (no pre-computed ELO):
      → Server fetches profiles read-only, emits "resultsReady" with myNewElo === myOldElo
   c. Ranked normal case (no pre-computed ELO):
      → Server calls processEloUpdate() (accuracy-first winner determination)
      → Server emits personalized "resultsReady" to EACH socket with times + accuracy + ELO
   → All "resultsReady" include matchType field
   → Both extensions show Final Results screen

5. If opponent disconnects before finishing:
   → Extension handles via "partnerLeft" event
   → If player already finished, shows results with opponentElapsedMs: -1 (DNF)
   → If 100% early ELO was processed, ELO stands (already written to DB)
```

### ELO Ranking System

Server-side ELO computation and persistence via Supabase.

**Database**: `public.profiles.elo` — integer column, default 472, CHECK constraint [472, 528]. `public.profiles.is_test` — boolean column, default false; test users are isolated in matchmaking (only match with other test users) and excluded from the frontend leaderboard.

**Ranks and Deltas**:

| Rank | ELO Range | Win | Loss |
|------|-----------|-----|------|
| Caribbean | 472-485 | +5 | -1 |
| Osteopathic | 486-499 | +3 | -2 |
| Medical | 500-514 | +2 | -3 |
| Ivy | 515-528 | +1 | -5 |

**Functions** (in `app.ts`):
- `getRank(elo)` → rank name based on ELO value
- `computeNewElo(currentElo, won)` → new ELO clamped to [472, 528]; applies **ELO loss cap** — if a loss would cross a rank boundary, caps at top of the lower rank (e.g., 516 Ivy → 514, not 511). No gain cap. Uses `RANK_FLOORS` lookup.
- `processEloUpdate(player1, player2)` → async: fetches ELO from Supabase, determines winner (**accuracy-first**: higher accuracy wins; time tiebreaker; equal both = tie/no change), computes new ELO, updates DB, returns results for both players
- `processEloGuaranteed(winnerSocketId, loserSocketId)` → async: called when first player finishes with 100% accuracy (guaranteed winner). Fetches ELO, computes new ELO for both, updates DB immediately, returns results. Winner sees results right away; loser sees theirs when they finish.

**Flow (ranked normal)**: When both players finish → `processEloUpdate()` called → fetches both profiles → determines winner (higher accuracy wins; time tiebreaker; tie = no change) → applies rank-specific delta (with loss cap at rank boundary) → clamps → updates `profiles.elo` → returns `{ displayName, oldElo, newElo, rank, newRank }` per player → included in `resultsReady` payload.

**Flow (ranked 100% early finish)**: First player finishes with 100% accuracy → `processEloGuaranteed()` called → fetches both profiles → winner = first player (guaranteed) → computes and updates DB for both immediately → stores in `roomEloResults` → sends `resultsReady` to winner (`opponentElapsedMs: -2` = still playing) → when opponent finishes: sends `resultsReady` to loser + `opponentResults` to winner (fills in opponent's accuracy/time).

**Flow (casual)**: All ELO processing skipped (`roomMatchTypes.get(roomId) === "casual"`). Server fetches profiles read-only for display names/ranks. `resultsReady` sent with `myNewElo === myOldElo`. For 100% first finisher, immediate results sent without ELO computation or `roomEloResults` storage.

---

## Error Handling

### HTTP Errors

| Status          | Condition                  | Response                                           |
| --------------- | -------------------------- | -------------------------------------------------- |
| 400 Bad Request | Invalid room ID format     | `{ error: "Invalid room ID" }`                     |
| 400 Bad Request | Invalid JSON body          | `{ error: "Invalid JSON" }`                        |
| 400 Bad Request | Missing/invalid passageId/frameIds | `{ error: "passageId and frameIds (array, 1-20 items) are required" }` |
| 400 Bad Request | Invalid passageId          | `{ error: "Invalid passageId" }`                   |
| 404 Not Found   | Room doesn't exist         | `{ error: "Room not found" }`                      |

### Socket.io Errors

| Event  | Condition         | Action                          |
| ------ | ----------------- | ------------------------------- |
| (none) | Connection error  | Browser extension handles retry |

**Note**: Sentry (`@sentry/node`) is listed as a dependency but is not currently initialized in `app.ts`.

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

**Matchmaking**:

```
[CARS Ranked] Matchmake: AbCdEfGhIj123456 (ELO 500) joined existing room A3F9K (host ELO 485)
[CARS Ranked] Matchmake: AbCdEfGhIj123456 (ELO 500) created new room A3F9K, waiting for opponent
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

Server uses `console.log` with `[CARS Ranked]` prefix for structured logging. No client-side `log()` relay function exists in the current codebase.

---

## Debugging Tips

### Verify Server Running

```bash
curl http://localhost:3000/passage/TEST1
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
- Password: Enter the **plaintext** password (admin UI handles comparison against the bcrypt hash in `.env`)

### Common Issues

**Port 3000 already in use**:

```bash
lsof -ti:3000 | xargs kill -9  # Kill process on port 3000
```

**CORS errors**:

- CORS is restricted to the deterministic extension ID `gemfgidajmobibjlnhehbjglemnnihmo`. If you see 400 errors on WebSocket handshake, the extension may not have the manifest `key` field (rebuild required).
- Check browser background console for repeated "Unexpected response code: 400" on the WebSocket URL — this is a CORS rejection symptom.

**Room not found (404)**:

- Room may have been cleaned up (all users disconnected)
- Verify passage was stored via `POST /passage/:roomId`
- Check server logs for cleanup messages

**Admin password not working**:

- `.env` must contain a **bcrypt hash** of the password (used by `@socket.io/admin-ui` `instrument()`)
- Enter the **plaintext** password in the admin UI login form
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

## Production Deployment (Railway)

The backend is deployed to **Railway** using a Dockerfile.

### Why Dockerfile?

Railway's default Node.js buildpack uses a Linux image with glibc < 2.38. uWebSockets.js v20.56.0 requires glibc 2.38+. The `Dockerfile` uses Ubuntu 24.04 (glibc 2.39) to satisfy this requirement.

### Deployment

Railway auto-detects the Dockerfile and builds from it. Pushes to the connected GitHub branch trigger automatic deploys.

- **QA URL**: `https://cars-ranked-backend-qa.up.railway.app`
- **Admin UI**: `https://cars-ranked-backend-qa.up.railway.app/admin`

### Railway Environment Variables

Set these in the Railway dashboard (Variables tab):

| Variable | Value | Notes |
|----------|-------|-------|
| `SUPABASE_URL` | `https://nmhxwlqugqvzptbxtmqd.supabase.co` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `<service-role-key>` | Bypasses RLS for ELO updates |
| `ADMIN_PASSWORD` | `<bcrypt-hash>` | For Socket.io Admin UI |
| `PORT` | *(do not set)* | Auto-injected by Railway |

### Local Build & Run

```bash
npm run build        # TypeScript compile → dist/
npm start            # Runs node dist/app.js
npm run build:full   # Compile + upload Sentry sourcemaps
```

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

- **CORS**: Restricted to the deterministic extension ID `gemfgidajmobibjlnhehbjglemnnihmo` (from manifest `key` field). All installations share this ID.
- **Rate limiting**: Per-socket rate limiting (5 events per 10s window) on `matchmake` and `playerFinished` events. Expired entries cleaned up by periodic 60s sweeper.
- **Input validation**: `playerFinished` data validated (accuracy 0-100, elapsedMs max 4h, non-negative integers for correct/incorrect/incomplete). `matchType` validated against `["ranked", "casual"]`. `roomId` format validated on HTTP endpoints (`/^[A-Za-z0-9]{5,12}$/`). `frameIds` validated as array with max 20 items. `passageId` validated as string with max 200 chars.
- **Room code entropy**: 10-character alphanumeric codes (62^10 ≈ 8.4×10^17 combinations), generated with `crypto.randomBytes`
- **Race condition prevention**: `waitingRooms` entry deleted before `socket.join()` to prevent concurrent matchers from finding the same room
- **HTTP security headers**: All responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`
- **Source maps**: `inlineSources` disabled in tsconfig to prevent source code exposure in production
- **Supabase service role key**: Used server-side only for ELO updates (bypasses RLS); never exposed to client
- **Ephemeral data**: Passage info deleted when room empties; ELO persisted in Supabase
- **No socket authentication**: User identity sent voluntarily with matchmake (not JWT-verified)

### Remaining Recommendations

1. **Socket JWT Authentication**: Validate Supabase access token on socket `connection` event to prevent impersonation
2. **Admin UI hardening**: Add rate limiting on failed login attempts, consider IP whitelisting
3. **Server-side accuracy verification**: Currently trusts client-reported accuracy; ideally verify independently

---

## Related Documentation

- **Browser Extension**: See [`../cars-ranked/CLAUDE.md`](../cars-ranked/CLAUDE.md)
- **uWebSockets.js**: https://github.com/uNetworking/uWebSockets.js
- **Socket.io Server**: https://socket.io/docs/v4/server-api/
- **Socket.io Admin UI**: https://socket.io/docs/v4/admin-ui/
- **Sentry Node.js**: https://docs.sentry.io/platforms/node/
