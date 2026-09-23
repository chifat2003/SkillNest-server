const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken } = require("../middleware/authMiddleware");

const router = express.Router();

// ─── GET /api/profiles/me — Get own profile ───────────────────────────────────
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const userId = new ObjectId(req.user.id);

    const user = await db.collection("users").findOne({ _id: userId }, { projection: { passwordHash: 0 } });
    if (!user) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "User not found." } });

    const profile = await db.collection("profiles").findOne({ userId });

    return res.json({ success: true, data: { ...user, profile: profile || null } });
  } catch (err) {
    console.error("Get Own Profile Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── PATCH /api/profiles/me — Update own profile ─────────────────────────────
router.patch("/me", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const userId = new ObjectId(req.user.id);
    const now = new Date();

    // Fields allowed for all users
    const userAllowed = ["fullName", "bio", "location", "avatar"];
    const userUpdates = { updatedAt: now };
    for (const f of userAllowed) {
      if (req.body[f] !== undefined) userUpdates[f] = req.body[f];
    }
    if (Object.keys(userUpdates).length > 1) {
      await db.collection("users").updateOne({ _id: userId }, { $set: userUpdates });
    }

    // Role-specific profile fields
    let profileUpdates = { userId, updatedAt: now };

    if (req.user.role === "Freelancer") {
      const freelancerFields = [
        "title", "overview", "hourlyRate", "skills", "availability",
        "socialLinks", "languages", "workPreferences",
      ];
      for (const f of freelancerFields) {
        if (req.body[f] !== undefined) profileUpdates[f] = req.body[f];
      }
    } else if (req.user.role === "Client") {
      const clientFields = [
        "companyName", "industry", "website", "companySize", "description",
      ];
      for (const f of clientFields) {
        if (req.body[f] !== undefined) profileUpdates[f] = req.body[f];
      }
    }

    await db.collection("profiles").updateOne(
      { userId },
      { $set: profileUpdates },
      { upsert: true }
    );

    return res.json({ success: true, message: "Profile updated." });
  } catch (err) {
    console.error("Update Profile Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/profiles/freelancers — List freelancers (public search) ─────────
router.get("/freelancers", async (req, res) => {
  try {
    const db = getDb();
    const {
      page = 1, limit = 12, keyword, skills, category,
      minRate, maxRate, availability, sort = "newest",
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    // Match users who are Freelancers
    const userFilter = { role: "Freelancer", status: "active" };
    if (keyword) {
      userFilter.$or = [
        { fullName: { $regex: keyword, $options: "i" } },
      ];
    }

    const freelancerUsers = await db.collection("users")
      .find(userFilter, { projection: { passwordHash: 0 } })
      .toArray();

    const userIds = freelancerUsers.map((u) => u._id);

    // Build profile filter
    const profileFilter = { userId: { $in: userIds } };
    if (availability) profileFilter.availability = availability;
    if (minRate) profileFilter.hourlyRate = { ...profileFilter.hourlyRate, $gte: Number(minRate) };
    if (maxRate) profileFilter.hourlyRate = { ...profileFilter.hourlyRate, $lte: Number(maxRate) };
    if (skills) {
      const skillList = typeof skills === "string" ? skills.split(",").map((s) => s.trim()) : skills;
      profileFilter.skills = { $in: skillList };
    }

    const profiles = await db.collection("profiles").find(profileFilter).toArray();
    const profileMap = {};
    for (const p of profiles) profileMap[p.userId.toString()] = p;

    // Merge user + profile, filter out those with no profile if skills filter applied
    let merged = freelancerUsers
      .map((u) => ({ ...u, profile: profileMap[u._id.toString()] || null }))
      .filter((u) => !skills || u.profile); // only those with profiles when filtering by skill

    // Sort
    if (sort === "rate_high") merged.sort((a, b) => (b.profile?.hourlyRate || 0) - (a.profile?.hourlyRate || 0));
    else if (sort === "rate_low") merged.sort((a, b) => (a.profile?.hourlyRate || 0) - (b.profile?.hourlyRate || 0));
    else merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = merged.length;
    const paginated = merged.slice(skip, skip + Number(limit));

    return res.json({
      success: true,
      data: paginated,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("List Freelancers Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/profiles/:id — Get any user profile (public) ───────────────────
router.get("/:id", async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Profile not found." } });
    }
    const userId = new ObjectId(req.params.id);

    const user = await db.collection("users").findOne({ _id: userId }, { projection: { passwordHash: 0 } });
    if (!user || user.status !== "active") {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Profile not found." } });
    }

    const [profile, reviews] = await Promise.all([
      db.collection("profiles").findOne({ userId }),
      db.collection("reviews").find({ revieweeId: userId }).sort({ createdAt: -1 }).limit(10).toArray(),
    ]);

    // Compute average rating
    let avgRating = null;
    if (reviews.length) {
      avgRating = (reviews.reduce((sum, r) => sum + r.overallRating, 0) / reviews.length).toFixed(1);
    }

    return res.json({
      success: true,
      data: { ...user, profile: profile || null, reviews, avgRating, reviewCount: reviews.length },
    });
  } catch (err) {
    console.error("Get Profile Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/profiles/experience — Add experience ──────────────────────────
router.post("/experience", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { title, company, startDate, endDate, current, description } = req.body;
    if (!title || !company) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "title and company are required." } });
    }
    const entry = {
      _id: new ObjectId(),
      title, company,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      current: !!current,
      description: description || "",
    };
    await db.collection("profiles").updateOne(
      { userId: new ObjectId(req.user.id) },
      { $push: { experiences: entry }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    return res.status(201).json({ success: true, data: entry, message: "Experience added." });
  } catch (err) {
    console.error("Add Experience Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/profiles/education — Add education ────────────────────────────
router.post("/education", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { school, degree, field, startDate, endDate } = req.body;
    if (!school || !degree) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "school and degree are required." } });
    }
    const entry = {
      _id: new ObjectId(),
      school, degree, field: field || "",
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
    };
    await db.collection("profiles").updateOne(
      { userId: new ObjectId(req.user.id) },
      { $push: { educations: entry }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    return res.status(201).json({ success: true, data: entry, message: "Education added." });
  } catch (err) {
    console.error("Add Education Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/profiles/portfolio — Add portfolio project ────────────────────
router.post("/portfolio", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { title, description, technologies, category, projectUrl, completedDate } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "title is required." } });
    }
    const entry = {
      _id: new ObjectId(),
      title,
      description: description || "",
      technologies: Array.isArray(technologies) ? technologies : [],
      category: category || "",
      projectUrl: projectUrl || "",
      completedDate: completedDate ? new Date(completedDate) : null,
      createdAt: new Date(),
    };
    await db.collection("profiles").updateOne(
      { userId: new ObjectId(req.user.id) },
      { $push: { portfolio: entry }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    return res.status(201).json({ success: true, data: entry, message: "Portfolio item added." });
  } catch (err) {
    console.error("Add Portfolio Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

module.exports = router;
