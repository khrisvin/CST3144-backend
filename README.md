# CST3144 After-School Lessons API

This is the backend for the CST3144 After-School Lessons shop. It uses Node.js, Express and MongoDB Atlas to list and search lessons, save orders and update available spaces when a booking is confirmed.

## Project links

- [Open the lesson shop](https://khrisvin.github.io/CST3144-COURSEWORK/)
- [View all lessons as JSON](https://m01003462-after-school.onrender.com/lessons)
- [Try a search for Moka](https://m01003462-after-school.onrender.com/lessons?q=moka)
- [Frontend repository](https://github.com/khrisvin/CST3144-COURSEWORK)
- [Backend repository](https://github.com/khrisvin/CST3144-backend)
- [Postman collection](./CST3144.postman_collection.json)

## API routes

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/` | Checks that the backend is running. |
| GET | `/lessons` | Returns all lessons and their available spaces, sorted by lesson ID. |
| GET | `/lessons?q=moka` | Searches by subject, location, price or available spaces. In the coursework catalogue, `moka` returns Art in Moka (ID `1006`). |
| PUT | `/lessons/:id` | Updates one or more fields of a lesson using its numeric ID. |
| POST | `/orders` | Creates a pending order and returns its order ID. Spaces are not deducted yet. |
| PUT | `/orders/:id/confirm` | Confirms a saved order and updates the spaces for all booked lessons in one MongoDB transaction. |

## Search

Search ignores capitalisation and supports partial matches. For example, `MOKA` matches the location `Moka`, and `ches` matches the subject `Chess`. An empty search returns the full catalogue. A search with no matches returns `[]`.

## Lesson updates

`PUT /lessons/:id` accepts `subject`, `location`, `price`, `spaces` or `icon`. Send only the fields you want to change. The price must be a non-negative number, and spaces must be a non-negative whole number.

For example, to set the price of Chess, send `PUT /lessons/1010` with this JSON body:

```json
{
  "price": 350
}
```

If the price is already `350`, the request succeeds and returns `"modified": false`.

## How booking works

1. Send `POST /orders` with the customer's name, phone number and lesson IDs. The name accepts English letters only. Send the phone number as a string containing digits only.
2. The backend saves the order with status `pending` and returns `order.id`. Each occurrence of a lesson ID represents one space.
3. Read the latest availability from `GET /lessons`. Send `PUT /orders/:id/confirm`, replacing `:id` with the returned order ID. Include one entry per booked lesson with its expected remaining spaces.
4. The backend checks the quantities against the saved order and the database. If availability has changed, it returns `409` without partially updating the booking. Retrying an already confirmed order does not deduct spaces twice.

Example body for `POST /orders`:

```json
{
  "name": "PostmanTest",
  "phone": "12345678",
  "lessonIds": [1010]
}
```

Example confirmation body **if Chess currently has 4 spaces** and the order books 1:

```json
{
  "lessonUpdates": [
    { "id": 1010, "spaces": 3 }
  ]
}
```

## Run locally on Windows

1. Open PowerShell in the `CST3144-backend` folder and install the dependencies:

   ```powershell
   npm.cmd ci
   ```

2. Create a private file named `config.env` in the same folder as `server.js`. Set these four variables using your own Atlas database credentials:

   ```dotenv
   MONGODB_USERNAME=your_database_username
   MONGODB_PASSWORD=your_database_password
   MONGODB_HOST=your_cluster_hostname
   MONGODB_DATABASE=cst3144_coursework
   ```

   For `MONGODB_HOST`, enter only the cluster hostname, without `mongodb+srv://`. Keep `config.env` out of Git.

3. Add your current public IP address to the MongoDB Atlas project's IP Access List. If your public IP changes, update the list before connecting again.

4. If you are setting up an empty database, import the 10 lessons:

   ```powershell
   node import-lessons.js
   ```

5. Start the backend and leave the terminal open:

   ```powershell
   npm.cmd start
   ```

6. Open [the local catalogue](http://localhost:3000/lessons), then [the local Moka search](http://localhost:3000/lessons?q=moka). With the supplied lesson data, the catalogue returns 10 lessons and the search returns only Art.

## Test with Postman

Import `CST3144.postman_collection.json` into Postman. It contains five saved requests:

1. List all lessons
2. Create order
3. Update lesson
4. Confirm order
5. Search lessons by location

To test without changing data, run **Search lessons by location**. Expect `200 OK` and one lesson: **Art**, ID `1006`, location **Moka**.

To test a new booking, run **Create order** first. Use the new order ID in **Confirm order** and calculate the remaining spaces from the latest catalogue response. Confirming a booking against the live API changes the live database.
## Teachers and enrolment

| Method | Route | What it returns |
| --- | --- | --- |
| GET | `/teachers` | Lists teachers with their names and the lesson IDs they teach. |
| GET | `/enrolment/:id` | Returns the number of confirmed spaces booked for the lesson ID. Pending orders do not count. |

Try the live API: [List all teachers](https://m01003462-after-school.onrender.com/teachers) or [Check Chess enrolment](https://m01003462-after-school.onrender.com/enrolment/1010).
