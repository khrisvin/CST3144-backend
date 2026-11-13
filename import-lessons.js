const path = require('path');
const dns = require('node:dns');

dns.setServers(['8.8.8.8']);

require('dotenv').config({
    path: path.join(__dirname, 'config.env')
});

const { MongoClient } = require('mongodb');
const lessons = require('./lessons.json');

async function importLessons() {
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
        if (!Array.isArray(lessons) || lessons.length === 0) {
            throw new Error('lessons.json must contain a non-empty array.');
        }

        const ids = new Set();

        for (const lesson of lessons) {
            if (
                !Number.isInteger(lesson.id) ||
                ids.has(lesson.id) ||
                typeof lesson.subject !== 'string' ||
                !lesson.subject.trim() ||
                typeof lesson.location !== 'string' ||
                !lesson.location.trim() ||
                !Number.isFinite(lesson.price) ||
                lesson.price < 0 ||
                !Number.isInteger(lesson.spaces) ||
                lesson.spaces < 0 ||
                typeof lesson.icon !== 'string'
            ) {
                throw new Error('Invalid lesson data or duplicate lesson ID.');
            }

            ids.add(lesson.id);
        }

        await client.connect();

        const collection = client
            .db(database)
            .collection('lessons');

        // Prevent multiple documents from sharing a lesson ID.
        await collection.createIndex({ id: 1 }, { unique: true });

        const operations = lessons.map(lesson => ({
            updateOne: {
                filter: { id: lesson.id },
                update: {
                    $setOnInsert: {
                        id: lesson.id,
                        subject: lesson.subject,
                        location: lesson.location,
                        price: lesson.price,
                        spaces: lesson.spaces,
                        icon: lesson.icon
                    }
                },
                upsert: true
            }
        }));

        const result = await collection.bulkWrite(operations);
        const total = await collection.countDocuments();

        console.log('Lesson import completed.');
        console.log(`New lessons inserted: ${result.upsertedCount}`);
        console.log(`Existing lessons kept: ${result.matchedCount}`);
        console.log(`Total lessons in database: ${total}`);
    } catch (error) {
        console.error('Lesson import failed:', error.message);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

importLessons();