# Trade Worker

A Cloudflare Worker service for executing cryptocurrency trades across multiple exchanges. This worker handles trade execution requests and provides a unified interface for different cryptocurrency exchanges.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yourusername/hoox-trading/tree/main/workers/trade-worker)

## Features

- Multi-exchange support (Binance, MEXC, Bybit)
- Secure authentication with internal service key
- Request/Response logging with D1 database integration
- Leverage configuration
- Position management (Long/Short positions)
- Error handling and logging

## Prerequisites

- Node.js >= 16
- Bun (for package management)
- Wrangler CLI
- Cloudflare Workers account
- API keys for supported exchanges

## Setup

1. Install dependencies:
```bash
bun install
```

2. Configure environment variables in `.dev.vars` for local development:
```env
INTERNAL_SERVICE_KEY=your_internal_key
MEXC_API_KEY=your_mexc_key
MEXC_API_SECRET=your_mexc_secret
BINANCE_API_KEY=your_binance_key
BINANCE_API_SECRET=your_binance_secret
BYBIT_API_KEY=your_bybit_key
BYBIT_API_SECRET=your_bybit_secret
D1_WORKER_URL=http://localhost:8787
```

3. Configure production secrets using wrangler:
```bash
wrangler secret put INTERNAL_SERVICE_KEY
wrangler secret put MEXC_API_KEY
wrangler secret put MEXC_API_SECRET
wrangler secret put BINANCE_API_KEY
wrangler secret put BINANCE_API_SECRET
wrangler secret put BYBIT_API_KEY
wrangler secret put BYBIT_API_SECRET
```

4. Update the D1 worker URL in `wrangler.toml` for production:
```toml
[vars]
D1_WORKER_URL = "https://your-d1-worker.workers.dev"
```

## Development

### Local Development

For local development, this worker should run on port 8788:

```bash
bun run dev -- --port 8788
```

The worker uses environment variables from `.dev.vars` during local development instead of the values in `wrangler.toml` or Cloudflare secrets.

### Production Deployment

Deploy to production:
```bash
bun run deploy
```

## API Usage

### Execute Trade

```http
POST /
Content-Type: application/json
X-Internal-Key: your_internal_key
X-Request-ID: unique_request_id

{
  "exchange": "binance",
  "action": "LONG",
  "symbol": "BTCUSDT",
  "quantity": 0.001,
  "price": 65000,
  "leverage": 20
}
```

#### Supported Actions
- `LONG`: Open a long position
- `SHORT`: Open a short position
- `CLOSE_LONG`: Close a long position
- `CLOSE_SHORT`: Close a short position

#### Supported Exchanges
- Binance (`binance`)
- MEXC (`mexc`)
- Bybit (`bybit`)

#### Response Format

Success:
```json
{
  "success": true,
  "requestId": "unique_request_id",
  "result": {
    // Exchange-specific order details
  }
}
```

Error:
```json
{
  "success": false,
  "error": "Error message"
}
```

## Exchange Clients

The worker includes dedicated client implementations for each supported exchange:
- `binance-client.js` - Binance Futures API integration
- `mexc-client.js` - MEXC Futures API integration
- `bybit-client.js` - Bybit Futures API integration

Each client handles exchange-specific API requirements, authentication, and trade execution.

## Database Logging

When enabled, the worker logs all requests and responses to a D1 database through the D1 Worker. The logging system tracks:
- Request details (method, path, headers, body)
- Response information (status, headers, body)
- Error data
- Execution timing

## Security

- All requests must include a valid `X-Internal-Key` header
- All requests must include a unique `X-Request-ID` header
- API keys are stored securely using Cloudflare Workers Secrets
- Request validation and sanitization
- Error messages don't expose sensitive information

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