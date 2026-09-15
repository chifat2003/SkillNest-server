const express = require("express");
const router = express.Router();
const { register, login, getMe } = require("../controllers/authController");
const { authenticateToken, authorizeRoles } = require("../middleware/authMiddleware");

// Public Routes
router.post("/register", register);
router.post("/login", login);

// Authenticated Route
router.get("/me", authenticateToken, getMe);

// Role-Specific Routes
router.get("/freelancer/dashboard", authenticateToken, authorizeRoles("Freelancer"), (req, res) => {
  res.json({ message: "Welcome to the Freelancer Dashboard!" });
});

router.get("/client/dashboard", authenticateToken, authorizeRoles("Client"), (req, res) => {
  res.json({ message: "Welcome to the Client Dashboard!" });
});

module.exports = router;