const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken } = require("../middleware/authMiddleware");

const router = express.Router();

// ─── POST /api/reviews — Submit a review ─────────────────────────────────────
router.post("/", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { contractId, overallRating, communication, quality, professionalism, timeliness, comment } = req.body;

    if (!contractId || !overallRating) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "contractId and overallRating are required." } });
    }
    if (!ObjectId.isValid(contractId)) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid contractId." } });
    }

    const contract = await db.collection("contracts").findOne({ _id: new ObjectId(contractId) });
    if (!contract) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Contract not found." } });
    }
    if (contract.status !== "Completed") {
      return res.status(400).json({ success: false, error: { code: "INVALID_STATUS", message: "Reviews can only be submitted for completed contracts." } });
    }

    const uid = new ObjectId(req.user.id);
    const isClient = contract.clientId.equals(uid);
    const isFreelancer = contract.freelancerId.equals(uid);

    if (!isClient && !isFreelancer) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    const revieweeId = isClient ? contract.freelancerId : contract.clientId;

    // Prevent self-review
    if (uid.equals(revieweeId)) {
      return res.status(400).json({ success: false, error: { code: "SELF_REVIEW", message: "You cannot review yourself." } });
    }

    // Prevent duplicate review
    const existing = await db.collection("reviews").findOne({
      contractId: new ObjectId(contractId),
      reviewerId: uid,
    });
    if (existing) {
      return res.status(409).json({ success: false, error: { code: "DUPLICATE_REVIEW", message: "You have already reviewed this contract." } });
    }

    const rating = Math.min(5, Math.max(1, Number(overallRating)));

    const review = {
      contractId: new ObjectId(contractId),
      projectId: contract.projectId,
      reviewerId: uid,
      revieweeId,
      reviewerRole: req.user.role,
      overallRating: rating,
      communication: communication ? Math.min(5, Math.max(1, Number(communication))) : rating,
      quality: quality ? Math.min(5, Math.max(1, Number(quality))) : rating,
      professionalism: professionalism ? Math.min(5, Math.max(1, Number(professionalism))) : rating,
      timeliness: timeliness ? Math.min(5, Math.max(1, Number(timeliness))) : rating,
      comment: comment || "",
      createdAt: new Date(),
    };

    const result = await db.collection("reviews").insertOne(review);
    return res.status(201).json({ success: true, data: { _id: result.insertedId, ...review }, message: "Review submitted." });
  } catch (err) {
    console.error("Submit Review Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/reviews — List reviews (by user or contract) ───────────────────
router.get("/", async (req, res) => {
  try {
    const db = getDb();
    const { userId, contractId, role, page = 1, limit = 10 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const filter = {};
    if (userId && ObjectId.isValid(userId)) filter.revieweeId = new ObjectId(userId);
    if (contractId && ObjectId.isValid(contractId)) filter.contractId = new ObjectId(contractId);
    if (role) filter.reviewerRole = role;

    const [reviews, total] = await Promise.all([
      db.collection("reviews").find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
      db.collection("reviews").countDocuments(filter),
    ]);

    // Enrich with reviewer info
    const enriched = await Promise.all(reviews.map(async (r) => {
      const reviewer = await db.collection("users").findOne(
        { _id: r.reviewerId },
        { projection: { fullName: 1, avatar: 1 } }
      );
      return { ...r, reviewer };
    }));

    return res.json({
      success: true,
      data: enriched,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("List Reviews Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

module.exports = router;
