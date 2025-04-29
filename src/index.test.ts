import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from './index'; // Import the worker entry point

// Mock the D1Database methods globally or per suite/test
const mockRun = vi.fn();
const mockAll = vi.fn();
const mockBind = vi.fn(() => ({ run: mockRun, all: mockAll }));
const mockPrepare = vi.fn(() => ({ bind: mockBind }));

const mockEnv = {
    DB: {
        prepare: mockPrepare,
        // Add other necessary D1 methods if used, e.g., batch, dump
    },
    // Add other necessary env bindings with mocks or dummy values
    CONFIG_KV: { get: vi.fn(), put: vi.fn(), list: vi.fn(), delete: vi.fn() }, 
    AI: { run: vi.fn() },
    REPORTS_BUCKET: { put: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() },
    INTERNAL_KEY_BINDING: { get: vi.fn().mockResolvedValue('test-internal-key')},
    // ... other bindings ...
} as any; // Use 'as any' for simplicity in testing, or define a more specific mock type

// Helper to create a mock Request object
function createMockRequest(method: string, urlPath: string, body?: any, headers?: HeadersInit): Request {
    const url = `http://localhost${urlPath}`;
    const init: RequestInit = {
        method,
        headers: new Headers(headers),
    };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        (init.headers as Headers).set('Content-Type', 'application/json');
    }
    const request = new Request(url, init);
    // Mock the json() method for POST/PUT requests
    if (body !== undefined) {
        request.json = async () => JSON.parse(init.body as string);
    }
    return request;
}

