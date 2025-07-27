const express = require('express');
const path = require('path');
const { addWeeks, addMonths, addYears, format, startOfDay, isEqual, subDays, isBefore, isToday, sub } = require('date-fns');
const setupDatabase = require('./database');

const app = express();
const PORT = 3052;

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

async function main() {
    const db = await setupDatabase();

    // Home Page
    app.get('/', (req, res) => {
        res.render('home');
    });

    // Expenses Page (Old Home Page)
    app.get('/expenses', async (req, res) => {
        const expensesToShow = [];
        const today = startOfDay(new Date());
        const futureLimit = addMonths(today, 6);
        const pastLimit = addMonths(today, -3);

        const allExpensesFromDb = await db.all('SELECT * FROM expenses ORDER BY description, startDate');

        let totalWeekly = 0;
        let totalMonthly = 0;
        let totalYearly = 0;

        allExpensesFromDb.forEach(expense => {
            if (!expense.endDate) {
                if (expense.frequency === 'weekly') {
                    totalWeekly += expense.amount;
                } else if (expense.frequency === 'monthly') {
                    totalMonthly += expense.amount;
                } else if (expense.frequency === 'yearly') {
                    totalYearly += expense.amount;
                }
            }
        });

        const totalWeeklyExpense = totalWeekly + (totalMonthly / 4) + (totalYearly / 52);

        allExpensesFromDb.forEach(baseExpense => {
            baseExpense.startDate = new Date(baseExpense.startDate);
            baseExpense.endDate = baseExpense.endDate ? new Date(baseExpense.endDate) : null;
            baseExpense.adjustments = JSON.parse(baseExpense.adjustments);

            let idealDate = new Date(baseExpense.startDate);

            while (idealDate <= futureLimit && (!baseExpense.endDate || idealDate <= baseExpense.endDate)) {
                if (idealDate >= addMonths(pastLimit, -1)) {
                    const adjustment = baseExpense.adjustments.find(adj => isEqual(new Date(adj.originalDate), idealDate));
                    const displayDate = adjustment ? new Date(adjustment.newDate) : idealDate;

                    if (displayDate >= pastLimit && displayDate <= futureLimit) {
                        expensesToShow.push({ ...baseExpense, displayDate, originalDate: idealDate });
                    }
                }

                if (baseExpense.frequency === 'weekly') idealDate = addWeeks(idealDate, 1);
                else if (baseExpense.frequency === 'monthly') idealDate = addMonths(idealDate, 1);
                else if (baseExpense.frequency === 'yearly') idealDate = addYears(idealDate, 1);
                else break;
            }
        });

        expensesToShow.sort((a, b) => a.displayDate - b.displayDate);

        const recentBills = expensesToShow.filter(e => isBefore(e.displayDate, today));
        const todaysBills = expensesToShow.filter(e => isToday(e.displayDate));
        const upcomingBills = expensesToShow.filter(e => isBefore(today, e.displayDate));

        res.render('expenses', {
            allExpenses: allExpensesFromDb,
            recentBills,
            todaysBills,
            upcomingBills,
            format,
            formatForInput: (date) => format(date, "yyyy-MM-dd"),
            totalWeeklyExpense: totalWeeklyExpense.toFixed(2),
        });
    });

    // Income Page
    app.get('/income', async (req, res) => {
        const allIncome = await db.all('SELECT * FROM income ORDER BY date DESC');
        res.render('income', { allIncome, format });
    });

    app.post('/income', async (req, res) => {
        const { description, amount, date } = req.body;
        if (description && amount && date) {
            await db.run(
                'INSERT INTO income (description, amount, date) VALUES (?, ?, ?)',
                [description, parseFloat(amount), new Date(date + 'T00:00').toISOString()]
            );
        }
        res.redirect('/income');
    });

    // Graph Page
    app.get('/graph', async (req, res) => {
        const { startDate, endDate } = req.query;
        let chartData = await calculateChartData(db, startDate, endDate);
        res.render('graph', { chartData });
    });
    
    app.post('/update-disposable-income', async (req, res) => {
        const { disposableIncome } = req.body;
        if (disposableIncome) {
            await db.run("UPDATE settings SET value = ? WHERE key = 'disposableIncome'", [parseFloat(disposableIncome)]);
        }
        res.redirect('/graph');
    });

    app.post('/add', async (req, res) => {
        const { description, amount, frequency, startDate } = req.body;
        if (description && amount && frequency && startDate) {
            const cleanStartDate = new Date(startDate + 'T00:00').toISOString();
            await db.run(
                'INSERT INTO expenses (description, amount, frequency, startDate, adjustments) VALUES (?, ?, ?, ?, ?)',
                [description, parseFloat(amount), frequency, cleanStartDate, '[]']
            );
        }
        res.redirect('/expenses');
    });

    app.post('/update', async (req, res) => {
        const { baseId, originalDateStr, newDateStr, propagate } = req.body;
        const cleanNewDate = new Date(newDateStr + 'T00:00');
        const originalDate = new Date(originalDateStr);
        
        const expense = await db.get('SELECT * FROM expenses WHERE id = ?', [parseInt(baseId)]);
        if (!expense) return res.redirect('/expenses');

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
        
        res.redirect('/expenses');
    });

    app.post('/delete/:id', async (req, res) => {
        const id = parseInt(req.params.id, 10);
        await db.run('DELETE FROM expenses WHERE id = ?', [id]);
        res.redirect('/expenses');
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server is running at http://localhost:${PORT} 🚀`);
    });
}

