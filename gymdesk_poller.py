#!/usr/bin/env python3
import csv, io, json, subprocess, time, logging, requests, sqlite3, shutil
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(Path.home() / "gymdesk_followup.log"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)

SHEET_ID = "17LiXLW3tYJI76BfxMKU71R9_mJF4g9hKB1b6ZbmMOXo"
POLL_INTERVAL_SECONDS = 5
STATE_FILE = Path.home() / ".gymdesk_leads_state.json"
CHAT_DB = Path.home() / "Library/Messages/chat.db"
CHAT_DB_COPY = Path.home() / ".gymdesk_chat_copy.db"
CALL_DB = Path.home() / "Library/Application Support/CallHistoryDB/CallHistoryDB.storedata"
CALL_DB_COPY = Path.home() / ".gymdesk_call_copy.db"
TZ = ZoneInfo("America/New_York")

FOLLOWUP_SCHEDULE = [
    (24 * 3600, "Hey {first_name} I know you've probably been busy, but wanted to get in touch! We can only book 2 trials per day, so it helps a ton to plan ahead. We're also raising our membership prices soon, and I'd love for you to have a chance to check us out before that happens. Were you thinking of coming in? :)"),
    (72 * 3600, "Not sure if you got a chance to see my last messages, but figured I'd reach out again just in case! Were you still thinking about coming in?"),
    (72 * 3600 + 7 * 86400, "How's it going {first_name}, just wanted to reach out one last time. If you're still interested in giving Carbon a try, I'd love to get you set up! If not, totally understand. Hope to see you around sometime!"),
]

AFTER_HOURS_MSG = "Hi {first_name}! This is Erich (Owner of Carbon SG) I just saw your info come through, didn't want to shoot you a call at this hour. Have you ever trained jiu jitsu before? \U0001f4aa"

def is_after_hours():
    now = datetime.now(TZ)
    return now.hour >= 23 or now.hour < 8

def fetch_sheet():
    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid=0"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return list(csv.DictReader(io.StringIO(resp.text)))

def send_imessage(phone, message):
    safe_msg = message.replace('\\', '\\\\').replace('"', '\\"')
    safe_phone = phone.replace('"', "").strip()

    # Try direct send first — Messages auto-routes to iMessage or SMS (works for Android)
    script = f'tell application "Messages" to send "{safe_msg}" to buddy "{safe_phone}"'
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=60)
    if result.returncode == 0:
        return

    log.warning("Direct send failed for %s (%s), trying SMS service...", phone, result.stderr.strip())

    # Fallback: force SMS service explicitly (required for some Android numbers)
    script = f"""
tell application "Messages"
    activate
    set b to buddy "{safe_phone}" of 1st service whose service type = SMS
    send "{safe_msg}" to b
end tell
"""
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=60)
    if result.returncode == 0:
        return

    raise RuntimeError(f"Could not send to {phone}: {result.stderr.strip()}")

def has_replied(phone):
    """Returns True if this number has ever sent an incoming message to Erich."""
    try:
        if not CHAT_DB.exists():
            return False
        shutil.copy2(CHAT_DB, CHAT_DB_COPY)
        conn = sqlite3.connect(CHAT_DB_COPY)
        cur = conn.cursor()
        digits = "".join(c for c in phone if c.isdigit())[-10:]
        cur.execute("""
            SELECT COUNT(*) FROM message m
            JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
            JOIN chat_handle_join chj ON cmj.chat_id = chj.chat_id
            JOIN handle h ON chj.handle_id = h.ROWID
            WHERE m.is_from_me = 0
            AND replace(replace(replace(replace(h.id, '+1', ''), '-', ''), '(', ''), ')', '') LIKE ?
        """, (f"%{digits}",))
        count = cur.fetchone()[0]
        conn.close()
        return count > 0
    except Exception as exc:
        log.warning("Could not check replies: %s", exc)
        return False

