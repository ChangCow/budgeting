const express = require('express');
const path = require('path');
const { addWeeks, addMonths, addYears, format, startOfDay, isEqual, subDays, isBefore, isToday, isAfter, differenceInWeeks, min, sub } = require('date-fns');
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
        // Calculate the average income
        const averageWeeklyIncome = await calculateAverageWeeklyIncome(db);

        // Pass the new data to the income page
        res.render('income', {
            allIncome,
            averageWeeklyIncome: averageWeeklyIncome.toFixed(2), // Pass the formatted average
            format
        });
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

    app.post('/adjust-balance', async (req, res) => {
        const { date, amount } = req.body;
        if (date && amount) {
            // Use INSERT OR REPLACE to either add a new adjustment or update an existing one for that date.
            const adjustmentDate = startOfDay(new Date(date + 'T00:00')).toISOString();
            await db.run(
                'INSERT OR REPLACE INTO balance_adjustments (date, amount) VALUES (?, ?)',
                [adjustmentDate, parseFloat(amount)]
            );
        }
        res.redirect('/graph');
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

async function calculateAverageWeeklyIncome(db) {
    const allIncome = await db.all('SELECT * FROM income ORDER BY date ASC');
    if (allIncome.length === 0) {
        return 0;
    }

    const totalIncome = allIncome.reduce((sum, inc) => sum + inc.amount, 0);
    const firstIncomeDate = new Date(allIncome[0].date);
    const today = new Date();

    // Get the number of weeks, ensuring it's at least 1 to avoid division by zero.
    const weeks = Math.max(1, differenceInWeeks(today, firstIncomeDate));

    return totalIncome / weeks;
}

async function calculateChartData(db, startDate, endDate) {
    // --- 1. SETUP & FETCH ALL DATA ---
    const allExpenses = await db.all('SELECT * FROM expenses');
    const allIncome = await db.all('SELECT * FROM income');
    const allAdjustments = await db.all('SELECT * FROM balance_adjustments');
    const averageWeeklyIncome = await calculateAverageWeeklyIncome(db);
    const today = startOfDay(new Date());

    // --- 2. DEFINE CHART'S DATE RANGE ---
    const rangeStart = startDate ? startOfDay(new Date(startDate)) : subDays(today, 30);
    const rangeEnd = endDate ? startOfDay(new Date(endDate)) : addMonths(today, 3);

    const firstExpenseDates = allExpenses.map(e => startOfDay(new Date(e.startDate)));
    const firstIncomeDates = allIncome.map(i => startOfDay(new Date(i.date)));
    const allTransactionDates = [...firstExpenseDates, ...firstIncomeDates];
    const historyStart = allTransactionDates.length > 0 ? min(allTransactionDates) : today;

    // --- 3. GROUP ALL REAL TRANSACTIONS BY DAY ---
    const dailyNetChanges = {};
    allIncome.forEach(inc => {
        const dateStr = format(startOfDay(new Date(inc.date)), 'yyyy-MM-dd');
        if (!dailyNetChanges[dateStr]) dailyNetChanges[dateStr] = 0;
        dailyNetChanges[dateStr] += inc.amount;
    });
    allExpenses.forEach(baseExpense => {
        let idealDate = startOfDay(new Date(baseExpense.startDate));
        const expenseEndDate = baseExpense.endDate ? startOfDay(new Date(baseExpense.endDate)) : null;
        const adjustments = JSON.parse(baseExpense.adjustments);
        while (idealDate <= rangeEnd && (!expenseEndDate || idealDate <= expenseEndDate)) {
            const adj = adjustments.find(a => isEqual(startOfDay(new Date(a.originalDate)), idealDate));
            const displayDate = adj ? startOfDay(new Date(adj.newDate)) : idealDate;
            if (displayDate <= rangeEnd) {
                const dateStr = format(displayDate, 'yyyy-MM-dd');
                if (!dailyNetChanges[dateStr]) dailyNetChanges[dateStr] = 0;
                dailyNetChanges[dateStr] -= baseExpense.amount;
            }
            if (baseExpense.frequency === 'weekly') idealDate = addWeeks(idealDate, 1);
            else if (baseExpense.frequency === 'monthly') idealDate = addMonths(idealDate, 1);
            else if (baseExpense.frequency === 'yearly') idealDate = addYears(idealDate, 1);
            else break;
        }
    });

    // --- 4. BUILD THE CHART DATA WITH ADJUSTMENTS & PREDICTIONS ---
    const labels = [];
    const data = [];
    let currentBalance = 0; // Start with a zero balance at the beginning of history

    for (let d = new Date(historyStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
        const currentDay = startOfDay(d);
        const dateStr = format(currentDay, 'yyyy-MM-dd');

        // Check for a manual balance adjustment for the *start* of this day
        const adjustment = allAdjustments.find(a => isEqual(startOfDay(new Date(a.date)), currentDay));
        if (adjustment) {
            // If an adjustment exists, override the running balance completely.
            currentBalance = adjustment.amount;
        }
        
        // Apply net change from any real transactions that occurred today
        if (dailyNetChanges[dateStr]) {
            currentBalance += dailyNetChanges[dateStr];
        }

        // For future Thursdays, add the estimated income if no real income was recorded
        const isFutureThursday = isAfter(currentDay, today) && currentDay.getDay() === 4;
        if (isFutureThursday) {
            const hasRealIncome = allIncome.some(inc => isEqual(startOfDay(new Date(inc.date)), currentDay));
            if (!hasRealIncome) {
                currentBalance += averageWeeklyIncome;
            }
        }
        
        if (currentDay >= rangeStart) {
            labels.push(dateStr);
            data.push(currentBalance.toFixed(2));
        }
    }

    return { labels, data };
}

main();