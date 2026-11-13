const path = require('path');
const dns = require('node:dns');

// Keep the DNS setting that worked on your computer.
dns.setServers(['8.8.8.8']);

require('dotenv').config({
    path: path.join(__dirname, 'config.env')
});

const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

async function startServer() {
    const username = process.env.MONGODB_USERNAME;
    const password = process.env.MONGODB_PASSWORD;
    const host = process.env.MONGODB_HOST;
    const database = process.env.MONGODB_DATABASE;

    if (!username || !password || !host || !database) {
        console.error('Missing MongoDB settings in config.env.');
        process.exitCode = 1;
        return;
    }

    const uri =
        `mongodb+srv://${encodeURIComponent(username)}:` +
        `${encodeURIComponent(password)}@${host}/`;

    const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000
    });

    try {
        await client.connect();

        const db = client.db(database);
        await db.command({ ping: 1 });

        const lessonsCollection = db.collection('lessons');
        const ordersCollection = db.collection('orders');

        console.log(`Connected to MongoDB: ${database}`);

        app.get('/', (req, res) => {
            res.send('After-School Lessons backend is running.');
        });

        // Read lessons from MongoDB.
        app.get('/lessons', async (req, res) => {
            try {
                const lessons = await lessonsCollection
                    .find({}, { projection: { _id: 0 } })
                    .sort({ id: 1 })
                    .toArray();

                res.json(lessons);
            } catch (error) {
                console.error('Error loading lessons:', error.message);

                res.status(500).json({
                    message: 'Could not load lessons. Please try again.'
                });
            }
        });

        // Validate and permanently save an order.
        app.post('/orders', async (req, res) => {
            const { name, phone, lessonIds } = req.body || {};

            const validName =
                typeof name === 'string' &&
                /^[A-Za-z]+$/.test(name);

            const validPhone =
                typeof phone === 'string' &&
                /^[0-9]+$/.test(phone);

            const validLessonIds =
                Array.isArray(lessonIds) &&
                lessonIds.length > 0 &&
                lessonIds.every(id => Number.isSafeInteger(id));

            if (!validName || !validPhone || !validLessonIds) {
                return res.status(400).json({
                    message: 'Provide a valid name, phone and lesson IDs.'
                });
            }

            try {
                // Repeated IDs represent multiple spaces for one lesson.
                const uniqueIds = [...new Set(lessonIds)];

                const matchingLessons = await lessonsCollection
                    .find(
                        { id: { $in: uniqueIds } },
                        { projection: { _id: 0, id: 1 } }
                    )
                    .toArray();

                const existingIds = new Set(
                    matchingLessons.map(lesson => lesson.id)
                );

                if (!uniqueIds.every(id => existingIds.has(id))) {
                    return res.status(400).json({
                        message: 'One or more lesson IDs do not exist.'
                    });
                }

                const order = {
                    name,
                    phone,
                    lessonIds: [...lessonIds],
                    spaces: lessonIds.length
                };

                const result = await ordersCollection.insertOne(order);

                res.status(201).json({
                    message: 'Order received successfully.',
                    order: {
                        id: result.insertedId.toString(),
                        name: order.name,
                        phone: order.phone,
                        lessonIds: order.lessonIds,
                        spaces: order.spaces
                    }
                });
            } catch (error) {
                console.error('Error saving order:', error.message);

                res.status(500).json({
                    message: 'Could not confirm your order. Please try again.'
                });
            }
        });

        // Return JSON for malformed JSON request bodies.
        app.use((error, req, res, next) => {
            if (error.type === 'entity.parse.failed') {
                return res.status(400).json({
                    message: 'Request body must contain valid JSON.'
                });
            }

            console.error('Request error:', error.message);

            res.status(500).json({
                message: 'An unexpected server error occurred.'
            });
        });

        const server = app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });

        server.on('error', async error => {
            console.error('Server failed to start:', error.message);
            process.exitCode = 1;
            await client.close();
        });

        // Close the database connection when stopping the server.
        let stopping = false;

        function shutdown() {
            if (stopping) return;
            stopping = true;

            console.log('\nStopping server...');

            server.close(async () => {
                try {
                    await client.close();
                } catch (error) {
                    console.error('Error closing MongoDB:', error.message);
                    process.exitCode = 1;
                }
            });
        }

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    } catch (error) {
        console.error('MongoDB connection failed:', error.message);
        process.exitCode = 1;
        await client.close();
    }
}

startServer();