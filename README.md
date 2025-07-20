# 🤖 PR Line Counter – GitHub App

A simple GitHub App that automatically comments on every new pull request with a summary of:

- 📈 Lines added  
- 📉 Lines deleted  
- 📁 Files changed  
- 📏 Net code change

> Built using Node.js, Express, and GitHub’s REST API via Octokit.

---

## 🚀 Features

- Listens to pull request events via webhooks
- Fetches file diffs from the GitHub API
- Posts a contextual summary comment on each PR
- Highlights large pull requests with warnings

---

## 📦 Tech Stack

- Node.js
- Express
- @octokit/rest
- jsonwebtoken
- dotenv

---

## 🛠️ Setup Instructions

### 1. Clone the repo

```bash
git clone https://github.com/your-username/pr-line-counter.git
cd pr-line-counter
npm install
```

### 2. Add a .env file

GITHUB_APP_ID=your_app_id
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIEv...\\n-----END PRIVATE KEY-----"
WEBHOOK_SECRET=your_webhook_secret

### 3. Start the server

`node index.js`
Use a tunneling service like:
`npx localtunnel --port 3000 --subdomain pr-line-bot`

## Github app setup 

- Go to https://github.com/settings/apps
- create a github app 
- Set these 
	Homepage URL: http://localhost:3000
	Webhook URL: https://pr-line-bot.loca.lt/webhook

- Subscribe to:
    •	pull_request events
    •	Save and install the app on a test repository