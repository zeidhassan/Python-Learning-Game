# Python Learning Game

A full-stack multiplayer web app that gamifies learning Python functions. Players move across a physical board by scanning QR code tiles and answering multiple-choice questions in real time.

---

## How It Works

1. An **admin** sets up a physical board with printed QR code tiles, each linked to a Python question.
2. A **host** creates a game room — players join using a 6-character room code.
3. Players take **turns** scanning a QR tile on the physical board, then answering the question assigned to it.
4. Points are awarded based on difficulty and speed. A live scoreboard updates in real time via WebSockets.
5. The game ends when all players have answered all questions, or the host manually finishes it.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, React Router DOM, Socket.IO client |
| Backend | Node.js, Express 5, Socket.IO |
| Database | PostgreSQL |
| Auth | express-session + bcrypt |
| Validation | Zod (client & server) |

---

## Project Structure

```
/
├── client/          # React frontend (Vite)
├── server/          # Express backend
│   ├── src/
│   │   ├── routes/  # Auth, rooms, questions, board tiles
│   │   ├── socket/  # Socket.IO event handlers
│   │   ├── utils/   # Room state, QR, formatting helpers
│   │   └── middleware/
│   └── sql/         # schema.sql, seed.sql, reset.sql
└── package.json     # Root scripts (runs both client & server)
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 12+

### 1. Clone the repo

```bash
git clone <repo-url>
cd "WebApp - Python Learning Game"
```

### 2. Install dependencies

```bash
npm install
npm --prefix client install
npm --prefix server install
```

### 3. Set up the database

Create a PostgreSQL database and run the schema:

```bash
psql -U <your-pg-user> -d <your-db-name> -f server/sql/schema.sql
psql -U <your-pg-user> -d <your-db-name> -f server/sql/seed.sql  # optional seed data
```

### 4. Configure environment variables

Create `server/.env`:

```env
PORT=4000
NODE_ENV=development
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<db-name>
SESSION_SECRET=your-secret-here
CLIENT_ORIGIN=http://localhost:5173
```

Create `client/.env.local`:

```env
VITE_API_URL=http://localhost:4000
```

### 5. Run the app

```bash
npm run dev
```

This starts both the frontend (`http://localhost:5173`) and backend (`http://localhost:4000`) concurrently.

---

## Scoring

| Difficulty | Base Points | Speed Bonus (< 15s) |
|---|---|---|
| Easy | 5 | +2 |
| Medium | 10 | +2 |
| Hard | 15 | +2 |

---

## API Overview

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Log in |
| POST | `/api/auth/logout` | Log out |
| GET | `/api/auth/me` | Current user |
| GET | `/api/questions` | List questions |
| POST | `/api/questions` | Create question (admin) |
| PATCH | `/api/questions/:id` | Update question (admin) |
| POST | `/api/rooms` | Create room |
| POST | `/api/rooms/:code/join` | Join room |
| POST | `/api/rooms/:code/start` | Start game (host) |
| POST | `/api/rooms/:code/scan` | Scan QR tile |
| POST | `/api/rooms/:code/attempts` | Submit answer |
| GET | `/api/board-tiles` | List board tiles (admin) |
| GET | `/api/board-tiles/print-sheet` | Generate QR print sheet |
| PATCH | `/api/board-tiles/:tileNumber` | Update tile (admin) |

---

## Database Schema

- **users** — email, hashed password, display name, role (`player` / `admin`)
- **questions** — prompt, difficulty, explanation, active flag
- **question_options** — multiple-choice options linked to questions
- **board_tiles** — tile number, QR payload, linked question
- **game_rooms** — room code, host, status (`lobby` / `active` / `finished`)
- **room_players** — player list per room, score, current tile, turn order
- **attempts** — answer records with correctness, response time, awarded points

To reset the database:

```bash
psql -U <your-pg-user> -d <your-db-name> -f server/sql/reset.sql
```
