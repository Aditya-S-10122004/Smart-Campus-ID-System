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

async function addUser() {
  try {

    const student_id = "2sd23is012";
    const fullname = "Akash Shivapur";
    const email = "akash@example.com";
    const plainPassword = "akash123";
    const hostelite = false;

    const password_hash = await bcrypt.hash(plainPassword, 10);

    const result = await pool.query(
      `INSERT INTO users (student_id, fullname, email, password_hash, hostelite)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, fullname, email;`,
      [student_id, fullname, email, password_hash, hostelite]
    );

    console.log("✅ User added successfully:", result.rows[0]);
  } catch (err) {
    console.error("❌ Error adding user:", err.message);
  } finally {
    pool.end();
  }
}

addUser();
