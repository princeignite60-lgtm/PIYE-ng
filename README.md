# Prince Ignite Your English (PIYE) — Expanded frontend + backend starter

## What is included
- Existing PIYE frontend retained and expanded.
- Advanced English Skill Studio: academic writing checklist, argument builder, precision vocabulary, collocations, and professional email models.
- Full-site login gate: visitors see only Login/Create Account until the backend confirms a valid session; logging out locks the interface again.
- Visitors do not enter or configure an API URL. The website owner configures the backend URL once in `frontend/script.js`.
- Account screen wired to a separate Express API.
- Node.js/Express backend with PostgreSQL users/progress/saved-word tables, bcrypt password hashing, server-side PostgreSQL sessions, HttpOnly cookies, CSRF tokens, origin allow-list, security headers, and rate limiting.

## Important distinction
The backend source is prepared but is **not deployed or connected to a live database yet**. GitHub Pages hosts static frontend files only; it cannot run this Node server. You must deploy the `backend/` folder to a Node hosting provider and provision PostgreSQL.

## Local development
1. Install Node.js 20+.
2. Create a PostgreSQL database.
3. Copy `backend/.env.example` to `backend/.env`; fill in `DATABASE_URL`, a random `SESSION_SECRET` (32+ characters), and `FRONTEND_ORIGINS`.
4. In `backend/`, run `npm install`, then `npm start`.
5. In `frontend/script.js`, set `const PIYE_API_BASE = 'http://localhost:3000';` for local development, then serve the `frontend/` directory through a local web server. Visitors do not configure this setting.
6. Never deploy with example secrets or `NODE_ENV=development`. Use HTTPS in production and set `DATABASE_SSL=true` if required by your database provider.

## Deploy backend (Render + PostgreSQL)
1. Push this folder structure to a GitHub repository.
2. Create a managed PostgreSQL database with your chosen provider.
3. Create a Render Web Service from the repository, set Root Directory to `backend`, Build Command `npm install`, Start Command `npm start`.
4. Add environment variables: `NODE_ENV=production`, `DATABASE_URL`, `SESSION_SECRET` (random 32+ chars), `FRONTEND_ORIGINS` (the exact PIYE frontend origin, e.g. `https://YOUR-USERNAME.github.io`), and `DATABASE_SSL=true` if required. Do not commit `.env`.
5. Deploy and verify `https://YOUR-API-DOMAIN/api/health` returns `{"ok":true,...}`.
6. Copy the deployed backend HTTPS URL into `const PIYE_API_BASE = 'https://YOUR-API-DOMAIN';` near the top of the account-client section in `frontend/script.js`, commit and redeploy the frontend. Do this once as the website owner. Visitors then use the login screen without entering any API details.

## Security notes
- Passwords are never stored in plain text; bcrypt cost factor is 12.
- Session identifiers are in HttpOnly cookies; production cookies require HTTPS.
- Mutating requests require a session CSRF token and an allowed origin.
- Configure the exact frontend origin; do not use wildcard CORS with credentials.
- Production uses `SameSite=None; Secure` cookies to permit cross-origin frontend/API requests, but some browsers or privacy settings block third-party cookies. For dependable sign-in, preferably use a custom domain arrangement where frontend and API are same-site.
- Password recovery/email verification are not implemented yet. Add them with a trusted email provider before relying on account recovery.
- This is a starter, not a security audit. Test in staging before using real learner data.

## Current data behavior
The full PIYE interface remains hidden until the backend validates a signed-in session. When logged in, use **Sync my progress** to upload the local progress snapshot. This starter currently uploads the current local snapshot; it does not merge conflicts between multiple devices.


## Important limitation of static hosting
The login gate blocks normal visitors from using the website without credentials, but GitHub Pages still serves frontend source files publicly. If lesson content itself must be confidential, move the lesson data to protected backend endpoints and require a valid server session on every content request. Never put secrets in HTML/CSS/JavaScript.
