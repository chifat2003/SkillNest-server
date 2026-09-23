const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken, authorizeRoles } = require("../middleware/authMiddleware");

const router = express.Router();

// ─── POST /api/invitations — Client sends invitation ─────────────────────────
router.post("/", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    const { freelancerId, projectId, message } = req.body;

    if (!freelancerId || !projectId || !message) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "freelancerId, projectId, and message are required." } });
    }
    if (!ObjectId.isValid(freelancerId) || !ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid freelancerId or projectId." } });
    }

    const project = await db.collection("projects").findOne({ _id: new ObjectId(projectId), clientId: new ObjectId(req.user.id) });
    if (!project) {
      return res.status(404).json({ success: false, error: { code: "PROJECT_NOT_FOUND", message: "Project not found or not owned by you." } });
    }

    const existing = await db.collection("invitations").findOne({
      projectId: new ObjectId(projectId),
      freelancerId: new ObjectId(freelancerId),
      status: "Pending",
    });
    if (existing) {
      return res.status(400).json({ success: false, error: { code: "DUPLICATE_INVITATION", message: "An active invitation already exists for this freelancer." } });
    }

    const invitation = {
      projectId: new ObjectId(projectId),
      clientId: new ObjectId(req.user.id),
      freelancerId: new ObjectId(freelancerId),
      message,
      status: "Pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("invitations").insertOne(invitation);
    return res.status(201).json({ success: true, data: { _id: result.insertedId, ...invitation }, message: "Invitation sent." });
  } catch (err) {
    console.error("Send Invitation Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/invitations — List invitations (role-scoped) ───────────────────
router.get("/", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 10, status } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const filter = {};
    if (req.user.role === "Client") filter.clientId = new ObjectId(req.user.id);
    else if (req.user.role === "Freelancer") filter.freelancerId = new ObjectId(req.user.id);

    const validStatuses = ["Pending", "Accepted", "Declined", "Withdrawn"];
    if (status && validStatuses.includes(status)) filter.status = status;

    const [invitations, total] = await Promise.all([
      db.collection("invitations").find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
      db.collection("invitations").countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: invitations,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("List Invitations Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/invitations/:id — Get single invitation ────────────────────────
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Invitation not found." } });
    }

    const invitation = await db.collection("invitations").findOne({ _id: new ObjectId(req.params.id) });
    if (!invitation) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Invitation not found." } });
    }

    const userId = new ObjectId(req.user.id);
    if (!invitation.clientId.equals(userId) && !invitation.freelancerId.equals(userId)) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    return res.json({ success: true, data: invitation });
  } catch (err) {
    console.error("Get Invitation Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── PATCH /api/invitations/:id/respond — Freelancer accepts or declines ─────
router.patch("/:id/respond", authenticateToken, authorizeRoles("Freelancer"), async (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;

    if (!["Accepted", "Declined"].includes(status)) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Status must be Accepted or Declined." } });
    }
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Invitation not found." } });
    }

    const invitation = await db.collection("invitations").findOne({ _id: new ObjectId(req.params.id) });
    if (!invitation) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Invitation not found." } });
    }
    if (!invitation.freelancerId.equals(new ObjectId(req.user.id))) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }
    if (invitation.status !== "Pending") {
      return res.status(400).json({ success: false, error: { code: "INVALID_STATUS", message: "Invitation is no longer pending." } });
    }

    await db.collection("invitations").updateOne({ _id: invitation._id }, { $set: { status, updatedAt: new Date() } });
    return res.json({ success: true, message: `Invitation ${status.toLowerCase()}.` });
  } catch (err) {
    console.error("Respond Invitation Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── PATCH /api/invitations/:id/withdraw — Client withdraws invitation ────────
router.patch("/:id/withdraw", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Invitation not found." } });
    }

    const invitation = await db.collection("invitations").findOne({ _id: new ObjectId(req.params.id) });
    if (!invitation) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Invitation not found." } });
    }
    if (!invitation.clientId.equals(new ObjectId(req.user.id))) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }
    if (invitation.status !== "Pending") {
      return res.status(400).json({ success: false, error: { code: "INVALID_STATUS", message: "Only pending invitations can be withdrawn." } });
    }

    await db.collection("invitations").updateOne({ _id: invitation._id }, { $set: { status: "Withdrawn", updatedAt: new Date() } });
    return res.json({ success: true, message: "Invitation withdrawn." });
  } catch (err) {
    console.error("Withdraw Invitation Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

module.exports = router;
