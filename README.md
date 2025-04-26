# Trade Worker

A Cloudflare Worker service for executing cryptocurrency trades across multiple exchanges. This worker accepts requests via a standardized `/process` endpoint from the `webhook-receiver`.

## Features

- Multi-exchange support (Binance, MEXC, Bybit).
- Secure authentication via shared internal key with `webhook-receiver`.
- Request/Response logging with D1 database integration (via `D1_WORKER_URL`).
- Leverage configuration.
- Position management (Long/Short positions).
- Error handling and logging.

## Prerequisites

- Node.js >= 16
- Bun (or npm/yarn)
- Wrangler CLI
- Cloudflare Workers account
- API keys for desired exchanges (MEXC, Binance, Bybit).

## Setup

1.  Install dependencies:
    ```bash
    bun install
    ```
2.  Set your Cloudflare account ID in `wrangler.toml`.
3.  Configure the `D1_WORKER_URL` in `wrangler.toml` (`vars` section) to point to your deployed D1 worker.
4.  Configure Secrets (via Cloudflare dashboard Secrets Store or `wrangler secret put`):
    - `WEBHOOK_INTERNAL_KEY`: The **shared** secret key used for authentication with the `webhook-receiver`. Bind this to `INTERNAL_KEY_BINDING` in `wrangler.toml`.
    - `MEXC_API_KEY`, `MEXC_API_SECRET`: If using MEXC. Bind to `MEXC_KEY_BINDING`, `MEXC_SECRET_BINDING`.
    - `BINANCE_API_KEY`, `BINANCE_API_SECRET`: If using Binance. Bind to `BINANCE_KEY_BINDING`, `BINANCE_SECRET_BINDING`.
    - `BYBIT_API_KEY`, `BYBIT_API_SECRET`: If using Bybit. Bind to `BYBIT_KEY_BINDING`, `BYBIT_SECRET_BINDING`.
5.  For local development, create a `.dev.vars` file and define the URLs and secrets:
    ```.dev.vars
    D1_WORKER_URL="http://localhost:<d1_worker_port>"
    # Mock secret bindings for local dev:
    INTERNAL_KEY_BINDING="your_shared_internal_secret"
    MEXC_KEY_BINDING="your_mexc_key"
    MEXC_SECRET_BINDING="your_mexc_secret"
    # ... (add other exchange keys/secrets as needed)
    ```

## Development

Run locally (e.g., on port 8788):

```bash
bun run dev --port 8788
```

Deploy:

```bash
bun run deploy
```

## API Interface

This worker **only** accepts requests from the `webhook-receiver` (or another authenticated internal service) on the `/process` endpoint.

- **Method:** `POST`
- **Endpoint:** `/process`
- **Content-Type:** `application/json`
- **Expected Request Body:**

  ```json
  {
    "requestId": "<uuid_from_receiver>",
    "internalAuthKey": "YOUR_INTERNAL_SHARED_SECRET", // Validated against INTERNAL_KEY_BINDING
    "payload": {
      // --- Trade-specific payload fields below ---
      "exchange": "binance", // Required (e.g., "mexc", "binance", "bybit")
      "action": "LONG", // Required (e.g., "LONG", "SHORT", "CLOSE_LONG", "CLOSE_SHORT")
      "symbol": "BTCUSDT", // Required (Exchange-specific symbol format)
      "quantity": 0.001, // Required (Positive number)
      "price": 65000, // Optional (for LIMIT orders)
      "orderType": "MARKET", // Optional (Defaults to "MARKET", use "LIMIT" with price)
      "leverage": 20 // Optional (Defaults to 20)
    }
  }
  ```

- **Response Format:**

  **Success:**

  ```json
  {
    "success": true,
    "result": {
      /* Exchange-specific order details from executeTrade */
    },
    "error": null
  }
  ```

  **Error:**

  ```json
  {
    "success": false,
    "result": null,
    "error": "<Error message describing the failure (e.g., Authentication failed, Invalid quantity, Trade execution failed: ...)>"
  }
  ```

## Exchange Clients

The worker includes dedicated client implementations for each supported exchange:

- `binance-client.js` - Binance Futures API integration
- `mexc-client.js` - MEXC Futures API integration
- `bybit-client.js` - Bybit Futures API integration

Each client handles exchange-specific API requirements, authentication, and trade execution.

## Database Logging

The worker logs incoming requests and outgoing responses (including errors) to a D1 database via the configured `D1_WORKER_URL`. The log includes the `requestId` from the incoming request.

## Security

- All requests _must_ be received on the `/process` endpoint.
- Requests _must_ include a valid `internalAuthKey` in the body, matching the `WEBHOOK_INTERNAL_KEY` secret.
- Exchange API keys/secrets are stored securely using Cloudflare Workers Secrets.
- Validates the trade parameters within the `payload`.

## Error Handling

The worker includes error handling for:

- Authentication failures
- Invalid request parameters
- Exchange API errors
- Network issues
- Database logging failures

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request
