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
const MATCHMAKE_TIMEOUT_MS = 30_000;
const ELO_RANGE = 15;

// Match types (ranked = ELO-filtered, casual = first-come-first-served)
type MatchType = "ranked" | "casual";

// Ranked matchmaking window configuration (mirrors cars-ranked/src/utils/rankedWindows.ts)
const RANKED_WINDOWS = [
	{ startHour: 10, endHour: 12 },
	{ startHour: 20, endHour: 22 },
] as const;
const RANKED_TIMEZONE = "America/Chicago";

// Returns the current hour in US Central Time (0-23), DST-safe
function getCTHour(): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: RANKED_TIMEZONE,
		hour: "numeric",
		hour12: false
	}).formatToParts(new Date());
	return parseInt(parts.find((p) => p.type === "hour")!.value, 10);
}

function isRankedWindowOpen(): boolean {
	const hour = getCTHour();
	return RANKED_WINDOWS.some((w) => hour >= w.startHour && hour < w.endHour);
}

// Generate random 5-char room code
const random = () =>
	crypto.randomBytes(20).toString("hex").slice(0, 5).toUpperCase();

// Store passage information per room
const roomPassages = new Map<
	string,
	{ passageId: string; frameIds: number[]; passageTitle?: string; passageHref?: string }
>();

// Rooms waiting for more players (roomId -> waiting player info for ELO filtering)
type WaitingEntry = {
	socketId: string;
	elo: number;
	matchType: MatchType;
	timeoutHandle: ReturnType<typeof setTimeout>;
};
const waitingRooms = new Map<string, WaitingEntry>();

// Track which socket is in which room (socketId -> roomId)
const socketRoom = new Map<string, string>();

// Player finish data (time + accuracy)
type PlayerFinishData = {
	elapsedMs: number;
	accuracy: number | null;
	correct: number | null;
	incorrect: number | null;
	incomplete: number | null;
};

// Track player finish data per room: roomId -> Map<socketId, PlayerFinishData>
const roomFinishTimes = new Map<string, Map<string, PlayerFinishData>>();

// Pre-computed ELO results for 100% guaranteed-win early finish
type EloResult = {
	displayName: string;
	oldElo: number;
	newElo: number;
	rank: string;
	newRank: string;
};
const roomEloResults = new Map<string, Record<string, EloResult>>();

// Track match type per room for ELO decision at finish time
const roomMatchTypes = new Map<string, MatchType>();

// Track socket -> authenticated user identity
const socketUser = new Map<string, { userId: string; displayName: string }>();

// Mutex: prevent concurrent matchmake processing for the same socket (async race guard)
const matchmakingInProgress = new Set<string>();

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

const RANK_FLOORS: Record<Rank, number> = {
	Caribbean: 472,
	Osteopathic: 486,
	Medical: 500,
	Ivy: 515,
};

