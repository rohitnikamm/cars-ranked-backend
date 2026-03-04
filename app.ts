import crypto from "crypto";
import { instrument } from "@socket.io/admin-ui";
import { createClient } from "@supabase/supabase-js";
import { Server } from "socket.io";
import { App } from "uWebSockets.js";

import "dotenv/config";

// Supabase admin client (service role — bypasses RLS)
const supabaseAdmin = createClient(
	process.env.SUPABASE_URL as string,
	process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

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

// Generate random 5-char room code
const random = () =>
	crypto.randomBytes(20).toString("hex").slice(0, 5).toUpperCase();

// Store passage information per room
const roomPassages = new Map<
	string,
	{ passageId: string; frameIds: number[]; passageTitle?: string; passageHref?: string }
>();

// Rooms waiting for more players
const waitingRooms = new Set<string>();

// Track which socket is in which room (socketId -> roomId)
const socketRoom = new Map<string, string>();

// Track player finish times per room: roomId -> Map<socketId, elapsedMs>
const roomFinishTimes = new Map<string, Map<string, number>>();

// Track socket -> authenticated user identity
const socketUser = new Map<string, { userId: string; displayName: string }>();

// ELO system
type Rank = "Caribbean" | "Osteopathic" | "Medical" | "Ivy";

function getRank(elo: number): Rank {
	if (elo <= 485) return "Caribbean";
	if (elo <= 499) return "Osteopathic";
	if (elo <= 514) return "Medical";
	return "Ivy";
}

const ELO_DELTAS: Record<Rank, { win: number; loss: number }> = {
	Caribbean: { win: 5, loss: -1 },
	Osteopathic: { win: 3, loss: -2 },
	Medical: { win: 2, loss: -3 },
	Ivy: { win: 1, loss: -5 },
};

function computeNewElo(currentElo: number, won: boolean): number {
	const rank = getRank(currentElo);
	const delta = won ? ELO_DELTAS[rank].win : ELO_DELTAS[rank].loss;
	return Math.max(472, Math.min(528, currentElo + delta));
}

async function processEloUpdate(
	player1: { socketId: string; elapsedMs: number },
	player2: { socketId: string; elapsedMs: number },
) {
	const user1 = socketUser.get(player1.socketId);
	const user2 = socketUser.get(player2.socketId);
	if (!user1 || !user2) return null;

	const { data: profiles, error } = await supabaseAdmin
		.from("profiles")
		.select("id, elo, display_name")
		.in("id", [user1.userId, user2.userId]);

	if (error || !profiles || profiles.length < 2) return null;

	const profile1 = profiles.find((p) => p.id === user1.userId)!;
	const profile2 = profiles.find((p) => p.id === user2.userId)!;

	// Determine winner (lower elapsed time wins; both must be positive)
	const p1Won =
		player1.elapsedMs > 0 &&
		(player2.elapsedMs < 0 || player1.elapsedMs < player2.elapsedMs);
	const p2Won =
		player2.elapsedMs > 0 &&
		(player1.elapsedMs < 0 || player2.elapsedMs < player1.elapsedMs);
	const isTie = !p1Won && !p2Won && player1.elapsedMs > 0 && player2.elapsedMs > 0;

	const newElo1 = isTie ? profile1.elo : computeNewElo(profile1.elo, p1Won);
	const newElo2 = isTie ? profile2.elo : computeNewElo(profile2.elo, p2Won);

	await Promise.all([
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
}

// Check if room has 0 users (true if 0)
function isEmpty(room: string) {
	return (io.sockets.adapter.rooms.get(room)?.size ?? 0) === 0;
}

function getRoomSize(room: string) {
	return io.sockets.adapter.rooms.get(room)?.size ?? 0;
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
					res.end(
						JSON.stringify({ error: "passageId and frameIds are required" }),
					);
					return;
				}

				roomPassages.set(roomId, { passageId, frameIds, passageTitle, passageHref });
				console.log(
					`[CARS Ranked] Stored passage for room ${roomId}: ${passageId}${passageTitle ? ` (${passageTitle})` : ""}`,
				);

				// Notify all sockets in the room that passage is ready
				io.sockets
					.in(roomId)
					.emit("passageReady", { roomId, passageId, frameIds, passageTitle, passageHref });

				res.writeStatus("200 OK");
				res.writeHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ success: true }));
			} catch (error) {
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

	console.log(
		`[CARS Ranked] Retrieved passage for room ${roomId}: ${passageInfo.passageId}`,
	);
	res.writeStatus("200 OK");
	res.writeHeader("Content-Type", "application/json");
	res.end(JSON.stringify(passageInfo));
});

// Admin dashboard for Socket.io
instrument(io, {
	auth: {
		type: "basic",
		username: "admin",
		password: process.env.ADMIN_PASSWORD as string,
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
			cleaned++;
		}
	}
	for (const roomId of waitingRooms) {
		if (isEmpty(roomId)) {
			waitingRooms.delete(roomId);
			cleaned++;
		}
	}
	if (cleaned > 0) {
		console.log(`[CARS Ranked] Periodic cleanup: removed ${cleaned} stale entries`);
	}
}, 60_000);

