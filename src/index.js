// trade-worker/src/index.js - Only accepts requests from the webhook receiver
import { MexcClient } from './mexc-client.js';
import { BinanceClient } from './binance-client.js';
import { BybitClient } from './bybit-client.js';

// ES Module format requires a default export
export default {
  async fetch(request, env) {
    return await handleRequest(request, env);
  }
};

async function handleRequest(request, env) {
  // Verify internal service authentication
  const internalKey = request.headers.get('X-Internal-Key');
  const requestId = request.headers.get('X-Request-ID');

  if (!internalKey || internalKey !== env.INTERNAL_SERVICE_KEY || !requestId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Unauthorized'
    }), { status: 403 });
  }

  try {
    // Process the trade request
    const data = await request.json();

    const { exchange, action, symbol, quantity, price, orderType = 'MARKET', leverage } = data;

    // Initialize the appropriate exchange client
    let client;
    switch (exchange.toLowerCase()) {
      case 'mexc':
        client = new MexcClient(env.MEXC_API_KEY, env.MEXC_API_SECRET);
        break;
      case 'binance':
        client = new BinanceClient(env.BINANCE_API_KEY, env.BINANCE_API_SECRET);
        break;
      case 'bybit':
        client = new BybitClient(env.BYBIT_API_KEY, env.BYBIT_API_SECRET);
        break;
      default:
        return new Response(JSON.stringify({
          success: false,
          error: 'Unsupported exchange'
        }), { status: 400 });
    }

    // Map action to parameters
    let side, reduceOnly = false;

    switch (action.toUpperCase()) {
      case 'LONG':
        side = 'BUY';
        reduceOnly = false;
        break;
      case 'SHORT':
        side = 'SELL';
        reduceOnly = false;
        break;
      case 'CLOSE_LONG':
        side = 'SELL';
        reduceOnly = true;
        break;
      case 'CLOSE_SHORT':
        side = 'BUY';
        reduceOnly = true;
        break;
      default:
        return new Response(JSON.stringify({
          success: false,
          error: `Invalid action: ${action}`
        }), { status: 400 });
    }

    // Set leverage if provided
    if (leverage) {
      await client.setLeverage(symbol, leverage);
    }

    // Execute the trade
    const result = await client.executeTrade({
      symbol,
      side,
      orderType,
      quantity,
      price,
      reduceOnly,
      leverage
    });

    return new Response(JSON.stringify({
      success: true,
      requestId,
      result
    }));

  } catch (error) {
    console.error('Error processing trade request:', error);

    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error occurred'
    }), { status: 500 });
  }
}
