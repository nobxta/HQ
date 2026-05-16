import os
import asyncio
from telethon import TelegramClient
from telethon.errors import (
    SessionPasswordNeededError,
    UserDeactivatedBanError,
    PhoneNumberBannedError,
    FloodWaitError,
    ChannelsTooMuchError,
    InviteHashExpiredError,
    InviteHashInvalidError,
    UserAlreadyParticipantError,
    ChatWriteForbiddenError
)
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.messages import ImportChatInviteRequest

API_ID = 33592373          # <-- put your api_id
API_HASH = "7f06d56847fc6902a41696bc10ea5c8c"    # <-- put your api_hash

async def join_with_session(session_path, link):
    name = os.path.basename(session_path)

    try:
        async with TelegramClient(session_path, API_ID, API_HASH) as client:
            if not await client.is_user_authorized():
                return name, "Session Unauth ❌"

            try:
                if "joinchat" in link or "+" in link:
                    await client(ImportChatInviteRequest(link.split("/")[-1]))
                else:
                    await client(JoinChannelRequest(link))

                return name, "Joined ✅"

            except UserAlreadyParticipantError:
                return name, "Already Joined ⚠️"

            except ChannelsTooMuchError:
                return name, "Max Group Limit Reached 🚫"

            except ChatWriteForbiddenError:
                return name, "Join Req Sent ⏳ (Waiting for approval)"

            except InviteHashExpiredError:
                return name, "Group Not Available ❌"

            except InviteHashInvalidError:
                return name, "Invalid / Private Group ❌"

            except FloodWaitError as e:
                return name, f"FloodWait {e.seconds}s ⏱️"

    except (UserDeactivatedBanError, PhoneNumberBannedError):
        return name, "Frozen / Banned Account ❄️"

    except SessionPasswordNeededError:
        return name, "2FA Enabled (Skipped) 🔐"

    except Exception as e:
        return name, f"Failed ❌ ({str(e)})"


async def main():
    sessions_dir = input("Enter sessions folder path: ").strip()
    link = input("Enter group link or @username: ").strip()

    sessions = [
        os.path.join(sessions_dir, f.replace(".session", ""))
        for f in os.listdir(sessions_dir)
        if f.endswith(".session")
    ]

    print(f"\nTotal sessions found: {len(sessions)}\n")

    results = {
        "Joined": 0,
        "Already": 0,
        "Request": 0,
        "Frozen": 0,
        "Unauth": 0,
        "Max": 0,
        "Invalid": 0,
        "Flood": 0,
        "Other": 0
    }

    for session in sessions:
        name, status = await join_with_session(session, link)
        print(f"{name} → {status}")

        if "Joined" in status:
            results["Joined"] += 1
        elif "Already" in status:
            results["Already"] += 1
        elif "Req" in status:
            results["Request"] += 1
        elif "Frozen" in status:
            results["Frozen"] += 1
        elif "Unauth" in status:
            results["Unauth"] += 1
        elif "Max" in status:
            results["Max"] += 1
        elif "Flood" in status:
            results["Flood"] += 1
        elif "Invalid" in status or "Not Available" in status:
            results["Invalid"] += 1
        else:
            results["Other"] += 1

    print("\n===== SUMMARY =====")
    for k, v in results.items():
        print(f"{k}: {v}")


asyncio.run(main())
