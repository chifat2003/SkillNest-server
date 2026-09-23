const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken } = require("../middleware/authMiddleware");

const router = express.Router();

// ─── GET /api/notifications — List notifications for current user ─────────────
router.get("/", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 20, unreadOnly } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const uid = new ObjectId(req.user.id);

    const filter = { userId: uid };
    if (unreadOnly === "true") filter.read = false;

    const [notifications, total, unreadCount] = await Promise.all([
      db.collection("notifications")
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .toArray(),
      db.collection("notifications").countDocuments(filter),
      db.collection("notifications").countDocuments({ userId: uid, read: false }),
    ]);

    return res.json({
      success: true,
      data: notifications,
      unreadCount,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("List Notifications Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── PATCH /api/notifications/:id/read — Mark single notification as read ─────
router.patch("/:id/read", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Notification not found." } });
    }

    const result = await db.collection("notifications").updateOne(
      { _id: new ObjectId(req.params.id), userId: new ObjectId(req.user.id) },
      { $set: { read: true, readAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Notification not found." } });
    }

    return res.json({ success: true, message: "Notification marked as read." });
  } catch (err) {
    console.error("Mark Read Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── PATCH /api/notifications/read-all — Mark all as read ────────────────────
router.patch("/read-all", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    await db.collection("notifications").updateMany(
      { userId: new ObjectId(req.user.id), read: false },
      { $set: { read: true, readAt: new Date() } }
    );
    return res.json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    console.error("Mark All Read Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── DELETE /api/notifications/:id — Delete a notification ───────────────────
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Notification not found." } });
    }

    const result = await db.collection("notifications").deleteOne({
      _id: new ObjectId(req.params.id),
      userId: new ObjectId(req.user.id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Notification not found." } });
    }

    return res.json({ success: true, message: "Notification deleted." });
  } catch (err) {
    console.error("Delete Notification Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── Helper: createNotification (exported for use in other routes) ─────────────
const createNotification = async (db, { userId, type, title, message, entityType, entityId }) => {
  try {
    await db.collection("notifications").insertOne({
      userId: new ObjectId(userId),
      type,
      title,
      message,
      entityType: entityType || null,
      entityId: entityId ? new ObjectId(entityId) : null,
      read: false,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("Create Notification Error:", err);
  }
};

module.exports = router;
module.exports.createNotification = createNotification;
