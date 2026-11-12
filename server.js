const express = require('express');
const cors = require('cors');
const lessons = require('./lessons.json');

const app = express();

const port = process.env.PORT || 3000;

const orders = [];

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('After-School Lessons backend is running.');
});

app.get('/lessons', (req, res) => {
    res.json(lessons);
});

app.post('/orders', (req, res) => {
    const { name, phone, lessonIds } = req.body || {};

    const validName =
        typeof name === 'string' && /^[A-Za-z]+$/.test(name);

    const validPhone =
        typeof phone === 'string' && /^[0-9]+$/.test(phone);

    const validLessons =
        Array.isArray(lessonIds)
        && lessonIds.length > 0
        && lessonIds.every(id =>
            lessons.some(lesson => lesson.id === id)
        );

    if (!validName || !validPhone || !validLessons) {
        return res.status(400).json({
            message: 'Provide a valid name, phone and lesson IDs.'
        });
    }

    const order = {
        id: orders.length + 1,
        name,
        phone,
        lessonIds: [...lessonIds],
        spaces: lessonIds.length
    };

    orders.push(order);

    res.status(201).json({
        message: 'Order received successfully.',
        order
    });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});