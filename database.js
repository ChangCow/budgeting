const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function setupDatabase() {
    const db = await open({
        filename: './expenses.sqlite',
        driver: sqlite3.Database
    });

    // We run a migration to add the endDate column if it doesn't exist
    await db.exec(`
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            frequency TEXT NOT NULL,
            startDate TEXT NOT NULL,
            adjustments TEXT NOT NULL,
            endDate TEXT 
        )
    `);

    // Simple migration check to add the endDate column to older tables
    const columns = await db.all("PRAGMA table_info(expenses);");
    if (!columns.some(col => col.name === 'endDate')) {
        await db.exec('ALTER TABLE expenses ADD COLUMN endDate TEXT');
    }

    return db;
}

module.exports = setupDatabase;