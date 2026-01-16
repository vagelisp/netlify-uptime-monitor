# Netlify Uptime Monitor

A serverless URL monitoring service that checks the availability of multiple websites and sends email alerts when services go down. Built for Netlify Functions with zero maintenance overhead.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/vagelisp/netlify-uptime-monitor)

## Features

- ⚡ **Serverless**: Runs on Netlify Functions - no servers to maintain
- 🔄 **Concurrent Monitoring**: Check multiple URLs simultaneously with configurable concurrency
- 📧 **Email Alerts**: Automatic notifications via [Resend](https://resend.com) when URLs are down
- 🔄 **Smart Retries**: Exponential backoff retry logic for transient failures
- 🎯 **Flexible Status Matching**: Support for complex status code expectations
- 🔒 **Optional Authentication**: Bearer token protection for your monitoring endpoint
- 📊 **Detailed Reporting**: Comprehensive status reports with timing data

## Quick Start

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd netlify-uptime-monitor
npm install
```

### 2. Configure Your URLs

Edit the `MONITORS` array in `url-monitor.mjs`:

```javascript
const MONITORS = [
  {
    url: "https://your-website.com",
    method: "HEAD",
    expect: "2xx3xx",
  },
  {
    url: "https://api.your-website.com/health",
    method: "GET",
    expect: { anyOf: [200, 204] },
  },
  // Add more URLs to monitor...
];
```

### 3. Set Environment Variables

In your Netlify dashboard or `.env` file:

```bash
# Required for email alerts
RESEND_API_KEY=your_resend_api_key
ALERT_EMAIL_TO=alerts@yourcompany.com
ALERT_EMAIL_FROM=monitor@yourcompany.com

# Optional authentication
MONITOR_TOKEN=your_secret_token
```

### 4. Deploy to Netlify

```bash
# Deploy via Netlify CLI
netlify deploy --prod

# Or connect your Git repository to Netlify for automatic deployments
```

## Configuration

### Monitor Configuration

Each monitor in the `MONITORS` array supports these options:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `url` | `string` | *required* | The URL to monitor |
| `method` | `"HEAD" \| "GET"` | `"HEAD"` | HTTP method (HEAD is faster) |
| `timeoutMs` | `number` | `8000` | Request timeout in milliseconds |
| `retries` | `number` | `2` | Number of retry attempts |
| `expect` | `string \| object` | `"2xx3xx"` | Expected response criteria |

### Status Code Expectations

The `expect` property supports various formats:

#### Simple String
```javascript
expect: "2xx3xx"  // Accept any 2xx or 3xx status (default)
```

#### Specific Status Codes
```javascript
expect: { anyOf: [200, 201, 204] }  // Accept specific codes
```

#### Status Code Ranges
```javascript
expect: { between: [200, 299] }  // Accept range of codes
```

#### Multiple Ranges
```javascript
expect: { 
  oneOfRanges: [
    [200, 299],  // 2xx codes
    [301, 302]   // Specific 3xx codes
  ] 
}
```

#### Negation
```javascript
expect: { not: { anyOf: [503, 504] } }  // Accept anything except these
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes | Your Resend API key for sending emails |
| `ALERT_EMAIL_TO` | Yes | Email address to receive alerts |
| `ALERT_EMAIL_FROM` | Yes | Email address to send alerts from |
| `MONITOR_TOKEN` | No | Bearer token for API authentication |

## Usage

### Manual Check

Once deployed, trigger a check by calling your Netlify function:

```bash
# Without authentication
curl https://your-site.netlify.app/.netlify/functions/url-monitor

# With authentication
curl -H "Authorization: Bearer your_secret_token" \
     https://your-site.netlify.app/.netlify/functions/url-monitor
```

### Scheduled Monitoring

Set up a cron job or external service to call your monitor regularly:

```bash
# Check every 5 minutes via crontab
*/5 * * * * curl -s https://your-site.netlify.app/.netlify/functions/url-monitor > /dev/null

# Or use a service like:
# - GitHub Actions with scheduled workflows
# - Uptime Robot (to monitor your monitor!)
# - Cronitor
# - EasyCron
```

## Response Format

The monitor returns detailed JSON responses:

### Success Response
```json
{
  "ok": true,
  "emailSent": false,
  "emailId": null,
  "totals": {
    "checked": 3,
    "down": 0,
    "up": 3
  },
  "down": [],
  "results": [
    {
      "url": "https://example.com",
      "ok": true,
      "expect": "2xx3xx",
      "method": "HEAD",
      "attempts": 1,
      "lastStatus": 200,
      "lastError": null,
      "attemptDetails": [...]
    }
  ],
  "durationMs": 1234,
  "timestamp": "2026-01-16T10:30:00.000Z"
}
```

### Alert Response (URLs Down)
```json
{
  "ok": false,
  "emailSent": true,
  "emailId": "email-id-from-resend",
  "totals": {
    "checked": 3,
    "down": 1,
    "up": 2
  },
  "down": [
    {
      "url": "https://broken-site.com",
      "ok": false,
      "expect": "2xx3xx",
      "method": "HEAD",
      "attempts": 3,
      "lastStatus": 500,
      "lastError": null,
      "attemptDetails": [...]
    }
  ],
  "results": [...],
  "durationMs": 5678,
  "timestamp": "2026-01-16T10:30:00.000Z"
}
```

## Email Alerts

When URLs are detected as down, the monitor sends detailed email alerts containing:

- List of down URLs with attempt details
- Full status report for all monitored URLs
- Error details and status codes
- Number of retry attempts made

## Advanced Configuration

### Adjusting Concurrency

Modify the `CONCURRENCY` constant to control how many URLs are checked simultaneously:

```javascript
const CONCURRENCY = 5;  // Check 5 URLs at once (good for slower connections)
```

### Custom Timeouts and Retries

Set different values per monitor:

```javascript
const MONITORS = [
  {
    url: "https://slow-api.com",
    method: "GET",
    timeoutMs: 15000,  // 15 second timeout
    retries: 5,        // Try 5 times
    expect: "2xx3xx"
  }
];
```

### Fallback Behavior

The monitor automatically falls back from HEAD to GET requests if a server returns `405` (Method Not Allowed) or `501` (Not Implemented) for HEAD requests.

## Development

### Local Testing

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your values

# Test locally with Netlify CLI
netlify dev

# Or run directly with Node.js
node -e "
import('./url-monitor.mjs')
  .then(m => m.default(new Request('http://localhost')))
  .then(r => r.json())
  .then(console.log)
"
```

### Project Structure

```
netlify-uptime-monitor/
├── netlify/functions/
│   └── url-monitor.mjs    # Main monitoring function
├── package.json           # Dependencies
├── README.md             # This file
└── .env.example          # Environment variables template
```

## Deployment Options

### Netlify Functions (Recommended)

1. Connect your repository to Netlify
2. Set environment variables in Netlify dashboard
3. Deploy automatically on git push

### Other Serverless Platforms

The code can be adapted for other platforms:
- **Vercel**: Rename to `api/url-monitor.js`
- **Cloudflare Workers**: Adapt the Request/Response handling
- **AWS Lambda**: Add API Gateway wrapper

## Troubleshooting

### Common Issues

**Email alerts not working**
- Verify all email environment variables are set
- Check Resend API key permissions
- Ensure sender domain is verified in Resend

**Timeouts on slow connections**
- Increase `DEFAULT_TIMEOUT_MS`
- Reduce `CONCURRENCY` value
- Add custom `timeoutMs` to specific monitors

**HEAD requests failing**
- Some servers don't support HEAD - use `method: "GET"`
- The monitor auto-falls back to GET for 405/501 responses

**Authentication errors**
- Ensure `MONITOR_TOKEN` environment variable is set
- Use `Authorization: Bearer <token>` header format

## License

[GPLv3](LICENSE)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

## Support

- Create an issue for bugs or feature requests
- Check existing issues for solutions
- Consider sponsoring the project for priority support