# CST3144 After-School Lessons API

This Node.js and Express backend connects the lesson shop to MongoDB Atlas. It lists lessons, saves orders and updates available spaces when a booking is confirmed.

## Project links

- [Open the lesson shop](https://khrisvin.github.io/CST3144-COURSEWORK/)

- [View the live lessons as JSON](https://m01003462-after-school.onrender.com/lessons)

- [Frontend repository](https://github.com/khrisvin/CST3144-COURSEWORK)

- [Backend repository](https://github.com/khrisvin/CST3144-backend)

## API routes

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/` | Checks that the backend is running. |
| GET | `/lessons` | Lists lessons and their available spaces. |
| PUT | `/lessons/:id` | Updates a lesson by its numeric ID. |
| POST | `/orders` | Creates an order with a name, phone number and lesson IDs. |
| PUT | `/orders/:id/confirm` | Confirms the order and updates the remaining lesson spaces. |

## Run locally on Windows

1. Open PowerShell in the backend folder and run `npm.cmd ci`.

2. Create a private `config.env` file in that folder. Set `MONGODB_USERNAME`, `MONGODB_PASSWORD`, `MONGODB_HOST` and `MONGODB_DATABASE` for your Atlas database.

3. Add your current IP address to the Atlas IP Access List.

4. If the database is empty, run `node import-lessons.js` to load the 10 lessons.

5. Run `npm.cmd start` and open `http://localhost:3000/lessons` to see the catalogue.

Keep `config.env` out of Git so the database password stays private.

