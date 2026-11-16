"""Safety and timeout regressions for the managed SSH tunnel's remote guard."""
import base64
import importlib.util
import json
from pathlib import Path
import signal
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "src" / "stable_remote" / "tunnel_guard.py"
SPEC = importlib.util.spec_from_file_location("tunnel_guard", SOURCE)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)

OWNER = "723e72d0-bc01-42f3-8611-d29602702cee"
NONCE = "1c477db4-1a89-4be9-a4d5-cfa0d4ff88aa"
BOOT = "7a3a3dd7-31bd-4852-a371-544876b1828a"


def receipt():
    return {
        "version": 1, "owner": OWNER, "nonce": NONCE, "port": 7823,
        "bootId": BOOT, "uid": 1004, "pid": 400, "startTicks": 500,
        "guardPid": 401, "guardStartTicks": 501,
    }


def processes():
    return {
        400: {"pid": 400, "ppid": 200, "uid": 1004, "startTicks": 500, "comm": "sshd"},
        401: {"pid": 401, "ppid": 400, "uid": 1004, "startTicks": 501, "comm": "python3"},
    }


def command_line(nonce=NONCE):
    payload = {"owner": OWNER, "nonce": nonce, "port": 7823}
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    return ["python3", "-u", "-c", "loader", "serve", encoded]


class ReclaimTests(unittest.TestCase):
    def setUp(self):
        self.entries = processes()
        self.cmdline = command_line()
        self.patches = [
            patch.object(guard, "read_process", side_effect=self.read_process),
            patch.object(guard, "read_command_line", side_effect=lambda pid: self.cmdline),
            patch.object(guard, "boot_id", return_value=BOOT),
            patch.object(guard.os, "getuid", return_value=1004, create=True),
            patch.object(guard.os, "pidfd_open", return_value=44, create=True),
            patch.object(guard.os, "close"),
            patch.object(guard.signal, "pidfd_send_signal", create=True),
            patch.object(guard.os, "kill", side_effect=AssertionError("Numeric PID signalling is forbidden")),
        ]
        self.mocks = [item.start() for item in self.patches]
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    def read_process(self, pid):
        if pid not in self.entries:
            raise ProcessLookupError(pid)
        return self.entries[pid].copy()

    @property
    def sent(self):
        return self.mocks[6]

    def test_reclaims_the_recorded_session_using_a_stable_process_handle(self):
        self.assertEqual(guard.reclaim(receipt()), "released")
        self.mocks[4].assert_called_once_with(400, 0)
        self.sent.assert_called_once_with(44, signal.SIGTERM, None, 0)
        self.mocks[5].assert_called_once_with(44)

    def test_another_users_session_is_never_signalled(self):
        record = receipt()
        record["uid"] = 1005
        self.assertEqual(guard.reclaim(record), "unverified")
        self.sent.assert_not_called()

    def test_a_reused_pid_does_not_target_the_new_process(self):
        self.entries[400]["startTicks"] = 999
        self.assertEqual(guard.reclaim(receipt()), "gone")
        self.sent.assert_not_called()

    def test_a_server_reboot_invalidates_the_old_receipt(self):
        record = receipt()
        record["bootId"] = "e250ef1e-a59f-43b8-af1a-e1431d7185ca"
        self.assertEqual(guard.reclaim(record), "gone")
        self.mocks[4].assert_not_called()
        self.sent.assert_not_called()

    def test_an_ordinary_terminal_without_a_guard_is_not_reclaimed(self):
        del self.entries[401]
        self.assertEqual(guard.reclaim(receipt()), "unverified")
        self.sent.assert_not_called()

    def test_a_different_tunnel_nonce_is_not_reclaimed(self):
        self.cmdline = command_line("8360b97e-bda6-42d7-9e84-d4ff5a364eeb")
        self.assertEqual(guard.reclaim(receipt()), "unverified")
        self.sent.assert_not_called()

    def test_a_guard_attached_to_a_different_ssh_session_is_not_reclaimed(self):
        self.entries[401]["ppid"] = 402
        self.entries[402] = {"pid": 402, "ppid": 200, "uid": 1004, "startTicks": 502, "comm": "sshd"}
        self.assertEqual(guard.reclaim(receipt()), "unverified")
        self.sent.assert_not_called()

    def test_a_different_port_in_the_guard_command_is_not_reclaimed(self):
        record = receipt()
        record["port"] = 7824
        self.assertEqual(guard.reclaim(record), "unverified")
        self.sent.assert_not_called()

    def test_an_exited_session_is_safe_to_forget(self):
        self.mocks[4].side_effect = ProcessLookupError()
        self.assertEqual(guard.reclaim(receipt()), "gone")
        self.sent.assert_not_called()

    def test_a_non_ssh_process_is_not_reclaimed(self):
        self.entries[400]["comm"] = "node"
        self.assertEqual(guard.reclaim(receipt()), "unverified")
        self.sent.assert_not_called()


