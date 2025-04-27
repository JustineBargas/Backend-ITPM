// server.js (Node.js with Express)
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const http = require("http");
const socketIo = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("uploads"));

// Set up storage for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  },
});

// Initialize multer
//dependency to install =  "npm install multer"
const upload = multer({ storage: storage });

const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "clean_up_tracker",
});

db.connect((err) => {
  if (err) {
    console.error("❌ MySQL connection failed:", err);
  } else {
    console.log("✅ Connected to MySQL Database");
  }
});

app.post("/api/login", async (req, res) => {
  const { emailOrUsername, password } = req.body;

  if (!emailOrUsername || !password) {
    return res.status(400).json({ error: "Email/Username and password are required" });
  }

  try {
    const userSql = "SELECT * FROM users WHERE email = ? OR username = ?";
    const [user] = await db.promise().query(userSql, [emailOrUsername, emailOrUsername]);

    if (!user || user.length === 0) {
      return res.status(401).json({ error: "User not found" });
    }

    const passwordMatch = await bcrypt.compare(password, user[0].password);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const { user_id, role, status } = user[0];
    res.json({ success: true, user: { user_id, role, status } });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/register", async (req, res) => {
  const { fullName, username, email, password, userType, idImagePath } = req.body;
  console.log("Registration Request Body:", req.body); // Log the received data

  if (!fullName || !username || !email || !password) {
    return res.status(400).json({ message: "All fields are required!" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const query = `INSERT INTO users (fullName, username, email, password, userType, idImagePath, createdAt, role, status)
                   VALUES (?, ?, ?, ?, ?, ?, NOW(), 'User', 'Pending')`;

  db.query(query, [fullName, username, email, hashedPassword, userType, idImagePath], (err, result) => {
    if (err) {
      console.error("Database Error during registration:", err); // Log database errors
      return res.status(500).json({ message: "Database error!" });
    }
    console.log("Registration successful:", result); // Log successful registration
    res.status(201).json({ message: "Registration successful!" });
  });
});

app.get("/api/admin/dashboard", (req, res) => {
  const userCountSql = "SELECT COUNT(*) as userCount FROM users";
  const eventCountSql = "SELECT COUNT(*) as eventCount FROM events";
  const notificationCountSql = "SELECT COUNT(*) as notificationCount FROM notifications";

  db.query(userCountSql, (err, userCountResult) => {
    if (err) return res.status(500).json({ error: "Failed to fetch user count" });

    db.query(eventCountSql, (err, eventCountResult) => {
      if (err) return res.status(500).json({ error: "Failed to fetch event count" });

      db.query(notificationCountSql, (err, notificationCountResult) => {
        if (err) return res.status(500).json({ error: "Failed to fetch notification count" });

        res.json({
          userCount: userCountResult[0].userCount,
          eventCount: eventCountResult[0].eventCount,
          notificationCount: notificationCountResult[0].notificationCount,
        });
      });
    });
  });
});

let connectedUsers = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("registerUser", (userId) => {
    connectedUsers[userId] = socket.id;

    const sql = "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC";
    db.query(sql, [userId], (err, results) => {
      if (!err && results.length > 0) {
        let lastEventNotification = null;
        for (let i = 0; i < results.length; i++) {
          if (results[i].message.startsWith("New event:")) {
            lastEventNotification = results[i];
            break;
          }
        }
        socket.emit("unreadNotifications", { notifications: results, newEvent: lastEventNotification });
      } else {
        socket.emit("unreadNotifications", { notifications: [], newEvent: null });
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    Object.keys(connectedUsers).forEach((userId) => {
      if (connectedUsers[userId] === socket.id) delete connectedUsers[userId];
    });
  });
});

app.post("/api/markNotificationsRead", (req, res) => {
  const { notificationId } = req.body;
  const sql = "UPDATE notifications SET is_read = 1 WHERE id = ?";
  db.query(sql, [notificationId], (err) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json({ message: "Notification marked as read" });
  });
});

app.get("/getNotifications", (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const sql = `
    SELECT notif_id, user_id, event_id, message, IFNULL(created_at, NOW()) AS created_at
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC`;

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("❌ Error fetching notifications:", err);
      return res.status(500).json({ error: "Database error" });
    }

    let lastEventNotification = null;
    for (let i = 0; i < results.length; i++) {
      if (results[i].message.startsWith("New event:")) {
        lastEventNotification = results[i];
        break;
      }
    }
    res.json({ notifications: results, newEvent: lastEventNotification });
  });
});

app.post("/addEvent", (req, res) => {
  const { eventName, description, date, time, location, additionalDetails, createdBy } = req.body;

  const checkSql = "SELECT * FROM events WHERE event_name = ? AND event_date = ? AND event_time = ?";
  db.query(checkSql, [eventName, date, time], (err, results) => {
    if (err) {
      console.error("❌ Error checking event:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length > 0) return res.status(400).json({ message: "Event already exists!" });

    const insertSql = `INSERT INTO events (event_name, description, event_date, event_time, location, add_details, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.query(insertSql, [eventName, description, date, time, location, additionalDetails, createdBy], (err, result) => {
      if (err) {
        console.error("❌ Error inserting event:", err);
        return res.status(500).json({ error: "Failed to add event" });
      }

      const eventId = result.insertId;

      const notificationSql = `INSERT INTO notifications (user_id, event_id, message, is_read, created_at) SELECT user_id, ?, ?, 0, NOW() FROM users`;
      db.query(notificationSql, [eventId, `New event: ${eventName}`], (err) => {
        if (err) {
          console.error("❌ Error inserting notifications:", err);
          return res.status(500).json({ error: "Failed to create notifications" });
        }

        io.emit("newEvent", { eventName, description, date, time, location });
        res.json({ message: "Event added successfully!" });
      });
    });
  });
});

app.get("/events", (req, res) => {
  const sql = "SELECT * FROM events ORDER BY event_date ASC";
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json(results);
  });
});

app.get("/events/:id", (req, res) => {
  const { id } = req.params;
  const sql = "SELECT * FROM events WHERE event_id = ?";
  db.query(sql, [id], (err, results) => {
    if (err) {
      console.error("Error fetching event details:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length > 0) {
      res.json(results[0]);
    } else {
      res.status(404).json({ message: "Event not found" });
    }
  });
});

app.get('/api/admin/users', async (req, res) => {
  const filter = req.query.filter;
  let sql = 'SELECT user_id, username, status FROM users';

  if (filter && filter !== 'All') {
    sql += ` WHERE status = "${filter}"`;
  }

  console.log('API Request received with filter:', filter);
  console.log('SQL Query:', sql);

  try {
    const [users] = await db.promise().query(sql);
    console.log('SQL Query Result (users):', users);

    const countQueries = {
      approved: `SELECT COUNT(*) as count FROM users WHERE status = "approved" ${filter !== 'All' ? `AND status = "${filter}"` : ''}`,
      pending: `SELECT COUNT(*) as count FROM users WHERE status = "pending" ${filter !== 'All' ? `AND status = "${filter}"` : ''}`,
      restricted: `SELECT COUNT(*) as count FROM users WHERE status = "restricted" ${filter !== 'All' ? `AND status = "${filter}"` : ''}`,
    };

    const countResults = await Promise.all(
      Object.values(countQueries).map((query) => db.promise().query(query))
    );

    const approvedCount = countResults[0][0][0].count;
    const pendingCount = countResults[1][0][0].count;
    const restrictedCount = countResults[2][0][0].count;

    res.json({
      users,
      approvedCount,
      pendingCount,
      restrictedCount,
      totalUsers: users.length,
    });

    console.log('API Response sent:', {
      users,
      approvedCount,
      pendingCount,
      restrictedCount,
      totalUsers: users.length,
    });
  } catch (err) {
    console.error('Error fetching users or counts:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/admin/users/:userId/status', async (req, res) => {
  const { userId } = req.params;
  const { status } = req.body;

  if (!userId || !status || !['Approved', 'Restricted'].includes(status)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    const sql = 'UPDATE users SET status = ? WHERE user_id = ?';
    await db.promise().query(sql, [status, userId]);
    res.json({ message: 'User status updated successfully' });
  } catch (err) {
    console.error('Error updating user status:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// New API endpoint to handle joining an event
app.post('/joinEvent', async (req, res) => {
  const { userId, eventId } = req.body;

  if (!userId || !eventId) {
    return res.status(400).json({ message: 'User ID and Event ID are required.' });
  }

  try {
    const connection = await db.promise();

    // Check if the user has already joined the event
    const [existingParticipation] = await connection.execute(
      'SELECT * FROM event_participants WHERE user_id = ? AND event_id = ?',
      [userId, eventId]
    );

    if (existingParticipation.length > 0) {
      return res.status(409).json({ message: 'You have already joined this event.' });
    }

    // Insert the new participation record
    await connection.execute(
      'INSERT INTO event_participants (user_id, event_id) VALUES (?, ?)',
      [userId, eventId]
    );

    res.status(200).json({ message: 'Successfully joined the event.' });

  } catch (error) {
    console.error('Error joining event:', error);
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ message: 'Database error: The event_participants table does not exist.' });
    } else if (error.code === 'ER_FK_CONSTRAINT_FOREIGN_KEY') {
      return res.status(400).json({ message: 'Invalid User ID or Event ID.' });
    }
    res.status(500).json({ message: 'Failed to join the event.' });
  }
});

// Report Submission Route
app.post("/api/reports", upload.array("images"), (req, res) => { //corrected the route to /api/reports
  const { userId, latitude, longitude, description } = req.body;
  const images = req.files;

  const reportQuery = "INSERT INTO reports (user, latitude, longitude, description, timestamp) VALUES (?, ?, ?, ?, NOW())";

  db.query(reportQuery, [userId, latitude, longitude, description], (err, result) => {
    if (err) {
      console.error("Error creating report:", err);
      return res.status(500).json({ message: "Failed to create report" });
    }

    const reportId = result.insertId;

    const imageQueries = images.map((image) => {
      const imagePath = image.filename;
      return new Promise((resolve, reject) => {
        const imageQuery = "INSERT INTO report_images (report_id, image) VALUES (?, ?)";
        db.query(imageQuery, [reportId, imagePath], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    Promise.all(imageQueries)
      .then(() => res.status(201).json({ message: "Report created successfully!" }))
      .catch((err) => {
        console.error("Error saving images:", err);
        res.status(500).json({ message: "Failed to save images" });
      });
  });
})

const PORT = 5000;
server.listen(PORT, () => console.log(`🚀 Backend running at http://192.168.1.17:${PORT}`));