io.sockets.on("connection", (socket) => {
	console.log(`User connected: ${socket.id}`);

	// Clock synchronization: echo client's t0 + add server timestamp
	socket.on("clockSync", ({ t0 }: { t0: number }) => {
		socket.emit("clockSyncResponse", { t0, t1: Date.now() });
	});

	// Matchmaking: find an open room or create a new one
	socket.on("matchmake", ({ userId, displayName }: { userId?: string; displayName?: string } = {}) => {
		if (userId && displayName) {
			socketUser.set(socket.id, { userId, displayName });
		}
		// Prevent double-matchmaking
		if (socketRoom.has(socket.id)) {
			socket.emit("error", { message: "Already in matchmaking" });
			return;
		}

		// Find first available waiting room
		let assignedRoom: string | null = null;
		for (const roomId of waitingRooms) {
			const roomSize = getRoomSize(roomId);
			if (roomSize > 0 && roomSize < ROOM_MAX_CAPACITY) {
				assignedRoom = roomId;
				break;
			} else if (roomSize === 0) {
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

			console.log(
				`[CARS Ranked] Matchmake: ${socket.id} joined existing room ${assignedRoom}`,
			);

			// Notify both players with same absolute countdown target
			const countdownEndAt = Date.now() + COUNTDOWN_MS;
			socket.emit("matched", { roomId: assignedRoom, role: "guest", countdownEndAt });
			socket
				.to(assignedRoom)
				.emit("matched", { roomId: assignedRoom, role: "host", countdownEndAt });
		} else {
			// Create new room
			let code = random();
			while (!isEmpty(code)) {
				code = random();
			}

			socket.join(code);
			socketRoom.set(socket.id, code);
			waitingRooms.add(code);

			console.log(
				`[CARS Ranked] Matchmake: ${socket.id} created new room ${code}, waiting for opponent`,
			);

			socket.emit("waiting", { roomId: code });
		}
	});

	// Cancel matchmaking
	socket.on("cancelMatchmake", () => {
		const roomId = socketRoom.get(socket.id);
		if (!roomId) return;

		const roomSize = getRoomSize(roomId);

		socket.leave(roomId);
		socketRoom.delete(socket.id);
		socketUser.delete(socket.id);
		waitingRooms.delete(roomId);
		roomPassages.delete(roomId);
		roomFinishTimes.delete(roomId);

		// If someone else was in the room (rare race), notify them
		if (roomSize > 1) {
			io.sockets.in(roomId).emit("partnerLeft", { roomId });
		}

		console.log(
			`[CARS Ranked] Matchmake cancelled: ${socket.id} left room ${roomId}`,
		);

		socket.emit("matchmakeCancelled");
	});

	// Player finished the test
	socket.on("playerFinished", async ({ roomId, elapsedMs }: { roomId: string; elapsedMs: number }) => {
		const actualRoom = socketRoom.get(socket.id);
		if (!actualRoom || actualRoom !== roomId) return;
		if (typeof elapsedMs !== "number" || elapsedMs <= 0) return;

		if (!roomFinishTimes.has(roomId)) {
			roomFinishTimes.set(roomId, new Map());
		}
		const finishMap = roomFinishTimes.get(roomId)!;

		// Prevent duplicate submissions
		if (finishMap.has(socket.id)) return;

		finishMap.set(socket.id, elapsedMs);
		console.log(`[CARS Ranked] Player ${socket.id} finished in room ${roomId}: ${elapsedMs}ms`);

		if (finishMap.size >= ROOM_MAX_CAPACITY) {
			// Both players finished — process ELO and send results
			const entries = Array.from(finishMap.entries());

			const eloResults = await processEloUpdate(
				{ socketId: entries[0][0], elapsedMs: entries[0][1] },
				{ socketId: entries[1][0], elapsedMs: entries[1][1] },
			);

			for (const [sid, time] of entries) {
				const opponentSid = entries.find(([s]) => s !== sid)![0];
				const opponentTime = entries.find(([s]) => s !== sid)?.[1] ?? 0;
				const myElo = eloResults?.[sid];
				const opElo = eloResults?.[opponentSid];

				io.sockets.sockets.get(sid)?.emit("resultsReady", {
					roomId,
					myElapsedMs: time,
					opponentElapsedMs: opponentTime,
					myDisplayName: myElo?.displayName ?? socketUser.get(sid)?.displayName ?? "Unknown",
					myOldElo: myElo?.oldElo ?? null,
					myNewElo: myElo?.newElo ?? null,
					myRank: myElo?.rank ?? null,
					myNewRank: myElo?.newRank ?? null,
					opponentDisplayName: opElo?.displayName ?? socketUser.get(opponentSid)?.displayName ?? "Unknown",
					opponentOldElo: opElo?.oldElo ?? null,
					opponentNewElo: opElo?.newElo ?? null,
					opponentRank: opElo?.rank ?? null,
					opponentNewRank: opElo?.newRank ?? null,
				});
			}
			console.log(`[CARS Ranked] Results + ELO sent for room ${roomId}`);
		} else {
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
		socketUser.delete(socket.id);

		if (roomId) {
			waitingRooms.delete(roomId);

			const roomSize = getRoomSize(roomId);
			if (roomSize === 0) {
				roomPassages.delete(roomId);
				roomFinishTimes.delete(roomId);
				console.log(`[CARS Ranked] Cleaned up empty room ${roomId}`);
			} else if (roomSize < ROOM_MAX_CAPACITY) {
				// Partner left — notify remaining players
				io.sockets.in(roomId).emit("partnerLeft", { roomId });
				console.log(
					`[CARS Ranked] Partner left room ${roomId}, notified remaining players`,
				);
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
