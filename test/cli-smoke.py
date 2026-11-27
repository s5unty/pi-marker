#!/usr/bin/env python3
"""Isolated real-CLI/PTY smoke test. Never opens user sessions or calls a model."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
work = Path(tempfile.mkdtemp(prefix="pi-marker-cli-"))
agent = work / "agent"
agent.mkdir()
(agent / "settings.json").write_text(json.dumps({"quietStartup": True, "theme": "dark", "fullscreenExitOutput": "resume-hint", "tidy": {"finalReplyStyle": os.environ.get("PI_MARKER_TEST_TIDY_STYLE", "frame")}}))
session = work / "fixture.jsonl"
probe = work / "probe.json"
usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
entries = [
    {"type": "session", "version": 3, "id": "marker-cli-fixture", "timestamp": "2026-01-01T00:00:00Z", "cwd": str(work)},
    {"type": "message", "id": "user-fixture", "parentId": None, "timestamp": "2026-01-01T00:00:00Z", "message": {"role": "user", "content": "Fixture", "timestamp": 1}},
    {"type": "message", "id": "assistant-fixture", "parentId": "user-fixture", "timestamp": "2026-01-01T00:00:01Z", "message": {"role": "assistant", "content": [{"type": "text", "text": os.environ.get("PI_MARKER_TEST_CONTENT", "Hello marker target world.")}], "api": "openai-completions", "provider": "fixture", "model": "fixture", "timestamp": 2, "stopReason": "stop", "usage": usage}},
]
if os.environ.get("PI_MARKER_TEST_THINKING"):
    entries[-1]["message"]["content"].insert(0, {"type": "thinking", "thinking": "Synthetic hidden reasoning."})
session.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
env = dict(os.environ)
env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0", "PI_MARKER_PROBE_FILE": str(probe), "PI_IMAGE_PROTOCOL": "none", "PI_TRUE_COLOR": "1", "TERM": "xterm-256color"})
# Linux headless/remote clipboard routes emit OSC 52 into this captured PTY only.
# Never exercise an actual desktop clipboard (including WSL/Termux) in a test.
verify_clipboard = sys.platform.startswith("linux")
if verify_clipboard:
    env.update({"DISPLAY": "", "WAYLAND_DISPLAY": "", "TERMUX_VERSION": "", "PI_CLIPBOARD_OSC52": "1", "WT_SESSION": "pi-marker-pty-test"})
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
extra_extensions = [argument for path in sys.argv[1:] for argument in ("-e", str(Path(path).resolve()))]
process = subprocess.Popen([os.environ.get("PI_MARKER_TEST_CLI", "pi"), *extra_extensions, "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve", "--tui-mode", "fullscreen", "-e", str(ROOT / "src/index.ts"), "-e", str(ROOT / "test/fixtures/cli-probe.ts"), "--session", str(session)], stdin=slave, stdout=slave, stderr=slave, cwd=work, env=env, start_new_session=True)
os.close(slave)
output = bytearray()
succeeded = False


def pump_until(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        if process.poll() is not None:
            raise AssertionError(f"Pi exited early: {process.returncode}")
        if select.select([master], [], [], 0.05)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            output.extend(data)
            # Respond to basic terminal queries so startup can finish promptly.
            if b"\x1b[c" in data:
                os.write(master, b"\x1b[?1;2c")
    raise AssertionError("Timed out waiting for CLI fixture")


def send(text):
    os.write(master, text.encode())


def marked():
    return any(entry.get("customType") == "pi-marker:v1" for entry in (json.loads(line) for line in session.read_text().splitlines()))


def snapshot():
    probe.unlink(missing_ok=True)
    send("/marker-probe\r")
    pump_until(probe.exists)
    return json.loads(probe.read_text())


try:
    pump_until(lambda: b"marker target" in output, 12)
    send("/marker on\r")
    pump_until(lambda: b"marker:mark" in output)
    metadata = snapshot()
    expected_version = os.environ.get("PI_MARKER_TEST_EXPECT_VERSION")
    if expected_version:
        assert metadata["version"] == expected_version, f"Wrong CLI host: expected {expected_version}, got {metadata['version']}"
    location = metadata["fixtureLocation"]
    assert location is not None, "Synthetic answer is not visible"
    row = location["row"] + 1
    start, end = location["start"] + 1, location["end"] + 1
    send(f"\x1b[<0;{start};{row}M\x1b[<32;{end};{row}M\x1b[<0;{end};{row}m")
    pump_until(lambda: marked() or "请选择已完成".encode() in output or "未识别到当前布局".encode() in output)
    assert marked(), "Mouse selection did not persist a mark in the real CLI"
    pump_until(lambda: b"\x1b[48;2;255;220;85m" in output)
    assert snapshot()["yellowText"] == "marker target", "Highlight must cover only the selected text"
    expected = os.environ.get("PI_MARKER_TEST_EXPECT_MARKDOWN", "marker target\n")
    export_path = work / "highlights.md"
    send(f'/marker export "{export_path}"\r')
    pump_until(export_path.exists)
    assert export_path.read_text() == expected, f"Unexpected Markdown export: {export_path.read_text()!r}"
    if verify_clipboard:
        encoded = base64.b64encode(expected.encode())
        assert len(encoded) <= 100_000, "Fixture must fit OSC52; never permit an oversized WSL native-clipboard fallback"
        offset = len(output)
        osc52 = b"\x1b]52;c;" + encoded + b"\x07"
        send("/marker copy\r")
        pump_until(lambda: osc52 in output[offset:])
    else:
        print("SKIP: real clipboard transport on non-Linux; only injected unit-test transport is safe")
    offset = len(output)
    send("/reload\r")
    pump_until(lambda: b"Reloaded" in output[offset:], 10)
    assert snapshot()["yellowText"] == "marker target", "Highlight must survive actual CLI /reload"
    restored_path = work / "restored-highlights.md"
    send(f'/marker export "{restored_path}"\r')
    pump_until(restored_path.exists)
    assert restored_path.read_text() == expected, "Reloaded marks must still export in off mode"
    # Re-select the middle of the saved stroke in mark mode. Probe before
    # release to distinguish a live preview from an on-release-only eraser.
    send("/marker on\r")
    metadata = snapshot()
    location = metadata["fixtureLocation"]
    row = location["row"] + 1
    start, end = location["start"] + 3, location["end"] - 3
    before_erase = session.read_text()
    send(f"\x1b[<0;{start};{row}M\x1b[<32;{end};{row}M")
    preview = snapshot()
    assert preview["yellowText"] == "marget", "Partial erasure must be visible before release"
    assert session.read_text() == before_erase, "Preview must not append session operations"
    send(f"\x1b[<0;{end};{row}m")
    pump_until(lambda: session.read_text() != before_erase)
    assert snapshot()["yellowText"] == "marget", "Release must keep the split highlight"
    operation = json.loads(session.read_text().splitlines()[-1])
    assert operation["data"]["kind"] == "replace", "One atomic replacement must persist the erasure"
    offset = len(output)
    send("/reload\r")
    pump_until(lambda: b"Reloaded" in output[offset:], 10)
    assert snapshot()["yellowText"] == "marget", "Split anchors must survive CLI reload"
    send("/marker undo\r")
    assert snapshot()["yellowText"] == "marker target", "One undo must restore the complete original stroke"
    assert "升级 pi-marker".encode() not in output, "A working host must not prompt users to upgrade pi-marker"
    print(f"PASS: Pi {metadata['version']} actual CLI mouse marks, exact Markdown file export" + (", isolated OSC52 clipboard" if verify_clipboard else "") + ", live partial erasure, /reload and undo")
    succeeded = True
finally:
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    os.close(master)
    if succeeded:
        shutil.rmtree(work)
    else:
        (work / "terminal.log").write_bytes(output)
        print(f"Failure artifacts: {work}")
        if probe.exists():
            print(probe.read_text())
