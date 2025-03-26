-- Create requests table
CREATE TABLE IF NOT EXISTS trade_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    headers TEXT,
    body TEXT,
    source_ip TEXT,
    user_agent TEXT
);

-- Create responses table
CREATE TABLE IF NOT EXISTS trade_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    status_code INTEGER,
    headers TEXT,
    body TEXT,
    error TEXT,
    execution_time_ms INTEGER,
    FOREIGN KEY (request_id) REFERENCES trade_requests(id)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_trade_requests_timestamp ON trade_requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_trade_responses_request_id ON trade_responses(request_id); 