const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Setup session
app.use(session({
  secret: process.env.SESSION_SECRET || 'my_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if running on HTTPS
}));

// Body parsing middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files
app.use('/static', express.static(path.join(__dirname, 'static')));

// Ensure static/uploads exists
async function ensureUploadsDir() {
  try {
    await fs.mkdir(path.join(__dirname, 'static', 'uploads'), { recursive: true });
  } catch (err) {
    console.error("Error creating uploads directory:", err);
  }
}
ensureUploadsDir();

// Setup template engine to render HTML files using EJS
app.set('views', path.join(__dirname, 'templates'));
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');

// MySQL Connection Pool Setup
let pool;
try {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'chatbot',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
} catch (e) {
  console.error("Error initializing MySQL connection pool:", e);
}

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Setup Multer for handling file uploads (stored in memory first, then written to disk)
const upload = multer({ storage: multer.memoryStorage() });

// Helpers
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findKBMatch(userMessage, connection) {
  if (!userMessage) {
    return { responseText: null, contentId: null };
  }
  
  const [rows] = await connection.execute("SELECT content_id, keywords, response_text FROM knowledge_base");
  
  let bestMatch = null;
  let maxLen = -1;
  const msgLower = userMessage.toLowerCase().trim();
  
  for (const row of rows) {
    if (!row.keywords) continue;
    const keywords = row.keywords.split(',').map(k => k.trim().toLowerCase());
    for (const kw of keywords) {
      if (!kw) continue;
      const pattern = new RegExp('\\b' + escapeRegExp(kw) + '\\b', 'i');
      if (pattern.test(msgLower)) {
        if (kw.length > maxLen) {
          maxLen = kw.length;
          bestMatch = {
            contentId: row.content_id,
            responseText: row.response_text
          };
        }
      }
    }
  }
  
  if (bestMatch) {
    return { responseText: bestMatch.responseText, contentId: bestMatch.contentId };
  }
  return { responseText: null, contentId: null };
}

function parseMessageAttachment(messageText) {
  if (!messageText) {
    return { cleanText: "", filePath: null, mimeType: null, filename: null };
  }
  
  const pattern = /(?:\r?\n)?\[file:([^|\]]+)\|([^|\]]+)\|([^\]]+)\]$/;
  const match = messageText.match(pattern);
  if (match) {
    const filePath = match[1];
    const mimeType = match[2];
    const filename = match[3];
    const cleanText = messageText.replace(pattern, '').trim();
    return { cleanText, filePath, mimeType, filename };
  }
  
  return { cleanText: messageText, filePath: null, mimeType: null, filename: null };
}

function formatDateTime(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const pad = (num) => String(num).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTime12h(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; 
  const hoursStr = String(hours).padStart(2, '0');
  return `${hoursStr}:${minutes} ${ampm}`;
}

function formatDateTimeMinutes(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const pad = (num) => String(num).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Authentication Middlewares
const requireLogin = (req, res, next) => {
  if (!req.session.username) {
    return res.redirect('/');
  }
  next();
};

const requireLoginApi = (req, res, next) => {
  if (!req.session.username) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// Routes
app.get('/', (req, res) => {
  res.render('login.html', { error: null });
});

app.post('/', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.execute(
      "SELECT user_id, name FROM users WHERE email = ? AND password = ?",
      [email, password]
    );
    
    if (rows.length > 0) {
      const user = rows[0];
      req.session.userId = user.user_id;
      req.session.username = user.name;
      return res.redirect('/chatbot');
    } else {
      return res.render('login.html', { error: "Invalid Email or Password" });
    }
  } catch (err) {
    console.error("Login database error:", err);
    return res.render('login.html', { error: "Database connection error. Please try again." });
  }
});

app.get('/register', (req, res) => {
  res.render('register.html', { msg: null });
});

app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const [existing] = await pool.execute(
      "SELECT user_id FROM users WHERE email = ?",
      [email]
    );
    
    if (existing.length > 0) {
      return res.render('register.html', { msg: "Email already registered!" });
    }
    
    await pool.execute(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, password]
    );
    
    return res.render('register.html', { msg: "Registered Successfully! You can now login." });
  } catch (err) {
    console.error("Registration database error:", err);
    return res.render('register.html', { msg: "Database error. Please try again." });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/guest', (req, res) => {
  req.session.userId = null;
  req.session.username = 'Guest';
  res.redirect('/chatbot');
});

