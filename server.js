const express = require('express');
const path = require('path');
const { addWeeks, addMonths, addYears, format, startOfDay, isEqual, subDays, isBefore } = require('date-fns');
const setupDatabase = require('./database');

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

async function main() {
    const db = await setupDatabase();

    // The GET '/' route is updated to show past and future expenses.
    app.get('/', async (req, res) => {
        const expensesToShow = [];
        const today = startOfDay(new Date());
        const futureLimit = addMonths(today, 6);
        const pastLimit = addMonths(today, -3); // How far back to show expenses

        const allExpensesFromDb = await db.all('SELECT * FROM expenses ORDER BY description, startDate');

        allExpensesFromDb.forEach(baseExpense => {
            baseExpense.startDate = new Date(baseExpense.startDate);
            baseExpense.endDate = baseExpense.endDate ? new Date(baseExpense.endDate) : null;
            baseExpense.adjustments = JSON.parse(baseExpense.adjustments);

            let idealDate = new Date(baseExpense.startDate);

            while (idealDate <= futureLimit && (!baseExpense.endDate || idealDate <= baseExpense.endDate)) {
                // Check if the idealDate is within the window we care about, to avoid unnecessary processing
                // A bit of a buffer for adjustments that might move a date into the window
                if (idealDate >= addMonths(pastLimit, -1)) {
                    const adjustment = baseExpense.adjustments.find(adj => isEqual(new Date(adj.originalDate), idealDate));
                    const displayDate = adjustment ? new Date(adjustment.newDate) : idealDate;

                    // Add to list if it's within the display window
                    if (displayDate >= pastLimit && displayDate <= futureLimit) {
                        expensesToShow.push({ ...baseExpense, displayDate, originalDate: idealDate });
                    }
                }

                if (baseExpense.frequency === 'weekly') idealDate = addWeeks(idealDate, 1);
                else if (baseExpense.frequency === 'monthly') idealDate = addMonths(idealDate, 1);
                else if (baseExpense.frequency === 'yearly') idealDate = addYears(idealDate, 1);
                else break; // Should not happen
            }
        });

        expensesToShow.sort((a, b) => a.displayDate - b.displayDate);

        // Find the index of the first expense that is on or after today.
        // This will be our scroll target.
        const upcomingIndex = expensesToShow.findIndex(e => !isBefore(e.displayDate, today));

        res.render('index', {
            allExpenses: allExpensesFromDb,
            upcoming: expensesToShow,
            format,
            formatForInput: (date) => format(date, "yyyy-MM-dd"),
            upcomingIndex: upcomingIndex > -1 ? upcomingIndex : 0, // pass index, default to 0
        });
    });

    // --- UNCHANGED CODE BELOW ---

    app.post('/add', async (req, res) => {
        const { description, amount, frequency, startDate } = req.body;
        if (description && amount && frequency && startDate) {
            // FIX: Append 'T00:00' to ensure date is parsed in local timezone, not UTC.
            const cleanStartDate = new Date(startDate + 'T00:00').toISOString();
            await db.run(
                'INSERT INTO expenses (description, amount, frequency, startDate, adjustments) VALUES (?, ?, ?, ?, ?)',
                [description, parseFloat(amount), frequency, cleanStartDate, '[]']
            );
        }
        res.redirect('/');
    });

    app.post('/update', async (req, res) => {
        const { baseId, originalDateStr, newDateStr, propagate } = req.body;

        // FIX: Append 'T00:00' to parse the new date string in the local timezone.
        const cleanNewDate = new Date(newDateStr + 'T00:00');
        // The original date from the DB is already a full ISO string, so it's parsed correctly.
        const originalDate = new Date(originalDateStr);
        
        const expense = await db.get('SELECT * FROM expenses WHERE id = ?', [parseInt(baseId)]);
        if (!expense) return res.redirect('/');

        if (propagate) {
            const newEndDate = subDays(originalDate, 1);
            await db.run('UPDATE expenses SET endDate = ? WHERE id = ?', [newEndDate.toISOString(), expense.id]);
            await db.run(
                'INSERT INTO expenses (description, amount, frequency, startDate, adjustments) VALUES (?, ?, ?, ?, ?)',
                [expense.description, expense.amount, expense.frequency, cleanNewDate.toISOString(), '[]']
            );
        } else {
            const adjustments = JSON.parse(expense.adjustments);
            const existingAdjIndex = adjustments.findIndex(adj => isEqual(new Date(adj.originalDate), originalDate));
            if (existingAdjIndex > -1) {
                adjustments[existingAdjIndex].newDate = cleanNewDate.toISOString();
            } else {
                adjustments.push({ originalDate: originalDate.toISOString(), newDate: cleanNewDate.toISOString() });
            }
            await db.run('UPDATE expenses SET adjustments = ? WHERE id = ?', [JSON.stringify(adjustments), expense.id]);
        }
        
        res.redirect('/');
    });

    app.post('/delete/:id', async (req, res) => {
        const id = parseInt(req.params.id, 10);
        await db.run('DELETE FROM expenses WHERE id = ?', [id]);
        res.redirect('/');
    });

    app.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT} 🚀`);
    });
}

main();