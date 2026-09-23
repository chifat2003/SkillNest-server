const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken, authorizeRoles } = require("../middleware/authMiddleware");

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const notFound = (res) =>
  res.status(404).json({ success: false, error: { code: "PROPOSAL_NOT_FOUND", message: "Proposal not found." } });

const forbidden = (res) =>
  res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });

const badRequest = (res, message, code = "BAD_REQUEST") =>
  res.status(400).json({ success: false, error: { code, message } });

const getProposalAndVerifyOwner = async (db, proposalId, userId, role) => {
  if (!ObjectId.isValid(proposalId)) return null;
  const proposal = await db.collection("proposals").findOne({ _id: new ObjectId(proposalId) });
  if (!proposal) return null;
  const uid = new ObjectId(userId);
  if (role === "Freelancer" && !proposal.freelancerId.equals(uid)) return null;
  if (role === "Client" && !proposal.clientId.equals(uid)) return null;
  return proposal;
};

// ─── POST /api/proposals — Submit a proposal (Freelancer only) ───────────────
router.post("/", authenticateToken, authorizeRoles("Freelancer"), async (req, res) => {
  try {
    const db = getDb();
    const { projectId, coverLetter, proposedPrice, deliveryDays, hourlyRate, portfolioRefs, attachments, milestones } = req.body;

    if (!projectId || !coverLetter || !proposedPrice || !deliveryDays) {
      return badRequest(res, "projectId, coverLetter, proposedPrice, and deliveryDays are required.", "VALIDATION_ERROR");
    }
    if (!ObjectId.isValid(projectId)) return badRequest(res, "Invalid projectId.");

    const project = await db.collection("projects").findOne({ _id: new ObjectId(projectId) });
    if (!project) return res.status(404).json({ success: false, error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } });
    if (!["Published", "Hiring"].includes(project.status)) return badRequest(res, "Project is not accepting proposals.", "PROJECT_NOT_ACCEPTING");

    const existing = await db.collection("proposals").findOne({
      projectId: new ObjectId(projectId),
      freelancerId: new ObjectId(req.user.id),
      status: { $nin: ["Withdrawn", "Rejected", "Expired"] },
    });
    if (existing) return badRequest(res, "You already have an active proposal for this project.", "DUPLICATE_PROPOSAL");

    const now = new Date();
    const proposal = {
      projectId: new ObjectId(projectId),
      freelancerId: new ObjectId(req.user.id),
      clientId: project.clientId,
      coverLetter,
      proposedPrice: Number(proposedPrice),
      deliveryDays: Number(deliveryDays),
      hourlyRate: hourlyRate ? Number(hourlyRate) : null,
      portfolioRefs: portfolioRefs || [],
      status: "Submitted",
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("proposals").insertOne(proposal);
    const proposalId = result.insertedId;

    // Store attachments in proposal_attachments collection
    if (attachments?.length) {
      const docs = attachments.map((url) => ({
        proposalId,
        freelancerId: new ObjectId(req.user.id),
        url,
        createdAt: now,
      }));
      await db.collection("proposal_attachments").insertMany(docs);
    }

    // Store milestones in proposal_milestones collection
    if (milestones?.length) {
      const docs = milestones.map((m, i) => ({
        proposalId,
        freelancerId: new ObjectId(req.user.id),
        order: i + 1,
        title: m.title,
        description: m.description || "",
        amount: Number(m.amount),
        dueDate: m.dueDate ? new Date(m.dueDate) : null,
        createdAt: now,
      }));
      await db.collection("proposal_milestones").insertMany(docs);
    }

    return res.status(201).json({ success: true, data: { _id: proposalId, ...proposal }, message: "Proposal submitted successfully." });
  } catch (err) {
    console.error("Submit Proposal Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/proposals — List proposals (role-scoped) ───────────────────────
router.get("/", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 10, status, projectId } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const filter = {};
    if (req.user.role === "Freelancer") filter.freelancerId = new ObjectId(req.user.id);
    else if (req.user.role === "Client") filter.clientId = new ObjectId(req.user.id);

    if (status) filter.status = status;
    if (projectId && ObjectId.isValid(projectId)) filter.projectId = new ObjectId(projectId);

    const [proposals, total] = await Promise.all([
      db.collection("proposals").find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray(),
      db.collection("proposals").countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: proposals,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("List Proposals Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/proposals/:id — Get single proposal with attachments & milestones
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) return notFound(res);

    const proposal = await db.collection("proposals").findOne({ _id: new ObjectId(req.params.id) });
    if (!proposal) return notFound(res);

    const userId = new ObjectId(req.user.id);
    if (!proposal.freelancerId.equals(userId) && !proposal.clientId.equals(userId)) return forbidden(res);

    // Auto-mark as Viewed when client reads a Submitted proposal
    if (req.user.role === "Client" && proposal.status === "Submitted") {
      await db.collection("proposals").updateOne({ _id: proposal._id }, { $set: { status: "Viewed", updatedAt: new Date() } });
      proposal.status = "Viewed";
    }

    // Fetch related attachments and milestones
    const [attachments, milestones] = await Promise.all([
      db.collection("proposal_attachments").find({ proposalId: proposal._id }).toArray(),
      db.collection("proposal_milestones").find({ proposalId: proposal._id }).sort({ order: 1 }).toArray(),
    ]);

    return res.json({ success: true, data: { ...proposal, attachments, milestones } });
  } catch (err) {
    console.error("Get Proposal Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── PATCH /api/proposals/:id — Edit proposal (Freelancer, Submitted/Viewed only)
router.patch("/:id", authenticateToken, authorizeRoles("Freelancer"), async (req, res) => {
  try {
    const db = getDb();
    const proposal = await getProposalAndVerifyOwner(db, req.params.id, req.user.id, "Freelancer");
    if (!proposal) return notFound(res);
    if (!["Submitted", "Viewed"].includes(proposal.status)) return badRequest(res, "Proposal cannot be edited in its current status.", "INVALID_STATUS");

    const { coverLetter, proposedPrice, deliveryDays, hourlyRate, portfolioRefs, attachments, milestones } = req.body;
    const updates = { updatedAt: new Date() };
    if (coverLetter !== undefined) updates.coverLetter = coverLetter;
    if (proposedPrice !== undefined) updates.proposedPrice = Number(proposedPrice);
    if (deliveryDays !== undefined) updates.deliveryDays = Number(deliveryDays);
    if (hourlyRate !== undefined) updates.hourlyRate = Number(hourlyRate);
    if (portfolioRefs !== undefined) updates.portfolioRefs = portfolioRefs;

    await db.collection("proposals").updateOne({ _id: proposal._id }, { $set: updates });

    // Replace attachments if provided
    if (attachments !== undefined) {
      await db.collection("proposal_attachments").deleteMany({ proposalId: proposal._id });
      if (attachments.length) {
        await db.collection("proposal_attachments").insertMany(
          attachments.map((url) => ({ proposalId: proposal._id, freelancerId: proposal.freelancerId, url, createdAt: new Date() }))
        );
      }
    }

    // Replace milestones if provided
    if (milestones !== undefined) {
      await db.collection("proposal_milestones").deleteMany({ proposalId: proposal._id });
      if (milestones.length) {
        await db.collection("proposal_milestones").insertMany(
          milestones.map((m, i) => ({
            proposalId: proposal._id,
            freelancerId: proposal.freelancerId,
            order: i + 1,
            title: m.title,
            description: m.description || "",
            amount: Number(m.amount),
            dueDate: m.dueDate ? new Date(m.dueDate) : null,
            createdAt: new Date(),
          }))
        );
      }
    }

    return res.json({ success: true, message: "Proposal updated." });
  } catch (err) {
    console.error("Edit Proposal Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/proposals/:id/withdraw ────────────────────────────────────────
router.post("/:id/withdraw", authenticateToken, authorizeRoles("Freelancer"), async (req, res) => {
  try {
    const db = getDb();
    const proposal = await getProposalAndVerifyOwner(db, req.params.id, req.user.id, "Freelancer");
    if (!proposal) return notFound(res);
    if (["Accepted", "Withdrawn", "Rejected", "Expired"].includes(proposal.status)) return badRequest(res, "Proposal cannot be withdrawn in its current status.", "INVALID_STATUS");

    await db.collection("proposals").updateOne({ _id: proposal._id }, { $set: { status: "Withdrawn", updatedAt: new Date() } });
    return res.json({ success: true, message: "Proposal withdrawn." });
  } catch (err) {
    console.error("Withdraw Proposal Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/proposals/:id/shortlist ───────────────────────────────────────
router.post("/:id/shortlist", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    const proposal = await getProposalAndVerifyOwner(db, req.params.id, req.user.id, "Client");
    if (!proposal) return notFound(res);
    if (!["Submitted", "Viewed", "Interview"].includes(proposal.status)) return badRequest(res, "Proposal cannot be shortlisted in its current status.", "INVALID_STATUS");

    await db.collection("proposals").updateOne({ _id: proposal._id }, { $set: { status: "Shortlisted", updatedAt: new Date() } });
    return res.json({ success: true, message: "Proposal shortlisted." });
  } catch (err) {
    console.error("Shortlist Proposal Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/proposals/:id/interview ───────────────────────────────────────
router.post("/:id/interview", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    const proposal = await getProposalAndVerifyOwner(db, req.params.id, req.user.id, "Client");
    if (!proposal) return notFound(res);
    if (!["Submitted", "Viewed", "Shortlisted"].includes(proposal.status)) return badRequest(res, "Proposal cannot be moved to interview in its current status.", "INVALID_STATUS");

    await db.collection("proposals").updateOne({ _id: proposal._id }, { $set: { status: "Interview", updatedAt: new Date() } });
    return res.json({ success: true, message: "Proposal moved to interview." });
  } catch (err) {
    console.error("Interview Proposal Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/proposals/:id/reject ──────────────────────────────────────────
router.post("/:id/reject", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    const proposal = await getProposalAndVerifyOwner(db, req.params.id, req.user.id, "Client");
    if (!proposal) return notFound(res);
    if (["Accepted", "Rejected", "Withdrawn", "Expired"].includes(proposal.status)) return badRequest(res, "Proposal cannot be rejected in its current status.", "INVALID_STATUS");

    await db.collection("proposals").updateOne({ _id: proposal._id }, { $set: { status: "Rejected", updatedAt: new Date() } });
    return res.json({ success: true, message: "Proposal rejected." });
  } catch (err) {
    console.error("Reject Proposal Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/proposals/:id/accept — Accept → auto-create contract ──────────
router.post("/:id/accept", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    const proposal = await getProposalAndVerifyOwner(db, req.params.id, req.user.id, "Client");
    if (!proposal) return notFound(res);
    if (!["Submitted", "Viewed", "Shortlisted", "Interview"].includes(proposal.status)) return badRequest(res, "Proposal cannot be accepted in its current status.", "INVALID_STATUS");

    const now = new Date();

    await db.collection("proposals").updateOne({ _id: proposal._id }, { $set: { status: "Accepted", updatedAt: now } });

    // Auto-reject remaining active proposals for the same project
    await db.collection("proposals").updateMany(
      { projectId: proposal.projectId, _id: { $ne: proposal._id }, status: { $nin: ["Withdrawn", "Rejected", "Expired"] } },
      { $set: { status: "Rejected", updatedAt: now } }
    );

    // Fetch proposal milestones to carry into contract
    const proposalMilestones = await db.collection("proposal_milestones")
      .find({ proposalId: proposal._id })
      .sort({ order: 1 })
      .toArray();

    const project = await db.collection("projects").findOne({ _id: proposal.projectId });

    const contract = {
      proposalId: proposal._id,
      projectId: proposal.projectId,
      clientId: proposal.clientId,
      freelancerId: proposal.freelancerId,
      contractType: project?.projectType || "fixed",
      amount: proposal.proposedPrice,
      hourlyRate: proposal.hourlyRate,
      status: "Active",
      terms: req.body.terms || "",
      milestones: proposalMilestones.map((m) => ({
        title: m.title,
        description: m.description,
        amount: m.amount,
        dueDate: m.dueDate,
        status: "Pending",
      })),
      startDate: now,
      createdAt: now,
      updatedAt: now,
    };

    const contractResult = await db.collection("contracts").insertOne(contract);
    await db.collection("projects").updateOne({ _id: proposal.projectId }, { $set: { status: "Hiring", updatedAt: now } });

    return res.status(201).json({
      success: true,
      data: { contractId: contractResult.insertedId },
      message: "Proposal accepted and contract created.",
    });
  } catch (err) {
    console.error("Accept Proposal Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

module.exports = router;