async function calculateChartData(db, startDate, endDate) {
    const { value: disposableIncome } = await db.get("SELECT value FROM settings WHERE key = 'disposableIncome'");
    const { value: lastResetDateStr } = await db.get("SELECT value FROM settings WHERE key = 'lastResetDate'");
    
    const lastResetDate = new Date(lastResetDateStr);
    let rangeStart = startDate ? new Date(startDate) : subDays(new Date(), 30);
    let rangeEnd = endDate ? new Date(endDate) : new Date();

    // Ensure the chart doesn't show data from before the last reset
    rangeStart = rangeStart < lastResetDate ? lastResetDate : rangeStart;

    // --- FIX 1: Fetch ALL data, do not filter by date here ---
    const allExpenses = await db.all('SELECT * FROM expenses');
    const allIncome = await db.all('SELECT * FROM income');

    // --- FIX 2: Group all transactions by day using a simple string ('yyyy-MM-dd') ---
    const dailyNetChanges = {};

    // Process Income
    allIncome.forEach(inc => {
        const incomeDate = new Date(inc.date);
        // Only consider income within the chart's range
        if (incomeDate >= rangeStart && incomeDate <= rangeEnd) {
            const dateStr = format(incomeDate, 'yyyy-MM-dd');
            if (!dailyNetChanges[dateStr]) dailyNetChanges[dateStr] = 0;
            dailyNetChanges[dateStr] += inc.amount;
        }
    });
    
    // Process Expenses
    allExpenses.forEach(baseExpense => {
        baseExpense.startDate = new Date(baseExpense.startDate);
        baseExpense.endDate = baseExpense.endDate ? new Date(baseExpense.endDate) : null;
        baseExpense.adjustments = JSON.parse(baseExpense.adjustments);

        let idealDate = new Date(baseExpense.startDate);

        // Generate all occurrences of a recurring expense
        while(idealDate <= rangeEnd && (!baseExpense.endDate || idealDate <= baseExpense.endDate)) {
            // Find any date adjustments for this specific occurrence
            const adjustment = baseExpense.adjustments.find(adj => isEqual(new Date(adj.originalDate), idealDate));
            const displayDate = adjustment ? new Date(adjustment.newDate) : idealDate;

            // Only consider expenses that actually fall within the chart's range
            if (displayDate >= rangeStart && displayDate <= rangeEnd) {
                const dateStr = format(displayDate, 'yyyy-MM-dd');
                if (!dailyNetChanges[dateStr]) dailyNetChanges[dateStr] = 0;
                dailyNetChanges[dateStr] -= baseExpense.amount;
            }

            // Move to the next occurrence
            if (baseExpense.frequency === 'weekly') idealDate = addWeeks(idealDate, 1);
            else if (baseExpense.frequency === 'monthly') idealDate = addMonths(idealDate, 1);
            else if (baseExpense.frequency === 'yearly') idealDate = addYears(idealDate, 1);
            else break;
        }
    });

    // --- Build the chart data using the reliable daily groups ---
    const labels = [];
    const data = [];
    let currentBalance = parseFloat(disposableIncome);

    for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
        const dateStr = format(d, 'yyyy-MM-dd');
        labels.push(dateStr);
        
        // If there was a net change on this day, apply it to the balance
        if (dailyNetChanges[dateStr]) {
            currentBalance += dailyNetChanges[dateStr];
        }
        
        data.push(currentBalance.toFixed(2));
    }

    return { labels, data };
}

main();