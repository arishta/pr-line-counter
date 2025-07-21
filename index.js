require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(express.raw({ type: 'application/json' }));

// Helper function to create JWT for GitHub App
function createJWT() {
    const payload = {
        iat: Math.floor(Date.now() / 1000) - 60,
        exp: Math.floor(Date.now() / 1000) + (10 * 60),
        iss: process.env.GITHUB_APP_ID
    };

    // Handle private key with proper line breaks
    const privateKey = process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');

    return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
}


function isCodeFile(filename) {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.bmp', '.webp'];
    return !imageExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

// Get installation access token
async function getInstallationToken(installationId) {
    const jwtToken = createJWT();
    const octokit = new Octokit({ auth: jwtToken });

    const { data } = await octokit.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
    });

    return data.token;
}

// Verify webhook signature
function verifySignature(payload, signature) {
    const expectedSignature = crypto
        .createHmac('sha256', process.env.WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(`sha256=${expectedSignature}`),
        Buffer.from(signature || '')
    );
}

// Main webhook handler
app.post('/webhook', async (req, res) => {
    const signature = req.headers['x-hub-signature-256'];

    // Verify webhook signature
    if (!verifySignature(req.body, signature)) {
        console.log('Invalid signature');
        return res.status(401).send('Unauthorized');
    }

    const payload = JSON.parse(req.body.toString());
    const { action, pull_request, installation } = payload;

    // Only handle opened and updated PRs
    if (!pull_request || (action !== 'opened' && action !== 'synchronize')) {
        return res.status(200).send('OK - Not handling this event');
    }

    try {
        console.log(`Processing PR #${pull_request.number}: ${action}`);
        await handlePullRequest(payload);
        res.status(200).send('Success');
    } catch (error) {
        console.error('Error processing PR:', error);
        res.status(500).send('Error processing PR');
    }
});

async function reviewFileWithAI(file, octokit, repository, prNumber) {
    try {
        console.log('Reviewing file:', file.filename);

        // get ai review for the changes
        const aiReview = await getAIReview(file.filename, file.patch);

        if (aiReview.comments && aiReview.comments.length > 0) {
            for (const comment of aiReview.comments) {
                await postInlineComment(octokit, repository, prNumber, file, comment);
            }
        }
    } catch (error) {
        console.error('Error reviewing file:', error);
    }
}

async function getAIReview(filename, patch) {
    const prompt = `Review this code change and provide specific feedback. Focus on:
- Potential bugs or issues
- Code quality improvements
- Security concerns
- Performance issues
- Best practices

File: ${filename}
Changes:
${patch}

Respond in JSON format:
{
  "comments": [
    {
      "line": <line_number>,
      "message": "<specific feedback>",
      "severity": "error|warning|suggestion"
    }
  ]
}

Only include comments for lines that actually need improvement. If no issues found, return {"comments": []}.`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_tokens: 1000
        });

        const content = response.choices[0].message.content;
        return JSON.parse(content);
    } catch (error) {
        console.error('AI review error:', error);
        return { comments: [] };
    }
}

async function postInlineComment(octokit, repository, prNumber, file, comment) {
    try {
        // First, let's get the commit SHA for the PR
        const { data: prData } = await octokit.rest.pulls.get({
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: prNumber,
        });

        await octokit.rest.pulls.createReviewComment({
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: prNumber,
            body: `🤖 **${comment.severity.toUpperCase()}**: ${comment.message}`,
            commit_id: prData.head.sha,  // Required: commit SHA
            path: file.filename,
            position: comment.line,      // Changed from 'line' to 'position'
        });

        console.log(`Posted inline comment on ${file.filename}:${comment.line}`);
    } catch (error) {
        console.error('Error posting inline comment:', error.message);
    }
}


async function handlePullRequest(payload) {
    const { pull_request, installation, repository } = payload;

    // Get installation access token
    const token = await getInstallationToken(installation.id);
    const octokit = new Octokit({ auth: token });

    // Get PR file changes
    const { data: files } = await octokit.rest.pulls.listFiles({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: pull_request.number,
    });

    // Process each file for AI review 

    for (const file of files) {
        if (file.status === 'removed' || !file.patch) continue;

        // Only review non image files
        if (isCodeFile(file.filename)) {
            await reviewFileWithAI(file, octokit, repository, pull_request.number);
        }
    }

    // Count lines
    const stats = countLines(files);

    // Create comment
    const comment = formatComment(stats);

    // Post comment
    await octokit.rest.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: pull_request.number,
        body: comment,
    });

    console.log(`Posted comment on PR #${pull_request.number}`);
}

function countLines(files) {
    let totalAdditions = 0;
    let totalDeletions = 0;
    let filesChanged = 0;

    files.forEach(file => {
        if (file.status !== 'removed') {
            totalAdditions += file.additions || 0;
            totalDeletions += file.deletions || 0;
            filesChanged++;
        }
    });

    return {
        additions: totalAdditions,
        deletions: totalDeletions,
        filesChanged,
        netChange: totalAdditions - totalDeletions
    };
}

function formatComment(stats) {
    const { additions, deletions, filesChanged, netChange } = stats;

    let emoji = '📊';
    if (netChange > 100) emoji = '🚀';
    else if (netChange < 0) emoji = '🔥';

    return `${emoji} **PR Line Count Summary**

📈 **Added:** ${additions} lines
📉 **Deleted:** ${deletions} lines
📁 **Files changed:** ${filesChanged}
📏 **Net change:** ${netChange > 0 ? '+' : ''}${netChange} lines

${netChange > 200 ? '⚠️ This is a large PR. Consider breaking it into smaller changes.' : '✅ Good PR size!'}`;
}

// Health check endpoint
app.get('/', (req, res) => {
    res.send('PR Line Counter is running! 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Waiting for GitHub webhooks...');
});
