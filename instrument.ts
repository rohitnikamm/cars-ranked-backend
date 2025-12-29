import * as Sentry from "@sentry/node";
import * as dotenv from "dotenv";

dotenv.config();
Sentry.init({
	dsn: process.env.SENTRY_DSN,

	// Tracing
	tracesSampleRate: 1.0, // capture all transactions
	enableLogs: true,
	sendDefaultPii: true,
});
