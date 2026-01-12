const http = require('http');
const port = process.env.PORT || 3000;

console.log('🏁 Starting PURE NODE Server...');
console.log(`Port asked: ${port}`);

const server = http.createServer((req, res) => {
    console.log(`Request received: ${req.url}`);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('✅ PURE NODE SERVER WORKING. No dependencies used.\n');
});

server.listen(port, '0.0.0.0', () => {
    console.log(`✅ Server running at http://0.0.0.0:${port}/`);
});
