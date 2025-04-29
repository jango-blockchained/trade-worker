-- workers/trade-worker/schema.sql

-- Remove table if it exists (useful for development/resetting)
DROP TABLE IF EXISTS trade_signals;

-- Create the trade_signals table
CREATE TABLE trade_signals (
    signal_id TEXT PRIMARY KEY,      -- Unique identifier for the signal (e.g., UUID)
    timestamp INTEGER NOT NULL,      -- Unix timestamp (seconds) of when the signal was generated/received
    symbol TEXT NOT NULL,            -- Trading symbol (e.g., 'BTCUSDT')
    signal_type TEXT NOT NULL,       -- Type of signal (e.g., 'BUY', 'SELL', 'HOLD')
    source TEXT,                     -- Source of the signal (e.g., 'TradingView', 'InternalModel')
    raw_data TEXT,                   -- Store the original raw signal data (e.g., JSON string)
    processed_at INTEGER DEFAULT (unixepoch()) -- Timestamp when the record was inserted
);

-- Optional: Add indexes for faster querying
CREATE INDEX IF NOT EXISTS idx_trade_signals_timestamp ON trade_signals (timestamp);
CREATE INDEX IF NOT EXISTS idx_trade_signals_symbol ON trade_signals (symbol); 