const path = require('node:path');
const dns = require('node:dns');
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

require('dotenv').config({
    path: path.join(__dirname, 'config.env')
});

// Use the DNS resolver that worked for this project's Atlas connection.
dns.setServers(['8.8.8.8']);

const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

app.use(cors());
app.use(express.json());

app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

app.use('/images', (req, res) => {
    res.status(404).json({ message: 'Lesson image not found.' });
});

function requestError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
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

function countSpacesByLesson(lessonIds) {
    const quantities = new Map();

    for (const id of lessonIds) {
        quantities.set(id, (quantities.get(id) || 0) + 1);
    }

    return quantities;
}

function validateLessonUpdates(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw requestError(400, 'Provide a JSON object.');
    }

    const allowed = ['subject', 'location', 'price', 'spaces', 'icon'];
    const fields = Object.keys(body);

    if (!fields.length || fields.some(field => !allowed.includes(field))) {
        throw requestError(
            400,
            'Update subject, location, price, spaces or icon only.'
        );
    }

    const updates = {};

    for (const field of fields) {
        const value = body[field];

        if (field === 'spaces') {
            if (!Number.isSafeInteger(value) || value < 0) {
                throw requestError(400, 'Spaces must be a non-negative integer.');
            }

            updates.spaces = value;
        } else if (field === 'price') {
            if (!Number.isFinite(value) || value < 0) {
                throw requestError(400, 'Price must be a non-negative number.');
            }

            updates.price = value;
        } else {
            if (typeof value !== 'string' || !value.trim()) {
                throw requestError(400, `${field} must be a non-empty string.`);
            }

            updates[field] = value.trim();
        }
    }

    return updates;
}

