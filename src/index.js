// trade-worker/src/index.js - Processes trading requests, expects standardized input via /process endpoint.
import { MexcClient } from "./mexc-client.js";
import { BinanceClient } from "./binance-client.js";
import { BybitClient } from "./bybit-client.js";
import { DbLogger } from "./db-logger.js";

// Standard endpoint path
const PROCESS_ENDPOINT = "/process";

export default {
	async fetch(request, env) {
		// Basic routing: only handle the /process endpoint
		const url = new URL(request.url);
		if (url.pathname === PROCESS_ENDPOINT && request.method === "POST") {
			return await handleProcessRequest(request, env);
		}
		// Return 404 for other paths/methods
		return new Response("Not Found", { status: 404 });
	},
};

// Define SecretBinding structure for clarity (not enforced in JS)
/**
 * @typedef {object} SecretBinding
 * @property {() => Promise<string | null>} get
 */

// Update Env JSDoc to include optional mocks
/**
 * @typedef {object} Env
 * @property {string} [D1_WORKER_URL] // For DbLogger
 * @property {SecretBinding} [INTERNAL_KEY_BINDING] // For internal auth (expects WEBHOOK_INTERNAL_KEY)
 * @property {SecretBinding} [MEXC_KEY_BINDING]
 * @property {SecretBinding} [MEXC_SECRET_BINDING]
 * @property {SecretBinding} [BINANCE_KEY_BINDING]
 * @property {SecretBinding} [BINANCE_SECRET_BINDING]
 * @property {SecretBinding} [BYBIT_KEY_BINDING]
 * @property {SecretBinding} [BYBIT_SECRET_BINDING]
 * @property {object} [__mocks__] Optional property for test mocks
 * @property {typeof MexcClient} [__mocks__.MexcClient]
 * @property {typeof BinanceClient} [__mocks__.BinanceClient]
 * @property {typeof BybitClient} [__mocks__.BybitClient]
 * @property {typeof DbLogger} [__mocks__.DbLogger]
 */

// Add validation functions
/**
 * @param {string} exchange
 * @param {Env} env
 * @returns {Promise<boolean>}
 */
async function validateApiCredentials(exchange, env) {
	// Helper to check if both key and secret bindings seem configured
	/**
	 * @param {SecretBinding | undefined} keyBinding
	 * @param {SecretBinding | undefined} secretBinding
	 * @returns {Promise<boolean>}
	 */
	const checkBinding = async (keyBinding, secretBinding) => {
		if (!keyBinding || !secretBinding) return false;
		// Check if *getting* the secrets works (returns non-null).
		const key = await keyBinding.get();
		const secret = await secretBinding.get();
		return key !== null && secret !== null;
	};

	switch (exchange.toLowerCase()) {
		case "mexc":
			return await checkBinding(env.MEXC_KEY_BINDING, env.MEXC_SECRET_BINDING);
		case "binance":
			return await checkBinding(
				env.BINANCE_KEY_BINDING,
				env.BINANCE_SECRET_BINDING
			);
		case "bybit":
			return await checkBinding(
				env.BYBIT_KEY_BINDING,
				env.BYBIT_SECRET_BINDING
			);
		default:
			return false;
	}
}

/**
 * Validates the trade-specific payload.
 * @param {object} payload The nested payload object from the standardized request.
 * @returns {{isValid: boolean, error?: string}}
 */
async function validateTradePayload(payload) {
	const { exchange, action, symbol, quantity } = payload;

	if (!exchange || !action || !symbol || !quantity) {
		return { isValid: false, error: "Missing required fields in payload" };
	}

	// Validate action
	const validActions = ["LONG", "SHORT", "CLOSE_LONG", "CLOSE_SHORT"]; // Keep using existing action names
	if (!validActions.includes(action.toUpperCase())) {
		return { isValid: false, error: `Invalid action in payload: ${action}` };
	}

	// Validate quantity
	if (isNaN(quantity) || quantity <= 0) {
		return { isValid: false, error: "Invalid quantity in payload" };
	}

	return { isValid: true };
}

