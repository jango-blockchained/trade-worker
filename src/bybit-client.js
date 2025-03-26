// trade-worker/src/bybit-client.js - Bybit API client implementation
export class BybitClient {
    constructor(apiKey, apiSecret) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = 'https://api.bybit.com';
    }

    // Generate signature for authenticated requests
    async generateSignature(params, timestamp) {
        const queryString = Object.keys(params)
            .sort()
            .map(key => `${key}=${params[key]}`)
            .join('&');

        const signaturePayload = `${timestamp}${this.apiKey}${queryString}`;

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
                category: 'linear',
                symbol: symbol,
                buyLeverage: leverage.toString(),
                sellLeverage: leverage.toString()
            };

            const signature = await this.generateSignature(params, timestamp);
            const queryString = Object.entries(params)
                .map(([key, value]) => `${key}=${value}`)
                .join('&');

            const response = await fetch(`${this.baseUrl}/v5/position/set-leverage`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BAPI-API-KEY': this.apiKey,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-SIGN': signature
                },
                body: JSON.stringify(params)
            });

            const data = await response.json();

            if (data.retCode !== 0) {
                throw new Error(data.retMsg);
            }

            return data.result;
        } catch (error) {
            throw new Error(`Failed to set leverage: ${error.message}`);
        }
    }

    // Execute a trade
    async executeTrade({ symbol, side, orderType, quantity, price, reduceOnly }) {
        try {
            const timestamp = Date.now();
            const params = {
                category: 'linear',
                symbol: symbol,
                side: side.toUpperCase(),
                orderType: orderType,
                qty: quantity.toString(),
                reduceOnly: reduceOnly
            };

            if (orderType === 'Limit' && price) {
                params.price = price.toString();
            }

            const signature = await this.generateSignature(params, timestamp);

            const response = await fetch(`${this.baseUrl}/v5/order/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BAPI-API-KEY': this.apiKey,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-SIGN': signature
                },
                body: JSON.stringify(params)
            });

            const data = await response.json();

            if (data.retCode !== 0) {
                throw new Error(data.retMsg);
            }

            return data.result;
        } catch (error) {
            throw new Error(`Order execution failed: ${error.message}`);
        }
    }

    // Get account information
    async getAccountInfo() {
        try {
            const timestamp = Date.now();
            const params = {
                accountType: 'CONTRACT'
            };

            const signature = await this.generateSignature(params, timestamp);

            const response = await fetch(`${this.baseUrl}/v5/account/wallet-balance?${new URLSearchParams(params)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BAPI-API-KEY': this.apiKey,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-SIGN': signature
                }
            });

            const data = await response.json();

            if (data.retCode !== 0) {
                throw new Error(data.retMsg);
            }

            return data.result;
        } catch (error) {
            throw new Error(`Failed to get account info: ${error.message}`);
        }
    }

    // Get positions
    async getPositions(symbol = null) {
        try {
            const timestamp = Date.now();
            const params = {
                category: 'linear'
            };

            if (symbol) {
                params.symbol = symbol;
            }

            const signature = await this.generateSignature(params, timestamp);

            const response = await fetch(`${this.baseUrl}/v5/position/list?${new URLSearchParams(params)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BAPI-API-KEY': this.apiKey,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-SIGN': signature
                }
            });

            const data = await response.json();

            if (data.retCode !== 0) {
                throw new Error(data.retMsg);
            }

            return data.result;
        } catch (error) {
            throw new Error(`Failed to get positions: ${error.message}`);
        }
    }
} 