def had_long_call(phone):
    """Returns True if there is any answered call >= 1 min with this number (ever)."""
    try:
        if not CALL_DB.exists():
            log.warning("Call DB not found at %s — iCloud call history may not be syncing to this Mac", CALL_DB)
            return False
        shutil.copy2(CALL_DB, CALL_DB_COPY)
        conn = sqlite3.connect(CALL_DB_COPY)
        cur = conn.cursor()
        digits = "".join(c for c in phone if c.isdigit())[-10:]
        cur.execute("""
            SELECT COUNT(*) FROM ZCALLRECORD
            WHERE ZDURATION >= 60
            AND ZANSWERED = 1
            AND replace(replace(replace(replace(ZADDRESS, '+1', ''), '-', ''), '(', ''), ')', '') LIKE ?
        """, (f"%{digits}",))
        count = cur.fetchone()[0]
        conn.close()
        return count > 0
    except Exception as exc:
        log.warning("Could not check calls: %s", exc)
        return False

def get_phone(row):
    phone = row.get("Phone Number") or row.get("Phone") or row.get("phone") or row.get("Mobile") or ""
    digits = "".join(c for c in phone if c.isdigit() or c == "+")
    if not digits:
        return None
    if digits.startswith("+"):
        return digits
    if len(digits) == 10:
        return f"+1{digits}"
    return digits or None

def get_name(row):
    return (row.get("First Name") or row.get("first_name") or row.get("Name") or "there").split()[0]

def get_email(row):
    return row.get("EMAIL") or row.get("Email") or row.get("email") or ""

def row_key(row):
    return f"{get_name(row)}|{get_phone(row)}"

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}

def save_state(state):
    STATE_FILE.write_text(json.dumps(state))

def now_ts():
    return datetime.now(timezone.utc).timestamp()

def main():
    log.info("Gymdesk lead poller started (checks every %ds)", POLL_INTERVAL_SECONDS)
    state = load_state()

    if not state:
        log.info("First run - seeding existing leads without texting them...")
        try:
            leads = fetch_sheet()
            for row in leads:
                key = row_key(row)
                state[key] = {
                    "first_contact": now_ts(),
                    "followups_sent": len(FOLLOWUP_SCHEDULE),
                    "phone": get_phone(row),
                    "name": get_name(row),
                    "email": get_email(row),
                    "stopped": False,
                }
            save_state(state)
            log.info("Seeded %d existing leads.", len(state))
        except Exception as exc:
            log.error("Seed failed: %s", exc)

    while True:
        try:
            leads = fetch_sheet()
            for row in leads:
                key = row_key(row)
                phone = get_phone(row)
                name = get_name(row)
                last_name = row.get("Last Name", "").strip()
                email = get_email(row)
                sheet_stopped = str(row.get("STOP", "")).strip() != ""

                if not phone:
                    continue

                if key not in state:
                    full_name = f"{name} {last_name}".strip()
                    log.info("New lead: %s | Phone: %s | Email: %s", full_name, phone, email or "none")
                    if is_after_hours():
                        msg = AFTER_HOURS_MSG.format(first_name=name)
                        try:
                            send_imessage(phone, msg)
                            log.info("After-hours text sent to %s at %s", name, phone)
                        except Exception as exc:
                            log.error("Failed to send after-hours text to %s: %s", name, exc)
                    else:
                        log.info("Lead %s came in during business hours - no auto text sent.", name)
                    state[key] = {
                        "first_contact": now_ts(),
                        "followups_sent": 0,
                        "phone": phone,
                        "name": name,
                        "email": email,
                        "stopped": False,
                    }
                    save_state(state)
                    continue

                if not state[key].get("stopped") and not sheet_stopped:
                    if has_replied(phone) or had_long_call(phone):
                        log.info("%s replied or had long call - stopping follow-ups.", name)
                        state[key]["stopped"] = True
                        save_state(state)
                        continue

                state[key]["stopped"] = sheet_stopped or state[key].get("stopped", False)

                if state[key]["stopped"]:
                    continue

                followups_sent = state[key].get("followups_sent", 0)
                if followups_sent >= len(FOLLOWUP_SCHEDULE):
                    continue

                delay, msg_template = FOLLOWUP_SCHEDULE[followups_sent]
                elapsed = now_ts() - state[key]["first_contact"]

                if elapsed >= delay:
                    msg = msg_template.format(first_name=name)
                    try:
                        send_imessage(phone, msg)
                        log.info("Follow-up %d sent to %s", followups_sent + 1, name)
                    except Exception as exc:
                        log.error("Follow-up failed for %s: %s", name, exc)
                    state[key]["followups_sent"] += 1
                    save_state(state)

        except Exception as exc:
            log.error("Poll error: %s", exc)

        time.sleep(POLL_INTERVAL_SECONDS)

if __name__ == "__main__":
    main()
