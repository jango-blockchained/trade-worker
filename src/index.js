// trade-worker/src/index.js - Only accepts requests from the webhook receiver
import { MexcClient } from './mexc-client.js';
import { BinanceClient } from './binance-client.js';
import { BybitClient } from './bybit-client.js';
import { DbLogger } from './db-logger.js';

// ES Module format requires a default export
export default {
  async fetch(request, env) {
    return await handleRequest(request, env);
  }
};

async function handleRequest(request, env) {
  const startTime = Date.now();
  const dbLogger = new DbLogger(env);
  let requestId = null;

  // Verify internal service authentication
  const internalKey = request.headers.get('X-Internal-Key');
  const headerRequestId = request.headers.get('X-Request-ID');

  if (!internalKey || internalKey !== env.INTERNAL_SERVICE_KEY || !headerRequestId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Unauthorized'
    }), { status: 403 });
  }

  try {
    // Process the trade request
    const data = await request.json();
    console.log('Received trade request:', JSON.stringify(data, null, 2));

    // Log the request to database
    requestId = await dbLogger.logRequest(request, data);

    const { exchange, action, symbol, quantity, price, orderType = 'MARKET', leverage = 20 } = data;

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
        const response = new Response(JSON.stringify({
          success: false,
          error: 'Unsupported exchange'
        }), { status: 400 });
        await dbLogger.logResponse(requestId, response, null, startTime);
        return response;
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
        const response = new Response(JSON.stringify({
          success: false,
          error: `Invalid action: ${action}`
        }), { status: 400 });
        await dbLogger.logResponse(requestId, response, null, startTime);
        return response;
    }

    // Set leverage if provided
    if (leverage) {
      console.log(`Setting leverage for ${symbol} to ${leverage}`);
      await client.setLeverage(symbol, leverage);
    }

    // Prepare trade parameters
    const tradeParams = {
      symbol,
      side,
      orderType,
      quantity,
      price,
      reduceOnly,
      leverage
    };

    // Add exchange-specific parameters
    if (exchange.toLowerCase() === 'mexc') {
      tradeParams.positionMode = 'ONE_WAY';
      tradeParams.openType = 'ISOLATED';
      tradeParams.positionType = 2;
    }

    console.log('Executing trade with params:', JSON.stringify(tradeParams, null, 2));

    // Execute the trade
    const result = await client.executeTrade(tradeParams);

    console.log('Trade result:', JSON.stringify(result, null, 2));

    const response = new Response(JSON.stringify({
      success: true,
      requestId: headerRequestId,
      result
    }));

    // Log the successful response
    await dbLogger.logResponse(requestId, response, null, startTime);
    return response;

  } catch (error) {
    console.error('Error processing trade request:', error);

    const response = new Response(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error occurred'
    }), { status: 500 });

    // Log the error response
    await dbLogger.logResponse(requestId, response, error, startTime);
    return response;
  }
}
