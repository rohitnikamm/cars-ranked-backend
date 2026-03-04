var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import crypto from "crypto";
import { instrument } from "@socket.io/admin-ui";
import { createClient } from "@supabase/supabase-js";
import { Server } from "socket.io";
import { App } from "uWebSockets.js";
import "dotenv/config";
// Supabase admin client (service role — bypasses RLS)
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const app = App();
const io = new Server({
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
const MATCHMAKE_TIMEOUT_MS = 30000;
const ELO_RANGE = 15;
// Generate random 5-char room code
const random = () => crypto.randomBytes(20).toString("hex").slice(0, 5).toUpperCase();
// Store passage information per room
const roomPassages = new Map();
const waitingRooms = new Map();
// Track which socket is in which room (socketId -> roomId)
const socketRoom = new Map();
// Track player finish data per room: roomId -> Map<socketId, PlayerFinishData>
const roomFinishTimes = new Map();
const roomEloResults = new Map();
// Track match type per room for ELO decision at finish time
const roomMatchTypes = new Map();
// Track socket -> authenticated user identity
const socketUser = new Map();
// Mutex: prevent concurrent matchmake processing for the same socket (async race guard)
const matchmakingInProgress = new Set();
function getRank(elo) {
    if (elo <= 485)
        return "Caribbean";
    if (elo <= 499)
        return "Osteopathic";
    if (elo <= 514)
        return "Medical";
    return "Ivy";
}
const ELO_DELTAS = {
    Caribbean: { win: 5, loss: -1 },
    Osteopathic: { win: 3, loss: -2 },
    Medical: { win: 2, loss: -3 },
    Ivy: { win: 1, loss: -5 },
};
const RANK_FLOORS = {
    Caribbean: 472,
    Osteopathic: 486,
    Medical: 500,
    Ivy: 515,
};
function computeNewElo(currentElo, won) {
    const rank = getRank(currentElo);
    const delta = won ? ELO_DELTAS[rank].win : ELO_DELTAS[rank].loss;
    let newElo = currentElo + delta;
    // ELO loss cap: if losing would cross a rank boundary, cap at top of the lower rank
    if (!won && rank !== "Caribbean") {
        const floor = RANK_FLOORS[rank];
        if (newElo < floor) {
            newElo = floor - 1;
        }
    }
    return Math.max(472, Math.min(528, newElo));
}
function processEloUpdate(player1, player2) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const user1 = socketUser.get(player1.socketId);
        const user2 = socketUser.get(player2.socketId);
        if (!user1 || !user2)
            return null;
        const { data: profiles, error } = yield supabaseAdmin
            .from("profiles")
            .select("id, elo, display_name")
            .in("id", [user1.userId, user2.userId]);
        if (error || !profiles || profiles.length < 2)
            return null;
        const profile1 = profiles.find((p) => p.id === user1.userId);
        const profile2 = profiles.find((p) => p.id === user2.userId);
        // Determine winner: PRIMARY = higher accuracy, TIEBREAKER = faster time
        const acc1 = (_a = player1.data.accuracy) !== null && _a !== void 0 ? _a : 0;
        const acc2 = (_b = player2.data.accuracy) !== null && _b !== void 0 ? _b : 0;
        let p1Won = false;
        let p2Won = false;
        let isTie = false;
        if (acc1 > acc2) {
            p1Won = true;
        }
        else if (acc2 > acc1) {
            p2Won = true;
        }
        else {
            // Equal accuracy — tiebreak by time (lower is better)
            if (player1.data.elapsedMs < player2.data.elapsedMs) {
                p1Won = true;
            }
            else if (player2.data.elapsedMs < player1.data.elapsedMs) {
                p2Won = true;
            }
            else {
                isTie = true;
            }
        }
        const newElo1 = isTie ? profile1.elo : computeNewElo(profile1.elo, p1Won);
        const newElo2 = isTie ? profile2.elo : computeNewElo(profile2.elo, p2Won);
        yield Promise.all([
            supabaseAdmin.from("profiles").update({ elo: newElo1 }).eq("id", user1.userId),
            supabaseAdmin.from("profiles").update({ elo: newElo2 }).eq("id", user2.userId),
        ]);
        return {
            [player1.socketId]: {
                displayName: profile1.display_name,
                oldElo: profile1.elo,
                newElo: newElo1,
                rank: getRank(profile1.elo),
                newRank: getRank(newElo1),
            },
            [player2.socketId]: {
                displayName: profile2.display_name,
                oldElo: profile2.elo,
                newElo: newElo2,
                rank: getRank(profile2.elo),
                newRank: getRank(newElo2),
            },
        };
    });
}
/**
 * Process ELO when winner is already known (100% guaranteed win).
 * Fetches profiles, computes ELO, updates DB.
 */
