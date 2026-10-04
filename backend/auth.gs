/**
 * Auth: salted SHA-256 passwords, server-side sessions (CacheService + Sessions sheet),
 * login throttling, OTP password reset, user management.
 */

function hashPwd_(pwd, salt) {
    let h = salt + "|" + pwd;
    for (let i = 0; i < 200; i++) {
        const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
        h = Utilities.base64Encode(bytes);
    }
    return h;
}

function newSalt_() {
    return uuid_().slice(0, 16);
}

/**
 * The role, by its current name.
 *
 * Roles have been renamed twice — "salesman" became "salesperson", "admin" became "owner" — and staff
 * rows written before each rename still hold the old word. Everything reads roles through here, so
 * every spelling works and only the current one is ever written; otherwise a row saying an old word
 * would match nothing and that person would be refused every action, which for an owner means being
 * locked out of the very screen that could put it right. The rows are rewritten by migrateRoleNames_().
 *
 * The old words are spelled in pieces on purpose: a search-and-replace across the codebase would
 * otherwise rewrite them here too and turn this function into a no-op that silently matches nothing.
 * That very mistake happened during the first rename, and only the tests caught it.
 */
const OLD_ROLE_NAMES_ = {};
OLD_ROLE_NAMES_["sales" + "man"] = "salesperson";
OLD_ROLE_NAMES_["ad" + "min"] = "owner";

function roleName_(r) {
    const s = str_(r);
    return OLD_ROLE_NAMES_[s] || s;
}

function publicUser_(u) {
    const role = roleName_(u.role);
    return {
        id: u.id, name: u.name, email: u.email, phone: u.phone, role: role, active: u.active,
        home_branch_id: role === "owner" ? 0 : homeBranch_(u),
        branch_ids: allowedBranchIds_(u), // active branches this person may work at
    };
}

// home branch + "works at" list from the staff form (the owner works everywhere)
function cleanUserBranches_(p, role) {
    if (role === "owner") return { branch_id: 0, branch_ids: "" };
    const existing = rows_("Branches").map((b) => b.id);
    let list = parseIdList_(Array.isArray(p.branch_ids) ? p.branch_ids.join(",") : p.branch_ids).filter((id) => existing.indexOf(id) >= 0);
    let home = Number(p.branch_id) || 0;
    if (!home) home = list[0] || (existing.length === 1 ? existing[0] : 0);
    if (existing.indexOf(home) < 0) fail_("Choose the home branch");
    if (list.length && list.indexOf(home) < 0) list.push(home);
    // every branch ticked = "all branches" (also covers branches added later)
    if (list.length === existing.length) list = [];
    return { branch_id: home, branch_ids: list.join(",") };
}

/**
 * Passwords.
 *
 * The app's address is public — it is inside the app every phone downloads — so what keeps a
 * stranger out is the password and nothing else. One that is short, on everybody's list of common
 * passwords, or made from the person's own name or phone is the first thing anyone tries.
 *
 * The rule is applied when a password is SET. One already in use keeps working, so nobody is shut
 * out by a rule that came later; logging in with it tells the app, which asks for a better one.
 */
const PASSWORD_MIN_ = 8;
const COMMON_PASSWORDS_ = [
    "password", "password1", "password12", "password123", "pass1234", "pass@123", "pass@1234", "passw0rd", "p@ssw0rd", "p@ssword",
    "admin123", "admin1234", "admin@123", "admin@1234", "administrator", "welcome1", "welcome123", "welcome@123",
    "qwerty12", "qwerty123", "qwertyui", "qwertyuiop", "asdfghjk", "asdf1234", "1q2w3e4r", "1qaz2wsx", "abcd1234", "abc12345", "abcdefgh", "a1b2c3d4",
    "iloveyou", "letmein1", "changeme", "default1", "test1234", "testtest", "india123", "india@123", "sairam123",
    "demo1234", "groovy123", "groovy1234", "groovy@123", "groovy@1234", "kiosk123", "kiosk1234", "kiosk@123",
];
const WEAK_PASSWORD_MSG_ =
    "Choose a password that is harder to guess: at least " + PASSWORD_MIN_ + " characters, not your name, email or phone, and not a common one like 12345678 or admin123.";

