"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = __importDefault(require("crypto"));
const admin_ui_1 = require("@socket.io/admin-ui");
const socket_io_1 = require("socket.io");
const uWebSockets_js_1 = require("uWebSockets.js");
require("dotenv/config");
const app = (0, uWebSockets_js_1.App)();
const io = new socket_io_1.Server({
    cors: {
        origin: true,
        credentials: true,
        methods: ["GET"],
    },
});
io.attachApp(app);
// Room configuration
const ROOM_MAX_CAPACITY = 2;
const COUNTDOWN_MS = 5000;
// Generate random 5-char room code
const random = () => crypto_1.default.randomBytes(20).toString("hex").slice(0, 5).toUpperCase();
// Store passage information per room
const roomPassages = new Map();
// Rooms waiting for more players
const waitingRooms = new Set();
// Track which socket is in which room (socketId -> roomId)
const socketRoom = new Map();
// Track player finish times per room: roomId -> Map<socketId, elapsedMs>
const roomFinishTimes = new Map();
// Check if room has 0 users (true if 0)
function isEmpty(room) {
    var _a, _b;
    return ((_b = (_a = io.sockets.adapter.rooms.get(room)) === null || _a === void 0 ? void 0 : _a.size) !== null && _b !== void 0 ? _b : 0) === 0;
}
function getRoomSize(room) {
    var _a, _b;
    return (_b = (_a = io.sockets.adapter.rooms.get(room)) === null || _a === void 0 ? void 0 : _a.size) !== null && _b !== void 0 ? _b : 0;
}
// Store passage info for a room
app.post("/passage/:roomId", (res, req) => {
    const roomId = req.getParameter(0);
    if (!roomId) {
        res.writeStatus("400 Bad Request");
        res.end(JSON.stringify({ error: "Room ID is required" }));
        return;
    }
    let buffer = Buffer.alloc(0);
    res.onData((chunk, isLast) => {
        const chunkBuffer = Buffer.from(chunk);
        buffer = Buffer.concat([buffer, chunkBuffer]);
        if (isLast) {
            try {
                const body = JSON.parse(buffer.toString());
                const { passageId, frameIds, passageTitle, passageHref } = body;
                if (!passageId || !frameIds) {
                    res.writeStatus("400 Bad Request");
                    res.end(JSON.stringify({ error: "passageId and frameIds are required" }));
                    return;
                }
                roomPassages.set(roomId, { passageId, frameIds, passageTitle, passageHref });
                console.log(`[CARS Ranked] Stored passage for room ${roomId}: ${passageId}${passageTitle ? ` (${passageTitle})` : ""}`);
                // Notify all sockets in the room that passage is ready
                io.sockets
                    .in(roomId)
                    .emit("passageReady", { roomId, passageId, frameIds, passageTitle, passageHref });
                res.writeStatus("200 OK");
                res.writeHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ success: true }));
            }
            catch (error) {
                res.writeStatus("400 Bad Request");
                res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
        }
    });
    res.onAborted(() => {
        console.log("Request aborted");
    });
});
// Get passage info for a room
app.get("/passage/:roomId", (res, req) => {
    const roomId = req.getParameter(0);
    if (!roomId) {
        res.writeStatus("400 Bad Request");
        res.end(JSON.stringify({ error: "Room ID is required" }));
        return;
    }
    const passageInfo = roomPassages.get(roomId);
    if (!passageInfo) {
        console.log(`[CARS Ranked] No passage found for room ${roomId}`);
        res.writeStatus("404 Not Found");
        res.writeHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Room not found" }));
        return;
    }
    console.log(`[CARS Ranked] Retrieved passage for room ${roomId}: ${passageInfo.passageId}`);
    res.writeStatus("200 OK");
    res.writeHeader("Content-Type", "application/json");
    res.end(JSON.stringify(passageInfo));
});
// Admin dashboard for Socket.io
(0, admin_ui_1.instrument)(io, {
    auth: {
        type: "basic",
        username: "admin",
        password: process.env.ADMIN_PASSWORD,
    },
});
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
    console.log(`listening on *:${PORT}`);
});
io.sockets.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);
    // Clock synchronization: echo client's t0 + add server timestamp
    socket.on("clockSync", ({ t0 }) => {
        socket.emit("clockSyncResponse", { t0, t1: Date.now() });
    });
    // Matchmaking: find an open room or create a new one
    socket.on("matchmake", () => {
        // Prevent double-matchmaking
        if (socketRoom.has(socket.id)) {
            socket.emit("error", { message: "Already in matchmaking" });
            return;
        }
        // Find first available waiting room
        let assignedRoom = null;
        for (const roomId of waitingRooms) {
            const roomSize = getRoomSize(roomId);
            if (roomSize > 0 && roomSize < ROOM_MAX_CAPACITY) {
                assignedRoom = roomId;
                break;
            }
            else if (roomSize === 0) {
                // Stale entry — clean up
                waitingRooms.delete(roomId);
                roomPassages.delete(roomId);
            }
        }
        if (assignedRoom) {
            // Join existing room
            socket.join(assignedRoom);
            socketRoom.set(socket.id, assignedRoom);
            waitingRooms.delete(assignedRoom); // Room is now full
            console.log(`[CARS Ranked] Matchmake: ${socket.id} joined existing room ${assignedRoom}`);
            // Notify both players with same absolute countdown target
            const countdownEndAt = Date.now() + COUNTDOWN_MS;
            socket.emit("matched", { roomId: assignedRoom, role: "guest", countdownEndAt });
            socket
                .to(assignedRoom)
                .emit("matched", { roomId: assignedRoom, role: "host", countdownEndAt });
        }
        else {
            // Create new room
            let code = random();
            while (!isEmpty(code)) {
                code = random();
            }
            socket.join(code);
            socketRoom.set(socket.id, code);
            waitingRooms.add(code);
            console.log(`[CARS Ranked] Matchmake: ${socket.id} created new room ${code}, waiting for opponent`);
            socket.emit("waiting", { roomId: code });
        }
    });
    // Cancel matchmaking
    socket.on("cancelMatchmake", () => {
        const roomId = socketRoom.get(socket.id);
        if (!roomId)
            return;
        const roomSize = getRoomSize(roomId);
        socket.leave(roomId);
        socketRoom.delete(socket.id);
        waitingRooms.delete(roomId);
        roomPassages.delete(roomId);
        roomFinishTimes.delete(roomId);
        // If someone else was in the room (rare race), notify them
        if (roomSize > 1) {
            io.sockets.in(roomId).emit("partnerLeft", { roomId });
        }
        console.log(`[CARS Ranked] Matchmake cancelled: ${socket.id} left room ${roomId}`);
        socket.emit("matchmakeCancelled");
    });
    // Player finished the test
    socket.on("playerFinished", ({ roomId, elapsedMs }) => {
        var _a, _b, _c;
        const actualRoom = socketRoom.get(socket.id);
        if (!actualRoom || actualRoom !== roomId)
            return;
        if (typeof elapsedMs !== "number" || elapsedMs <= 0)
            return;
        if (!roomFinishTimes.has(roomId)) {
            roomFinishTimes.set(roomId, new Map());
        }
        const finishMap = roomFinishTimes.get(roomId);
        // Prevent duplicate submissions
        if (finishMap.has(socket.id))
            return;
        finishMap.set(socket.id, elapsedMs);
        console.log(`[CARS Ranked] Player ${socket.id} finished in room ${roomId}: ${elapsedMs}ms`);
        if (finishMap.size >= ROOM_MAX_CAPACITY) {
            // Both players finished — send personalized results to each
            const entries = Array.from(finishMap.entries());
            for (const [sid, time] of entries) {
                const opponentTime = (_b = (_a = entries.find(([s]) => s !== sid)) === null || _a === void 0 ? void 0 : _a[1]) !== null && _b !== void 0 ? _b : 0;
                (_c = io.sockets.sockets.get(sid)) === null || _c === void 0 ? void 0 : _c.emit("resultsReady", {
                    roomId,
                    myElapsedMs: time,
                    opponentElapsedMs: opponentTime,
                });
            }
            console.log(`[CARS Ranked] Results sent for room ${roomId}`);
        }
        else {
            // First player finished — notify opponent (no time revealed)
            socket.to(roomId).emit("playerFinished", { roomId });
            console.log(`[CARS Ranked] Notified opponent in room ${roomId} that a player finished`);
        }
    });
    // Clean up on disconnect
    socket.on("disconnect", () => {
        console.log(`User disconnected: ${socket.id}`);
        const roomId = socketRoom.get(socket.id);
        socketRoom.delete(socket.id);
        if (roomId) {
            waitingRooms.delete(roomId);
            const roomSize = getRoomSize(roomId);
            if (roomSize === 0) {
                roomPassages.delete(roomId);
                roomFinishTimes.delete(roomId);
                console.log(`[CARS Ranked] Cleaned up empty room ${roomId}`);
            }
            else if (roomSize < ROOM_MAX_CAPACITY) {
                // Partner left — notify remaining players
                io.sockets.in(roomId).emit("partnerLeft", { roomId });
                console.log(`[CARS Ranked] Partner left room ${roomId}, notified remaining players`);
            }
        }
        // Safety net: clean up any orphaned maps
        roomPassages.forEach((_, rid) => {
            if (isEmpty(rid)) {
                roomPassages.delete(rid);
            }
        });
        roomFinishTimes.forEach((_, rid) => {
            if (isEmpty(rid)) {
                roomFinishTimes.delete(rid);
            }
        });
    });
});
//# sourceMappingURL=app.js.map