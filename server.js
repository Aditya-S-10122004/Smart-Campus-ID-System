import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import pkg from "pg";
import jwt from "jsonwebtoken";
import session from "express-session";
import multer from "multer";
import FormData from "form-data";
import axios from "axios";

dotenv.config();
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

// Prefer a single DATABASE_URL (Render provides this). Fall back to individual vars for local dev.
const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      // Many hosted Postgres providers require SSL; this avoids certificate validation problems.
      ssl: {
        rejectUnauthorized: false,
      },
    })
  : new Pool({
      user: process.env.DATABASE_USER,
      host: process.env.DATABASE_HOST || "localhost",
      database: process.env.DATABASE_NAME,
      password: process.env.DATABASE_PASSWORD,
      port: process.env.DATABASE_PORT
        ? Number(process.env.DATABASE_PORT)
        : 5432,
    });

// Optional: log when a client is acquired/released (helpful in debugging connection usage)
pool.on("error", (err) => {
  console.error("Unexpected idle client error", err);
});

async function query(text, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

app.use(express.static(path.join(__dirname, "public")));
app.use("/static", express.static(path.join(__dirname, "public", "static")));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.JWT_SECRET || "change_this_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 6, // 6 hours
    },
  })
);

const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";

function signToken(admin) {
  return jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, {
    expiresIn: "6h",
  });
}

async function getCounts() {
  const totalRes = await query("SELECT COUNT(id) AS c FROM users");
  const hostRes = await query(
    "SELECT COUNT(id) AS c FROM users WHERE hostelite = true"
  );

  const totalStudents = Number(totalRes.rows[0].c || 0);
  const hostelite = Number(hostRes.rows[0].c || 0);
  const dayScholar = totalStudents - hostelite;

  return { totalStudents, hostelite, dayScholar };
}

const FACEPP_KEY = (process.env.FACEPP_KEY || "").trim();
const FACEPP_SECRET = (process.env.FACEPP_SECRET || "").trim();
const FACEPP_ENDPOINT =
  process.env.FACEPP_ENDPOINT ||
  "https://api-us.faceplusplus.com/facepp/v3/compare";

async function faceppCompare(probeBuffer, targetBuffer) {
  if (!FACEPP_KEY || !FACEPP_SECRET) {
    throw new Error(
      "Face++ credentials not configured (FACEPP_KEY/FACEPP_SECRET)"
    );
  }

  const form = new FormData();
  form.append("api_key", FACEPP_KEY);
  form.append("api_secret", FACEPP_SECRET);
  form.append("image_file1", probeBuffer, {
    filename: "probe.jpg",
    contentType: "image/jpeg",
  });
  form.append("image_file2", targetBuffer, {
    filename: "target.jpg",
    contentType: "image/jpeg",
  });

  const headers = form.getHeaders ? form.getHeaders() : {};
  const resp = await axios.post(FACEPP_ENDPOINT, form, {
    headers,
    timeout: 20000,
  });
  return resp.data;
}

function safeJson(res, obj) {
  try {
    return res.json(obj);
  } catch (e) {
    console.error("safeJson error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
}

app.get("/", (req, res) => res.render("login", { message: null }));
app.get("/login", (req, res) => res.render("login", { message: null }));

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render("login", {
      message: "Please enter both email and password.",
    });
  }

  try {
    const result = await query(
      "SELECT id, fullname, student_id, email, password_hash FROM users WHERE email = $1",
      [email]
    );

    if (result.rowCount === 0) {
      return res.render("login", { message: "Invalid email or password." });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.render("login", { message: "Invalid email or password." });
    }

    req.session.userId = user.id;
    return res.redirect("/sdmcet/home");
  } catch (err) {
    console.error("Login Error:", err);
    return res.render("login", {
      message: "Server error. Please try again later.",
    });
  }
});

app.get("/adminLogin", (req, res) =>
  res.render("adminLogin", { message: null })
);

app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body;
  const isStaff = req.body.isStaff ? true : false;
  const staffSection = req.body.staffSection || "";

  const sectionMap = {
    "/sdmcet/staff/mess": { table: "mess", path: "/sdmcet/staff/mess" },
    "/sdmcet/staff/gym": { table: "gym", path: "/sdmcet/staff/gym" },
    "/sdmcet/staff/sports": { table: "sports", path: "/sdmcet/staff/sports" },
    "/sdmcet/staff/library": { table: "library", path: "/sdmcet/staff/library" },
  };

  try {
    if (isStaff) {
      if (!sectionMap[staffSection]) {
        return res.render("adminLogin", {
          message: "Please select a valid section (mess / gym / sports / library).",
        });
      }

      const { table, path } = sectionMap[staffSection];
      const r = await query(
        `SELECT id, username, password_hash FROM ${table} WHERE username = $1`,
        [username]
      );

      if (r.rowCount === 0)
        return res.render("adminLogin", { message: "Invalid credentials" });

      const staffUser = r.rows[0];
      const ok = await bcrypt.compare(password, staffUser.password_hash);
      if (!ok)
        return res.render("adminLogin", { message: "Invalid credentials" });

      if (req.session) {
        req.session.staff = {
          id: staffUser.id,
          username: staffUser.username,
          section: table,
        };
      }
      return res.redirect(path);
    }

    const r = await query(
      "SELECT id, username, password_hash FROM admins WHERE username = $1",
      [username]
    );
    if (r.rowCount === 0)
      return res.render("adminLogin", { message: "Invalid credentials" });

    const admin = r.rows[0];
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok)
      return res.render("adminLogin", { message: "Invalid credentials" });

    const counts = await getCounts();
    if (req.session) {
      req.session.admin = { id: admin.id, username: admin.username };
    }

    return res.render("admin-dashboard", {
      message: "Logged in as admin",
      admin,
      totalStudents: counts.totalStudents,
      hostelite: counts.hostelite,
      dayScholar: counts.dayScholar,
    });
  } catch (err) {
    console.error("Admin/staff login error:", err);
    return res.render("adminLogin", { message: "Server error. Try again." });
  }
});

app.get("/sdmcet/home", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  try {
    const r = await query(
      `SELECT id, fullname, student_id, email, wallet, hostelite, gym_active, indoor_sports_active, photo_data
       FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (r.rowCount === 0) return res.redirect("/login");
    return res.render("home", { user: r.rows[0] });
  } catch (err) {
    console.error("Home page error:", err);
    return res.redirect("/login");
  }
});

app.get("/sdmcet/contact", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  try {
    res.render("contact");
  } catch (err) {
    console.log(err);
  }
});

app.post("/contact/details", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  try {
    const fullName = req.body.fullName;
    const email = req.body.email;
    const mobileNumber = req.body.mobileNumber;
    const subject = req.body.subject;
    const message = req.body.message;
    const r = await query(
      `INSERT INTO contact (name,email,number,subject,message) VALUES ($1,$2,$3,$4,$5)`,
      [fullName, email, mobileNumber, subject, message]
    );

    res.render("contact");
  } catch (err) {
    console.error("Form submission failed:", err);
    res.render("contact");
  }
});

app.get("/sdmcet/gym", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  try {
    const r = await query(
      `SELECT id, fullname, student_id, email, gym_active, wallet FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (r.rowCount === 0) return res.redirect("/login");
    return res.render("gym", { user: r.rows[0] });
  } catch (err) {
    console.error("Error loading gym page:", err);
    return res.redirect("/sdmcet/home");
  }
});

