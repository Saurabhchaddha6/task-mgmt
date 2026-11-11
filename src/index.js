
import express from "express";
import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import pg from "pg";
import { createClient } from "redis";
import dotenv from "dotenv";

dotenv.config();


const app = express();
app.use(express.json());

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Initialize Redis first
const redis = createClient({
  url: process.env.REDIS_URL,
});

redis.on("error", (err) => {
  console.log("Redis error:", err);
});

// Initialize rate limiter after Redis
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,

  store: new RedisStore({
    sendCommand: (...args) => redis.sendCommand(args),
  }),

  message: {
    status: "error",
    message: "Too many requests. Please try again later.",
  },
});

app.use("/tasks", limiter);
// Health check
app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    await redis.ping();

    res.json({
      status: "OK",
      database: "connected",
      redis: "connected",
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message,
    });
  }
});

// Create task
app.post("/tasks", async (req, res) => {
  try {
    const { title } = req.body;

    if (!title) {
      return res.status(400).json({
        message: "Title is required",
      });
    }

    const result = await db.query(
      "INSERT INTO tasks (title) VALUES ($1) RETURNING *",
      [title]
    );

    await redis.del("tasks");

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all tasks (Redis caching)
app.get("/tasks", async (req, res) => {
  try {
    const cachedTasks = await redis.get("tasks");

    if (cachedTasks) {
      return res.json({
        source: "Redis",
        tasks: JSON.parse(cachedTasks),
      });
    }

    const result = await db.query(
      "SELECT * FROM tasks ORDER BY id DESC"
    );

    await redis.set("tasks", JSON.stringify(result.rows), {
      EX: 60,
    });

    res.json({
      source: "PostgreSQL",
      tasks: result.rows,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get single task
app.get("/tasks/:id", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM tasks WHERE id = $1",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update task
app.patch("/tasks/:id", async (req, res) => {
  try {
    const { title, completed } = req.body;

    const result = await db.query(
      `UPDATE tasks
       SET title = COALESCE($1, title),
           completed = COALESCE($2, completed)
       WHERE id = $3
       RETURNING *`,
      [title ?? null, completed ?? null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    await redis.del("tasks");

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete task
app.delete("/tasks/:id", async (req, res) => {
  try {
    const result = await db.query(
      "DELETE FROM tasks WHERE id = $1 RETURNING *",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Task not found" });
    }

    await redis.del("tasks");

    res.json({ message: "Task deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Start server
async function startServer() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await redis.connect();

    app.listen(process.env.PORT || 3000, () => {
      console.log("Server running on port 3000");
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
