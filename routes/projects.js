const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken, authorizeRoles } = require("../middleware/authMiddleware");

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────
const notFound = (res) =>
  res.status(404).json({ success: false, error: { code: "PROJECT_NOT_FOUND", message: "Project not found." } });

const forbidden = (res) =>
  res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });

const badRequest = (res, message, code = "BAD_REQUEST") =>
  res.status(400).json({ success: false, error: { code, message } });

const VALID_STATUSES = ["Draft", "Published", "Hiring", "In Progress", "Completed", "Cancelled", "Suspended"];

// ─── POST /api/projects — Create project (Client only) ───────────────────────
router.post("/", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    const {
      title, description, category, skills, projectType,
      budgetMin, budgetMax, deadline, duration, experienceLevel, attachments,
    } = req.body;

    if (!title || !description || !projectType) {
      return badRequest(res, "title, description, and projectType are required.", "VALIDATION_ERROR");
    }
    if (!["fixed", "hourly"].includes(projectType)) {
      return badRequest(res, "projectType must be 'fixed' or 'hourly'.", "VALIDATION_ERROR");
    }

    const now = new Date();
    const project = {
      clientId: new ObjectId(req.user.id),
      title: title.trim(),
      description: description.trim(),
      category: category || "",
      skills: Array.isArray(skills) ? skills : [],
      projectType,
      budgetMin: budgetMin ? Number(budgetMin) : null,
      budgetMax: budgetMax ? Number(budgetMax) : null,
      deadline: deadline ? new Date(deadline) : null,
      duration: duration || "",
      experienceLevel: experienceLevel || "Any",
      attachments: Array.isArray(attachments) ? attachments : [],
      status: "Draft",
      proposalCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("projects").insertOne(project);
    return res.status(201).json({
      success: true,
      data: { _id: result.insertedId, ...project },
      message: "Project created successfully.",
    });
  } catch (err) {
    console.error("Create Project Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/projects — List/search projects (public) ───────────────────────
router.get("/", async (req, res) => {
  try {
    const db = getDb();
    const {
      page = 1, limit = 12, keyword, category, skills, projectType,
      budgetMin, budgetMax, experienceLevel, duration, sort = "newest",
      myProjects, status,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const filter = {};

    // If authenticated client requests their own projects
    if (myProjects === "true" && req.headers.authorization) {
      try {
        const jwt = require("jsonwebtoken");
        const token = req.headers.authorization.replace("Bearer ", "");
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        filter.clientId = new ObjectId(decoded.id);
        if (status) filter.status = status;
      } catch {
        // ignore — fall through to public listing
      }
    } else {
      // Public listing: only show Published and Hiring
      filter.status = { $in: ["Published", "Hiring"] };
    }

    if (keyword) {
      filter.$or = [
        { title: { $regex: keyword, $options: "i" } },
        { description: { $regex: keyword, $options: "i" } },
      ];
    }
    if (category) filter.category = { $regex: category, $options: "i" };
    if (projectType) filter.projectType = projectType;
    if (experienceLevel) filter.experienceLevel = experienceLevel;
    if (duration) filter.duration = duration;
    if (skills) {
      const skillList = typeof skills === "string" ? skills.split(",").map((s) => s.trim()) : skills;
      filter.skills = { $in: skillList };
    }
    if (budgetMin) filter.budgetMin = { $gte: Number(budgetMin) };
    if (budgetMax) filter.budgetMax = { $lte: Number(budgetMax) };

    const sortMap = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      budget_high: { budgetMax: -1 },
      budget_low: { budgetMin: 1 },
      proposals: { proposalCount: -1 },
    };
    const sortOrder = sortMap[sort] || sortMap.newest;

    const [projects, total] = await Promise.all([
      db.collection("projects").find(filter).sort(sortOrder).skip(skip).limit(Number(limit)).toArray(),
      db.collection("projects").countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: projects,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("List Projects Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/projects/:id — Get single project ───────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) return notFound(res);

    const project = await db.collection("projects").findOne({ _id: new ObjectId(req.params.id) });
    if (!project) return notFound(res);

    // Non-owners can only see Published/Hiring projects
    let isOwner = false;
    if (req.headers.authorization) {
      try {
        const jwt = require("jsonwebtoken");
        const token = req.headers.authorization.replace("Bearer ", "");
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        isOwner = project.clientId.equals(new ObjectId(decoded.id));
      } catch { /* ignore */ }
    }

    if (!isOwner && !["Published", "Hiring", "In Progress", "Completed"].includes(project.status)) {
      return notFound(res);
    }

    // Fetch client info
    const client = await db.collection("users").findOne(
      { _id: project.clientId },
      { projection: { passwordHash: 0 } }
    );

    return res.json({ success: true, data: { ...project, client } });
  } catch (err) {
    console.error("Get Project Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── PATCH /api/projects/:id — Update project (Client owner only) ─────────────
router.patch("/:id", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) return notFound(res);

    const project = await db.collection("projects").findOne({ _id: new ObjectId(req.params.id) });
    if (!project) return notFound(res);
    if (!project.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);
    if (!["Draft", "Published"].includes(project.status)) {
      return badRequest(res, "Only Draft or Published projects can be edited.", "INVALID_STATUS");
    }

    const allowedFields = ["title", "description", "category", "skills", "projectType",
      "budgetMin", "budgetMax", "deadline", "duration", "experienceLevel", "attachments"];
    const updates = { updatedAt: new Date() };
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    await db.collection("projects").updateOne({ _id: project._id }, { $set: updates });
    return res.json({ success: true, message: "Project updated." });
  } catch (err) {
    console.error("Update Project Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── DELETE /api/projects/:id — Delete draft project ─────────────────────────
router.delete("/:id", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) return notFound(res);

    const project = await db.collection("projects").findOne({ _id: new ObjectId(req.params.id) });
    if (!project) return notFound(res);
    if (!project.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);
    if (project.status !== "Draft") {
      return badRequest(res, "Only Draft projects can be deleted.", "INVALID_STATUS");
    }

    await db.collection("projects").deleteOne({ _id: project._id });
    return res.json({ success: true, message: "Project deleted." });
  } catch (err) {
    console.error("Delete Project Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/projects/:id/publish — Publish a draft project ────────────────
router.post("/:id/publish", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) return notFound(res);

    const project = await db.collection("projects").findOne({ _id: new ObjectId(req.params.id) });
    if (!project) return notFound(res);
    if (!project.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);
    if (project.status !== "Draft") {
      return badRequest(res, "Only Draft projects can be published.", "INVALID_STATUS");
    }
    if (!project.title || !project.description) {
      return badRequest(res, "Project must have a title and description before publishing.", "INCOMPLETE_PROJECT");
    }

    await db.collection("projects").updateOne(
      { _id: project._id },
      { $set: { status: "Published", publishedAt: new Date(), updatedAt: new Date() } }
    );
    return res.json({ success: true, message: "Project published." });
  } catch (err) {
    console.error("Publish Project Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/projects/:id/cancel — Cancel a project ────────────────────────
router.post("/:id/cancel", authenticateToken, authorizeRoles("Client"), async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) return notFound(res);

    const project = await db.collection("projects").findOne({ _id: new ObjectId(req.params.id) });
    if (!project) return notFound(res);
    if (!project.clientId.equals(new ObjectId(req.user.id))) return forbidden(res);
    if (!["Published", "Hiring"].includes(project.status)) {
      return badRequest(res, "Only Published or Hiring projects can be cancelled.", "INVALID_STATUS");
    }

    await db.collection("projects").updateOne(
      { _id: project._id },
      { $set: { status: "Cancelled", updatedAt: new Date() } }
    );
    return res.json({ success: true, message: "Project cancelled." });
  } catch (err) {
    console.error("Cancel Project Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

module.exports = router;
