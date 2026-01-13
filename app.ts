import crypto from "crypto";
import { instrument } from "@socket.io/admin-ui";
import { Server } from "socket.io";
import { App } from "uWebSockets.js";

import "dotenv/config";

const app = App();
const io = new Server({
	cors: {
		origin: true,
		credentials: true,
		methods: ["GET"],
	},
});
io.attachApp(app);

// create room ID
const random = () =>
	crypto.randomBytes(20).toString("hex").slice(0, 5).toUpperCase();

// Store passage information per room
const roomPassages = new Map<
	string,
	{ passageId: string; frameIds: number[]; passageTitle?: string }
>();

// Check if room has 0 users (true if 0)
function isEmpty(room: string) {
	return io.sockets.adapter.rooms.get(room)?.size ?? 0 === 0;
}

// Creates room code and ensures it is empty
app.get("/create", (res) => {
	let valid = false;
	let code = random();
	while (!valid) {
		if (isEmpty(code)) {
			valid = true;
			break;
		}
		code = random();
	}
	res.end(code);
});

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
				const { passageId, frameIds, passageTitle } = body;

				if (!passageId || !frameIds) {
					res.writeStatus("400 Bad Request");
					res.end(
						JSON.stringify({ error: "passageId and frameIds are required" }),
					);
					return;
				}

				roomPassages.set(roomId, { passageId, frameIds, passageTitle });
				console.log(
					`[CARS Ranked] Stored passage for room ${roomId}: ${passageId}${passageTitle ? ` (${passageTitle})` : ""}`,
				);

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

app.listen(3000, () => {
	console.log("listening on *:3000");
});

io.sockets.on("connection", (socket) => {
	console.log(`User connected: ${socket.id}`);

	// Convenience function to log server messages to the client
	function log(...messages: string[]) {
		const array = [">>> Message from server: "];
		for (let i = 0; i < messages.length; i++) {
			array.push(arguments[i]);
		}
		socket.emit("log", array);
	}

	// Joining and creating rooms
	socket.on("join", (room) => {
		const numClients = io.sockets.adapter.rooms.get(room)?.size ?? 0;

		log("Room " + room + " has " + numClients + " client(s)");
		log("Request to create or join room " + room);

		if (numClients > 1) {
			socket.emit("full", room);
		}

		// only one room allowed per socket
		for (room in socket.rooms) {
			if (socket.id !== room) socket.leave(room);
		}

		if (numClients === 0) {
			socket.join(room);
			socket.emit("created", room);
		} else if (numClients === 1) {
			io.sockets.in(room).emit("join", room); // broadcast within room
			socket.join(room);
			socket.emit("joined", room);
		}
		socket.emit("emit(): client " + socket.id + " joined room " + room);
	});

	// Clean up passage info when room is empty
	socket.on("disconnect", () => {
		console.log(`User disconnected: ${socket.id}`);

		// Check all rooms and clean up empty ones
		roomPassages.forEach((value, roomId) => {
			if (isEmpty(roomId)) {
				roomPassages.delete(roomId);
				console.log(
					`[CARS Ranked] Cleaned up passage for empty room ${roomId}`,
				);
			}
		});
	});
});
