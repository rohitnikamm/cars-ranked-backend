import { App, HttpResponse } from "uWebSockets.js";
import { Server } from "socket.io";
import crypto from "crypto";
import "./instrument";

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
	crypto.randomBytes(20).toString("hex").slice(0, 5).toUpperCase;

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

app.post("/t", async (res) => {
	try {
		res.onAborted(() => {
			res.aborted = true;
		});

		// Allow CORS access to server
		res.writeHeader("Access-Control-Allow-Origin", "*");
		res.writeHeader("Access-Control-Allow-Methods", "OPTIONS, POST");
		res.writeHeader(
			"Access-Control-Allow-Headers",
			"origin, content-type, accept, x-requested-with",
		);
		res.writeHeader("Access-Control-Max-Age", "3600");

		// Store req as envelope
		const envelope = await readJson(res);

		// Build Sentry URL and headers
		const host = process.env.SENTRY_HOST; // domain
		const projectId = process.env.SENTRY_PROJECT_ID;
		const url = `https://${host}/api/${projectId}/envelope/?sentry_key=${process.env.SENTRY_KEY}`;

		const options = {
			headers: {
				"Content-Type": "application/x-sentry-envelope",
			},
		};

		// Send response to Sentry
		const response = await fetch(url, {
			method: "POST",
			headers: options.headers,
			body: envelope
		});

		// Read Sentry response (ex: OK)
		const resData = await response.text();

		// Respond to client
		res.writeStatus("201");
		res.end(JSON.stringify({ message: "Success", data: resData }));
	} catch (error) {
		if (!res.aborted) res.writeStatus("404 Bad Request");
		res.end(JSON.stringify({ message: "invalid request", error }));
	}
});