function computeNewElo(currentElo: number, won: boolean): number {
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

async function processEloUpdate(
	player1: { socketId: string; data: PlayerFinishData },
	player2: { socketId: string; data: PlayerFinishData },
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

	// Determine winner: PRIMARY = higher accuracy, TIEBREAKER = faster time
	const acc1 = player1.data.accuracy ?? 0;
	const acc2 = player2.data.accuracy ?? 0;

	let p1Won = false;
	let p2Won = false;
	let isTie = false;

	if (acc1 > acc2) {
		p1Won = true;
	} else if (acc2 > acc1) {
		p2Won = true;
	} else {
		// Equal accuracy — tiebreak by time (lower is better)
		if (player1.data.elapsedMs < player2.data.elapsedMs) {
			p1Won = true;
		} else if (player2.data.elapsedMs < player1.data.elapsedMs) {
			p2Won = true;
		} else {
			isTie = true;
		}
	}

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

/**
 * Process ELO when winner is already known (100% guaranteed win).
 * Fetches profiles, computes ELO, updates DB.
 */
async function processEloGuaranteed(
	winnerSocketId: string,
	loserSocketId: string,
) {
	const winnerUser = socketUser.get(winnerSocketId);
	const loserUser = socketUser.get(loserSocketId);
	if (!winnerUser || !loserUser) return null;

	const { data: profiles, error } = await supabaseAdmin
		.from("profiles")
		.select("id, elo, display_name")
		.in("id", [winnerUser.userId, loserUser.userId]);

	if (error || !profiles || profiles.length < 2) return null;

	const winnerProfile = profiles.find((p) => p.id === winnerUser.userId)!;
	const loserProfile = profiles.find((p) => p.id === loserUser.userId)!;

	const newWinnerElo = computeNewElo(winnerProfile.elo, true);
	const newLoserElo = computeNewElo(loserProfile.elo, false);

	await Promise.all([
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
}, 60_000);

io.sockets.on("connection", (socket) => {
	console.log(`User connected: ${socket.id}`);

	// Clock synchronization: echo client's t0 + add server timestamp
	socket.on("clockSync", ({ t0 }: { t0: number }) => {
		socket.emit("clockSyncResponse", { t0, t1: Date.now() });
	});

	// Matchmaking: find an open room or create a new one
	socket.on("matchmake", async ({ userId, displayName, matchType = "ranked" }: { userId?: string; displayName?: string; matchType?: MatchType } = {}) => {
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

			// Reject ranked matchmaking outside window hours
			if (matchType === "ranked" && !isRankedWindowOpen()) {
				socket.emit("matchmakeRejected", { reason: "ranked_closed" });
				return;
			}

			// Fetch authoritative ELO from Supabase (tamper-proof)
			let playerElo = 472; // default
			if (userId) {
				try {
					const { data } = await supabaseAdmin
						.from("profiles")
						.select("elo")
						.eq("id", userId)
						.single();
					if (data?.elo != null) {
						playerElo = data.elo;
					}
				} catch (err) {
					console.warn(`[CARS Ranked] Failed to fetch ELO for ${userId}, using default:`, err);
				}
			}

			// Find compatible waiting room
			let assignedRoom: string | null = null;
			for (const [roomId, entry] of waitingRooms) {
				if (entry.matchType !== matchType) continue;
				// Never match a socket with itself
				if (entry.socketId === socket.id) continue;
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
				const waitingEntry = waitingRooms.get(assignedRoom)!;
				clearTimeout(waitingEntry.timeoutHandle);

				// Join existing room
				socket.join(assignedRoom);
				socketRoom.set(socket.id, assignedRoom);
				waitingRooms.delete(assignedRoom); // Room is now full

				console.log(
					`[CARS Ranked] Matchmake: ${socket.id} (ELO ${playerElo}) joined existing room ${assignedRoom} (host ELO ${waitingEntry.elo})`,
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
				roomMatchTypes.set(code, matchType);

				// Start timeout — if no match found within MATCHMAKE_TIMEOUT_MS, notify client
				const timeoutHandle = setTimeout(() => {
					socket.emit("matchmakeTimeout", { roomId: code });
					socket.leave(code);
					socketRoom.delete(socket.id);
					socketUser.delete(socket.id);
					waitingRooms.delete(code);
					console.log(
						`[CARS Ranked] Matchmake timeout: ${socket.id} in room ${code} after ${MATCHMAKE_TIMEOUT_MS}ms`,
					);
				}, MATCHMAKE_TIMEOUT_MS);

				waitingRooms.set(code, { socketId: socket.id, elo: playerElo, matchType, timeoutHandle });

				console.log(
					`[CARS Ranked] Matchmake: ${socket.id} (ELO ${playerElo}) created new room ${code}, waiting for opponent`,
				);

				socket.emit("waiting", { roomId: code });
			}
		} finally {
			matchmakingInProgress.delete(socket.id);
		}
	});

	// Cancel matchmaking
	socket.on("cancelMatchmake", () => {
		const roomId = socketRoom.get(socket.id);
		if (!roomId) return;

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

		console.log(
			`[CARS Ranked] Matchmake cancelled: ${socket.id} left room ${roomId}`,
		);

		socket.emit("matchmakeCancelled");
	});

	// Player finished the test
	socket.on("playerFinished", async ({
		roomId,
		elapsedMs,
		accuracy,
		correct,
		incorrect,
		incomplete,
	}: {
		roomId: string;
		elapsedMs: number;
		accuracy: number | null;
		correct: number | null;
		incorrect: number | null;
		incomplete: number | null;
	}) => {
		const actualRoom = socketRoom.get(socket.id);
		if (!actualRoom || actualRoom !== roomId) return;
		if (typeof elapsedMs !== "number" || elapsedMs <= 0) return;

		if (!roomFinishTimes.has(roomId)) {
			roomFinishTimes.set(roomId, new Map());
		}
		const finishMap = roomFinishTimes.get(roomId)!;

		// Prevent duplicate submissions
		if (finishMap.has(socket.id)) return;

		const playerData: PlayerFinishData = {
			elapsedMs,
			accuracy: accuracy ?? null,
			correct: correct ?? null,
			incorrect: incorrect ?? null,
			incomplete: incomplete ?? null,
		};
		finishMap.set(socket.id, playerData);
		console.log(`[CARS Ranked] Player ${socket.id} finished in room ${roomId}: ${elapsedMs}ms, accuracy=${accuracy}%`);

		const isCasual = roomMatchTypes.get(roomId) === "casual";
		const roomMatchType = roomMatchTypes.get(roomId) ?? "ranked";

		if (finishMap.size >= ROOM_MAX_CAPACITY) {
			// Both players finished
			const entries = Array.from(finishMap.entries());

			// Check if ELO was already processed (100% early finish case)
			const preComputedElo = roomEloResults.get(roomId);

			if (preComputedElo) {
				// ELO already computed for this room (first player got 100%)
				const secondSid = socket.id;
				const firstSid = entries.find(([s]) => s !== secondSid)![0];
				const secondData = finishMap.get(secondSid)!;
				const firstData = finishMap.get(firstSid)!;

				const secondElo = preComputedElo[secondSid];
				const firstElo = preComputedElo[firstSid];

				// Send full results to second player (the loser)
				io.sockets.sockets.get(secondSid)?.emit("resultsReady", {
					roomId,
					matchType: roomMatchType,
					myElapsedMs: secondData.elapsedMs,
					opponentElapsedMs: firstData.elapsedMs,
					myAccuracy: secondData.accuracy,
					opponentAccuracy: firstData.accuracy,
					opponentCorrect: firstData.correct,
					opponentIncorrect: firstData.incorrect,
					opponentIncomplete: firstData.incomplete,
					myDisplayName: secondElo?.displayName ?? socketUser.get(secondSid)?.displayName ?? "Unknown",
					myOldElo: secondElo?.oldElo ?? null,
					myNewElo: secondElo?.newElo ?? null,
					myRank: secondElo?.rank ?? null,
					myNewRank: secondElo?.newRank ?? null,
					opponentDisplayName: firstElo?.displayName ?? socketUser.get(firstSid)?.displayName ?? "Unknown",
					opponentOldElo: firstElo?.oldElo ?? null,
					opponentNewElo: firstElo?.newElo ?? null,
					opponentRank: firstElo?.rank ?? null,
					opponentNewRank: firstElo?.newRank ?? null,
				});

				// Send opponent data update to first player (the winner)
				io.sockets.sockets.get(firstSid)?.emit("opponentResults", {
					roomId,
					opponentElapsedMs: secondData.elapsedMs,
					opponentAccuracy: secondData.accuracy,
					opponentCorrect: secondData.correct,
					opponentIncorrect: secondData.incorrect,
					opponentIncomplete: secondData.incomplete,
				});

				roomEloResults.delete(roomId);
				console.log(`[CARS Ranked] Results sent for room ${roomId} (early ELO path)`);
			} else if (isCasual) {
				// Casual mode: no ELO changes — fetch profiles read-only for display
				const user1 = socketUser.get(entries[0][0]);
				const user2 = socketUser.get(entries[1][0]);
				let profiles: { id: string; elo: number; display_name: string }[] = [];
				if (user1 && user2) {
					const { data } = await supabaseAdmin
						.from("profiles")
						.select("id, elo, display_name")
						.in("id", [user1.userId, user2.userId]);
					profiles = data ?? [];
				}

				for (const [sid, data] of entries) {
					const opponentSid = entries.find(([s]) => s !== sid)![0];
					const opponentData = entries.find(([s]) => s !== sid)![1];
					const myUser = socketUser.get(sid);
					const opUser = socketUser.get(opponentSid);
					const myProfile = profiles.find((p) => p.id === myUser?.userId);
					const opProfile = profiles.find((p) => p.id === opUser?.userId);

					io.sockets.sockets.get(sid)?.emit("resultsReady", {
						roomId,
						matchType: roomMatchType,
						myElapsedMs: data.elapsedMs,
						opponentElapsedMs: opponentData.elapsedMs,
						myAccuracy: data.accuracy,
						opponentAccuracy: opponentData.accuracy,
						opponentCorrect: opponentData.correct,
						opponentIncorrect: opponentData.incorrect,
						opponentIncomplete: opponentData.incomplete,
						myDisplayName: myProfile?.display_name ?? myUser?.displayName ?? "Unknown",
						myOldElo: myProfile?.elo ?? null,
						myNewElo: myProfile?.elo ?? null,
						myRank: myProfile ? getRank(myProfile.elo) : null,
						myNewRank: myProfile ? getRank(myProfile.elo) : null,
						opponentDisplayName: opProfile?.display_name ?? opUser?.displayName ?? "Unknown",
						opponentOldElo: opProfile?.elo ?? null,
						opponentNewElo: opProfile?.elo ?? null,
						opponentRank: opProfile ? getRank(opProfile.elo) : null,
						opponentNewRank: opProfile ? getRank(opProfile.elo) : null,
					});
				}
				console.log(`[CARS Ranked] Casual results sent for room ${roomId} (no ELO change)`);
			} else {
				// Ranked: both finished, process ELO now
				const eloResults = await processEloUpdate(
					{ socketId: entries[0][0], data: entries[0][1] },
					{ socketId: entries[1][0], data: entries[1][1] },
				);

				for (const [sid, data] of entries) {
					const opponentSid = entries.find(([s]) => s !== sid)![0];
					const opponentData = entries.find(([s]) => s !== sid)![1];
					const myElo = eloResults?.[sid];
					const opElo = eloResults?.[opponentSid];

					io.sockets.sockets.get(sid)?.emit("resultsReady", {
						roomId,
						matchType: roomMatchType,
						myElapsedMs: data.elapsedMs,
						opponentElapsedMs: opponentData.elapsedMs,
						myAccuracy: data.accuracy,
						opponentAccuracy: opponentData.accuracy,
						opponentCorrect: opponentData.correct,
						opponentIncorrect: opponentData.incorrect,
						opponentIncomplete: opponentData.incomplete,
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
			}
		} else {
			// First player finished — check for 100% guaranteed win
			if (accuracy !== null && accuracy === 100 && !isCasual) {
				// Find opponent socket ID from the room
				const roomSockets = io.sockets.adapter.rooms.get(roomId);
				let opponentSid: string | null = null;
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
					const eloResults = await processEloGuaranteed(socket.id, opponentSid);

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
							myDisplayName: myElo?.displayName ?? socketUser.get(socket.id)?.displayName ?? "Unknown",
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
						console.log(`[CARS Ranked] 100% accuracy: immediate ELO for room ${roomId}`);
					}
				}
			} else if (accuracy !== null && accuracy === 100 && isCasual) {
				// Casual 100%: send results immediately but with no ELO changes
				const roomSockets = io.sockets.adapter.rooms.get(roomId);
				let opponentSid: string | null = null;
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
					let profiles: { id: string; elo: number; display_name: string }[] = [];
					if (myUser && opUser) {
						const { data } = await supabaseAdmin
							.from("profiles")
							.select("id, elo, display_name")
							.in("id", [myUser.userId, opUser.userId]);
						profiles = data ?? [];
					}
					const myProfile = profiles.find((p) => p.id === myUser?.userId);
					const opProfile = profiles.find((p) => p.id === opUser?.userId);

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
						myDisplayName: myProfile?.display_name ?? myUser?.displayName ?? "Unknown",
						myOldElo: myProfile?.elo ?? null,
						myNewElo: myProfile?.elo ?? null,
						myRank: myProfile ? getRank(myProfile.elo) : null,
						myNewRank: myProfile ? getRank(myProfile.elo) : null,
						opponentDisplayName: opProfile?.display_name ?? opUser?.displayName ?? "Unknown",
						opponentOldElo: opProfile?.elo ?? null,
						opponentNewElo: opProfile?.elo ?? null,
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
	});

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
