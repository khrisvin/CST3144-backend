const express = require('express');
const cors = require('cors');
const lessons = require('./lessons.json');

const app = express();

const port = process.env.PORT || 3000;

app.use(cors());

app.get('/', (req, res) => {
    res.send('After-School Lessons backend is running.');
});

app.get('/lessons', (req, res) => {
    res.json(lessons);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});