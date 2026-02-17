const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const socketIo = require('socket.io');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

// Helper to normalize URL
function normalizeUrl(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = ''; // Remove fragments
        return parsed.toString();
    } catch (e) {
        return null;
    }
}

// Check if URL is same origin
function isSameOrigin(baseUrl, targetUrl) {
    try {
        const base = new URL(baseUrl);
        const target = new URL(targetUrl);
        return base.origin === target.origin;
    } catch (e) {
        return false;
    }
}

// Crawler logic
class Crawler {
    constructor(startUrl, socket, options = {}) {
        this.startUrl = normalizeUrl(startUrl);
        this.socket = socket;
        this.visited = new Set(); // Internal pages visited
        this.checkedLinks = new Set(); // All links checked (internal & external) to avoid duplicates
        this.queue = [{ url: this.startUrl, depth: 0 }]; // Queue now stores objects with depth
        this.brokenLinks = [];
        this.isRunning = false;
        this.maxPages = options.maxPages || 50;
        this.maxDepth = options.maxDepth || 3; // Default depth limit
        this.allowedDomains = options.allowedDomains || []; // Array of allowed domains
        this.crawledCount = 0;
        this.activeRequests = 0;
        this.maxConcurrency = 5;
        this.externalCheckQueue = [];
        this.isProcessingExternal = false;

        // Add startUrl's hostname to allowed domains if not present, to ensure we can at least crawl the start site
        try {
            const startHost = new URL(this.startUrl).hostname;
            if (!this.allowedDomains.includes(startHost)) {
                this.allowedDomains.push(startHost);
            }
        } catch (e) { }
    }

    async start() {
        if (!this.startUrl) {
            this.socket.emit('error', '開始URLが無効です');
            return;
        }

        this.isRunning = true;
        this.socket.emit('log', `クロールを開始します: ${this.startUrl} (深さ制限: ${this.maxDepth})`);

        while (this.queue.length > 0 && this.isRunning && this.crawledCount < this.maxPages) {
            const { url: currentUrl, depth } = this.queue.shift();

            if (this.visited.has(currentUrl)) continue;
            this.visited.add(currentUrl);
            this.crawledCount++;

            this.socket.emit('progress', {
                url: currentUrl,
                count: this.crawledCount,
                queueSize: this.queue.length,
                depth: depth
            });

            this.socket.emit('log', `クロール中 (深さ ${depth}): ${currentUrl}`);

            try {
                const response = await axios.get(currentUrl, {
                    timeout: 10000,
                    validateStatus: () => true,
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' }
                });

                if (response.status >= 400) {
                    this.reportBroken(currentUrl, response.status, 'seed');
                    continue;
                }

                const contentType = response.headers['content-type'] || '';
                if (!contentType.includes('text/html')) {
                    continue;
                }

                // If we reached max depth, don't parse links
                if (depth >= this.maxDepth) continue;

                const $ = cheerio.load(response.data);
                const links = $('a');

                links.each((i, link) => {
                    const href = $(link).attr('href');
                    if (!href) return;

                    let absoluteUrl;
                    try {
                        absoluteUrl = new URL(href, currentUrl).toString();
                        absoluteUrl = normalizeUrl(absoluteUrl);
                    } catch (e) {
                        return;
                    }

                    if (!absoluteUrl || !absoluteUrl.startsWith('http')) return;

                    // If already checked, skip
                    if (this.checkedLinks.has(absoluteUrl)) return;
                    this.checkedLinks.add(absoluteUrl);

                    // Check if domain is allowed
                    const urlHostname = new URL(absoluteUrl).hostname;
                    // Allowing subdomains or strict match depending on requirement. 
                    // Let's go for strict match or logic: "if any allowed domain is suffix of this hostname" 
                    // or simpler: exact match or strict subdomain if user provided domain.
                    // For now, simple includes check from the list.

                    const isAllowed = this.allowedDomains.some(domain => urlHostname === domain || urlHostname.endsWith('.' + domain));

                    if (isAllowed) {
                        // Internal/Allowed: Only add to queue if NOT visited and NOT already in queue (optimization)
                        const inQueue = this.queue.some(item => item.url === absoluteUrl);
                        if (!this.visited.has(absoluteUrl) && !inQueue) {
                            this.queue.push({ url: absoluteUrl, depth: depth + 1 });
                        }
                    } else {
                        // External: Add to check queue
                        this.externalCheckQueue.push({ url: absoluteUrl, source: currentUrl });
                        this.processExternalQueue();
                    }
                });

            } catch (error) {
                this.socket.emit('error', `${currentUrl} の取得エラー: ${error.message}`);
                this.reportBroken(currentUrl, 'Error', 'seed');
            }

            // Artificial delay to be polite
            await new Promise(r => setTimeout(r, 500));
        }

        // Wait for external checks to finish
        while (this.activeRequests > 0 || this.externalCheckQueue.length > 0) {
            if (!this.isRunning) break;
            await new Promise(r => setTimeout(r, 500));
            this.processExternalQueue(); // Ensure processing continues
        }

        this.socket.emit('finished', { brokenLinks: this.brokenLinks });
        this.socket.emit('log', 'クロールが完了しました。');
    }

    reportBroken(url, status, source) {
        const item = { url, status, source };
        this.brokenLinks.push(item);
        this.socket.emit('broken-link', item);
    }

    async processExternalQueue() {
        if (this.isProcessingExternal) return;
        this.isProcessingExternal = true;

        while (this.externalCheckQueue.length > 0 && this.activeRequests < this.maxConcurrency && this.isRunning) {
            const item = this.externalCheckQueue.shift();
            this.activeRequests++;

            this.checkExternalLink(item.url, item.source).finally(() => {
                this.activeRequests--;
                this.processExternalQueue();
            });
        }

        this.isProcessingExternal = false;
    }

    async checkExternalLink(url, sourceUrl) {
        try {
            // Try HEAD first
            let response = await axios.head(url, {
                timeout: 5000,
                validateStatus: () => true,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' }
            });

            if (response.status >= 400 && response.status !== 405) { // 405 Method Not Allowed checks usually mean HEAD not supported
                // Fallback to GET
                response = await axios.get(url, {
                    timeout: 5000,
                    validateStatus: () => true,
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)' }
                });
            }

            if (response.status >= 400) {
                this.reportBroken(url, response.status, sourceUrl);
            }
        } catch (error) {
            // Network errors etc.
            this.reportBroken(url, 'Error', sourceUrl);
        }
    }
}

io.on('connection', (socket) => {
    console.log('User connected');
    let crawler;

    socket.on('start-crawl', (data) => {
        let url, options = {};

        if (typeof data === 'string') {
            url = data;
        } else {
            url = data.url;
            options = data.options || {};
        }

        if (crawler) {
            crawler.isRunning = false;
        }
        // Basic url validation
        if (!url || !url.startsWith('http')) {
            socket.emit('error', '無効なURLです。http または https で始まる必要があります。');
            return;
        }

        crawler = new Crawler(url, socket, options);
        // Start async
        crawler.start().catch(err => {
            console.error(err);
            socket.emit('error', '内部クローラーエラー');
        });
    });

    socket.on('stop-crawl', () => {
        if (crawler) crawler.isRunning = false;
        socket.emit('log', 'ユーザーにより停止されました。');
    });

    socket.on('disconnect', () => {
        if (crawler) crawler.isRunning = false;
        console.log('User disconnected');
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