async function startServer() {
    const {
        MONGODB_USERNAME: username,
        MONGODB_PASSWORD: password,
        MONGODB_HOST: host,
        MONGODB_DATABASE: database
    } = process.env;

    if (!username || !password || !host || !database) {
        throw new Error('Missing MongoDB settings. Check your environment variables.');
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

        // GET /lessons returns the full catalogue.
        // GET /lessons?q=moka returns lessons matching "moka".
        app.get('/lessons', async (req, res, next) => {
            try {
                const query = String(req.query.q || '').trim().toLowerCase();

                const rows = await lessons
                    .find({}, { projection: { _id: 0 } })
                    .sort({ id: 1 })
                    .toArray();

                const matches = query
                    ? rows.filter(lesson =>
                        [lesson.subject, lesson.location, lesson.price, lesson.spaces]
                            .some(value => String(value).toLowerCase().includes(query))
                    )
                    : rows;

                res.set('Cache-Control', 'no-store').json(matches);
            } catch (error) {
                next(error);
            }
        });
                // Count purchased spaces for one lesson across confirmed orders.
        app.get('/enrolment/:lessonid', async (req, res, next) => {
            try {
                const rawId = req.params.lessonid;
                const lessonId = Number(rawId);

                if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(lessonId)) {
                    throw requestError(400, 'Invalid lesson ID.');
                }

                const lesson = await lessons.findOne(
                    { id: lessonId },
                    { projection: { _id: 1 } }
                );

                if (!lesson) {
                    throw requestError(404, 'Lesson not found.');
                }

                const [result] = await orders.aggregate([
                    { $match: { status: 'confirmed', lessonIds: lessonId } },
                    { $unwind: '$lessonIds' },
                    { $match: { lessonIds: lessonId } },
                    { $count: 'enrolment' }
                ]).toArray();

                res.set('Cache-Control', 'no-store').json({
                    lessonId,
                    enrolment: result?.enrolment ?? 0
                });
            } catch (error) {
                next(error);
            }
        });

        app.put('/lessons/:id', async (req, res, next) => {
            try {
                const id = Number(req.params.id);

                if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id)) {
                    throw requestError(400, 'Invalid lesson ID.');
                }

                const updates = validateLessonUpdates(req.body);
                const result = await lessons.updateOne(
                    { id },
                    { $set: updates }
                );

                if (!result.matchedCount) {
                    throw requestError(404, 'Lesson not found.');
                }

                res.json({
                    message: 'Lesson updated successfully.',
                    id,
                    updatedFields: updates,
                    modified: result.modifiedCount === 1
                });
            } catch (error) {
                next(error);
            }
        });

        // Save the order as pending. Spaces are deducted on confirmation.
        app.post('/orders', async (req, res, next) => {
            try {
                const { name, phone, lessonIds } = req.body || {};

                const validName =
                    typeof name === 'string' && /^[A-Za-z]+$/.test(name);

                const validPhone =
                    typeof phone === 'string' && /^[0-9]+$/.test(phone);

                const validLessons =
                    Array.isArray(lessonIds) &&
                    lessonIds.length > 0 &&
                    lessonIds.every(Number.isSafeInteger);

                if (!validName || !validPhone || !validLessons) {
                    throw requestError(400, 'Provide a valid name, phone and lesson IDs.');
                }

                const uniqueIds = [...new Set(lessonIds)];
                const found = await lessons.countDocuments({
                    id: { $in: uniqueIds }
                });

                if (found !== uniqueIds.length) {
                    throw requestError(400, 'One or more lessons do not exist.');
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
                next(error);
            }
        });

        // Confirm the order and update all its lessons in one transaction.
        app.put('/orders/:id/confirm', async (req, res, next) => {
            try {
                if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
                    throw requestError(400, 'Invalid order ID.');
                }

                const orderId = new ObjectId(req.params.id);
                const updates = req.body?.lessonUpdates;

                if (
                    !Array.isArray(updates) ||
                    updates.length === 0 ||
                    !updates.every(item =>
                        item &&
                        Number.isSafeInteger(item.id) &&
                        Number.isSafeInteger(item.spaces) &&
                        item.spaces >= 0
                    )
                ) {
                    throw requestError(
                        400,
                        'Provide lesson IDs and non-negative remaining spaces.'
                    );
                }

                const remainingById = new Map(
                    updates.map(item => [item.id, item.spaces])
                );

                if (remainingById.size !== updates.length) {
                    throw requestError(400, 'Include each lesson only once.');
                }

                const confirmed = await client.withSession(session =>
                    session.withTransaction(async () => {
                        const order = await orders.findOne(
                            { _id: orderId },
                            { session }
                        );

                        if (!order) {
                            throw requestError(404, 'Order not found.');
                        }

                        // A retry must not deduct the same spaces twice.
                        if (order.status === 'confirmed') {
                            return publicOrder(order);
                        }

                        if (order.status !== 'pending') {
                            throw requestError(409, 'This order cannot be confirmed.');
                        }

                        const quantities = countSpacesByLesson(order.lessonIds);

                        if (
                            quantities.size !== remainingById.size ||
                            [...quantities.keys()].some(id => !remainingById.has(id))
                        ) {
                            throw requestError(
                                400,
                                'Updates must match the lessons in the order.'
                            );
                        }

                        for (const [id, quantity] of quantities) {
                            const remaining = remainingById.get(id);

                            // To book 2 and leave 3, the database must still have 5.
                            const result = await lessons.updateOne(
                                { id, spaces: remaining + quantity },
                                { $set: { spaces: remaining } },
                                { session }
                            );

                            if (result.modifiedCount !== 1) {
                                throw requestError(
                                    409,
                                    `Availability changed for lesson ${id}. Refresh and try again.`
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

                        return publicOrder({ ...order, status: 'confirmed' });
                    }, {
                        readPreference: 'primary',
                        readConcern: { level: 'snapshot' },
                        writeConcern: { w: 'majority' }
                    })
                );

                res.json({
                    message: 'Order confirmed and lesson spaces updated.',
                    order: confirmed
                });
            } catch (error) {
                next(error);
            }
        });

        app.use((error, req, res, next) => {
            if (res.headersSent) return next(error);

            if (error.type === 'entity.parse.failed') {
                return res.status(400).json({
                    message: 'Request body must contain valid JSON.'
                });
            }

            console.error(error.message);

            const status = [400, 404, 409, 413].includes(error.status)
                ? error.status
                : 500;

            res.status(status).json({
                message: status === 500
                    ? 'The request could not be completed. Please check its status.'
                    : error.message
            });
        });

        const server = app.listen(port);

        server.once('listening', () => {
            console.log(`Server running on port ${port}`);
        });

        server.once('error', async error => {
            console.error('Server failed to start:', error.message);
            process.exitCode = 1;
            await client.close();
        });

        let stopping = false;

        function shutdown() {
            if (stopping) return;
            stopping = true;

            server.close(async () => {
                await client.close();
            });
        }

        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    } catch (error) {
        await client.close();
        throw error;
    }
}

startServer().catch(error => {
    console.error('Startup failed:', error.message);
    process.exitCode = 1;
});