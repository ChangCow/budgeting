const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function setupDatabase() {
    const db = await open({
        filename: './expenses.sqlite',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            frequency TEXT NOT NULL,
            startDate TEXT NOT NULL,
            adjustments TEXT NOT NULL,
            endDate TEXT
        );
        CREATE TABLE IF NOT EXISTS income (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);

    // Initialize disposable income setting if it doesn't exist
    const disposableIncome = await db.get("SELECT * FROM settings WHERE key = 'disposableIncome'");
    if (!disposableIncome) {
        await db.run("INSERT INTO settings (key, value) VALUES ('disposableIncome', '0')");
    }

    const lastReset = await db.get("SELECT * FROM settings WHERE key = 'lastResetDate'");
    if (!lastReset) {
        await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ['lastResetDate', new Date().toISOString()]);
    }


    // Simple migration check to add the endDate column to older tables
    const columns = await db.all("PRAGMA table_info(expenses);");
    if (!columns.some(col => col.name === 'endDate')) {
        await db.exec('ALTER TABLE expenses ADD COLUMN endDate TEXT');
    }

    return db;
}

module.exports = setupDatabase;