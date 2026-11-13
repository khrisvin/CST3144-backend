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

function sendError(res, error) {
    console.error(error.message);

    const status = [400, 404, 409].includes(error.status)
        ? error.status
        : 500;

    res.status(status).json({
        message: status === 500
            ? 'The request could not be completed. Please check its status.'
            : error.message
    });
}

function publicOrder(order) {
    return {
        id: order._id.toString(),
        name: order.name,
        phone: order.phone,
        lessonIds: order.lessonIds,
        spaces: order.spaces,
        status: order.status
    };
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

        const lessons = db.collection('lessons');
        const orders = db.collection('orders');

        await lessons.createIndex({ id: 1 }, { unique: true });

        console.log(`Connected to MongoDB: ${database}`);

        app.get('/', (req, res) => {
            res.send('After-School Lessons backend is running.');
        });

        // Return the current lesson data.
        app.get('/lessons', async (req, res) => {
            try {
                const result = await lessons
                    .find({}, { projection: { _id: 0 } })
                    .sort({ id: 1 })
                    .toArray();

                res.set('Cache-Control', 'no-store');
                res.json(result);
            } catch (error) {
                sendError(res, error);
            }
        });

        // Update editable attributes of one lesson.
        app.put('/lessons/:id', async (req, res) => {
            try {
                const id = Number(req.params.id);

                if (
                    !/^[0-9]+$/.test(req.params.id) ||
                    !Number.isSafeInteger(id)
                ) {
                    throw requestError(400, 'Invalid lesson ID.');
                }

                const body = req.body;

                if (
                    !body ||
                    typeof body !== 'object' ||
                    Array.isArray(body)
                ) {
                    throw requestError(400, 'Provide a JSON object.');
                }

                const allowed = [
                    'subject', 'location', 'price', 'spaces', 'icon'
                ];

                const fields = Object.keys(body);

                if (
                    fields.length === 0 ||
                    fields.some(field => !allowed.includes(field))
                ) {
                    throw requestError(
                        400,
                        'Update subject, location, price, spaces or icon only.'
                    );
                }

                const updates = {};

                for (const field of fields) {
                    const value = body[field];

                    if (['subject', 'location', 'icon'].includes(field)) {
                        if (
                            typeof value !== 'string' ||
                            !value.trim()
                        ) {
                            throw requestError(
                                400,
                                `${field} must be a non-empty string.`
                            );
                        }

                        updates[field] = value.trim();
                    }

                    if (field === 'price') {
                        if (
                            typeof value !== 'number' ||
                            !Number.isFinite(value) ||
                            value < 0
                        ) {
                            throw requestError(
                                400,
                                'Price must be a non-negative number.'
                            );
                        }

                        updates.price = value;
                    }

                    if (field === 'spaces') {
                        if (!Number.isSafeInteger(value) || value < 0) {
                            throw requestError(
                                400,
                                'Spaces must be a non-negative integer.'
                            );
                        }

                        updates.spaces = value;
                    }
                }

                const result = await lessons.updateOne(
                    { id },
                    { $set: updates }
                );

                if (result.matchedCount === 0) {
                    throw requestError(404, 'Lesson not found.');
                }

                res.json({
                    message: 'Lesson updated successfully.',
                    id,
                    updatedFields: updates,
                    modified: result.modifiedCount === 1
                });
            } catch (error) {
                sendError(res, error);
            }
        });

        // Save an order first. Spaces are changed by the PUT route.
        app.post('/orders', async (req, res) => {
            try {
                const { name, phone, lessonIds } = req.body || {};

                const validName =
                    typeof name === 'string' &&
                    /^[A-Za-z]+$/.test(name);

                const validPhone =
                    typeof phone === 'string' &&
                    /^[0-9]+$/.test(phone);

                const validIds =
                    Array.isArray(lessonIds) &&
                    lessonIds.length > 0 &&
                    lessonIds.every(id => Number.isSafeInteger(id));

                if (!validName || !validPhone || !validIds) {
                    throw requestError(
                        400,
                        'Provide a valid name, phone and lesson IDs.'
                    );
                }

                const uniqueIds = [...new Set(lessonIds)];

                const found = await lessons
                    .find(
                        { id: { $in: uniqueIds } },
                        { projection: { id: 1 } }
                    )
                    .toArray();

                if (found.length !== uniqueIds.length) {
                    throw requestError(
                        400,
                        'One or more lessons do not exist.'
                    );
                }

                const order = {
                    _id: new ObjectId(),
                    name,
                    phone,
                    lessonIds: [...lessonIds],
                    spaces: lessonIds.length,
                    status: 'pending',
                    createdAt: new Date()
                };

                await orders.insertOne(order);

                res.status(201).json({
                    message: 'Order saved; availability confirmation required.',
                    order: publicOrder(order)
                });
            } catch (error) {
                sendError(res, error);
            }
        });

        // Set absolute space counts after an order has been submitted.
        // All lesson updates and order confirmation succeed together.
        app.put('/orders/:id/confirm', async (req, res) => {
            try {
                if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
                    throw requestError(400, 'Invalid order ID.');
                }

                const orderId = new ObjectId(req.params.id);
                const updates = req.body?.lessonUpdates;

                if (
                    !Array.isArray(updates) ||
                    updates.length === 0 ||
                    !updates.every(update =>
                        update &&
                        Number.isSafeInteger(update.id) &&
                        Number.isSafeInteger(update.spaces) &&
                        update.spaces >= 0
                    )
                ) {
                    throw requestError(
                        400,
                        'Provide lessonUpdates with lesson IDs and remaining spaces.'
                    );
                }

                const updateMap = new Map(
                    updates.map(update => [update.id, update.spaces])
                );

                if (updateMap.size !== updates.length) {
                    throw requestError(
                        400,
                        'Each lesson must appear only once in lessonUpdates.'
                    );
                }

                const confirmedOrder = await client.withSession(
                    async session => {
                        return session.withTransaction(async () => {
                            const order = await orders.findOne(
                                { _id: orderId },
                                { session }
                            );

                            if (!order) {
                                throw requestError(404, 'Order not found.');
                            }

                            // A repeated confirmation must not deduct again.
                            if (order.status === 'confirmed') {
                                return publicOrder(order);
                            }

                            if (order.status !== 'pending') {
                                throw requestError(
                                    409,
                                    'This order cannot be confirmed by this route.'
                                );
                            }

                            const quantities = new Map();

                            for (const id of order.lessonIds) {
                                quantities.set(
                                    id,
                                    (quantities.get(id) || 0) + 1
                                );
                            }

                            if (
                                quantities.size !== updateMap.size ||
                                [...quantities.keys()].some(
                                    id => !updateMap.has(id)
                                )
                            ) {
                                throw requestError(
                                    400,
                                    'Updates must match the lessons in the order.'
                                );
                            }

                            for (const [id, quantity] of quantities) {
                                const lesson = await lessons.findOne(
                                    { id },
                                    { session }
                                );

                                if (!lesson) {
                                    throw requestError(
                                        409,
                                        `Lesson ${id} is no longer available.`
                                    );
                                }

                                if (
                                    !Number.isSafeInteger(lesson.spaces) ||
                                    lesson.spaces < quantity
                                ) {
                                    throw requestError(
                                        409,
                                        `Not enough spaces for ${lesson.subject}.`
                                    );
                                }

                                const remaining = updateMap.get(id);

                                // Reject stale or incorrect client calculations.
                                if (remaining !== lesson.spaces - quantity) {
                                    throw requestError(
                                        409,
                                        'Availability changed. Refresh it before confirming.'
                                    );
                                }

                                const result = await lessons.updateOne(
                                    { id, spaces: lesson.spaces },
                                    { $set: { spaces: remaining } },
                                    { session }
                                );

                                if (result.modifiedCount !== 1) {
                                    throw requestError(
                                        409,
                                        'Availability changed. Please refresh it.'
                                    );
                                }
                            }

                            await orders.updateOne(
                                { _id: orderId, status: 'pending' },
                                {
                                    $set: {
                                        status: 'confirmed',
                                        confirmedAt: new Date()
                                    }
                                },
                                { session }
                            );

                            return publicOrder({
                                ...order,
                                status: 'confirmed'
                            });
                        }, {
                            readPreference: 'primary',
                            readConcern: { level: 'snapshot' },
                            writeConcern: { w: 'majority' }
                        });
                    }
                );

                res.json({
                    message: 'Order confirmed and lesson spaces updated.',
                    order: confirmedOrder
                });
            } catch (error) {
                sendError(res, error);
            }
        });

        app.use((error, req, res, next) => {
            if (error.type === 'entity.parse.failed') {
                return res.status(400).json({
                    message: 'Request body must contain valid JSON.'
                });
            }

            sendError(res, error);
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
                    console.error(error.message);
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