// trade-worker/src/mexc-client.js - MEXC API client implementation
export class MexcClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = 'https://contract.mexc.com';
  }

  // Generate signature for authenticated requests
  async generateSignature(params, timestamp) {
    const queryString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');

    const signaturePayload = `${queryString}&timestamp=${timestamp}`;

    // Use WebCrypto API instead of Node's crypto
    const encoder = new TextEncoder();
    const key = encoder.encode(this.apiSecret);
    const message = encoder.encode(signaturePayload);

    return crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    ).then(key => crypto.subtle.sign(
      'HMAC',
      key,
      message
    )).then(signature => {
      return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    });
  }

  // Set leverage for a symbol
  async setLeverage(symbol, leverage) {
    try {
      const timestamp = Date.now();
      const params = {
        symbol: symbol,
        leverage: leverage
      };

      const signature = await this.generateSignature(params, timestamp);
      const queryString = Object.entries(params)
        .map(([key, value]) => `${key}=${value}`)
        .join('&');

      const response = await fetch(`${this.baseUrl}/api/v1/private/position/change-leverage?${queryString}&timestamp=${timestamp}&signature=${signature}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MEXC-APIKEY': this.apiKey
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.msg || 'Failed to set leverage');
      }

      return await response.json();
    } catch (error) {
      throw new Error(`Failed to set leverage: ${error.message}`);
    }
  }

  // Execute a trade
  async executeTrade({ symbol, side, orderType, quantity, price, reduceOnly }) {
    try {
      const timestamp = Date.now();
      const params = {
        symbol: symbol,
        side: side,
        type: orderType,
        volume: quantity.toString(),
        reduceOnly: reduceOnly.toString()
      };

      if (orderType === 'LIMIT' && price) {
        params.price = price.toString();
      }

      const signature = await this.generateSignature(params, timestamp);
      const queryString = Object.entries(params)
        .map(([key, value]) => `${key}=${value}`)
        .join('&');

      const response = await fetch(`${this.baseUrl}/api/v1/private/order/submit?${queryString}&timestamp=${timestamp}&signature=${signature}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MEXC-APIKEY': this.apiKey
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.msg || 'Order execution failed');
      }

      return await response.json();
    } catch (error) {
      throw new Error(`Order execution failed: ${error.message}`);
    }
  }

  // Get account information
  async getAccountInfo() {
    try {
      const timestamp = Date.now();
      const params = {};

      const signature = await this.generateSignature(params, timestamp);

      const response = await fetch(`${this.baseUrl}/api/v1/private/account/assets?timestamp=${timestamp}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': this.apiKey
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.msg || 'Failed to get account info');
      }

      return await response.json();
    } catch (error) {
      throw new Error(`Failed to get account info: ${error.message}`);
    }
  }

  // Get positions
  async getPositions(symbol = null) {
    try {
      const timestamp = Date.now();
      const params = {};

      if (symbol) {
        params.symbol = symbol;
      }

      const signature = await this.generateSignature(params, timestamp);
      const queryString = symbol ? `symbol=${symbol}&` : '';

      const response = await fetch(`${this.baseUrl}/api/v1/private/position/list?${queryString}timestamp=${timestamp}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': this.apiKey
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.msg || 'Failed to get positions');
      }

      return await response.json();
    } catch (error) {
      throw new Error(`Failed to get positions: ${error.message}`);
    }
  }
}
