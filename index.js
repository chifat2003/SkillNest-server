const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { connectDB, getClient } = require("./config/db");
const authRoutes = require("./routes/authRoutes");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use("/api/auth", authRoutes);

// Health Check Routes
app.get("/", (req, res) => {
  res.send("SkillNest Server is running 🚀");
});

app.get("/ping", (req, res) => {
  const client = getClient();
  const dbStatus = client && client.topology && client.topology.isConnected()
    ? "connected"
    : "disconnected";

  res.json({
    status: "ok",
    message: "pong 🏓",
    mongodb: dbStatus,
  });
});

// Start Server after Database Connection
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});