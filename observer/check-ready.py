import argparse
from datetime import datetime, timezone
import json
import re
import time
from urllib.request import urlopen


def fresh(report, seconds=5):
    if not report.get("available"):
        return False
    try:
        observed_at = re.sub(
            r"\.(\d+)(?=Z$|[+-]\d{2}:\d{2}$)",
            lambda match: "." + match.group(1)[:6].ljust(6, "0"),
            report["observed_at"],
        )
        stamp = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        return 0 <= (datetime.now(timezone.utc) - stamp).total_seconds() < seconds
    except (KeyError, ValueError, TypeError):
        return False


def missing_sources(document, require_room=False, require_survey=False):
    missing = []
    daemon = document.get("daemon", {})
    if "explorer_details" not in daemon.get("capabilities", []):
        missing.append("NG daemon telemetry extension")
    if not document.get("summary", {}).get("available") or document.get("error"):
        missing.append("live medium summary")
    if int(document.get("identity_inventory", {}).get("matched", 0)) <= 0:
        missing.append("radio identity inventory")
    service = document.get("service", {})
    if not fresh(service) or service.get("data", {}).get("airtime_profile") != "legacy20":
        missing.append("live RF model/service telemetry")
    if require_room:
        room = document.get("room", {})
        data = room.get("data", {})
        if (not fresh(room) or data.get("instance_id") != daemon.get("instance_id")
                or data.get("live") is not True or not data.get("roles") or data.get("fault")):
            missing.append("matching live room observer")
    if require_survey:
        survey = document.get("survey", {})
        data = survey.get("data", {})
        age = int(data.get("reader_monotonic_ns", 0)) - int(data.get("recorded_monotonic_ns", 0))
        if (not fresh(survey) or not data.get("recorded_monotonic_ns") or not 0 <= age <= 1_000_000_000
                or data.get("instance_id") != daemon.get("instance_id") or not data.get("written")):
            missing.append("matching live survey publication")
    return missing


def main():
    parser = argparse.ArgumentParser(description="Bounded, read-only Console NG readiness check; no traffic or RF writes")
    parser.add_argument("--url", default="http://127.0.0.1:8890")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--require-room", action="store_true")
    parser.add_argument("--require-survey", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 600:
        parser.error("--timeout must be 1..600 seconds")
    deadline = time.monotonic() + args.timeout
    previous = None
    while time.monotonic() < deadline:
        try:
            with urlopen(args.url.rstrip("/") + "/api/v2/overview", timeout=min(3, max(0.1, deadline - time.monotonic()))) as response:
                document = json.load(response)
            missing = missing_sources(document, args.require_room, args.require_survey)
            if not missing:
                print(json.dumps({"ready": True, "instance_id": document["daemon"]["instance_id"],
                                  "radios": document["identity_inventory"]["matched"],
                                  "room_required": args.require_room, "survey_required": args.require_survey}))
                return
            reason = ", ".join(missing)
        except (OSError, ValueError, KeyError, TypeError) as error:
            reason = str(error)
        if reason != previous:
            print("Waiting for Console NG: " + reason, flush=True)
            previous = reason
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise SystemExit("Console NG not ready: " + str(previous))


if __name__ == "__main__":
    main()
