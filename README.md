# 🌿 Scent World Canada — Complete Website Platform

Your fully self-owned website. No monthly subscriptions, no third-party dependencies.
Every line of code, every piece of data — **100% yours**.

---

## What's Included

- ✅ Luxury landing page with animations and responsive design
- ✅ Working contact/quote request form (saves to your database)
- ✅ Booking/consultation system with date & time picker
- ✅ Newsletter subscriber collection
- ✅ Product catalog (16 products pre-loaded)
- ✅ Full admin panel with login (manage everything)
- ✅ Email notifications when someone submits a form
- ✅ SQLite database (no separate database server needed)
- ✅ CSV export for subscribers

---

## Quick Start (Your Computer — For Testing)

### 1. Install Node.js
Go to https://nodejs.org and download the **LTS version** (the green button).
Install it — just click Next through everything.

### 2. Open Terminal
- **Mac**: Open "Terminal" from Applications
- **Windows**: Open "Command Prompt" or "PowerShell"

### 3. Navigate to the project folder
```bash
cd path/to/scentworld
```

### 4. Install dependencies
```bash
npm install
```

### 5. Set up the database and admin user
```bash
cp .env.example .env
npm run setup
```

### 6. Start the server
```bash
npm start
```

### 7. Open your browser
- Website: http://localhost:3000
- Admin Panel: http://localhost:3000/admin/login.html
- Default login: `admin@scentworld.ca` / `changeme123`

---

## Deploy to a Server (Go Live at scentworld.ca)

### Option A: Hetzner Cloud (Recommended — ~$5 USD/month)

1. **Create account** at https://www.hetzner.com/cloud
2. **Create a server**: Choose "Ubuntu 24.04", CX22 plan (~$5/month)
3. **Connect to your server**:
   ```bash
   ssh root@YOUR_SERVER_IP
   ```
4. **Install Node.js**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
5. **Upload your project** (from your computer):
   ```bash
   scp -r scentworld/ root@YOUR_SERVER_IP:/var/www/scentworld
   ```
6. **Set up on server**:
   ```bash
   cd /var/www/scentworld
   npm install
   cp .env.example .env
   nano .env   # Edit your settings
   npm run setup
   ```
7. **Install PM2** (keeps server running forever):
   ```bash
   npm install -g pm2
   pm2 start server.js --name scentworld
   pm2 startup
   pm2 save
   ```
8. **Install Nginx** (handles your domain):
   ```bash
   sudo apt install nginx
   ```
   Create config:
   ```bash
   sudo nano /etc/nginx/sites-available/scentworld
   ```
   Paste this:
   ```nginx
   server {
       listen 80;
       server_name scentworld.ca www.scentworld.ca;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```
   Enable it:
   ```bash
   sudo ln -s /etc/nginx/sites-available/scentworld /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```
9. **Free SSL certificate**:
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d scentworld.ca -d www.scentworld.ca
   ```
10. **Point your GoDaddy domain**:
    - Log into GoDaddy → DNS Management for scentworld.ca
    - Change the **A Record** to point to your server's IP address
    - Change or add **www** CNAME to point to scentworld.ca

### Option B: DigitalOcean ($6 USD/month)
Same steps as Hetzner, just create your server at https://www.digitalocean.com

---

## Admin Panel Guide

### Login
Go to `https://scentworld.ca/admin/login.html`

### Dashboard
See overview of all quote requests, bookings, subscribers, and products.

### Quote Requests
- View all inquiries from the contact form
- Mark as "reviewed" when you've responded
- Delete old requests

### Bookings
- View consultation requests with preferred dates/times
- Click "Confirm" to mark as confirmed
- You'll need to email/call the person to confirm

### Subscribers
- View all newsletter signups
- Export to CSV for email marketing
- Remove unsubscribers

### Products
- Add, edit, or remove products from your catalog
- Set prices, descriptions, coverage areas
- Mark products as featured or draft

### Settings
- Update your contact info, phone, address
- Change your admin password

---

## Email Notifications (Optional)

To receive email alerts when someone submits a form:

1. Go to https://myaccount.google.com/apppasswords
2. Create an App Password for "Mail"
3. Edit your `.env` file:
   ```
   SMTP_USER=your-gmail@gmail.com
   SMTP_PASS=your-16-char-app-password
   NOTIFY_EMAIL=info@scentworld.ca
   ```
4. Restart the server: `pm2 restart scentworld`

---

## File Structure

```
scentworld/
├── server.js          ← Main application (Express.js)
├── database.js        ← SQLite database setup
├── setup.js           ← Initial setup script
├── package.json       ← Dependencies
├── .env               ← Your configuration (private!)
├── data/
│   └── scentworld.db  ← Your database (auto-created)
├── public/
│   └── index.html     ← The luxury landing page
└── admin/
    ├── login.html      ← Admin login page
    └── index.html      ← Admin dashboard
```

---

## Costs Summary

| Item | Cost | Frequency |
|------|------|-----------|
| Domain (scentworld.ca) | ~$20 CAD | Yearly (already have it) |
| Server (Hetzner CX22) | ~$5 USD | Monthly (~$60/year) |
| SSL Certificate | Free | Auto-renews |
| **Total** | **~$80 CAD/year** | |

No subscriptions. No per-transaction fees. No third-party branding.
**You own everything.**

---

## Support

Built with ❤️ for Scent World Canada.
For questions about the code, bring this project back to Claude.
