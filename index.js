const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { connectDB, getClient } = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const proposalRoutes = require("./routes/proposals");
const invitationRoutes = require("./routes/invitations");
const projectRoutes = require("./routes/projects");
const profileRoutes = require("./routes/profiles");
const contractRoutes = require("./routes/contracts");
const conversationRoutes = require("./routes/conversations");
const notificationRoutes = require("./routes/notifications");
const reviewRoutes = require("./routes/reviews");
const disputeRoutes = require("./routes/disputes");

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
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

app.use(express.json({ limit: "10mb" }));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/proposals", proposalRoutes);
app.use("/api/invitations", invitationRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/profiles", profileRoutes);
app.use("/api/contracts", contractRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/disputes", disputeRoutes);

// ─── Health Check Routes ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "SkillNest Server is running 🚀",
    version: "2.0.0",
    endpoints: [
      "/api/auth",
      "/api/projects",
      "/api/proposals",
      "/api/invitations",
      "/api/profiles",
      "/api/contracts",
      "/api/conversations",
      "/api/notifications",
      "/api/reviews",
      "/api/disputes",
    ],
  });
});

app.get("/ping", (req, res) => {
  const client = getClient();
  const dbStatus =
    client && client.topology && client.topology.isConnected()
      ? "connected"
      : "disconnected";

  res.json({ status: "ok", message: "pong 🏓", mongodb: dbStatus });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found." } });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 SkillNest Server running on port ${PORT}`);
    console.log(`📡 Routes: auth | projects | proposals | invitations | profiles | contracts | conversations | notifications | reviews | disputes`);
  });
});
