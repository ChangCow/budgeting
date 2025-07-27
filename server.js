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
    
    // Update Disposable Income
    app.post('/update-disposable-income', async (req, res) => {
        const { disposableIncome } = req.body;
        if (disposableIncome) {
            await db.run("UPDATE settings SET value = ? WHERE key = 'disposableIncome'", [parseFloat(disposableIncome)]);
            await db.run("UPDATE settings SET value = ? WHERE key = 'lastResetDate'", [new Date().toISOString()]);
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
    const lastResetDate = new Date((await db.get("SELECT value FROM settings WHERE key = 'lastResetDate'")).value);
    
    let rangeStart = startDate ? new Date(startDate) : subDays(new Date(), 30);
    let rangeEnd = endDate ? new Date(endDate) : new Date();

    rangeStart = rangeStart < lastResetDate ? lastResetDate : rangeStart;

    const allExpenses = await db.all('SELECT * FROM expenses WHERE startDate >= ?', [rangeStart.toISOString()]);
    const allIncome = await db.all('SELECT * FROM income WHERE date >= ?', [rangeStart.toISOString()]);

    let transactions = [];
    allIncome.forEach(inc => transactions.push({ date: new Date(inc.date), amount: inc.amount }));
    
    allExpenses.forEach(baseExpense => {
        baseExpense.startDate = new Date(baseExpense.startDate);
        baseExpense.endDate = baseExpense.endDate ? new Date(baseExpense.endDate) : null;
        baseExpense.adjustments = JSON.parse(baseExpense.adjustments);

        let idealDate = new Date(baseExpense.startDate);

        while(idealDate <= rangeEnd && (!baseExpense.endDate || idealDate <= baseExpense.endDate)) {
            if (idealDate >= rangeStart) {
                const adjustment = baseExpense.adjustments.find(adj => isEqual(new Date(adj.originalDate), idealDate));
                const displayDate = adjustment ? new Date(adjustment.newDate) : idealDate;
                transactions.push({ date: displayDate, amount: -baseExpense.amount });
            }

            if (baseExpense.frequency === 'weekly') idealDate = addWeeks(idealDate, 1);
            else if (baseExpense.frequency === 'monthly') idealDate = addMonths(idealDate, 1);
            else if (baseExpense.frequency === 'yearly') idealDate = addYears(idealDate, 1);
            else break;
        }
    });

    transactions.sort((a,b) => a.date - b.date);

    let labels = [];
    let data = [];
    let currentBalance = parseFloat((await db.get("SELECT value FROM settings WHERE key = 'disposableIncome'")).value);

    for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
        labels.push(format(d, 'yyyy-MM-dd'));
        let dailyNet = transactions.filter(t => isToday(t.date)).reduce((sum, t) => sum + t.amount, 0);
        currentBalance += dailyNet;
        data.push(currentBalance.toFixed(2));
    }

    return { labels, data };
}

main();