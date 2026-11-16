"""A per-connection lease for cc-bridge's managed remote SSH listener."""
import base64
import json
import os
from pathlib import Path
import select
import signal
import sys
import time
import uuid

LEASE_SECONDS = 45
SSHD_NAMES = ("sshd", "sshd-session")


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def valid_payload(value):
    return (isinstance(value, dict) and valid_uuid(value.get("owner"))
            and valid_uuid(value.get("nonce")) and type(value.get("port")) is int
            and 0 < value["port"] <= 65535)


def valid_receipt(value):
    return (valid_payload(value) and value.get("version") == 1
            and valid_uuid(value.get("bootId"))
            and all(type(value.get(key)) is int and value[key] > 1
                    for key in ("pid", "guardPid"))
            and all(type(value.get(key)) is int and value[key] > 0
                    for key in ("startTicks", "guardStartTicks"))
            and type(value.get("uid")) is int and value["uid"] >= 0)


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def read_process(pid):
    proc = Path("/proc") / str(pid)
    text = proc.joinpath("stat").read_text()
    fields = text[text.rfind(")") + 2:].split()
    uid_line = next(line for line in proc.joinpath("status").read_text().splitlines()
                    if line.startswith("Uid:"))
    uids = [int(value) for value in uid_line.split()[1:]]
    if len(set(uids)) != 1:
        raise PermissionError("The process has a different privilege context")
    return {"pid": pid, "ppid": int(fields[1]), "uid": uids[0],
            "startTicks": int(fields[19]), "comm": proc.joinpath("comm").read_text().strip()}


def read_command_line(pid):
    raw = (Path("/proc") / str(pid) / "cmdline").read_bytes()
    return [item.decode("utf-8", errors="strict") for item in raw.split(b"\0") if item]


def find_session(guard_pid):
    pid = read_process(guard_pid)["ppid"]
    for _ in range(8):
        process = read_process(pid)
        if process["comm"] in SSHD_NAMES:
            if process["uid"] != os.getuid():
                raise PermissionError("The SSH session is not owned by this account")
            return process
        pid = process["ppid"]
        if pid <= 1:
            break
    raise ValueError("The owning SSH session could not be identified")


def matches_session(process, receipt):
    return (process["pid"] == receipt["pid"] and process["uid"] == receipt["uid"]
            and process["startTicks"] == receipt["startTicks"])


def matches_guard(receipt):
    try:
        process = read_process(receipt["guardPid"])
        if (process["uid"] != receipt["uid"]
                or process["startTicks"] != receipt["guardStartTicks"]):
            return False
        if not matches_session(find_session(receipt["guardPid"]), receipt):
            return False
        args = read_command_line(receipt["guardPid"])
        if len(args) < 2 or args[-2] != "serve":
            return False
        payload = json.loads(base64.b64decode(args[-1], validate=True))
        return (valid_payload(payload) and all(payload[key] == receipt[key]
                for key in ("owner", "nonce", "port")))
    except (OSError, ValueError, KeyError, UnicodeError):
        return False


def terminate_handle(fd):
    try:
        # A pidfd remains tied to this process instance even after its numeric PID is reused.
        signal.pidfd_send_signal(fd, signal.SIGTERM, None, 0)
    except ProcessLookupError:
        pass


def reclaim(receipt):
    if not valid_receipt(receipt) or receipt["uid"] != os.getuid():
        return "unverified"
    if receipt["bootId"] != boot_id():
        return "gone"
    try:
        fd = os.pidfd_open(receipt["pid"], 0)
    except ProcessLookupError:
        return "gone"
    try:
        try:
            process = read_process(receipt["pid"])
        except (FileNotFoundError, ProcessLookupError):
            return "gone"
        if not matches_session(process, receipt):
            return "gone"
        if process["comm"] not in SSHD_NAMES or not matches_guard(receipt):
            return "unverified"
        terminate_handle(fd)
        return "released"
    finally:
        os.close(fd)


class HeartbeatFrames:
    def __init__(self, nonce):
        self.expected = ("CCB_TUNNEL_PING " + nonce).encode("ascii")
        self.pending = bytearray()
        self.discarding = False
        self.invalid = False
        self.empty_lines = 0

    def feed(self, chunk):
        matched = False
        for byte in chunk.replace(b"\r", b"\n"):
            if byte == 10:
                valid = not self.discarding and self.pending == self.expected
                matched |= valid
                if valid:
                    self.empty_lines = 0
                elif self.pending or self.discarding:
                    self.invalid = True
                else:
                    self.empty_lines += 1
                    self.invalid |= self.empty_lines > 4
                self.pending.clear()
                self.discarding = False
            elif not self.discarding:
                self.pending.append(byte)
                if len(self.pending) > 256:
                    self.pending.clear()
                    self.discarding = True
                    self.invalid = True
        return matched


def watchdog(input_fd, nonce):
    frames = HeartbeatFrames(nonce)
    deadline = time.monotonic() + LEASE_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "expired"
        readable, _, _ = select.select([input_fd], [], [], remaining)
        if not readable:
            continue
        chunk = os.read(input_fd, 4096)
        if not chunk:
            return "eof"
        matched = frames.feed(chunk)
        if frames.invalid:
            return "invalid"
        if matched:
            deadline = time.monotonic() + LEASE_SECONDS


def frame(name, value):
    sys.stdout.write("\r\nCCB_TUNNEL_" + name + " "
                     + json.dumps(value, separators=(",", ":")) + "\r\n")
    sys.stdout.flush()


def serve(payload):
    if not valid_payload(payload):
        raise ValueError("Invalid tunnel identity")
    helper = read_process(os.getpid())
    session = find_session(helper["pid"])
    receipt = {**payload, "version": 1, "bootId": boot_id(), "uid": session["uid"],
               "pid": session["pid"], "startTicks": session["startTicks"],
               "guardPid": helper["pid"], "guardStartTicks": helper["startTicks"]}
    fd = os.pidfd_open(session["pid"], 0)
    try:
        if not matches_session(read_process(session["pid"]), receipt):
            raise ValueError("The SSH process identity changed")
        if os.isatty(sys.stdin.fileno()):
            import tty
            # Raw input prevents terminal echo or line editing from corrupting heartbeat frames.
            tty.setraw(sys.stdin.fileno())
        frame("GUARD_READY", receipt)
        try:
            watchdog(sys.stdin.fileno(), payload["nonce"])
        finally:
            # Leaving the command channel alone does not release an SSH remote listener.
            terminate_handle(fd)
    finally:
        os.close(fd)


def main():
    payload = json.loads(base64.b64decode(sys.argv[2], validate=True))
    nonce = payload.get("nonce", "")
    try:
        if (sys.platform != "linux" or not hasattr(os, "pidfd_open")
                or not hasattr(signal, "pidfd_send_signal")):
            frame("GUARD_ERROR", {"nonce": nonce, "code": "unsupported"})
            return 1
        if sys.argv[1] == "serve":
            serve(payload)
        elif sys.argv[1] == "reclaim" and valid_uuid(nonce):
            result = reclaim(payload["receipt"])
            frame("RECLAIM_RESULT", {"nonce": nonce, "result": result})
        else:
            raise ValueError("Unknown tunnel operation")
        return 0
    except (OSError, ValueError, KeyError) as error:
        code = "unsupported" if isinstance(error, OSError) and error.errno == 38 else "unverified"
        frame("GUARD_ERROR", {"nonce": nonce, "code": code})
        return 1


if __name__ == "__main__":
    sys.exit(main())
