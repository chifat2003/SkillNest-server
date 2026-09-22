const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { getDb } = require("../config/db");

const register = async (req, res) => {
  try {
    const { fullName, username, email, password, role } = req.body;

    if (!fullName || !username || !email || !password || !role) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const validRoles = ["Freelancer", "Client"];

    if (!validRoles.includes(role)) {
      return res.status(400).json({
        message: "Invalid role selected",
      });
    }

    const db = getDb();
    const usersCollection = db.collection("users");

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username.toLowerCase().trim();

    const existingUser = await usersCollection.findOne({
      $or: [
        { email: normalizedEmail },
        { username: normalizedUsername },
      ],
    });

    if (existingUser) {
      return res.status(409).json({
        message: "User with this email or username already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const newUser = {
      fullName,
      username: normalizedUsername,
      email: normalizedEmail,
      passwordHash,
      role,
      status: "active",
      isVerified: false,
      authProvider: "local",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await usersCollection.insertOne(newUser);

    return res.status(201).json({
      message: "User registered successfully",
      userId: result.insertedId,
    });
  } catch (err) {
    console.error("Register Error:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const db = getDb();
    const usersCollection = db.collection("users");

    const normalizedEmail = email.toLowerCase().trim();

    const user = await usersCollection.findOne({
      email: normalizedEmail,
    });

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    if (!user.passwordHash) {
      return res.status(401).json({
        message:
          "This account uses Google login. Please continue with Google.",
      });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    if (
      user.status === "suspended" ||
      user.status === "deactivated"
    ) {
      return res.status(403).json({
        message: `Account is ${user.status}`,
      });
    }

    const payload = {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user._id.toString(),
        fullName: user.fullName,
        username: user.username,
        email: user.email,
        role: user.role,
        profileImage: user.profileImage || null,
      },
    });
  } catch (err) {
    console.error("Login Error:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const getMe = async (req, res) => {
  try {
    const db = getDb();
    const usersCollection = db.collection("users");

    const user = await usersCollection.findOne(
      {
        _id: new ObjectId(req.user.id),
      },
      {
        projection: {
          passwordHash: 0,
        },
      }
    );

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    return res.json({ user });
  } catch (err) {
    console.error("Get Me Error:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const googleLogin = async (req, res) => {
  try {
    const role = req.query.role;
    const validRoles = ["Freelancer", "Client"];

    if (!validRoles.includes(role)) {
      return res.status(400).json({
        message: "Invalid role selected",
      });
    }

    const state = jwt.sign(
      {
        role,
        nonce: crypto.randomBytes(16).toString("hex"),
        purpose: "google-oauth",
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "10m",
      }
    );

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL,
      response_type: "code",
      scope: "openid email profile",
      state,
    });

    const googleAuthUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return res.redirect(googleAuthUrl);
  } catch (err) {
    console.error("Google Login Error:", err);

    return res.status(500).json({
      message: "Failed to start Google login",
    });
  }
};

const googleCallback = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/login?error=google_cancelled`
      );
    }

    if (!code || !state) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/login?error=missing_oauth_data`
      );
    }

    let stateData;

    try {
      stateData = jwt.verify(
        state,
        process.env.JWT_SECRET
      );
    } catch {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/login?error=invalid_oauth_state`
      );
    }

    if (stateData.purpose !== "google-oauth") {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/login?error=invalid_oauth_state`
      );
    }

    const tokenResponse = await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_CALLBACK_URL,
          grant_type: "authorization_code",
        }),
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/login?error=google_token_failed`
      );
    }

    const userResponse = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      }
    );

    const googleUser = await userResponse.json();

    if (!userResponse.ok) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/login?error=google_user_failed`
      );
    }

    const {
      sub: googleId,
      email,
      email_verified,
      name,
      picture,
    } = googleUser;

    if (!email || !email_verified) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/login?error=google_email_not_verified`
      );
    }

    const db = getDb();
    const usersCollection = db.collection("users");
    const normalizedEmail = email.toLowerCase().trim();

    let user = await usersCollection.findOne({
      email: normalizedEmail,
    });

    if (user) {
      if (
        user.googleId &&
        user.googleId !== googleId
      ) {
        return res.redirect(
          `${process.env.FRONTEND_URL}/auth/login?error=google_account_conflict`
        );
      }

      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: {
            googleId,
            authProvider: "google",
            isVerified: true,
            profileImage:
              picture || user.profileImage || null,
            updatedAt: new Date(),
          },
        }
      );

      user = await usersCollection.findOne({
        _id: user._id,
      });
    } else {
      const baseUsername =
        (name || "user")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 15) || "user";

      let username = baseUsername;

      let usernameExists =
        await usersCollection.findOne({
          username,
        });

      while (usernameExists) {
        username = `${baseUsername}${crypto.randomInt(
          1000,
          9999
        )}`;

        usernameExists =
          await usersCollection.findOne({
            username,
          });
      }

      const newUser = {
        fullName: name || "Google User",
        username,
        email: normalizedEmail,
        passwordHash: null,
        role: stateData.role,
        googleId,
        authProvider: "google",
        status: "active",
        isVerified: true,
        profileImage: picture || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result =
        await usersCollection.insertOne(newUser);

      user = {
        ...newUser,
        _id: result.insertedId,
      };
    }

    if (
      user.status === "suspended" ||
      user.status === "deactivated"
    ) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/login?error=account_${user.status}`
      );
    }

    const payload = {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
    };

    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    const userData = {
      id: user._id.toString(),
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      role: user.role,
      profileImage: user.profileImage || null,
    };

    const redirectUrl =
      `${process.env.FRONTEND_URL}/auth/google-callback` +
      `#token=${encodeURIComponent(token)}` +
      `&user=${encodeURIComponent(
        JSON.stringify(userData)
      )}`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("Google Callback Error:", err);

    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/login?error=google_login_failed`
    );
  }
};

module.exports = {
  register,
  login,
  getMe,
  googleLogin,
  googleCallback,
};