// "" for a password fit to set, otherwise why not. `who` = {name, email, phone} of its owner, where known.
function weakPassword_(pwd, who) {
    const s = String(pwd || "");
    if (s.length < PASSWORD_MIN_) return "Password must be at least " + PASSWORD_MIN_ + " characters";
    const low = s.toLowerCase();
    if (COMMON_PASSWORDS_.indexOf(low) >= 0) return WEAK_PASSWORD_MSG_;
    if (/^groovy@\d{1,6}$/.test(low)) return WEAK_PASSWORD_MSG_; // the shape Setup used to hand out: 9,000 possibilities
    if (/^\d+$/.test(s) || /^(.)\1+$/.test(s)) return WEAK_PASSWORD_MSG_; // a phone number, a date, or one key held down
    const w = who || {};
    const own = String(w.name || "").split(/\s+/)
        .concat([String(w.email || "").split("@")[0], String(w.email || ""), String(w.phone || "").replace(/\D/g, "")])
        .map((x) => x.toLowerCase())
        .filter((x) => x.length >= 4);
    if (own.some((x) => low.indexOf(x) >= 0)) return WEAK_PASSWORD_MSG_;
    return "";
}

function validatePassword_(pwd, who) {
    const why = weakPassword_(pwd, who);
    if (why) fail_(why);
}

// A password to hand to someone: twelve random characters in three groups, none of them a letter or
// digit that is easily read as another (no 0/o, 1/l/i). Typed once, then changed by its owner.
function newPassword_() {
    const abc = "abcdefghjkmnpqrstuvwxyz23456789";
    const hex = (uuid_() + uuid_()).replace(/-/g, "");
    let out = "";
    for (let i = 0; i < 12; i++) out += (i && i % 4 === 0 ? "-" : "") + abc[parseInt(hex.substr(i * 4, 4), 16) % abc.length];
    return out;
}

/* ---------- sessions ---------- */

function createSession_(user, device) {
    const token = uuid_() + uuid_();
    const now = new Date();
    const exp = new Date(now.getTime() + APP.SESSION_DAYS * 86400000);
    appendRows_("Sessions", [
        { token, user_id: user.id, created_at: fmtDateTime_(now), expires_at: fmtDateTime_(exp), device: str_(device).slice(0, 120) },
    ]);
    CacheService.getScriptCache().put("s_" + token, String(user.id), 21600);
    return token;
}

// returns ctx {user, token} or throws AUTH_EXPIRED
function authenticate_(token) {
    if (!token || typeof token !== "string" || token.length < 40) fail_("Please log in", "AUTH_EXPIRED");
    const cache = CacheService.getScriptCache();
    let uid = cache.get("s_" + token);
    if (!uid) {
        const s = findBy_("Sessions", "token", token);
        if (!s || s.expires_at < nowStr_()) fail_("Session expired, please log in again", "AUTH_EXPIRED");
        uid = String(s.user_id);
        cache.put("s_" + token, uid, 21600);
    }
    const user = findBy_("Users", "id", Number(uid));
    if (!user || !user.active) {
        cache.remove("s_" + token);
        fail_("Account inactive. Contact the owner.", "AUTH_EXPIRED");
    }
    // a copy, so a row still holding the old role name reads correctly everywhere without the
    // cached sheet row being altered behind the back of whatever else reads it this request
    return { user: Object.assign({}, user, { role: roleName_(user.role) }), token };
}

function endSession_(token) {
    CacheService.getScriptCache().remove("s_" + token);
    const s = findBy_("Sessions", "token", token);
    if (s) deleteRow_("Sessions", s);
}

// drop all sessions of a user (deactivate / password change)
function endUserSessions_(userId, exceptToken) {
    const cache = CacheService.getScriptCache();
    const rows = rows_("Sessions").filter((s) => s.user_id === userId && s.token !== exceptToken);
    rows.forEach((s) => cache.remove("s_" + s.token));
    emptyRows_("Sessions", rows.map((s) => s._r)); // emptied, not deleted — see deleteRow_
}

/* ---------- public actions ---------- */

