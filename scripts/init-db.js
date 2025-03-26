import { readFileSync } from 'fs';
import { join } from 'path';

async function initDatabase() {
    const D1_WORKER_URL = process.env.D1_WORKER_URL || 'http://localhost:8787';
    const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;

    if (!INTERNAL_SERVICE_KEY) {
        console.error('Error: INTERNAL_SERVICE_KEY environment variable is required');
        process.exit(1);
    }

    try {
        // Read SQL file
        const sqlPath = join(__dirname, 'init-db.sql');
        const sqlContent = readFileSync(sqlPath, 'utf-8');

        // Split SQL content into individual statements
        const statements = sqlContent
            .split(';')
            .map(stmt => stmt.trim())
            .filter(stmt => stmt.length > 0)
            .map(query => ({ query, params: [] }));

        // Send batch request to D1 worker
        const response = await fetch(`${D1_WORKER_URL}/batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${INTERNAL_SERVICE_KEY}`
            },
            body: JSON.stringify({ statements })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to initialize database: ${error}`);
        }

        const result = await response.json();
        console.log('Database initialized successfully:', result);
    } catch (error) {
        console.error('Error initializing database:', error);
        process.exit(1);
    }
}

initDatabase(); 