async function testApiConnection(client) {
	try {
		// Try to get account info as a test
		await client.getAccountInfo();
		return true;
	} catch (error) {
		console.error("API connection test failed:", error);
		return false;
	}
}

/**
 * Handles the standardized processing request.
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function handleProcessRequest(request, env) {
	const startTime = Date.now();
	// Use provided mock DbLogger if available, otherwise create real one
	const DbLoggerClass = env.__mocks__?.DbLogger || DbLogger;
	const dbLogger = new DbLoggerClass(env);
	let dbLogId = null; // Renamed from requestId to avoid clash with incoming requestId
	let incomingRequestId = null;

	try {
		// --- Parse and Authenticate Standardized Request --- 
		const data = await request.json();
		incomingRequestId = data?.requestId; // Get request ID from body
		const internalAuthKey = data?.internalAuthKey; // Get auth key from body

		console.log(`Processing request ID: ${incomingRequestId}`);
		console.log("Received standardized request:", JSON.stringify(data, null, 2));

		const expectedInternalKey = await env.INTERNAL_KEY_BINDING?.get();

		if (!expectedInternalKey) {
			console.error("INTERNAL_KEY_BINDING binding not configured or accessible.");
			const response = new Response(
				JSON.stringify({ success: false, error: "Service configuration error", result: null }),
				{ status: 500, headers: { "Content-Type": "application/json" } }
			);
			// Log even config errors if possible
			dbLogId = await dbLogger.logRequest(request, data, incomingRequestId); // Pass ID if available
			await dbLogger.logResponse(dbLogId, response, null, startTime);
			return response;
		}

		if (!internalAuthKey || internalAuthKey !== expectedInternalKey) {
			console.warn(`Authentication failed for request ID: ${incomingRequestId}`);
			const response = new Response(
				JSON.stringify({ success: false, error: "Authentication failed", result: null }),
				{ status: 403, headers: { "Content-Type": "application/json" } }
			);
			dbLogId = await dbLogger.logRequest(request, data, incomingRequestId);
			await dbLogger.logResponse(dbLogId, response, null, startTime);
			return response;
		}

		// --- Process Trade Payload --- 

		// Log the request to database *after* auth succeeds
		dbLogId = await dbLogger.logRequest(request, data, incomingRequestId); // Pass incomingRequestId

		const payload = data?.payload; // Extract the nested payload

		if (!payload) {
			const response = new Response(
				JSON.stringify({ success: false, error: "Missing payload in request", result: null }),
				{ status: 400, headers: { "Content-Type": "application/json" } }
			);
			await dbLogger.logResponse(dbLogId, response, null, startTime);
			return response;
		}

		// Validate the trade-specific payload
		const validation = await validateTradePayload(payload);
		if (!validation.isValid) {
			const response = new Response(
				JSON.stringify({ success: false, error: validation.error, result: null }),
				{ status: 400, headers: { "Content-Type": "application/json" } }
			);
			await dbLogger.logResponse(dbLogId, response, null, startTime);
			return response;
		}

		const {
			exchange,
			action,
			symbol,
			quantity,
			price,
			orderType = "MARKET", // Defaults from payload if provided, else hardcoded
			leverage = 20,
		} = payload; // Destructure from payload

		// Validate API credentials are *configured*
		if (!(await validateApiCredentials(exchange, env))) {
			const errorMsg = `API secret bindings not configured or accessible for ${exchange}`;
			console.error(errorMsg);
			const response = new Response(
				JSON.stringify({ success: false, error: errorMsg, result: null }),
				{ status: 400, headers: { "Content-Type": "application/json" } }
			);
			await dbLogger.logResponse(dbLogId, response, null, startTime);
			return response;
		}

		// Get actual secrets for client initialization
		let apiKey = null;
		let apiSecret = null;

		switch (exchange.toLowerCase()) {
			case "mexc": {
				// Use optional chaining and nullish coalescing, though validate passed
				apiKey = (await env.MEXC_KEY_BINDING?.get()) ?? null;
				apiSecret = (await env.MEXC_SECRET_BINDING?.get()) ?? null;
				break;
			}
			case "binance": {
				apiKey = (await env.BINANCE_KEY_BINDING?.get()) ?? null;
				apiSecret = (await env.BINANCE_SECRET_BINDING?.get()) ?? null;
				break;
			}
			case "bybit": {
				apiKey = (await env.BYBIT_KEY_BINDING?.get()) ?? null;
				apiSecret = (await env.BYBIT_SECRET_BINDING?.get()) ?? null;
				break;
			}
			default: {
				// but handle defensively.
				// This case should ideally not be reached if validateRequest is comprehensive
				const response = new Response(
					JSON.stringify({ success: false, error: "Unsupported exchange", result: null }),
					{ status: 400, headers: { "Content-Type": "application/json" } }
				);
				await dbLogger.logResponse(dbLogId, response, null, startTime);
				return response;
			}
		}

		if (!apiKey || !apiSecret) {
			const errorMsg = `Failed to retrieve API credentials for ${exchange} from Secrets Store.`;
			console.error(errorMsg);
			const response = new Response(
				JSON.stringify({ success: false, error: errorMsg, result: null }),
				{ status: 500, headers: { "Content-Type": "application/json" } }
			);
			if (dbLogId) { // Check if dbLogId was set
				await dbLogger.logResponse(dbLogId, response, null, startTime);
			}
			return response;
		}

		// Initialize the appropriate exchange client
		let client;
		switch (exchange.toLowerCase()) {
			case "mexc": {
				const MexcClientClass = env.__mocks__?.MexcClient || MexcClient;
				client = new MexcClientClass(apiKey, apiSecret);
				break;
			}
			case "binance": {
				const BinanceClientClass =
					env.__mocks__?.BinanceClient || BinanceClient;
				client = new BinanceClientClass(apiKey, apiSecret);
				break;
			}
			case "bybit": {
				const BybitClientClass = env.__mocks__?.BybitClient || BybitClient;
				client = new BybitClientClass(apiKey, apiSecret);
				break;
			}
			// No default needed here as exchange was validated earlier
		}

		// Test API connection using the (potentially mocked) client
		if (!(await testApiConnection(client))) {
			const response = new Response(
				JSON.stringify({
					success: false,
					error: "Failed to connect to exchange API",
					result: null,
				}),
				{ status: 500, headers: { "Content-Type": "application/json" } }
			);
			await dbLogger.logResponse(dbLogId, response, null, startTime);
			return response;
		}

		// --- Execute Trade --- 
		let tradeResult;
		try {
			tradeResult = await client.executeTrade({
				action,
				symbol,
				quantity,
				orderType,
				price, // Pass price if available
				leverage,
			});
			console.log(`Trade execution result for ${incomingRequestId}:`, tradeResult);

			// --- Return Standardized Success Response --- 
			const successResponse = new Response(
				JSON.stringify({
					success: true,
					result: tradeResult,
					error: null,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
			await dbLogger.logResponse(dbLogId, successResponse, tradeResult, startTime);
			return successResponse;

		} catch (tradeError) {
			console.error(`Trade execution failed for ${incomingRequestId}:`, tradeError);
			// --- Return Standardized Error Response (Trade Execution Error) --- 
			const tradeErrorResponse = new Response(
				JSON.stringify({
					success: false,
					error: `Trade execution failed: ${tradeError.message}`,
					result: null,
				}),
				// Use 500 or maybe 422 (Unprocessable Entity) depending on error type
				{ status: 500, headers: { "Content-Type": "application/json" } }
			);
			await dbLogger.logResponse(dbLogId, tradeErrorResponse, null, startTime, tradeError);
			return tradeErrorResponse;
		}

	} catch (error) {
		// --- Catch All / Unexpected Errors --- 
		console.error(`Unexpected error processing request ${incomingRequestId}:`, error);
		const unexpectedErrorResponse = new Response(
			JSON.stringify({
				success: false,
				error: "Internal server error",
				result: null,
			}),
			{ status: 500, headers: { "Content-Type": "application/json" } }
		);
		// Log if dbLogId was obtained before the error
		if (dbLogId) {
			await dbLogger.logResponse(dbLogId, unexpectedErrorResponse, null, startTime, error);
		}
		return unexpectedErrorResponse;
	}
}