describe('Trade Worker - D1 Signals Endpoint (/api/signals)', () => {

    beforeEach(() => {
        // Reset mocks before each test
        vi.clearAllMocks();
    });

    // --- Tests for POST /api/signals ---
    describe('POST /api/signals', () => {
        const validSignalPayload = {
            timestamp: Math.floor(Date.now() / 1000),
            symbol: 'BTCUSDT',
            signal_type: 'BUY',
            source: 'Test',
        };

        it('should insert a valid signal and return 201', async () => {
            mockRun.mockResolvedValueOnce({ success: true, meta: { changes: 1 } }); // Simulate successful D1 insert

            const request = createMockRequest('POST', '/api/signals', validSignalPayload);
            const response = await worker.fetch(request, mockEnv, {} as any); // Pass mock context if needed

            expect(response.status).toBe(201);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(true);
            expect(responseBody.result).toHaveProperty('signalId');
            expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO trade_signals'));
            expect(mockBind).toHaveBeenCalledWith(
                expect.any(String), // signal_id (UUID)
                validSignalPayload.timestamp,
                validSignalPayload.symbol,
                validSignalPayload.signal_type,
                validSignalPayload.source,
                JSON.stringify(validSignalPayload)
            );
            expect(mockRun).toHaveBeenCalledTimes(1);
        });

        it('should return 400 for invalid JSON', async () => {
            const request = new Request('http://localhost/api/signals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{ invalid json,'
            });

            const response = await worker.fetch(request, mockEnv, {} as any);
            expect(response.status).toBe(400);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(false);
            expect(responseBody.error).toContain('Invalid JSON');
            expect(mockRun).not.toHaveBeenCalled();
        });

        it('should return 400 for missing required fields', async () => {
            const invalidPayload = { timestamp: 123, symbol: 'ETHUSDT' }; // Missing signal_type
            const request = createMockRequest('POST', '/api/signals', invalidPayload);
            const response = await worker.fetch(request, mockEnv, {} as any);

            expect(response.status).toBe(400);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(false);
            expect(responseBody.error).toContain('Missing required fields');
            expect(mockRun).not.toHaveBeenCalled();
        });

        it('should return 500 if D1 insert fails', async () => {
            mockRun.mockResolvedValueOnce({ success: false, error: 'D1 Error' }); // Simulate D1 failure

            const request = createMockRequest('POST', '/api/signals', validSignalPayload);
            const response = await worker.fetch(request, mockEnv, {} as any);

            expect(response.status).toBe(500);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(false);
            expect(responseBody.error).toContain('Failed to store signal');
            expect(mockRun).toHaveBeenCalledTimes(1);
        });

         it('should return 500 if D1 insert throws an exception', async () => {
            mockRun.mockRejectedValueOnce(new Error('D1 Exception')); // Simulate D1 exception

            const request = createMockRequest('POST', '/api/signals', validSignalPayload);
            const response = await worker.fetch(request, mockEnv, {} as any);

            expect(response.status).toBe(500);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(false);
            expect(responseBody.error).toContain('Internal server error');
            expect(mockRun).toHaveBeenCalledTimes(1);
        });
    });

    // --- Tests for GET /api/signals ---
    describe('GET /api/signals', () => {
        const mockSignalResults = [
            { signal_id: 'uuid-1', timestamp: 1, symbol: 'BTC', signal_type: 'BUY', source: 'A', processed_at: 10 },
            { signal_id: 'uuid-2', timestamp: 2, symbol: 'ETH', signal_type: 'SELL', source: 'B', processed_at: 9 },
        ];

        it('should return recent signals with default limit', async () => {
            mockAll.mockResolvedValueOnce({ success: true, results: mockSignalResults });

            const request = createMockRequest('GET', '/api/signals');
            const response = await worker.fetch(request, mockEnv, {} as any);

            expect(response.status).toBe(200);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(true);
            expect(responseBody.result).toEqual(mockSignalResults);
            expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT signal_id'));
            expect(mockBind).toHaveBeenCalledWith(10); // Default limit
            expect(mockAll).toHaveBeenCalledTimes(1);
        });

        it('should return signals with specified limit', async () => {
             mockAll.mockResolvedValueOnce({ success: true, results: [mockSignalResults[0]] });

            const request = createMockRequest('GET', '/api/signals?limit=1');
            const response = await worker.fetch(request, mockEnv, {} as any);

            expect(response.status).toBe(200);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(true);
            expect(responseBody.result).toEqual([mockSignalResults[0]]);
            expect(mockBind).toHaveBeenCalledWith(1); // Specified limit
            expect(mockAll).toHaveBeenCalledTimes(1);
        });

        it('should return empty array if no signals found', async () => {
             mockAll.mockResolvedValueOnce({ success: true, results: [] });

            const request = createMockRequest('GET', '/api/signals');
            const response = await worker.fetch(request, mockEnv, {} as any);

            expect(response.status).toBe(200);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(true);
            expect(responseBody.result).toEqual([]);
            expect(mockAll).toHaveBeenCalledTimes(1);
        });

        it('should return 400 for invalid limit parameter (string)', async () => {
            const request = createMockRequest('GET', '/api/signals?limit=abc');
            const response = await worker.fetch(request, mockEnv, {} as any);
            expect(response.status).toBe(400);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(false);
            expect(responseBody.error).toContain('Invalid limit');
            expect(mockAll).not.toHaveBeenCalled();
        });

         it('should return 400 for invalid limit parameter (zero)', async () => {
            const request = createMockRequest('GET', '/api/signals?limit=0');
            const response = await worker.fetch(request, mockEnv, {} as any);
            expect(response.status).toBe(400);
            // ... assertions ...
            expect(mockAll).not.toHaveBeenCalled();
        });

         it('should return 400 for invalid limit parameter (too large)', async () => {
            const request = createMockRequest('GET', '/api/signals?limit=101');
            const response = await worker.fetch(request, mockEnv, {} as any);
            expect(response.status).toBe(400);
            // ... assertions ...
             expect(mockAll).not.toHaveBeenCalled();
        });

        it('should return 500 if D1 query fails', async () => {
             mockAll.mockRejectedValueOnce(new Error('D1 Select Error'));

            const request = createMockRequest('GET', '/api/signals');
            const response = await worker.fetch(request, mockEnv, {} as any);

            expect(response.status).toBe(500);
            const responseBody = await response.json();
            expect(responseBody.success).toBe(false);
            expect(responseBody.error).toContain('Internal server error');
            expect(mockAll).toHaveBeenCalledTimes(1);
        });
    });
}); 