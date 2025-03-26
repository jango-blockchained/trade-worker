/**
 * Database logging utility for trade worker
 */

export class DbLogger {
    constructor(env) {
        this.env = env;
        this.d1WorkerUrl = env.D1_WORKER_URL || 'http://127.0.0.1:8787';
        this.enabled = !!env.D1_WORKER_URL && !!env.INTERNAL_SERVICE_KEY;
    }

    async logRequest(request, requestBody) {
        if (!this.enabled) return null;

        try {
            const headers = Object.fromEntries(request.headers.entries());
            const response = await fetch(`${this.d1WorkerUrl}/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.env.INTERNAL_SERVICE_KEY}`
                },
                body: JSON.stringify({
                    query: `INSERT INTO trade_requests 
                           (method, path, headers, body, source_ip, user_agent) 
                           VALUES (?, ?, ?, ?, ?, ?)`,
                    params: [
                        request.method,
                        new URL(request.url).pathname,
                        JSON.stringify(headers),
                        JSON.stringify(requestBody),
                        request.headers.get('cf-connecting-ip'),
                        request.headers.get('user-agent')
                    ]
                })
            });

            if (!response.ok) {
                console.error('Failed to log request:', await response.text());
                return null;
            }

            const result = await response.json();
            return result.lastRowId;
        } catch (error) {
            console.error('Error logging request:', error);
            return null;
        }
    }

    async logResponse(requestId, response, error = null, startTime) {
        if (!this.enabled || !requestId) return;

        try {
            const executionTime = Date.now() - startTime;
            const headers = Object.fromEntries(response.headers.entries());
            const body = await response.clone().text();

            await fetch(`${this.d1WorkerUrl}/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.env.INTERNAL_SERVICE_KEY}`
                },
                body: JSON.stringify({
                    query: `INSERT INTO trade_responses 
                           (request_id, status_code, headers, body, error, execution_time_ms) 
                           VALUES (?, ?, ?, ?, ?, ?)`,
                    params: [
                        requestId,
                        response.status,
                        JSON.stringify(headers),
                        body,
                        error ? error.toString() : null,
                        executionTime
                    ]
                })
            });
        } catch (error) {
            console.error('Error logging response:', error);
        }
    }
} 