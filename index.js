const express = require("express");
const { MongoClient } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

let db = null;
let client = null;

// Routes
app.get("/", (req, res) => {
  res.send("SkillNest Server is running 🚀");
});

app.get("/ping", (req, res) => {
  const dbStatus = client && client.topology && client.topology.isConnected()
    ? "connected"
    : "disconnected";

  res.json({
    status: "ok",
    message: "pong 🏓",
    mongodb: dbStatus,
  });
});

// MongoDB Connection
const connectDB = async () => {
  try {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log("✅ MongoDB connected successfully");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
};

// Export db for use in other modules
module.exports = { getDb: () => db };

// Start Server
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
  });
});
