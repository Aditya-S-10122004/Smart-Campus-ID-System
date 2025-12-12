import pkg from "pg";
import bcrypt from "bcrypt";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const pool = new Pool({
  user: process.env.DATABASE_USER,
  host: process.env.DATABASE_HOST || "localhost",
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.DATABASE_PORT ? Number(process.env.DATABASE_PORT) : 5432,
});

async function addAdmin() {
  try {
    const username = process.env.SPORTS_USER;
    const plainPassword = process.env.SPORTS_PASS;

    const password_hash = await bcrypt.hash(plainPassword, 10);

    const result = await pool.query(
      `INSERT INTO sports (username, password_hash) VALUES ($1, $2) RETURNING username`,
      [username, password_hash]
    );

    console.log("✅ User added successfully:", result.rows[0]);
  } catch (err) {
    console.error("❌ Error adding user:", err.message);
  } finally {
    pool.end();
  }
}

addAdmin();
