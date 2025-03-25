// trade-worker/src/mexc-client.js - MEXC API client implementation
import { createHmac } from 'node:crypto';

export class MexcClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = 'https://api.mexc.com';
  }

  // Generate signature for authenticated requests
  generateSignature(params, timestamp) {
    const queryString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');
    
    const signaturePayload = `${queryString}&timestamp=${timestamp}`;
    return createHmac('sha256', this.apiSecret)
      .update(signaturePayload)
      .digest('hex');
  }

  // Set leverage for a symbol
  async setLeverage(symbol, leverage) {
    const timestamp = Date.now();
    const params = {
      symbol: symbol,
      leverage: leverage
    };
    
    const signature = this.generateSignature(params, timestamp);
    
    const response = await fetch(`${this.baseUrl}/api/v3/leverage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MEXC-APIKEY': this.apiKey
      },
      body: JSON.stringify({
        ...params,
        timestamp,
        signature
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to set leverage: ${JSON.stringify(error)}`);
    }
    
    return response.json();
  }

  // Execute a trade
  async executeTrade({ symbol, side, orderType, quantity, price, reduceOnly, leverage }) {
    const timestamp = Date.now();
    const params = {
      symbol: symbol,
      side: side,
      type: orderType,
      quantity: quantity.toString(),
      reduceOnly: reduceOnly.toString()
    };
    
    // Add price for limit orders
    if (orderType === 'LIMIT' && price) {
      params.price = price.toString();
    }
    
    const signature = this.generateSignature(params, timestamp);
    
    const response = await fetch(`${this.baseUrl}/api/v3/order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MEXC-APIKEY': this.apiKey
      },
      body: JSON.stringify({
        ...params,
        timestamp,
        signature
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Order execution failed: ${JSON.stringify(error)}`);
    }
    
    return response.json();
  }

  // Get account information
  async getAccountInfo() {
    const timestamp = Date.now();
    const params = {};
    
    const signature = this.generateSignature(params, timestamp);
    
    const response = await fetch(`${this.baseUrl}/api/v3/account?timestamp=${timestamp}&signature=${signature}`, {
      method: 'GET',
      headers: {
        'X-MEXC-APIKEY': this.apiKey
      }
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to get account info: ${JSON.stringify(error)}`);
    }
    
    return response.json();
  }

  // Get positions
  async getPositions(symbol = null) {
    const timestamp = Date.now();
    const params = {};
    
    if (symbol) {
      params.symbol = symbol;
    }
    
    const signature = this.generateSignature(params, timestamp);
    
    const queryString = symbol ? `symbol=${symbol}&` : '';
    const url = `${this.baseUrl}/api/v3/positionRisk?${queryString}timestamp=${timestamp}&signature=${signature}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MEXC-APIKEY': this.apiKey
      }
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to get positions: ${JSON.stringify(error)}`);
    }
    
    return response.json();
  }
}
