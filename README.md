# Hybrid AI-Powered Retrieval Chatbot

A full-stack chatbot that answers from a custom knowledge base first, 
and falls back to the Gemini API when no match is found — supporting 
authenticated sessions, file uploads (PDF/image), and saved notes.

## Features
- Session-based user authentication (login, register, guest mode)
- Persistent multi-session chat history
- Keyword-based retrieval from a custom knowledge base for fast, 
  predefined answers
- Gemini API fallback for open-ended queries when no knowledge base match is found
- File upload support — PDF and image attachments analyzed via Gemini's multimodal input
- Edit previously sent messages, with bot response auto-regenerated
- Save chatbot responses as notes for later reference
- Markdown-formatted bot replies with syntax-highlighted code blocks
- Voice input via Web Speech API
- Light/dark theme toggle

## Tech Stack
- **Backend:** Node.js, Express.js
- **Database:** MySQL (mysql2), schema designed in MySQL Workbench
- **AI:** Google Gemini API (@google/genai)
- **Templating:** EJS
- **File handling:** Multer
- **Frontend:** Vanilla JS, marked.js (Markdown), highlight.js

## Database Schema
5 tables:
- `users` — accounts and credentials
- `chat_session` — one row per conversation session
- `messages` — all user/bot messages, linked to a session
- `saved_notes` — user-saved responses, linked to knowledge base entries
- `knowledge_base` — keyword-indexed Q&A pairs used for retrieval-based replies

## How it works
1. User sends a message (optionally with a file attachment)
2. If no file is attached, the system checks `knowledge_base` for a keyword match
3. If no match is found (or a file was attached), the message is sent to the Gemini API instead
4. Both user and bot messages are stored in `messages` for persistent history

## Setup
\`\`\`bash
git clone https://github.com/ImGakash/Hybrid-retrival-based-AI-chatbot.git
cd Hybrid-retrival-based-AI-chatbot
npm install
\`\`\`

Create a `.env` file:
\`\`\`
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
SESSION_SECRET=
GEMINI_API_KEY=
PORT=5000
\`\`\`

Run the server:
\`\`\`bash
npm start
\`\`\`

## Author
Akash G — [GitHub](https://github.com/ImGakash)
