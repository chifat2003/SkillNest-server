const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken } = require("../middleware/authMiddleware");

const router = express.Router();

const VALID_DISPUTE_STATUSES = ["Open", "Under Review", "Waiting for Client", "Waiting for Freelancer", "Resolved", "Closed"];

// ─── POST /api/disputes — Open a dispute ─────────────────────────────────────
router.post("/", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { contractId, reason, description } = req.body;

    if (!contractId || !reason || !description) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "contractId, reason, and description are required." } });
    }
    if (!ObjectId.isValid(contractId)) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid contractId." } });
    }

    const contract = await db.collection("contracts").findOne({ _id: new ObjectId(contractId) });
    if (!contract) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Contract not found." } });
    }

    const uid = new ObjectId(req.user.id);
    if (!contract.clientId.equals(uid) && !contract.freelancerId.equals(uid)) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    if (!["Active", "In Progress"].includes(contract.status)) {
      return res.status(400).json({ success: false, error: { code: "INVALID_STATUS", message: "Disputes can only be opened on active contracts." } });
    }

    // Check for existing open dispute
    const existing = await db.collection("disputes").findOne({
      contractId: new ObjectId(contractId),
      status: { $in: ["Open", "Under Review", "Waiting for Client", "Waiting for Freelancer"] },
    });
    if (existing) {
      return res.status(409).json({ success: false, error: { code: "DISPUTE_EXISTS", message: "An open dispute already exists for this contract." } });
    }

    const now = new Date();
    const dispute = {
      contractId: new ObjectId(contractId),
      projectId: contract.projectId,
      clientId: contract.clientId,
      freelancerId: contract.freelancerId,
      reporterId: uid,
      reason,
      description,
      status: "Open",
      evidence: [],
      messages: [],
      resolution: null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("disputes").insertOne(dispute);
    return res.status(201).json({ success: true, data: { _id: result.insertedId, ...dispute }, message: "Dispute opened." });
  } catch (err) {
    console.error("Open Dispute Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/disputes — List disputes for current user ──────────────────────
router.get("/", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 10, status } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const uid = new ObjectId(req.user.id);

    const filter = {
      $or: [{ clientId: uid }, { freelancerId: uid }],
    };
    if (status) filter.status = status;

    const [disputes, total] = await Promise.all([
      db.collection("disputes").find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
      db.collection("disputes").countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: disputes,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("List Disputes Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/disputes/:id — Get single dispute ───────────────────────────────
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Dispute not found." } });
    }

    const dispute = await db.collection("disputes").findOne({ _id: new ObjectId(req.params.id) });
    if (!dispute) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Dispute not found." } });
    }

    const uid = new ObjectId(req.user.id);
    if (!dispute.clientId.equals(uid) && !dispute.freelancerId.equals(uid)) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    const [contract, client, freelancer] = await Promise.all([
      db.collection("contracts").findOne({ _id: dispute.contractId }, { projection: { status: 1, amount: 1 } }),
      db.collection("users").findOne({ _id: dispute.clientId }, { projection: { fullName: 1, email: 1 } }),
      db.collection("users").findOne({ _id: dispute.freelancerId }, { projection: { fullName: 1, email: 1 } }),
    ]);

    return res.json({ success: true, data: { ...dispute, contract, client, freelancer } });
  } catch (err) {
    console.error("Get Dispute Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/disputes/:id/evidence — Add evidence ──────────────────────────
router.post("/:id/evidence", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Dispute not found." } });
    }

    const dispute = await db.collection("disputes").findOne({ _id: new ObjectId(req.params.id) });
    if (!dispute) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Dispute not found." } });
    }

    const uid = new ObjectId(req.user.id);
    if (!dispute.clientId.equals(uid) && !dispute.freelancerId.equals(uid)) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    if (["Resolved", "Closed"].includes(dispute.status)) {
      return res.status(400).json({ success: false, error: { code: "INVALID_STATUS", message: "Cannot add evidence to a resolved or closed dispute." } });
    }

    const { description, files } = req.body;
    if (!description) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "description is required." } });
    }

    const evidence = {
      _id: new ObjectId(),
      submittedBy: uid,
      role: req.user.role,
      description,
      files: Array.isArray(files) ? files : [],
      createdAt: new Date(),
    };

    await db.collection("disputes").updateOne(
      { _id: dispute._id },
      { $push: { evidence }, $set: { updatedAt: new Date() } }
    );

    return res.status(201).json({ success: true, data: evidence, message: "Evidence added." });
  } catch (err) {
    console.error("Add Evidence Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/disputes/:id/messages — Add message to dispute ────────────────
router.post("/:id/messages", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Dispute not found." } });
    }

    const dispute = await db.collection("disputes").findOne({ _id: new ObjectId(req.params.id) });
    if (!dispute) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Dispute not found." } });
    }

    const uid = new ObjectId(req.user.id);
    if (!dispute.clientId.equals(uid) && !dispute.freelancerId.equals(uid)) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "content is required." } });
    }

    const msg = {
      _id: new ObjectId(),
      senderId: uid,
      role: req.user.role,
      content,
      createdAt: new Date(),
    };

    await db.collection("disputes").updateOne(
      { _id: dispute._id },
      { $push: { messages: msg }, $set: { updatedAt: new Date() } }
    );

    return res.status(201).json({ success: true, data: msg, message: "Message added." });
  } catch (err) {
    console.error("Add Dispute Message Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

module.exports = router;
