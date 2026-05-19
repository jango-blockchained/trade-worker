# @hoox/trade-worker

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

Executes trades on Binance, Bybit, and MEXC — routes signals to the configured exchange.

## For CLI Users

Use this worker indirectly when you run `hoox` commands:

- `hoox secrets update-cf BINANCE_KEY_BINDING trade-worker` — set exchange API keys
- `hoox deploy worker trade-worker` — deploy the trade worker

→ [Monitor Trading](../../docs/guides/monitor-trading.md) · [CLI Reference](../../docs/reference/cli-commands.md)

## For Operators

This worker provides multi-exchange trade execution. It consumes signals from the `trade-execution` queue, routes orders to Binance, Bybit, or MEXC, logs results to D1, and offloads verbose logs to R2. Retry logic handles failures with exponential backoff (up to 5 attempts) and dead-letter logging.

→ [Operator Docs](../../docs/devops/workers/trade-worker.md)

## Development

```bash
bun test workers/trade-worker
```
