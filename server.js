const path = require('path');
const dns = require('node:dns');

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

        // GET: retrieve all lessons.
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

        // PUT: update one or more editable lesson attributes.
        app.put('/lessons/:id', async (req, res) => {
            const id = Number(req.params.id);

            if (
                !/^[0-9]+$/.test(req.params.id) ||
                !Number.isSafeInteger(id)
            ) {
                return res.status(400).json({
                    message: 'Lesson ID must be a valid integer.'
                });
            }

            const body = req.body;

            if (
                !body ||
                typeof body !== 'object' ||
                Array.isArray(body)
            ) {
                return res.status(400).json({
                    message: 'Provide a JSON object containing lesson updates.'
                });
            }

            const allowedFields = [
                'subject',
                'location',
                'price',
                'spaces',
                'icon'
            ];

            const fields = Object.keys(body);

            if (
                fields.length === 0 ||
                fields.some(field => !allowedFields.includes(field))
            ) {
                return res.status(400).json({
                    message:
                        'Provide at least one of: subject, location, ' +
                        'price, spaces or icon. Other fields are not allowed.'
                });
            }

            const updates = {};

            for (const field of fields) {
                const value = body[field];

                if (
                    field === 'subject' ||
                    field === 'location' ||
                    field === 'icon'
                ) {
                    if (
                        typeof value !== 'string' ||
                        value.trim().length === 0
                    ) {
                        return res.status(400).json({
                            message: `${field} must be a non-empty string.`
                        });
                    }

                    updates[field] = value.trim();
                }

                if (field === 'price') {
                    if (
                        typeof value !== 'number' ||
                        !Number.isFinite(value) ||
                        value < 0
                    ) {
                        return res.status(400).json({
                            message: 'Price must be a non-negative number.'
                        });
                    }

                    updates.price = value;
                }

                if (field === 'spaces') {
                    if (!Number.isSafeInteger(value) || value < 0) {
                        return res.status(400).json({
                            message: 'Spaces must be a non-negative integer.'
                        });
                    }

                    updates.spaces = value;
                }
            }

            try {
                const result = await lessonsCollection.updateOne(
                    { id },
                    { $set: updates }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({
                        message: 'Lesson not found.'
                    });
                }

                // An unchanged value is still a successful request.
                res.json({
                    message: 'Lesson updated successfully.',
                    id,
                    updatedFields: updates,
                    modified: result.modifiedCount === 1
                });
            } catch (error) {
                console.error('Error updating lesson:', error.message);

                res.status(500).json({
                    message: 'Could not update the lesson.'
                });
            }
        });

        // POST: save an order and reduce spaces together.
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