app.get('/chatbot', requireLogin, (req, res) => {
  res.render('chatbot.html', { username: req.session.username });
});

app.get('/api/sessions', requireLoginApi, async (req, res) => {
  const userId = req.session.userId;
  
  if (userId === null || userId === undefined) {
    // Guest user has no saved sessions
    return res.json({ sessions: [] });
  }
  
  try {
    const [sessions] = await pool.execute(
      "SELECT session_id, start_time FROM chat_session WHERE user_id = ? ORDER BY start_time DESC",
      [userId]
    );
    
    // Fetch first message for each session to use as title
    for (const sessionItem of sessions) {
      const [messages] = await pool.execute(
        "SELECT message_text FROM messages WHERE session_id = ? AND sender_type = 'user' ORDER BY timestamp ASC LIMIT 1",
        [sessionItem.session_id]
      );
      
      let title = "New Session";
      if (messages.length > 0) {
        const { cleanText } = parseMessageAttachment(messages[0].message_text);
        title = cleanText ? cleanText : "File Attachment";
      }
      
      sessionItem.title = title;
      sessionItem.start_time = formatDateTime(sessionItem.start_time);
    }
    
    return res.json({ sessions });
  } catch (err) {
    console.error("Error handling sessions GET:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

app.post('/api/sessions', requireLoginApi, async (req, res) => {
  const userId = req.session.userId || null;
  
  try {
    const [result] = await pool.execute(
      "INSERT INTO chat_session (user_id, start_time, end_time) VALUES (?, NOW(), NOW())",
      [userId]
    );
    return res.json({ session_id: result.insertId });
  } catch (err) {
    console.error("Error handling sessions POST:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

app.get('/api/sessions/:session_id/messages', requireLoginApi, async (req, res) => {
  const sessionId = req.params.session_id;
  const userId = req.session.userId || null;
  
  try {
    // Verify session ownership
    let sessionCheckQuery, sessionCheckParams;
    if (userId) {
      sessionCheckQuery = "SELECT session_id FROM chat_session WHERE session_id = ? AND user_id = ?";
      sessionCheckParams = [sessionId, userId];
    } else {
      sessionCheckQuery = "SELECT session_id FROM chat_session WHERE session_id = ? AND user_id IS NULL";
      sessionCheckParams = [sessionId];
    }
    
    const [sessionCheck] = await pool.execute(sessionCheckQuery, sessionCheckParams);
    if (sessionCheck.length === 0) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    const [messages] = await pool.execute(
      "SELECT message_id, sender_type, message_text, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
      [sessionId]
    );
    
    for (const msg of messages) {
      msg.time = formatTime12h(msg.timestamp);
    }
    
    return res.json({ messages });
  } catch (err) {
    console.error("Error fetching messages:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

app.delete('/api/sessions/:session_id', requireLoginApi, async (req, res) => {
  const sessionId = req.params.session_id;
  const userId = req.session.userId || null;
  
  try {
    // Verify session ownership
    let sessionCheckQuery, sessionCheckParams;
    if (userId) {
      sessionCheckQuery = "SELECT session_id FROM chat_session WHERE session_id = ? AND user_id = ?";
      sessionCheckParams = [sessionId, userId];
    } else {
      sessionCheckQuery = "SELECT session_id FROM chat_session WHERE session_id = ? AND user_id IS NULL";
      sessionCheckParams = [sessionId];
    }
    
    const [sessionCheck] = await pool.execute(sessionCheckQuery, sessionCheckParams);
    if (sessionCheck.length === 0) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    // Clean up files associated with messages in this session
    const [messages] = await pool.execute(
      "SELECT message_text FROM messages WHERE session_id = ?",
      [sessionId]
    );
    
    for (const msg of messages) {
      const { filePath } = parseMessageAttachment(msg.message_text);
      if (filePath) {
        const relativePath = filePath.replace(/^\//, ''); // strip leading slash
        const fullPath = path.join(__dirname, relativePath);
        try {
          await fs.unlink(fullPath);
        } catch (err) {
          console.error(`Failed to delete file ${fullPath}:`, err.message);
        }
      }
    }
    
    await pool.execute("DELETE FROM messages WHERE session_id = ?", [sessionId]);
    if (userId) {
      await pool.execute("DELETE FROM chat_session WHERE session_id = ? AND user_id = ?", [sessionId, userId]);
    } else {
      await pool.execute("DELETE FROM chat_session WHERE session_id = ? AND user_id IS NULL", [sessionId]);
    }
    
    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting session:", err);
    return res.status(500).json({ error: "Failed to delete session" });
  }
});

app.post('/chat', requireLoginApi, upload.single('file'), async (req, res) => {
  const userMessage = (req.body.message || '').trim();
  const sessionId = req.body.session_id;
  const userId = req.session.userId || null;
  
  if (!userMessage && !req.file) {
    return res.status(400).json({ reply: "Please enter a message or attach a file." });
  }
  
  if (!sessionId) {
    return res.status(400).json({ reply: "Session not found." });
  }
  
  try {
    // Verify session ownership
    let sessionCheckQuery, sessionCheckParams;
    if (userId) {
      sessionCheckQuery = "SELECT session_id FROM chat_session WHERE session_id = ? AND user_id = ?";
      sessionCheckParams = [sessionId, userId];
    } else {
      sessionCheckQuery = "SELECT session_id FROM chat_session WHERE session_id = ? AND user_id IS NULL";
      sessionCheckParams = [sessionId];
    }
    
    const [sessionCheck] = await pool.execute(sessionCheckQuery, sessionCheckParams);
    if (sessionCheck.length === 0) {
      return res.status(403).json({ reply: "Invalid session or unauthorized access." });
    }
    
    let fileBytes = null;
    let mimeType = null;
    let filename = null;
    let fileUrl = null;
    
    // Save file if present
    if (req.file) {
      filename = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
      const uniqueFilename = `${sessionId}_${Math.floor(Date.now() / 1000)}_${filename}`;
      const uploadDir = path.join(__dirname, 'static', 'uploads');
      const filepath = path.join(uploadDir, uniqueFilename);
      
      fileBytes = req.file.buffer;
      mimeType = req.file.mimetype;
      
      await fs.writeFile(filepath, fileBytes);
      fileUrl = `/static/uploads/${uniqueFilename}`;
    }
    
    // Format message with file metadata if present
    let msgToSave = userMessage;
    if (fileUrl) {
      msgToSave += `${userMessage ? '\n' : ''}[file:${fileUrl}|${mimeType}|${filename}]`;
    }
    
    // 1. Insert user message
    const [insertUserResult] = await pool.execute(
      "INSERT INTO messages (session_id, sender_type, message_text, timestamp) VALUES (?, 'user', ?, NOW())",
      [sessionId, msgToSave]
    );
    const userMessageId = insertUserResult.insertId;
    
    let botReply = null;
    let contentId = null;
    
    // 2. Query knowledge_base ONLY if NO file is uploaded
    if (!fileUrl && userMessage) {
      const kbMatch = await findKBMatch(userMessage, pool);
      botReply = kbMatch.responseText;
      contentId = kbMatch.contentId;
    }
    
    // 3. Fallback to Gemini if no knowledge base match or file was uploaded
    if (!botReply) {
      try {
        const sysPrompt = 
          "You are chatbot, A Hybrid AI-Powered Retrieval Chatbot. " +
          "Provide clear, insightful, and beautifully formatted answers. " +
          "You MUST use Markdown for formatting (e.g., bolding, bullet points, headers, tables, and code blocks). " +
          "If the user asks for code, always use proper markdown code blocks with the language specified.";
        
        const contents = [sysPrompt];
        
        if (fileBytes) {
          contents.push({
            inlineData: {
              data: fileBytes.toString('base64'),
              mimeType: mimeType
            }
          });
        }
        
        if (userMessage) {
          contents.push(userMessage);
        } else if (fileBytes) {
          contents.push("Please describe or analyze this attached file.");
        }
        
        const response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: contents
        });
        
        botReply = response.text;
      } catch (err) {
        console.error("Gemini API Error:", err);
        botReply = "I'm sorry, I'm having trouble processing that right now. Please try again.";
      }
    }
    
    // 4. Insert bot message
    await pool.execute(
      "INSERT INTO messages (session_id, sender_type, message_text, timestamp) VALUES (?, 'bot', ?, NOW())",
      [sessionId, botReply]
    );
    
    // Update session end time
    await pool.execute(
      "UPDATE chat_session SET end_time = NOW() WHERE session_id = ?",
      [sessionId]
    );
    
    // Wait a brief period to mimic typing/db synchronization
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return res.json({
      reply: botReply,
      content_id: contentId,
      user_message_id: userMessageId
    });
  } catch (err) {
    console.error("Database error in chat route:", err);
    return res.json({
      reply: "I'm currently experiencing database connection issues. Please try again later.",
      content_id: null,
      user_message_id: null
    });
  }
});

app.post('/api/messages/edit', requireLoginApi, upload.none(), async (req, res) => {
  const messageId = req.body.message_id;
  const sessionId = req.body.session_id;
  const newText = (req.body.new_text || '').trim();
  const userId = req.session.userId || null;
  
  if (!messageId || !sessionId || !newText) {
    return res.status(400).json({ error: "Missing parameters" });
  }
  
  try {
    // Verify session ownership
    let sessionCheckQuery, sessionCheckParams;
    if (userId) {
      sessionCheckQuery = "SELECT session_id FROM chat_session WHERE session_id = ? AND user_id = ?";
      sessionCheckParams = [sessionId, userId];
    } else {
      sessionCheckQuery = "SELECT session_id FROM chat_session WHERE session_id = ? AND user_id IS NULL";
      sessionCheckParams = [sessionId];
    }
    
    const [sessionCheck] = await pool.execute(sessionCheckQuery, sessionCheckParams);
    if (sessionCheck.length === 0) {
      return res.status(403).json({ error: "Unauthorized access" });
    }
    
    // Fetch the original message to preserve any file attachment metadata
    const [origMessage] = await pool.execute(
      "SELECT message_text FROM messages WHERE message_id = ? AND session_id = ?",
      [messageId, sessionId]
    );
    
    if (origMessage.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }
    
    const origText = origMessage[0].message_text;
    const { filePath, mimeType, filename } = parseMessageAttachment(origText);
    
    // Reconstruct message with original attachment metadata
    let textToSave = newText;
    if (filePath) {
      textToSave += `\n[file:${filePath}|${mimeType}|${filename}]`;
    }
    
    // Update user message
    await pool.execute(
      "UPDATE messages SET message_text = ? WHERE message_id = ? AND session_id = ?",
      [textToSave, messageId, sessionId]
    );
    
    // Find next bot message
    const [botMsg] = await pool.execute(
      "SELECT message_id FROM messages WHERE session_id = ? AND message_id > ? AND sender_type = 'bot' ORDER BY message_id ASC LIMIT 1",
      [sessionId, messageId]
    );
    
    let botReply = null;
    let contentId = null;
    
    // Query KB ONLY if there is no file attachment
    if (!filePath) {
      const kbMatch = await findKBMatch(newText, pool);
      botReply = kbMatch.responseText;
      contentId = kbMatch.contentId;
    }
    
    // Fallback Gemini
    if (!botReply) {
      try {
        const sysPrompt = 
          "You are chatbot, A Hybrid AI-Powered Retrieval Chatbot. " +
          "Provide clear, insightful, and beautifully formatted answers. " +
          "You MUST use Markdown for formatting (e.g., bolding, bullet points, headers, tables, and code blocks). " +
          "If the user asks for code, always use proper markdown code blocks with the language specified.";
        
        const contents = [sysPrompt];
        
        if (filePath) {
          const relativePath = filePath.replace(/^\//, ''); // strip leading slash
          const fullPath = path.join(__dirname, relativePath);
          try {
            const fileBytes = await fs.readFile(fullPath);
            contents.push({
              inlineData: {
                data: fileBytes.toString('base64'),
                mimeType: mimeType
              }
            });
          } catch (err) {
            console.error(`Error reading file ${fullPath} in edit message fallback:`, err.message);
          }
        }
        
        if (newText) {
          contents.push(newText);
        } else if (filePath) {
          contents.push("Please describe or analyze this attached file.");
        }
        
        const response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: contents
        });
        botReply = response.text;
      } catch (err) {
        console.error("Gemini API Error in edit:", err);
        botReply = "I'm sorry, I'm having trouble processing that right now. Please try again.";
      }
    }
    
    let botMessageId = null;
    if (botMsg.length > 0) {
      // Update existing bot response
      botMessageId = botMsg[0].message_id;
      await pool.execute(
        "UPDATE messages SET message_text = ? WHERE message_id = ?",
        [botReply, botMessageId]
      );
    } else {
      // If there was no bot response, insert one
      const [insertResult] = await pool.execute(
        "INSERT INTO messages (session_id, sender_type, message_text, timestamp) VALUES (?, 'bot', ?, NOW())",
        [sessionId, botReply]
      );
      botMessageId = insertResult.insertId;
    }
    
    return res.json({
      reply: botReply,
      content_id: contentId,
      bot_message_id: botMessageId
    });
  } catch (err) {
    console.error("Error in edit_message:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

app.post('/api/notes/save', requireLoginApi, async (req, res) => {
  const userId = req.session.userId;
  const contentId = req.body.content_id;
  
  if (userId === null || userId === undefined) {
    return res.status(401).json({ success: false, message: "Guests cannot save notes. Please login." });
  }
  
  if (!contentId) {
    return res.status(400).json({ success: false, message: "No content to save." });
  }
  
  try {
    await pool.execute(
      "INSERT INTO saved_notes (user_id, content_id, saved_at) VALUES (?, ?, NOW())",
      [userId, contentId]
    );
    return res.json({ success: true, message: "Note saved successfully!" });
  } catch (err) {
    console.error("Error saving note:", err);
    return res.status(500).json({ success: false, message: "Failed to save note." });
  }
});

app.get('/api/notes', requireLoginApi, async (req, res) => {
  const userId = req.session.userId;
  
  if (userId === null || userId === undefined) {
    return res.status(401).json({ success: false, notes: [] });
  }
  
  try {
    const [notes] = await pool.execute(
      `SELECT sn.save_id, sn.saved_at, kb.topic, kb.response_text 
       FROM saved_notes sn
       JOIN knowledge_base kb ON sn.content_id = kb.content_id
       WHERE sn.user_id = ?
       ORDER BY sn.saved_at DESC`,
      [userId]
    );
    
    for (const note of notes) {
      note.saved_at = formatDateTimeMinutes(note.saved_at);
    }
    
    return res.json({ success: true, notes: notes });
  } catch (err) {
    console.error("Error fetching notes:", err);
    return res.status(500).json({ success: false, notes: [] });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
