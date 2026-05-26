#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ARM64 ptrace breakpoint probe for WeChat DB key candidates.

This diagnostic helper is intentionally local-only. It writes candidate keys to
config/secrets and prints only counters/metadata.
"""

import argparse
import ctypes
import json
import os
import re
import signal
import struct
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import validate_wechat_db_key  # noqa: E402


PTRACE_ATTACH = 16
PTRACE_CONT = 7
PTRACE_DETACH = 17
PTRACE_GETEVENTMSG = 0x4201
PTRACE_GETREGSET = 0x4204
PTRACE_SETOPTIONS = 0x4200
PTRACE_SETREGSET = 0x4205
PTRACE_SINGLESTEP = 9
PTRACE_O_TRACECLONE = 0x00000008
PTRACE_EVENT_CLONE = 3
NT_PRSTATUS = 1
WAIT_WALL = 0x40000000
BRK_INSN = struct.pack("<I", 0xD4200000)
HEX64_RE = re.compile(rb"(?<![0-9A-Fa-f])([0-9A-Fa-f]{64})(?![0-9A-Fa-f])")
MIN_KEY_MATERIAL_BYTES = 32
MAX_KEY_MATERIAL_BYTES = 512

# Offsets for /opt/wechat/wechat 4.1.4 aarch64, derived from the WCDB Cipher
# string and nearby config call sites. These are offsets from ELF base mapping.
DEFAULT_TARGET_OFFSETS = [
    # Downstream SQLCipher/WCDB key copy path. The Linux ARM64 build reaches
    # this from the DB open path with x1=key bytes and x2=key length.
    0x665E4E0,
    # Instruction-level fallbacks around the same copy path, kept narrow so a
    # login-time capture can catch the key arguments even if function entry is
    # skipped by tail calls or inlining-adjacent branches.
    0x665E568,
    0x665EED4,
    0x6642024,
    # Static callers of the key API found by following sqlite3_key_v2-like
    # calls. These are closer to WeFlow's Linux x64 strategy: wait for key
    # arguments, then only verify candidates without printing them.
    0x6679E3C,
    0x668C9F8,
    0x668CD50,
    0x668CD70,
    0x668CD8C,
    0x6642390,
    # SQLCipher/WCDB internal key setter path. At this layer x2/w3 commonly
    # carry raw key bytes and length.
    0x6641F98,
    0x66421F0,
    0x665EBA8,
    # WeFlow-like semantic scan result for /opt/wechat/wechat 4.1.4 aarch64.
    # The target function receives key bytes as x1 and key length as x2.
    0x6498834,
    # Nearby fallback call sites. In strict mode these only record when x2 == 32.
    0x64BBEA8,
    0x64BC260,
]


class IOVec(ctypes.Structure):
    _fields_ = [("iov_base", ctypes.c_void_p), ("iov_len", ctypes.c_size_t)]


class Tracer:
    def __init__(self) -> None:
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
        self.libc.ptrace.restype = ctypes.c_long

    def ptrace(self, request: int, tid: int, address: int = 0, data: int = 0) -> int:
        result = self.libc.ptrace(
            request,
            tid,
            ctypes.c_void_p(address),
            ctypes.c_void_p(data),
        )
        if result == -1:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return int(result)

    def get_event_msg(self, tid: int) -> int:
        value = ctypes.c_ulonglong()
        self.ptrace(PTRACE_GETEVENTMSG, tid, 0, ctypes.addressof(value))
        return int(value.value)

    def get_regs(self, tid: int) -> List[int]:
        regs = (ctypes.c_ulonglong * 34)()
        iov = IOVec(ctypes.cast(regs, ctypes.c_void_p), ctypes.sizeof(regs))
        self.ptrace(PTRACE_GETREGSET, tid, NT_PRSTATUS, ctypes.addressof(iov))
        return list(regs)

    def set_regs(self, tid: int, regs: Sequence[int]) -> None:
        regs_array = (ctypes.c_ulonglong * 34)(*regs)
        iov = IOVec(ctypes.cast(regs_array, ctypes.c_void_p), ctypes.sizeof(regs_array))
        self.ptrace(PTRACE_SETREGSET, tid, NT_PRSTATUS, ctypes.addressof(iov))


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def emit(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True), flush=True)


def process_tids(pid: int) -> List[int]:
    task_dir = Path("/proc") / str(pid) / "task"
    return sorted(int(path.name) for path in task_dir.iterdir() if path.name.isdigit())


def find_wechat_pid() -> Optional[int]:
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            comm = (proc / "comm").read_text(encoding="utf-8", errors="ignore").strip()
        except OSError:
            continue
        if comm in ("wechat", "wechat-bin", "xwechat"):
            return int(proc.name)
    return None


def load_maps(pid: int) -> Tuple[Optional[int], List[Tuple[int, int, str, str]]]:
    base = None
    regions: List[Tuple[int, int, str, str]] = []
    for line in (Path("/proc") / str(pid) / "maps").read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.split(None, 5)
        if len(parts) < 5:
            continue
        start_text, end_text = parts[0].split("-", 1)
        start = int(start_text, 16)
        end = int(end_text, 16)
        perms = parts[1]
        offset = int(parts[2], 16)
        path = parts[5].strip() if len(parts) > 5 else ""
        regions.append((start, end, perms, path))
        if path == "/opt/wechat/wechat" and offset == 0:
            base = start
    return base, regions


def readable_region(regions: Sequence[Tuple[int, int, str, str]], address: int, size: int = 1) -> bool:
    end = address + size
    for start, stop, perms, _path in regions:
        if start <= address and end <= stop and "r" in perms:
            return True
    return False


def looks_like_key(raw: bytes) -> bool:
    if len(raw) != 32 or raw == b"\x00" * 32:
        return False
    if len(set(raw)) < 12:
        return False
    printable = sum(1 for byte in raw if 32 <= byte <= 126)
    return printable < 30


def looks_like_key_material(raw: bytes) -> bool:
    if len(raw) == 32:
        return looks_like_key(raw)
    if len(raw) < MIN_KEY_MATERIAL_BYTES or len(raw) > MAX_KEY_MATERIAL_BYTES:
        return False
    if raw == b"\x00" * len(raw):
        return False
    if len(set(raw)) < 12:
        return False
    printable = sum(1 for byte in raw if 32 <= byte <= 126)
    return printable < len(raw) - 2


def extract_hex_key(raw: bytes) -> Optional[str]:
    match = HEX64_RE.search(raw)
    if not match:
        return None
    return match.group(1).decode("ascii").lower()


def append_candidate(path: Path, pid: int, source: str, target: int, key_hex: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(str(path.parent), 0o700)
    row = {
        "captured_at": int(time.time()),
        "key_hex": key_hex,
        "pid": pid,
        "source": source,
        "target": hex(target),
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    os.chmod(str(path), 0o600)


def extract_candidate_keys(
    mem_fd: int,
    regions: Sequence[Tuple[int, int, str, str]],
    regs: Sequence[int],
    broad_scan: bool = False,
    struct_scan: bool = False,
) -> List[Tuple[str, str]]:
    found: Set[Tuple[str, str]] = set()
    struct_reg_indexes = list(range(8))
    if struct_scan:
        struct_reg_indexes = list(range(8)) + [19, 20, 21, 22, 23, 24, 29, 30, 31]
    if broad_scan:
        struct_reg_indexes = list(range(31)) + [31]
    for struct_index in struct_reg_indexes:
        struct_address = regs[struct_index]
        if not struct_address or not readable_region(regions, struct_address, 24):
            continue
        try:
            raw_struct = os.pread(mem_fd, 32, struct_address)
        except OSError:
            continue
        if len(raw_struct) < 24:
            continue
        layouts = [
            (
                "arm64_weflow_struct_x%d_len0_ptr8" % struct_index,
                struct.unpack_from("<Q", raw_struct, 8)[0],
                struct.unpack_from("<Q", raw_struct, 0)[0],
                struct.unpack_from("<I", raw_struct, 0)[0],
            ),
            (
                "arm64_struct_x%d_off8_len32" % struct_index,
                struct.unpack_from("<Q", raw_struct, 8)[0],
                struct.unpack_from("<Q", raw_struct, 16)[0],
                struct.unpack_from("<I", raw_struct, 16)[0],
            ),
        ]
        for source, key_address, key_length_64, key_length_32 in layouts:
            if key_length_64 == 32:
                key_length = key_length_64
            elif key_length_32 == 32:
                key_length = key_length_32
            else:
                continue
            if not key_address or not readable_region(regions, key_address, int(key_length)):
                continue
            try:
                raw_key = os.pread(mem_fd, int(key_length), key_address)
            except OSError:
                continue
            if looks_like_key(raw_key):
                found.add((source, raw_key.hex()))
    for pointer_index, key_address in enumerate(regs[:8]):
        if not key_address:
            continue
        for length_index, key_length in enumerate(regs[:8]):
            if (
                key_length < MIN_KEY_MATERIAL_BYTES
                or key_length > MAX_KEY_MATERIAL_BYTES
                or not readable_region(regions, key_address, int(key_length))
            ):
                continue
            try:
                raw = os.pread(mem_fd, int(key_length), key_address)
            except OSError:
                raw = b""
            if looks_like_key_material(raw):
                if pointer_index == 1 and length_index == 2 and key_length == 32:
                    source = "arm64_arg_x1_len32"
                elif pointer_index == 2 and length_index == 3:
                    source = "arm64_arg_x2_len_x3_%d" % key_length
                else:
                    source = "arm64_arg_x%d_len_x%d_%d" % (pointer_index, length_index, key_length)
                found.add((source, raw.hex()))
    for index, value in enumerate(regs[:8]):
        if not value or not readable_region(regions, value, 64):
            continue
        try:
            raw = os.pread(mem_fd, 96, value)
        except OSError:
            continue
        key = extract_hex_key(raw)
        if key:
            found.add(("arm64_arg_x%d_hex64" % index, key))

    if not broad_scan and not struct_scan:
        return sorted(found)

    values = list(regs[:31]) + [regs[31]]
    if struct_scan and not broad_scan:
        values = [regs[index] for index in list(range(8)) + [19, 20, 21, 22, 23, 24, 29, 30, 31]]
    offsets = (-64, -32, -16, 0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256)
    if struct_scan and not broad_scan:
        offsets = (0,)
    marker = struct.pack("<Q", 32)
    for index, value in enumerate(values):
        if not value or not readable_region(regions, value, 1):
            continue
        for offset in offsets:
            address = value + offset
            if not readable_region(regions, address, 32):
                continue
            try:
                raw = os.pread(mem_fd, 32, address)
            except OSError:
                continue
            if looks_like_key(raw):
                found.add(("arm64_hook_reg%d_plus%d" % (index, offset), raw.hex()))
            try:
                text = os.pread(mem_fd, 96, address)
            except OSError:
                continue
            key = extract_hex_key(text)
            if key:
                found.add(("arm64_hook_reg%d_plus%d_hex64" % (index, offset), key))
        try:
            block = os.pread(mem_fd, 4096, value)
        except OSError:
            continue
        key = extract_hex_key(block)
        if key:
            found.add(("arm64_hook_reg%d_block_hex64" % index, key))
        position = 8
        while True:
            position = block.find(marker, position)
            if position < 0:
                break
            pointer_offset = position - 8
            position += 1
            if pointer_offset < 0 or pointer_offset % 8 != 0:
                continue
            key_address = struct.unpack_from("<Q", block, pointer_offset)[0]
            if not readable_region(regions, key_address, 32):
                continue
            try:
                raw = os.pread(mem_fd, 32, key_address)
            except OSError:
                continue
            if looks_like_key(raw):
                found.add(("arm64_hook_struct_reg%d" % index, raw.hex()))
    return sorted(found)


def describe_hit(
    mem_fd: int,
    regions: Sequence[Tuple[int, int, str, str]],
    regs: Sequence[int],
) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "regs": {"x%d" % index: hex(regs[index]) for index in range(8)},
        "small_regs": {},
        "arg_len_pairs": [],
        "struct_len_pairs": [],
    }
    for index in range(8):
        value = regs[index]
        if 0 <= value <= 4096:
            summary["small_regs"]["x%d" % index] = value
    interesting_lengths = {16, 24, 32, 48, 64}
    for pointer_index in range(8):
        pointer = regs[pointer_index]
        for length_index in range(8):
            length = regs[length_index]
            if length in interesting_lengths and pointer and readable_region(regions, pointer, int(length)):
                summary["arg_len_pairs"].append(
                    {
                        "len_reg": "x%d" % length_index,
                        "length": int(length),
                        "ptr_reg": "x%d" % pointer_index,
                    }
                )
    scan_regs = list(range(8)) + [19, 20, 21, 22, 23, 24, 29, 30, 31]
    for reg_index in scan_regs:
        base = regs[reg_index]
        if not base or not readable_region(regions, base, 64):
            continue
        try:
            block = os.pread(mem_fd, 256, base)
        except OSError:
            continue
        if len(block) >= 16:
            weflow_length_64 = struct.unpack_from("<Q", block, 0)[0]
            weflow_length_32 = struct.unpack_from("<I", block, 0)[0]
            weflow_pointer = struct.unpack_from("<Q", block, 8)[0]
            if (
                (weflow_length_64 in interesting_lengths or weflow_length_32 in interesting_lengths)
                and weflow_pointer
                and readable_region(regions, weflow_pointer, int(weflow_length_32 or weflow_length_64))
            ):
                summary["struct_len_pairs"].append(
                    {
                        "base_reg": "x%d" % reg_index,
                        "layout": "len0_ptr8",
                        "length": int(weflow_length_32 if weflow_length_32 in interesting_lengths else weflow_length_64),
                        "offset": 0,
                    }
                )
        for offset in range(0, min(len(block) - 16, 240), 8):
            pointer = struct.unpack_from("<Q", block, offset)[0]
            length = struct.unpack_from("<Q", block, offset + 8)[0]
            if length in interesting_lengths and pointer and readable_region(regions, pointer, int(length)):
                summary["struct_len_pairs"].append(
                    {
                        "base_reg": "x%d" % reg_index,
                        "offset": offset,
                        "length": int(length),
                    }
                )
    summary["arg_len_pairs"] = summary["arg_len_pairs"][:20]
    summary["struct_len_pairs"] = summary["struct_len_pairs"][:30]
    return summary


def collect_candidates(
    pid: int,
    mem_fd: int,
    regions: Sequence[Tuple[int, int, str, str]],
    regs: Sequence[int],
    target: int,
    candidates_path: Path,
    broad_scan: bool = False,
    struct_scan: bool = False,
) -> int:
    found = extract_candidate_keys(mem_fd, regions, regs, broad_scan=broad_scan, struct_scan=struct_scan)
    for source, key_hex in found:
        append_candidate(candidates_path, pid, source, target, key_hex)
    return len(found)


def validate_candidates_on_hit(
    account_dirs: Sequence[Path],
    candidate_keys: Sequence[Tuple[str, str]],
    secrets_path: Path,
    db_labels: Optional[Set[str]] = None,
    page_sizes: Sequence[int] = (1024, 4096),
) -> Dict[str, Any]:
    verified: List[Dict[str, Any]] = []
    for account_dir in account_dirs:
        validation_dbs = [
            (label, db_path)
            for label, db_path in validate_wechat_db_key.resolve_validation_dbs(account_dir)
            if not db_labels or label in db_labels
        ]
        for source, key_hex in candidate_keys:
            normalized = validate_wechat_db_key.normalize_hex_material(key_hex)
            if not normalized:
                continue
            key_material = bytes.fromhex(normalized)
            for db_label, db_path in validation_dbs:
                verification = validate_wechat_db_key.verify_db_key_material(
                    key_material,
                    db_path,
                    page_sizes=page_sizes,
                )
                if verification:
                    mode = str(verification.get("mode") or validate_wechat_db_key.mode_for_material_hex(normalized))
                    validate_wechat_db_key.write_verified_key(secrets_path, account_dir.name, normalized, mode=mode)
                    verified.append(
                        {
                            "account": account_dir.name,
                            "cipher_version": verification.get("cipher_version"),
                            "db_label": db_label,
                            "key_fingerprint": validate_wechat_db_key.key_fingerprint(normalized),
                            "mode": mode,
                            "page_size": verification.get("page_size"),
                            "source": source,
                        }
                    )
                    return {"success": True, "verified": verified}
    return {"success": False, "verified": verified}


def continue_thread(tracer: Tracer, tid: int, signal_to_deliver: int = 0) -> None:
    tracer.ptrace(PTRACE_CONT, tid, 0, signal_to_deliver)


def install_breakpoints(mem_fd: int, targets: Sequence[int]) -> Dict[int, bytes]:
    originals: Dict[int, bytes] = {}
    for target in targets:
        originals[target] = os.pread(mem_fd, 4, target)
        os.pwrite(mem_fd, BRK_INSN, target)
    return originals


def remove_breakpoints(mem_fd: int, originals: Dict[int, bytes]) -> None:
    for target, original in originals.items():
        try:
            os.pwrite(mem_fd, original, target)
        except OSError:
            pass


def run_hook(
    pid: int,
    targets: Sequence[int],
    candidates_path: Path,
    duration_sec: int,
    broad_scan: bool = False,
    struct_scan: bool = False,
    trace_hits: int = 0,
    account_dirs: Optional[Sequence[Path]] = None,
    secrets_path: Optional[Path] = None,
    validate_on_hit: bool = False,
    db_labels: Optional[Set[str]] = None,
    page_sizes: Sequence[int] = (1024, 4096),
) -> Dict[str, Any]:
    tracer = Tracer()
    attached: Set[int] = set()
    mem_fd: Optional[int] = None
    originals: Dict[int, bytes] = {}
    hit_count = 0
    candidate_count = 0
    verified: List[Dict[str, Any]] = []
    hit_targets: List[str] = []
    try:
        for tid in process_tids(pid):
            tracer.ptrace(PTRACE_ATTACH, tid)
            attached.add(tid)
            os.waitpid(tid, 0)
            tracer.ptrace(PTRACE_SETOPTIONS, tid, 0, PTRACE_O_TRACECLONE)
        mem_fd = os.open(str(Path("/proc") / str(pid) / "mem"), os.O_RDWR)
        originals = install_breakpoints(mem_fd, targets)
        for tid in list(attached):
            continue_thread(tracer, tid)
        emit({"event": "hook_ready", "pid": pid, "target_count": len(targets), "timeout_sec": duration_sec})
        deadline = time.time() + duration_sec
        while time.time() < deadline:
            try:
                waited_pid, status = os.waitpid(-1, os.WNOHANG | WAIT_WALL)
            except ChildProcessError:
                break
            if waited_pid == 0:
                time.sleep(0.05)
                continue
            if not os.WIFSTOPPED(status):
                continue
            stop_signal = os.WSTOPSIG(status)
            event = status >> 16
            if event == PTRACE_EVENT_CLONE:
                try:
                    new_tid = tracer.get_event_msg(waited_pid)
                    attached.add(new_tid)
                    tracer.ptrace(PTRACE_SETOPTIONS, new_tid, 0, PTRACE_O_TRACECLONE)
                    continue_thread(tracer, new_tid)
                except OSError:
                    pass
                continue_thread(tracer, waited_pid)
                continue
            if stop_signal != signal.SIGTRAP:
                continue_thread(tracer, waited_pid, stop_signal)
                continue
            regs = tracer.get_regs(waited_pid)
            pc = regs[32]
            target = pc if pc in originals else (pc - 4 if (pc - 4) in originals else 0)
            if not target:
                continue_thread(tracer, waited_pid)
                continue
            hit_count += 1
            hit_targets.append(hex(target))
            base, regions = load_maps(pid)
            if mem_fd is not None:
                if trace_hits and hit_count <= trace_hits:
                    emit(
                        {
                            "event": "hit_diag",
                            "hit_count": hit_count,
                            "target": hex(target),
                            **describe_hit(mem_fd, regions, regs),
                        }
                    )
                hit_candidates = extract_candidate_keys(
                    mem_fd,
                    regions,
                    regs,
                    broad_scan=broad_scan,
                    struct_scan=struct_scan,
                )
                for source, key_hex in hit_candidates:
                    append_candidate(candidates_path, pid, source, target, key_hex)
                candidate_count += len(hit_candidates)
                if validate_on_hit and hit_candidates and account_dirs and secrets_path:
                    validation = validate_candidates_on_hit(
                        account_dirs,
                        hit_candidates,
                        secrets_path,
                        db_labels=db_labels,
                        page_sizes=page_sizes,
                    )
                    if validation.get("success"):
                        verified.extend(validation.get("verified", []))
                        emit({"event": "verified_key", "hit_count": hit_count, "verified": validation.get("verified", [])})
                original = originals[target]
                os.pwrite(mem_fd, original, target)
                regs[32] = target
                tracer.set_regs(waited_pid, regs)
                tracer.ptrace(PTRACE_SINGLESTEP, waited_pid)
                os.waitpid(waited_pid, WAIT_WALL)
                os.pwrite(mem_fd, BRK_INSN, target)
            emit({"event": "hook_hit", "hit_count": hit_count, "candidate_count": candidate_count, "target": hex(target)})
            if verified:
                break
            continue_thread(tracer, waited_pid)
    finally:
        if mem_fd is not None:
            remove_breakpoints(mem_fd, originals)
            os.close(mem_fd)
        for tid in list(attached):
            try:
                tracer.ptrace(PTRACE_DETACH, tid)
            except OSError:
                pass
    return {
        "candidate_count": candidate_count,
        "hit_count": hit_count,
        "hit_targets": hit_targets[:20],
        "pid": pid,
        "success": bool(verified) if validate_on_hit else candidate_count > 0,
        "verified": verified,
    }


def parse_offsets(values: Sequence[str]) -> List[int]:
    if not values:
        return list(DEFAULT_TARGET_OFFSETS)
    offsets = []
    for value in values:
        for part in value.split(","):
            part = part.strip()
            if part:
                offsets.append(int(part, 0))
    return offsets


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Hook ARM64 WeChat login-time DB key paths.")
    parser.add_argument("--pid", type=int, default=0)
    parser.add_argument("--duration-sec", type=int, default=300)
    parser.add_argument("--target-offset", action="append", default=[])
    parser.add_argument("--broad-scan", action="store_true")
    parser.add_argument("--struct-scan", action="store_true")
    parser.add_argument("--trace-hits", type=int, default=0)
    parser.add_argument("--validate-on-hit", action="store_true")
    parser.add_argument("--data-root", default="/home/lanxus/xwechat_files")
    parser.add_argument("--account", action="append", default=[])
    parser.add_argument("--db-label", action="append", default=[])
    parser.add_argument("--page-size", action="append", type=int, default=[])
    parser.add_argument(
        "--candidates",
        default=str(skill_root() / "config" / "secrets" / "wechat_db_key_candidates.jsonl"),
    )
    parser.add_argument(
        "--secrets",
        default=str(skill_root() / "config" / "secrets" / "wechat_db_key.json"),
    )
    args = parser.parse_args(argv)

    pid = args.pid or find_wechat_pid()
    if not pid:
        emit({"event": "error", "error": "wechat_pid_not_found"})
        return 1
    base, _regions = load_maps(pid)
    if not base:
        emit({"event": "error", "error": "wechat_base_not_found", "pid": pid})
        return 1
    offsets = parse_offsets(args.target_offset)
    targets = [base + offset for offset in offsets]
    account_dirs = validate_wechat_db_key.filter_account_dirs(
        validate_wechat_db_key.discover_account_dirs(Path(args.data_root)),
        args.account,
    )
    result = run_hook(
        pid,
        targets,
        Path(args.candidates),
        args.duration_sec,
        broad_scan=args.broad_scan,
        struct_scan=args.struct_scan,
        trace_hits=args.trace_hits,
        account_dirs=account_dirs,
        secrets_path=Path(args.secrets),
        validate_on_hit=args.validate_on_hit,
        db_labels=set(args.db_label) if args.db_label else None,
        page_sizes=tuple(args.page_size) if args.page_size else (1024, 4096),
    )
    emit({"event": "hook_done", **result})
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
