const path = require('path');
const dns = require('node:dns');

// DNS setting that worked on your computer.
dns.setServers(['8.8.8.8']);

require('dotenv').config({
    path: path.join(__dirname, 'config.env')
});

const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function requestError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

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

        await lessonsCollection.createIndex(
            { id: 1 },
            { unique: true }
        );

        console.log(`Connected to MongoDB: ${database}`);

        app.get('/', (req, res) => {
            res.send('After-School Lessons backend is running.');
        });

        app.get('/lessons', async (req, res) => {
            try {
                const lessons = await lessonsCollection
                    .find({}, { projection: { _id: 0 } })
                    .sort({ id: 1 })
                    .toArray();

                res.set('Cache-Control', 'no-store');
                res.json(lessons);
            } catch (error) {
                console.error('Error loading lessons:', error.message);

                res.status(500).json({
                    message: 'Could not load lessons. Please try again.'
                });
            }
        });

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

            // Count how many spaces are requested for each lesson.
            const quantities = new Map();

            for (const id of lessonIds) {
                quantities.set(id, (quantities.get(id) || 0) + 1);
            }

            const order = {
                _id: new ObjectId(),
                name,
                phone,
                lessonIds: [...lessonIds],
                spaces: lessonIds.length,
                createdAt: new Date()
            };

            try {
                await client.withSession(async session => {
                    await session.withTransaction(async () => {
                        // Run transaction operations sequentially.
                        for (const [id, quantity] of quantities) {
                            const lesson = await lessonsCollection.findOne(
                                { id },
                                { session }
                            );

                            if (!lesson) {
                                throw requestError(
                                    400,
                                    `Lesson ${id} does not exist.`
                                );
                            }

                            if (
                                !Number.isInteger(lesson.spaces) ||
                                lesson.spaces < quantity
                            ) {
                                throw requestError(
                                    409,
                                    `Not enough spaces for ${lesson.subject}.`
                                );
                            }

                            // Only reduce spaces if enough remain.
                            const result =
                                await lessonsCollection.updateOne(
                                    {
                                        id,
                                        spaces: { $gte: quantity }
                                    },
                                    {
                                        $inc: { spaces: -quantity }
                                    },
                                    { session }
                                );

                            if (result.modifiedCount !== 1) {
                                throw requestError(
                                    409,
                                    `Availability changed for ${lesson.subject}.`
                                );
                            }
                        }

                        // The order and space changes commit together.
                        await ordersCollection.insertOne(order, {
                            session
                        });
                    }, {
                        readPreference: 'primary',
                        readConcern: { level: 'snapshot' },
                        writeConcern: { w: 'majority' }
                    });
                });

                res.status(201).json({
                    message: 'Order received successfully.',
                    order: {
                        id: order._id.toString(),
                        name: order.name,
                        phone: order.phone,
                        lessonIds: order.lessonIds,
                        spaces: order.spaces
                    }
                });
            } catch (error) {
                console.error('Error saving order:', error.message);

                const status =
                    error.status === 400 || error.status === 409
                        ? error.status
                        : 500;

                res.status(status).json({
                    message: status === 500
                        ? 'Could not confirm your order.'
                        : error.message
                });
            }
        });

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

        let stopping = false;

        function shutdown() {
            if (stopping) return;
            stopping = true;

            console.log('\nStopping server...');

            server.close(async () => {
                try {
                    await client.close();
                } catch (error) {
                    console.error(
                        'Error closing MongoDB:',
                        error.message
                    );
                    process.exitCode = 1;
                }
            });
        }

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    } catch (error) {
        console.error('Startup failed:', error.message);
        process.exitCode = 1;
        await client.close();
    }
}

startServer();