/**
 * Wrong passwords are counted per email, in the script cache — never in the sheet, so a flood of
 * them cannot hold the lock that billing needs.
 *
 * Five in a row pause the login for ten minutes. That alone still allowed five more every ten
 * minutes, for ever: some 700 guesses a day. So there is a second count over six hours (the longest
 * the cache keeps anything): twenty wrong and the login stays shut for the rest of that window.
 * Someone already signed in is not affected, and a password reset by the owner opens it at once.
 */
const LOGIN_TRIES_ = 5;
const LOGIN_TRIES_LONG_ = 20;
const LOGIN_LONG_SECONDS_ = 21600;

function apiLogin_(p) {
    const email = str_(p.email).toLowerCase();
    const pwd = String(p.password || "");
    if (!email || !pwd) fail_("Email and password required");

    const cache = CacheService.getScriptCache();
    const fk = "lf_" + email;
    const lk = "lfd_" + email;
    const fails = num_(cache.get(fk), 0);
    const longFails = num_(cache.get(lk), 0);
    if (longFails >= LOGIN_TRIES_LONG_) fail_("Too many wrong passwords. Ask the owner to reset your password, or try again in a few hours.");
    if (fails >= LOGIN_TRIES_) fail_("Too many attempts. Try again in 10 minutes.");

    const u = findBy_("Users", "email", email);
    if (!u || hashPwd_(pwd, u.salt) !== u.pwd_hash) {
        cache.put(fk, String(fails + 1), 600);
        cache.put(lk, String(longFails + 1), LOGIN_LONG_SECONDS_);
        if (u && u.active && (fails + 1 === LOGIN_TRIES_ || longFails + 1 === LOGIN_TRIES_LONG_)) alertLockedLogin_(u, longFails + 1 >= LOGIN_TRIES_LONG_);
        fail_("Invalid email or password");
    }
    if (!u.active) fail_("Account inactive. Contact the owner.");
    clearLoginLock_(email);

    const token = withLock_(() => {
        const now = nowStr_();
        emptyRows_("Sessions", rows_("Sessions").filter((x) => x.user_id === u.id && x.expires_at < now).map((x) => x._r));
        const t = createSession_(u, p.device);
        log_({ user: u }, "LOGIN", "Users", u.id, "");
        return t;
    });
    const data = { token, user: publicUser_(u) };
    // the password just used would not be accepted as a new one: the app asks for a better one
    if (weakPassword_(pwd, u)) data.weak_password = true;
    return { data };
}

// a new password from the owner must work straight away, whatever was tried against the old one
function clearLoginLock_(email) {
    const e = str_(email).toLowerCase();
    if (e) CacheService.getScriptCache().removeAll(["lf_" + e, "lfd_" + e]);
}

/**
 * Tell the owner that a login has been shut by wrong passwords: it is either a member of staff who
 * needs a new password, or somebody trying their luck — and until now nobody ever heard about it.
 * One email per account in six hours, for real accounts only, and never allowed to get in the way:
 * the person at the login screen gets the same answer whether or not this could be sent.
 */
function alertLockedLogin_(u, long) {
    try {
        const cache = CacheService.getScriptCache();
        const k = "lfa_" + String(u.email).toLowerCase();
        if (cache.get(k)) return;
        cache.put(k, "1", LOGIN_LONG_SECONDS_);
        const to = reportRecipients_();
        if (!to.length) return;
        const biz = setting_("business_name") || "Groovy Fragrances";
        const pause = long ? "for the next few hours" : "for 10 minutes";
        const lines = [
            "The wrong password was entered " + (long ? LOGIN_TRIES_LONG_ : LOGIN_TRIES_) + " times for " + u.name + " (" + u.email + "), most recently at " + nowStr_().slice(0, 16) + ".",
            "Their login is paused " + pause + ". Nobody got in, and anyone already logged in is not affected.",
            "If it was " + u.name + ": nothing to do, or give them a new password in More → Staff, which opens the login again at once.",
            "If it was not: their password has not been guessed. Make sure it is a strong one.",
        ];
        sendMail_(
            to,
            {
                subject: biz + " Kiosk — wrong passwords for " + u.name,
                text: lines.join("\n\n") + "\n\n— " + biz,
                html:
                    '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;background:#FAF7F2">' +
                    '<div style="background:#fff;border-radius:12px;padding:28px;border-top:5px solid #F5BF03">' +
                    '<h2 style="margin:0 0 8px;color:#654321;font-family:Georgia,serif">' + escHtml_(biz) + "</h2>" +
                    lines.map((l) => '<p style="color:#403B37">' + escHtml_(l) + "</p>").join("") +
                    "</div></div>",
            },
            {},
        );
    } catch (e) {
        console.error("alertLockedLogin_", e);
    }
}