app.post("/gym/subscribe", async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.redirect("/login");

  const amount = Number(req.body.amount);
  try {
    const r = await query("SELECT wallet FROM users WHERE id = $1", [userId]);
    if (r.rowCount === 0)
      return res.json({ ok: false, message: "User not found" });

    const wallet = Number(r.rows[0].wallet || 0);
    if (wallet < amount)
      return res.json({ ok: false, message: "Insufficient amount" });

    const newWallet = wallet - amount;

    await query(
      "UPDATE users SET wallet = $1, gym_active = true WHERE id = $2",
      [newWallet, userId]
    );

    return res.json({ ok: true, message: "Subscription successful" });
  } catch (err) {
    console.error("Subscribe error:", err);
    return res.json({ ok: false, message: "Server error" });
  }
});

app.post("/gym/unsubscribe", async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.redirect("/login");

  try {
    await query("UPDATE users SET gym_active = false WHERE id = $1", [userId]);
    return res.redirect("/sdmcet/gym");
  } catch (err) {
    console.log(err);
    console.warn("Failed to unsubscribe!");

    return res.redirect("/sdmcet/gym");
  }
});

app.get("/sdmcet/mess", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  try {
    const r = await query(
      `SELECT id, fullname, student_id, email, hostelite, wallet,
      (SELECT booked_item FROM mess_bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1) AS last_booking
      FROM users WHERE id = $1`,
      [req.session.userId]
    );

    if (r.rowCount === 0) return res.redirect("/login");
    return res.render("mess", { user: r.rows[0] });
  } catch (err) {
    console.error("Error loading mess page :", err);
    return res.redirect("/sdmcet/home");
  }
});

app.get("/sdmcet/sports", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  try {
    const r = await query(
      `SELECT id, fullname, student_id, email, indoor_sports_active, wallet FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (r.rowCount === 0) return res.redirect("/login");
    return res.render("sports", { user: r.rows[0] });
  } catch (err) {
    console.error("Error loading sports page:", err);
    return res.redirect("/sdmcet/home");
  }
});

app.post("/sports/subscribe", async (req, res) => {
  const userId = req.session && req.session.userId;
  if (!userId) return res.redirect("/login");

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0)
    return res.json({ ok: false, message: "Invalid amount" });

  try {
    const r = await query("SELECT wallet FROM users WHERE id = $1", [userId]);
    if (r.rowCount === 0)
      return res.json({ ok: false, message: "User not found" });

    const wallet = Number(r.rows[0].wallet || 0);
    if (wallet < amount)
      return res.json({ ok: false, message: "Insufficient amount" });

    const newWallet = wallet - amount;
    await query(
      "UPDATE users SET wallet = $1, indoor_sports_active = true WHERE id = $2",
      [newWallet, userId]
    );

    return res.json({ ok: true, message: "Subscription successful" });
  } catch (err) {
    console.error("Sports subscribe error:", err);
    return res.json({ ok: false, message: "Server error" });
  }
});

app.post("/sports/unsubscribe", async (req, res) => {
  const userId = req.session && req.session.userId;
  if (!userId) return res.redirect("/login");

  try {
    await query("UPDATE users SET indoor_sports_active = false WHERE id = $1", [
      userId,
    ]);
    return res.redirect("/sdmcet/sports");
  } catch (err) {
    console.error("Sports unsubscribe error:", err);
    console.warn("Failed to unsubscribe!");

    return res.redirect("/sdmcet/sports");
  }
});

app.get("/sdmcet/library", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  try {
    const userResult = await query(
      `SELECT id, fullname, student_id, email FROM users WHERE id = $1`,
      [req.session.userId]
    );
    if (userResult.rowCount === 0) return res.redirect("/login");
    const user = userResult.rows[0];

    const booksResult = await query(
      `SELECT title,author,book_id,book_edition,issued_on,due_on
        FROM borrowed_books
        WHERE user_id = $1
        ORDER BY issued_on DESC`,
      [req.session.userId]
    );

    const borrowedBooks = booksResult.rows || [];

    let totalFine = 0;
    const today = new Date();
    borrowedBooks.forEach((book) => {
      const due = new Date(book.due_on);
      const diffDays = Math.floor((today - due) / (1000 * 60 * 60 * 24));
      if (diffDays > 0) {
        if (diffDays <= 7) {
          totalFine += diffDays * 1;
        } else {
          totalFine += 7 * 1 + (diffDays - 7) * 5;
        }
      }
    });

    return res.render("library", { user, borrowedBooks, totalFine });
  } catch (err) {
    console.error("Library page error:", err);
    return res.redirect("/sdmcet/home");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Session destroy error:", err);
    res.redirect("/login");
  });
});

app.get("/user/photo/:id", async (req, res) => {
  try {
    const r = await query("SELECT photo_data FROM users WHERE id = $1", [
      req.params.id,
    ]);
    if (r.rowCount === 0 || !r.rows[0].photo_data) return res.sendStatus(404);
    res.set("Content-Type", "image/jpeg");
    res.send(r.rows[0].photo_data);
  } catch (err) {
    console.error("Image fetch error:", err);
    res.sendStatus(500);
  }
});

app.get("/sdmcet/staff/mess", async (req, res) => {
  if (!req.session.staff || req.session.staff.section !== "mess") {
    return res.redirect("/adminLogin");
  }
  try {
    const staffRows = await query(
      "SELECT id, username FROM mess ORDER BY id ASC"
    );

    const rv = await query(
      `SELECT mv.id, mv.student_id, mv.student_name, mv.hostelite, mv.face_path, mv.created_at
       FROM mess_visits mv
       ORDER BY mv.created_at DESC
       LIMIT 500`
    );

    const recentVisits = rv.rows.map((r) => ({
      id: r.id,
      student_id: r.student_id,
      student_name: r.student_name,
      hostelite: r.hostelite,
      photo_path:
        r.face_path || (r.student_id ? `/user/photo/${r.student_id}` : null),
      created_at: r.created_at,
    }));

    const totalsQ = await query(
      `SELECT
     COUNT(*) FILTER (WHERE mv.created_at >= date_trunc('day', now()))::int AS total_visits,
     COUNT(*) FILTER (WHERE mv.created_at >= date_trunc('day', now()) AND mv.hostelite = true)::int AS hostelite_visits,
     COUNT(*) FILTER (WHERE mv.created_at >= date_trunc('day', now()) AND (mv.hostelite = false OR mv.hostelite IS FALSE))::int AS dayscholar_visits,
     (SELECT COUNT(*) FROM mess_bookings WHERE created_at >= date_trunc('day', now()))::int AS bookings,
     COALESCE(
       (SELECT SUM(amount) FROM mess_bookings WHERE created_at >= date_trunc('day', now())),
       0
     )::int AS today_booking_amount,
     COALESCE(
       (SELECT SUM(amount) FROM mess_bookings WHERE created_at >= date_trunc('month', now())),
       0
     )::int AS month_booking_amount
   FROM mess_visits mv`
    );

    const t = totalsQ.rows[0] || {
      total_visits: 0,
      hostelite_visits: 0,
      dayscholar_visits: 0,
      bookings: 0,
    };

    const totals = {
      totalVisits: Number(t.total_visits || 0),
      hostelite: Number(t.hostelite_visits || 0),
      dayScholar: Number(t.dayscholar_visits || 0),
      bookings: Number(t.bookings || 0),
      todayBookingAmount: Number(t.today_booking_amount || 0),
      monthBookingAmount: Number(t.month_booking_amount || 0),
    };

    return res.render("staffMess", {
      staff: staffRows.rows,
      recentVisits,
      totals,
    });
  } catch (err) {
    console.error("Error loading mess staff page:", err);
    return res.render("staffMess", {
      staff: [],
      recentVisits: [],
      totals: {
        totalVisits: 0,
        hosteliteVisits: 0,
        dayScholarVisits: 0,
        bookings: 0,
      },
      message: "Server error while loading Mess page.",
    });
  }
});

app.get("/api/staff/mess/bookings", async (req, res) => {
  try {
    const staff = req.session && req.session.staff;
    if (!staff || staff.section !== "mess")
      return res.status(403).json({ ok: false });

    const r = await query(
      `SELECT
         mb.id,
         mb.booked_item,
         mb.amount,
         mb.created_at,
         u.fullname,
         u.student_id
       FROM mess_bookings mb
       JOIN users u ON u.id = mb.user_id
       ORDER BY mb.created_at DESC`
    );

    return res.json({ ok: true, bookings: r.rows });
  } catch (err) {
    console.error("Mess bookings fetch error:", err);
    return res.json({ ok: false });
  }
});

app.get("/api/mess/booking-status", async (req, res) => {
  if (!req.session.userId)
    return res.json({ ok: false, message: "Not logged in" });

  try {
    const r = await query(
      `SELECT booked_item FROM mess_bookings 
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.session.userId]
    );

    if (r.rowCount === 0) return res.json({ ok: true, booked: null });

    return res.json({ ok: true, booked: r.rows[0].booked_item });
  } catch (err) {
    return res.json({ ok: false });
  }
});

