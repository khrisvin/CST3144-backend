const path = require('node:path');
const dns = require('node:dns');
const { MongoClient } = require('mongodb');
const teachers = require('./teachers.json');

require('dotenv').config({ path: path.join(__dirname, 'config.env') });
dns.setServers(['8.8.8.8']);

async function importTeachers() {
    const {
        MONGODB_USERNAME: username,
        MONGODB_PASSWORD: password,
        MONGODB_HOST: host,
        MONGODB_DATABASE: database
    } = process.env;

    if (!username || !password || !host || !database) {
        throw new Error('Missing MongoDB settings in config.env.');
    }

    const uri =
        `mongodb+srv://${encodeURIComponent(username)}:` +
        `${encodeURIComponent(password)}@${host}/`;

    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

    try {
        await client.connect();
        const db = client.db(database);

        // Check that all the lessons exist before saving the teachers.
        const lessonIds = [...new Set(teachers.flatMap(t => t.lessonIds))];
        const found = await db.collection('lessons').countDocuments({
            id: { $in: lessonIds }
        });

        if (found !== lessonIds.length) {
            throw new Error('A teacher references a lesson that does not exist.');
        }

        const collection = db.collection('teachers');
        await collection.createIndex({ id: 1 }, { unique: true });

        // Match by ID so a second import updates teachers without duplicating them.
        const result = await collection.bulkWrite(
            teachers.map(teacher => ({
                updateOne: {
                    filter: { id: teacher.id },
                    update: { $set: teacher },
                    upsert: true
                }
            }))
        );

        console.log(`Database: ${database}`);
        console.log(`New teachers inserted: ${result.upsertedCount}`);
        console.log(`Existing teachers matched: ${result.matchedCount}`);
        console.log(`Total teachers: ${await collection.countDocuments()}`);
    } finally {
        await client.close();
    }
}

importTeachers().catch(error => {
    console.error('Teacher import failed:', error.message);
    process.exitCode = 1;
});