function apiLogout_(p, ctx) {
    withLock_(() => endSession_(ctx.token));
    return { message: "Logged out" };
}

/**
 * "Forgot password?" on the login screen is the owner's to switch on (Settings). It is the one way
 * into an account for someone who is not logged in and does not know the password, and it lets a
 * stranger who knows a staff email send that person code after code. Switched off — which is how
 * it starts — a forgotten password is the owner's to reset, from the staff list or the Sheet's menu.
 */
const FORGOT_OFF_MSG_ = "Password reset by email is switched off. Ask the owner to reset your password.";
function forgotPasswordOn_() {
    return setting_("forgot_password") === "yes";
}

// eight digits, from the same source as the session keys rather than Math.random
function resetCode_() {
    const n = parseInt(uuid_().replace(/-/g, "").slice(0, 12), 16) % 100000000;
    return ("00000000" + n).slice(-8);
}

function apiForgotPassword_(p) {
    if (!forgotPasswordOn_()) fail_(FORGOT_OFF_MSG_);
    const email = str_(p.email).toLowerCase();
    // same answer whether or not the account exists, so nobody can use this to find out which
    // addresses are real staff accounts and then go after them
    const okMsg = "If this email is registered, a reset code has been sent.";

    // Both limits are applied to every address, before we know whether it exists. Checking after
    // would leave unknown addresses unthrottled, and would make the very appearance of these errors
    // proof that an address is real.
    const cache = CacheService.getScriptCache();
    if (cache.get("otp_sent_" + email)) fail_("Please wait a minute before requesting another code.");
    // a burst of requests would drain the account's daily send quota and take the nightly
    // day-close emails down with it. Cache entries cap out at 6 hours, hence the window.
    const dayKey = "otp_day_" + email;
    const sentToday = num_(cache.get(dayKey), 0);
    if (sentToday >= 10) fail_("Too many reset requests. Please try later or ask the owner.");
    cache.put("otp_sent_" + email, "1", 60);
    cache.put(dayKey, String(sentToday + 1), 21600);

    const u = findBy_("Users", "email", email);
    if (!u || !u.active) return { message: okMsg };

    const otp = resetCode_();
    withLock_(() => {
        const row = findBy_("Users", "email", email);
        row.otp = hashPwd_(otp, row.salt);
        row.otp_exp = fmtDateTime_(new Date(Date.now() + 10 * 60000));
        updateRows_("Users", [row]);
    });
    cache.remove("otpf_" + email); // a new code starts with its own five tries

    const biz = setting_("business_name");
    MailApp.sendEmail({
        to: email,
        subject: biz + " Kiosk — Password reset code",
        body: "Hi " + u.name + ",\n\nYour password reset code is: " + otp + "\nIt expires in 10 minutes.\n\n— " + biz,
        htmlBody:
            '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;background:#FAF7F2">' +
            '<div style="background:#fff;border-radius:12px;padding:28px;border-top:5px solid #F5BF03">' +
            '<h2 style="margin:0 0 8px;color:#654321;font-family:Georgia,serif">' + escHtml_(biz) + "</h2>" +
            '<p style="color:#403B37">Hi ' + escHtml_(u.name) + ", use this code to reset your password:</p>" +
            '<div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;background:#FFF4CC;border-radius:8px;padding:16px;color:#1A1A1A">' +
            otp + "</div>" +
            '<p style="color:#888;font-size:13px">It expires in 10 minutes. Ignore this email if you did not request it.</p>' +
            "</div></div>",
    });
    return { message: okMsg };
}