app.post("/api/mess/book", async (req, res) => {
  if (!req.session.userId)
    return res.status(401).json({ ok: false, message: "Not logged in" });

  const userId = req.session.userId;
  const { item, amount } = req.body;

  if (!item || typeof amount === "undefined")
    return res.status(400).json({ ok: false, message: "Missing data" });

  try {
    const userRes = await query(
      "SELECT wallet FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userRes.rowCount === 0)
      return res.status(404).json({ ok: false, message: "User not found" });

    const wallet = Number(userRes.rows[0].wallet || 0);
    const price = Number(amount);

    if (isNaN(price) || price <= 0)
      return res.status(400).json({ ok: false, message: "Invalid amount" });

    if (wallet < price)
      return res
        .status(400)
        .json({ ok: false, message: "Insufficient amount" });

    await query("BEGIN");
    try {
      await query("UPDATE users SET wallet = wallet - $1 WHERE id = $2", [
        price,
        userId,
      ]);
      await query(
        `INSERT INTO mess_bookings (user_id, booked_item, amount, created_at)
         VALUES ($1, $2, $3, now())`,
        [userId, item, price]
      );
      const wRes = await query("SELECT wallet FROM users WHERE id = $1", [
        userId,
      ]);
      const newWallet = Number(wRes.rows[0].wallet || 0);
      await query("COMMIT");
      return res.json({
        ok: true,
        message: "Booking successful",
        wallet: newWallet,
      });
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }
  } catch (err) {
    console.error("Booking error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.post("/admin/create", upload.single("photo"), async (req, res) => {
  try {
    let rawPassword = req.body.password;
    if ((!rawPassword || rawPassword.length === 0) && req.body.adminPassword)
      rawPassword = req.body.adminPassword;
    if (Array.isArray(rawPassword)) {
      const chosen = rawPassword.find(
        (p) => typeof p === "string" && p.trim() !== ""
      );
      rawPassword = chosen || rawPassword[0];
    }

    if (
      !rawPassword ||
      typeof rawPassword !== "string" ||
      rawPassword.trim() === ""
    ) {
      const counts0 = await getCounts();
      return res.render("admin-dashboard", {
        message: "Password missing",
        ...counts0,
      });
    }

    const hash = await bcrypt.hash(String(rawPassword).trim(), 10);

    if (req.body.student_id) {
      const fullname = req.body.fullname;
      const studentId = req.body.student_id;
      const email = req.body.email;
      const hostelite = req.body.hostelite === "true";
      const photoData = req.file ? req.file.buffer : null;
      if (!studentId || !email) {
        const countsBad = await getCounts();
        return res.render("admin-dashboard", {
          message: "Student ID and email required",
          ...countsBad,
        });
      }

      const checkStudent = await query(
        "SELECT id FROM users WHERE student_id = $1 OR email = $2",
        [studentId, email]
      );
      if (checkStudent.rowCount > 0) {
        const counts1 = await getCounts();
        return res.render("admin-dashboard", {
          message: "Student already exists",
          ...counts1,
        });
      }

      await query(
        `INSERT INTO users (student_id, fullname, email, password_hash, hostelite, photo_data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [studentId, fullname, email, hash, hostelite, photoData]
      );

      const counts2 = await getCounts();
      return res.render("admin-dashboard", {
        message: "Student registered successfully",
        totalStudents: counts2.totalStudents,
        hostelite: counts2.hostelite,
        dayScholar: counts2.dayScholar,
      });
    }

    if (req.body.username) {
      const username = req.body.username && String(req.body.username).trim();
      if (!username) {
        const countsBad = await getCounts();
        return res.render("admin-dashboard", {
          message: "Username required",
          ...countsBad,
        });
      }

      const checkStaff = await query(
        "SELECT id FROM staff WHERE username = $1",
        [username]
      );
      if (checkStaff.rowCount > 0) {
        const counts3 = await getCounts();
        return res.render("admin-dashboard", {
          message: "Staff username already exists",
          ...counts3,
        });
      }

      await query(
        `INSERT INTO staff (username, password_hash, created_at) VALUES ($1, $2, now())`,
        [username, hash]
      );
      const counts4 = await getCounts();
      return res.render("admin-dashboard", {
        message: "Staff registered successfully",
        totalStudents: counts4.totalStudents,
        hostelite: counts4.hostelite,
        dayScholar: counts4.dayScholar,
      });
    }

    const counts5 = await getCounts();
    return res.render("admin-dashboard", {
      message: "Invalid form submission",
      ...counts5,
    });
  } catch (err) {
    console.error("Create error:", err);
    const countsErr = await getCounts().catch(() => ({
      totalStudents: 0,
      hostelite: 0,
      dayScholar: 0,
    }));
    return res.render("admin-dashboard", {
      message: "Server error. Try again.",
      ...countsErr,
    });
  }
});

app.post("/api/staff/mess/identify", async (req, res) => {
  try {
    const barcode =
      req.body && req.body.barcode ? String(req.body.barcode).trim() : "";
    if (!barcode)
      return safeJson(res.status(400), {
        ok: false,
        message: "Missing barcode",
      });

    const userRes = await query(
      `SELECT id, fullname, student_id, hostelite FROM users WHERE student_id = $1 LIMIT 1`,
      [barcode]
    );
    if (userRes.rowCount === 0)
      return safeJson(res, { ok: false, message: "Student not found" });

    const user = userRes.rows[0];
    await query(
      `INSERT INTO mess_visits (user_id, student_id, student_name, hostelite, created_at) VALUES ($1, $2, $3, $4, now())`,
      [user.id, user.student_id, user.fullname, user.hostelite]
    );

    const recentRes = await query(
      `SELECT mv.id, mv.created_at, u.fullname AS student_name, u.student_id, u.hostelite, u.id AS user_id
       FROM mess_visits mv
       JOIN users u ON mv.user_id = u.id
       ORDER BY mv.created_at DESC
       LIMIT 8`
    );

    const recentVisits = recentRes.rows.map((r) => ({
      id: r.id,
      time: r.created_at,
      student_name: r.student_name,
      student_id: r.student_id,
      hostelite: r.hostelite,
      photo_path: `/user/photo/${r.user_id}`,
    }));

    return safeJson(res, {
      ok: true,
      student: {
        id: user.id,
        name: user.fullname,
        student_id: user.student_id,
        hostelite: user.hostelite,
        photo_url: `/user/photo/${user.id}`,
      },
      recentVisits,
    });
  } catch (err) {
    console.error("Error /api/staff/mess/identify:", err);
    return safeJson(res.status(500), { ok: false, message: "Server error" });
  }
});

app.post(
  "/api/staff/mess/compare",
  upload.single("image"),
  async (req, res) => {
    try {
      const staff = req.session && req.session.staff;
      if (!staff || staff.section !== "mess")
        return safeJson(res.status(403), {
          ok: false,
          message: "Forbidden: not mess staff",
        });
      if (!req.file || !req.file.buffer)
        return safeJson(res.status(400), {
          ok: false,
          message: "Probe image (image) is required",
        });

      const probeBuf = req.file.buffer;
      const userId = req.body.user_id || req.body.student_id;
      if (!userId)
        return safeJson(res.status(400), {
          ok: false,
          message: "user_id (target) is required",
        });

      const u = await query(
        "SELECT id, fullname, student_id, hostelite, photo_data FROM users WHERE id = $1 LIMIT 1",
        [userId]
      );
      if (u.rowCount === 0)
        return safeJson(res.status(404), {
          ok: false,
          message: "Target user not found",
        });

      const userRow = u.rows[0];
      if (!userRow.photo_data)
        return safeJson(res.status(404), {
          ok: false,
          message: "Target user has no stored photo",
        });

      const cmp = await faceppCompare(probeBuf, userRow.photo_data);
      if (!cmp)
        return safeJson(res.status(502), {
          ok: false,
          message: "Face++ returned invalid response",
        });
      if (cmp.error_message)
        return safeJson(res.status(500), {
          ok: false,
          message: "Face++ error: " + cmp.error_message,
          raw: cmp,
        });

      const confidence = Number(cmp.confidence ?? -1);
      const threshold = Number(process.env.FACEPP_THRESHOLD ?? 70);
      const matched = confidence >= threshold;
      let insertId = null;

      if (matched) {
        try {
          const staffId = staff.id || null;
          const insertRes = await query(
            `INSERT INTO mess_visits (user_id, student_id, student_name, hostelite, created_at, staff_id)
           VALUES ($1, $2, $3, $4, now(), $5) RETURNING id`,
            [
              userRow.id,
              userRow.student_id,
              userRow.fullname,
              userRow.hostelite,
              staffId,
            ]
          );
          if (insertRes.rowCount > 0) insertId = insertRes.rows[0].id;
        } catch (e) {
          console.error("Insert mess_visit failed:", e);
        }
      }

      return safeJson(res, {
        ok: true,
        matched,
        confidence,
        threshold,
        student: {
          id: userRow.id,
          name: userRow.fullname,
          student_id: userRow.student_id,
          hostelite: userRow.hostelite,
          photo_url: `/user/photo/${userRow.id}`,
        },
        inserted_visit_id: insertId,
        facepp_raw: cmp,
      });
    } catch (err) {
      console.error("Face++ compare route error (mess):", err);
      return safeJson(res.status(500), {
        ok: false,
        message: "Server error",
        error: String(err),
      });
    }
  }
);

app.post("/api/staff/mess/scan", upload.single("image"), async (req, res) => {
  try {
    const staff = req.session && req.session.staff;
    if (!staff || staff.section !== "mess")
      return safeJson(res.status(403), {
        ok: false,
        message: "Forbidden: not mess staff",
      });
    if (!req.file || !req.file.buffer)
      return safeJson(res.status(400), {
        ok: false,
        message: "Probe image (image) is required",
      });

    const probeBuf = req.file.buffer;
    const usersRes = await query(
      `SELECT id, fullname, student_id, hostelite, photo_data FROM users WHERE photo_data IS NOT NULL`
    );
    const users = usersRes.rows || [];

    if (!users.length)
      return safeJson(res, {
        ok: true,
        matched: false,
        message: "No users with stored photos",
      });

    const threshold = Number(process.env.FACEPP_THRESHOLD ?? 70);
    let matchedUser = null;
    let matchedConfidence = -1;
    let rawCompare = null;

    for (const u of users) {
      try {
        const cmp = await faceppCompare(probeBuf, u.photo_data);
        rawCompare = cmp;
        if (cmp && cmp.confidence !== undefined) {
          const conf = Number(cmp.confidence);
          if (conf >= threshold) {
            matchedUser = u;
            matchedConfidence = conf;
            break;
          }
        } else if (cmp && cmp.error_message) {
          console.warn("Face++ error for user", u.id, cmp.error_message);
        }
        await new Promise((r) => setTimeout(r, 120));
      } catch (e) {
        console.error(
          "Face++ compare error for user",
          u.id,
          e && e.response && e.response.data ? e.response.data : e.message || e
        );
      }
    }

    if (!matchedUser)
      return safeJson(res, {
        ok: true,
        matched: false,
        confidence: matchedConfidence,
        threshold,
        facepp_raw: rawCompare,
      });

    let insertedId = null;
    let createdAt = new Date().toISOString();
    try {
      const staffId = staff.id || null;
      const insertRes = await query(
        `INSERT INTO mess_visits (user_id, student_id, student_name, hostelite, created_at, staff_id)
         VALUES ($1, $2, $3, $4, now(), $5) RETURNING id, created_at`,
        [
          matchedUser.id,
          matchedUser.student_id,
          matchedUser.fullname,
          matchedUser.hostelite,
          staffId,
        ]
      );
      if (insertRes.rowCount > 0) {
        insertedId = insertRes.rows[0].id;
        createdAt = insertRes.rows[0].created_at || createdAt;
      }
    } catch (e) {
      console.error("Insert mess_visit failed in scan route:", e);
    }

    const recentVisit = {
      id: insertedId,
      student_id: matchedUser.student_id,
      student_name: matchedUser.fullname,
      hostelite: matchedUser.hostelite,
      photo_path: `/user/photo/${matchedUser.id}`,
      created_at: createdAt,
    };

    return safeJson(res, {
      ok: true,
      matched: true,
      confidence: matchedConfidence,
      threshold,
      student: {
        id: matchedUser.id,
        name: matchedUser.fullname,
        student_id: matchedUser.student_id,
        hostelite: matchedUser.hostelite,
        photo_url: `/user/photo/${matchedUser.id}`,
      },
      inserted_visit_id: insertedId,
      recentVisit,
      facepp_raw: rawCompare,
    });
  } catch (err) {
    console.error("Scan route error (mess):", err);
    return safeJson(res.status(500), {
      ok: false,
      message: "Server error",
      error: String(err),
    });
  }
});

app.get("/sdmcet/staff/gym", async (req, res) => {
  try {
    const staffRows = await query(
      "SELECT id, username FROM gym ORDER BY id ASC"
    );

    const rv = await query(
      `SELECT gv.id, gv.student_id, gv.student_name, gv.gym_active, gv.face_path, gv.created_at
       FROM gym_visits gv
       ORDER BY gv.created_at DESC
       LIMIT 500`
    );

    const recentVisits = rv.rows.map((r) => ({
      id: r.id,
      student_id: r.student_id,
      student_name: r.student_name,
      gym_active: r.gym_active,
      photo_path:
        r.face_path || (r.student_id ? `/user/photo/${r.student_id}` : null),
      created_at: r.created_at,
    }));

    const totalsQ = await query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS total_visits,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND gym_active = true)::int AS gym_active,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND (gym_active = false OR gym_active IS FALSE))::int AS not_active,
         0::int AS bookings
       FROM gym_visits`
    );

    const t = totalsQ.rows[0] || {
      total_visits: 0,
      gym_active: 0,
      not_active: 0,
      bookings: 0,
    };
    const totals = {
      totalVisits: Number(t.total_visits || 0),
      gymActive: Number(t.gym_active || 0),
      notActive: Number(t.not_active || 0),
      bookings: Number(t.bookings || 0),
    };

    return res.render("staffGym", {
      staff: staffRows.rows,
      recentVisits,
      totals,
    });
  } catch (err) {
    console.error("Error loading gym staff page:", err);
    return res.render("staffGym", {
      staff: [],
      recentVisits: [],
      totals: { totalVisits: 0, gymActive: 0, notActive: 0, bookings: 0 },
      message: "Server error while loading Gym page.",
    });
  }
});

app.post("/api/staff/gym/identify", async (req, res) => {
  try {
    const barcode =
      req.body && req.body.barcode ? String(req.body.barcode).trim() : "";
    if (!barcode)
      return safeJson(res.status(400), {
        ok: false,
        message: "Missing barcode",
      });

    const userRes = await query(
      `SELECT id, fullname, student_id, gym_active FROM users WHERE student_id = $1 LIMIT 1`,
      [barcode]
    );
    if (userRes.rowCount === 0)
      return safeJson(res, { ok: false, message: "Student not found" });

    const user = userRes.rows[0];
    await query(
      `INSERT INTO gym_visits (user_id, student_id, student_name, gym_active, created_at) VALUES ($1, $2, $3, $4, now())`,
      [user.id, user.student_id, user.fullname, user.gym_active]
    );

    const recentRes = await query(
      `SELECT gv.id, gv.created_at, u.fullname AS student_name, u.student_id, u.gym_active, u.id AS user_id
       FROM gym_visits gv
       JOIN users u ON gv.user_id = u.id
       ORDER BY gv.created_at DESC
       LIMIT 8`
    );

    const recentVisits = recentRes.rows.map((r) => ({
      id: r.id,
      time: r.created_at,
      student_name: r.student_name,
      student_id: r.student_id,
      gym_active: r.gym_active,
      photo_path: `/user/photo/${r.user_id}`,
    }));

    return safeJson(res, {
      ok: true,
      student: {
        id: user.id,
        name: user.fullname,
        student_id: user.student_id,
        gym_active: user.gym_active,
        photo_url: `/user/photo/${user.id}`,
      },
      recentVisits,
    });
  } catch (err) {
    console.error("Error /api/staff/gym/identify:", err);
    return safeJson(res.status(500), { ok: false, message: "Server error" });
  }
});

app.post("/api/staff/gym/compare", upload.single("image"), async (req, res) => {
  try {
    const staff = req.session && req.session.staff;
    if (!staff || staff.section !== "gym")
      return safeJson(res.status(403), {
        ok: false,
        message: "Forbidden: not gym staff",
      });
    if (!req.file || !req.file.buffer)
      return safeJson(res.status(400), {
        ok: false,
        message: "Probe image (image) is required",
      });

    const probeBuf = req.file.buffer;
    const userId = req.body.user_id || req.body.student_id;
    if (!userId)
      return safeJson(res.status(400), {
        ok: false,
        message: "user_id (target) is required",
      });

    const u = await query(
      "SELECT id, fullname, student_id, gym_active, photo_data FROM users WHERE id = $1 LIMIT 1",
      [userId]
    );
    if (u.rowCount === 0)
      return safeJson(res.status(404), {
        ok: false,
        message: "Target user not found",
      });

    const userRow = u.rows[0];
    if (!userRow.photo_data)
      return safeJson(res.status(404), {
        ok: false,
        message: "Target user has no stored photo",
      });

    const cmp = await faceppCompare(probeBuf, userRow.photo_data);
    if (!cmp)
      return safeJson(res.status(502), {
        ok: false,
        message: "Face++ returned invalid response",
      });
    if (cmp.error_message)
      return safeJson(res.status(500), {
        ok: false,
        message: "Face++ error: " + cmp.error_message,
        raw: cmp,
      });

    const confidence = Number(cmp.confidence ?? -1);
    const threshold = Number(process.env.FACEPP_THRESHOLD ?? 70);
    const matched = confidence >= threshold;
    let insertId = null;

    if (matched) {
      try {
        const staffId = staff.id || null;
        const insertRes = await query(
          `INSERT INTO gym_visits (user_id, student_id, student_name, gym_active, created_at, staff_id)
           VALUES ($1, $2, $3, $4, now(), $5) RETURNING id`,
          [
            userRow.id,
            userRow.student_id,
            userRow.fullname,
            userRow.gym_active,
            staffId,
          ]
        );
        if (insertRes.rowCount > 0) insertId = insertRes.rows[0].id;
      } catch (e) {
        console.error("Insert gym_visit failed:", e);
      }
    }

    return safeJson(res, {
      ok: true,
      matched,
      confidence,
      threshold,
      student: {
        id: userRow.id,
        name: userRow.fullname,
        student_id: userRow.student_id,
        gym_active: userRow.gym_active,
        photo_url: `/user/photo/${userRow.id}`,
      },
      inserted_visit_id: insertId,
      facepp_raw: cmp,
    });
  } catch (err) {
    console.error("Face++ gym compare route error:", err);
    return safeJson(res.status(500), {
      ok: false,
      message: "Server error",
      error: String(err),
    });
  }
});

app.post("/api/staff/gym/scan", upload.single("image"), async (req, res) => {
  try {
    const staff = req.session && req.session.staff;
    if (!staff || staff.section !== "gym")
      return safeJson(res.status(403), {
        ok: false,
        message: "Forbidden: not gym staff",
      });
    if (!req.file || !req.file.buffer)
      return safeJson(res.status(400), {
        ok: false,
        message: "Probe image (image) is required",
      });

    const probeBuf = req.file.buffer;
    const usersRes = await query(
      `SELECT id, fullname, student_id, gym_active, photo_data FROM users WHERE photo_data IS NOT NULL`
    );
    const users = usersRes.rows || [];

    if (!users.length)
      return safeJson(res, {
        ok: true,
        matched: false,
        message: "No users with stored photos",
      });

    const threshold = Number(process.env.FACEPP_THRESHOLD ?? 70);
    let matchedUser = null;
    let matchedConfidence = -1;
    let rawCompare = null;

    for (const u of users) {
      try {
        const cmp = await faceppCompare(probeBuf, u.photo_data);
        rawCompare = cmp;
        if (cmp && cmp.confidence !== undefined) {
          const conf = Number(cmp.confidence);
          if (conf >= threshold) {
            matchedUser = u;
            matchedConfidence = conf;
            break;
          }
        } else if (cmp && cmp.error_message) {
          console.warn("Face++ error for user", u.id, cmp.error_message);
        }
        await new Promise((r) => setTimeout(r, 120));
      } catch (e) {
        console.error(
          "Face++ compare error for user",
          u.id,
          e && e.response && e.response.data ? e.response.data : e.message || e
        );
      }
    }

    if (!matchedUser)
      return safeJson(res, {
        ok: true,
        matched: false,
        confidence: matchedConfidence,
        threshold,
        facepp_raw: rawCompare,
      });

    let insertedId = null;
    let createdAt = new Date().toISOString();
    try {
      const staffId = staff.id || null;
      const insertRes = await query(
        `INSERT INTO gym_visits (user_id, student_id, student_name, gym_active, created_at, staff_id)
         VALUES ($1, $2, $3, $4, now(), $5) RETURNING id, created_at`,
        [
          matchedUser.id,
          matchedUser.student_id,
          matchedUser.fullname,
          matchedUser.gym_active,
          staffId,
        ]
      );
      if (insertRes.rowCount > 0) {
        insertedId = insertRes.rows[0].id;
        createdAt = insertRes.rows[0].created_at || createdAt;
      }
    } catch (e) {
      console.error("Insert gym_visit failed in scan route:", e);
    }

    const recentVisit = {
      id: insertedId,
      student_id: matchedUser.student_id,
      student_name: matchedUser.fullname,
      gym_active: matchedUser.gym_active,
      photo_path: `/user/photo/${matchedUser.id}`,
      created_at: createdAt,
    };

    return safeJson(res, {
      ok: true,
      matched: true,
      confidence: matchedConfidence,
      threshold,
      student: {
        id: matchedUser.id,
        name: matchedUser.fullname,
        student_id: matchedUser.student_id,
        gym_active: matchedUser.gym_active,
        photo_url: `/user/photo/${matchedUser.id}`,
      },
      inserted_visit_id: insertedId,
      recentVisit,
      facepp_raw: rawCompare,
    });
  } catch (err) {
    console.error("Gym scan route error:", err);
    return safeJson(res.status(500), {
      ok: false,
      message: "Server error",
      error: String(err),
    });
  }
});

// Add this near your other admin routes (before app.listen)
app.post("/admin/add/amount", async (req, res) => {
  try {
    // require admin session
    if (!req.session || !req.session.admin) return res.redirect("/adminLogin");

    const usn = (req.body.amountUSN || "").trim();
    const rawAmount = req.body.amountValue;
    const amount = Number(rawAmount);

    // simple validation
    if (!usn || !rawAmount || isNaN(amount) || amount <= 0) {
      const counts = await getCounts();
      return res.render("admin-dashboard", {
        message: "Invalid USN or amount.",
        totalStudents: counts.totalStudents,
        hostelite: counts.hostelite,
        dayScholar: counts.dayScholar,
        admin: req.session.admin,
      });
    }

    // perform update: wallet = wallet + amount
    const upd = await query(
      "UPDATE users SET wallet = COALESCE(wallet, 0) + $1 WHERE student_id = $2 RETURNING wallet",
      [amount, usn]
    );

    const counts = await getCounts();

    if (upd.rowCount === 0) {
      return res.render("admin-dashboard", {
        message: "Student not found (check USN).",
        totalStudents: counts.totalStudents,
        hostelite: counts.hostelite,
        dayScholar: counts.dayScholar,
        admin: req.session.admin,
      });
    }

    const newWallet = upd.rows[0].wallet;
    return res.render("admin-dashboard", {
      message: `Amount added successfully. New wallet balance: ${newWallet}`,
      totalStudents: counts.totalStudents,
      hostelite: counts.hostelite,
      dayScholar: counts.dayScholar,
      admin: req.session.admin,
    });
  } catch (err) {
    console.error("Add amount error:", err);
    const counts = await getCounts().catch(() => ({
      totalStudents: 0,
      hostelite: 0,
      dayScholar: 0,
    }));
    return res.render("admin-dashboard", {
      message: "Server error. Try again.",
      totalStudents: counts.totalStudents,
      hostelite: counts.hostelite,
      dayScholar: counts.dayScholar,
      admin: req.session && req.session.admin,
    });
  }
});

app.get("/sdmcet/staff/sports", async (req, res) => {
  try {
    const staffRows = await query(
      "SELECT id, username FROM sports ORDER BY id ASC"
    );

    const rv = await query(
      `SELECT sv.id, sv.student_id, sv.student_name, sv.indoor_sports_active, sv.face_path, sv.created_at
       FROM sports_visits sv
       ORDER BY sv.created_at DESC
       LIMIT 500`
    );

    const recentVisits = rv.rows.map((r) => ({
      id: r.id,
      student_id: r.student_id,
      student_name: r.student_name,
      indoor_sports_active: r.indoor_sports_active,
      photo_path:
        r.face_path || (r.student_id ? `/user/photo/${r.student_id}` : null),
      created_at: r.created_at,
    }));

    const totalsQ = await query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS total_visits,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND indoor_sports_active = true)::int AS sports_active,
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND (indoor_sports_active = false OR indoor_sports_active IS FALSE))::int AS not_active,
         0::int AS bookings
       FROM sports_visits`
    );

    const t = totalsQ.rows[0] || {
      total_visits: 0,
      sports_active: 0,
      not_active: 0,
      bookings: 0,
    };
    const totals = {
      totalVisits: Number(t.total_visits || 0),
      sportsActive: Number(t.sports_active || 0),
      notActive: Number(t.not_active || 0),
      bookings: Number(t.bookings || 0),
    };

    return res.render("staffSports", {
      staff: staffRows.rows,
      recentVisits,
      totals,
    });
  } catch (err) {
    console.error("Error loading sports staff page:", err);
    return res.render("staffSports", {
      staff: [],
      recentVisits: [],
      totals: { totalVisits: 0, sportsActive: 0, notActive: 0, bookings: 0 },
      message: "Server error while loading Sports page.",
    });
  }
});

app.post("/api/staff/sports/identify", async (req, res) => {
  try {
    const barcode =
      req.body && req.body.barcode ? String(req.body.barcode).trim() : "";
    if (!barcode)
      return safeJson(res.status(400), {
        ok: false,
        message: "Missing barcode",
      });

    const userRes = await query(
      `SELECT id, fullname, student_id, indoor_sports_active FROM users WHERE student_id = $1 LIMIT 1`,
      [barcode]
    );
    if (userRes.rowCount === 0)
      return safeJson(res, { ok: false, message: "Student not found" });

    const user = userRes.rows[0];
    await query(
      `INSERT INTO sports_visits (user_id, student_id, student_name, indoor_sports_active, created_at) VALUES ($1, $2, $3, $4, now())`,
      [user.id, user.student_id, user.fullname, user.indoor_sports_active]
    );

    const recentRes = await query(
      `SELECT sv.id, sv.created_at, u.fullname AS student_name, u.student_id, u.indoor_sports_active, u.id AS user_id
       FROM sports_visits sv
       JOIN users u ON sv.user_id = u.id
       ORDER BY sv.created_at DESC
       LIMIT 8`
    );

    const recentVisits = recentRes.rows.map((r) => ({
      id: r.id,
      time: r.created_at,
      student_name: r.student_name,
      student_id: r.student_id,
      indoor_sports_active: r.indoor_sports_active,
      photo_path: `/user/photo/${r.user_id}`,
    }));

    return safeJson(res, {
      ok: true,
      student: {
        id: user.id,
        name: user.fullname,
        student_id: user.student_id,
        indoor_sports_active: user.indoor_sports_active,
        photo_url: `/user/photo/${user.id}`,
      },
      recentVisits,
    });
  } catch (err) {
    console.error("Error /api/staff/sports/identify:", err);
    return safeJson(res.status(500), { ok: false, message: "Server error" });
  }
});

app.post(
  "/api/staff/sports/compare",
  upload.single("image"),
  async (req, res) => {
    try {
      const staff = req.session && req.session.staff;
      if (!staff || staff.section !== "sports")
        return safeJson(res.status(403), {
          ok: false,
          message: "Forbidden: not sports staff",
        });
      if (!req.file || !req.file.buffer)
        return safeJson(res.status(400), {
          ok: false,
          message: "Probe image (image) is required",
        });

      const probeBuf = req.file.buffer;
      const userId = req.body.user_id || req.body.student_id;
      if (!userId)
        return safeJson(res.status(400), {
          ok: false,
          message: "user_id (target) is required",
        });

      const u = await query(
        "SELECT id, fullname, student_id, indoor_sports_active, photo_data FROM users WHERE id = $1 LIMIT 1",
        [userId]
      );
      if (u.rowCount === 0)
        return safeJson(res.status(404), {
          ok: false,
          message: "Target user not found",
        });

      const userRow = u.rows[0];
      if (!userRow.photo_data)
        return safeJson(res.status(404), {
          ok: false,
          message: "Target user has no stored photo",
        });

      const cmp = await faceppCompare(probeBuf, userRow.photo_data);
      if (!cmp)
        return safeJson(res.status(502), {
          ok: false,
          message: "Face++ returned invalid response",
        });
      if (cmp.error_message)
        return safeJson(res.status(500), {
          ok: false,
          message: "Face++ error: " + cmp.error_message,
          raw: cmp,
        });

      const confidence = Number(cmp.confidence ?? -1);
      const threshold = Number(process.env.FACEPP_THRESHOLD ?? 70);
      const matched = confidence >= threshold;
      let insertId = null;

      if (matched) {
        try {
          const staffId = staff.id || null;
          const insertRes = await query(
            `INSERT INTO sports_visits (user_id, student_id, student_name, indoor_sports_active, created_at, staff_id)
           VALUES ($1, $2, $3, $4, now(), $5) RETURNING id`,
            [
              userRow.id,
              userRow.student_id,
              userRow.fullname,
              userRow.indoor_sports_active,
              staffId,
            ]
          );
          if (insertRes.rowCount > 0) insertId = insertRes.rows[0].id;
        } catch (e) {
          console.error("Insert sports_visit failed:", e);
        }
      }

      return safeJson(res, {
        ok: true,
        matched,
        confidence,
        threshold,
        student: {
          id: userRow.id,
          name: userRow.fullname,
          student_id: userRow.student_id,
          indoor_sports_active: userRow.indoor_sports_active,
          photo_url: `/user/photo/${userRow.id}`,
        },
        inserted_visit_id: insertId,
        facepp_raw: cmp,
      });
    } catch (err) {
      console.error("Face++ sports compare route error:", err);
      return safeJson(res.status(500), {
        ok: false,
        message: "Server error",
        error: String(err),
      });
    }
  }
);

app.post("/api/staff/sports/scan", upload.single("image"), async (req, res) => {
  try {
    const staff = req.session && req.session.staff;
    if (!staff || staff.section !== "sports")
      return safeJson(res.status(403), {
        ok: false,
        message: "Forbidden: not sports staff",
      });
    if (!req.file || !req.file.buffer)
      return safeJson(res.status(400), {
        ok: false,
        message: "Probe image (image) is required",
      });

    const probeBuf = req.file.buffer;
    const usersRes = await query(
      `SELECT id, fullname, student_id, indoor_sports_active, photo_data FROM users WHERE photo_data IS NOT NULL`
    );
    const users = usersRes.rows || [];

    if (!users.length)
      return safeJson(res, {
        ok: true,
        matched: false,
        message: "No users with stored photos",
      });

    const threshold = Number(process.env.FACEPP_THRESHOLD ?? 70);
    let matchedUser = null;
    let matchedConfidence = -1;
    let rawCompare = null;

    for (const u of users) {
      try {
        const cmp = await faceppCompare(probeBuf, u.photo_data);
        rawCompare = cmp;
        if (cmp && cmp.confidence !== undefined) {
          const conf = Number(cmp.confidence);
          if (conf >= threshold) {
            matchedUser = u;
            matchedConfidence = conf;
            break;
          }
        } else if (cmp && cmp.error_message) {
          console.warn("Face++ error for user", u.id, cmp.error_message);
        }
        await new Promise((r) => setTimeout(r, 120));
      } catch (e) {
        console.error(
          "Face++ compare error for user",
          u.id,
          e && e.response && e.response.data ? e.response.data : e.message || e
        );
      }
    }

    if (!matchedUser)
      return safeJson(res, {
        ok: true,
        matched: false,
        confidence: matchedConfidence,
        threshold,
        facepp_raw: rawCompare,
      });

    let insertedId = null;
    let createdAt = new Date().toISOString();
    try {
      const staffId = staff.id || null;
      const insertRes = await query(
        `INSERT INTO sports_visits (user_id, student_id, student_name, indoor_sports_active, created_at, staff_id)
         VALUES ($1, $2, $3, $4, now(), $5) RETURNING id, created_at`,
        [
          matchedUser.id,
          matchedUser.student_id,
          matchedUser.fullname,
          matchedUser.indoor_sports_active,
          staffId,
        ]
      );
      if (insertRes.rowCount > 0) {
        insertedId = insertRes.rows[0].id;
        createdAt = insertRes.rows[0].created_at || createdAt;
      }
    } catch (e) {
      console.error("Insert sports_visit failed in scan route:", e);
    }

    const recentVisit = {
      id: insertedId,
      student_id: matchedUser.student_id,
      student_name: matchedUser.fullname,
      indoor_sports_active: matchedUser.indoor_sports_active,
      photo_path: `/user/photo/${matchedUser.id}`,
      created_at: createdAt,
    };

    return safeJson(res, {
      ok: true,
      matched: true,
      confidence: matchedConfidence,
      threshold,
      student: {
        id: matchedUser.id,
        name: matchedUser.fullname,
        student_id: matchedUser.student_id,
        indoor_sports_active: matchedUser.indoor_sports_active,
        photo_url: `/user/photo/${matchedUser.id}`,
      },
      inserted_visit_id: insertedId,
      recentVisit,
      facepp_raw: rawCompare,
    });
  } catch (err) {
    console.error("Sports scan route error:", err);
    return safeJson(res.status(500), {
      ok: false,
      message: "Server error",
      error: String(err),
    });
  }
});

// Graceful shutdown: close DB pool on SIGTERM / SIGINT
async function shutdown() {
  console.log("Shutting down server...");
  try {
    await pool.end();
    console.log("Database pool has ended.");
  } catch (e) {
    console.error("Error while ending database pool:", e);
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Optional startup DB check
(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("Database connection OK");
  } catch (e) {
    console.error("Database connection failed at startup:", e);
    // If DB is required for the app, exit so Render marks the deploy as failed.
    process.exit(1);
  }
})();

//staffLibrary

app.get("/sdmcet/staff/library", async (req, res) => {
  try {
    if (!req.session.staff || req.session.staff.section !== "library") {
      return res.redirect("/adminLogin");
    }

    const result = await query(`
      SELECT 
        u.student_id AS usn,
        u.fullname AS name,
        b.title,
        b.author,
        b.book_id,
        b.book_edition,
        TO_CHAR(b.issued_on, 'DD/MM/YYYY') AS issued_on,
        TO_CHAR(b.due_on, 'DD/MM/YYYY') AS due_on
      FROM borrowed_books b
      JOIN users u ON u.id = b.user_id
      ORDER BY b.issued_on DESC
    `);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const borrowedBooks = result.rows.map((b) => {
      // b.due_on is "DD/MM/YYYY"
      const [day, month, year] = b.due_on.split("/").map(Number);

      const due = new Date(year, month - 1, day);
      due.setHours(0, 0, 0, 0);

      const diffDays = Math.floor(
        (today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)
      );

      let fine = 0;
      if (diffDays > 0) {
        if (diffDays <= 7) {
          fine = diffDays;
        } else {
          fine = 7 + (diffDays - 7) * 5;
        }
      }

      return {
        ...b,
        fine,
      };
    });

    res.render("staffLibrary", { borrowedBooks });
  } catch (err) {
    console.error("GET /staff/library error:", err);
    res.render("staffLibrary", { borrowedBooks: [] });
  }
});

app.post("/staff/library/borrow", async (req, res) => {
  try {
    // staff auth check
    if (!req.session.staff || req.session.staff.section !== "library") {
      return res.redirect("/adminLogin");
    }

    const { usn, title, author, book_id, book_edition } = req.body;

    // basic validation
    if (!usn || !title) {
      return res.redirect("/sdmcet/staff/library");
    }

    // get user_id from users table
    const userRes = await query("SELECT id FROM users WHERE student_id = $1", [
      usn,
    ]);

    if (userRes.rowCount === 0) {
      return res.redirect("/sdmcet/staff/library");
    }

    const userId = userRes.rows[0].id;

    // dates
    const issuedOn = new Date();
    const dueOn = new Date();
    dueOn.setDate(issuedOn.getDate() + 15); // 15-day borrowing period

    // insert into borrowed_books with new columns
    await query(
      `
      INSERT INTO borrowed_books 
        (user_id, title, author, book_id, book_edition, issued_on, due_on)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        userId,
        title,
        author || null,
        book_id || null,
        book_edition || null,
        issuedOn,
        dueOn,
      ]
    );

    return res.redirect("/sdmcet/staff/library");
  } catch (err) {
    console.error("POST /staff/library/borrow error:", err);
    return res.redirect("/sdmcet/staff/library");
  }
});

app.listen(port, () => {
  console.log(`Server running at port ${port}`);
});
