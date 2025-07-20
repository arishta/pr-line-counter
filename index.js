require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const jwt = require('jsonwebtoken');

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
