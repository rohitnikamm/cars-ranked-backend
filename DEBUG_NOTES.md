# Backend Server Debug Notes

## Overview

Socket.io server for CARS Ranked Chrome extension. Handles real-time room management and passage synchronization across different browsers/locations.

## Technology Stack

- **uWebSockets.js**: High-performance HTTP server
- **Socket.io**: Real-time bidirectional communication
- **TypeScript**: Type safety
- **ts-node**: Development runtime
- **nodemon**: Auto-restart on file changes

## Key Features

### 1. Room Management

- **GET /create**: Generates unique 5-character room codes
- Uses cryptographic random bytes
- Ensures room is empty before returning code

### 2. Passage Storage (Added Session 5)

- **Data Structure**: `Map<roomId, { passageId: string, frameIds: number[] }>`
- **POST /passage/:roomId**: Store passage info when host creates room
- **GET /passage/:roomId**: Retrieve passage info when joiner enters code
- **Auto-cleanup**: Deletes passage data when rooms become empty

### 3. Socket.io Events

- **join**: User joins/creates a room
- **created**: Emitted when user creates a new room (first to join)
- **joined**: Emitted when user joins existing room
- **full**: Emitted when room already has 2+ users
- **disconnect**: Cleans up empty rooms and their passage data

## Implementation Details

### uWebSockets.js Streaming Body Parse

POST /passage/:roomId uses streaming API:

```typescript
res.onData((chunk, isLast) => {
	buffer = Buffer.concat([buffer, chunkBuffer]);
	if (isLast) {
		const body = JSON.parse(buffer.toString());
		// Process body
	}
});
```

### Type Guards (Added Session 6)

Both endpoints validate roomId exists:

```typescript
if (!roomId) {
	res.writeStatus("400 Bad Request");
	res.end(JSON.stringify({ error: "Room ID is required" }));
	return;
}
```

### Cleanup Logic

On disconnect, iterates all stored passages and removes entries for empty rooms:

```typescript
roomPassages.forEach((value, roomId) => {
	if (isEmpty(roomId)) {
		roomPassages.delete(roomId);
		console.log(`[CARS Ranked] Cleaned up passage for empty room ${roomId}`);
	}
});
```

## Logging Convention

All logs prefixed with `[CARS Ranked]` for easy filtering:

- Stored passage: `[CARS Ranked] Stored passage for room XYZ: passageId`
- Retrieved passage: `[CARS Ranked] Retrieved passage for room XYZ: passageId`
- Cleanup: `[CARS Ranked] Cleaned up passage for empty room XYZ`

## Port Configuration

- Development: `localhost:3000`
- Production: TBD (will need environment variable)

## Admin Dashboard

Socket.io Admin UI available at configured endpoint with basic auth.

## Known Issues / Future Enhancements

- Passage data stored in memory (lost on server restart)
- No TTL for abandoned rooms (relies on disconnect event)
- Consider Redis for production persistence
- Consider adding passage TTL to prevent stale data

## Testing Notes

- Server must be running for extension to work
- Check logs for "User connected" when extension loads
- Check logs for "Stored passage" when host creates room
- Check logs for "Retrieved passage" when joiner enters code
