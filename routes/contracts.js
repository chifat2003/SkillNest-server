const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken } = require("../middleware/authMiddleware");

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────
const notFound = (res) =>
  res.status(404).json({ success: false, error: { code: "CONTRACT_NOT_FOUND", message: "Contract not found." } });

const forbidden = (res) =>
  res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });

const badRequest = (res, message, code = "BAD_REQUEST") =>
  res.status(400).json({ success: false, error: { code, message } });

const getContract = async (db, contractId, userId) => {
  if (!ObjectId.isValid(contractId)) return null;
  const contract = await db.collection("contracts").findOne({ _id: new ObjectId(contractId) });
  if (!contract) return null;
  const uid = new ObjectId(userId);
  if (!contract.clientId.equals(uid) && !contract.freelancerId.equals(uid)) return null;
  return contract;
};

// ─── GET /api/contracts — List contracts for current user ────────────────────
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

    const [contracts, total] = await Promise.all([
      db.collection("contracts").find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
      db.collection("contracts").countDocuments(filter),
    ]);

    // Enrich with project + user info
    const enriched = await Promise.all(contracts.map(async (c) => {
      const [project, client, freelancer] = await Promise.all([
        db.collection("projects").findOne({ _id: c.projectId }, { projection: { title: 1, category: 1 } }),
        db.collection("users").findOne({ _id: c.clientId }, { projection: { fullName: 1, email: 1 } }),
        db.collection("users").findOne({ _id: c.freelancerId }, { projection: { fullName: 1, email: 1 } }),
      ]);
      return { ...c, project, client, freelancer };
    }));

    return res.json({
      success: true,
      data: enriched,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("List Contracts Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/contracts/:id — Get single contract ────────────────────────────
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const contract = await getContract(db, req.params.id, req.user.id);
    if (!contract) return notFound(res);

    const [project, client, freelancer] = await Promise.all([
      db.collection("projects").findOne({ _id: contract.projectId }),
      db.collection("users").findOne({ _id: contract.clientId }, { projection: { passwordHash: 0 } }),
      db.collection("users").findOne({ _id: contract.freelancerId }, { projection: { passwordHash: 0 } }),
    ]);

    return res.json({ success: true, data: { ...contract, project, client, freelancer } });
  } catch (err) {
    console.error("Get Contract Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/contracts/:id/milestones — Add milestone (Client) ─────────────
router.post("/:id/milestones", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const contract = await getContract(db, req.params.id, req.user.id);
    if (!contract) return notFound(res);

    if (!contract.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);
    if (!["Active"].includes(contract.status)) {
      return badRequest(res, "Milestones can only be added to active contracts.", "INVALID_STATUS");
    }

    const { title, description, amount, dueDate } = req.body;
    if (!title || !amount) {
      return badRequest(res, "title and amount are required.", "VALIDATION_ERROR");
    }

    const milestone = {
      _id: new ObjectId(),
      title,
      description: description || "",
      amount: Number(amount),
      dueDate: dueDate ? new Date(dueDate) : null,
      status: "Pending",
      funded: false,
      createdAt: new Date(),
    };

    await db.collection("contracts").updateOne(
      { _id: contract._id },
      { $push: { milestones: milestone }, $set: { updatedAt: new Date() } }
    );

    return res.status(201).json({ success: true, data: milestone, message: "Milestone added." });
  } catch (err) {
    console.error("Add Milestone Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── PATCH /api/contracts/:id/milestones/:mid — Update milestone ──────────────
router.patch("/:id/milestones/:mid", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const contract = await getContract(db, req.params.id, req.user.id);
    if (!contract) return notFound(res);
    if (!contract.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);

    const mid = new ObjectId(req.params.mid);
    const milestone = contract.milestones?.find((m) => m._id.equals(mid));
    if (!milestone) {
      return res.status(404).json({ success: false, error: { code: "MILESTONE_NOT_FOUND", message: "Milestone not found." } });
    }
    if (milestone.status !== "Pending") {
      return badRequest(res, "Only Pending milestones can be edited.", "INVALID_STATUS");
    }

    const { title, description, amount, dueDate } = req.body;
    const updates = { updatedAt: new Date() };
    if (title) updates["milestones.$.title"] = title;
    if (description !== undefined) updates["milestones.$.description"] = description;
    if (amount) updates["milestones.$.amount"] = Number(amount);
    if (dueDate) updates["milestones.$.dueDate"] = new Date(dueDate);

    await db.collection("contracts").updateOne(
      { _id: contract._id, "milestones._id": mid },
      { $set: updates }
    );

    return res.json({ success: true, message: "Milestone updated." });
  } catch (err) {
    console.error("Update Milestone Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/contracts/:id/milestones/:mid/fund — Fund a milestone ─────────
router.post("/:id/milestones/:mid/fund", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const contract = await getContract(db, req.params.id, req.user.id);
    if (!contract) return notFound(res);
    if (!contract.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);

    const mid = new ObjectId(req.params.mid);
    const milestone = contract.milestones?.find((m) => m._id.equals(mid));
    if (!milestone) {
      return res.status(404).json({ success: false, error: { code: "MILESTONE_NOT_FOUND", message: "Milestone not found." } });
    }
    if (milestone.funded) return badRequest(res, "Milestone is already funded.", "ALREADY_FUNDED");
    if (milestone.status !== "Pending") return badRequest(res, "Only Pending milestones can be funded.", "INVALID_STATUS");

    const now = new Date();

    // Mark milestone as funded
    await db.collection("contracts").updateOne(
      { _id: contract._id, "milestones._id": mid },
      { $set: { "milestones.$.funded": true, "milestones.$.fundedAt": now, "milestones.$.status": "In Progress", updatedAt: now } }
    );

    // Create a payment record
    await db.collection("payments").insertOne({
      contractId: contract._id,
      milestoneId: mid,
      clientId: contract.clientId,
      freelancerId: contract.freelancerId,
      amount: milestone.amount,
      currency: "USD",
      status: "Escrow",
      type: "milestone_funding",
      createdAt: now,
    });

    return res.json({ success: true, message: "Milestone funded and moved to escrow." });
  } catch (err) {
    console.error("Fund Milestone Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/contracts/:id/milestones/:mid/submit — Submit work ─────────────
router.post("/:id/milestones/:mid/submit", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const contract = await getContract(db, req.params.id, req.user.id);
    if (!contract) return notFound(res);
    if (!contract.freelancerId.equals(new ObjectId(req.user.id))) return forbidden(res);

    const mid = new ObjectId(req.params.mid);
    const milestone = contract.milestones?.find((m) => m._id.equals(mid));
    if (!milestone) {
      return res.status(404).json({ success: false, error: { code: "MILESTONE_NOT_FOUND", message: "Milestone not found." } });
    }
    if (!milestone.funded) return badRequest(res, "Milestone must be funded before submitting work.", "NOT_FUNDED");
    if (milestone.status !== "In Progress") return badRequest(res, "Milestone is not in progress.", "INVALID_STATUS");

    const { message, files, liveUrl, notes } = req.body;

    const submission = {
      _id: new ObjectId(),
      contractId: contract._id,
      milestoneId: mid,
      freelancerId: contract.freelancerId,
      message: message || "",
      files: Array.isArray(files) ? files : [],
      liveUrl: liveUrl || "",
      notes: notes || "",
      status: "Submitted",
      createdAt: new Date(),
    };

    await db.collection("submissions").insertOne(submission);

    await db.collection("contracts").updateOne(
      { _id: contract._id, "milestones._id": mid },
      { $set: { "milestones.$.status": "Under Review", "milestones.$.submittedAt": new Date(), updatedAt: new Date() } }
    );

    return res.status(201).json({ success: true, data: submission, message: "Work submitted for review." });
  } catch (err) {
    console.error("Submit Work Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/contracts/:id/milestones/:mid/approve — Approve submission ─────
router.post("/:id/milestones/:mid/approve", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const contract = await getContract(db, req.params.id, req.user.id);
    if (!contract) return notFound(res);
    if (!contract.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);

    const mid = new ObjectId(req.params.mid);
    const milestone = contract.milestones?.find((m) => m._id.equals(mid));
    if (!milestone) {
      return res.status(404).json({ success: false, error: { code: "MILESTONE_NOT_FOUND", message: "Milestone not found." } });
    }
    if (milestone.status !== "Under Review") return badRequest(res, "Milestone is not under review.", "INVALID_STATUS");

    const now = new Date();
    const PLATFORM_FEE_RATE = 0.10; // 10%
    const platformFee = milestone.amount * PLATFORM_FEE_RATE;
    const freelancerEarning = milestone.amount - platformFee;

    // Approve milestone
    await db.collection("contracts").updateOne(
      { _id: contract._id, "milestones._id": mid },
      { $set: { "milestones.$.status": "Completed", "milestones.$.approvedAt": now, updatedAt: now } }
    );

    // Update payment status
    await db.collection("payments").updateOne(
      { contractId: contract._id, milestoneId: mid },
      { $set: { status: "Released", platformFee, freelancerEarning, releasedAt: now, updatedAt: now } }
    );

    // Credit freelancer wallet
    await db.collection("wallets").updateOne(
      { userId: contract.freelancerId },
      { $inc: { availableBalance: freelancerEarning }, $set: { updatedAt: now } },
      { upsert: true }
    );

    // Create transaction record
    await db.collection("transactions").insertOne({
      contractId: contract._id,
      milestoneId: mid,
      clientId: contract.clientId,
      freelancerId: contract.freelancerId,
      amount: milestone.amount,
      platformFee,
      freelancerEarning,
      currency: "USD",
      type: "milestone_release",
      status: "Completed",
      createdAt: now,
    });

    // Check if all milestones completed → mark contract complete
    const updated = await db.collection("contracts").findOne({ _id: contract._id });
    const allDone = updated.milestones?.every((m) => ["Completed", "Cancelled"].includes(m.status));
    if (allDone) {
      await db.collection("contracts").updateOne(
        { _id: contract._id },
        { $set: { status: "Completed", completedAt: now, updatedAt: now } }
      );
      // Mark project as completed
      await db.collection("projects").updateOne(
        { _id: contract.projectId },
        { $set: { status: "Completed", updatedAt: now } }
      );
    }

    return res.json({ success: true, message: "Milestone approved and payment released." });
  } catch (err) {
    console.error("Approve Milestone Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/contracts/:id/milestones/:mid/revision — Request revision ──────
router.post("/:id/milestones/:mid/revision", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const contract = await getContract(db, req.params.id, req.user.id);
    if (!contract) return notFound(res);
    if (!contract.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);

    const mid = new ObjectId(req.params.mid);
    const milestone = contract.milestones?.find((m) => m._id.equals(mid));
    if (!milestone) {
      return res.status(404).json({ success: false, error: { code: "MILESTONE_NOT_FOUND", message: "Milestone not found." } });
    }
    if (milestone.status !== "Under Review") return badRequest(res, "Milestone is not under review.", "INVALID_STATUS");

    const { changes, attachments } = req.body;
    if (!changes) return badRequest(res, "changes description is required.", "VALIDATION_ERROR");

    const revision = {
      _id: new ObjectId(),
      contractId: contract._id,
      milestoneId: mid,
      clientId: contract.clientId,
      changes,
      attachments: Array.isArray(attachments) ? attachments : [],
      createdAt: new Date(),
    };

    await db.collection("revisions").insertOne(revision);

    await db.collection("contracts").updateOne(
      { _id: contract._id, "milestones._id": mid },
      { $set: { "milestones.$.status": "Revision Requested", "milestones.$.revisionRequestedAt": new Date(), updatedAt: new Date() } }
    );

    return res.status(201).json({ success: true, data: revision, message: "Revision requested." });
  } catch (err) {
    console.error("Revision Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

module.exports = router;
