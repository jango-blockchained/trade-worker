# Trade Worker

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Edge%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/) [![Build Status](https://img.shields.io/badge/Build-TODO-lightgrey?style=for-the-badge)](https://github.com/jango-blockchained/hoox-cf-edge-worker/actions) <!-- TODO: Update Build Status link -->

**[Main Repository](https://github.com/jango-blockchained/hoox-cf-edge-worker)** <!-- TODO: Update Main Repo link -->

A Cloudflare Worker service for executing cryptocurrency trades, logging signals, and potentially leveraging AI/RAG for strategy analysis. This worker interacts directly with exchange APIs, D1, R2, and potentially AI services.

## Features

- Multi-exchange support (e.g., Binance, MEXC, Bybit - depending on implemented clients).
- Secure authentication for internal requests via shared key (`INTERNAL_KEY_BINDING`).
- Direct D1 database integration for storing trade signals, history, etc. (`DB` binding).
- Direct R2 integration for storing reports or logs (`REPORTS_BUCKET` binding).
- Optional Workers AI / Vectorize integration for RAG or strategy analysis (`AI`, `VECTORIZE_INDEX` bindings).
- Position management.
- Error handling and logging.

## Prerequisites

- Node.js >= 16
- Bun
- Wrangler CLI
- Cloudflare Workers account
- Cloudflare D1 Database access
- Cloudflare R2 access
- API keys for desired exchanges.

## Setup

1.  Install dependencies:
    ```bash
    bun install
    ```
2.  Set your Cloudflare account ID in `wrangler.jsonc`.
3.  Create necessary D1 database(s) and R2 bucket(s):
    ```bash
    # Example D1 database for trade data
    npx wrangler d1 create trade-data-db
    # Example R2 bucket for reports
    npx wrangler r2 bucket create trade-reports
    # Example Vectorize index (if using RAG)
    # npx wrangler vectorize create trade-strategy-index --dimensions=768 --metric=cosine
    ```
4.  Apply D1 schema(s):
    ```bash
    # Assuming schema.sql exists in this worker directory
    npx wrangler d1 execute trade-data-db --file=./schema.sql
    ```
5.  Configure Secrets (via Cloudflare dashboard or `wrangler secret put`):
    - `INTERNAL_KEY_BINDING`: The **shared** secret key for internal authentication.
    - `MEXC_API_KEY`, `MEXC_API_SECRET`: If using MEXC.
    - `BINANCE_API_KEY`, `BINANCE_API_SECRET`: If using Binance.
    - `BYBIT_API_KEY`, `BYBIT_API_SECRET`: If using Bybit.
    - _(Add any other required secrets, e.g., for external AI providers)_.
6.  Update `wrangler.jsonc` with all necessary bindings (D1, R2, KV, Secrets, AI, Vectorize). Example:
    ```jsonc
    {
      "name": "trade-worker",
      "main": "src/index.ts",
      "compatibility_date": "2025-03-07",
      "compatibility_flags": ["nodejs_compat"],
      "account_id": "YOUR_CLOUDFLARE_ACCOUNT_ID",
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "trade-data-db",
          "database_id": "<YOUR_D1_DB_ID>"
        }
      ],
      "r2_buckets": [
        { "binding": "REPORTS_BUCKET", "bucket_name": "trade-reports" }
      ],
      "kv_namespaces": [
        // Example: If using KV for config/state
        { "binding": "CONFIG_KV", "id": "...", "preview_id": "..." }
      ],
      "vectorize": [
        // Example: If using RAG
        // { "binding": "VECTORIZE_INDEX", "index_name": "trade-strategy-index" }
      ],
      "ai": {
        // Example: If using Workers AI
        // "binding": "AI"
      },
      "secrets": [
        "INTERNAL_KEY_BINDING",
        "MEXC_API_KEY", "MEXC_API_SECRET",
        "BINANCE_API_KEY", "BINANCE_API_SECRET",
        "BYBIT_API_KEY", "BYBIT_API_SECRET"
        // Add other secrets
      ],
      "observability": {
         "enabled": true,
         "head_sampling_rate": 1
       }
    }
    ```
7.  Update the corresponding `worker-configuration.d.ts` file.
8.  For local development, create a `.dev.vars` file and define secrets/variables:
    ```.dev.vars
    # Mock secret bindings for local dev:
    INTERNAL_KEY_BINDING="your_shared_internal_secret"
    MEXC_API_KEY="your_mexc_key"
    MEXC_API_SECRET="your_mexc_secret"
    # ... (add other exchange keys/secrets as needed)
    # Add mock bindings for D1, R2, KV etc. if needed locally
    ```
    *Note: Use `wrangler d1 execute ... --local` and `wrangler dev --local` for local D1.* 

## Development

Run locally:

```bash
# If using local D1, ensure schema is applied locally first
bun run dev --local # Add --local if using local D1
```

Deploy:

```bash
bun run deploy
```

## API Interface

This worker primarily exposes two types of endpoints:

### 1. Internal Processing Endpoint (`/process`)

Accepts requests from authenticated internal services (like `webhook-receiver`) to perform actions like placing trades.

- **Method:** `POST`
- **Endpoint:** `/process`
- **Content-Type:** `application/json`
- **Expected Request Body:**

  ```json
  {
    "requestId": "<uuid_from_caller>",
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
      // ... other potential fields like strategy ID, notes, etc.
    }
  }
  ```

- **Response Format (from `/process`):**

  **Success:**

  ```json
  {
    "success": true,
    "result": { /* Exchange-specific order details or action result */ },
    "error": null
  }
  ```

  **Error:**

  ```json
  {
    "success": false,
    "result": null,
    "error": "<Error message>"
  }
  ```

### 2. Data API Endpoints (e.g., `/api/signals`)

Provides direct access to data stored by the worker (e.g., in D1).

- **Method:** `POST` (for creating signals), `GET` (for retrieving signals)
- **Endpoint:** `/api/signals`
- **Authentication:** May use API keys, JWT, or other methods depending on requirements (needs implementation).
- **Request/Response:** Refer to the specific implementation in the source code.

## Exchange Clients

The worker uses dedicated client implementations for each supported exchange (e.g., `binance-client.ts`, `mexc-client.ts`). These handle exchange-specific API requirements.

## Database Interaction

The worker uses its `DB` binding to interact directly with the configured D1 database for storing and retrieving trade signals, history, configurations, etc.

## Security

- Internal requests to `/process` _must_ include a valid `internalAuthKey`.
- Public-facing API endpoints (like `/api/*`) require separate, robust authentication/authorization.
- Exchange API keys/secrets are stored securely using Cloudflare Workers Secrets.
- D1 interactions use parameterized queries to prevent SQL injection.

## Error Handling

The worker includes error handling for:

- Authentication failures
- Invalid request parameters
- Exchange API errors
- Network issues
- Database interaction failures (D1, R2)

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request
