const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

console.log('🏁 Starting DEBUG Server...');
console.log(`Port asked: ${port}`);

app.get('/', (req, res) => {
    res.send('✅ DEBUG SERVER WORKING. Node is healthy. Issue is in application dependencies.');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Catch-all
app.use((req, res) => {
    res.send('DEBUG SERVER CATCH-ALL');
});

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Debug server listening on 0.0.0.0:${port}`);
});