function processEloGuaranteed(winnerSocketId, loserSocketId) {
    return __awaiter(this, void 0, void 0, function* () {
        const winnerUser = socketUser.get(winnerSocketId);
        const loserUser = socketUser.get(loserSocketId);
        if (!winnerUser || !loserUser)
            return null;
        const { data: profiles, error } = yield supabaseAdmin
            .from("profiles")
            .select("id, elo, display_name")
            .in("id", [winnerUser.userId, loserUser.userId]);
        if (error || !profiles || profiles.length < 2)
            return null;
        const winnerProfile = profiles.find((p) => p.id === winnerUser.userId);
        const loserProfile = profiles.find((p) => p.id === loserUser.userId);
        const newWinnerElo = computeNewElo(winnerProfile.elo, true);
        const newLoserElo = computeNewElo(loserProfile.elo, false);
        yield Promise.all([
            supabaseAdmin.from("profiles").update({ elo: newWinnerElo }).eq("id", winnerUser.userId),
            supabaseAdmin.from("profiles").update({ elo: newLoserElo }).eq("id", loserUser.userId),
        ]);
        return {
            [winnerSocketId]: {
                displayName: winnerProfile.display_name,
                oldElo: winnerProfile.elo,
                newElo: newWinnerElo,
                rank: getRank(winnerProfile.elo),
                newRank: getRank(newWinnerElo),
            },
            [loserSocketId]: {
                displayName: loserProfile.display_name,
                oldElo: loserProfile.elo,
                newElo: newLoserElo,
                rank: getRank(loserProfile.elo),
                newRank: getRank(newLoserElo),
            },
        };
    });
}
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
instrument(io, {
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
// Periodic stale room sweeper — catches zombie rooms where sockets died
// without a clean disconnect (e.g. network drop before pingTimeout fires)
setInterval(() => {
    let cleaned = 0;
    for (const [roomId] of roomPassages) {
        if (isEmpty(roomId)) {
            roomPassages.delete(roomId);
            roomFinishTimes.delete(roomId);
            roomEloResults.delete(roomId);
            roomMatchTypes.delete(roomId);
            cleaned++;
        }
    }
    for (const [roomId] of roomMatchTypes) {
        if (isEmpty(roomId)) {
            roomMatchTypes.delete(roomId);
            cleaned++;
        }
    }
    for (const [roomId, entry] of waitingRooms) {
        if (isEmpty(roomId)) {
            clearTimeout(entry.timeoutHandle);
            waitingRooms.delete(roomId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[CARS Ranked] Periodic cleanup: removed ${cleaned} stale entries`);
    }
}, 60000);
io.sockets.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);
    // Clock synchronization: echo client's t0 + add server timestamp
    socket.on("clockSync", ({ t0 }) => {
        socket.emit("clockSyncResponse", { t0, t1: Date.now() });
    });
    // Matchmaking: find an open room or create a new one
    socket.on("matchmake", (...args_1) => __awaiter(void 0, [...args_1], void 0, function* ({ userId, displayName, matchType = "ranked" } = {}) {
        if (userId && displayName) {
            socketUser.set(socket.id, { userId, displayName });
        }
        // Prevent concurrent matchmake processing (async race guard)
        if (matchmakingInProgress.has(socket.id)) {
            return;
        }
        matchmakingInProgress.add(socket.id);
        try {
            // Prevent double-matchmaking
            if (socketRoom.has(socket.id)) {
                socket.emit("error", { message: "Already in matchmaking" });
                return;
            }
            // Fetch authoritative ELO from Supabase (tamper-proof)
            let playerElo = 472; // default
            if (userId) {
                try {
                    const { data } = yield supabaseAdmin
                        .from("profiles")
                        .select("elo")
                        .eq("id", userId)
                        .single();
                    if ((data === null || data === void 0 ? void 0 : data.elo) != null) {
                        playerElo = data.elo;
                    }
                }
                catch (err) {
                    console.warn(`[CARS Ranked] Failed to fetch ELO for ${userId}, using default:`, err);
                }
            }
            // Find compatible waiting room
            let assignedRoom = null;
            for (const [roomId, entry] of waitingRooms) {
                if (entry.matchType !== matchType)
                    continue;
                // Never match a socket with itself
                if (entry.socketId === socket.id)
                    continue;
                const roomSize = getRoomSize(roomId);
                if (roomSize === 0) {
                    // Stale entry — clean up
                    clearTimeout(entry.timeoutHandle);
                    waitingRooms.delete(roomId);
                    roomPassages.delete(roomId);
                    continue;
                }
                if (roomSize < ROOM_MAX_CAPACITY) {
                    // For ranked: bidirectional ±ELO_RANGE check
                    if (matchType === "ranked" && Math.abs(playerElo - entry.elo) > ELO_RANGE) {
                        continue;
                    }
                    assignedRoom = roomId;
                    break;
                }
            }
            if (assignedRoom) {
                // Cancel the waiting player's timeout
                const waitingEntry = waitingRooms.get(assignedRoom);
                clearTimeout(waitingEntry.timeoutHandle);
                // Join existing room
                socket.join(assignedRoom);
                socketRoom.set(socket.id, assignedRoom);
                waitingRooms.delete(assignedRoom); // Room is now full
                console.log(`[CARS Ranked] Matchmake: ${socket.id} (ELO ${playerElo}) joined existing room ${assignedRoom} (host ELO ${waitingEntry.elo})`);
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
                roomMatchTypes.set(code, matchType);
                // Start timeout — if no match found within MATCHMAKE_TIMEOUT_MS, notify client
                const timeoutHandle = setTimeout(() => {
                    socket.emit("matchmakeTimeout", { roomId: code });
                    socket.leave(code);
                    socketRoom.delete(socket.id);
                    socketUser.delete(socket.id);
                    waitingRooms.delete(code);
                    console.log(`[CARS Ranked] Matchmake timeout: ${socket.id} in room ${code} after ${MATCHMAKE_TIMEOUT_MS}ms`);
                }, MATCHMAKE_TIMEOUT_MS);
                waitingRooms.set(code, { socketId: socket.id, elo: playerElo, matchType, timeoutHandle });
                console.log(`[CARS Ranked] Matchmake: ${socket.id} (ELO ${playerElo}) created new room ${code}, waiting for opponent`);
                socket.emit("waiting", { roomId: code });
            }
        }
        finally {
            matchmakingInProgress.delete(socket.id);
        }
    }));
    // Cancel matchmaking
    socket.on("cancelMatchmake", () => {
        const roomId = socketRoom.get(socket.id);
        if (!roomId)
            return;
        const roomSize = getRoomSize(roomId);
        // Cancel timeout if this socket was waiting
        const waitingEntry = waitingRooms.get(roomId);
        if (waitingEntry) {
            clearTimeout(waitingEntry.timeoutHandle);
        }
        socket.leave(roomId);
        socketRoom.delete(socket.id);
        socketUser.delete(socket.id);
        waitingRooms.delete(roomId);
        roomPassages.delete(roomId);
        roomFinishTimes.delete(roomId);
        roomEloResults.delete(roomId);
        roomMatchTypes.delete(roomId);
        // If someone else was in the room (rare race), notify them
        if (roomSize > 1) {
            io.sockets.in(roomId).emit("partnerLeft", { roomId });
        }
        console.log(`[CARS Ranked] Matchmake cancelled: ${socket.id} left room ${roomId}`);
        socket.emit("matchmakeCancelled");
    });
    // Player finished the test
    socket.on("playerFinished", (_a) => __awaiter(void 0, [_a], void 0, function* ({ roomId, elapsedMs, accuracy, correct, incorrect, incomplete, }) {
        var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39;
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
        const playerData = {
            elapsedMs,
            accuracy: accuracy !== null && accuracy !== void 0 ? accuracy : null,
            correct: correct !== null && correct !== void 0 ? correct : null,
            incorrect: incorrect !== null && incorrect !== void 0 ? incorrect : null,
            incomplete: incomplete !== null && incomplete !== void 0 ? incomplete : null,
        };
        finishMap.set(socket.id, playerData);
        console.log(`[CARS Ranked] Player ${socket.id} finished in room ${roomId}: ${elapsedMs}ms, accuracy=${accuracy}%`);
        const isCasual = roomMatchTypes.get(roomId) === "casual";
        const roomMatchType = (_b = roomMatchTypes.get(roomId)) !== null && _b !== void 0 ? _b : "ranked";
        if (finishMap.size >= ROOM_MAX_CAPACITY) {
            // Both players finished
            const entries = Array.from(finishMap.entries());
            // Check if ELO was already processed (100% early finish case)
            const preComputedElo = roomEloResults.get(roomId);
            if (preComputedElo) {
                // ELO already computed for this room (first player got 100%)
                const secondSid = socket.id;
                const firstSid = entries.find(([s]) => s !== secondSid)[0];
                const secondData = finishMap.get(secondSid);
                const firstData = finishMap.get(firstSid);
                const secondElo = preComputedElo[secondSid];
                const firstElo = preComputedElo[firstSid];
                // Send full results to second player (the loser)
                (_c = io.sockets.sockets.get(secondSid)) === null || _c === void 0 ? void 0 : _c.emit("resultsReady", {
                    roomId,
                    matchType: roomMatchType,
                    myElapsedMs: secondData.elapsedMs,
                    opponentElapsedMs: firstData.elapsedMs,
                    myAccuracy: secondData.accuracy,
                    opponentAccuracy: firstData.accuracy,
                    opponentCorrect: firstData.correct,
                    opponentIncorrect: firstData.incorrect,
                    opponentIncomplete: firstData.incomplete,
                    myDisplayName: (_f = (_d = secondElo === null || secondElo === void 0 ? void 0 : secondElo.displayName) !== null && _d !== void 0 ? _d : (_e = socketUser.get(secondSid)) === null || _e === void 0 ? void 0 : _e.displayName) !== null && _f !== void 0 ? _f : "Unknown",
                    myOldElo: (_g = secondElo === null || secondElo === void 0 ? void 0 : secondElo.oldElo) !== null && _g !== void 0 ? _g : null,
                    myNewElo: (_h = secondElo === null || secondElo === void 0 ? void 0 : secondElo.newElo) !== null && _h !== void 0 ? _h : null,
                    myRank: (_j = secondElo === null || secondElo === void 0 ? void 0 : secondElo.rank) !== null && _j !== void 0 ? _j : null,
                    myNewRank: (_k = secondElo === null || secondElo === void 0 ? void 0 : secondElo.newRank) !== null && _k !== void 0 ? _k : null,
                    opponentDisplayName: (_o = (_l = firstElo === null || firstElo === void 0 ? void 0 : firstElo.displayName) !== null && _l !== void 0 ? _l : (_m = socketUser.get(firstSid)) === null || _m === void 0 ? void 0 : _m.displayName) !== null && _o !== void 0 ? _o : "Unknown",
                    opponentOldElo: (_p = firstElo === null || firstElo === void 0 ? void 0 : firstElo.oldElo) !== null && _p !== void 0 ? _p : null,
                    opponentNewElo: (_q = firstElo === null || firstElo === void 0 ? void 0 : firstElo.newElo) !== null && _q !== void 0 ? _q : null,
                    opponentRank: (_r = firstElo === null || firstElo === void 0 ? void 0 : firstElo.rank) !== null && _r !== void 0 ? _r : null,
                    opponentNewRank: (_s = firstElo === null || firstElo === void 0 ? void 0 : firstElo.newRank) !== null && _s !== void 0 ? _s : null,
                });
                // Send opponent data update to first player (the winner)
                (_t = io.sockets.sockets.get(firstSid)) === null || _t === void 0 ? void 0 : _t.emit("opponentResults", {
                    roomId,
                    opponentElapsedMs: secondData.elapsedMs,
                    opponentAccuracy: secondData.accuracy,
                    opponentCorrect: secondData.correct,
                    opponentIncorrect: secondData.incorrect,
                    opponentIncomplete: secondData.incomplete,
                });
                roomEloResults.delete(roomId);
                console.log(`[CARS Ranked] Results sent for room ${roomId} (early ELO path)`);
            }
            else if (isCasual) {
                // Casual mode: no ELO changes — fetch profiles read-only for display
                const user1 = socketUser.get(entries[0][0]);
                const user2 = socketUser.get(entries[1][0]);
                let profiles = [];
                if (user1 && user2) {
                    const { data } = yield supabaseAdmin
                        .from("profiles")
                        .select("id, elo, display_name")
                        .in("id", [user1.userId, user2.userId]);
                    profiles = data !== null && data !== void 0 ? data : [];
                }
                for (const [sid, data] of entries) {
                    const opponentSid = entries.find(([s]) => s !== sid)[0];
                    const opponentData = entries.find(([s]) => s !== sid)[1];
                    const myUser = socketUser.get(sid);
                    const opUser = socketUser.get(opponentSid);
                    const myProfile = profiles.find((p) => p.id === (myUser === null || myUser === void 0 ? void 0 : myUser.userId));
                    const opProfile = profiles.find((p) => p.id === (opUser === null || opUser === void 0 ? void 0 : opUser.userId));
                    (_u = io.sockets.sockets.get(sid)) === null || _u === void 0 ? void 0 : _u.emit("resultsReady", {
                        roomId,
                        matchType: roomMatchType,
                        myElapsedMs: data.elapsedMs,
                        opponentElapsedMs: opponentData.elapsedMs,
                        myAccuracy: data.accuracy,
                        opponentAccuracy: opponentData.accuracy,
                        opponentCorrect: opponentData.correct,
                        opponentIncorrect: opponentData.incorrect,
                        opponentIncomplete: opponentData.incomplete,
                        myDisplayName: (_w = (_v = myProfile === null || myProfile === void 0 ? void 0 : myProfile.display_name) !== null && _v !== void 0 ? _v : myUser === null || myUser === void 0 ? void 0 : myUser.displayName) !== null && _w !== void 0 ? _w : "Unknown",
                        myOldElo: (_x = myProfile === null || myProfile === void 0 ? void 0 : myProfile.elo) !== null && _x !== void 0 ? _x : null,
                        myNewElo: (_y = myProfile === null || myProfile === void 0 ? void 0 : myProfile.elo) !== null && _y !== void 0 ? _y : null,
                        myRank: myProfile ? getRank(myProfile.elo) : null,
                        myNewRank: myProfile ? getRank(myProfile.elo) : null,
                        opponentDisplayName: (_0 = (_z = opProfile === null || opProfile === void 0 ? void 0 : opProfile.display_name) !== null && _z !== void 0 ? _z : opUser === null || opUser === void 0 ? void 0 : opUser.displayName) !== null && _0 !== void 0 ? _0 : "Unknown",
                        opponentOldElo: (_1 = opProfile === null || opProfile === void 0 ? void 0 : opProfile.elo) !== null && _1 !== void 0 ? _1 : null,
                        opponentNewElo: (_2 = opProfile === null || opProfile === void 0 ? void 0 : opProfile.elo) !== null && _2 !== void 0 ? _2 : null,
                        opponentRank: opProfile ? getRank(opProfile.elo) : null,
                        opponentNewRank: opProfile ? getRank(opProfile.elo) : null,
                    });
                }
                console.log(`[CARS Ranked] Casual results sent for room ${roomId} (no ELO change)`);
            }
            else {
                // Ranked: both finished, process ELO now
                const eloResults = yield processEloUpdate({ socketId: entries[0][0], data: entries[0][1] }, { socketId: entries[1][0], data: entries[1][1] });
                for (const [sid, data] of entries) {
                    const opponentSid = entries.find(([s]) => s !== sid)[0];
                    const opponentData = entries.find(([s]) => s !== sid)[1];
                    const myElo = eloResults === null || eloResults === void 0 ? void 0 : eloResults[sid];
                    const opElo = eloResults === null || eloResults === void 0 ? void 0 : eloResults[opponentSid];
                    (_3 = io.sockets.sockets.get(sid)) === null || _3 === void 0 ? void 0 : _3.emit("resultsReady", {
                        roomId,
                        matchType: roomMatchType,
                        myElapsedMs: data.elapsedMs,
                        opponentElapsedMs: opponentData.elapsedMs,
                        myAccuracy: data.accuracy,
                        opponentAccuracy: opponentData.accuracy,
                        opponentCorrect: opponentData.correct,
                        opponentIncorrect: opponentData.incorrect,
                        opponentIncomplete: opponentData.incomplete,
                        myDisplayName: (_6 = (_4 = myElo === null || myElo === void 0 ? void 0 : myElo.displayName) !== null && _4 !== void 0 ? _4 : (_5 = socketUser.get(sid)) === null || _5 === void 0 ? void 0 : _5.displayName) !== null && _6 !== void 0 ? _6 : "Unknown",
                        myOldElo: (_7 = myElo === null || myElo === void 0 ? void 0 : myElo.oldElo) !== null && _7 !== void 0 ? _7 : null,
                        myNewElo: (_8 = myElo === null || myElo === void 0 ? void 0 : myElo.newElo) !== null && _8 !== void 0 ? _8 : null,
                        myRank: (_9 = myElo === null || myElo === void 0 ? void 0 : myElo.rank) !== null && _9 !== void 0 ? _9 : null,
                        myNewRank: (_10 = myElo === null || myElo === void 0 ? void 0 : myElo.newRank) !== null && _10 !== void 0 ? _10 : null,
                        opponentDisplayName: (_13 = (_11 = opElo === null || opElo === void 0 ? void 0 : opElo.displayName) !== null && _11 !== void 0 ? _11 : (_12 = socketUser.get(opponentSid)) === null || _12 === void 0 ? void 0 : _12.displayName) !== null && _13 !== void 0 ? _13 : "Unknown",
                        opponentOldElo: (_14 = opElo === null || opElo === void 0 ? void 0 : opElo.oldElo) !== null && _14 !== void 0 ? _14 : null,
                        opponentNewElo: (_15 = opElo === null || opElo === void 0 ? void 0 : opElo.newElo) !== null && _15 !== void 0 ? _15 : null,
                        opponentRank: (_16 = opElo === null || opElo === void 0 ? void 0 : opElo.rank) !== null && _16 !== void 0 ? _16 : null,
                        opponentNewRank: (_17 = opElo === null || opElo === void 0 ? void 0 : opElo.newRank) !== null && _17 !== void 0 ? _17 : null,
                    });
                }
                console.log(`[CARS Ranked] Results + ELO sent for room ${roomId}`);
            }
        }
        else {
            // First player finished — check for 100% guaranteed win
            if (accuracy !== null && accuracy === 100 && !isCasual) {
                // Find opponent socket ID from the room
                const roomSockets = io.sockets.adapter.rooms.get(roomId);
                let opponentSid = null;
                if (roomSockets) {
                    for (const sid of roomSockets) {
                        if (sid !== socket.id) {
                            opponentSid = sid;
                            break;
                        }
                    }
                }
                if (opponentSid) {
                    // Compute ELO immediately — this player is the guaranteed winner
                    const eloResults = yield processEloGuaranteed(socket.id, opponentSid);
                    if (eloResults) {
                        roomEloResults.set(roomId, eloResults);
                        const myElo = eloResults[socket.id];
                        const opElo = eloResults[opponentSid];
                        // Send results to winner immediately (opponent data pending)
                        socket.emit("resultsReady", {
                            roomId,
                            matchType: roomMatchType,
                            myElapsedMs: elapsedMs,
                            opponentElapsedMs: -2, // -2 = opponent still playing
                            myAccuracy: accuracy,
                            opponentAccuracy: null,
                            opponentCorrect: null,
                            opponentIncorrect: null,
                            opponentIncomplete: null,
                            myDisplayName: (_20 = (_18 = myElo === null || myElo === void 0 ? void 0 : myElo.displayName) !== null && _18 !== void 0 ? _18 : (_19 = socketUser.get(socket.id)) === null || _19 === void 0 ? void 0 : _19.displayName) !== null && _20 !== void 0 ? _20 : "Unknown",
                            myOldElo: (_21 = myElo === null || myElo === void 0 ? void 0 : myElo.oldElo) !== null && _21 !== void 0 ? _21 : null,
                            myNewElo: (_22 = myElo === null || myElo === void 0 ? void 0 : myElo.newElo) !== null && _22 !== void 0 ? _22 : null,
                            myRank: (_23 = myElo === null || myElo === void 0 ? void 0 : myElo.rank) !== null && _23 !== void 0 ? _23 : null,
                            myNewRank: (_24 = myElo === null || myElo === void 0 ? void 0 : myElo.newRank) !== null && _24 !== void 0 ? _24 : null,
                            opponentDisplayName: (_27 = (_25 = opElo === null || opElo === void 0 ? void 0 : opElo.displayName) !== null && _25 !== void 0 ? _25 : (_26 = socketUser.get(opponentSid)) === null || _26 === void 0 ? void 0 : _26.displayName) !== null && _27 !== void 0 ? _27 : "Unknown",
                            opponentOldElo: (_28 = opElo === null || opElo === void 0 ? void 0 : opElo.oldElo) !== null && _28 !== void 0 ? _28 : null,
                            opponentNewElo: (_29 = opElo === null || opElo === void 0 ? void 0 : opElo.newElo) !== null && _29 !== void 0 ? _29 : null,
                            opponentRank: (_30 = opElo === null || opElo === void 0 ? void 0 : opElo.rank) !== null && _30 !== void 0 ? _30 : null,
                            opponentNewRank: (_31 = opElo === null || opElo === void 0 ? void 0 : opElo.newRank) !== null && _31 !== void 0 ? _31 : null,
                        });
                        console.log(`[CARS Ranked] 100% accuracy: immediate ELO for room ${roomId}`);
                    }
                }
            }
            else if (accuracy !== null && accuracy === 100 && isCasual) {
                // Casual 100%: send results immediately but with no ELO changes
                const roomSockets = io.sockets.adapter.rooms.get(roomId);
                let opponentSid = null;
                if (roomSockets) {
                    for (const sid of roomSockets) {
                        if (sid !== socket.id) {
                            opponentSid = sid;
                            break;
                        }
                    }
                }
                if (opponentSid) {
                    const myUser = socketUser.get(socket.id);
                    const opUser = socketUser.get(opponentSid);
                    let profiles = [];
                    if (myUser && opUser) {
                        const { data } = yield supabaseAdmin
                            .from("profiles")
                            .select("id, elo, display_name")
                            .in("id", [myUser.userId, opUser.userId]);
                        profiles = data !== null && data !== void 0 ? data : [];
                    }
                    const myProfile = profiles.find((p) => p.id === (myUser === null || myUser === void 0 ? void 0 : myUser.userId));
                    const opProfile = profiles.find((p) => p.id === (opUser === null || opUser === void 0 ? void 0 : opUser.userId));
                    socket.emit("resultsReady", {
                        roomId,
                        matchType: roomMatchType,
                        myElapsedMs: elapsedMs,
                        opponentElapsedMs: -2,
                        myAccuracy: accuracy,
                        opponentAccuracy: null,
                        opponentCorrect: null,
                        opponentIncorrect: null,
                        opponentIncomplete: null,
                        myDisplayName: (_33 = (_32 = myProfile === null || myProfile === void 0 ? void 0 : myProfile.display_name) !== null && _32 !== void 0 ? _32 : myUser === null || myUser === void 0 ? void 0 : myUser.displayName) !== null && _33 !== void 0 ? _33 : "Unknown",
                        myOldElo: (_34 = myProfile === null || myProfile === void 0 ? void 0 : myProfile.elo) !== null && _34 !== void 0 ? _34 : null,
                        myNewElo: (_35 = myProfile === null || myProfile === void 0 ? void 0 : myProfile.elo) !== null && _35 !== void 0 ? _35 : null,
                        myRank: myProfile ? getRank(myProfile.elo) : null,
                        myNewRank: myProfile ? getRank(myProfile.elo) : null,
                        opponentDisplayName: (_37 = (_36 = opProfile === null || opProfile === void 0 ? void 0 : opProfile.display_name) !== null && _36 !== void 0 ? _36 : opUser === null || opUser === void 0 ? void 0 : opUser.displayName) !== null && _37 !== void 0 ? _37 : "Unknown",
                        opponentOldElo: (_38 = opProfile === null || opProfile === void 0 ? void 0 : opProfile.elo) !== null && _38 !== void 0 ? _38 : null,
                        opponentNewElo: (_39 = opProfile === null || opProfile === void 0 ? void 0 : opProfile.elo) !== null && _39 !== void 0 ? _39 : null,
                        opponentRank: opProfile ? getRank(opProfile.elo) : null,
                        opponentNewRank: opProfile ? getRank(opProfile.elo) : null,
                    });
                    console.log(`[CARS Ranked] Casual 100% accuracy: immediate results for room ${roomId} (no ELO change)`);
                }
            }
            // Notify opponent that this player finished (no details revealed)
            socket.to(roomId).emit("playerFinished", { roomId });
            console.log(`[CARS Ranked] Notified opponent in room ${roomId} that a player finished`);
        }
    }));
    // Clean up on disconnect
    socket.on("disconnect", () => {
        console.log(`User disconnected: ${socket.id}`);
        const roomId = socketRoom.get(socket.id);
        socketRoom.delete(socket.id);
        socketUser.delete(socket.id);
        if (roomId) {
            // Cancel timeout if this socket was waiting
            const waitingEntry = waitingRooms.get(roomId);
            if (waitingEntry) {
                clearTimeout(waitingEntry.timeoutHandle);
            }
            waitingRooms.delete(roomId);
            const roomSize = getRoomSize(roomId);
            if (roomSize === 0) {
                roomPassages.delete(roomId);
                roomFinishTimes.delete(roomId);
                roomEloResults.delete(roomId);
                roomMatchTypes.delete(roomId);
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
        roomEloResults.forEach((_, rid) => {
            if (isEmpty(rid)) {
                roomEloResults.delete(rid);
            }
        });
        roomMatchTypes.forEach((_, rid) => {
            if (isEmpty(rid)) {
                roomMatchTypes.delete(rid);
            }
        });
    });
});
//# sourceMappingURL=app.js.map