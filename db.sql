CREATE TABLE admins (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);


CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  student_id VARCHAR(50) UNIQUE,
  fullname VARCHAR(150) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  hostelite BOOLEAN DEFAULT FALSE,
  photo_data BYTEA,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE borrowed_books (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  issued_on DATE NOT NULL,
  due_on DATE NOT NULL
);

CREATE TABLE staff (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

INSERT INTO borrowed_books (user_id, title, issued_on, due_on)
VALUES (
  2,
  'Testing to check the overdue',
  CURRENT_DATE - INTERVAL '14 days',
  CURRENT_DATE - INTERVAL '7 days'
);

CREATE TABLE mess (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE gym (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE sports (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mess_visits (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL,
  student_name VARCHAR(200) NOT NULL,
  hostelite BOOLEAN,
  face_path VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mess_visits_created_at ON mess_visits (created_at);
CREATE INDEX IF NOT EXISTS idx_mess_visits_student_id ON mess_visits (student_id);

CREATE TABLE IF NOT EXISTS gym_visits (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL,
  student_name VARCHAR(200) NOT NULL,
  gym_active BOOLEAN,
  face_path VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_visits_created_at ON gym_visits (created_at);
CREATE INDEX IF NOT EXISTS idx_gym_visits_student_id ON gym_visits (student_id);

CREATE TABLE IF NOT EXISTS sports_visits (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL,
  student_name VARCHAR(200) NOT NULL,
  indoor_sports_active BOOLEAN,
  face_path VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sports_visits_created_at ON sports_visits (created_at);
CREATE INDEX IF NOT EXISTS idx_sports_visits_student_id ON sports_visits (student_id);