class HeartbeatTests(unittest.TestCase):
    def test_windows_enter_and_split_frames_are_supported(self):
        frames = guard.HeartbeatFrames(NONCE)
        command = ("CCB_TUNNEL_PING " + NONCE).encode()
        self.assertFalse(frames.feed(command[:18]))
        self.assertTrue(frames.feed(command[18:] + b"\r\n"))

    def test_unrelated_input_and_another_tunnels_heartbeat_do_not_extend_the_lease(self):
        frames = guard.HeartbeatFrames(NONCE)
        self.assertFalse(frames.feed(b"debug output\nCCB_TUNNEL_PING wrong\n"))

    def test_oversized_input_cannot_disguise_a_valid_heartbeat_tail(self):
        frames = guard.HeartbeatFrames(NONCE)
        self.assertFalse(frames.feed(b"x" * 4096))
        self.assertFalse(frames.feed(("CCB_TUNNEL_PING " + NONCE + "\n").encode()))
        self.assertTrue(frames.feed(("CCB_TUNNEL_PING " + NONCE + "\n").encode()))

    def run_watchdog(self, scheduled):
        clock = [0.0]
        pending = list(scheduled)
        chunks = []

        def wait(readers, writers, errors, timeout):
            if pending and pending[0][0] <= clock[0] + timeout:
                clock[0], chunk = pending.pop(0)
                chunks.append(chunk)
                return ([0], [], [])
            clock[0] += timeout
            return ([], [], [])

        with patch.object(guard.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(guard.select, "select", side_effect=wait), \
             patch.object(guard.os, "read", side_effect=lambda fd, size: chunks.pop(0)):
            result = guard.watchdog(0, NONCE)
        return result, clock[0]

    def test_missing_heartbeats_expire_at_the_server_lease_deadline(self):
        result, elapsed = self.run_watchdog([])
        self.assertEqual(result, "expired")
        self.assertEqual(elapsed, 45)

    def test_valid_heartbeats_keep_an_idle_tunnel_alive(self):
        ping = ("CCB_TUNNEL_PING " + NONCE + "\n").encode()
        result, elapsed = self.run_watchdog([(10, ping), (20, ping), (50, ping)])
        self.assertEqual(result, "expired")
        self.assertEqual(elapsed, 95)

    def test_invalid_heartbeats_do_not_postpone_cleanup(self):
        result, elapsed = self.run_watchdog([(20, b"CCB_TUNNEL_PING wrong\n")])
        self.assertEqual(result, "invalid")
        self.assertLessEqual(elapsed, 45)

    def test_a_malformed_producer_is_stopped_without_a_hot_read_loop(self):
        result, elapsed = self.run_watchdog([(1, b"\n" * 4096)])
        self.assertEqual(result, "invalid")
        self.assertEqual(elapsed, 1)

    def test_eof_requests_immediate_cleanup(self):
        result, elapsed = self.run_watchdog([(2, b"")])
        self.assertEqual(result, "eof")
        self.assertEqual(elapsed, 2)


if __name__ == "__main__":
    unittest.main()
