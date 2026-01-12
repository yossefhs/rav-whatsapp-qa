/**
 * MINIMAL SERVER - For Railway Debugging
 * No native modules, no database, just Express static serving
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('🏁 Starting MINIMAL Server...');
console.log(`Port: ${PORT}`);

// Health check (MUST be first)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA
app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send('<h1>RavQA - Minimal Mode</h1><p>Server is running. No index.html found.</p>');
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ MINIMAL Server running on http://0.0.0.0:${PORT}`);
});