function apiResetPassword_(p) {
    if (!forgotPasswordOn_()) fail_(FORGOT_OFF_MSG_);
    const email = str_(p.email).toLowerCase();
    const otp = str_(p.otp);
    validatePassword_(p.password);
    const cache = CacheService.getScriptCache();
    const fk = "otpf_" + email;
    if (num_(cache.get(fk), 0) >= 5) fail_("Too many attempts. Request a new code.");

    // null = the code was wrong (reported after the lock is released, so a code thrown away below is saved first)
    const done = withLock_(() => {
        const u = findBy_("Users", "email", email);
        if (!u || !u.otp || u.otp_exp < nowStr_() || hashPwd_(otp, u.salt) !== u.otp) {
            const tries = num_(cache.get(fk), 0) + 1;
            cache.put(fk, String(tries), 600);
            // five wrong tries and the code itself is thrown away: guessing on needs a new one,
            // and each new one is an email its owner sees
            if (u && u.otp && tries >= 5) {
                u.otp = "";
                u.otp_exp = "";
                updateRows_("Users", [u]);
            }
            return null;
        }
        validatePassword_(p.password, u); // now that we know whose it is: not their own name or phone
        u.salt = newSalt_();
        u.pwd_hash = hashPwd_(String(p.password), u.salt);
        u.otp = "";
        u.otp_exp = "";
        u.updated_at = nowStr_();
        updateRows_("Users", [u]);
        endUserSessions_(u.id);
        clearLoginLock_(email);
        log_({ user: u }, "RESET_PWD", "Users", u.id, "Password reset via email code");
        return { message: "Password changed. Please log in." };
    });
    if (!done) fail_("Invalid or expired code");
    return done;
}

/* ---------- own account ---------- */

function apiMe_(p, ctx) {
    return { data: publicUser_(ctx.user) };
}

function apiChangePassword_(p, ctx) {
    validatePassword_(p.new_password, ctx.user);
    return withLock_(() => {
        const u = findBy_("Users", "id", ctx.user.id);
        if (hashPwd_(String(p.current_password || ""), u.salt) !== u.pwd_hash) fail_("Current password is incorrect");
        u.salt = newSalt_();
        u.pwd_hash = hashPwd_(String(p.new_password), u.salt);
        u.updated_at = nowStr_();
        updateRows_("Users", [u]);
        endUserSessions_(u.id, ctx.token);
        log_(ctx, "CHANGE_PWD", "Users", u.id, "");
        return { message: "Password changed" };
    });
}

/* ---------- user management (owner) ---------- */

function apiListUsers_(p, ctx) {
    // just the salesperson column — the rest of the bill is not needed to answer "has any?"
    const sold = {};
    columnValues_("Sales", "salesman_id").forEach((v) => (sold[v] = true));
    return {
        data: rows_("Users").map((u) =>
            Object.assign(publicUser_(u), {
                has_sales: !!sold[u.id], created_at: u.created_at,
                branch_id: u.branch_id, works_at: parseIdList_(u.branch_ids), // raw form values ([] = all)
            }),
        ),
    };
}

// active users for the "Sold by" picker — any logged-in user. A stock mover never sells, so is left out.
function apiListSellers_(p, ctx) {
    return {
        data: rows_("Users")
            .filter((u) => u.active && roleName_(u.role) !== MOVER_ && (!ctx.branch_id || allowedBranchIds_(u).indexOf(ctx.branch_id) >= 0))
            .map((u) => ({ id: u.id, name: u.name, role: roleName_(u.role) })),
    };
}

