const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { connectDB, getClient } = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const proposalRoutes = require("./routes/proposals");
const invitationRoutes = require("./routes/invitations");

const app = express();

// Middleware
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://skill-nest-client-five.vercel.app",
  "https://skillnest.vercel.app",
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));
app.use(express.json());

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/proposals", proposalRoutes);
app.use("/api/invitations", invitationRoutes);

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
