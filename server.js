const express = require('express');
const path = require('path');
const { addWeeks, addMonths, addYears, format, startOfDay, isEqual, subDays, isBefore, isToday } = require('date-fns');
const setupDatabase = require('./database');

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

async function main() {
    const db = await setupDatabase();

    app.get('/', async (req, res) => {
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

        res.render('index', {
            allExpenses: allExpensesFromDb,
            recentBills,
            todaysBills,
            upcomingBills,
            format,
            formatForInput: (date) => format(date, "yyyy-MM-dd"),
            totalWeeklyExpense: totalWeeklyExpense.toFixed(2),
        });
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
        res.redirect('/');
    });

    app.post('/update', async (req, res) => {
        const { baseId, originalDateStr, newDateStr, propagate } = req.body;
        const cleanNewDate = new Date(newDateStr + 'T00:00');
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