function apiSaveUser_(p, ctx) {
    const name = str_(p.name);
    const email = str_(p.email).toLowerCase();
    const role = roleName_(p.role); // an app not yet updated still sends the old name
    if (!name) fail_("Name is required");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail_("Valid email is required");
    if (ROLES.indexOf(role) < 0) fail_("Invalid role");

    return withLock_(() => {
        const br = cleanUserBranches_(p, role);
        const dup = findBy_("Users", "email", email);
        const now = nowStr_();
        if (p.id) {
            const u = findBy_("Users", "id", Number(p.id));
            if (!u) fail_("User not found");
            if (dup && dup.id !== u.id) fail_("Email already in use");
            if (u.id === ctx.user.id && role !== "owner") fail_("You cannot remove your own Owner role");
            const wasRole = roleName_(u.role);
            u.name = name;
            u.email = email;
            u.phone = str_(p.phone);
            u.role = role;
            u.branch_id = br.branch_id;
            u.branch_ids = br.branch_ids;
            if (p.password) {
                validatePassword_(p.password, { name, email, phone: p.phone });
                u.salt = newSalt_();
                u.pwd_hash = hashPwd_(String(p.password), u.salt);
                endUserSessions_(u.id);
                clearLoginLock_(email); // the new password works at once, whatever was tried against the old one
            }
            u.updated_at = now;
            updateRows_("Users", [u]);
            // the catalogue carries cost price for managers and the owner only, so a role change means
            // this person's copy is now the wrong shape — bump so their app fetches it again
            if (u.role !== wasRole) bumpCatalogVersion_();
            log_(ctx, "UPDATE", "Users", u.id, name + " (" + role + ")");
            return { message: "User updated", data: publicUser_(u) };
        }
        if (dup) fail_("Email already in use");
        validatePassword_(p.password, { name, email, phone: p.phone });
        const salt = newSalt_();
        const u = {
            id: nextId_("Users"), name, email, phone: str_(p.phone), role,
            pwd_hash: hashPwd_(String(p.password), salt), salt, active: 1, otp: "", otp_exp: "",
            created_at: now, updated_at: now, branch_id: br.branch_id, branch_ids: br.branch_ids,
        };
        appendRows_("Users", [u]);
        log_(ctx, "CREATE", "Users", u.id, name + " (" + role + ")");
        return { message: "User added", data: publicUser_(u) };
    });
}

function apiToggleUser_(p, ctx) {
    return withLock_(() => {
        const u = findBy_("Users", "id", Number(p.id));
        if (!u) fail_("User not found");
        if (u.id === ctx.user.id) fail_("You cannot deactivate yourself");
        u.active = u.active ? 0 : 1;
        u.updated_at = nowStr_();
        updateRows_("Users", [u]);
        if (!u.active) endUserSessions_(u.id);
        log_(ctx, u.active ? "ACTIVATE" : "DEACTIVATE", "Users", u.id, u.name);
        return { message: u.active ? "User activated" : "User deactivated", data: publicUser_(u) };
    });
}

function apiDeleteUser_(p, ctx) {
    return withLock_(() => {
        const u = findBy_("Users", "id", Number(p.id));
        if (!u) fail_("User not found");
        if (u.id === ctx.user.id) fail_("You cannot delete yourself");
        if (columnValues_("Sales", "salesman_id").some((v) => v === u.id) || columnValues_("Sales", "created_by").some((v) => v === u.id))
            fail_("This user has sales. Deactivate instead so sales history stays intact.");
        endUserSessions_(u.id);
        deleteRow_("Users", findBy_("Users", "id", u.id));
        log_(ctx, "DELETE", "Users", u.id, u.name);
        return { message: "User deleted" };
    });
}

function escHtml_(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * One-time rewrite of the old role name in the Users sheet.
 *
 * Nothing depends on this having run — roleName_() means both spellings work — so it can happen
 * quietly whenever the sheet is next touched, and the flag means it only happens once. It is called
 * from Setup and from the quarter-hourly invoice job, so the owner has nothing to run.
 */
function migrateRoleNames_() {
    // No "already done" marker: staff is a handful of rows, so looking is as cheap as remembering,
    // and this way a row that turns up with the old name later — restored from a backup, or typed
    // into the sheet by hand — is put right too instead of being left behind forever.
    const stale = (u) => !!OLD_ROLE_NAMES_[str_(u.role)];
    if (!rows_("Users").some(stale)) return 0;
    return withLock_(() => {
        const rows = rows_("Users").filter(stale);
        rows.forEach((u) => (u.role = roleName_(u.role)));
        if (rows.length) writeColumn_("Users", rows, "role");
        return rows.length;
    });
}
