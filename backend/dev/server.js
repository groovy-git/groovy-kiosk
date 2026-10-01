/**
 * Local dev API: runs the real backend (.gs files) on an in-memory sheet with demo data.
 *   node backend/dev/server.js      → http://localhost:8787
 * Logins (all): admin@demo.local / admin123, manager@demo.local, sameer@demo.local, ayesha@demo.local (demo1234)
 */
const http = require("http");
const { createEnv } = require("./mock-gas");

const PORT = process.env.PORT || 8787;
const env = createEnv();
const { ctx } = env;

ctx.setupSheets();
env.alerts.length = 0;
// predictable admin login for local testing
vm_run(`(function () {
    const u = rows_("Users")[0];
    u.email = "admin@demo.local"; u.name = "Owner"; u.salt = newSalt_(); u.pwd_hash = hashPwd_("admin123", u.salt);
    updateRows_("Users", [u]);
})()`);
ctx.seedDemo();
console.log(env.alerts.pop());

function vm_run(code) {
    require("vm").runInContext(code, ctx);
}

const LATENCY = Number(process.env.LATENCY || 250); // feel of a real Apps Script round-trip
// FAIL_ECHO=0.3 → 30% of replies are lost AFTER the action ran, like Google's intermittent 404 on …/macros/echo
const FAIL_ECHO = Number(process.env.FAIL_ECHO || 0);

http
    .createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") return res.end();
        if (req.method === "GET" && req.url.startsWith("/mail")) {
            // emails aren't really sent locally — preview the latest one here
            const m = env.mails[env.mails.length - 1];
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.end(
                m
                    ? `<p style="font-family:Arial;padding:8px;background:#eee;margin:0">To: ${m.to}${m.cc ? " · Cc: " + m.cc : ""} · Subject: ${m.subject} · (${env.mails.length} sent this session)</p>` + (m.htmlBody || `<pre>${m.body}</pre>`)
                    : "<p style='font-family:Arial'>No emails sent yet.</p>",
            );
        }
        if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            return res.end(ctx.doGet().content);
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            setTimeout(() => {
                const out = ctx.doPost({ postData: { contents: body } });
                try {
                    const j = JSON.parse(body);
                    const r = JSON.parse(out.content);
                    console.log(new Date().toISOString().slice(11, 19), j.action, r.success ? "ok" : "ERR " + r.message);
                } catch (e) {}
                if (FAIL_ECHO && Math.random() < FAIL_ECHO) {
                    res.statusCode = 404;
                    res.setHeader("Content-Type", "text/html");
                    return res.end("<html><body>Sorry, unable to open the file at this time.</body></html>");
                }
                res.setHeader("Content-Type", "application/json");
                res.end(out.content);
            }, LATENCY);
        });
    })
    .listen(PORT, () =>
        console.log(`Groovy Kiosk mock API on http://localhost:${PORT}\nLogin: admin@demo.local / admin123\nEmails are not sent locally — preview the latest at http://localhost:${PORT}/mail`),
    );
