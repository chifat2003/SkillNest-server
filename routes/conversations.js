const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");
const { authenticateToken } = require("../middleware/authMiddleware");

const router = express.Router();

// ─── GET /api/conversations — List conversations for current user ─────────────
router.get("/", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const uid = new ObjectId(req.user.id);

    const conversations = await db.collection("conversations")
      .find({ members: uid })
      .sort({ lastMessageAt: -1 })
      .toArray();

    // Enrich with other participant info and last message
    const enriched = await Promise.all(conversations.map(async (conv) => {
      const otherIds = conv.members.filter((m) => !m.equals(uid));
      const others = await Promise.all(
        otherIds.map((id) =>
          db.collection("users").findOne({ _id: id }, { projection: { fullName: 1, email: 1, avatar: 1, role: 1 } })
        )
      );
      const lastMsg = await db.collection("messages")
        .findOne({ conversationId: conv._id }, { sort: { createdAt: -1 } });

      const unreadCount = await db.collection("messages").countDocuments({
        conversationId: conv._id,
        readBy: { $ne: uid },
        senderId: { $ne: uid },
      });

      return { ...conv, participants: others.filter(Boolean), lastMessage: lastMsg, unreadCount };
    }));

    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error("List Conversations Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/conversations — Create or get conversation ────────────────────
router.post("/", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const uid = new ObjectId(req.user.id);
    const { recipientId, projectId } = req.body;

    if (!recipientId || !ObjectId.isValid(recipientId)) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Valid recipientId is required." } });
    }

    const rid = new ObjectId(recipientId);
    if (rid.equals(uid)) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Cannot message yourself." } });
    }

    // Check recipient exists
    const recipient = await db.collection("users").findOne({ _id: rid });
    if (!recipient) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Recipient not found." } });
    }

    // Find existing conversation between these two users
    const existing = await db.collection("conversations").findOne({
      members: { $all: [uid, rid] },
      ...(projectId && ObjectId.isValid(projectId) ? { projectId: new ObjectId(projectId) } : {}),
    });

    if (existing) return res.json({ success: true, data: existing, message: "Existing conversation." });

    const now = new Date();
    const conversation = {
      members: [uid, rid],
      projectId: projectId && ObjectId.isValid(projectId) ? new ObjectId(projectId) : null,
      lastMessageAt: now,
      createdAt: now,
    };

    const result = await db.collection("conversations").insertOne(conversation);
    return res.status(201).json({
      success: true,
      data: { _id: result.insertedId, ...conversation },
      message: "Conversation created.",
    });
  } catch (err) {
    console.error("Create Conversation Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── GET /api/conversations/:id/messages — Get messages ──────────────────────
router.get("/:id/messages", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found." } });
    }
    const convId = new ObjectId(req.params.id);
    const uid = new ObjectId(req.user.id);

    const conversation = await db.collection("conversations").findOne({ _id: convId });
    if (!conversation) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found." } });
    }
    if (!conversation.members.some((m) => m.equals(uid))) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    const { page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const [messages, total] = await Promise.all([
      db.collection("messages")
        .find({ conversationId: convId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .toArray(),
      db.collection("messages").countDocuments({ conversationId: convId }),
    ]);

    // Mark messages as read
    await db.collection("messages").updateMany(
      { conversationId: convId, readBy: { $ne: uid } },
      { $addToSet: { readBy: uid } }
    );

    return res.json({
      success: true,
      data: messages.reverse(), // chronological order
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error("Get Messages Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

// ─── POST /api/conversations/:id/messages — Send message ─────────────────────
router.post("/:id/messages", authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found." } });
    }
    const convId = new ObjectId(req.params.id);
    const uid = new ObjectId(req.user.id);

    const conversation = await db.collection("conversations").findOne({ _id: convId });
    if (!conversation) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found." } });
    }
    if (!conversation.members.some((m) => m.equals(uid))) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    const { content, attachments } = req.body;
    if (!content && (!attachments || !attachments.length)) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Message content or attachments are required." } });
    }

    const now = new Date();
    const message = {
      conversationId: convId,
      senderId: uid,
      content: content || "",
      attachments: Array.isArray(attachments) ? attachments : [],
      readBy: [uid],
      createdAt: now,
    };

    const result = await db.collection("messages").insertOne(message);

    // Update conversation last message time
    await db.collection("conversations").updateOne(
      { _id: convId },
      { $set: { lastMessageAt: now, lastMessage: content || "[attachment]" } }
    );

    return res.status(201).json({
      success: true,
      data: { _id: result.insertedId, ...message },
      message: "Message sent.",
    });
  } catch (err) {
    console.error("Send Message Error:", err);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
});

module.exports = router;
