const { connectDB, getDb } = require("../config/db");
require("dotenv").config();

const createIndexes = async () => {
  await connectDB();
  const db = getDb();

  // proposals
  await db.collection("proposals").createIndexes([
    { key: { freelancerId: 1, status: 1 } },
    { key: { clientId: 1, status: 1 } },
    { key: { projectId: 1, status: 1 } },
    { key: { projectId: 1, freelancerId: 1 } },
    { key: { createdAt: -1 } },
  ]);

  // proposal_attachments
  await db.collection("proposal_attachments").createIndexes([
    { key: { proposalId: 1 } },
    { key: { freelancerId: 1 } },
  ]);

  // proposal_milestones
  await db.collection("proposal_milestones").createIndexes([
    { key: { proposalId: 1, order: 1 } },
    { key: { freelancerId: 1 } },
  ]);

  // invitations
  await db.collection("invitations").createIndexes([
    { key: { freelancerId: 1, status: 1 } },
    { key: { clientId: 1, status: 1 } },
    { key: { projectId: 1, freelancerId: 1 } },
    { key: { createdAt: -1 } },
  ]);

  console.log("✅ All indexes created successfully.");
  process.exit(0);
};

createIndexes().catch((err) => {
  console.error("❌ Index creation failed:", err);
  process.exit(1);
});
